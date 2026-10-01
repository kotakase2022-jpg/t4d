import {
  GENDER_PAY_GAP_RATE_METHOD,
  GENDER_PAY_RATIO_METHOD,
  type BenchmarkMetricKey,
} from '@/lib/domain/benchmark';

/**
 * 他社比較のデモ用データ（docs/disclosure-first.md §9.5）。**すべて架空**で、実在企業の数値ではない。
 *
 * - 静的なデータで、DB の表も organization_id も持たない（どのテナントにも属さない）。
 *   Demo Mode のときだけ画面に出す。Supabase モードでは使わず「比較データが登録されていません」と示す。
 * - 他テナント（蒼天マテリアル等）の値は決して使わない（テナントの値を比較データに流用しない）。
 * - 比較の条件（決算月・範囲・定義・単位）がわざと揃っていない社を混ぜてある
 *   （B: 12 月決算、C: 単体、D: 男女の賃金が格差率・LTIFR が 20 万時間当たり）。
 *   比較対象外の理由を画面で示すためで、値を換算して揃えることはしない。
 */

export interface DemoPeer {
  id: string;
  /** 「ピアA社（架空）」の形。実在の社名を使わない */
  name: string;
  industry: string;
  sizeBand: string;
}

export interface DemoPeerValue {
  peerId: string;
  metricKey: BenchmarkMetricKey;
  fiscalYear: 'FY2025';
  fiscalYearEndMonth: 3 | 12;
  /** 未開示は null（0 にしない） */
  value: number | null;
  unit: string;
  boundary: '連結' | '単体';
  /** 算定方法・定義（定義で分かれる指標だけ） */
  method: string | null;
  /** 第三者保証の有無（注記。比較の可否には使わない） */
  assured: boolean;
  note?: string;
}

/** 比較データの年度 */
export const DEMO_PEER_FISCAL_YEAR = 'FY2025' as const;

const INDUSTRY = '電子部品（架空・同業想定）';

export const DEMO_PEERS: readonly DemoPeer[] = [
  { id: 'peer-a', name: 'ピアA社（架空）', industry: INDUSTRY, sizeBand: '大規模（架空）' },
  { id: 'peer-b', name: 'ピアB社（架空）', industry: INDUSTRY, sizeBand: '中規模（架空）' },
  { id: 'peer-c', name: 'ピアC社（架空）', industry: INDUSTRY, sizeBand: '小規模（架空）' },
  { id: 'peer-d', name: 'ピアD社（架空）', industry: INDUSTRY, sizeBand: '大規模（架空）' },
  { id: 'peer-e', name: 'ピアE社（架空）', industry: INDUSTRY, sizeBand: '大規模（架空）' },
];

/** 各社の開示の前提（決算月・範囲）。値ごとに上書きしない（同じ社の中では揃っている想定） */
const PEER_PROFILE: Record<string, { month: 3 | 12; boundary: '連結' | '単体'; assured: boolean }> =
  {
    'peer-a': { month: 3, boundary: '連結', assured: true },
    'peer-b': { month: 12, boundary: '連結', assured: false },
    'peer-c': { month: 3, boundary: '単体', assured: false },
    'peer-d': { month: 3, boundary: '連結', assured: true },
    'peer-e': { month: 3, boundary: '連結', assured: false },
  };

/** 第三者保証の対象は GHG・エネルギーだけとする（人的資本の指標は保証の対象外の想定） */
const ASSURANCE_SCOPE: ReadonlySet<BenchmarkMetricKey> = new Set([
  'scope1',
  'scope2_market',
  'scope2_location',
  'energy',
]);

type PeerCell = number | null | { value: number | null; unit?: string; method?: string | null };

/** 指標 → [A, B, C, D, E] の値（§9.5 の表）。null は未開示 */
const TABLE: Record<
  BenchmarkMetricKey,
  {
    unit: string;
    method?: string | null;
    cells: [PeerCell, PeerCell, PeerCell, PeerCell, PeerCell];
  }
> = {
  scope1: { unit: 't-CO2e', cells: [12400, 6850, 3920, 9760, 15300] },
  scope2_market: { unit: 't-CO2e', cells: [25100, 18300, 9880, null, 31200] },
  scope2_location: { unit: 't-CO2e', cells: [27900, 20050, 10400, 24600, null] },
  // Scope3 合計は全社とも未開示（自社も未算定のため比較しない）
  scope3_total: { unit: 't-CO2e', cells: [null, null, null, null, null] },
  energy: { unit: 'MWh', cells: [61500, 39800, 18200, 52300, 70100] },
  water_withdrawal: { unit: 'm3', cells: [310000, 198000, 95000, 260000, null] },
  waste: { unit: 't', cells: [3850, 2100, 880, 3300, 4420] },
  female_manager_ratio: { unit: '%', cells: [12.4, 18.9, 9.7, 14.2, 11.0] },
  female_officer_ratio: { unit: '%', cells: [18.2, 25.0, 10.0, 16.7, 12.5] },
  gender_pay: {
    unit: '%',
    method: GENDER_PAY_RATIO_METHOD,
    cells: [74.1, 71.5, 77.0, { value: 26.3, method: GENDER_PAY_GAP_RATE_METHOD }, 72.8],
  },
  ltifr: {
    unit: '件/百万時間',
    cells: [0.62, 0.35, 0.8, { value: 0.18, unit: '件/20万時間' }, 0.71],
  },
  turnover: { unit: '%', cells: [5.9, 7.2, 4.1, 6.5, 8.0] },
};

function buildValues(): DemoPeerValue[] {
  const values: DemoPeerValue[] = [];
  for (const [metricKey, spec] of Object.entries(TABLE) as Array<
    [BenchmarkMetricKey, (typeof TABLE)[BenchmarkMetricKey]]
  >) {
    spec.cells.forEach((cell, index) => {
      const peer = DEMO_PEERS[index];
      const profile = peer ? PEER_PROFILE[peer.id] : undefined;
      if (!peer || !profile) return;
      const detail = typeof cell === 'object' && cell !== null ? cell : { value: cell };
      values.push({
        peerId: peer.id,
        metricKey,
        fiscalYear: DEMO_PEER_FISCAL_YEAR,
        fiscalYearEndMonth: profile.month,
        value: detail.value,
        unit: 'unit' in detail && detail.unit ? detail.unit : spec.unit,
        boundary: profile.boundary,
        method: 'method' in detail ? (detail.method ?? null) : (spec.method ?? null),
        assured: profile.assured && ASSURANCE_SCOPE.has(metricKey),
      });
    });
  }
  return values;
}

export const DEMO_PEER_VALUES: readonly DemoPeerValue[] = buildValues();
