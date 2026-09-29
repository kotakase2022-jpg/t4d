import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, at, dataPointId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { DbClient } from '@/lib/repositories/types';
import {
  DISCLOSURE_DEMO_RESET_TABLES,
  resetDisclosureDemoData,
} from '@/lib/services/disclosure-demo-reset';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 開示デモのリセット（指示書 §14.2「デモ開始時に初期状態を再現できる。既存データ・他期間を消さず、
 * 明示したデモ領域だけに作用する」）。
 *
 * - デモ中に作った行は消え、書き換えた行は Fixture の値へ戻る
 * - 数値データ・資料・SSBJ 評価・機能設定・別テナントの行には触れない
 * - Demo Mode 専用（Supabase の DbClient では拒否）、開示の編集権限が必要
 */

let fixture: FixtureDb;
let db: DemoDbClient;

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
      organizationName: 'テスト組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

/** 開示優先モードの表の、主役の企業の行（比較用） */
function disclosureRows(db: FixtureDb) {
  return Object.fromEntries(
    DISCLOSURE_DEMO_RESET_TABLES.map((table) => [
      table,
      byId(
        (db[table] as unknown as Array<{ id: string; organizationId: string }>).filter(
          (r) => r.organizationId === ORG_IDS.aomi,
        ),
      ),
    ]),
  );
}

/** デモで操作した状態を作る（原稿の依頼・版の追加・プロジェクト作成・KPI 改訂・AI 下書き） */
async function playDemo() {
  const risk = IDS.blocks.fy2026RiskOpportunity;
  const newVersionId = fid('disclosure_block_version', 'demo/risk/v2');
  const base = fixture.disclosureBlockVersions.find((v) => v.id === risk.version)!;
  await db.insert('disclosureBlockVersions', [
    {
      ...base,
      id: newVersionId,
      versionNo: 2,
      baseVersionId: risk.version,
      changeReason: 'デモで修正',
      createdAt: at(0, 1),
    },
  ]);
  await db.update('disclosureBlocks', risk.block, {
    status: 'review_requested',
    currentVersionId: newVersionId,
    submittedVersionId: newVersionId,
    workingBody: { paragraphs: [] },
    updatedAt: at(0, 2),
  });
  await db.insert('reviewRequests', [
    {
      ...fixture.reviewRequests.find((r) => r.id === IDS.blocks.fy2026Governance.request)!,
      id: fid('review_request', 'demo/risk/1'),
      targetId: risk.block,
      targetVersionId: newVersionId,
      status: 'open',
    },
  ]);
  await db.update('narrativeRecords', IDS.narratives.financialImpact, {
    title: 'デモで書き換えた題名',
  });
  await db.insert('disclosureProjects', [
    {
      ...fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!,
      id: fid('disclosure_project', 'demo/new'),
      name: 'デモで作ったプロジェクト',
    },
  ]);
  await db.insert('kpiTargets', [
    {
      ...fixture.kpiTargets.find((k) => k.id === IDS.kpiTargets.scope1)!,
      id: fid('kpi_target', 'demo/scope1/v2'),
      versionNo: 2,
      targetValue: 7_000,
      revisionReason: 'デモで改訂',
    },
  ]);
  await db.insert('aiRuns', [
    {
      id: fid('ai_run', 'demo/disclosure-draft'),
      organizationId: ORG_IDS.aomi,
      jobId: null,
      featureType: 'disclosureBlockDraft',
      provider: 'mock',
      model: 'mock',
      promptVersion: 'test',
      inputReferenceIds: [risk.block],
      outputJson: {},
      sourceReferences: [],
      confidence: 0.5,
      warnings: [],
      latencyMs: 1,
      tokenUsage: { input: 0, output: 0, total: 0 },
      estimatedCostUsd: 0,
      status: 'succeeded',
      errorMessage: null,
      engagementId: null,
      reviewedBy: null,
      acceptedAt: null,
      rejectedAt: null,
      createdAt: at(0, 3),
      createdBy: userId('sustainability@demo.local'),
    },
  ]);
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('開示デモのリセット', () => {
  it('デモ中に作った行を消し、書き換えた行を Fixture の値へ戻す', async () => {
    const pristine = disclosureRows(createFixtureDb());
    await playDemo();
    expect(disclosureRows(fixture)).not.toEqual(pristine);

    const result = await resetDisclosureDemoData(db, author());

    expect(disclosureRows(fixture)).toEqual(pristine);
    // 作った行: 版・依頼・プロジェクト・KPI の版・AI 下書き（5 行）
    expect(result.removedRows).toBe(5);
    // 戻した行: 節・定性情報の台帳（2 行）
    expect(result.restoredRows).toBe(2);
    expect(result.byTable.disclosureBlocks).toEqual({ removed: 0, restored: 1 });
    expect(result.byTable.aiRuns).toEqual({ removed: 1, restored: 0 });
    // 自動保存の本文も初期状態（なし）へ戻る
    const riskBlock = fixture.disclosureBlocks.find(
      (b) => b.id === IDS.blocks.fy2026RiskOpportunity.block,
    );
    expect(riskBlock?.workingBody).toBeNull();
    expect(riskBlock?.status).toBe('draft');
  });

  it('リセットは監査ログに残る', async () => {
    await playDemo();
    await resetDisclosureDemoData(db, author());
    const event = fixture.auditEvents.find((e) => e.resourceType === 'disclosure_demo_reset');
    expect(event?.eventType).toBe('project_updated');
    expect(event?.actorUserId).toBe(userId('sustainability@demo.local'));
  });

  it('他の領域（数値データ・資料・SSBJ 評価・機能設定・他の AI 実行）と別テナントには触れない', async () => {
    await playDemo();
    // 他の領域をデモ中に操作した状態
    const dpId = dataPointId('HQ', 'scope1', 'FY2026');
    await db.update('dataPoints', dpId, { status: 'draft' });
    const assessment = fixture.ssbjAssessments[0]!;
    await db.update('ssbjAssessments', assessment.id, { reviewComment: 'デモで入力' });
    await setDisclosureFirst(db, admin(), true);
    // 開示の原稿以外の AI 実行（Copilot など）はデモ中に作られたものでも残す
    const draftRun = fixture.aiRuns.find((r) => r.featureType === 'disclosureBlockDraft')!;
    const otherAiRunId = fid('ai_run', 'demo/copilot');
    await db.insert('aiRuns', [{ ...draftRun, id: otherAiRunId, featureType: 'copilotChat' }]);
    const filesBefore = fixture.files.length;
    // 別テナントの開示プロジェクト（同じ表でも組織が違えば消さない）
    const sotenProjectId = fid('disclosure_project', 'SOTEN/demo');
    fixture.disclosureProjects.push({
      ...fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!,
      id: sotenProjectId,
      organizationId: ORG_IDS.soten,
      reportingPeriodId: PERIOD_IDS.fy2026,
    });

    await resetDisclosureDemoData(db, author());

    expect(fixture.dataPoints.find((d) => d.id === dpId)?.status).toBe('draft');
    expect(fixture.ssbjAssessments.find((a) => a.id === assessment.id)?.reviewComment).toBe(
      'デモで入力',
    );
    expect(
      fixture.organizationFeatureSettings.find((s) => s.organizationId === ORG_IDS.aomi)
        ?.disclosureFirst,
    ).toBe(true);
    expect(fixture.files).toHaveLength(filesBefore);
    expect(fixture.aiRuns.some((r) => r.id === otherAiRunId)).toBe(true);
    expect(fixture.aiRuns.some((r) => r.featureType === 'disclosureBlockDraft')).toBe(false);
    expect(fixture.disclosureProjects.some((p) => p.id === sotenProjectId)).toBe(true);
  });

  it('初期状態のままならリセットしても何も変えない', async () => {
    const before = disclosureRows(fixture);
    const result = await resetDisclosureDemoData(db, author());
    expect(result).toMatchObject({ removedRows: 0, restoredRows: 0 });
    expect(disclosureRows(fixture)).toEqual(before);
  });

  it('Demo Mode 以外の DbClient（本番）では実行を拒否する', async () => {
    const notDemo = { mode: 'supabase' } as unknown as DbClient;
    await expect(resetDisclosureDemoData(notDemo, author())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('開示の編集権限（enterprise.disclosure.write）が無いと実行できない', async () => {
    const site = ctxFor('site-user@demo.local', ['site_contributor']);
    await playDemo();
    await expect(resetDisclosureDemoData(db, site)).rejects.toBeInstanceOf(AuthorizationError);
    // 何も消えていない
    expect(fixture.disclosureProjects.some((p) => p.name === 'デモで作ったプロジェクト')).toBe(
      true,
    );
  });
});
