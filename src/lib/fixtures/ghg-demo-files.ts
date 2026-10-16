import type { ExportSheet } from '@/lib/exports';
import type { FixtureDb } from './store';
import { GHG_FIXTURE_IDS, ghgBatchId } from './ghg-verification';

/**
 * Scope1・2 の算定と照合のサンプルファイル（架空。plan §2.6・E20）。
 *
 * 取込の流れ（ファイル → 列の対応 → 検証 → 確定）を Demo で試すための入力で、値はすべて Fixture から導く
 * （別の値を手で書くと、照合や算定の結果と食い違ったときに原因が追えなくなる）。
 * 列名は取込の列の対応付けで選ぶ語（labels.ts が読める語）に揃える。実係数・実データではない。
 */

export const GHG_DEMO_FILE_KINDS = ['factor-set', 'energy', 'transport', 'baseline'] as const;
export type GhgDemoFileKind = (typeof GHG_DEMO_FILE_KINDS)[number];

export type DemoCell = string | number | null;
export type DemoRow = Record<string, DemoCell>;

export interface GhgDemoFile {
  kind: GhgDemoFileKind;
  /** 画面のリンクの名前 */
  label: string;
  fileName: string;
  format: 'csv' | 'xlsx';
  sheet: ExportSheet<DemoRow>;
}

/** 画面のリンクの名前（ファイルの label と同じ） */
export const GHG_DEMO_FILE_LABELS: Record<GhgDemoFileKind, string> = {
  'factor-set': '係数セット（架空・2025 年版 改訂）CSV',
  energy: 'エネルギー（架空・米国工場の 7 月の訂正）XLSX',
  transport: '輸送実績（架空・東日本工場の追加 6 行）CSV',
  baseline: '既存の算定結果（架空・拠点×活動の合計）XLSX',
};

export function isGhgDemoFileKind(value: string | null): value is GhgDemoFileKind {
  return value !== null && (GHG_DEMO_FILE_KINDS as readonly string[]).includes(value);
}

function sheetOf(
  name: string,
  headers: readonly string[],
  rows: DemoRow[],
  numeric: readonly string[],
) {
  return {
    name,
    columns: headers.map((header) => ({
      key: header,
      header,
      value: (row: DemoRow) => row[header] ?? null,
      numeric: numeric.includes(header),
    })),
    rows,
  } satisfies ExportSheet<DemoRow>;
}

const ACTIVITY_WORD: Record<string, string> = {
  diesel: '軽油',
  gasoline: '揮発油',
  city_gas: '都市ガス',
  grid: '電力',
};

const BASIS_WORD: Record<string, string> = {
  location: 'ロケーション基準',
  market: 'マーケット基準',
};

/** 改訂で値を変える係数（架空。改訂の差が照合・算定の画面で見えるよう 2 つだけ変える） */
const REVISED: Record<string, number> = {
  'ELEC-LOC-VN': 0.671,
  CITYGAS: 44.8,
};

/** 係数セット CSV（「組織指定（架空）2025 年版 改訂」8 行: 燃料・ガス 3 行＋電力のロケーション基準 5 か国） */
function factorSetFile(db: FixtureDb): GhgDemoFile {
  const prefix = 'ORG-2025-';
  const factors = db.emissionFactors
    .filter((f) => f.factorSetId === GHG_FIXTURE_IDS.sets.org2025)
    .filter(
      (f) =>
        f.activityKind === 'fuel' ||
        f.activityKind === 'gas' ||
        (f.activityKind === 'electricity' && f.basis === 'location'),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
  const headers = [
    '係数コード',
    '名称',
    '種類',
    '活動',
    '国',
    '基準',
    '活動量の単位',
    '単位発熱量',
    '単位発熱量の単位',
    '炭素排出係数',
    '炭素排出係数の単位',
    '排出係数',
    '排出係数の単位',
    '適用開始',
    '適用終了',
    '出典',
  ];
  const rows: DemoRow[] = factors.map((f) => {
    const key = f.code.startsWith(prefix) ? f.code.slice(prefix.length) : f.code;
    const revised = REVISED[key];
    const twoStage = f.calorificValue !== null && f.carbonFactor !== null;
    return {
      係数コード: `ORG-2025R-${key}`,
      名称: f.name,
      種類: f.activityKind === 'electricity' ? '電力' : f.activityKind === 'gas' ? 'ガス' : '燃料',
      活動: ACTIVITY_WORD[f.activityCode ?? ''] ?? f.activityCode,
      国: f.countryCode,
      基準: f.basis ? (BASIS_WORD[f.basis] ?? f.basis) : null,
      活動量の単位: f.activityUnit,
      単位発熱量: twoStage ? (key === 'CITYGAS' && revised ? revised : f.calorificValue) : null,
      単位発熱量の単位: f.calorificUnit,
      炭素排出係数: f.carbonFactor,
      炭素排出係数の単位: f.carbonFactorUnit,
      排出係数: twoStage ? null : (revised ?? f.factorValue),
      排出係数の単位: twoStage ? null : f.factorUnit,
      適用開始: f.validFrom,
      適用終了: f.validTo,
      出典: '（架空）組織指定 2025 年版 改訂（実係数ではありません）',
    };
  });
  return {
    kind: 'factor-set',
    label: GHG_DEMO_FILE_LABELS['factor-set'],
    fileName: '（架空）係数セット_組織指定2025年版改訂.csv',
    format: 'csv',
    sheet: sheetOf('係数セット', headers, rows, ['単位発熱量', '炭素排出係数', '排出係数']),
  };
}

/** エネルギー XLSX（US1 の 1 か月分の訂正。7 月の電力を 1.5% 多く訂正） */
function energyFile(db: FixtureDb): GhgDemoFile {
  const batchId = ghgBatchId('US1', 'energy');
  const month = '2025-07-01';
  const lines = db.ghgActivityLines.filter((l) => l.batchId === batchId && l.month === month);
  const headers = ['月', '活動', '量', '単位', '契約', '備考'];
  const rows: DemoRow[] = lines.map((l) => {
    const corrected = l.activityKind === 'electricity' && l.amount !== null;
    return {
      月: month.slice(0, 7),
      活動: ACTIVITY_WORD[l.activityCode] ?? l.activityCode,
      量: corrected ? Math.round(l.amount! * 1.015) : l.amount,
      単位: l.unit,
      契約: l.contractCode,
      備考: corrected ? '（架空）検針値の訂正' : '（架空）',
    };
  });
  return {
    kind: 'energy',
    label: GHG_DEMO_FILE_LABELS.energy,
    fileName: '（架空）エネルギー_US1_2025-07訂正.xlsx',
    format: 'xlsx',
    sheet: sheetOf('エネルギー', headers, rows, ['量']),
  };
}

/**
 * 輸送実績 CSV（EAST の追加 6 行。積載率なし 1 行・積載率 5% の行 1 行・最大積載量 25,000kg の行 1 行を含む。
 * 見なし積載率・下限・範囲外の警告を取込の検証で試せるように）
 */
function transportFile(): GhgDemoFile {
  const shipments: ReadonlyArray<{
    month: string;
    ref: string;
    weightT: number;
    km: number;
    payloadKg: number;
    load: number | null;
    economy: string;
  }> = [
    {
      month: '2025-12',
      ref: 'SHP-202512-C',
      weightT: 3.6,
      km: 210,
      payloadKg: 8000,
      load: 45,
      economy: '2015年度燃費基準',
    },
    {
      month: '2025-12',
      ref: 'SHP-202512-D',
      weightT: 5.4,
      km: 260,
      payloadKg: 10000,
      load: 54,
      economy: '2025年度燃費基準',
    },
    {
      month: '2025-12',
      ref: 'SHP-202512-E',
      weightT: 1.9,
      km: 120,
      payloadKg: 3000,
      load: null,
      economy: '未確認',
    },
    {
      month: '2025-12',
      ref: 'SHP-202512-F',
      weightT: 0.3,
      km: 70,
      payloadKg: 6000,
      load: 5,
      economy: '未確認',
    },
    {
      month: '2025-12',
      ref: 'SHP-202512-G',
      weightT: 10.8,
      km: 390,
      payloadKg: 25000,
      load: 43,
      economy: '未確認',
    },
    {
      month: '2025-12',
      ref: 'SHP-202512-H',
      weightT: 2.8,
      km: 150,
      payloadKg: 4000,
      load: 70,
      economy: '2015年度燃費基準',
    },
  ];
  const headers = [
    '月',
    '出荷番号',
    '輸送の区分',
    '燃料',
    '輸送重量(t)',
    '輸送距離(km)',
    '最大積載量(kg)',
    '積載率(%)',
    '用途',
    '燃費の区分',
    '貨物',
    '備考',
  ];
  const rows: DemoRow[] = shipments.map((s) => ({
    月: s.month,
    出荷番号: s.ref,
    輸送の区分: '委託物流',
    燃料: '軽油',
    '輸送重量(t)': s.weightT,
    '輸送距離(km)': s.km,
    '最大積載量(kg)': s.payloadKg,
    '積載率(%)': s.load,
    用途: '事業用',
    燃費の区分: s.economy,
    貨物: '主要製品',
    備考: '（架空）追加の輸送実績',
  }));
  return {
    kind: 'transport',
    label: GHG_DEMO_FILE_LABELS.transport,
    fileName: '（架空）輸送実績_EAST_2025追加.csv',
    format: 'csv',
    sheet: sheetOf('輸送実績', headers, rows, [
      '輸送重量(t)',
      '輸送距離(km)',
      '最大積載量(kg)',
      '積載率(%)',
    ]),
  };
}

const SCOPE_WORD: Record<string, string> = {
  scope1: 'Scope1',
  scope2: 'Scope2（マーケット基準）',
  scope2_location: 'Scope2（ロケーション基準）',
  scope3_cat4: 'Scope3 カテゴリ4',
};

const TRANSPORT_WORD: Record<string, string> = { contracted: '委託物流', own_fleet: '自社便' };

/**
 * 既存結果 XLSX（BL-1 の変種。拠点 × 区分 × 活動 の粒度。80 行以下）。行の粒度の BL-1 を活動ごとに足し上げ、
 * t 単位・小数 3 桁で書く（取込で粒度「拠点×活動」と判定され、丸めの記述「活動ごと・t・小数3桁・四捨五入」が読める）
 */
function baselineFile(db: FixtureDb): GhgDemoFile {
  const baseline = db.ghgBaselineResults.find((b) => b.id === GHG_FIXTURE_IDS.baseline);
  const sums = new Map<string, { site: string; scope: string; activity: string; t: number }>();
  for (const row of baseline?.rows ?? []) {
    // 合計だけの拠点（US1）は活動が無いので、この変種には含めない（粒度を揃える）
    if (!row.activityKind || !row.activityCode) continue;
    const activity =
      row.activityKind === 'transport'
        ? (TRANSPORT_WORD[row.activityCode] ?? row.activityCode)
        : (ACTIVITY_WORD[row.activityCode] ?? row.activityCode);
    const tonnes = row.emissionsUnit.startsWith('kg') ? row.emissions / 1000 : row.emissions;
    const key = `${row.siteCode}|${row.scope}|${activity}`;
    const current = sums.get(key) ?? { site: row.siteCode, scope: row.scope, activity, t: 0 };
    current.t += tonnes;
    sums.set(key, current);
  }
  const headers = ['拠点コード', '区分', '活動', '排出量', '排出量の単位', '丸め'];
  const rows: DemoRow[] = [...sums.values()]
    .sort((a, b) =>
      `${a.site}|${a.scope}|${a.activity}`.localeCompare(`${b.site}|${b.scope}|${b.activity}`),
    )
    .slice(0, 80)
    .map((s) => ({
      拠点コード: s.site,
      区分: SCOPE_WORD[s.scope] ?? s.scope,
      活動: s.activity,
      排出量: Math.round(s.t * 1000) / 1000,
      排出量の単位: 't-CO2e',
      丸め: '活動ごと・t・小数3桁・四捨五入',
    }));
  return {
    kind: 'baseline',
    label: GHG_DEMO_FILE_LABELS.baseline,
    fileName: '（架空）既存算定結果_CY2025_拠点別活動別.xlsx',
    format: 'xlsx',
    sheet: sheetOf('既存の算定結果', headers, rows, ['排出量']),
  };
}

/** サンプルファイルを 1 つ作る（Fixture の DB から。決定論的） */
export function buildGhgDemoFile(kind: GhgDemoFileKind, db: FixtureDb): GhgDemoFile {
  switch (kind) {
    case 'factor-set':
      return factorSetFile(db);
    case 'energy':
      return energyFile(db);
    case 'transport':
      return transportFile();
    case 'baseline':
      return baselineFile(db);
  }
}

/** 画面のリンクの一覧（kind・名前・行き先） */
export function ghgDemoFileLinks(): Array<{ kind: GhgDemoFileKind; label: string; href: string }> {
  return GHG_DEMO_FILE_KINDS.map((kind) => ({
    kind,
    label: GHG_DEMO_FILE_LABELS[kind],
    href: `/api/exports/ghg-demo-files?kind=${kind}`,
  }));
}
