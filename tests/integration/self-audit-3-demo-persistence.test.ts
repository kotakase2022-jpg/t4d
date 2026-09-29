import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, getDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import { applyPendingDemoResetFor, getDb } from '@/lib/repositories';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits, type DemoEdit } from '@/lib/repositories/demo-edit-codec';
import {
  appendDemoEdit,
  demoEditsWereEvicted,
  pendingDemoReset,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import {
  DEMO_RESET_MAX_FUTURE_MS,
  isPlausibleDemoResetMark,
  newDemoResetEpoch,
} from '@/lib/repositories/demo-reset-sync';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
} from '@/lib/services/disclosure-ai-draft';
import { saveBlockVersion } from '@/lib/services/disclosure-block';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { computeBlockFreshness } from '@/lib/services/disclosure-recheck';
import {
  addReviewComment,
  completeReview,
  finalApprove,
  requestReview,
  returnReview,
} from '@/lib/services/disclosure-review';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import { registerKpiTarget } from '@/lib/services/kpi';
import { saveNarrative } from '@/lib/services/narrative';
import {
  commitQuantitativeImport,
  validateQuantitativeImport,
} from '@/lib/services/quantitative-import';
import { createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import {
  confirmSupplierImport,
  previewSupplierImport,
  type SupplierRowDecision,
} from '@/lib/services/scope3-suppliers';
import { transitionDataPoint, updateDataPointValue } from '@/lib/services/data-point-workflow';
import { buildMurataFiles } from '../../scripts/murata-dataset';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 自己監査 第 3 回（2026-09-30）: Demo Mode の Cookie による持ち回りの回帰テスト。
 * next/headers の cookies() をテスト用の入れ物に差し替え、実際の Cookie・リセットの印を確かめる。
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

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  jar.clear();
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);

const RISK = IDS.blocks.fy2026RiskOpportunity;

// ----------------------------------------------------------------------
// F1（永続化）: 「依頼中」を見たインスタンスへ「承認済み」だけが届く
// ----------------------------------------------------------------------

describe('F1 依頼中の状態を持つインスタンスにも、承認・最終段の差戻しが届く', () => {
  it('B は依頼中を見た後、レビュー完了を経ずに承認済みの Cookie を受け取っても承認済みになる', async () => {
    const b = createFixtureDb();
    const { request, version } = await requestReview(db, author(), { blockId: RISK.block });
    // 版は Cookie に載らないため、B にも写しておく（同じインスタンスで保存した想定）
    b.disclosureBlockVersions.push(structuredClone(version));
    applyDemoEdits(b, await readDemoEdits());
    expect(b.reviewRequests.find((r) => r.id === request.id)?.status).toBe('open');

    await completeReview(db, reviewer(), { requestId: request.id });
    await finalApprove(db, approver(), { requestId: request.id });
    const edits = await readDemoEdits();
    applyDemoEdits(b, edits);
    applyDemoEdits(b, edits);
    expect(b.reviewRequests.find((r) => r.id === request.id)?.status).toBe('approved');
    expect(b.disclosureBlocks.find((x) => x.id === RISK.block)?.status).toBe('approved');
    expect(
      b.reviewEvents.filter((e) => e.reviewRequestId === request.id).map((e) => e.eventType),
    ).toEqual(expect.arrayContaining(['requested', 'review_completed', 'approved']));
  });

  it('最終段の差戻しも同じく届く', async () => {
    const b = createFixtureDb();
    const { request, version } = await requestReview(db, author(), { blockId: RISK.block });
    b.disclosureBlockVersions.push(structuredClone(version));
    applyDemoEdits(b, await readDemoEdits());
    await completeReview(db, reviewer(), { requestId: request.id });
    await returnReview(db, approver(), {
      requestId: request.id,
      reason: '根拠の版を確認してください',
      paragraphId: version.body.paragraphs[0]!.id,
    });
    applyDemoEdits(b, await readDemoEdits());
    applyDemoEdits(b, await readDemoEdits());
    expect(b.reviewRequests.find((r) => r.id === request.id)?.status).toBe('returned');
    expect(b.disclosureBlocks.find((x) => x.id === RISK.block)?.status).toBe('returned');
  });

  it('レビュー完了の記録が無いまま承認済みを名乗る Cookie は、依頼中の行を進めない', async () => {
    const b = createFixtureDb();
    const { request, version } = await requestReview(db, author(), { blockId: RISK.block });
    b.disclosureBlockVersions.push(structuredClone(version));
    applyDemoEdits(b, await readDemoEdits());
    const forged: DemoEdit[] = [
      { t: 'reviewRequests', id: request.id, v: { ...request, status: 'approved' } },
      {
        t: 'reviewEvents',
        id: fid('review_event', 'forged-final'),
        v: {
          id: fid('review_event', 'forged-final'),
          organizationId: ORG_IDS.aomi,
          reviewRequestId: request.id,
          eventType: 'approved',
          stage: 'final',
          actorUserId: userId('approver@demo.local'),
          targetVersionId: request.targetVersionId,
          reason: null,
          paragraphId: null,
          idempotencyKey: 'forged-final',
          createdAt: new Date().toISOString(),
        },
      },
    ];
    applyDemoEdits(b, forged);
    expect(b.reviewRequests.find((r) => r.id === request.id)?.status).toBe('open');
  });
});

// ----------------------------------------------------------------------
// F2（永続化）: リセットの基準時刻
// ----------------------------------------------------------------------

describe('F2 ログイン前に前のリハーサルの操作を適用したインスタンスにも、後のリセットが届く', () => {
  it('getDb が操作を適用する前に基準時刻を決める', async () => {
    const shared = getDemoDb();
    // 前のリハーサル: 別のインスタンスで依頼した操作が Cookie に残っている
    const { request } = await requestReview(db, author(), { blockId: RISK.block });
    shared.disclosureBlockVersions.push(
      structuredClone(
        fixture.disclosureBlockVersions.find((v) => v.id === request.targetVersionId)!,
      ),
    );
    // B（このプロセスの共有メモリ）: ログイン画面で getDb が操作を適用する（印はまだ無い）
    await getDb();
    expect(shared.reviewRequests.find((r) => r.id === request.id)?.status).toBe('open');
    expect(await applyPendingDemoResetFor(author())).toBe(false);
    type Applied = { baseline: string; byOrganization: Map<string, string> };
    const g = globalThis as { __t4dAppliedDemoResets?: Applied };
    const instanceB = g.__t4dAppliedDemoResets ? { ...g.__t4dAppliedDemoResets } : undefined;

    await new Promise((resolve) => setTimeout(resolve, 5));
    // A でリセットした（印が Cookie に付き、開示の操作は Cookie から消える）
    await resetDisclosureDemoData(db, author());
    expect(jar.has('t4d.demo-reset')).toBe(true);
    // A と B は同じプロセスで動かしているため、反映済みの記録を B のものへ戻す
    g.__t4dAppliedDemoResets = instanceB
      ? { baseline: instanceB.baseline, byOrganization: new Map() }
      : undefined;

    // B の次のリクエスト: ログイン後に印を反映し、前のリハーサルの依頼が消える
    await getDb();
    expect(await applyPendingDemoResetFor(author())).toBe(true);
    expect(shared.reviewRequests.some((r) => r.id === request.id)).toBe(false);
    expect(shared.disclosureBlocks.find((b) => b.id === RISK.block)?.status).not.toBe(
      'review_requested',
    );
  });
});

// ----------------------------------------------------------------------
// SEC-7: 遠い未来のリセットの印
// ----------------------------------------------------------------------

describe('SEC-7 遠い未来を名乗るリセットの印は反映しない（以後の本物の印を止めさせない）', () => {
  it('時計のずれの幅を超える未来の印は未反映として扱わない', async () => {
    const now = Date.now();
    const future = { organizationId: ORG_IDS.aomi, epoch: '9999999999999-x' };
    expect(isPlausibleDemoResetMark(future, now)).toBe(false);
    expect(
      isPlausibleDemoResetMark(
        { organizationId: ORG_IDS.aomi, epoch: newDemoResetEpoch(now + 1000, 'a') },
        now,
      ),
    ).toBe(true);
    expect(
      isPlausibleDemoResetMark(
        {
          organizationId: ORG_IDS.aomi,
          epoch: newDemoResetEpoch(now + DEMO_RESET_MAX_FUTURE_MS + 60_000, 'a'),
        },
        now,
      ),
    ).toBe(false);

    await getDb();
    jar.set('t4d.demo-reset', `${ORG_IDS.aomi}:9999999999999-x`);
    expect(await pendingDemoReset()).toBeNull();
    expect(await applyPendingDemoResetFor(author())).toBe(false);
    // 本物の印はその後も反映される
    jar.set('t4d.demo-reset', `${ORG_IDS.aomi}:${newDemoResetEpoch(Date.now() + 10, 'real')}`);
    expect(await pendingDemoReset()).not.toBeNull();
  });
});

// ----------------------------------------------------------------------
// SEC-2 / SEC-4: Cookie から承認・判断・設定を作らせない
// ----------------------------------------------------------------------

describe('SEC-2 Cookie から Data Point の値・承認、基準の適用区分を書き換えさせない', () => {
  const dp = () => fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!;

  it('偽の承認済みの版とポインタ、版の無い値、判断の無い適用区分は受け付けない', () => {
    const before = structuredClone(dp());
    const approved = fixture.dataPointVersions.find((v) => v.id === before.currentVersionId)!;
    const forgedId = fid('data_point_version', 'forged-approved');
    const other = createFixtureDb();
    applyDemoEdits(other, [
      {
        t: 'dataPointVersions',
        id: forgedId,
        v: { ...approved, id: forgedId, versionNo: 99, value: 0, status: 'approved' },
      },
      {
        t: 'dataPoints',
        id: before.id,
        v: { currentVersionId: forgedId, status: 'approved', value: 0 },
      },
    ]);
    const after = other.dataPoints.find((d) => d.id === before.id)!;
    expect(after.value).toBe(before.value);
    expect(after.currentVersionId).toBe(before.currentVersionId);

    // 版を作らずに値だけ書き換える
    applyDemoEdits(other, [{ t: 'dataPoints', id: before.id, v: { value: 12345 } }]);
    expect(other.dataPoints.find((d) => d.id === before.id)!.value).toBe(before.value);

    // 判断を足さずに適用区分と現在の判断を書き換える
    const pf = other.projectFrameworks.find((p) => p.id === IDS.projectFrameworks.fy2026Ssbj)!;
    const pfBefore = structuredClone(pf);
    applyDemoEdits(other, [
      {
        t: 'projectFrameworks',
        id: pf.id,
        v: { applicabilityStatus: 'not_applicable', currentDecisionId: null },
      },
    ]);
    expect(other.projectFrameworks.find((p) => p.id === pf.id)).toEqual(pfBefore);
    // 判断の無い基準に「適用」を名乗らせない
    const esrs = other.projectFrameworks.find((p) => p.id === IDS.projectFrameworks.fy2026Esrs40a)!;
    applyDemoEdits(other, [
      { t: 'projectFrameworks', id: esrs.id, v: { applicabilityStatus: 'applicable' } },
    ]);
    expect(other.projectFrameworks.find((p) => p.id === esrs.id)?.applicabilityStatus).toBe(
      'candidate',
    );
  });

  it('画面の操作（値の訂正 → 提出 → 承認）は別インスタンスでも同じ結果になる', async () => {
    const corrected = await updateDataPointValue(db, author(), {
      dataPointId: SCOPE1_CORRECTION.dataPointId,
      value: 1400,
      unitOfMeasure: dp().unitOfMeasure,
      changeReason: 'テスト: 訂正',
    });
    const other = createFixtureDb();
    applyDemoEdits(other, await readDemoEdits());
    const seen = () => other.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!;
    expect(seen().value).toBe(1400);
    expect(seen().currentVersionId).toBe(corrected.version.id);
    expect(seen().status).toBe('draft');

    // 提出 → 承認の道筋を全段階承認 → 最終承認
    await transitionDataPoint(db, author(), {
      dataPointId: SCOPE1_CORRECTION.dataPointId,
      to: 'submitted',
    });
    const steps = () =>
      fixture.dataPointApprovalSteps.filter((s) => s.dataPointId === SCOPE1_CORRECTION.dataPointId);
    const round = Math.max(0, ...steps().map((s) => s.round));
    expect(steps().filter((s) => s.round === round).length).toBeGreaterThan(0);
    // 承認の道筋が残っている間は、Cookie で承認済みを名乗っても別インスタンスでは承認済みにならない
    const pending = createFixtureDb();
    applyDemoEdits(pending, [
      ...(await readDemoEdits()),
      {
        t: 'dataPoints',
        id: SCOPE1_CORRECTION.dataPointId,
        v: {
          status: 'approved',
          approvedBy: userId('approver@demo.local'),
          updatedBy: userId('approver@demo.local'),
        },
      },
    ]);
    expect(pending.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)?.status).not.toBe(
      'approved',
    );
    for (const step of steps().filter((s) => s.round === round)) {
      await db.update('dataPointApprovalSteps', step.id, {
        status: 'approved',
        decidedBy: userId('approver@demo.local'),
        decidedAt: new Date().toISOString(),
      });
    }
    await transitionDataPoint(db, approver(), {
      dataPointId: SCOPE1_CORRECTION.dataPointId,
      to: 'approved',
    });
    expect(fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)?.status).toBe(
      'approved',
    );
    applyDemoEdits(other, await readDemoEdits());
    expect(seen().status).toBe('approved');
    expect(seen().value).toBe(1400);
  });

  it('適用判断の確定は別インスタンスでも同じ区分・判断になる', async () => {
    const { confirmApplicability } = await import('@/lib/services/disclosure-project');
    const decision = await confirmApplicability(db, author(), {
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      applicabilityStatus: 'awaiting_confirmation',
      reason: 'テスト: 草案の公表待ち',
      ruleRef: 'ESRS-40a 公開草案（テスト）',
      confirmedOn: '2026-08-14',
      transitionalNote: null,
    });
    const other = createFixtureDb();
    applyDemoEdits(other, await readDemoEdits());
    const pf = other.projectFrameworks.find((p) => p.id === IDS.projectFrameworks.fy2026Esrs40a)!;
    expect(pf.currentDecisionId).toBe(decision.id);
    expect(pf.applicabilityStatus).toBe('awaiting_confirmation');
  });
});

describe('SEC-4 開示優先モードの切り替えは、組織の管理者の操作だけを Cookie から戻す', () => {
  it('管理権限の無い利用者の名義・名義なしの切り替えは受け付けない', async () => {
    const settings = await setDisclosureFirst(db, admin(), false);
    const other = createFixtureDb();
    applyDemoEdits(other, await readDemoEdits());
    applyDemoEdits(other, [
      {
        t: 'organizationFeatureSettings',
        id: settings.id,
        v: { disclosureFirst: true, updatedBy: userId('site-user@demo.local') },
      },
    ]);
    expect(
      other.organizationFeatureSettings.find((s) => s.id === settings.id)?.disclosureFirst,
    ).toBe(false);

    // 管理者の切り替えは戻す
    await setDisclosureFirst(db, admin(), true);
    applyDemoEdits(other, await readDemoEdits());
    expect(
      other.organizationFeatureSettings.find((s) => s.id === settings.id)?.disclosureFirst,
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------
// REG-1: 取込ジョブの押し出しの知らせ
// ----------------------------------------------------------------------

describe('REG-1 取込ジョブ・ファイルが別の操作で押し出されたら知らせる', () => {
  it('取込ジョブがコメントで押し出されると、押し出しの知らせが出る', async () => {
    await appendDemoEdit('ingestionJobs', 'job-1', { id: 'job-1', status: 'committed' });
    await appendDemoEdit('ingestionRows', 'row-1', { id: 'row-1', jobId: 'job-1' });
    for (let i = 0; i < 12 && !(await demoEditsWereEvicted()); i += 1) {
      await appendDemoEdit('comments', `c-${i}`, {
        id: `c-${i}`,
        body: randomBytes(700).toString('base64'),
      });
      const left = (await readDemoEdits()).map((e) => e.id);
      if (!left.includes('job-1')) {
        // 取込ジョブが押し出されたその時点で知らせが出ている
        expect(await demoEditsWereEvicted()).toBe(true);
        return;
      }
    }
    throw new Error('取込ジョブが押し出されませんでした');
  });

  it('別の取込の行による押し出しも知らせる（同じ取込の行どうしだけ黙る）', async () => {
    await appendDemoEdit('ingestionRows', 'a-0', {
      id: 'a-0',
      jobId: 'job-a',
      body: randomBytes(1400).toString('base64'),
    });
    for (let i = 0; i < 12; i += 1) {
      await appendDemoEdit('ingestionRows', `b-${i}`, {
        id: `b-${i}`,
        jobId: 'job-b',
        body: randomBytes(1400).toString('base64'),
      });
      if (!(await readDemoEdits()).some((e) => e.id === 'a-0')) break;
    }
    expect((await readDemoEdits()).some((e) => e.id === 'a-0')).toBe(false);
    expect(await demoEditsWereEvicted()).toBe(true);
  });
});

// ----------------------------------------------------------------------
// F3（永続化）: 実演の流れ全体を Cookie の容量に収める
// ----------------------------------------------------------------------

describe('F3 実演の流れ（§14.1 の 2〜7 手目）で、2・3 手目の取込を押し出さない', () => {
  it('Scope3 → 標準 CSV → 定性 → AI 下書き → 依頼・差戻し・再依頼・完了・承認 → 草稿 → KPI 目標', async () => {
    await setDisclosureFirst(db, admin(), true);

    // 2 手目: サプライヤーデータ（村田の 1 ファイル）で Scope3 を算定
    const [file] = await buildMurataFiles();
    const preview = await previewSupplierImport(
      db,
      author(),
      PERIOD_IDS.fy2026,
      file!.name,
      file!.bytes,
    );
    const decisions = preview.rows
      .filter((row) => row.skippedReason === null && row.errors.length === 0)
      .map((row) => ({
        supplierCode: row.supplierCode,
        item: row.item,
        dataType: row.dataType as SupplierRowDecision['dataType'],
        amount: row.amount as number,
        unit: row.unit as string,
        factorCode:
          row.factor?.code ??
          row.recommendedFactorCode ??
          (row.needsFactorChoice ? 'EF-PUR-PACK' : null),
      }));
    await confirmSupplierImport(db, author(), PERIOD_IDS.fy2026, decisions);
    const scope3Ids = (await readDemoEdits())
      .filter((e) => e.t === 'calculations')
      .map((e) => `${e.t}:${e.id}`);
    expect(scope3Ids.length).toBeGreaterThan(0);

    // 3 手目: 標準 CSV（配布しているひな形）
    const template = readFileSync(
      join(process.cwd(), 'public', 'templates', 'standard-metrics.csv'),
      'utf8',
    );
    const csv = await validateQuantitativeImport(db, author(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      source: {
        kind: 'file',
        fileName: 'standard-metrics.csv',
        bytes: new TextEncoder().encode(template),
      },
    });
    await commitQuantitativeImport(db, author(), {
      batchId: csv.batchId,
      previewHash: csv.previewHash,
      idempotencyKey: randomUUID(),
      mode: 'all',
      correctionReason: '検針票の再集計により訂正（テスト）',
    });
    const importedIds = (await readDemoEdits())
      .filter((e) => e.t === 'dataPoints' || e.t === 'dataPointVersions')
      .map((e) => `${e.t}:${e.id}`);
    expect(importedIds.length).toBeGreaterThan(0);

    // 4 手目: 定性情報
    const record = fixture.narrativeRecords.find((r) => r.id === IDS.narratives.strategy)!;
    const nv = fixture.narrativeVersions.find((v) => v.id === record.currentVersionId)!;
    await saveNarrative(db, author(), {
      narrativeId: record.id,
      baseVersionId: record.currentVersionId,
      reportingPeriodId: nv.reportingPeriodId,
      scopeNote: nv.scopeNote,
      fields: nv.fields,
      body: `${nv.body} 省電力製品の比率を高めます（架空）。`,
      sourceAnchorIds: nv.sourceAnchorIds,
      changeReason: '方針を追記（テスト）',
      acknowledgeImpact: true,
    });

    // 5 手目: AI 下書き（1 段落を採用し、残りを閉じる）
    const draft = await generateBlockDraft(db, author(), {
      blockId: RISK.block,
      operation: 'draft_from_sources',
      sources: [
        { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
        { kind: 'source_anchor', id: IDS.anchors.riskPhysical },
        { kind: 'source_anchor', id: IDS.anchors.opportunity },
      ],
    });
    if (draft.status !== 'succeeded') throw new Error('AI 下書きに失敗しました');
    const block = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    await adoptDraftParagraphs(db, author(), {
      blockId: RISK.block,
      runId: draft.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    await closeDraftRun(db, author(), { blockId: RISK.block, runId: draft.run.runId });

    // 6 手目: 依頼 → コメント → 差戻し → 修正 → 再依頼 → レビュー完了 → 最終承認
    const first = await requestReview(db, author(), { blockId: RISK.block });
    await addReviewComment(db, reviewer(), {
      blockId: RISK.block,
      paragraphId: first.version.body.paragraphs[0]!.id,
      body: '集計範囲を本文に明記してください。',
      severity: 'info',
    });
    await returnReview(db, reviewer(), {
      requestId: first.request.id,
      reason: '集計範囲を本文に明記してください。',
      paragraphId: first.version.body.paragraphs[0]!.id,
    });
    const returned = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    const body: BlockBody = {
      paragraphs: [
        ...first.version.body.paragraphs,
        { id: 'fix-1', kind: 'paragraph', children: [{ t: 'text', text: '集計範囲は連結。' }] },
      ],
    };
    await saveBlockVersion(db, author(), {
      blockId: RISK.block,
      baseVersionId: returned.currentVersionId,
      body,
      changeReason: '差戻しを受けて集計範囲を明記',
    });
    const second = await requestReview(db, author(), { blockId: RISK.block });
    await completeReview(db, reviewer(), { requestId: second.request.id });
    await finalApprove(db, approver(), { requestId: second.request.id });

    // 7 手目: レビュー用草稿を作り、KPI の目標を登録する
    await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    await registerKpiTarget(db, admin(), {
      targetKey: null,
      metricId: metricId('AOMI', 'scope1'),
      boundary: '連結',
      scopeNote: '連結子会社を含む',
      baseYear: 2024,
      baseValue: 9735.4,
      targetYear: 2035,
      targetValue: 5000,
      targetType: 'absolute',
      direction: 'reduce',
      methodologyNote: 'GHG プロトコル（架空）',
      actualMethodology: '実測値の集計',
      ownerUserId: userId('sustainability@demo.local'),
      revisionReason: null,
    });

    const remaining = new Set((await readDemoEdits()).map((e) => `${e.t}:${e.id}`));
    expect(scope3Ids.filter((id) => !remaining.has(id))).toEqual([]);
    expect(importedIds.filter((id) => !remaining.has(id))).toEqual([]);
    expect(await demoEditsWereEvicted()).toBe(false);
  });
});

// ----------------------------------------------------------------------
// F4（永続化）: 数値データも含めて初期状態へ戻す
// ----------------------------------------------------------------------

describe('F4 リセットで数値データも戻すと、次のリハーサルが同じ初期状態から始まる', () => {
  it('標準 CSV の取込と Scope1 の訂正を戻し、再確認と取込のプレビューが初期状態と同じになる', async () => {
    const metrics = fixture.disclosureBlocks.find((b) => b.id === IDS.blocks.fy2026Metrics.block)!;
    const pristineItem = (await computeBlockFreshness(db, author(), metrics)).items.find(
      (i) => i.refKind === 'metric',
    )!;
    expect(pristineItem.decisions.adopt_new.allowed).toBe(true);
    const template = readFileSync(
      join(process.cwd(), 'public', 'templates', 'standard-metrics.csv'),
      'utf8',
    );
    const previewOf = async () =>
      validateQuantitativeImport(db, author(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        source: {
          kind: 'file',
          fileName: 'standard-metrics.csv',
          bytes: new TextEncoder().encode(template),
        },
      });
    const firstPreview = await previewOf();
    const kinds = (p: typeof firstPreview) => p.rows.map((r) => r.diffKind).join(',');
    const pristineKinds = kinds(firstPreview);
    await commitQuantitativeImport(db, author(), {
      batchId: firstPreview.batchId,
      previewHash: firstPreview.previewHash,
      idempotencyKey: randomUUID(),
      mode: 'all',
      correctionReason: 'テスト',
    });
    await updateDataPointValue(db, author(), {
      dataPointId: SCOPE1_CORRECTION.dataPointId,
      value: 1500,
      unitOfMeasure: fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!
        .unitOfMeasure,
      changeReason: 'テスト: 8 手目の訂正',
    });
    expect(kinds(await previewOf())).not.toBe(pristineKinds);

    // 既定のリセットは数値データに触れない（従来どおり）
    await resetDisclosureDemoData(db, author());
    expect(
      fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)?.changedAfterApproval,
    ).toBe(true);

    // 数値データも戻す
    await resetDisclosureDemoData(db, author(), { includeDataPoints: true });
    const dp = fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!;
    expect(dp.changedAfterApproval).toBe(false);
    expect(dp.currentVersionId).toBe(SCOPE1_CORRECTION.correctedVersionId);
    const item = (await computeBlockFreshness(db, author(), metrics)).items.find(
      (i) => i.refKind === 'metric',
    )!;
    expect(item.decisions.adopt_new.allowed).toBe(true);
    expect(kinds(await previewOf())).toBe(pristineKinds);
    // Cookie にも数値の操作を残さない（別インスタンスで戻らないように）
    const left = await readDemoEdits();
    expect(left.some((e) => e.t === 'dataPoints' || e.t === 'dataPointVersions')).toBe(false);
  });

  it('数値データを戻したリセットは、ほかのインスタンスにも数値の範囲まで反映される', async () => {
    const shared = getDemoDb();
    await getDb();
    const original = structuredClone(
      shared.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!,
    );
    // B のメモリ: 訂正を適用済み
    const index = shared.dataPoints.findIndex((d) => d.id === SCOPE1_CORRECTION.dataPointId);
    shared.dataPoints[index] = { ...original, value: 1, changedAfterApproval: true };
    type Applied = { baseline: string; byOrganization: Map<string, string> };
    const g = globalThis as { __t4dAppliedDemoResets?: Applied };
    const baseline = g.__t4dAppliedDemoResets!.baseline;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await resetDisclosureDemoData(db, author(), { includeDataPoints: true });
    // A（リセットしたインスタンス）と B（共有メモリ）は同じプロセスなので、B の反映済みの記録へ戻す
    g.__t4dAppliedDemoResets = { baseline, byOrganization: new Map() };
    await getDb();
    expect(await applyPendingDemoResetFor(author())).toBe(true);
    expect(shared.dataPoints[index]).toEqual(original);
  });
});
