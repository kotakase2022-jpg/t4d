import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { FY2025_APPROVED_SNAPSHOT_ID, trialScenarioId } from '@/lib/fixtures/trial-case';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { RECONCILIATION_CHECKER_VERSION } from '@/lib/domain/export-reconciliation';
import { exportRequirementMatrix } from '@/lib/exports/requirement-matrix';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  MAX_BYTES_PER_COOKIE,
  demoEditsWereEvicted,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import { loadApprovalRoutes, saveApprovalRoute } from '@/lib/services/approval-route';
import { loadDataRoom } from '@/lib/services/assurance';
import {
  createReportNote,
  listNotesForClient,
  respondToNote,
} from '@/lib/services/assurance-notes';
import { updateBlockRequirements } from '@/lib/services/block-requirements';
import { loadCrosswalk } from '@/lib/services/crosswalk';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { exportReportSnapshot } from '@/lib/services/disclosure-export';
import { saveProjectRequirementAssessment } from '@/lib/services/project-requirement-assessment';
import { loadSnapshotTrace } from '@/lib/services/report-trace';
import { shareReportSnapshot } from '@/lib/services/report-share';
import {
  decideExclusion,
  loadExclusionStatus,
  requestExclusion,
} from '@/lib/services/requirement-exclusion';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import { judgeScenario, recordScenarioRun } from '@/lib/services/trial-evaluation';
import { submitFeedback } from '@/lib/services/trial-feedback';
import { recordTaskTiming } from '@/lib/services/trial-timing';
import { previewXbrl } from '@/lib/services/xbrl-export';
import type { AuthorizationContext, Uuid } from '@/types/domain';
import { admin, approver, author, playMainDemoFlow } from '../support/demo-flows';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * トライアル対応の「試行の流れ」（plan §4.3-6・K8）を、すべてのリクエストが別インスタンスに届く最悪の場合で
 * Service の層に通す（E2E は tests/e2e/zzzzz-trial-chain.stateless.ts が同じ流れを画面で通す）。
 *
 * 開示デモのリセット → 40a の判断と対象外の申請・承認 → 節の対応付け → 対応表 XLSX → FY2025 の承認済み
 * レポートを案件へ共有 → 保証側が段落にコメント → 企業が回答 → Data Room に開示レポート → DOCX 出力で突合 0 →
 * 追跡率 → XBRL プレビュー（書込なし）→ ご意見・シナリオの実施・判定・作業時間 → 3 段階の承認ルートの保存。
 *
 * 手順ごとに Fixture を作り直し、Cookie の操作だけを適用した DB で次の手順を行う。確かめること:
 *  - 前の手順の結果が別インスタンスに残る（Cookie だけで戻る）
 *  - 押し出し（容量不足で古い操作を捨てること）が 0
 *  - 試行の流れだけで Cookie（操作の記録）は 9,000B 以下（K8）
 *  - 実演の流れ → リセット → 試行の流れでも押し出し 0
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

/** 試行の流れの Cookie の上限（plan K8） */
const TRIAL_CHAIN_BUDGET_BYTES = 9_000;

async function fresh(): Promise<{ db: DemoDbClient; fixture: FixtureDb }> {
  const fixture = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
}

function editsBytes(): number {
  return [...jar.entries()]
    .filter(([name]) => name.startsWith('t4d.demo-edits'))
    .reduce((sum, [, value]) => sum + value.length, 0);
}

const sizes: Array<{ step: string; bytes: number }> = [];
function measure(step: string): void {
  sizes.push({ step, bytes: editsBytes() });
}

/** 監査法人の担当者（案件のメンバー） */
function firmManager(): AuthorizationContext {
  return {
    userId: userId('assurance-manager@demo.local'),
    email: 'assurance-manager@demo.local',
    displayName: 'assurance-manager@demo.local',
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: '（架空）監査法人',
      roleKeys: ['assurance_manager'],
      unitScopeIds: [],
    },
    engagementIds: [ENGAGEMENT_IDS.main],
    demo: true,
  };
}

const ENG = ENGAGEMENT_IDS.main;
const PF_40A = IDS.projectFrameworks.fy2026Esrs40a;
const S02 = esrs40aSampleItemId('40A-S02');
const S07 = esrs40aSampleItemId('40A-S07');
const S07_TARGET = {
  source: 'project_assessment' as const,
  itemId: S07,
  projectFrameworkId: PF_40A,
};

function assessment(itemId: Uuid, patch: Record<string, unknown> = {}) {
  return {
    projectFrameworkId: PF_40A,
    itemId,
    applicability: 'applicable' as const,
    applicabilityReason: '（試行）全社共通の取組のため適用と判断。',
    ruleRef: '（サンプル）',
    disclosureCoverage: 'partial' as const,
    dataCoverage: 'mostly_covered' as const,
    processCoverage: 'partial' as const,
    missingInformation: '',
    ownerUserId: userId('sustainability@demo.local'),
    dueOn: '2027-03-31',
    actionNote: '',
    changeReason: '試行の流れ',
    ...patch,
  };
}

interface TrialChainResult {
  blockId: Uuid;
  copyId: Uuid;
  noteId: Uuid;
  artifactId: Uuid;
  routeName: string;
}

/** 試行の流れ（リセットから 3 段階の承認ルートまで）。手順ごとに別インスタンス */
async function playTrialChain(step: (label: string) => void): Promise<TrialChainResult> {
  // 0. 開示デモを初期状態に戻してから始める（K8。CSRD の流れと同じ扱い）
  await resetDisclosureDemoData((await fresh()).db, author());
  step('リセット');

  // 1. 40a の判断（S02 を適用・3 観点）と対象外の申請（S07）・承認（別の人）
  {
    const { db } = await fresh();
    await saveProjectRequirementAssessment(db, author(), assessment(S02));
    await saveProjectRequirementAssessment(
      db,
      author(),
      assessment(S07, {
        applicability: 'not_applicable',
        applicabilityReason: '（試行）該当する事業を持たないため対象外と判断。',
        disclosureCoverage: null,
        dataCoverage: null,
        processCoverage: null,
      }),
    );
  }
  {
    const { db } = await fresh();
    await requestExclusion(db, author(), S07_TARGET);
  }
  {
    const { db } = await fresh();
    await decideExclusion(db, approver(), { ...S07_TARGET, decision: 'approved' });
  }
  step('40a の判断・対象外の申請と承認');

  // 2. 節の対応付け（40a の節に S02 を足す）
  let blockId: Uuid;
  {
    const { db, fixture } = await fresh();
    const block = fixture.disclosureBlocks.find(
      (b) =>
        b.projectId === IDS.projects.fy2026 &&
        b.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID &&
        b.translationOfBlockId === null &&
        b.deletedAt === null,
    )!;
    expect(block, '40a の節が Fixture に無い').toBeDefined();
    blockId = block.id;
    await updateBlockRequirements(db, author(), {
      blockId,
      itemIds: [...new Set([...block.requirementItemIds, S02])],
      reason: '（試行）S02 を対応付け',
    });
  }
  step('節の対応付け');

  // 3. 要求事項・情報対応表（XLSX）。書くのは監査ログだけ（Cookie に載らない）。横断対応表は読むだけ
  {
    const { db } = await fresh();
    const matrix = await exportRequirementMatrix(db, author(), {
      projectId: IDS.projects.fy2026,
      format: 'xlsx',
    });
    expect(matrix.rowCount).toBeGreaterThan(0);
    const crosswalk = new WriteDetectingDbClient(db);
    await loadCrosswalk(crosswalk, author(), { projectId: IDS.projects.fy2026 });
    expect(crosswalk.writes).toEqual([]);
  }
  step('対応表 XLSX');

  // 4. FY2025 の承認済みレポートを案件へ共有（企業の許諾の管理者）
  let copyId: Uuid;
  {
    const { db } = await fresh();
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    copyId = copy.id;
  }
  step('レポートの共有');

  // 5. 保証側が段落にコメント（クライアントへ共有）→ 6. 企業が回答
  let noteId: Uuid;
  {
    const { db, fixture } = await fresh();
    const copy = fixture.sharedReportCopies.find((c) => c.id === copyId)!;
    const content = parseSharedReportCopy(copy.copy)!;
    const block = content.blocks.find((b) =>
      b.body.paragraphs.some((p) => p.kind === 'paragraph'),
    )!;
    const paragraph = block.body.paragraphs.find((p) => p.kind === 'paragraph')!;
    const note = await createReportNote(db, firmManager(), {
      engagementId: ENG,
      copyId,
      target: { kind: 'report_paragraph', blockId: block.blockId, paragraphId: paragraph.id },
      body: '（試行）この段落の根拠の版を確認させてください。',
      sharedWithClient: true,
    });
    noteId = note.id;
  }
  step('保証側のコメント');
  {
    const { db } = await fresh();
    await respondToNote(db, author(), {
      noteId,
      body: '（試行）取締役会の議事録（版 2）が根拠です。',
    });
  }
  step('企業の回答');

  // 7. Data Room に開示レポート（導出。書き込みは閲覧の監査ログだけ）
  {
    const { db } = await fresh();
    const room = await loadDataRoom(db, firmManager(), ENG);
    expect(room.reports.map((r) => r.copyId)).toContain(copyId);
  }

  // 8. DOCX 出力で突合 0（不一致なら渡さない）
  let artifactId: Uuid;
  {
    const { db } = await fresh();
    const result = await exportReportSnapshot(db, approver(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'docx',
      audience: 'internal',
    });
    expect(result.artifact.mismatchCount).toBe(0);
    artifactId = result.artifact.id;
  }
  step('DOCX と突合');

  // 9. 追跡率（導出）・10. XBRL プレビュー（書き込みなし）
  {
    const { db } = await fresh();
    const trace = await loadSnapshotTrace(db, approver(), {
      projectId: IDS.projects.fy2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    expect(trace.integrityOk).toBe(true);
    expect(trace.summary.label).toMatch(/^\d+ \/ \d+（段落 \d+ \/ \d+・数値 \d+ \/ \d+）$/);
    const guard = new WriteDetectingDbClient(db);
    const preview = await previewXbrl(guard, author(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID });
    expect(guard.writes).toEqual([]);
    expect(preview.integrityOk).toBe(true);
    expect(preview.evaluation).not.toBeNull();
  }
  step('追跡率・XBRL プレビュー');

  // 11. ご意見・シナリオの実施・判定・作業時間（本人名義・判定は管理者）
  {
    const { db } = await fresh();
    await submitFeedback(db, author(), {
      kind: 'request',
      title: '（試行）対応表の列を選びたい',
      body: '（試行）基準横断のシートで列を絞りたい。',
      route: '/enterprise/disclosure-projects',
    });
  }
  {
    const { db } = await fresh();
    await recordScenarioRun(db, author(), {
      scenarioId: trialScenarioId('TS-01'),
      completion: 'self',
      minutes: 15,
      helpCount: 0,
      easeRating: 4,
      comment: '（試行）トレースから承認版へ遡れた。',
      evidenceUrl: '/enterprise/disclosure-projects',
    });
  }
  {
    const { db } = await fresh();
    await judgeScenario(db, admin(), {
      scenarioId: trialScenarioId('TS-01'),
      judgement: 'pass',
      reason: '（試行）選定ケースの追跡を確認。',
      measuredValue: '',
    });
  }
  {
    const { db } = await fresh();
    await recordTaskTiming(db, author(), {
      taskKey: 'check_reconcile',
      mode: 't4d',
      method: 'observed',
      minutes: 30,
      quantity: 1,
      unitLabel: '表',
      department: 'サステナビリティ推進部',
      measuredOn: '2026-10-08',
      note: '（試行）',
    });
  }
  step('ご意見・シナリオ・判定・作業時間');

  // 12. 3 段階の承認ルート（既定は変えない。進行中のデータの経路を変えないため）
  const routeName = '（試行）3 段階の承認';
  {
    const { db } = await fresh();
    await saveApprovalRoute(db, admin(), {
      name: routeName,
      description: '',
      isDefault: false,
      purpose: 'default',
      stages: [
        {
          name: '拠点・部署の確認',
          approverRole: 'reviewer',
          approverUserId: null,
          department: '',
        },
        {
          name: '本社サステナビリティ担当の確認',
          approverRole: 'sustainability_manager',
          approverUserId: null,
          department: '',
        },
        { name: '最終承認', approverRole: 'approver', approverUserId: null, department: '' },
      ],
    });
  }
  step('3 段階の承認ルート');

  return { blockId, copyId, noteId, artifactId, routeName };
}

/** 試行の流れの結果が、別のインスタンスでもすべて残っている */
async function expectTrialResultsPersist(result: TrialChainResult): Promise<void> {
  const { db, fixture } = await fresh();
  // 判断と対象外の承認
  expect(
    fixture.projectRequirementAssessments.filter(
      (a) => a.projectFrameworkId === PF_40A && [S02, S07].includes(a.itemId),
    ),
  ).toHaveLength(2);
  expect((await loadExclusionStatus(db, author(), S07_TARGET)).state.state).toBe('approved');
  const matrix = await loadRequirementMatrix(db, author(), {
    projectId: IDS.projects.fy2026,
    frameworkVersionIds: [ESRS_40A_SAMPLE_VERSION_ID],
  });
  expect(matrix.rows.find((r) => r.itemId === S07)?.category).toBe('excluded');
  // 節の対応付け
  expect(
    fixture.disclosureBlocks.find((b) => b.id === result.blockId)?.requirementItemIds,
  ).toContain(S02);
  // 共有した写し（目録から作り直して内容ハッシュが一致）・コメント・回答
  const copy = fixture.sharedReportCopies.find((c) => c.id === result.copyId);
  expect(copy?.withdrawnAt ?? null).toBeNull();
  expect(parseSharedReportCopy(copy!.copy)).not.toBeNull();
  const notes = await listNotesForClient(db, author(), { copyId: result.copyId });
  const entry = notes.find((n) => n.note.id === result.noteId);
  expect(entry?.state).toBe('answered');
  // 出力の記録（突合 0 件）
  expect(fixture.exportArtifacts.find((a) => a.id === result.artifactId)).toMatchObject({
    mismatchCount: 0,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
  });
  // トライアルの記録
  expect(fixture.trialFeedbackItems.some((f) => f.title === '（試行）対応表の列を選びたい')).toBe(
    true,
  );
  expect(
    fixture.trialScenarioRuns.some(
      (r) =>
        r.scenarioId === trialScenarioId('TS-01') &&
        r.comment === '（試行）トレースから承認版へ遡れた。',
    ),
  ).toBe(true);
  expect(
    fixture.trialScenarioJudgements.some((j) => j.reason === '（試行）選定ケースの追跡を確認。'),
  ).toBe(true);
  expect(fixture.trialTaskTimings.some((t) => t.note === '（試行）' && t.minutes === 30)).toBe(
    true,
  );
  // 3 段階の承認ルート
  const routes = await loadApprovalRoutes(db, admin());
  const route = routes.find((r) => r.route.name === result.routeName);
  expect(route?.stages.map((s) => s.name)).toEqual([
    '拠点・部署の確認',
    '本社サステナビリティ担当の確認',
    '最終承認',
  ]);
}

beforeEach(() => {
  jar.clear();
  sizes.length = 0;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('試行の流れ（plan §4.3-6）は、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('リセット → 判断・対象外 → 対応付け → 対応表 → 共有 → コメント・回答 → 突合 → 追跡率 → XBRL → 評価の記録 → 承認ルート', async () => {
    const result = await playTrialChain(measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectTrialResultsPersist(result);

    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-trial-chain] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${TRIAL_CHAIN_BUDGET_BYTES}B）`,
    );
    expect(peak).toBeLessThanOrEqual(TRIAL_CHAIN_BUDGET_BYTES);
  });

  it('実演の流れ → 開示デモのリセット → 試行の流れでも押し出しが起きず、試行の結果が別インスタンスに残る', async () => {
    await playMainDemoFlow(fresh, () => undefined);
    expect(await demoEditsWereEvicted()).toBe(false);
    const result = await playTrialChain(measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectTrialResultsPersist(result);
    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-main→reset→trial] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${COOKIE_CHUNKS}×${MAX_BYTES_PER_COOKIE}B）`,
    );
    expect(peak).toBeLessThanOrEqual(COOKIE_CHUNKS * MAX_BYTES_PER_COOKIE);
  });
});
