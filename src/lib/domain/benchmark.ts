/**
 * 他社比較の比較可否と集計（docs/disclosure-first.md §9.5）。
 *
 * 手本は kpi.ts の targetComparability（目標と実績の比較条件）。比較の条件が 1 つでも違えば
 * 「比較対象外」とし、理由を示す。**換算はしない**（比率と格差率、マーケット基準とロケーション基準、
 * LTIFR の 100 万時間当たりと 20 万時間当たりを相互に換算すると、定義の違いが値に隠れるため）。
 *
 * 集計は比較できる社だけで行い、社数 n を必ず示す。中央値は n ≥ 3 のときだけ出す
 * （2 社の「中央値」は 2 社の平均にすぎず、分布の代表値として読まれると誤解を招く）。
 * 順位・総合スコアは作らない。良し悪しを色で示すための値（上位・下位の判定）も作らない。
 *
 * `server-only` を付けない純粋モジュール。サービス・画面・テストが同じ規則を使う。
 */

/** 比較データの表示に必ず添える文言（画面の先頭と表の caption） */
export const DEMO_BENCHMARK_NOTICE = '架空の比較データ（デモ用）。実在企業の数値ではありません';

/** 中央値を出す最小の社数 */
export const BENCHMARK_MEDIAN_MIN_PEERS = 3;

export const BENCHMARK_METRIC_KEYS = [
  'scope1',
  'scope2_market',
  'scope2_location',
  'scope3_total',
  'energy',
  'water_withdrawal',
  'waste',
  'female_manager_ratio',
  'female_officer_ratio',
  'gender_pay',
  'ltifr',
  'turnover',
] as const;
export type BenchmarkMetricKey = (typeof BENCHMARK_METRIC_KEYS)[number];

export interface BenchmarkMetric {
  key: BenchmarkMetricKey;
  /** 表の行見出し */
  label: string;
  /** 比較に使う単位（自社の指標の単位がこれと違えば、比較先とも単位の違いとして扱う） */
  unit: string;
  /** 自社の値を取る指標コード（指標マスターの code） */
  ownMetricCode: string;
  /**
   * 自社の算定方法・定義。定義が会社ごとに分かれる指標だけ持つ（null は指標名で定義が決まるもの）。
   * 比較先の method と文字列で一致しなければ比較対象外にする
   */
  ownMethod: string | null;
  /** 行に添える注記（定義・自社の指標の扱い） */
  note: string | null;
}

/** 男女の賃金の定義（自社の指標は「男性の平均賃金に対する女性の平均賃金の割合」） */
export const GENDER_PAY_RATIO_METHOD = '比率（女性 ÷ 男性 × 100）';
export const GENDER_PAY_GAP_RATE_METHOD = '格差率（(男性 − 女性) ÷ 男性 × 100）';

/**
 * 比較する指標。原単位（売上高当たり・従業員当たり）は出さない
 * （売上高の指標が無く、従業員数の集計方法が比較先と揃っていることを確認できないため）。
 * Scope2 のマーケット基準とロケーション基準は別の行で、足したり読み替えたりしない。
 */
export const BENCHMARK_METRICS: readonly BenchmarkMetric[] = [
  {
    key: 'scope1',
    label: 'Scope1',
    unit: 't-CO2e',
    ownMetricCode: 'scope1',
    ownMethod: null,
    note: null,
  },
  {
    key: 'scope2_market',
    label: 'Scope2（マーケット基準）',
    unit: 't-CO2e',
    ownMetricCode: 'scope2',
    ownMethod: null,
    note: 'ロケーション基準とは別の指標です。読み替え・合算はしません。',
  },
  {
    key: 'scope2_location',
    label: 'Scope2（ロケーション基準）',
    unit: 't-CO2e',
    ownMetricCode: 'scope2_location',
    ownMethod: null,
    note: 'マーケット基準とは別の指標です。読み替え・合算はしません。',
  },
  {
    key: 'scope3_total',
    label: 'Scope3 合計',
    unit: 't-CO2e',
    ownMetricCode: 'scope3_total',
    ownMethod: null,
    note: '合計の登録値だけを使います。Cat.1 だけを Scope3 全量として扱いません。',
  },
  {
    key: 'energy',
    label: 'エネルギー使用量',
    unit: 'MWh',
    ownMetricCode: 'energy',
    ownMethod: null,
    note: null,
  },
  {
    key: 'water_withdrawal',
    label: '取水量',
    unit: 'm3',
    ownMetricCode: 'water',
    ownMethod: null,
    note: '自社の値は指標「水使用量」（上水・工業用水・地下水の取水の合計）です。',
  },
  {
    key: 'waste',
    label: '廃棄物排出量',
    unit: 't',
    ownMetricCode: 'waste',
    ownMethod: null,
    note: null,
  },
  {
    key: 'female_manager_ratio',
    label: '女性管理職比率',
    unit: '%',
    ownMetricCode: 'female_manager_ratio',
    ownMethod: null,
    note: '自社の全社値は分子・分母の合計から計算します（拠点値の単純合計・単純平均は使いません）。',
  },
  {
    key: 'female_officer_ratio',
    label: '女性役員比率',
    unit: '%',
    ownMetricCode: 'female_officer_ratio',
    ownMethod: null,
    note: '自社の全社値は分子・分母の合計から計算します（拠点値の単純合計・単純平均は使いません）。',
  },
  {
    key: 'gender_pay',
    label: '男女の賃金（女性 ÷ 男性）',
    unit: '%',
    ownMetricCode: 'gender_pay_gap',
    ownMethod: GENDER_PAY_RATIO_METHOD,
    note: '比率と格差率は別の定義です。換算しません。',
  },
  {
    key: 'ltifr',
    label: 'LTIFR（労働災害度数率）',
    unit: '件/百万時間',
    ownMetricCode: 'ltifr',
    ownMethod: null,
    note: '100 万時間当たりと 20 万時間当たりは換算しません。',
  },
  {
    key: 'turnover',
    label: '離職率',
    unit: '%',
    ownMetricCode: 'turnover_rate',
    ownMethod: null,
    note: null,
  },
];

// ----------------------------------------------------------------------
// 比較の可否
// ----------------------------------------------------------------------

/** 比較の条件（自社・比較先の両方を同じ形で表す） */
export interface ComparisonConditions {
  unit: string;
  /** 範囲（境界）。自社の承認済みデータが無いなどで確かめられなければ null */
  boundary: string | null;
  /** 算定方法・定義。定義で分かれない指標は null */
  method: string | null;
  /** 年度（例: FY2025） */
  fiscalYear: string | null;
  /** 決算月（1〜12） */
  fiscalYearEndMonth: number | null;
}

export const COMPARABILITY_FACTORS = [
  'unit',
  'boundary',
  'method',
  'fiscal_year',
  'fiscal_year_end',
] as const;
export type ComparabilityFactor = (typeof COMPARABILITY_FACTORS)[number];

/** 比較対象外の理由の短いラベル（バッジ） */
export const COMPARABILITY_FACTOR_LABEL: Record<ComparabilityFactor, string> = {
  unit: '単位が異なる',
  boundary: '範囲が異なる',
  method: '定義が異なる',
  fiscal_year: '年度が異なる',
  fiscal_year_end: '決算月が異なる',
};

export interface ComparabilityReason {
  factor: ComparabilityFactor;
  /** 短いラベル（COMPARABILITY_FACTOR_LABEL） */
  label: string;
  /** 自社と比較先の値を添えた説明 */
  text: string;
}

export interface Comparability {
  comparable: boolean;
  reasons: ComparabilityReason[];
}

const norm = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

function reason(factor: ComparabilityFactor, text: string): ComparabilityReason {
  return { factor, label: COMPARABILITY_FACTOR_LABEL[factor], text };
}

/**
 * 自社と比較先を同じ条件で比べられるか。単位・範囲（境界）・算定方法/定義・年度・決算月の
 * どれかが違う（または確かめられない）なら比較対象外。値は換算しない（この関数は値を見ない）。
 * 第三者保証の有無は可否に使わない（注記として別に示す）
 */
export function peerComparability(
  own: ComparisonConditions,
  peer: ComparisonConditions,
): Comparability {
  const reasons: ComparabilityReason[] = [];

  const ownUnit = norm(own.unit);
  const peerUnit = norm(peer.unit);
  if (ownUnit === null || peerUnit === null || ownUnit !== peerUnit) {
    reasons.push(
      reason(
        'unit',
        `単位が異なります（自社 ${ownUnit ?? '不明'} ／ 比較先 ${peerUnit ?? '不明'}）。換算しません。`,
      ),
    );
  }

  const ownBoundary = norm(own.boundary);
  const peerBoundary = norm(peer.boundary);
  if (ownBoundary === null) {
    reasons.push(
      reason(
        'boundary',
        '自社の範囲（境界）を確かめられません（自社の承認済みデータがありません）。',
      ),
    );
  } else if (peerBoundary === null) {
    reasons.push(reason('boundary', '比較先の範囲（境界）が開示されていません。'));
  } else if (ownBoundary !== peerBoundary) {
    reasons.push(
      reason(
        'boundary',
        `範囲（境界）が異なります（自社 ${ownBoundary} ／ 比較先 ${peerBoundary}）。`,
      ),
    );
  }

  const ownMethod = norm(own.method);
  const peerMethod = norm(peer.method);
  if (ownMethod !== null && peerMethod === null) {
    reasons.push(reason('method', '比較先の算定方法・定義が開示されていません。'));
  } else if (ownMethod === null && peerMethod !== null) {
    reasons.push(reason('method', `比較先の定義（${peerMethod}）を自社と同じと確かめられません。`));
  } else if (ownMethod !== null && peerMethod !== null && ownMethod !== peerMethod) {
    reasons.push(
      reason(
        'method',
        `定義が異なります（自社 ${ownMethod} ／ 比較先 ${peerMethod}）。換算しません。`,
      ),
    );
  }

  const ownYear = norm(own.fiscalYear);
  const peerYear = norm(peer.fiscalYear);
  if (ownYear === null) {
    reasons.push(
      reason('fiscal_year', `自社に比較先と同じ年度（${peerYear ?? '不明'}）がありません。`),
    );
  } else if (peerYear === null || ownYear !== peerYear) {
    reasons.push(
      reason(
        'fiscal_year',
        `年度が異なります（自社 ${ownYear} ／ 比較先 ${peerYear ?? '不明'}）。`,
      ),
    );
  }

  if (own.fiscalYearEndMonth === null || peer.fiscalYearEndMonth === null) {
    reasons.push(reason('fiscal_year_end', '決算月を確かめられません。'));
  } else if (own.fiscalYearEndMonth !== peer.fiscalYearEndMonth) {
    reasons.push(
      reason(
        'fiscal_year_end',
        `決算月が異なります（自社 ${own.fiscalYearEndMonth} 月 ／ 比較先 ${peer.fiscalYearEndMonth} 月）。`,
      ),
    );
  }

  return { comparable: reasons.length === 0, reasons };
}

// ----------------------------------------------------------------------
// 比較できる社の集計
// ----------------------------------------------------------------------

export interface PeerStatistics {
  /** 比較できる社のうち値を開示している社の数（集計の分母） */
  n: number;
  /** 中央値。n < 3 のときは null（medianOmittedReason に理由） */
  median: number | null;
  medianOmittedReason: string | null;
  /** 範囲（最小〜最大）。n = 0 のときは null */
  min: number | null;
  max: number | null;
}

/** 比較できる社の値だけを渡す（比較対象外・未開示を混ぜない）。値は換算せずそのまま扱う */
export function peerStatistics(values: readonly number[]): PeerStatistics {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return {
      n,
      median: null,
      medianOmittedReason: '比較できる社がありません。',
      min: null,
      max: null,
    };
  }
  let median: number | null = null;
  let medianOmittedReason: string | null = null;
  if (n >= BENCHMARK_MEDIAN_MIN_PEERS) {
    const mid = Math.floor(n / 2);
    median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  } else {
    medianOmittedReason = `比較できる社が ${n} 社のため、中央値は出しません（${BENCHMARK_MEDIAN_MIN_PEERS} 社以上で表示）。`;
  }
  return { n, median, medianOmittedReason, min: sorted[0]!, max: sorted[n - 1]! };
}
