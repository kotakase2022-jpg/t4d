import { describe, expect, it } from 'vitest';
import {
  DEMO_PEERS,
  DEMO_PEER_FISCAL_YEAR,
  DEMO_PEER_VALUES,
  type DemoPeerValue,
} from '@/lib/benchmarks/demo-peers';
import {
  BENCHMARK_METRICS,
  BENCHMARK_METRIC_KEYS,
  DEMO_BENCHMARK_NOTICE,
  GENDER_PAY_GAP_RATE_METHOD,
  GENDER_PAY_RATIO_METHOD,
  peerComparability,
  peerStatistics,
  type ComparisonConditions,
} from '@/lib/domain/benchmark';

/**
 * 他社比較の比較可否（docs/disclosure-first.md §9.5）。
 *  - 単位・範囲（境界）・算定方法/定義・年度・決算月のどれかが違えば比較対象外。理由ごとに示す
 *  - 換算しない（比率↔格差率、LTIFR の 100 万時間↔20 万時間、マーケット↔ロケーション）
 *  - 中央値は比較できる社が 3 社以上のときだけ。順位・総合スコアは無い
 */

const OWN: ComparisonConditions = {
  unit: 't-CO2e',
  boundary: '連結',
  method: null,
  fiscalYear: 'FY2025',
  fiscalYearEndMonth: 3,
};

describe('peerComparability', () => {
  it('すべての条件が同じなら比較できる（理由なし）', () => {
    expect(peerComparability(OWN, { ...OWN })).toEqual({ comparable: true, reasons: [] });
  });

  it('単位が違えば比較対象外（換算しない）', () => {
    const result = peerComparability(
      { ...OWN, unit: '件/百万時間' },
      { ...OWN, unit: '件/20万時間' },
    );
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['unit']);
    expect(result.reasons[0]!.label).toBe('単位が異なる');
    expect(result.reasons[0]!.text).toContain('件/20万時間');
    expect(result.reasons[0]!.text).toContain('換算しません');
  });

  it('範囲（境界）が違えば比較対象外', () => {
    const result = peerComparability(OWN, { ...OWN, boundary: '単体' });
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['boundary']);
    expect(result.reasons[0]!.text).toContain('単体');
  });

  it('自社の範囲を確かめられない（承認済みデータが無い）ときは比較対象外', () => {
    const result = peerComparability({ ...OWN, boundary: null }, OWN);
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['boundary']);
    expect(result.reasons[0]!.text).toContain('確かめられません');
  });

  it('定義が違えば比較対象外（比率と格差率を換算しない）', () => {
    const result = peerComparability(
      { ...OWN, unit: '%', method: GENDER_PAY_RATIO_METHOD },
      { ...OWN, unit: '%', method: GENDER_PAY_GAP_RATE_METHOD },
    );
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['method']);
    expect(result.reasons[0]!.text).toContain('格差率');
    expect(result.reasons[0]!.text).toContain('換算しません');
  });

  it('自社が定義を持つ指標で、比較先の定義が開示されていなければ比較対象外', () => {
    const result = peerComparability(
      { ...OWN, method: GENDER_PAY_RATIO_METHOD },
      { ...OWN, method: null },
    );
    expect(result.reasons.map((r) => r.factor)).toEqual(['method']);
    expect(result.reasons[0]!.text).toContain('開示されていません');
  });

  it('比較先だけが定義を持つとき、同じ定義と確かめられないので比較対象外', () => {
    const result = peerComparability(OWN, { ...OWN, method: '独自の定義' });
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['method']);
  });

  it('年度が違えば比較対象外', () => {
    const result = peerComparability(OWN, { ...OWN, fiscalYear: 'FY2024' });
    expect(result.reasons.map((r) => r.factor)).toEqual(['fiscal_year']);
    expect(result.reasons[0]!.text).toContain('FY2024');
  });

  it('自社に同じ年度が無ければ比較対象外', () => {
    const result = peerComparability({ ...OWN, fiscalYear: null }, OWN);
    expect(result.reasons.map((r) => r.factor)).toEqual(['fiscal_year']);
  });

  it('決算月が違えば比較対象外（同じ FY2025 でも 3 月決算と 12 月決算は比べない）', () => {
    const result = peerComparability(OWN, { ...OWN, fiscalYearEndMonth: 12 });
    expect(result.comparable).toBe(false);
    expect(result.reasons.map((r) => r.factor)).toEqual(['fiscal_year_end']);
    expect(result.reasons[0]!.text).toContain('12 月');
  });

  it('複数の条件が違えば、理由をすべて示す', () => {
    const result = peerComparability(OWN, {
      unit: 'kt-CO2e',
      boundary: '単体',
      method: null,
      fiscalYear: 'FY2024',
      fiscalYearEndMonth: 12,
    });
    expect(result.reasons.map((r) => r.factor)).toEqual([
      'unit',
      'boundary',
      'fiscal_year',
      'fiscal_year_end',
    ]);
  });

  it('前後の空白だけの違いは同じ条件として扱う（表記ゆれで対象外にしない）', () => {
    expect(peerComparability(OWN, { ...OWN, unit: ' t-CO2e ', boundary: '連結 ' }).comparable).toBe(
      true,
    );
  });
});

describe('peerStatistics（比較できる社だけの集計）', () => {
  it('3 社以上なら中央値を出す（奇数）', () => {
    expect(peerStatistics([15300, 12400, 9760])).toEqual({
      n: 3,
      median: 12400,
      medianOmittedReason: null,
      min: 9760,
      max: 15300,
    });
  });

  it('偶数の社数は中央の 2 社の平均', () => {
    expect(peerStatistics([1, 2, 3, 10]).median).toBe(2.5);
  });

  it('2 社以下は中央値を出さず、理由を示す（範囲は出す）', () => {
    const two = peerStatistics([25100, 31200]);
    expect(two.n).toBe(2);
    expect(two.median).toBeNull();
    expect(two.medianOmittedReason).toContain('2 社');
    expect(two.min).toBe(25100);
    expect(two.max).toBe(31200);

    const one = peerStatistics([5]);
    expect(one.median).toBeNull();
    expect(one.min).toBe(5);
  });

  it('0 社なら何も出さない（0 を中央値・範囲にしない）', () => {
    expect(peerStatistics([])).toMatchObject({ n: 0, median: null, min: null, max: null });
  });

  it('順位・総合スコアの項目を持たない', () => {
    const keys = Object.keys(peerStatistics([1, 2, 3]));
    expect(keys.sort()).toEqual(['max', 'median', 'medianOmittedReason', 'min', 'n']);
  });
});

describe('比較する指標の定義', () => {
  it('原単位（売上高・従業員当たり）を比較しない', () => {
    for (const metric of BENCHMARK_METRICS) {
      expect(metric.label).not.toMatch(/原単位|当たり|あたり/);
      expect(metric.ownMetricCode).not.toBe('ghg_intensity');
    }
  });

  it('Scope2 のマーケット基準とロケーション基準は別の指標（読み替えない）', () => {
    const market = BENCHMARK_METRICS.find((m) => m.key === 'scope2_market')!;
    const location = BENCHMARK_METRICS.find((m) => m.key === 'scope2_location')!;
    expect(market.ownMetricCode).toBe('scope2');
    expect(location.ownMetricCode).toBe('scope2_location');
  });

  it('指標のキーと定義が 1 対 1', () => {
    expect(BENCHMARK_METRICS.map((m) => m.key)).toEqual([...BENCHMARK_METRIC_KEYS]);
  });
});

describe('デモ用の比較データ（すべて架空）', () => {
  const valueOf = (peerId: string, key: string): DemoPeerValue =>
    DEMO_PEER_VALUES.find((v) => v.peerId === peerId && v.metricKey === key)!;

  it('表示の文言は固定（実在企業の数値ではないと明示する）', () => {
    expect(DEMO_BENCHMARK_NOTICE).toBe('架空の比較データ（デモ用）。実在企業の数値ではありません');
  });

  it('5 社とも「ピア○社（架空）」で、同業想定の架空業種', () => {
    expect(DEMO_PEERS.map((p) => p.name)).toEqual([
      'ピアA社（架空）',
      'ピアB社（架空）',
      'ピアC社（架空）',
      'ピアD社（架空）',
      'ピアE社（架空）',
    ]);
    for (const peer of DEMO_PEERS) {
      expect(peer.industry).toBe('電子部品（架空・同業想定）');
      expect(peer.sizeBand).toContain('（架空）');
    }
  });

  it('5 社 × 12 指標がそろい、年度はすべて FY2025', () => {
    expect(DEMO_PEER_VALUES).toHaveLength(DEMO_PEERS.length * BENCHMARK_METRICS.length);
    expect(new Set(DEMO_PEER_VALUES.map((v) => v.fiscalYear))).toEqual(
      new Set([DEMO_PEER_FISCAL_YEAR]),
    );
  });

  it('前提の違い: B は 12 月決算、C は単体、D の男女賃金は格差率・LTIFR は 20 万時間当たり', () => {
    expect(valueOf('peer-b', 'scope1').fiscalYearEndMonth).toBe(12);
    expect(valueOf('peer-c', 'scope1').boundary).toBe('単体');
    expect(valueOf('peer-d', 'gender_pay')).toMatchObject({
      value: 26.3,
      method: GENDER_PAY_GAP_RATE_METHOD,
    });
    expect(valueOf('peer-a', 'gender_pay').method).toBe(GENDER_PAY_RATIO_METHOD);
    expect(valueOf('peer-d', 'ltifr')).toMatchObject({ value: 0.18, unit: '件/20万時間' });
    expect(valueOf('peer-a', 'ltifr').unit).toBe('件/百万時間');
  });

  it('未開示は null（0 にしない）。Scope3 合計は全社とも未開示', () => {
    expect(valueOf('peer-d', 'scope2_market').value).toBeNull();
    expect(valueOf('peer-e', 'scope2_location').value).toBeNull();
    expect(valueOf('peer-e', 'water_withdrawal').value).toBeNull();
    expect(
      DEMO_PEER_VALUES.filter((v) => v.metricKey === 'scope3_total').map((v) => v.value),
    ).toEqual([null, null, null, null, null]);
    expect(DEMO_PEER_VALUES.some((v) => v.value === 0)).toBe(false);
  });

  it('§9.5 の表の値（Scope1・女性管理職比率）', () => {
    expect(DEMO_PEERS.map((p) => valueOf(p.id, 'scope1').value)).toEqual([
      12400, 6850, 3920, 9760, 15300,
    ]);
    expect(DEMO_PEERS.map((p) => valueOf(p.id, 'female_manager_ratio').value)).toEqual([
      12.4, 18.9, 9.7, 14.2, 11.0,
    ]);
  });

  it('保証の有無は A が保証あり・E が保証なし（GHG）。人的資本の指標は保証の対象にしない', () => {
    expect(valueOf('peer-a', 'scope1').assured).toBe(true);
    expect(valueOf('peer-e', 'scope1').assured).toBe(false);
    expect(valueOf('peer-a', 'turnover').assured).toBe(false);
  });

  it('同じ条件の社どうしで実際に比較の可否が分かれる（Scope1: A・D・E が比較可、B・C が対象外）', () => {
    const comparable = DEMO_PEERS.filter((peer) => {
      const value = valueOf(peer.id, 'scope1');
      return peerComparability(OWN, {
        unit: value.unit,
        boundary: value.boundary,
        method: value.method,
        fiscalYear: value.fiscalYear,
        fiscalYearEndMonth: value.fiscalYearEndMonth,
      }).comparable;
    }).map((p) => p.id);
    expect(comparable).toEqual(['peer-a', 'peer-d', 'peer-e']);
  });
});
