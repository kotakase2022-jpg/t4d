import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, at, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  coverageSummaryText,
  loadContentCoverage,
  loadContentCoverageSummaries,
  loadVersionMigrationImpact,
  matchesCoverageFilter,
} from '@/lib/services/content-coverage';
import { buildRequirementRows, getProject } from '@/lib/services/disclosure-project';
import {
  addNarrativeRequirementLinks,
  adoptNarrativeMappingCandidates,
  listLinkableRequirements,
  loadNarrativeMappingCandidates,
  rejectNarrativeMappingCandidates,
  removeNarrativeRequirementLink,
  suggestNarrativeRequirementMappings,
} from '@/lib/services/narrative-requirement-links';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 共通本文（定性情報）の基準別の対応状況と直接の対応付け（トライアル対応 NF-06・NF-11。int:content-coverage）。
 *
 *  - A20: 同じ定性情報の版を SSBJ と ESRS-40a の節が引用 → 基準ごとに別の区分。40a（試行用サンプル）は
 *    充足確認済みにならない（K6）
 *  - 区分は要求事項タブと同じ行（buildRequirementRows）から取る（件数を食い違わせない）
 *  - 読込は書かない。他テナントは見つからない
 *  - 直接の対応付け: 原稿が無くても要求事項の行が出る（不足を出す）。外すのは deleted_at
 *  - AI の候補は採用するまで対応付けにならない。不採用の理由は ai_feedback に残る
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const contributor = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const GOVERNANCE = IDS.narratives.governance;
const TRANSITION = IDS.narratives.riskTransition;

describe('A20: 共通の定性情報の基準別の対応状況', () => {
  it('SSBJ と ESRS-40a の節が同じ版を引用 → 基準ごとに別の区分。40a は充足確認済みにならない', async () => {
    const coverage = await loadContentCoverage(db, author(), { narrativeRecordId: GOVERNANCE });
    expect(coverage.projects.map((p) => p.id)).toEqual([IDS.projects.fy2026]);
    const ssbj = coverage.groups.find((g) => g.frameworkKey === 'ssbj');
    const e40a = coverage.groups.find((g) => g.frameworkKey === 'esrs_40a');
    expect(ssbj?.shortLabel).toBe('SSBJ');
    expect(e40a?.shortLabel).toBe('CSRD 域外');
    expect(ssbj?.rows.map((r) => r.code).sort()).toEqual(['気候-10', '気候-11']);
    expect(e40a?.rows.map((r) => r.code)).toEqual(['40A-S01']);
    // 40a は試行用サンプル（架空）。人の評価が「対応済み」でも上限は「追加確認が必要」
    expect(e40a?.isSample).toBe(true);
    expect(e40a?.isPreparationOnly).toBe(true);
    expect(e40a?.rows[0]?.category).not.toBe('confirmed');
    expect(e40a?.counts.confirmed).toBe(0);
    // 節の引用経由（直接の対応付けではない）
    expect(e40a?.rows[0]?.via).toEqual(['block']);
    expect(e40a?.rows[0]?.blocks.map((b) => b.id)).toEqual([
      IDS.blocks.fy2026Esrs40aGovernance.block,
    ]);
    // 要求事項の詳細へ: SSBJ は SSBJ 要求事項の詳細（期間付き）、40a はプロジェクトの要求事項の詳細
    expect(ssbj?.rows[0]?.requirementHref).toMatch(
      /^\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+\?period=/,
    );
    expect(e40a?.rows[0]?.requirementHref).toBe(
      `/enterprise/disclosure-projects/${IDS.projects.fy2026}/requirements/${esrs40aSampleItemId('40A-S01')}`,
    );
  });

  it('区分は要求事項タブと同じ行（buildRequirementRows）から取る', async () => {
    const coverage = await loadContentCoverage(db, author(), { narrativeRecordId: GOVERNANCE });
    const detail = await getProject(db, author(), IDS.projects.fy2026);
    for (const group of coverage.groups) {
      const view = detail.frameworks.find((f) => f.version.id === group.frameworkVersionId)!;
      const { rows } = await buildRequirementRows(db, author(), detail, view);
      for (const row of group.rows) {
        const same = rows.find((r) => r.item.id === row.itemId)!;
        expect(row.category, row.code).toBe(same.coverage.category);
        expect(row.reasons).toEqual(same.coverage.reasons);
      }
    }
  });

  it('一覧の列は基準ごとの件数を並べ、?coverage= で絞り込める（全件を 1 回で数える）', async () => {
    const records = fixture.narrativeRecords.filter((r) => r.organizationId === ORG_IDS.aomi);
    const summaries = await loadContentCoverageSummaries(db, author(), records);
    const governance = summaries.get(GOVERNANCE);
    expect(coverageSummaryText(governance)).toMatch(/^SSBJ .+／CSRD 域外 .+$/);
    expect(governance?.unmapped).toBe(false);
    // 戦略の定性情報は原稿に引用されていない → 要求事項との対応なし
    const strategy = summaries.get(IDS.narratives.strategy);
    expect(coverageSummaryText(strategy)).toBe('要求事項との対応なし');
    expect(matchesCoverageFilter(strategy, 'unmapped')).toBe(true);
    expect(matchesCoverageFilter(governance, 'unmapped')).toBe(false);
    const single = await loadContentCoverage(db, author(), { narrativeRecordId: GOVERNANCE });
    for (const group of single.groups) {
      const found = governance?.frameworks.find((f) => f.key === group.key);
      expect(found?.counts).toEqual(group.counts);
    }
  });

  it('読込は書かない（表示で行を作らない）', async () => {
    const guarded = new WriteDetectingDbClient(db);
    await loadContentCoverage(guarded, author(), { narrativeRecordId: GOVERNANCE });
    await loadContentCoverageSummaries(
      guarded,
      author(),
      fixture.narrativeRecords.filter((r) => r.organizationId === ORG_IDS.aomi),
    );
    await listLinkableRequirements(guarded, author(), { narrativeRecordId: GOVERNANCE });
    expect(guarded.writes).toEqual([]);
  });

  it('他テナントの定性情報は見つからない', async () => {
    await expect(
      loadContentCoverage(db, otherTenant(), { narrativeRecordId: GOVERNANCE }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('定性情報と要求事項の直接の対応付け', () => {
  it('原稿が無くても要求事項の行が出る（不足: 原稿なし）。外すと消える', async () => {
    const s04 = esrs40aSampleItemId('40A-S04');
    const [link] = await addNarrativeRequirementLinks(db, author(), {
      narrativeRecordId: TRANSITION,
      itemIds: [s04],
    });
    const coverage = await loadContentCoverage(db, author(), { narrativeRecordId: TRANSITION });
    const row = coverage.groups
      .find((g) => g.frameworkKey === 'esrs_40a')
      ?.rows.find((r) => r.itemId === s04);
    expect(row?.via).toEqual(['link']);
    expect(row?.linkId).toBe(link!.id);
    // 適用と判断した 40A-S04 に節が無い → 未対応・原稿なし
    expect(row?.category).toBe('not_addressed');
    expect(row?.gapLabels).toContain('原稿なし');

    // 同じ要求事項は 2 回結ばない
    await expect(
      addNarrativeRequirementLinks(db, author(), { narrativeRecordId: TRANSITION, itemIds: [s04] }),
    ).rejects.toBeInstanceOf(ValidationError);

    await removeNarrativeRequirementLink(db, author(), { linkId: link!.id });
    const stored = fixture.narrativeRequirementLinks.find((l) => l.id === link!.id)!;
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.deletedBy).toBe(userId('sustainability@demo.local'));
    const after = await loadContentCoverage(db, author(), { narrativeRecordId: TRANSITION });
    expect(
      after.groups.flatMap((g) => g.rows).some((r) => r.itemId === s04 && r.via.includes('link')),
    ).toBe(false);
    // 外した後は結び直せる
    await addNarrativeRequirementLinks(db, author(), {
      narrativeRecordId: TRANSITION,
      itemIds: [s04],
    });
    expect(await auditCount('requirement_mapping_changed')).toBeGreaterThanOrEqual(3);
  });

  it('年度のプロジェクトの基準に無い要求事項・他テナント・権限なしは断る', async () => {
    // 公開草案の版（プロジェクトに付けていない）・CSRD サンプル（プロジェクトに付けていない）の要求事項
    const csrdItem = fixture.disclosureItems.find((i) => i.code.startsWith('ESRS2-'))!;
    await expect(
      addNarrativeRequirementLinks(db, author(), {
        narrativeRecordId: TRANSITION,
        itemIds: [csrdItem.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // 他テナントの定性情報は存在自体を伏せる（見つからない）
    await expect(
      addNarrativeRequirementLinks(db, otherTenant(), {
        narrativeRecordId: TRANSITION,
        itemIds: [esrs40aSampleItemId('40A-S04')],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addNarrativeRequirementLinks(db, contributor(), {
        narrativeRecordId: TRANSITION,
        itemIds: [esrs40aSampleItemId('40A-S04')],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const [link] = await addNarrativeRequirementLinks(db, author(), {
      narrativeRecordId: TRANSITION,
      itemIds: [esrs40aSampleItemId('40A-S04')],
    });
    const adminOther = ctxFor(
      'other-enterprise-admin@demo.local',
      ['sustainability_manager'],
      ORG_IDS.soten,
    );
    await expect(
      removeNarrativeRequirementLink(db, adminOther, { linkId: link!.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('対応付けの選択肢は年度のプロジェクトの基準（SSBJ・40a サンプル）だけ', async () => {
    const groups = await listLinkableRequirements(db, author(), { narrativeRecordId: TRANSITION });
    expect(groups.map((g) => g.shortLabel).sort()).toEqual(['CSRD 域外', 'SSBJ']);
    const sample = groups.find((g) => g.shortLabel === 'CSRD 域外')!;
    expect(sample.isSample).toBe(true);
    expect(sample.items).toHaveLength(8);
  });
});

describe('AI の対応付けの候補（採用するまで対応付けにならない）', () => {
  it('候補を出しても対応付けは増えない。採用した要求事項だけが対応付けになる', async () => {
    const before = fixture.narrativeRequirementLinks.length;
    const run = await suggestNarrativeRequirementMappings(db, author(), {
      narrativeRecordId: GOVERNANCE,
    });
    expect(fixture.narrativeRequirementLinks.length).toBe(before);
    const loaded = await loadNarrativeMappingCandidates(db, author(), {
      narrativeRecordId: GOVERNANCE,
      runId: run.id,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.candidates.length).toBeGreaterThan(0);
    // 候補は年度のプロジェクトの基準の要求事項だけ
    const scope = new Set(
      (await listLinkableRequirements(db, author(), { narrativeRecordId: GOVERNANCE })).flatMap(
        (g) => g.items.map((i) => i.id),
      ),
    );
    expect(loaded!.candidates.every((c) => scope.has(c.itemId))).toBe(true);

    // 候補に無い要求事項は採用できない
    const notCandidate = [...scope].find((id) => !loaded!.candidates.some((c) => c.itemId === id))!;
    await expect(
      adoptNarrativeMappingCandidates(db, author(), {
        narrativeRecordId: GOVERNANCE,
        runId: run.id,
        itemIds: [notCandidate],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const chosen = loaded!.candidates[0]!.itemId;
    const rows = await adoptNarrativeMappingCandidates(db, author(), {
      narrativeRecordId: GOVERNANCE,
      runId: run.id,
      itemIds: [chosen],
    });
    expect(rows.map((r) => r.itemId)).toEqual([chosen]);
    expect(fixture.aiRuns.find((r) => r.id === run.id)?.status).toBe('accepted');
    // 採否を記録した候補はもう一度採用・不採用にできない
    await expect(
      rejectNarrativeMappingCandidates(db, author(), {
        narrativeRecordId: GOVERNANCE,
        runId: run.id,
        reason: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('不採用は理由を ai_feedback に残し、対応付けは作らない。別の定性情報の実行は読めない', async () => {
    const run = await suggestNarrativeRequirementMappings(db, author(), {
      narrativeRecordId: GOVERNANCE,
    });
    expect(
      await loadNarrativeMappingCandidates(db, author(), {
        narrativeRecordId: TRANSITION,
        runId: run.id,
      }),
    ).toBeNull();
    const before = fixture.narrativeRequirementLinks.length;
    await rejectNarrativeMappingCandidates(db, author(), {
      narrativeRecordId: GOVERNANCE,
      runId: run.id,
      reason: '（テスト）既に節で対応しているため',
    });
    expect(fixture.narrativeRequirementLinks.length).toBe(before);
    expect(fixture.aiRuns.find((r) => r.id === run.id)?.status).toBe('rejected');
    const feedback = fixture.aiFeedback.find((f) => f.aiRunId === run.id);
    expect(feedback?.decision).toBe('rejected');
    expect(feedback?.comment).toContain('既に節で対応');
  });

  it('AI の実行権限が無い人は候補を出せない', async () => {
    await expect(
      suggestNarrativeRequirementMappings(db, contributor(), { narrativeRecordId: GOVERNANCE }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('基準の新しい版の影響先（NF-08。改番を削除＋追加にしない・要再確認）', () => {
  it('要求事項が未収録の公開草案の版は、差分・影響を算定しない', async () => {
    const impact = await loadVersionMigrationImpact(db, author(), {
      projectId: IDS.projects.fy2026,
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      toVersionId: IDS.esrs40aDraftVersion,
    });
    expect(impact.notLoaded).toBe(true);
    expect(impact.diff).toBeNull();
  });

  it('改番・文言の変更・削除された要求事項に結び付いた節・直接の対応付け・横断表・対象外の判断を挙げる', async () => {
    // テスト用の新しい版（架空）: S01 を改番（S11）、S06 を削除、それ以外は同じ
    const newVersionId = fid('framework_version', 'esrs_40a/test-next');
    const base = fixture.frameworkVersions.find((v) => v.id === ESRS_40A_SAMPLE_VERSION_ID)!;
    fixture.frameworkVersions.push({
      ...base,
      id: newVersionId,
      year: 2027,
      label: 'ESRS-40a テストの次の版（架空）',
      versionCode: 'esrs-40a-test-next',
      createdAt: at(1),
    });
    for (const item of fixture.disclosureItems.filter(
      (i) => i.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID && i.code !== '40A-S06',
    )) {
      const renumbered = item.code === '40A-S01';
      fixture.disclosureItems.push({
        ...item,
        id: fid('disclosure_item', `esrs_40a/test-next/${item.code}`),
        frameworkVersionId: newVersionId,
        code: renumbered ? '40A-S11' : item.code,
        previousItemCode: renumbered ? '40A-S01' : null,
      });
    }
    await addNarrativeRequirementLinks(db, author(), {
      narrativeRecordId: GOVERNANCE,
      itemIds: [esrs40aSampleItemId('40A-S01')],
    });

    const impact = await loadVersionMigrationImpact(db, author(), {
      projectId: IDS.projects.fy2026,
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      toVersionId: newVersionId,
    });
    expect(impact.notLoaded).toBe(false);
    expect(impact.diff?.renumbered.map((e) => [e.fromCode, e.toCode])).toEqual([
      ['40A-S01', '40A-S11'],
    ]);
    expect(impact.diff?.removed.map((e) => e.fromCode)).toEqual(['40A-S06']);
    expect(impact.diff?.added).toEqual([]);
    const byKind = Object.fromEntries(impact.targets.map((t) => [t.kind, t]));
    // 40a のガバナンスの節（40A-S01）
    expect(byKind.block?.codes).toEqual(['40A-S01']);
    expect(byKind.block?.href).toContain(IDS.blocks.fy2026Esrs40aGovernance.block);
    // 定性情報の直接の対応付け
    expect(byKind.narrative_link?.label).toBe('気候関連のガバナンス体制');
    // 横断対応表（SSBJ 気候-10・11 → 40A-S01）
    expect(byKind.crosswalk?.codes).toEqual(['40A-S01']);
    // 対象外の判断（40A-S06 は対象外を申請中）
    expect(byKind.exclusion?.codes).toEqual(['40A-S06']);
  });

  it('他テナントのプロジェクトは見つからない・読込は書かない', async () => {
    await expect(
      loadVersionMigrationImpact(db, otherTenant(), {
        projectId: IDS.projects.fy2026,
        projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
        toVersionId: IDS.esrs40aDraftVersion,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const guarded = new WriteDetectingDbClient(db);
    await loadVersionMigrationImpact(guarded, author(), {
      projectId: IDS.projects.fy2026,
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      toVersionId: IDS.esrs40aDraftVersion,
    });
    expect(guarded.writes).toEqual([]);
  });
});

async function auditCount(eventType: string): Promise<number> {
  return fixture.auditEvents.filter((e) => e.eventType === eventType).length;
}
