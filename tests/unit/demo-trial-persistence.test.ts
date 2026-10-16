import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_IDS,
  ORG_IDS,
  PERIOD_IDS,
  UNIT_IDS,
  metricId,
  userId,
} from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import {
  FY2025_APPROVED_SNAPSHOT_ID,
  TRIAL_ASSESSMENT_IDS,
  TRIAL_FICTIONAL_MEMBERS,
  TRIAL_XBRL_MAPPING_IDS,
  exclusionEventId,
  trialMemberUserId,
} from '@/lib/fixtures/trial-case';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  isPersistedTable,
  normalizeLegacyRow,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import {
  DEMO_TEXT_LIMITS,
  TRIAL_APPEND_ONLY_TABLES,
  TRIAL_PERSISTED_TABLES,
} from '@/lib/repositories/demo-trial-checks';
import type { TableName } from '@/lib/repositories/types';
import { createReportNote, respondToNote } from '@/lib/services/assurance-notes';
import { recordDataTermsVersion } from '@/lib/services/data-terms';
import { saveTrialProgram } from '@/lib/services/trial-program';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import type {
  AuthorizationContext,
  ProjectRequirementAssessment,
  RequirementExclusionEvent,
  RoleKey,
  SharedReportCopy,
} from '@/types/domain';

/**
 * Demo Mode の Cookie で持ち回すトライアル対応の表（plan 付録 B）と、偽の Cookie の拒否（demo-trial-checks.ts）。
 * 戻すときは DB と同じ検査（組織・権限・職務分離・本人名義・大きさ）を通す。
 */

let source: FixtureDb;

beforeEach(() => {
  source = createFixtureDb();
});

function replay(edits: DemoEdit[], target: FixtureDb = createFixtureDb()): FixtureDb {
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream(edits)));
  return target;
}

function editOf(table: string, row: object, db: FixtureDb = source): DemoEdit {
  const v = compactRow(table, row as Record<string, unknown>, db);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  return { t: table, id: (row as { id: string }).id, v };
}

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const ENG = ENGAGEMENT_IDS.main;
const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const manager: () => AuthorizationContext = () => ({
  ...enterprise('assurance-manager@demo.local', ['assurance_manager']),
  workspace: {
    organizationId: ORG_IDS.aoba,
    organizationType: 'assurance_firm',
    organizationName: 'テスト',
    roleKeys: ['assurance_manager'],
    unitScopeIds: [],
  },
  engagementIds: [ENG],
});

const AUTHOR = userId('sustainability@demo.local');
const APPROVER = userId('approver@demo.local');
const ADMIN = userId('enterprise-admin@demo.local');
const SITE_USER = userId('site-user@demo.local');
const OTHER_ORG_ADMIN = userId('other-enterprise-admin@demo.local');

describe('許可リスト', () => {
  it('トライアル対応の表は持ち回す。追記専用の表は許可リストの部分集合', () => {
    for (const table of TRIAL_PERSISTED_TABLES) {
      expect(isPersistedTable(table as TableName), table).toBe(true);
    }
    for (const table of TRIAL_APPEND_ONLY_TABLES) {
      expect((TRIAL_PERSISTED_TABLES as readonly string[]).includes(table), table).toBe(true);
    }
    // マスター・監査ログ・オプション・識別子は持ち回さない
    for (const table of [
      'auditEvents',
      'requirementCrosswalks',
      'xbrlTaxonomyPackages',
      'xbrlConcepts',
      'organizationOptions',
      'organizationFilingIdentifiers',
      'membershipRoles',
    ] as TableName[]) {
      expect(isPersistedTable(table), table).toBe(false);
    }
  });

  it('本文の上限は Demo Mode の Cookie に合わせる', () => {
    expect(DEMO_TEXT_LIMITS).toEqual({ note: 400, trialText: 300, trialTitle: 60 });
  });
});

describe('保証側へ共有した写し（目録だけ）', () => {
  async function share(): Promise<SharedReportCopy> {
    return shareReportSnapshot(new DemoDbClient(source), admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
  }

  it('目録は写しより小さく、別インスタンスで同じ写し（copy_hash）に作り直す', async () => {
    const copy = await share();
    const edit = editOf('sharedReportCopies', copy);
    expect(edit.v.copy).toBeUndefined();
    expect(JSON.stringify(edit.v).length).toBeLessThan(JSON.stringify(copy).length / 5);
    const restored = replay([edit]).sharedReportCopies.find((c) => c.id === copy.id);
    expect(restored).toBeDefined();
    expect(restored!.copyHash).toBe(copy.copyHash);
    expect(parseSharedReportCopy(restored!.copy)).toEqual(parseSharedReportCopy(copy.copy));
  });

  it('偽の目録（ハッシュの不一致・権限の無い人・他社のスナップショット・許諾の無い案件）は戻さない', async () => {
    const copy = await share();
    const edit = editOf('sharedReportCopies', copy);
    const variants: Array<Record<string, unknown>> = [
      { ...edit.v, copyHash: 'f'.repeat(64) },
      { ...edit.v, sharedBy: SITE_USER },
      { ...edit.v, sharedBy: APPROVER },
      { ...edit.v, clientOrganizationId: ORG_IDS.soten },
      { ...edit.v, engagementId: ENGAGEMENT_IDS.other },
      { ...edit.v, snapshotContentHash: 'x' },
    ];
    for (const v of variants) {
      const target = replay([{ ...edit, v }]);
      expect(
        target.sharedReportCopies.some((c) => c.id === copy.id),
        JSON.stringify(v),
      ).toBe(false);
    }
    const noGrant = createFixtureDb();
    noGrant.grants = noGrant.grants.map((g) =>
      g.engagementId === ENG ? { ...g, revokedAt: '2026-10-01T00:00:00.000Z' } : g,
    );
    expect(replay([edit], noGrant).sharedReportCopies.some((c) => c.id === copy.id)).toBe(false);
  });

  it('取り下げは、写しを既に持つインスタンスにも重ねる（権限の無い人の取り下げは重ねない）', async () => {
    const copy = await share();
    const shareEdit = editOf('sharedReportCopies', copy);
    const target = replay([shareEdit]);
    expect(target.sharedReportCopies.find((c) => c.id === copy.id)?.withdrawnAt).toBeNull();

    await withdrawSharedReport(new DemoDbClient(source), admin(), { copyId: copy.id });
    const withdrawn = source.sharedReportCopies.find((c) => c.id === copy.id)!;
    const forged = editOf('sharedReportCopies', { ...withdrawn, withdrawnBy: SITE_USER });
    applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream([forged])));
    expect(target.sharedReportCopies.find((c) => c.id === copy.id)?.withdrawnAt).toBeNull();

    applyDemoEdits(
      target,
      decodeDemoEdits(encodeDemoEditStream([editOf('sharedReportCopies', withdrawn)])),
    );
    const restored = target.sharedReportCopies.find((c) => c.id === copy.id)!;
    expect(restored.withdrawnAt).toBe(withdrawn.withdrawnAt);
    expect(restored.withdrawnBy).toBe(ADMIN);
  });
});

describe('保証側のコメントと企業の回答', () => {
  it('写し → コメント → 回答の順に戻る。偽の名義・共有していないコメントへの回答・長い本文は戻さない', async () => {
    const db = new DemoDbClient(source);
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const content = parseSharedReportCopy(copy.copy)!;
    const note = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: {
        kind: 'report_metric',
        dataPointVersionId: content.metricValues[0]!.dataPointVersionId,
      },
      body: '算定方法の説明をお願いします（架空）。',
      sharedWithClient: true,
    });
    const response = await respondToNote(db, author(), { noteId: note.id, body: '回答（架空）' });
    // Cookie の順と逆に並べても、親の行が先に戻る
    const edits = [
      editOf('reviewNoteResponses', response),
      editOf('reviewNotes', note),
      editOf('sharedReportCopies', copy),
    ];
    const target = replay(edits);
    expect(target.reviewNotes.some((n) => n.id === note.id)).toBe(true);
    expect(target.reviewNoteResponses.some((r) => r.id === response.id)).toBe(true);

    const forgedNotes = [
      { ...note, raisedBy: SITE_USER, createdBy: SITE_USER, updatedBy: SITE_USER },
      { ...note, body: 'あ'.repeat(DEMO_TEXT_LIMITS.note + 1) },
      { ...note, targetCopyId: null },
      { ...note, engagementId: ENGAGEMENT_IDS.other },
    ];
    for (const forged of forgedNotes) {
      const other = replay([editOf('sharedReportCopies', copy), editOf('reviewNotes', forged)]);
      expect(other.reviewNotes.some((n) => n.id === note.id)).toBe(false);
    }
    // 企業の開示デモのリセットで写しが消えても、保証側のコメントは監査法人の記録として戻る
    const dangling = replay([editOf('reviewNotes', note)]);
    expect(dangling.reviewNotes.some((n) => n.id === note.id)).toBe(true);
    // 写しが無くても、書き手の検査（案件のメンバー・権限）は同じ
    const danglingForged = replay([
      editOf('reviewNotes', {
        ...note,
        raisedBy: SITE_USER,
        createdBy: SITE_USER,
        updatedBy: SITE_USER,
      }),
    ]);
    expect(danglingForged.reviewNotes.some((n) => n.id === note.id)).toBe(false);
    const hidden = replay([
      editOf('sharedReportCopies', copy),
      editOf('reviewNotes', { ...note, sharedWithClient: false }),
      editOf('reviewNoteResponses', response),
    ]);
    expect(hidden.reviewNoteResponses.some((r) => r.id === response.id)).toBe(false);
    const otherOrg = replay([
      ...edits.slice(1).reverse(),
      editOf('reviewNoteResponses', { ...response, respondedBy: OTHER_ORG_ADMIN }),
    ]);
    expect(otherOrg.reviewNoteResponses.some((r) => r.id === response.id)).toBe(false);
  });
});

describe('要求事項の判断・対象外の申請', () => {
  function assessment(): ProjectRequirementAssessment {
    return source.projectRequirementAssessments.find(
      (a) => a.id === TRIAL_ASSESSMENT_IDS['40A-S01'],
    )!;
  }

  it('判断の更新は戻る。権限の無い書き手・他社の基準・理由の無い対象外・別の人の名義は戻さない', () => {
    const base = assessment();
    const changed = {
      ...base,
      actionNote: '担当部署と確認する（架空）',
      updatedBy: AUTHOR,
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
    const ok = replay([editOf('projectRequirementAssessments', changed)]);
    expect(ok.projectRequirementAssessments.find((a) => a.id === base.id)?.actionNote).toBe(
      changed.actionNote,
    );
    const variants: ProjectRequirementAssessment[] = [
      { ...changed, updatedBy: SITE_USER },
      { ...changed, projectFrameworkId: IDS.projectFrameworks.fy2026Ssbj },
      { ...changed, applicability: 'not_applicable', applicabilityReason: '' },
      { ...changed, decidedBy: APPROVER, decidedAt: '2026-10-05T00:00:00.000Z' },
      { ...changed, actionNote: 'あ'.repeat(DEMO_TEXT_LIMITS.note + 1) },
    ];
    for (const v of variants) {
      const target = replay([editOf('projectRequirementAssessments', v)]);
      expect(
        target.projectRequirementAssessments.find((a) => a.id === base.id)?.actionNote,
      ).not.toBe(changed.actionNote);
    }
  });

  it('対象外の承認は申請者と別の承認権限者だけ', () => {
    const requested = source.requirementExclusionEvents.find(
      (e) => e.id === exclusionEventId('esrs40a/40A-S06/requested'),
    )!;
    const approval = (actor: string, id: string): RequirementExclusionEvent => ({
      ...requested,
      id,
      event: 'approved',
      actorUserId: actor,
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const ok = replay([
      editOf(
        'requirementExclusionEvents',
        approval(APPROVER, 'e0e0e0e0-0000-4000-8000-000000000001'),
      ),
    ]);
    expect(
      ok.requirementExclusionEvents.some((e) => e.id === 'e0e0e0e0-0000-4000-8000-000000000001'),
    ).toBe(true);
    for (const [actor, id] of [
      [AUTHOR, 'e0e0e0e0-0000-4000-8000-000000000002'],
      [SITE_USER, 'e0e0e0e0-0000-4000-8000-000000000003'],
      [ADMIN, 'e0e0e0e0-0000-4000-8000-000000000004'],
    ] as const) {
      const target = replay([editOf('requirementExclusionEvents', approval(actor, id))]);
      expect(
        target.requirementExclusionEvents.some((e) => e.id === id),
        actor,
      ).toBe(false);
    }
    // 要求事項が名乗った版に無い・追記専用の既にある行は書き換えない
    const wrongItem = replay([
      editOf('requirementExclusionEvents', {
        ...approval(APPROVER, 'e0e0e0e0-0000-4000-8000-000000000005'),
        itemId: esrs40aSampleItemId('40A-S99'),
      }),
    ]);
    expect(
      wrongItem.requirementExclusionEvents.some(
        (e) => e.id === 'e0e0e0e0-0000-4000-8000-000000000005',
      ),
    ).toBe(false);
    const rewritten = replay([
      editOf('requirementExclusionEvents', { ...requested, actorUserId: APPROVER }),
    ]);
    expect(
      rewritten.requirementExclusionEvents.find((e) => e.id === requested.id)?.actorUserId,
    ).toBe(AUTHOR);
    expect(requested.frameworkVersionId).toBe(ESRS_40A_SAMPLE_VERSION_ID);
  });
});

describe('架空メンバー・XBRL・評価の記録', () => {
  it('架空メンバーの担当拠点の変更だけを戻す（実在のデモ利用者・組織の付け替えは戻さない）', () => {
    const fictional = trialMemberUserId(TRIAL_FICTIONAL_MEMBERS[0].email);
    const membership = source.memberships.find(
      (m) => m.userId === fictional && m.organizationId === ORG_IDS.aomi,
    )!;
    const changed = { ...membership, unitScopeIds: [UNIT_IDS.east], updatedBy: ADMIN };
    expect(
      replay([editOf('memberships', changed)]).memberships.find((m) => m.id === membership.id)
        ?.unitScopeIds,
    ).toEqual([UNIT_IDS.east]);
    const real = source.memberships.find(
      (m) => m.userId === SITE_USER && m.organizationId === ORG_IDS.aomi,
    )!;
    const forged = [
      { ...real, unitScopeIds: [], updatedBy: ADMIN },
      { ...changed, updatedBy: SITE_USER },
      { ...changed, userId: SITE_USER },
      { ...changed, unitScopeIds: ['f0f0f0f0-0000-4000-8000-000000000000'] },
    ];
    for (const row of forged) {
      const target = replay([editOf('memberships', row)]);
      const after = target.memberships.find((m) => m.id === row.id)!;
      const before = createFixtureDb().memberships.find((m) => m.id === row.id)!;
      expect(after).toEqual(before);
    }
  });

  it('XBRL の対応付けは作った人が確定できない（職務分離）', () => {
    const candidate = source.xbrlTagMappings.find(
      (m) => m.id === TRIAL_XBRL_MAPPING_IDS.scope2Candidate,
    )!;
    const confirm = (actor: string) => ({
      ...candidate,
      status: 'confirmed' as const,
      confirmedBy: actor,
      confirmedAt: '2026-10-06T00:00:00.000Z',
      updatedBy: actor,
    });
    const creator = candidate.createdBy!;
    expect(
      replay([editOf('xbrlTagMappings', confirm(creator))]).xbrlTagMappings.find(
        (m) => m.id === candidate.id,
      )?.status,
    ).toBe('candidate');
    const other = creator === APPROVER ? ADMIN : APPROVER;
    const approverCan = createFixtureDb();
    const result = replay([editOf('xbrlTagMappings', confirm(other))], approverCan);
    expect(result.xbrlTagMappings.find((m) => m.id === candidate.id)?.status).toBe(
      other === APPROVER ? 'confirmed' : 'candidate',
    );
  });

  it('XBRL の対応付けは本人の名義の候補として作る。最後に変えた人・内容の変更と同時の確定は戻さない（0059 と同じ）', () => {
    const candidate = source.xbrlTagMappings.find(
      (m) => m.id === TRIAL_XBRL_MAPPING_IDS.scope2Candidate,
    )!;
    const fresh = (overrides: Partial<typeof candidate>) => ({
      ...candidate,
      id: fid('xbrl_tag_mapping', `test/${JSON.stringify(overrides)}`),
      origin: 'human' as const,
      aiRunId: null,
      confirmedBy: null,
      confirmedAt: null,
      createdBy: APPROVER,
      updatedBy: APPROVER,
      ...overrides,
    });
    const has = (db: FixtureDb, id: string) => db.xbrlTagMappings.some((m) => m.id === id);
    // 別の人を作成者にして、作成と同時に自分で確定した行
    const forged = fresh({
      status: 'confirmed',
      createdBy: AUTHOR,
      confirmedBy: APPROVER,
      confirmedAt: '2026-10-06T00:00:00.000Z',
    });
    expect(has(replay([editOf('xbrlTagMappings', forged)]), forged.id)).toBe(false);
    // 作成者が空の候補
    const anonymous = fresh({ status: 'candidate', createdBy: null });
    expect(has(replay([editOf('xbrlTagMappings', anonymous)]), anonymous.id)).toBe(false);
    // 本人の名義の候補は戻る
    const own = fresh({ status: 'candidate', createdBy: AUTHOR, updatedBy: AUTHOR });
    expect(has(replay([editOf('xbrlTagMappings', own)]), own.id)).toBe(true);

    // 承認者が内容を変えてから確定する（最後に変えた人）・内容の変更と確定を同時に行う
    const edited = { ...own, decimals: 3, updatedBy: APPROVER };
    const confirmEdited = {
      ...edited,
      status: 'confirmed' as const,
      confirmedBy: APPROVER,
      confirmedAt: '2026-10-06T00:00:00.000Z',
    };
    const afterEdit = replay([
      editOf('xbrlTagMappings', own),
      editOf('xbrlTagMappings', edited),
      editOf('xbrlTagMappings', confirmEdited),
    ]);
    expect(afterEdit.xbrlTagMappings.find((m) => m.id === own.id)?.status).toBe('candidate');
    const confirmWithChange = {
      ...own,
      decimals: 4,
      status: 'confirmed' as const,
      confirmedBy: APPROVER,
      confirmedAt: '2026-10-06T00:00:00.000Z',
      updatedBy: APPROVER,
    };
    const changed = replay([
      editOf('xbrlTagMappings', own),
      editOf('xbrlTagMappings', confirmWithChange),
    ]);
    expect(changed.xbrlTagMappings.find((m) => m.id === own.id)?.status).toBe('candidate');
    // 作った人・最後に変えた人と別の承認者が確定の列だけを変えれば戻る
    const confirmOnly = {
      ...own,
      status: 'confirmed' as const,
      confirmedBy: APPROVER,
      confirmedAt: '2026-10-06T00:00:00.000Z',
      updatedBy: APPROVER,
    };
    const confirmed = replay([
      editOf('xbrlTagMappings', own),
      editOf('xbrlTagMappings', confirmOnly),
    ]);
    expect(confirmed.xbrlTagMappings.find((m) => m.id === own.id)?.status).toBe('confirmed');
  });

  it('AI の不採用の理由・フィードバックの件名は上限まで。トリアージは管理者だけ', () => {
    const run = {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      organizationId: ORG_IDS.aomi,
      jobId: null,
      featureType: 'ssbjGapAnalysis',
      provider: 'mock',
      model: 'mock',
      promptVersion: 'test',
      inputReferenceIds: [],
      outputJson: {},
      sourceReferences: [],
      confidence: 0.5,
      warnings: [],
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      estimatedCostUsd: 0,
      status: 'succeeded',
      errorMessage: null,
      engagementId: null,
      reviewedBy: null,
      acceptedAt: null,
      rejectedAt: null,
      createdAt: '2026-10-05T00:00:00.000Z',
      createdBy: AUTHOR,
    };
    const feedback = (comment: string) => ({
      id: 'a2a2a2a2-0000-4000-8000-000000000001',
      aiRunId: run.id,
      organizationId: ORG_IDS.aomi,
      userId: AUTHOR,
      decision: 'rejected',
      comment,
      createdAt: '2026-10-05T00:01:00.000Z',
    });
    const ok = replay([
      { t: 'aiRuns', id: run.id, v: run },
      editOf('aiFeedback', feedback('根拠が違う（架空）')),
    ]);
    expect(ok.aiFeedback.some((f) => f.id === 'a2a2a2a2-0000-4000-8000-000000000001')).toBe(true);
    const long = replay([
      { t: 'aiRuns', id: run.id, v: run },
      editOf('aiFeedback', feedback('あ'.repeat(DEMO_TEXT_LIMITS.trialText + 1))),
    ]);
    expect(long.aiFeedback.some((f) => f.id === 'a2a2a2a2-0000-4000-8000-000000000001')).toBe(
      false,
    );

    const item = source.trialFeedbackItems[0]!;
    const triaged = { ...item, status: 'triaged' as const, updatedBy: SITE_USER };
    expect(
      replay([editOf('trialFeedbackItems', triaged)]).trialFeedbackItems.find(
        (f) => f.id === item.id,
      )?.status,
    ).toBe(item.status);
    const byAdmin = { ...item, status: 'triaged' as const, updatedBy: ADMIN };
    expect(
      replay([editOf('trialFeedbackItems', byAdmin)]).trialFeedbackItems.find(
        (f) => f.id === item.id,
      )?.status,
    ).toBe('triaged');
    const retitled = { ...item, title: '書き換え', updatedBy: ADMIN };
    expect(
      replay([editOf('trialFeedbackItems', retitled)]).trialFeedbackItems.find(
        (f) => f.id === item.id,
      )?.title,
    ).toBe(item.title);
  });
});

describe('CDP の対応付け・回答（T7 の依頼。DB の規則と同じ検査で戻す）', () => {
  const CDP_C61 = fid('disclosure_item', 'cdp/2026/C6.1');
  const now = '2026-10-09T00:00:00.000Z';
  function mapping(patch: Record<string, unknown> = {}) {
    return {
      id: 'c1c1c1c1-0000-4000-8000-000000000001',
      organizationId: ORG_IDS.aomi,
      itemId: CDP_C61,
      metricId: metricId('AOMI', 'water'),
      unitId: null,
      transform: null,
      mappingSource: 'manual',
      aiRunId: null,
      confirmedBy: AUTHOR,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: AUTHOR,
      updatedBy: AUTHOR,
      ...patch,
    };
  }

  it('CDP の指標の対応付けは持ち回す。追加・外す（確定を null）が別インスタンスに残る', () => {
    expect(isPersistedTable('disclosureMappings')).toBe(true);
    const added = replay([editOf('disclosureMappings', mapping())]);
    expect(added.disclosureMappings.find((m) => m.id === mapping().id)?.confirmedBy).toBe(AUTHOR);

    const fixtureRow = source.disclosureMappings.find((m) => m.itemId === CDP_C61)!;
    const removed = replay([
      editOf('disclosureMappings', {
        ...fixtureRow,
        confirmedBy: null,
        confirmedAt: null,
        updatedAt: now,
        updatedBy: AUTHOR,
      }),
    ]);
    expect(removed.disclosureMappings.find((m) => m.id === fixtureRow.id)?.confirmedAt).toBeNull();
  });

  it('偽の対応付け（CDP 以外の質問・他組織の指標・本人でない確定者・編集の権限なし・重複）は戻さない', () => {
    const ssbj = source.frameworks.find((f) => f.key === 'ssbj')!;
    const ssbjVersionIds = new Set(
      source.frameworkVersions.filter((v) => v.frameworkId === ssbj.id).map((v) => v.id),
    );
    const ssbjItemId = source.disclosureItems.find((i) =>
      ssbjVersionIds.has(i.frameworkVersionId),
    )!.id;
    const forged = [
      // SSBJ の要求事項（CDP の回答画面の経路では変えない）
      mapping({ itemId: ssbjItemId }),
      // 他組織の指標
      mapping({ metricId: metricId('SOTEN', 'scope1') }),
      // 確定者が書き手本人でない
      mapping({ confirmedBy: APPROVER }),
      // 編集の権限が無い（拠点担当）
      mapping({ createdBy: SITE_USER, updatedBy: SITE_USER, confirmedBy: SITE_USER }),
      // 同じ質問 × 指標の行が既にある（Fixture の C6.1 ↔ Scope1）
      mapping({ metricId: metricId('AOMI', 'scope1') }),
    ];
    for (const row of forged) {
      const target = replay([editOf('disclosureMappings', row)]);
      expect(
        target.disclosureMappings.some((m) => m.id === row.id),
        JSON.stringify(row).slice(0, 120),
      ).toBe(false);
    }
  });

  it('同じセッションで付けて外した T4D の情報の対応付けは、外した状態で戻る（外した人は編集の権限が要る）', () => {
    const narrative = source.narrativeRecords.find((r) => r.organizationId === ORG_IDS.aomi)!;
    const link = {
      id: 'c2c2c2c2-0000-4000-8000-000000000002',
      organizationId: ORG_IDS.aomi,
      itemId: CDP_C61,
      targetKind: 'narrative_record',
      targetId: narrative.id,
      linkSource: 'manual',
      aiRunId: null,
      confirmedBy: AUTHOR,
      confirmedAt: now,
      deletedAt: now,
      deletedBy: AUTHOR,
    };
    const restored = replay([editOf('responseContentLinks', link)]);
    expect(restored.responseContentLinks.find((l) => l.id === link.id)?.deletedAt).toBe(now);
    const forged = replay([editOf('responseContentLinks', { ...link, deletedBy: SITE_USER })]);
    expect(forged.responseContentLinks.some((l) => l.id === link.id)).toBe(false);
  });

  it('回答の承認は、現在の版を作った人が承認者なら戻さない（0057 のトリガの職務分離）', () => {
    // FY2026 の未承認の CDP の回答。現在の版（作成者＝作成担当）を戻し先のインスタンスに置く
    const response = source.disclosureResponses.find(
      (r) =>
        r.itemId === CDP_C61 &&
        r.reportingPeriodId === PERIOD_IDS.fy2026 &&
        r.status !== 'approved',
    )!;
    expect(response, 'FY2026 の未承認の C6.1 の回答が Fixture に無い').toBeDefined();
    const versionId = 'c3c3c3c3-0000-4000-8000-000000000003';
    const target = () => {
      const db = createFixtureDb();
      db.disclosureResponseVersions.push({
        id: versionId,
        responseId: response.id,
        organizationId: ORG_IDS.aomi,
        versionNo: 1,
        answerText: null,
        answerNumeric: 1240.5,
        answerChoice: [],
        status: 'in_review',
        originatedFromAiRunId: null,
        changeReason: null,
        contentHash: 'd'.repeat(16),
        createdAt: now,
        createdBy: AUTHOR,
      });
      return db;
    };
    const approvedBy = (by: string, writer: string) => ({
      ...response,
      currentVersionId: versionId,
      status: 'approved',
      approvedBy: by,
      approvedAt: now,
      updatedAt: now,
      updatedBy: writer,
    });
    const ok = replay([editOf('disclosureResponses', approvedBy(APPROVER, APPROVER))], target());
    expect(ok.disclosureResponses.find((r) => r.id === response.id)?.approvedBy).toBe(APPROVER);
    // 承認の後に別の人が担当を変えた（最後の書き手が承認者でない）行は、承認者が作成者でなければ戻す
    const later = replay([editOf('disclosureResponses', approvedBy(APPROVER, ADMIN))], target());
    expect(later.disclosureResponses.find((r) => r.id === response.id)?.status).toBe('approved');
    for (const row of [
      // 現在の版を作った人が承認（書き手が誰でも）
      approvedBy(AUTHOR, AUTHOR),
      approvedBy(AUTHOR, APPROVER),
    ]) {
      const forged = replay([editOf('disclosureResponses', row)], target());
      expect(forged.disclosureResponses.find((r) => r.id === response.id)?.status).toBe(
        response.status,
      );
    }
  });
});

describe('トライアルの範囲・データ取扱（2026-10-16 の要望 ①④⑥⑦）', () => {
  it('合意 4 つ（範囲・判断者・スケジュール・無償の範囲）と検証範囲・展開対象・目安・予定日が Cookie から戻る', async () => {
    const { program } = await saveTrialProgram(new DemoDbClient(source), admin(), {
      agreements: {
        freeScope: { agreedOn: '2026-10-16', note: '（架空）標準機能の範囲は無償で合意' },
        decider: { agreedOn: '2026-10-10', note: '（架空）推進部長' },
      },
      rollout: { totalSites: 44, note: '（架空）検証の結果を見て順に広げる' },
      freeScope: { pdfFiles: 30 },
      disposal: { plannedOn: '2027-03-31' },
    });
    expect(Object.keys(program.agreements).sort()).toEqual(
      ['decider', 'freeScope', 'schedule', 'scope'].sort(),
    );
    const restored = replay([editOf('trialPrograms', program)]).trialPrograms.find(
      (p) => p.id === program.id,
    )!;
    expect(restored.agreements).toEqual(program.agreements);
    expect(restored.options).toEqual(program.options);
    expect(restored.options).toMatchObject({
      ghgVerification: { unitIds: expect.arrayContaining([UNIT_IDS.east]) },
      rollout: { totalSites: 44 },
      freeScope: { pdfFiles: 30 },
      disposal: { plannedOn: '2027-03-31' },
    });
  });

  it('処理を委ねる先 10 社分（区分・秘密保持の根拠つき）と残存期間が Cookie から戻る', async () => {
    const line = (i: number) =>
      `（架空）委託先 ${i}／運用の一部／（架空）国内／（架空）個別の秘密保持契約 ${i}`;
    const terms = await recordDataTermsVersion(new DemoDbClient(source), admin(), {
      ndaStatus: 'signed',
      processingTermsRef: '',
      storageLocation: '',
      retentionPolicy: '',
      aiTrainingUse: 'not_allowed',
      aiProviderStorage: 'none',
      subprocessorsByCategory: {
        contractor: [1, 2, 3].map(line).join('\n'),
        cloud: [4, 5, 6].map(line).join('\n'),
        ai: [7, 8].map(line).join('\n'),
        other: [9, 10].map(line).join('\n'),
      },
      returnMethod: '',
      deletionMethod: '',
      backupResidualDays: '35',
      agreedOn: '',
      agreedByLabel: '',
      note: '',
    });
    expect(terms.subprocessors).toHaveLength(10);
    const restored = replay([editOf('organizationDataTerms', terms)]).organizationDataTerms.find(
      (t) => t.id === terms.id,
    )!;
    expect(restored.subprocessors).toEqual(terms.subprocessors);
    expect(restored.subprocessors.map((s) => s.category)).toEqual([
      ...Array(3).fill('contractor'),
      ...Array(3).fill('cloud'),
      ...Array(2).fill('ai'),
      ...Array(2).fill('other'),
    ]);
    expect(restored.backupResidualDays).toBe(35);
  });

  it('偽の行は戻さない: 範囲外の残存期間・別途協議以外の費用区分に付けた区分', () => {
    const terms = source.organizationDataTerms.find((t) => t.organizationId === ORG_IDS.aomi)!;
    const forgedTerms = { ...terms, id: 'forged-terms', versionNo: 9, backupResidualDays: 401 };
    expect(
      replay([editOf('organizationDataTerms', forgedTerms)]).organizationDataTerms.some(
        (t) => t.id === 'forged-terms',
      ),
    ).toBe(false);
    const item = source.trialFeedbackItems.find(
      (f) => f.organizationId === ORG_IDS.aomi && f.costClass === 'maintenance',
    )!;
    const forgedItem = { ...item, scopeKind: 'custom_development' as const };
    expect(
      replay([editOf('trialFeedbackItems', forgedItem)]).trialFeedbackItems.find(
        (f) => f.id === item.id,
      )?.scopeKind ?? null,
    ).toBeNull();
  });
});

describe('以前の Cookie の行', () => {
  it('トライアル対応で既存の表に足した列が無い行は、DB の既定値で補う', () => {
    expect(normalizeLegacyRow('csrdDmaIros', { id: 'x' })).toEqual({
      id: 'x',
      sourceAnchorIds: [],
      policyActionNote: '',
    });
    expect(normalizeLegacyRow('ssbjAnalysisSettings', { id: 'x' })).toEqual({
      id: 'x',
      frameworkVersionId: null,
    });
    expect(normalizeLegacyRow('projectFrameworks', { id: 'x' })).toEqual({
      id: 'x',
      taxonomyPackageId: null,
    });
    expect(normalizeLegacyRow('approvalRoutes', { id: 'x', purpose: 'prior_year_final' })).toEqual({
      id: 'x',
      purpose: 'prior_year_final',
    });
    expect(normalizeLegacyRow('approvalRoutes', { id: 'x' })).toEqual({
      id: 'x',
      purpose: 'default',
    });
  });
});
