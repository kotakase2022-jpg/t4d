import { describe, expect, it } from 'vitest';
import {
  completionRate,
  effectiveRuns,
  effectiveTimings,
  formatRatePercent,
  inquiryCount,
  isUnresolved,
  judgementStateOf,
  latestJudgement,
  median,
  openIssueSummary,
  passRate,
  rateOf,
  reductionRate,
  reductionTargetLabel,
  reductionTargetOf,
  summarizeTimingsByTask,
  TRIAL_MIN_SAMPLE,
  verificationLabel,
} from '@/lib/domain/trial-metrics';
import type { TrialFeedbackItem, TrialTaskTiming } from '@/types/domain';

/**
 * トライアルの評価の数え方（NF-33・NF-34・NF-35）。率は n と一緒に返し、n < 3 では率を出さない。
 */

function timing(
  mode: 'baseline' | 't4d',
  minutes: number,
  overrides: Partial<TrialTaskTiming> = {},
): TrialTaskTiming {
  return {
    id: `${mode}-${minutes}-${Math.random()}`,
    organizationId: 'org',
    taskKey: 'transcription',
    mode,
    unitLabel: '節',
    quantity: 1,
    minutes,
    method: 'self_report',
    department: '',
    measuredOn: '2026-10-01',
    scenarioRunId: null,
    supersedesId: null,
    note: '',
    recordedBy: 'u',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('率と件数', () => {
  it('n < 3 は率を出さず「件数不足（n=2）」、0 件は「記録なし」（0% と出さない）', () => {
    expect(TRIAL_MIN_SAMPLE).toBe(3);
    expect(rateOf(2, 2)).toMatchObject({
      rate: null,
      insufficient: true,
      label: '件数不足（n=2）',
    });
    expect(rateOf(0, 0)).toMatchObject({ rate: null, n: 0, label: '記録なし' });
    expect(rateOf(2, 3)).toMatchObject({ rate: 2 / 3, n: 3, label: '66.7%（2 / 3）' });
    expect(formatRatePercent(1)).toBe('100%');
    expect(formatRatePercent(0.25)).toBe('25%');
  });

  it('自力完遂率は「自力で完了」だけを数える（支援を受けて完了は数えない）', () => {
    const runs = [
      { completion: 'self' as const },
      { completion: 'with_help' as const },
      { completion: 'not_completed' as const },
      { completion: 'self' as const },
    ];
    expect(completionRate(runs)).toMatchObject({ rate: 0.5, numerator: 2, n: 4 });
    expect(completionRate(runs.slice(0, 2)).label).toBe('件数不足（n=2）');
  });

  it('問い合わせ回数は 1 実施あたり（n と合計を併記）', () => {
    const result = inquiryCount([{ helpCount: 0 }, { helpCount: 1 }, { helpCount: 2 }]);
    expect(result).toMatchObject({ total: 3, n: 3, perRun: 1 });
    expect(result.label).toBe('1.0 回（計 3 回・n=3）');
    expect(inquiryCount([{ helpCount: 4 }]).perRun).toBeNull();
  });

  it('訂正された記録は数えない（新しい記録が supersedes で指したもの）', () => {
    const runs = [
      { id: 'a', supersedesRunId: null },
      { id: 'b', supersedesRunId: 'a' },
      { id: 'c', supersedesRunId: null },
    ];
    expect(effectiveRuns(runs).map((r) => r.id)).toEqual(['b', 'c']);
    const rows = [
      { id: 'x', supersedesId: null },
      { id: 'y', supersedesId: 'x' },
    ];
    expect(effectiveTimings(rows).map((r) => r.id)).toEqual(['y']);
  });
});

describe('判定と合格率', () => {
  it('最新の判定が前の判定に代わる。記録が無ければ未判定', () => {
    const judgements = [
      { scenarioId: 's1', judgement: 'hold' as const, judgedAt: '2026-10-01T00:00:00Z' },
      { scenarioId: 's1', judgement: 'pass' as const, judgedAt: '2026-10-02T00:00:00Z' },
      { scenarioId: 's2', judgement: 'fail' as const, judgedAt: '2026-10-03T00:00:00Z' },
    ];
    expect(latestJudgement(judgements, 's1')?.judgement).toBe('pass');
    expect(judgementStateOf(latestJudgement(judgements, 's3'))).toBe('not_judged');
  });

  it('合格率の分母は判定済み（保留は合格に数えない）。未判定は別に数える', () => {
    const result = passRate(['pass', 'pass', 'hold', 'fail', 'not_judged']);
    expect(result).toMatchObject({ rate: 0.5, numerator: 2, n: 4, notJudged: 1 });
    expect(passRate(['pass', 'not_judged']).label).toBe('件数不足（n=1）');
  });
});

describe('作業時間の短縮率（reductionRate）', () => {
  it('両方 n ≥ 3 のときだけ、1 単位あたりの分の中央値から短縮率を出す', () => {
    const rows = [
      timing('baseline', 120),
      timing('baseline', 110),
      timing('baseline', 130),
      timing('t4d', 85),
      timing('t4d', 90),
      timing('t4d', 80),
    ];
    const result = reductionRate(rows);
    expect(result.baseline).toMatchObject({ median: 120, n: 3 });
    expect(result.t4d).toMatchObject({ median: 85, n: 3 });
    expect(result.savedMinutesPerUnit).toBe(35);
    expect(result.rate).toBeCloseTo(35 / 120);
    expect(result.label).toBe('29.2% 短縮');
  });

  it('数量で割った 1 単位あたりの分で比べる', () => {
    const rows = [
      timing('baseline', 200, { quantity: 2 }),
      timing('baseline', 100),
      timing('baseline', 300, { quantity: 3 }),
      timing('t4d', 50),
      timing('t4d', 100, { quantity: 2 }),
      timing('t4d', 150, { quantity: 3 }),
    ];
    expect(reductionRate(rows).rate).toBeCloseTo(0.5);
  });

  it('片方が n < 3 なら率を出さない（件数を併記）', () => {
    const rows = [
      timing('baseline', 60),
      timing('baseline', 70),
      timing('t4d', 40),
      timing('t4d', 41),
      timing('t4d', 42),
    ];
    const result = reductionRate(rows);
    expect(result.rate).toBeNull();
    expect(result.label).toBe('件数不足（現行 n=2・T4D n=3）');
  });

  it('T4D の方が長ければ「増加」と出す（短縮と言わない）', () => {
    const rows = [
      timing('baseline', 10),
      timing('baseline', 10),
      timing('baseline', 10),
      timing('t4d', 12),
      timing('t4d', 12),
      timing('t4d', 12),
    ];
    expect(reductionRate(rows).label).toBe('20% 増加（短縮していません）');
  });

  it('記録からの推定を含むかを返す（待ち時間を含む参考値）', () => {
    const rows = [timing('t4d', 10, { method: 'log_estimate' })];
    expect(reductionRate(rows).t4d.includesLogEstimate).toBe(true);
  });

  it('6 作業すべてを並べ、訂正された記録は除く', () => {
    const original = timing('baseline', 999, { id: 'orig' });
    const corrected = timing('baseline', 100, { supersedesId: 'orig' });
    const tasks = summarizeTimingsByTask([original, corrected]);
    expect(tasks).toHaveLength(6);
    expect(tasks[0]!.baseline).toMatchObject({ median: 100, n: 1 });
    expect(tasks[1]!.label).toBe('記録なし');
  });

  it('中央値（偶数件は中央 2 件の平均）', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('目標は計画の options から読み、結果とは別の文言にする', () => {
    expect(reductionTargetOf({})).toBeNull();
    expect(reductionTargetOf({ reductionTarget: { minPercent: 30, maxPercent: 20 } })).toBeNull();
    const target = reductionTargetOf({ reductionTarget: { minPercent: 15, maxPercent: 25 } });
    expect(target).toEqual({ minPercent: 15, maxPercent: 25 });
    expect(reductionTargetLabel(target)).toBe('目標 15〜25% 短縮');
    expect(reductionTargetLabel(null)).toBe('目標は未設定');
  });
});

describe('改善管理表の集計', () => {
  function item(overrides: Partial<TrialFeedbackItem>): TrialFeedbackItem {
    return {
      id: 'i',
      organizationId: 'org',
      kind: 'defect',
      channel: 'in_app',
      title: 't',
      body: '',
      routePattern: '',
      scenarioId: null,
      severity: null,
      mandatoryRequirement: false,
      status: 'open',
      responsePolicy: '',
      costClass: 'undecided',
      ownerLabel: '',
      dueOn: null,
      resolvedInVersion: '',
      verificationResult: '',
      verifiedBy: null,
      verifiedAt: null,
      agreed: false,
      environmentVersion: '',
      deletedAt: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      createdBy: 'u',
      updatedBy: 'u',
      ...overrides,
    };
  }

  it('対応しないは合意があれば解決扱い。解決済み・再検証済みは解決', () => {
    expect(isUnresolved(item({ status: 'open' }))).toBe(true);
    expect(isUnresolved(item({ status: 'in_progress' }))).toBe(true);
    expect(isUnresolved(item({ status: 'wont_fix', agreed: false }))).toBe(true);
    expect(isUnresolved(item({ status: 'wont_fix', agreed: true }))).toBe(false);
    expect(isUnresolved(item({ status: 'resolved' }))).toBe(false);
    expect(isUnresolved(item({ status: 'verified' }))).toBe(false);
  });

  it('必須要件 × 重大 × 未解決を数える（削除済みは数えない）', () => {
    const summary = openIssueSummary([
      item({ severity: 'critical', mandatoryRequirement: true }),
      item({ severity: 'critical', mandatoryRequirement: true, status: 'resolved' }),
      item({ severity: 'critical', mandatoryRequirement: false }),
      item({ severity: 'major', mandatoryRequirement: true }),
      item({ severity: 'critical', mandatoryRequirement: true, deletedAt: '2026-10-02T00:00:00Z' }),
      item({ kind: 'positive', status: 'open' }),
    ]);
    expect(summary.mandatoryCriticalOpen).toBe(1);
    expect(summary.total).toBe(5);
    expect(summary.positive).toBe(1);
    // 良かった点は未解決の課題に数えない
    expect(summary.unresolved).toBe(3);
    expect(summary.byKind.defect).toBe(4);
  });

  it('再検証の結果は語で出す（生の値を出さない）', () => {
    expect(verificationLabel('pass')).toBe('再検証で解消を確認');
    expect(verificationLabel('fail')).toBe('再検証で解消せず');
    expect(verificationLabel('')).toBe('未実施');
  });
});
