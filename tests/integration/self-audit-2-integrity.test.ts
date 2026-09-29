import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import {
  computeConsolidatedAggregation,
  consolidatedTrendSeries,
} from '@/lib/services/aggregation';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  AI_RUN_UNAVAILABLE_MESSAGE,
  BlockRefValidationError,
  UNRESOLVABLE_REF_MESSAGE,
  autosaveWorkingBody,
  buildMetricInline,
  metricDisplay,
  saveBlockVersion,
  validateBodyRefs,
} from '@/lib/services/disclosure-block';
import { generateBlockDraft } from '@/lib/services/disclosure-ai-draft';
import { metricDisplay as reportMetricDisplay } from '@/lib/exports/disclosure-report';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import { displayFileName } from '@/lib/services/source-anchor';
import {
  ReviewBlockedError,
  completeReview,
  finalApprove,
  requestReview,
} from '@/lib/services/disclosure-review';
import { createReviewDraftSnapshot, evaluateReportReadiness } from '@/lib/services/report-snapshot';
import type { AuthorizationContext, BlockBody, DataPointVersion, RoleKey } from '@/types/domain';

/**
 * 自己監査 第 2 回（2026-09-29）の指摘の回帰テスト（不変条件）。
 * 各テストの見出しに指摘の ID を付ける（AI_HANDOFF.md の一覧と対応する）。
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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
/** 承認者は reviewer ロールも持つ（Fixture と同じ）＝本文を書ける */
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);

const FY2025 = IDS.projects.fy2025;
const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const METRICS = IDS.blocks.fy2026Metrics.block;

function blockRow(id: string) {
  const row = fixture.disclosureBlocks.find((b) => b.id === id);
  if (!row) throw new Error(`block ${id}`);
  return row;
}

function versionRow(id: string | null) {
  const row = fixture.disclosureBlockVersions.find((v) => v.id === id);
  if (!row) throw new Error(`version ${id}`);
  return row;
}

function withParagraph(body: BlockBody, id: string, text: string): BlockBody {
  return {
    paragraphs: [...body.paragraphs, { id, kind: 'paragraph', children: [{ t: 'text', text }] }],
  };
}

/** 最後の段落の文言だけを変える（1 文字直す） */
function touchLastParagraph(body: BlockBody): BlockBody {
  const paragraphs = structuredClone(body.paragraphs);
  const last = paragraphs[paragraphs.length - 1]!;
  last.children = [...last.children, { t: 'text', text: '。' }];
  return { paragraphs };
}

/** Data Point に未承認の訂正版を足し、現在の版にする */
function addUnapprovedVersion(dataPointId: string): DataPointVersion {
  const dp = fixture.dataPoints.find((d) => d.id === dataPointId)!;
  const versions = fixture.dataPointVersions.filter((v) => v.dataPointId === dataPointId);
  const base = versions[versions.length - 1]!;
  const version: DataPointVersion = {
    ...base,
    id: fid('data_point_version', `${dataPointId}/unapproved-v3`),
    versionNo: versions.length + 1,
    value: (base.value ?? 0) + 10,
    status: 'draft',
    changeReason: 'テスト: 未承認の訂正',
    createdAt: new Date().toISOString(),
  };
  fixture.dataPointVersions.push(version);
  const index = fixture.dataPoints.findIndex((d) => d.id === dataPointId);
  fixture.dataPoints[index] = { ...dp, currentVersionId: version.id, status: 'draft' };
  return version;
}

/** 訂正版を承認する（承認の道筋の最終段と同じく、Data Point を承認済みにして承認記録を残す） */
function approveCurrentVersion(dataPointId: string, versionId: string): void {
  const index = fixture.dataPoints.findIndex((d) => d.id === dataPointId);
  fixture.dataPoints[index] = { ...fixture.dataPoints[index]!, status: 'approved' };
  fixture.approvals.push({
    id: fid('approval', `${dataPointId}/${versionId}/test`),
    organizationId: ORG_IDS.aomi,
    targetType: 'data_point',
    targetId: dataPointId,
    targetVersionId: versionId,
    stage: 'final',
    decision: 'approved',
    actorUserId: userId('approver@demo.local'),
    comment: null,
    decidedAt: new Date().toISOString(),
  });
}

// ----------------------------------------------------------------------
// INV-1: 未承認の新版に対する「維持」は、新版の承認で無効になる
// ----------------------------------------------------------------------

describe('INV-1 新しい版が未承認のときの「維持」は、その版が承認されたら再確認を求める', () => {
  it('承認後は「再確認済み」でなくなり、レポートの確定も止まる', async () => {
    const v3 = addUnapprovedVersion(SCOPE1_CORRECTION.dataPointId);

    const before = await computeBlockFreshness(db, author(), blockRow(METRICS));
    const item = before.items.find((i) => i.refKind === 'metric')!;
    expect(item.newRefId).toBe(v3.id);
    expect(item.newApproved).toBe(false);
    expect(item.decisions.keep_old.allowed).toBe(true);

    const { decision } = await decideRecheck(db, author(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'keep_old',
      reason: '訂正はまだ承認されていないため、承認済みの版を引用し続ける。',
    });
    // 判断の前提（新しい版は未承認）を記録に残す
    expect(decision.newRefApproved).toBe(false);
    expect((await computeBlockFreshness(db, author(), blockRow(METRICS))).status).toBe('rechecked');
    const readinessBefore = await evaluateReportReadiness(db, approver(), IDS.projects.fy2026);
    expect(
      readinessBefore.blockers.some((b) => b.blockId === METRICS && b.code === 'stale_metric_refs'),
    ).toBe(false);

    // 訂正が承認された: 維持の前提が崩れたので、改めて判断を求める
    approveCurrentVersion(SCOPE1_CORRECTION.dataPointId, v3.id);
    const after = await computeBlockFreshness(db, author(), blockRow(METRICS));
    expect(after.status).toBe('upstream_updated');
    expect(after.items.find((i) => i.refKind === 'metric')?.keptOld).toBeNull();
    const readinessAfter = await evaluateReportReadiness(db, approver(), IDS.projects.fy2026);
    expect(
      readinessAfter.blockers.some((b) => b.blockId === METRICS && b.code === 'stale_metric_refs'),
    ).toBe(true);

    // 承認済みの訂正を見たうえで改めて維持すれば、再確認済みに戻る
    const again = await decideRecheck(db, author(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'keep_old',
      reason: '承認された訂正を確認した。開示の数値は前期の公表値のまま据え置く。',
    });
    expect(again.decision.newRefApproved).toBe(true);
    expect((await computeBlockFreshness(db, author(), blockRow(METRICS))).status).toBe('rechecked');
  });
});

// ----------------------------------------------------------------------
// INV-2: 版を追記しても、前の版を書いた人の記録を落とさない
// ----------------------------------------------------------------------

describe('INV-2 前の版を書いた人は、別の人が次の版を作っても本文を書いた人として残る', () => {
  it('承認者の版を担当者が 1 文字直しても、承認者は自分の段落を最終承認できない', async () => {
    const risk = blockRow(RISK);
    // 承認者（reviewer ロールも持つ）が段落を足して版を作る
    const byApprover = await saveBlockVersion(db, approver(), {
      blockId: RISK,
      baseVersionId: risk.currentVersionId,
      body: withParagraph(versionRow(risk.currentVersionId).body, 'appr-1', '承認者の段落。'),
      changeReason: '承認者が追記',
    });
    // 担当者が 1 文字だけ直した版
    const byAuthor = await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: byApprover.version.id,
      body: touchLastParagraph(byApprover.version.body),
      changeReason: '句点を追加',
    });
    expect(byAuthor.version.createdBy).toBe(userId('sustainability@demo.local'));
    expect(byAuthor.version.contributorUserIds).toContain(userId('approver@demo.local'));

    // 最終承認者（プロジェクトの指定: 承）は本文を書いているため、依頼の時点で止める
    await expect(requestReview(db, author(), { blockId: RISK })).rejects.toThrow(
      '最終承認者に指定した人は、この版の本文を書いています',
    );
    // 最終承認者を未定にして依頼しても、承は最終承認できない
    const { request } = await requestReview(db, author(), {
      blockId: RISK,
      approverUserId: null,
    });
    await completeReview(db, reviewer(), { requestId: request.id });
    await expect(finalApprove(db, approver(), { requestId: request.id })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(blockRow(RISK).status).toBe('approval_pending');
  });

  it('再確認の「新しい版を採用」で作った版にも、前の版を書いた人を引き継ぐ', async () => {
    const metrics = blockRow(METRICS);
    const byApprover = await saveBlockVersion(db, approver(), {
      blockId: METRICS,
      baseVersionId: metrics.currentVersionId,
      body: withParagraph(versionRow(metrics.currentVersionId).body, 'appr-m', '承認者の段落。'),
      changeReason: '承認者が追記',
    });
    const { newVersionId } = await decideRecheck(db, author(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'adopt_new',
      reason: null,
    });
    const adopted = versionRow(newVersionId);
    expect(adopted.createdBy).toBe(userId('sustainability@demo.local'));
    expect(adopted.baseVersionId).toBe(byApprover.version.id);
    expect(adopted.contributorUserIds).toContain(userId('approver@demo.local'));
  });
});

// ----------------------------------------------------------------------
// INV-4: 依頼の後の適用判断の更新
// ----------------------------------------------------------------------

describe('INV-4 依頼・承認の後に適用判断を確定し直したら、最終承認・確定で止める', () => {
  function reconfirmDecision(projectFrameworkId: string, key: string): string {
    const decisionId = fid('project_framework_decision', `test/${key}`);
    fixture.projectFrameworkDecisions.push({
      id: decisionId,
      organizationId: ORG_IDS.aomi,
      projectFrameworkId,
      decisionNo: 2,
      applicabilityStatus: 'voluntary',
      reason: 'テスト: 適用区分の見直し',
      ruleRef: 'テスト',
      confirmedOn: '2026-08-14',
      transitionalNote: '経過措置の注記を更新（テスト）',
      conditionsSnapshot: {},
      decidedBy: userId('enterprise-admin@demo.local'),
      decidedAt: new Date().toISOString(),
    });
    const index = fixture.projectFrameworks.findIndex((p) => p.id === projectFrameworkId);
    fixture.projectFrameworks[index] = {
      ...fixture.projectFrameworks[index]!,
      currentDecisionId: decisionId,
    };
    return decisionId;
  }

  it('依頼の後に判断が変わった依頼は最終承認できない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    reconfirmDecision(IDS.projectFrameworks.fy2026Ssbj, 'fy2026-risk');

    const error = await finalApprove(db, approver(), { requestId: request.id }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect((error as ReviewBlockedError).blockers.map((b) => b.code)).toEqual([
      'applicability_changed',
    ]);
    expect(blockRow(RISK).status).toBe('approval_pending');
  });

  it('承認済みの節も、承認の後に判断が変われば確定の阻害条件になる', async () => {
    const before = await evaluateReportReadiness(db, approver(), FY2025);
    expect(before.blockers).toEqual([]);
    reconfirmDecision(IDS.projectFrameworks.fy2025Ssbj, 'fy2025');
    const after = await evaluateReportReadiness(db, approver(), FY2025);
    expect(after.blockers.length).toBeGreaterThan(0);
    expect(after.blockers.every((b) => b.code === 'applicability_changed')).toBe(true);
    expect(after.canConfirm).toBe(false);
  });
});

// ----------------------------------------------------------------------
// INV-5: 推計・目標の値を実績と読ませない
// ----------------------------------------------------------------------

describe('INV-5 推計・目標の数値は、本文・下書き・出力で区分を添える', () => {
  function markKind(versionId: string, valueKind: 'estimate' | 'target') {
    const index = fixture.dataPointVersions.findIndex((v) => v.id === versionId);
    fixture.dataPointVersions[index] = { ...fixture.dataPointVersions[index]!, valueKind };
    return fixture.dataPointVersions[index]!;
  }

  it('本文へ挿入する表示に（推計）（目標）を添え、区分の無い表示は保存時に拒否する', async () => {
    const estimate = markKind(SCOPE1_CORRECTION.correctedVersionId, 'estimate');
    const inline = await buildMetricInline(db, author(), estimate.id);
    expect(inline.display).toMatch(/（推計）$/);
    expect(metricDisplay({ ...estimate, valueKind: 'target' })).toMatch(/（目標）$/);
    expect(metricDisplay({ ...estimate, valueKind: 'actual' })).not.toMatch(/（/);

    const body: BlockBody = {
      paragraphs: [{ id: 'p-est', kind: 'paragraph', children: [inline] }],
    };
    expect(await validateBodyRefs(db, author(), RISK, body)).toEqual([]);
    const bare = { ...inline, display: inline.display.replace('（推計）', '') };
    const issues = await validateBodyRefs(db, author(), RISK, {
      paragraphs: [{ id: 'p-bare', kind: 'paragraph', children: [bare] }],
    });
    expect(issues.map((i) => i.kind)).toEqual(['metric']);
  });

  it('AI 下書きは目標の値を当年度の根拠から外し、推計は区分つきで書いて警告する', async () => {
    const estimate = markKind(SCOPE1_CORRECTION.correctedVersionId, 'estimate');
    const result = await generateBlockDraft(db, author(), {
      blockId: RISK,
      operation: 'draft_from_sources',
      sources: [{ kind: 'metric_version', id: estimate.id }],
    });
    if (result.status !== 'succeeded') throw new Error('下書きに失敗しました');
    const texts = result.run.candidates.map((c) => c.text).join('\n');
    expect(texts).toContain('（推計）');
    expect(result.run.warnings.join(' ')).toContain('推計');

    markKind(SCOPE1_CORRECTION.correctedVersionId, 'target');
    const target = await generateBlockDraft(db, author(), {
      blockId: RISK,
      operation: 'draft_from_sources',
      sources: [
        { kind: 'metric_version', id: estimate.id },
        { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
      ],
      regenerate: true,
    });
    if (target.status !== 'succeeded') throw new Error('下書きに失敗しました');
    expect(target.notes.join(' ')).toContain('目標の値');
    expect(target.run.candidates.map((c) => c.text).join('\n')).not.toContain('（目標）');
  });

  it('確定前の検査は推計の引用を注意として示し（止めない）、出力の本文にも区分を添える', async () => {
    // FY2026 の数値の節が引用している Scope1（版 1）を推計の値にする
    markKind(SCOPE1_CORRECTION.citedVersionId, 'estimate');
    const readiness = await evaluateReportReadiness(db, approver(), IDS.projects.fy2026);
    expect(readiness.blockers.some((b) => b.code === 'metric_not_actual')).toBe(false);
    const assembled = await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    const metricsBlock = assembled.blocks.find((b) => b.blockId === METRICS)!;
    expect(metricsBlock.issues.some((i) => i.code === 'metric_not_actual')).toBe(true);
    const mv = assembled.metricValues.find(
      (m) => m.dataPointVersionId === SCOPE1_CORRECTION.citedVersionId,
    )!;
    expect(reportMetricDisplay(mv)).toMatch(/（推計）$/);
    expect(reportMetricDisplay(mv, { withKind: false })).not.toContain('（推計）');
  });
});

// ----------------------------------------------------------------------
// INV-6: 持分法・連結対象外の拠点の値だけの年度
// ----------------------------------------------------------------------

describe('INV-6 持分法・対象外の拠点にしか値が無い年度の連結値は 0 ではなく「未入力」', () => {
  it('連結値に入った行を別に数え、推移は値なし（null）にする', async () => {
    const scope1 = metricId('AOMI', 'scope1');
    // FY2026 の Scope1 を、持分法の合弁会社（35%）の承認済みの値だけにする
    for (const dp of fixture.dataPoints) {
      if (dp.metricId === scope1 && dp.reportingPeriodId === PERIOD_IDS.fy2026) {
        dp.status = 'submitted';
      }
    }
    const template = fixture.dataPoints.find(
      (d) => d.metricId === scope1 && d.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    fixture.dataPoints.push({
      ...template,
      id: fid('data_point', 'test/jv/scope1/FY2026'),
      unitId: UNIT_IDS.jv,
      value: 416.8,
      status: 'approved',
      valueKind: 'actual',
      availabilityStatus: 'value_present',
    });
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const period = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const aggregation = await computeConsolidatedAggregation(db, author(), period, periods, [
      'scope1',
    ]);
    const agg = aggregation.metrics[0]!;
    expect(agg.valueCount).toBe(1);
    expect(agg.simpleSum).toBeCloseTo(416.8);
    expect(agg.consolidatedValueCount).toBe(0);

    // 前年補完が無い年度: 推移は 0 のバーではなく値なし
    const series = consolidatedTrendSeries(
      [{ period, metrics: [{ ...agg, estimates: [] }] }],
      'scope1',
    );
    expect(series[0]?.value).toBeNull();
  });
});

// ----------------------------------------------------------------------
// F5（セキュリティ）: 他テナントの ID の有無を応答の違いから調べさせない
// ----------------------------------------------------------------------

describe('F5 別組織の行と存在しない行は、自動保存・保存で同じ結果・同じ文言にする', () => {
  async function autosaveOutcome(body: BlockBody): Promise<string> {
    const block = blockRow(RISK);
    try {
      await autosaveWorkingBody(db, author(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body,
      });
      return 'saved';
    } catch (error) {
      return error instanceof BlockRefValidationError
        ? error.issues.map((i) => `${i.kind}:${i.message}`).join('|')
        : `unexpected:${(error as Error).message}`;
    }
  }

  function withCite(anchorId: string): BlockBody {
    return {
      paragraphs: [
        ...versionRow(blockRow(RISK).currentVersionId).body.paragraphs,
        { id: 'x-1', kind: 'paragraph', children: [{ t: 'cite', sourceAnchorId: anchorId }] },
      ],
    };
  }

  it('他社の引用位置と存在しない引用位置は、自動保存で同じ理由で断る', async () => {
    const foreignAnchor = fid('source_anchor', 'test/soten-anchor-2');
    fixture.sourceAnchors.push({
      ...fixture.sourceAnchors[0]!,
      id: foreignAnchor,
      organizationId: ORG_IDS.soten,
    });
    const foreign = await autosaveOutcome(withCite(foreignAnchor));
    const missing = await autosaveOutcome(withCite(fid('source_anchor', 'test/nowhere')));
    expect(foreign).not.toBe('saved');
    expect(foreign).toBe(missing);
    expect(foreign).toContain(UNRESOLVABLE_REF_MESSAGE);
  });

  it('他社の AI 実行と存在しない AI 実行は、版の保存で同じ文言', async () => {
    const foreignRun = fid('ai_run', 'test/soten-run');
    fixture.aiRuns.push({
      ...fixture.aiRuns[0]!,
      id: foreignRun,
      organizationId: ORG_IDS.soten,
    });
    const bodyWith = (runId: string): BlockBody => ({
      paragraphs: [
        {
          id: 'ai-1',
          kind: 'paragraph',
          children: [{ t: 'text', text: '段落。' }],
          aiRunId: runId,
        },
      ],
    });
    const foreign = await validateBodyRefs(db, author(), RISK, bodyWith(foreignRun));
    const missing = await validateBodyRefs(
      db,
      author(),
      RISK,
      bodyWith(fid('ai_run', 'test/nowhere')),
    );
    expect(foreign.map((i) => i.message)).toEqual(missing.map((i) => i.message));
    expect(foreign[0]?.message).toBe(AI_RUN_UNAVAILABLE_MESSAGE);
  });
});

describe('F6 資料名の半角の引用符は、保存する表示名で全角にする', () => {
  it('Content-Disposition で引用を閉じられる文字を名前に残さない', () => {
    expect(displayFileName(`report"; filename*=UTF-8''invoice.html; x=".pdf`)).toBe(
      `report＂; filename*=UTF-8''invoice.html; x=＂.pdf`,
    );
    // ほかの記号は変えない（利用者が付けた名前と一覧の表示を食い違わせない）
    expect(displayFileName('【委員会】#3 資料.pdf')).toBe('【委員会】#3 資料.pdf');
  });
});
