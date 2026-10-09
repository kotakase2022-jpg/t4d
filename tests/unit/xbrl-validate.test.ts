import { describe, expect, it } from 'vitest';
import { buildFacts } from '@/lib/xbrl/facts';
import { XBRL_RULE_IDS, type XbrlRuleId } from '@/lib/xbrl/rules';
import { validateXbrl, type ValidationExtras } from '@/lib/xbrl/validate';
import {
  conceptId,
  governanceOf,
  scope1Of,
  scope2Of,
  xbrlScenario,
  type XbrlScenario,
} from './xbrl-test-helpers';

/**
 * T4D の簡易検査 V01〜V16（plan §3.5・§3.6「V01〜V16 のそれぞれに落ちるテスト」）。
 * 既定の Fixture（FY2025・SAMPLE）はエラー 0。1 か所ずつ壊して、その規則が指摘することを確かめる。
 */

function run(s: XbrlScenario, extras: ValidationExtras = {}) {
  const built = buildFacts(s.input);
  return { built, result: validateXbrl(s.input, built, extras) };
}

function severities(s: XbrlScenario, rule: XbrlRuleId, extras: ValidationExtras = {}) {
  return run(s, extras)
    .result.findings.filter((f) => f.rule === rule)
    .map((f) => f.severity);
}

describe('既定（Fixture の FY2025）', () => {
  it('エラー 0。SAMPLE は V16 の注記、架空の識別子は V11 の注記', () => {
    const { result, built } = run(xbrlScenario());
    expect(result.counts.error).toBe(0);
    expect(result.blocking).toBe(false);
    expect(result.byRule.V16).toBe('note');
    expect(result.byRule.V11).toBe('note');
    expect(built.facts).toHaveLength(3);
  });

  it('規則は 16 件', () => {
    expect(XBRL_RULE_IDS).toHaveLength(16);
  });
});

describe('規則ごとに落ちる', () => {
  it('V01: 本文の要求事項に確定した対応付けがない（警告）', () => {
    const s = xbrlScenario();
    governanceOf(s).status = 'candidate';
    governanceOf(s).confirmedBy = null;
    governanceOf(s).confirmedAt = null;
    const found = run(s).result.findings.filter((f) => f.rule === 'V01');
    // ガバナンスの節の要求事項（気候-10・気候-11）が対象外になる
    expect(found.length).toBe(2);
    expect(found.every((f) => f.severity === 'warning' && f.itemId)).toBe(true);
  });

  it('V02: 対応付け先の数値が本文にない・値がない（警告・事実を出さない）', () => {
    const s = xbrlScenario();
    scope2Of(s).status = 'confirmed';
    const { result, built } = run(s);
    expect(result.findings.some((f) => f.rule === 'V02' && f.mappingId === scope2Of(s).id)).toBe(
      true,
    );
    expect(built.facts.some((f) => f.mappingId === scope2Of(s).id)).toBe(false);

    const s2 = xbrlScenario();
    s2.snapshot.metricValues[0]!.availabilityStatus = 'not_entered';
    s2.snapshot.metricValues[0]!.value = null;
    expect(severities(s2, 'V02')).toEqual(['warning']);
  });

  it('V03: 金額の概念に t-CO2e・換算できない単位・節を数値の概念に（エラー）', () => {
    const s = xbrlScenario();
    scope1Of(s).conceptId = conceptId('SampleClimateRelatedCapitalExpenditure');
    expect(severities(s, 'V03')).toContain('error');

    const s2 = xbrlScenario();
    s2.snapshot.metricValues[0]!.unitOfMeasure = 'GJ';
    expect(severities(s2, 'V03')).toEqual(['error']);
    expect(run(s2).built.facts.some((f) => f.mappingId === scope1Of(s2).id)).toBe(false);

    const s3 = xbrlScenario();
    governanceOf(s3).conceptId = conceptId('SampleScope1GhgEmissions');
    expect(severities(s3, 'V03')).toEqual(['error']);

    // GHG の概念は tCO2e だけ（MWh は使えない）
    const s4 = xbrlScenario();
    s4.snapshot.metricValues[0]!.unitOfMeasure = 'MWh';
    expect(severities(s4, 'V03')).toEqual(['error']);
  });

  it('V04: 時点（最新値）の指標を期間の概念に・節を時点の概念に（エラー）', () => {
    const s = xbrlScenario();
    const metricId = scope1Of(s).metricId!;
    expect(
      severities(s, 'V04', { metrics: [{ id: metricId, aggregationMethod: 'latest', name: 'x' }] }),
    ).toEqual(['error']);
    expect(
      severities(s, 'V04', { metrics: [{ id: metricId, aggregationMethod: 'sum', name: 'x' }] }),
    ).toEqual([]);

    const s2 = xbrlScenario();
    const tb = s2.pkg.concepts.find((c) => c.localName === 'SampleGovernanceTextBlock')!;
    tb.periodType = 'instant';
    expect(severities(s2, 'V04')).toEqual(['error']);
  });

  it('V05: decimals がない（エラー）・scale が 0 以外（エラー）・精度が値より粗い（警告）', () => {
    const fixtureDefault = severities(xbrlScenario(), 'V05');
    // 既定の Scope1（1240.5・decimals 0）は精度の警告
    expect(fixtureDefault).toEqual(['warning']);

    const s = xbrlScenario();
    scope1Of(s).decimals = null;
    expect(severities(s, 'V05')).toEqual(['error']);
    expect(run(s).result.blocking).toBe(true);

    const s2 = xbrlScenario();
    scope1Of(s2).decimals = 1;
    scope1Of(s2).scale = 3;
    expect(severities(s2, 'V05')).toEqual(['error']);

    // 文章（テキストブロック）に decimals を付けた（Scope1 の精度の警告とは別に、節の行がエラー）
    const s3 = xbrlScenario();
    governanceOf(s3).decimals = 0;
    const onGovernance = run(s3).result.findings.filter(
      (f) => f.rule === 'V05' && f.mappingId === governanceOf(s3).id,
    );
    expect(onGovernance.map((f) => f.severity)).toEqual(['error']);
  });

  it('V06: 同じ概念・コンテキスト・単位に異なる値（エラー）', () => {
    const s = xbrlScenario();
    const mv = s.snapshot.metricValues[0]!;
    const second = { ...structuredClone(mv), dataPointVersionId: 'dpv-second', value: 999 };
    s.snapshot.metricValues.push(second);
    // 本文で 2 つ目の版も引用する
    const block = s.snapshot.blocks.find((b) => b.sectionKey === 'metrics_targets')!;
    block.body.paragraphs.push({
      id: 'extra',
      kind: 'paragraph',
      children: [
        {
          t: 'metric',
          dataPointId: second.dataPointId,
          dataPointVersionId: second.dataPointVersionId,
          display: '999 t-CO2e',
        },
      ],
    });
    const { result } = run(s);
    const v06 = result.findings.filter((f) => f.rule === 'V06');
    expect(v06.length).toBe(2);
    expect(v06.every((f) => f.severity === 'error')).toBe(true);
  });

  it('V07: 本文の表示値と事実の値が一致しない（エラー）', () => {
    const s = xbrlScenario();
    const block = s.snapshot.blocks.find((b) => b.sectionKey === 'metrics_targets')!;
    for (const p of block.body.paragraphs) {
      for (const c of p.children) if (c.t === 'metric') c.display = '1,999 t-CO2e';
    }
    expect(severities(s, 'V07')).toEqual(['error']);
  });

  it('V08: 推計の値を実績として対応付けた（警告）', () => {
    const s = xbrlScenario();
    s.snapshot.metricValues[0]!.valueKind = 'estimate';
    expect(severities(s, 'V08')).toEqual(['warning']);
  });

  it('V09: 未承認の版の値（警告）', () => {
    const s = xbrlScenario();
    s.snapshot.metricValues[0]!.versionApproved = false;
    const { result, built } = run(s);
    expect(result.findings.filter((f) => f.rule === 'V09').map((f) => f.severity)).toEqual([
      'warning',
    ]);
    // 事実は出すが、追跡できない（承認済みの版ではない）
    expect(built.facts.find((f) => f.source.kind === 'metric')!.traceable).toBe(false);
  });

  it('V10: テキストブロックの節が未承認・空（警告）', () => {
    const s = xbrlScenario();
    s.snapshot.blocks.find((b) => b.sectionKey === 'governance')!.isApprovedVersion = false;
    expect(severities(s, 'V10')).toEqual(['warning']);

    const s2 = xbrlScenario();
    s2.snapshot.blocks.find((b) => b.sectionKey === 'governance')!.body = { paragraphs: [] };
    expect(severities(s2, 'V10')).toEqual(['warning']);
    expect(run(s2).built.facts.some((f) => f.mappingId === governanceOf(s2).id)).toBe(false);
  });

  it('V11: 識別子がない（SAMPLE は警告・公式のパッケージはエラー）', () => {
    const s = xbrlScenario();
    s.input.entity = null;
    expect(severities(s, 'V11')).toEqual(['warning']);
    const s2 = xbrlScenario();
    s2.input.entity = null;
    s2.input.pkg = { ...s2.pkg, isSample: false, profile: 'edinet_ssbj', unitRules: {} };
    expect(severities(s2, 'V11')).toEqual(['error']);
  });

  it('V12: タクソノミと基準の版が対応しない（警告）', () => {
    const s = xbrlScenario();
    s.input.pkg = { ...s.pkg, frameworkKey: 'csrd' };
    expect(severities(s, 'V12')).toEqual(['warning']);
    expect(severities(xbrlScenario(), 'V12', { assignedPackageId: 'another-package' })).toEqual([
      'warning',
    ]);
  });

  it('V13: 軸メンバーがない・軸に属さない・パッケージにない（エラー）', () => {
    const s = xbrlScenario();
    scope1Of(s).dimensions = {};
    expect(severities(s, 'V13')).toEqual(['error']);

    const s2 = xbrlScenario();
    scope1Of(s2).dimensions = { SampleGhgBoundaryAxis: 'SampleConsolidatedMember' };
    expect(severities(s2, 'V13')).toEqual(['error']);

    const s3 = xbrlScenario();
    scope1Of(s3).dimensions = { UnknownAxis: 'SampleFinancialControlMember' };
    expect(severities(s3, 'V13')).toEqual(['error']);
  });

  it('V14: 抽象・軸・メンバーに値を付けた（エラー・事実を出さない）', () => {
    const s = xbrlScenario();
    scope1Of(s).conceptId = conceptId('SampleMetricsAndTargetsAbstract');
    expect(severities(s, 'V14')).toEqual(['error']);
    expect(run(s).built.facts.some((f) => f.mappingId === scope1Of(s).id)).toBe(false);
  });

  it('V15: 前年の対応付けに前年の版がない（警告）', () => {
    const s = xbrlScenario();
    scope1Of(s).periodRole = 'prior1';
    expect(severities(s, 'V15')).toEqual(['warning']);
  });

  it('V16: 提出用ではないパッケージは常に注記（提出用の確定版なら出ない）', () => {
    expect(severities(xbrlScenario(), 'V16')).toEqual(['note']);
    const s = xbrlScenario();
    s.input.pkg = { ...s.pkg, filingReady: true };
    expect(severities(s, 'V16')).toEqual([]);
  });
});

describe('事実の組み立て', () => {
  it('% は pure（×10^-2）に換算し、decimals も桁に合わせる。時点の概念は期間の終了日', () => {
    const s = xbrlScenario();
    const mv = s.snapshot.metricValues[0]!;
    mv.unitOfMeasure = '%';
    mv.value = 12.3;
    scope1Of(s).conceptId = conceptId('SampleFemaleManagerRatio');
    scope1Of(s).decimals = 1;
    scope1Of(s).dimensions = { SampleConsolidationAxis: 'SampleConsolidatedMember' };
    const block = s.snapshot.blocks.find((b) => b.sectionKey === 'metrics_targets')!;
    for (const p of block.body.paragraphs) {
      for (const c of p.children) if (c.t === 'metric') c.display = '12.3 %';
    }
    const { built, result } = run(s);
    const fact = built.facts.find((f) => f.mappingId === scope1Of(s).id)!;
    expect(fact.value).toBe('0.123');
    expect(fact.decimals).toBe(3);
    expect(fact.exponent).toBe(-2);
    expect(fact.unit?.measure).toBe('xbrli:pure');
    expect(fact.period).toEqual({ type: 'instant', instant: mv.periodEnd });
    expect(fact.contextId).toBe('CurrentYearInstant_SampleConsolidatedMember');
    expect(result.counts.error).toBe(0);
  });

  it('候補・対象外・削除済みの対応付けからは事実を作らない', () => {
    const s = xbrlScenario();
    scope1Of(s).status = 'candidate';
    governanceOf(s).status = 'excluded';
    governanceOf(s).excludedReason = '理由';
    const metrics = s.mappings.find((m) => m.sectionKey === 'metrics_targets')!;
    metrics.deletedAt = '2026-01-01T00:00:00.000Z';
    expect(run(s).built.facts).toHaveLength(0);
  });

  it('事実の ID・順番は決定的（同じ入力で同じ）', () => {
    const a = run(xbrlScenario()).built.facts.map((f) => f.id);
    const b = run(xbrlScenario()).built.facts.map((f) => f.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    for (const id of a) expect(id).toMatch(/^f-[0-9a-f]{16}$/);
  });
});
