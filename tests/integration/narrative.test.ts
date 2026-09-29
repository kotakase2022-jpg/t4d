import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { disclosureFragmentId } from '@/lib/fixtures/disclosure-documents';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  CANDIDATE_CHANGE_REASON,
  carryForwardNarrative,
  confirmNarrative,
  createNarrative,
  createNarrativeCandidateFromFragments,
  getNarrativeEditor,
  listNarratives,
  saveNarrative,
  type SaveNarrativeInput,
} from '@/lib/services/narrative';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 定性情報（指示書 §6.5・§6.6・§6.8・§12.2 saveNarrative）。
 *
 * 受入: A20（定性情報を SSBJ と CSRD（ESRS-40a 準備）で共用しても、元情報は共通のまま
 *       基準別の承認は独立。元情報を変えても原稿の採用本文・承認は黙って変わらない）、
 *       A35 の一部（同時編集は競合として止め、比較情報を返す。成功と誤表示しない）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);

const GOV = IDS.narratives.governance;
const GOV_V2 = IDS.narrativeVersions.governanceFy2026;

function governanceSaveInput(overrides: Partial<SaveNarrativeInput> = {}): SaveNarrativeInput {
  const v2 = fixture.narrativeVersions.find((v) => v.id === GOV_V2)!;
  return {
    narrativeId: GOV,
    baseVersionId: GOV_V2,
    reportingPeriodId: v2.reportingPeriodId,
    scopeNote: v2.scopeNote,
    fields: { ...v2.fields },
    body: `${v2.body}（委員会の構成を追記）`,
    sourceAnchorIds: [...v2.sourceAnchorIds],
    changeReason: '委員会構成の追記',
    acknowledgeImpact: true,
    ...overrides,
  };
}

describe('一覧（§6.5）', () => {
  it('利用先原稿を逆引きし、根拠件数・状態・最新確認日を並べる', async () => {
    const rows = await listNarratives(db, manager());
    expect(rows).toHaveLength(5);
    const governance = rows.find((r) => r.record.id === GOV)!;
    expect(governance.statusLabel).toBe('確認済み');
    expect(governance.confirmedIsCurrent).toBe(true);
    expect(governance.evidenceCount).toBe(3);
    expect(governance.period?.id).toBe(PERIOD_IDS.fy2026);
    // SSBJ のガバナンス節と ESRS-40a 準備のガバナンス節が同じ版を引用している
    expect(governance.usage.map((u) => u.blockId).sort()).toEqual(
      [IDS.blocks.fy2026Governance.block, IDS.blocks.fy2026Esrs40aGovernance.block].sort(),
    );

    const financial = rows.find((r) => r.record.id === IDS.narratives.financialImpact)!;
    // 影響額はキーを持たない（未確定の金額を埋めない）ため不足として数える
    expect(financial.missingFieldCount).toBeGreaterThan(0);

    const filtered = await listNarratives(db, manager(), { theme: 'risk_opportunity' });
    expect(filtered.every((r) => r.record.theme === 'risk_opportunity')).toBe(true);
  });

  it('開示の閲覧権限が無い利用者は見られない', async () => {
    await expect(listNarratives(db, siteUser())).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('A20: 共通の定性情報と基準別の承認', () => {
  it('元情報を更新しても、原稿の採用本文・状態・承認済みの版は変わらず、影響は先に示される', async () => {
    const blocksBefore = structuredClone(
      fixture.disclosureBlocks.filter((b) =>
        [IDS.blocks.fy2026Governance.block, IDS.blocks.fy2026Esrs40aGovernance.block].includes(
          b.id,
        ),
      ),
    );
    const versionsBefore = structuredClone(fixture.disclosureBlockVersions);
    expect(blocksBefore.map((b) => b.status).sort()).toEqual(['approved', 'draft']);

    // 影響の確認なしでは保存しない（利用先の原稿を先に示す）
    const pending = await saveNarrative(
      db,
      manager(),
      governanceSaveInput({ acknowledgeImpact: false }),
    );
    expect(pending.status).toBe('needs_confirmation');
    if (pending.status !== 'needs_confirmation') throw new Error('unreachable');
    expect(pending.usage.map((u) => u.blockStatusLabel).sort()).toEqual(['下書き', '承認済み']);
    expect(fixture.narrativeRecords.find((r) => r.id === GOV)!.currentVersionId).toBe(GOV_V2);

    const saved = await saveNarrative(db, manager(), governanceSaveInput());
    expect(saved.status).toBe('saved');

    // 原稿（節）は書き換えない: 状態・版・承認済みの版・本文（採用時の quote）がそのまま
    const blocksAfter = fixture.disclosureBlocks.filter((b) =>
      [IDS.blocks.fy2026Governance.block, IDS.blocks.fy2026Esrs40aGovernance.block].includes(b.id),
    );
    expect(blocksAfter).toEqual(blocksBefore);
    expect(fixture.disclosureBlockVersions).toEqual(versionsBefore);

    // 定性情報は新しい版（下書き）になり、確認済みの版は残る
    const record = fixture.narrativeRecords.find((r) => r.id === GOV)!;
    expect(record.status).toBe('draft');
    expect(record.confirmedVersionId).toBe(GOV_V2);

    // 両方の原稿で「引用中の版が最新ではない」と分かる（基準ごとに独立して再確認する）
    const rows = await listNarratives(db, manager());
    const usage = rows.find((r) => r.record.id === GOV)!.usage;
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => !u.citesCurrent)).toBe(true);
    expect(usage.map((u) => u.blockStatus).sort()).toEqual(['approved', 'draft']);
  });
});

describe('競合（§12.2 の 409 相当）', () => {
  it('基準の版が古い保存は止め、最新版との比較情報を返す。何も保存しない', async () => {
    const first = await saveNarrative(db, manager(), governanceSaveInput());
    expect(first.status).toBe('saved');
    const countAfterFirst = fixture.narrativeVersions.length;

    const second = await saveNarrative(
      db,
      reviewer(),
      governanceSaveInput({ body: '別の担当者が同時に書き換えた本文', changeReason: '同時編集' }),
    );
    expect(second.status).toBe('conflict');
    if (second.status !== 'conflict') throw new Error('unreachable');
    expect(second.conflict.latestVersion?.versionNo).toBe(3);
    expect(second.conflict.latestCreatedByName).toBe('海野 みどり');
    expect(second.conflict.bodyDiff.some((s) => s.op !== 'equal')).toBe(true);
    expect(fixture.narrativeVersions.length).toBe(countAfterFirst);
  });

  it('内容が同じなら版を増やさない。変更理由の無い更新は受け付けない', async () => {
    const v2 = fixture.narrativeVersions.find((v) => v.id === GOV_V2)!;
    const same = await saveNarrative(db, manager(), governanceSaveInput({ body: v2.body }));
    expect(same.status).toBe('unchanged');
    await expect(
      saveNarrative(db, manager(), governanceSaveInput({ changeReason: ' ' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('テンプレート項目は空欄と定義外のキーを捨てる（空欄を入力済みに見せない）', async () => {
    const result = await saveNarrative(
      db,
      manager(),
      governanceSaveInput({
        fields: {
          oversightBody: '取締役会',
          committee: '  ',
          madeUpKey: 'x',
          expertise: '外部専門家を招聘',
        },
      }),
    );
    if (result.status !== 'saved') throw new Error(`saved ではない: ${result.status}`);
    expect(result.version.fields).toEqual({
      oversightBody: '取締役会',
      expertise: '外部専門家を招聘',
    });
  });
});

describe('前年から引継ぎ・資料から候補・確認', () => {
  it('引継ぎは新年度の下書きを作り、確認（承認）も前年の根拠も引き継がない', async () => {
    const { record, version: v1 } = await createNarrative(db, manager(), {
      theme: 'policy_other',
      title: '人権方針（架空）',
      ownerDepartment: '人事総務部',
      tags: ['人権'],
      reportingPeriodId: PERIOD_IDS.fy2025,
      scopeNote: '当社及び連結子会社（2025年度）',
      fields: { policyName: '人権方針', content: '人権の尊重に関する基本方針を定める。' },
      body: '当社は人権方針を定め、事業活動における人権の尊重に取り組んでいます。',
      sourceAnchorIds: [IDS.anchors.priorGovernance1],
    });
    await confirmNarrative(db, reviewer(), { narrativeId: record.id, versionId: v1.id });
    expect(fixture.narrativeRecords.find((r) => r.id === record.id)!.status).toBe('confirmed');

    const carried = await carryForwardNarrative(db, manager(), {
      narrativeId: record.id,
      targetPeriodId: PERIOD_IDS.fy2026,
    });
    expect(carried).toMatchObject({
      versionNo: 2,
      reportingPeriodId: PERIOD_IDS.fy2026,
      carriedFromVersionId: v1.id,
      sourceAnchorIds: [],
      body: v1.body,
    });
    const after = fixture.narrativeRecords.find((r) => r.id === record.id)!;
    expect(after.status).toBe('draft');
    expect(after.currentVersionId).toBe(carried.id);
    // 確認済みの版は前年の版のまま（新しい版は未確認）
    expect(after.confirmedVersionId).toBe(v1.id);

    await expect(
      carryForwardNarrative(db, manager(), {
        narrativeId: record.id,
        targetPeriodId: PERIOD_IDS.fy2026,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      carryForwardNarrative(db, manager(), {
        narrativeId: record.id,
        targetPeriodId: PERIOD_IDS.fy2024,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('資料から候補: 抜粋を引用として並べるだけで、テンプレート項目は推測で埋めない', async () => {
    const aiRunsBefore = fixture.aiRuns.length;
    const result = await createNarrativeCandidateFromFragments(db, manager(), {
      theme: 'governance',
      title: '監督体制（候補）',
      reportingPeriodId: PERIOD_IDS.fy2026,
      fragmentIds: [
        disclosureFragmentId('fy2026-sustainability-committee-3', 'gov-2'),
        disclosureFragmentId('fy2025-securities-report-excerpt', 'gov-1'),
      ],
    });
    expect(result.version.fields).toEqual({});
    expect(result.version.changeReason).toBe(CANDIDATE_CHANGE_REASON);
    expect(result.version.body).toContain('年4回開催する');
    // 過年度の記載は当年度の事実に見せない
    expect(result.version.body).toContain('［過年度の記載］');
    expect(result.warnings.length).toBe(1);
    expect(result.version.sourceAnchorIds).toHaveLength(2);
    const anchors = fixture.sourceAnchors.filter((a) =>
      result.version.sourceAnchorIds.includes(a.id),
    );
    expect(anchors.every((a) => a.acquiredBy === 'extracted' && a.fragmentId !== null)).toBe(true);
    // AI は使わない
    expect(fixture.aiRuns.length).toBe(aiRunsBefore);

    const rows = await listNarratives(db, manager());
    expect(rows.find((r) => r.record.id === result.record.id)!.isCandidate).toBe(true);
  });

  it('確認は画面で見ていた最新の版だけ。閲覧だけの利用者は確認できない', async () => {
    await expect(
      confirmNarrative(db, manager(), {
        narrativeId: IDS.narratives.riskPhysical,
        versionId: GOV_V2,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      confirmNarrative(db, siteUser(), {
        narrativeId: IDS.narratives.riskPhysical,
        versionId: IDS.narrativeVersions.riskPhysical,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const confirmed = await confirmNarrative(db, reviewer(), {
      narrativeId: IDS.narratives.riskPhysical,
      versionId: IDS.narrativeVersions.riskPhysical,
    });
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      confirmedVersionId: IDS.narrativeVersions.riskPhysical,
      confirmedBy: userId('reviewer@demo.local'),
    });
    expect(fixture.auditEvents.some((e) => e.eventType === 'narrative_confirmed')).toBe(true);
  });

  it('編集画面: 初期表示と詳細のテンプレート項目・不足項目・引用位置・利用先がそろう', async () => {
    const editor = await getNarrativeEditor(db, manager(), IDS.narratives.financialImpact);
    expect(editor.templateFields.map((f) => f.key)).toContain('noAmountReason');
    expect(editor.detailFields.map((f) => f.key)).toContain('uncertainty');
    expect(editor.missingFields.map((f) => f.key)).toEqual(['amount', 'amountBasis']);
    expect(editor.anchors).toHaveLength(1);
    expect(editor.anchors[0]!.usagePurposeLabel).toBe('当年度の根拠');
    expect(editor.usage.map((u) => u.blockId)).toEqual([IDS.blocks.fy2026RiskOpportunity.block]);
  });
});
