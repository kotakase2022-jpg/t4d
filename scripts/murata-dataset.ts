/**
 * 村田製作所向けデモ: Scope3 カテゴリー1（購入した製品・サービス）の
 * 架空購買データ 20 ファイル（電子部品メーカー想定）の生成器。
 *
 * - すべて架空データ。実在のサプライヤー・実データ・第三者検証と誤認させない
 *   （サプライヤーは Fixture の SUP-31〜50、係数は DEMO-EF-* の架空係数のみ）。
 * - 1 ファイル 1 サプライヤー × 12 明細 = 240 明細。期間は 2025-04-01〜2026-03-31（架空年度）。
 * - 決定論（乱数を使わない）。同じスクリプトから常に同じ内容が生成される。
 * - 期待値（正解データ）はアプリの出力コピーではなく、このファイル内の
 *   換算表・係数表から独立に計算する。係数値が Fixture とずれていないことは
 *   integration テストが照合する。
 *
 * 形式: XLSX 14 / CSV 6。
 * 指示書の標準構成は「XLSX10 / CSV6 / テキストPDF4」だが、サプライヤーデータ取込は
 * 規則ベースの表解析（CSV / Excel）で、PDF の表再構成は OCR・AI 解析基盤の新設に
 * 当たるため（指示書 12: OCR 基盤の新設は禁止）、PDF 4 件は XLSX へ置き換えた。
 * 総数 20・内容（サプライヤー・明細・期間・算定方式）は維持している。
 */

import { buildXlsx, csv, encodeSjis, utf8Bom, type DatasetFile } from './hetero-dataset';

// ----------------------------------------------------------------------
// デモ係数（架空）と単位換算 — 期待値の独立計算に使う
// ----------------------------------------------------------------------

/**
 * 架空のデモ係数（t-CO2e / 活動量単位）。実算定には使用できない。
 * Fixture（src/lib/fixtures/dataset.ts の EMISSION_FACTOR_SPECS）と同じ値を
 * ここに独立して持ち、テストで両者の一致を検査する。
 */
export const MURATA_DEMO_FACTORS: Record<string, { value: number; activityUnit: string }> = {
  'DEMO-EF-BACO3-JP-KG': { value: 0.0029, activityUnit: 'kg' },
  'DEMO-EF-TIO2-JP-KG': { value: 0.0052, activityUnit: 'kg' },
  'DEMO-EF-NI-JP-KG': { value: 0.0089, activityUnit: 'kg' },
  'DEMO-EF-NI-GLB-KG': { value: 0.0125, activityUnit: 'kg' },
  'DEMO-EF-CU-GLB-KG': { value: 0.0041, activityUnit: 'kg' },
  'DEMO-EF-AGPASTE-JP-KG': { value: 0.032, activityUnit: 'kg' },
  'DEMO-EF-FERRITE-TW-KG': { value: 0.0038, activityUnit: 'kg' },
  'DEMO-EF-ALLOY-KR-KG': { value: 0.0067, activityUnit: 'kg' },
  'DEMO-EF-MAGWIRE-JP-KG': { value: 0.0049, activityUnit: 'kg' },
  'DEMO-EF-ALUMINA-GLB-KG': { value: 0.0061, activityUnit: 'kg' },
  'DEMO-EF-ALUMINA-MY-KG': { value: 0.0046, activityUnit: 'kg' },
  'DEMO-EF-CERSUB-CN-M2': { value: 0.018, activityUnit: 'm2' },
  'DEMO-EF-RESIN-JP-KG': { value: 0.0035, activityUnit: 'kg' },
  'DEMO-EF-SOLVENT-CN-KG': { value: 0.0018, activityUnit: 'kg' },
  'DEMO-EF-PETFILM-JP-KG': { value: 0.0028, activityUnit: 'kg' },
  'DEMO-EF-LCP-TW-M2': { value: 0.0094, activityUnit: 'm2' },
  'DEMO-EF-PCB-CN-M2': { value: 0.062, activityUnit: 'm2' },
  'DEMO-EF-PCB-GLB-M2': { value: 0.055, activityUnit: 'm2' },
  'DEMO-EF-CFP-IC-PC': { value: 0.0011, activityUnit: '個' },
  'DEMO-EF-CFP-PIEZO-PC': { value: 0.0024, activityUnit: '個' },
  'DEMO-EF-TAPE-JP-KG': { value: 0.0026, activityUnit: 'kg' },
  'DEMO-EF-CARDBOARD-JP-KG': { value: 0.0011, activityUnit: 'kg' },
  'DEMO-EF-MACHINING-JP-KJPY': { value: 0.00058, activityUnit: '千円' },
  // ファイル 19 の副資材行（推薦なし・人が選択）で選ぶ想定の汎用係数（30社デモ由来）
  'EF-PUR-PACK': { value: 0.00056, activityUnit: '千円' },
};

/** ファイル記載単位 → 正規化単位と倍率（アプリ normalizeUnit と同じ規則の独立コピー） */
const UNIT_NORMALIZATION: Record<string, { unit: string; multiplier: number }> = {
  kg: { unit: 'kg', multiplier: 1 },
  g: { unit: 'kg', multiplier: 0.001 },
  m2: { unit: 'm2', multiplier: 1 },
  '㎡': { unit: 'm2', multiplier: 1 },
  個: { unit: '個', multiplier: 1 },
  pcs: { unit: '個', multiplier: 1 },
  千円: { unit: '千円', multiplier: 1 },
  円: { unit: '千円', multiplier: 0.001 },
};

/**
 * デモ用固定為替レート（説明用の架空レート。実際の市場レートではない）。
 * 海外サプライヤーの参考単価（USD 等）の説明にのみ使い、取込値には使わない。
 */
export const MURATA_DEMO_FX_RATES: Array<{ currency: string; jpyPerUnit: number }> = [
  { currency: 'USD', jpyPerUnit: 150.0 },
  { currency: 'CNY', jpyPerUnit: 21.0 },
  { currency: 'TWD', jpyPerUnit: 4.8 },
  { currency: 'KRW', jpyPerUnit: 0.11 },
  { currency: 'MYR', jpyPerUnit: 32.0 },
];

// ----------------------------------------------------------------------
// 型
// ----------------------------------------------------------------------

/** 明細 1 行の定義。expectedFactorCode は取込確定時に紐づく想定の係数 */
export interface MurataRow {
  item: string;
  /** 購入月（2025-04〜2026-03） */
  month: string;
  /** ファイルに記載する数量・金額（記載単位ベース） */
  qty: number;
  /** ファイルに記載する単位 */
  unitRaw: string;
  /** ファイルに記載する係数コード。'' は記載なし（候補から選ぶデモ行） */
  factorCode: string;
  /** 生産国セルの値（生産国列を持つファイルのみ） */
  country?: string;
  /** 参考単価（取込対象外の飾り列） */
  unitPrice?: number;
  /** 期待される係数（自動解決 or 推薦 or 手動選択後） */
  expectedFactorCode: string;
  /** 係数の決まり方: file=係数コード記載 / auto=品目・単位から一意 / recommended=推薦候補 / manual=人が選択 */
  expectedResolution: 'file' | 'auto' | 'recommended' | 'manual';
}

export interface MurataFileSpec {
  /** 01〜20 */
  no: number;
  fileName: string;
  format: 'xlsx' | 'csv';
  /** CSV の文字コード（xlsx は該当なし） */
  encoding?: 'utf8-bom' | 'sjis';
  language: '日本語' | '英語' | '日英混在';
  supplierCode: string;
  supplierName: string;
  /** サプライヤー所在国（表示用） */
  supplierCountry: '日本' | '中国' | '台湾' | '韓国' | 'マレーシア';
  /** 算定方式の説明（manifest 用） */
  method: string;
  sheetName?: string;
  /** ヘッダー行より前に置く前置き行 */
  preamble?: string[][];
  /** 列の並び（役割の組を CSV/XLSX に展開する） */
  columns: MurataColumn[];
  /** 末尾に合計行を置くか（明細に数えない） */
  totalRow?: { label: string };
  /** 末尾の注記行（明細に数えない） */
  noteRows?: string[];
  rows: MurataRow[];
}

/** 列定義。header は各ファイルで表記を変える */
type MurataColumn =
  | { kind: 'supplier'; header: string }
  | { kind: 'item'; header: string }
  | { kind: 'dtype'; header: string; physical: string; monetary: string }
  | { kind: 'qty'; header: string }
  | { kind: 'unit'; header: string }
  | { kind: 'country'; header: string }
  | { kind: 'factor'; header: string }
  | { kind: 'month'; header: string }
  | { kind: 'price'; header: string };

// ----------------------------------------------------------------------
// 行の生成ヘルパー
// ----------------------------------------------------------------------

const MONTHS = [
  '2025-04',
  '2025-05',
  '2025-06',
  '2025-07',
  '2025-08',
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
] as const;

/** 標準 12 行（全行に係数コード記載）を組み立てる */
function coded(
  items: string[],
  qtys: number[],
  unitRaw: string,
  factorCode: string,
  options: { country?: string; prices?: number[] } = {},
): MurataRow[] {
  if (items.length !== 12 || qtys.length !== 12) {
    throw new Error(`明細は 12 行必要です（items=${items.length}, qtys=${qtys.length}）`);
  }
  return items.map((item, i) => ({
    item,
    month: MONTHS[i]!,
    qty: qtys[i]!,
    unitRaw,
    factorCode,
    country: options.country,
    unitPrice: options.prices?.[i],
    expectedFactorCode: factorCode,
    expectedResolution: 'file',
  }));
}

// ----------------------------------------------------------------------
// 20 ファイルの定義
// ----------------------------------------------------------------------

export function buildMurataFileSpecs(): MurataFileSpec[] {
  const specs: MurataFileSpec[] = [];

  // 01: 白鳳化学工業 — 炭酸バリウム（kg・全行コード記載・前置きあり）
  specs.push({
    no: 1,
    fileName: '01_白鳳化学工業_納入実績_2025年度.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-31',
    supplierName: '白鳳化学工業',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    sheetName: '納入実績',
    preamble: [
      ['白鳳化学工業株式会社 納入実績報告（2025年度）'],
      ['対象期間: 2025-04-01 〜 2026-03-31 ／ 本資料はデモ用の架空データです'],
    ],
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '購入月' },
      { kind: 'price', header: '単価(円/kg)' },
    ],
    rows: coded(
      [
        '高純度炭酸バリウム BC-90A',
        '高純度炭酸バリウム BC-90B',
        '高純度炭酸バリウム BC-91A',
        '微粒炭酸バリウム BC-20',
        '微粒炭酸バリウム BC-25',
        '炭酸バリウム顆粒 BCG-5',
        '炭酸バリウム顆粒 BCG-8',
        '高純度炭酸バリウム BC-92',
        '炭酸バリウム微粉 BCF-1',
        '炭酸バリウム微粉 BCF-2',
        '高純度炭酸バリウム BC-93',
        '炭酸バリウム顆粒 BCG-12',
      ],
      [12500, 9800, 14200, 8600, 11350, 9200, 13800, 10400, 7650, 12950, 11800, 8900],
      'kg',
      'DEMO-EF-BACO3-JP-KG',
      { prices: [820, 825, 818, 905, 902, 760, 758, 830, 940, 938, 828, 762] },
    ),
  });

  // 02: 燕青チタン工業 — 酸化チタン（CSV・合計行あり）
  specs.push({
    no: 2,
    fileName: '02_燕青チタン工業_出荷明細_FY2025.csv',
    format: 'csv',
    encoding: 'utf8-bom',
    language: '日本語',
    supplierCode: 'SUP-32',
    supplierName: '燕青チタン工業',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品名' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '出荷数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '出荷月' },
    ],
    totalRow: { label: '合計' },
    rows: coded(
      [
        '高純度酸化チタン TP-4N',
        '高純度酸化チタン TP-4NS',
        'ルチル型酸化チタン TR-11',
        'ルチル型酸化チタン TR-15',
        'アナターゼ型酸化チタン TA-01',
        'アナターゼ型酸化チタン TA-02',
        '高純度酸化チタン TP-5N',
        '酸化チタン微粒 TF-30',
        '酸化チタン微粒 TF-50',
        'ルチル型酸化チタン TR-21',
        '高純度酸化チタン TP-4NR',
        '酸化チタン顆粒 TG-8',
      ],
      [7400, 6150, 8900, 5300, 9600, 7050, 8300, 4750, 6800, 9100, 5900, 7700],
      'kg',
      'DEMO-EF-TIO2-JP-KG',
    ),
  });

  // 03: 深山金属粉体 — ニッケル粉末（候補選択デモ: 生産国一致 / 世界平均）
  specs.push({
    no: 3,
    fileName: '03_深山金属粉体_purchase_ledger_FY2025.xlsx',
    format: 'xlsx',
    language: '日英混在',
    supplierCode: 'SUP-33',
    supplierName: '深山金属粉体',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）。末尾 2 行は係数コード空欄（候補から選ぶデモ）',
    sheetName: 'FY2025',
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: '品目 / Item' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '数量 / Qty' },
      { kind: 'unit', header: '単位' },
      { kind: 'country', header: '生産国' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: 'PO Month' },
    ],
    rows: [
      ...coded(
        [
          'ニッケル微粉 NP-05',
          'ニッケル微粉 NP-08',
          'ニッケル微粉 NP-10',
          'ニッケル球状粉 NS-03',
          'ニッケル球状粉 NS-05',
          'ニッケルフレーク NF-12',
          'ニッケルフレーク NF-18',
          'ニッケル微粉 NP-12',
          'ニッケル球状粉 NS-08',
          'ニッケル微粉 NP-15',
          'ニッケルフレーク NF-25',
          'ニッケル微粉 NP-18',
        ],
        [3200, 2750, 4100, 1850, 2400, 3600, 2100, 3900, 1650, 2950, 2250, 3450],
        'kg',
        'DEMO-EF-NI-JP-KG',
        { country: '日本' },
      ).slice(0, 10),
      {
        item: 'ニッケル超微粉 NP-20（試作グレード）',
        month: '2026-02',
        qty: 1450,
        unitRaw: 'kg',
        factorCode: '',
        country: '日本',
        expectedFactorCode: 'DEMO-EF-NI-JP-KG',
        expectedResolution: 'recommended',
      },
      {
        item: 'ニッケル粉末 NP-80（海外調達枠）',
        month: '2026-03',
        qty: 2600,
        unitRaw: 'kg',
        factorCode: '',
        country: '中国',
        expectedFactorCode: 'DEMO-EF-NI-GLB-KG',
        expectedResolution: 'recommended',
      },
    ],
  });

  // 04: 旭峰銅材 — 銅粉末（種別列なし）
  specs.push({
    no: 4,
    fileName: '04_旭峰銅材_購買明細_2025.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-34',
    supplierName: '旭峰銅材',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    sheetName: 'Sheet1',
    columns: [
      { kind: 'month', header: '納入月' },
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
    ],
    rows: coded(
      [
        '電解銅粉 CU-E100',
        '電解銅粉 CU-E200',
        'アトマイズ銅粉 CU-A50',
        'アトマイズ銅粉 CU-A80',
        '電解銅粉 CU-E150',
        '樹枝状銅粉 CU-D30',
        '樹枝状銅粉 CU-D60',
        'アトマイズ銅粉 CU-A120',
        '電解銅粉 CU-E250',
        '銅微粉 CU-F10',
        '銅微粉 CU-F20',
        'アトマイズ銅粉 CU-A160',
      ],
      [5400, 7100, 4300, 6650, 5900, 3800, 4950, 7800, 6200, 3350, 4600, 7350],
      'kg',
      'DEMO-EF-CU-GLB-KG',
    ),
  });

  // 05: 琥山電子材料 — 銀ペースト（CSV・単位 g → kg 換算・末尾注記）
  specs.push({
    no: 5,
    fileName: '05_琥山電子材料_納品実績_FY2025.csv',
    format: 'csv',
    encoding: 'utf8-bom',
    language: '日本語',
    supplierCode: 'SUP-35',
    supplierName: '琥山電子材料',
    supplierCountry: '日本',
    method: '数量ベース（g 表記 → kg 換算 × 架空係数）',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '納品数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '納品月' },
    ],
    noteRows: ['※ 数量はグラム表記です。銀含有率はロットにより異なります。'],
    rows: coded(
      [
        '銀導電ペースト AGP-110',
        '銀導電ペースト AGP-115',
        '銀導電ペースト AGP-120',
        '銀パラジウムペースト APD-20',
        '銀パラジウムペースト APD-25',
        '銀導電ペースト AGP-130',
        '銀導電ペースト AGP-135',
        '銀パラジウムペースト APD-30',
        '銀導電ペースト AGP-140',
        '銀導電ペースト AGP-145',
        '銀パラジウムペースト APD-35',
        '銀導電ペースト AGP-150',
      ],
      [
        385000, 292000, 448000, 210500, 324000, 501000, 268000, 189500, 416000, 355000, 233000,
        472000,
      ],
      'g',
      'DEMO-EF-AGPASTE-JP-KG',
    ),
  });

  // 06: Taihoku Ferrite Materials — フェライト（英語・前置きあり）
  specs.push({
    no: 6,
    fileName: '06_Taihoku_Ferrite_Materials_Shipment_FY2025.xlsx',
    format: 'xlsx',
    language: '英語',
    supplierCode: 'SUP-36',
    supplierName: 'Taihoku Ferrite Materials Co.',
    supplierCountry: '台湾',
    method: '数量ベース（kg × 架空係数）',
    sheetName: 'Shipment',
    preamble: [
      ['Taihoku Ferrite Materials Co. - Annual Shipment Report FY2025'],
      ['Period: 2025-04-01 to 2026-03-31 / Fictitious demo data'],
    ],
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item' },
      { kind: 'dtype', header: 'Data Type', physical: 'Physical', monetary: 'Monetary' },
      { kind: 'qty', header: 'Quantity' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
      { kind: 'month', header: 'PO Month' },
      { kind: 'price', header: 'Unit Price (USD/kg)' },
    ],
    rows: coded(
      [
        'Mn-Zn ferrite powder FZ-110',
        'Mn-Zn ferrite powder FZ-115',
        'Ni-Zn ferrite powder FN-210',
        'Ni-Zn ferrite powder FN-215',
        'Mn-Zn ferrite powder FZ-120',
        'Ferrite granule FG-30',
        'Ferrite granule FG-35',
        'Mn-Zn ferrite powder FZ-130',
        'Ni-Zn ferrite powder FN-220',
        'Ferrite granule FG-40',
        'Mn-Zn ferrite powder FZ-140',
        'Ni-Zn ferrite powder FN-230',
      ],
      [9800, 7600, 11400, 6900, 12800, 8500, 10300, 7200, 9100, 11900, 6400, 10800],
      'kg',
      'DEMO-EF-FERRITE-TW-KG',
      {
        country: 'Taiwan',
        prices: [4.2, 4.2, 4.6, 4.6, 4.1, 3.8, 3.8, 4.3, 4.7, 3.9, 4.4, 4.8],
      },
    ),
  });

  // 07: Hanbit Magnetic Alloys — 磁性合金粉（CSV 英語・種別列なし）
  specs.push({
    no: 7,
    fileName: '07_Hanbit_Magnetic_Alloys_deliveries_FY2025.csv',
    format: 'csv',
    encoding: 'utf8-bom',
    language: '英語',
    supplierCode: 'SUP-37',
    supplierName: 'Hanbit Magnetic Alloys Co.',
    supplierCountry: '韓国',
    method: '数量ベース（kg × 架空係数）',
    columns: [
      { kind: 'month', header: 'Delivery Month' },
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item Name' },
      { kind: 'qty', header: 'Qty' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
    ],
    rows: coded(
      [
        'Magnetic alloy powder MA-1005',
        'Magnetic alloy powder MA-1010',
        'Fe-Si alloy powder FS-210',
        'Fe-Si alloy powder FS-215',
        'Magnetic alloy powder MA-1020',
        'Amorphous alloy powder AM-31',
        'Amorphous alloy powder AM-35',
        'Magnetic alloy powder MA-1030',
        'Fe-Si alloy powder FS-220',
        'Amorphous alloy powder AM-40',
        'Magnetic alloy powder MA-1040',
        'Fe-Si alloy powder FS-230',
      ],
      [4600, 3900, 5800, 3200, 6400, 2800, 4100, 5200, 3600, 4900, 2950, 5600],
      'kg',
      'DEMO-EF-ALLOY-KR-KG',
      { country: 'South Korea' },
    ),
  });

  // 08: 近江マグネットワイヤ — エナメル銅線（合計行あり）
  specs.push({
    no: 8,
    fileName: '08_近江マグネットワイヤ_出荷実績_2025年度.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-38',
    supplierName: '近江マグネットワイヤ',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    sheetName: '出荷実績',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '出荷数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '出荷月' },
    ],
    // 行種別判定は保守的で「年度合計」のような複合語は合計と断定しない。単独語にする
    totalRow: { label: '合計' },
    rows: coded(
      [
        'エナメル銅線 UEW-0.05',
        'エナメル銅線 UEW-0.08',
        'エナメル銅線 UEW-0.10',
        'エナメル銅線 PEW-0.12',
        'エナメル銅線 PEW-0.16',
        '自己融着線 SB-0.08',
        '自己融着線 SB-0.10',
        'エナメル銅線 UEW-0.15',
        'エナメル銅線 PEW-0.20',
        '自己融着線 SB-0.12',
        'エナメル銅線 UEW-0.20',
        'エナメル銅線 PEW-0.25',
      ],
      [6800, 5400, 8200, 4700, 9500, 3900, 5100, 7300, 6100, 4400, 8800, 5700],
      'kg',
      'DEMO-EF-MAGWIRE-JP-KG',
    ),
  });

  // 09: Penang Advanced Ceramics — アルミナ（候補選択デモ: 生産国一致 MY / 世界平均）
  specs.push({
    no: 9,
    fileName: '09_Penang_Advanced_Ceramics_PO_Summary_FY2025.xlsx',
    format: 'xlsx',
    language: '英語',
    supplierCode: 'SUP-39',
    supplierName: 'Penang Advanced Ceramics Sdn. Bhd.',
    supplierCountry: 'マレーシア',
    method: '数量ベース（kg × 架空係数）。末尾 2 行は係数コード空欄（候補から選ぶデモ）',
    sheetName: 'PO Summary',
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item' },
      { kind: 'dtype', header: 'Data Type', physical: 'Physical', monetary: 'Monetary' },
      { kind: 'qty', header: 'Quantity' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
      { kind: 'month', header: 'PO Month' },
    ],
    rows: [
      ...coded(
        [
          'Calcined alumina powder APC-02',
          'Calcined alumina powder APC-05',
          'Low-soda alumina LS-10',
          'Low-soda alumina LS-12',
          'Calcined alumina powder APC-08',
          'Reactive alumina RA-20',
          'Reactive alumina RA-22',
          'Calcined alumina powder APC-11',
          'Low-soda alumina LS-15',
          'Reactive alumina RA-25',
          'Calcined alumina powder APC-14',
          'Low-soda alumina LS-18',
        ],
        [8600, 7200, 10400, 6300, 11800, 5600, 7900, 9700, 6800, 8900, 5100, 10100],
        'kg',
        'DEMO-EF-ALUMINA-MY-KG',
        { country: 'Malaysia' },
      ).slice(0, 10),
      {
        item: 'High-purity alumina powder AL-9N',
        month: '2026-02',
        qty: 4200,
        unitRaw: 'kg',
        factorCode: '',
        country: 'Malaysia',
        expectedFactorCode: 'DEMO-EF-ALUMINA-MY-KG',
        expectedResolution: 'recommended',
      },
      {
        item: 'Alumina base powder AL-5N',
        month: '2026-03',
        qty: 5800,
        unitRaw: 'kg',
        factorCode: '',
        country: 'Japan',
        expectedFactorCode: 'DEMO-EF-ALUMINA-GLB-KG',
        expectedResolution: 'recommended',
      },
    ],
  });

  // 10: 華南精密基板 — セラミック基板（m2・英語ヘッダー＋中日品名・前置き）
  specs.push({
    no: 10,
    fileName: '10_South_China_Precision_Substrate_supply_FY2025.xlsx',
    format: 'xlsx',
    language: '日英混在',
    supplierCode: 'SUP-40',
    supplierName: '華南精密基板有限公司',
    supplierCountry: '中国',
    method: '数量ベース（m2 × 架空係数）',
    sheetName: 'Supply',
    preamble: [
      ['South China Precision Substrate Co. / Supply record FY2025 (fictitious demo data)'],
    ],
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item' },
      { kind: 'qty', header: 'Quantity' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
      { kind: 'month', header: 'Supply Month' },
    ],
    rows: coded(
      [
        'HTCC substrate 96% Alumina 50x50 / セラミック基板 HS-5050',
        'HTCC substrate 96% Alumina 60x60 / セラミック基板 HS-6060',
        'LTCC substrate 40x40 / セラミック基板 LS-4040',
        'LTCC substrate 50x50 / セラミック基板 LS-5050',
        'HTCC substrate 99% Alumina 50x50 / セラミック基板 HP-5050',
        'Thin ceramic substrate 0.25t / セラミック基板 TC-025',
        'Thin ceramic substrate 0.38t / セラミック基板 TC-038',
        'HTCC substrate 96% Alumina 70x70 / セラミック基板 HS-7070',
        'LTCC substrate 60x60 / セラミック基板 LS-6060',
        'Thin ceramic substrate 0.50t / セラミック基板 TC-050',
        'HTCC substrate 99% Alumina 60x60 / セラミック基板 HP-6060',
        'LTCC substrate 70x70 / セラミック基板 LS-7070',
      ],
      [1850, 1420, 2300, 1150, 2650, 980, 1550, 2100, 1300, 1750, 890, 2450],
      'm2',
      'DEMO-EF-CERSUB-CN-M2',
      { country: 'China' },
    ),
  });

  // 11: 千曲樹脂化学 — バインダー樹脂（CSV・Shift_JIS・最小列）
  specs.push({
    no: 11,
    fileName: '11_千曲樹脂化学_納入明細_FY2025.csv',
    format: 'csv',
    encoding: 'sjis',
    language: '日本語',
    supplierCode: 'SUP-41',
    supplierName: '千曲樹脂化学',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '納入月' },
    ],
    rows: coded(
      [
        'PVB バインダー樹脂 BR-105',
        'PVB バインダー樹脂 BR-110',
        'アクリル系バインダー AB-210',
        'アクリル系バインダー AB-215',
        'PVB バインダー樹脂 BR-120',
        'エチルセルロース EC-45',
        'エチルセルロース EC-50',
        'PVB バインダー樹脂 BR-130',
        'アクリル系バインダー AB-220',
        'エチルセルロース EC-55',
        'PVB バインダー樹脂 BR-140',
        'アクリル系バインダー AB-230',
      ],
      [4200, 3600, 5100, 2900, 5800, 2400, 3300, 4700, 3100, 3900, 2650, 5400],
      'kg',
      'DEMO-EF-RESIN-JP-KG',
    ),
  });

  // 12: 蘇河化学材料 — 溶剤（生産国列つき・日中品名）
  specs.push({
    no: 12,
    fileName: '12_蘇河化学材料_出荷明細_2025年度.xlsx',
    format: 'xlsx',
    language: '日英混在',
    supplierCode: 'SUP-42',
    supplierName: '蘇河化学材料有限公司',
    supplierCountry: '中国',
    method: '数量ベース（kg × 架空係数）',
    sheetName: '出荷明細',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '出荷数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'country', header: '生産国' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '出荷月' },
    ],
    rows: coded(
      [
        '工業用溶剤 テルピネオール TP-90',
        '工業用溶剤 テルピネオール TP-95',
        '工業用溶剤 ブチルカルビトール BC-70',
        '工業用溶剤 ブチルカルビトール BC-75',
        '洗浄用溶剤 CL-110',
        '洗浄用溶剤 CL-115',
        '工業用溶剤 テルピネオール TP-98',
        '希釈用溶剤 DL-30',
        '希釈用溶剤 DL-35',
        '洗浄用溶剤 CL-120',
        '工業用溶剤 ブチルカルビトール BC-80',
        '希釈用溶剤 DL-40',
      ],
      [9500, 7800, 12400, 6600, 14800, 8900, 11200, 5800, 9800, 13400, 7200, 10600],
      'kg',
      'DEMO-EF-SOLVENT-CN-KG',
      { country: '中国' },
    ),
  });

  // 13: 霞浦フィルム工業 — PET 離型フィルム（合計行あり）
  specs.push({
    no: 13,
    fileName: '13_霞浦フィルム工業_納品実績_FY2025.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-43',
    supplierName: '霞浦フィルム工業',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    sheetName: '納品実績',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '納品数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '納品月' },
    ],
    totalRow: { label: '合計' },
    rows: coded(
      [
        'PET離型フィルム RF-25',
        'PET離型フィルム RF-38',
        'PET離型フィルム RF-50',
        'PET離型フィルム RF-75',
        'PETキャリアフィルム CF-25',
        'PETキャリアフィルム CF-38',
        'PET離型フィルム RF-100',
        'PET保護フィルム PF-30',
        'PET保護フィルム PF-50',
        'PETキャリアフィルム CF-50',
        'PET離型フィルム RF-125',
        'PET保護フィルム PF-75',
      ],
      [7600, 6200, 9100, 5100, 10400, 6900, 8300, 4400, 7000, 9700, 5600, 8800],
      'kg',
      'DEMO-EF-PETFILM-JP-KG',
    ),
  });

  // 14: Formosa LCP Films — LCP フィルム（CSV 英語・m2）
  specs.push({
    no: 14,
    fileName: '14_Formosa_LCP_Films_shipment_FY2025.csv',
    format: 'csv',
    encoding: 'utf8-bom',
    language: '英語',
    supplierCode: 'SUP-44',
    supplierName: 'Formosa LCP Films Co.',
    supplierCountry: '台湾',
    method: '数量ベース（m2 × 架空係数）',
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item' },
      { kind: 'qty', header: 'Quantity' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
      { kind: 'month', header: 'Shipment Month' },
      { kind: 'price', header: 'Unit Price (USD/m2)' },
    ],
    rows: coded(
      [
        'LCP film 25um LF-25A',
        'LCP film 25um LF-25B',
        'LCP film 50um LF-50A',
        'LCP film 50um LF-50B',
        'LCP film 100um LF-100A',
        'LCP bonding sheet LB-20',
        'LCP bonding sheet LB-30',
        'LCP film 25um LF-25C',
        'LCP film 50um LF-50C',
        'LCP bonding sheet LB-40',
        'LCP film 100um LF-100B',
        'LCP film 25um LF-25D',
      ],
      [2800, 2300, 3400, 1900, 4100, 1500, 2100, 3000, 2500, 1750, 3700, 2650],
      'm2',
      'DEMO-EF-LCP-TW-M2',
      {
        country: 'Taiwan',
        prices: [11.5, 11.5, 13.2, 13.2, 16.8, 9.4, 9.6, 11.7, 13.4, 9.8, 17.1, 11.9],
      },
    ),
  });

  // 15: 深圳華聯電路板 — プリント基板（候補選択デモ: 3 候補 / 2 候補）
  specs.push({
    no: 15,
    fileName: '15_深圳華聯電路板_納入実績_FY2025.xlsx',
    format: 'xlsx',
    language: '日英混在',
    supplierCode: 'SUP-45',
    supplierName: '深圳華聯電路板有限公司',
    supplierCountry: '中国',
    method:
      '数量ベース（m2 × 架空係数）。末尾 2 行は係数コード空欄（候補から選ぶデモ・3 候補あり）',
    sheetName: '納入実績',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'country', header: '生産国' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '納入月' },
    ],
    rows: [
      ...coded(
        [
          '多層プリント基板 PW-0604',
          '多層プリント基板 PW-0806',
          '多層プリント基板 PW-1004',
          '両面プリント基板 PD-0402',
          '両面プリント基板 PD-0602',
          '多層プリント基板 PW-1206',
          'ビルドアップ基板 PB-0808',
          'ビルドアップ基板 PB-1010',
          '多層プリント基板 PW-1408',
          '両面プリント基板 PD-0802',
          'ビルドアップ基板 PB-1212',
          '多層プリント基板 PW-1610',
        ],
        [820, 650, 980, 540, 1150, 720, 460, 880, 610, 1050, 390, 940],
        'm2',
        'DEMO-EF-PCB-CN-M2',
        { country: '中国' },
      ).slice(0, 10),
      {
        item: 'HTCC セラミック基板 CS-88',
        month: '2026-02',
        qty: 520,
        unitRaw: 'm2',
        factorCode: '',
        country: '中国',
        expectedFactorCode: 'DEMO-EF-CERSUB-CN-M2',
        expectedResolution: 'recommended',
      },
      {
        item: '高密度プリント基板 PW-1608HD',
        month: '2026-03',
        qty: 760,
        unitRaw: 'm2',
        factorCode: '',
        country: '中国',
        expectedFactorCode: 'DEMO-EF-PCB-CN-M2',
        expectedResolution: 'recommended',
      },
    ],
  });

  // 16: Hsinchu Micro Devices — モジュール用 IC（製品 CFP・個数ベース）
  specs.push({
    no: 16,
    fileName: '16_Hsinchu_Micro_Devices_CFP_Report_FY2025.xlsx',
    format: 'xlsx',
    language: '英語',
    supplierCode: 'SUP-46',
    supplierName: 'Hsinchu Micro Devices Co.',
    supplierCountry: '台湾',
    method: '製品CFP（個 × サプライヤー固有の架空 CFP 係数）',
    sheetName: 'CFP Report',
    preamble: [
      ['Hsinchu Micro Devices Co. - Product Carbon Footprint Report FY2025'],
      ['Supplier-specific CFP per piece (fictitious demo values, cradle-to-gate)'],
    ],
    columns: [
      { kind: 'supplier', header: 'Supplier Code' },
      { kind: 'item', header: 'Item' },
      { kind: 'dtype', header: 'Data Type', physical: 'Physical', monetary: 'Monetary' },
      { kind: 'qty', header: 'Quantity' },
      { kind: 'unit', header: 'Unit' },
      { kind: 'country', header: 'Country of Origin' },
      { kind: 'factor', header: 'Factor Code' },
      { kind: 'month', header: 'PO Month' },
    ],
    rows: coded(
      [
        'RF module IC HMD-3210',
        'RF module IC HMD-3220',
        'Power management IC HMD-4110',
        'Power management IC HMD-4120',
        'RF module IC HMD-3230',
        'Sensor interface IC HMD-5010',
        'Sensor interface IC HMD-5020',
        'Power management IC HMD-4130',
        'RF module IC HMD-3240',
        'Sensor interface IC HMD-5030',
        'Power management IC HMD-4140',
        'RF module IC HMD-3250',
      ],
      [86000, 64000, 112000, 48000, 95000, 38000, 57000, 78000, 69000, 44000, 102000, 73000],
      'pcs',
      'DEMO-EF-CFP-IC-PC',
      { country: 'Taiwan' },
    ),
  });

  // 17: 常磐圧電結晶 — 圧電ウエハー（製品 CFP・個数ベース）
  specs.push({
    no: 17,
    fileName: '17_常磐圧電結晶_製品CFP報告_2025年度.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-47',
    supplierName: '常磐圧電結晶',
    supplierCountry: '日本',
    method: '製品CFP（個 × サプライヤー固有の架空 CFP 係数）',
    sheetName: 'CFP報告',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'dtype', header: 'データ種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '購入月' },
    ],
    rows: coded(
      [
        '圧電ウエハー LT-4in PZ-401',
        '圧電ウエハー LT-4in PZ-402',
        '圧電ウエハー LN-4in PZ-411',
        '圧電ウエハー LN-4in PZ-412',
        '圧電ウエハー LT-6in PZ-601',
        '圧電ウエハー LT-6in PZ-602',
        '圧電ウエハー LN-6in PZ-611',
        '圧電ウエハー LT-4in PZ-403',
        '圧電ウエハー LN-4in PZ-413',
        '圧電ウエハー LT-6in PZ-603',
        '圧電ウエハー LN-6in PZ-612',
        '圧電ウエハー LT-4in PZ-404',
      ],
      [18500, 14200, 22800, 11600, 9800, 12400, 7600, 16900, 13100, 8900, 6800, 15400],
      '個',
      'DEMO-EF-CFP-PIEZO-PC',
    ),
  });

  // 18: 早川テープ工業 — キャリアテープ（CSV・最小列）
  specs.push({
    no: 18,
    fileName: '18_早川テープ工業_出荷明細_FY2025.csv',
    format: 'csv',
    encoding: 'utf8-bom',
    language: '日本語',
    supplierCode: 'SUP-48',
    supplierName: '早川テープ工業',
    supplierCountry: '日本',
    method: '数量ベース（kg × 架空係数）',
    columns: [
      { kind: 'month', header: '出荷月' },
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
    ],
    rows: coded(
      [
        'エンボスキャリアテープ CT-08',
        'エンボスキャリアテープ CT-12',
        'エンボスキャリアテープ CT-16',
        'トップカバーテープ TC-08',
        'トップカバーテープ TC-12',
        '紙キャリアテープ PC-08',
        '紙キャリアテープ PC-12',
        'エンボスキャリアテープ CT-24',
        'トップカバーテープ TC-16',
        '紙キャリアテープ PC-16',
        'エンボスキャリアテープ CT-32',
        'トップカバーテープ TC-24',
      ],
      [3800, 3100, 4600, 2500, 5300, 2100, 2900, 4200, 3400, 2700, 4900, 3600],
      'kg',
      'DEMO-EF-TAPE-JP-KG',
    ),
  });

  // 19: みずほ紙器工業 — 段ボール（kg）＋ 副資材（金額・推薦なし候補 → 人が選択）
  specs.push({
    no: 19,
    fileName: '19_みずほ紙器工業_納品実績_FY2025.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-49',
    supplierName: 'みずほ紙器工業',
    supplierCountry: '日本',
    method:
      '数量ベース（kg × 架空係数）＋ 金額ベース 2 行（係数コード空欄・推薦なし → 汎用係数から人が選択）',
    sheetName: '納品実績',
    columns: [
      { kind: 'supplier', header: 'サプライヤーコード' },
      { kind: 'item', header: '品目' },
      { kind: 'qty', header: '数量' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '納品月' },
    ],
    rows: [
      ...coded(
        [
          '段ボール外装箱 C5-210',
          '段ボール外装箱 C5-260',
          '段ボール外装箱 C6-310',
          '段ボール仕切り PT-45',
          '段ボール仕切り PT-60',
          '段ボールパレット DP-11',
          '段ボール外装箱 C6-360',
          '段ボール緩衝材 CB-20',
          '段ボール緩衝材 CB-30',
          '段ボールパレット DP-12',
          '段ボール外装箱 C7-410',
          '段ボール仕切り PT-80',
        ],
        [9200, 7800, 11500, 5400, 13800, 6600, 10300, 4700, 7100, 8500, 12400, 5900],
        'kg',
        'DEMO-EF-CARDBOARD-JP-KG',
      ).slice(0, 10),
      {
        item: '梱包用副資材一式（上期）',
        month: '2025-09',
        qty: 3400,
        unitRaw: '千円',
        factorCode: '',
        expectedFactorCode: 'EF-PUR-PACK',
        expectedResolution: 'manual',
      },
      {
        item: '梱包用副資材一式（下期）',
        month: '2026-03',
        qty: 3150,
        unitRaw: '千円',
        factorCode: '',
        expectedFactorCode: 'EF-PUR-PACK',
        expectedResolution: 'manual',
      },
    ],
  });

  // 20: 播磨精密加工サービス — 外注加工（金額・円 → 千円換算・注記あり）
  specs.push({
    no: 20,
    fileName: '20_播磨精密加工サービス_加工費請求明細_2025年度.xlsx',
    format: 'xlsx',
    language: '日本語',
    supplierCode: 'SUP-50',
    supplierName: '播磨精密加工サービス',
    supplierCountry: '日本',
    method:
      '金額ベース（円表記 → 千円換算 × 架空係数）。外注加工費のみで、支給材の負荷は含まない境界',
    sheetName: '請求明細',
    preamble: [
      ['播磨精密加工サービス株式会社 加工費請求明細（2025年度）'],
      ['本明細は外注加工費のみです（支給材の材料費・材料製造負荷は含みません）'],
    ],
    columns: [
      { kind: 'supplier', header: '仕入先コード' },
      { kind: 'item', header: '作業内容' },
      { kind: 'dtype', header: '種別', physical: '物理量', monetary: '金額' },
      { kind: 'qty', header: '購買金額' },
      { kind: 'unit', header: '単位' },
      { kind: 'factor', header: '排出係数コード' },
      { kind: 'month', header: '作業月' },
    ],
    noteRows: ['※ 金額は円建てです。支給材（当社支給の材料）の負荷は本明細に含まれません。'],
    rows: [
      ...coded(
        [
          '外注加工 精密切削（4月度）',
          '外注加工 精密切削（5月度）',
          '外注加工 精密研削（6月度）',
          '外注加工 精密切削（7月度）',
          '外注加工 精密研削（8月度）',
          '外注加工 精密切削（9月度）',
          '外注加工 レーザー加工（10月度）',
          '外注加工 精密切削（11月度）',
          '外注加工 レーザー加工（12月度）',
          '外注加工 精密研削（1月度）',
          '外注加工 精密切削（2月度）',
          '外注加工 レーザー加工（3月度）',
        ],
        [
          18400000, 15600000, 22300000, 12800000, 25100000, 17200000, 14500000, 20800000, 11900000,
          16400000, 23600000, 13700000,
        ],
        '円',
        'DEMO-EF-MACHINING-JP-KJPY',
      ).slice(0, 10),
      {
        item: '外注加工 追加試作（2月度）',
        month: '2026-02',
        qty: 6800000,
        unitRaw: '円',
        factorCode: '',
        expectedFactorCode: 'DEMO-EF-MACHINING-JP-KJPY',
        expectedResolution: 'auto',
      },
      {
        item: '外注加工 金型メンテナンス（3月度）',
        month: '2026-03',
        qty: 5200000,
        unitRaw: '円',
        factorCode: '',
        expectedFactorCode: 'DEMO-EF-MACHINING-JP-KJPY',
        expectedResolution: 'auto',
      },
    ],
  });

  // 妥当性ガード: 20 ファイル × 12 明細・品目一意・係数の単位一致
  if (specs.length !== 20) throw new Error(`ファイル数が 20 ではありません: ${specs.length}`);
  for (const spec of specs) {
    if (spec.rows.length !== 12) {
      throw new Error(`${spec.fileName}: 明細が 12 行ではありません（${spec.rows.length}）`);
    }
    const items = new Set(spec.rows.map((r) => r.item));
    if (items.size !== 12) {
      throw new Error(`${spec.fileName}: 品目名が重複しています（確定時の一意制約に反する）`);
    }
    for (const row of spec.rows) {
      const norm = UNIT_NORMALIZATION[row.unitRaw];
      if (!norm) throw new Error(`${spec.fileName}: 未定義の単位 ${row.unitRaw}`);
      const factor = MURATA_DEMO_FACTORS[row.expectedFactorCode];
      if (!factor) throw new Error(`${spec.fileName}: 未定義の係数 ${row.expectedFactorCode}`);
      if (factor.activityUnit !== norm.unit) {
        throw new Error(
          `${spec.fileName}: ${row.item} の単位（${norm.unit}）と係数 ${row.expectedFactorCode} の分母（${factor.activityUnit}）が一致しません`,
        );
      }
    }
  }
  return specs;
}

// ----------------------------------------------------------------------
// 期待値（正解データ）の独立計算
// ----------------------------------------------------------------------

export interface MurataExpectedRow {
  fileName: string;
  supplierCode: string;
  item: string;
  dataType: 'physical' | 'monetary';
  /** 正規化後の活動量（kg / m2 / 個 / 千円） */
  normalizedAmount: number;
  normalizedUnit: string;
  factorCode: string;
  resolution: MurataRow['expectedResolution'];
  /** round(正規化活動量 × 係数, 0.1) t-CO2e */
  emissions: number;
}

export function buildMurataExpectedRows(specs = buildMurataFileSpecs()): MurataExpectedRow[] {
  return specs.flatMap((spec) =>
    spec.rows.map((row) => {
      const norm = UNIT_NORMALIZATION[row.unitRaw]!;
      const normalizedAmount = row.qty * norm.multiplier;
      const factor = MURATA_DEMO_FACTORS[row.expectedFactorCode]!;
      return {
        fileName: spec.fileName,
        supplierCode: spec.supplierCode,
        item: row.item,
        dataType: (norm.unit === '千円' ? 'monetary' : 'physical') as 'physical' | 'monetary',
        normalizedAmount,
        normalizedUnit: norm.unit,
        factorCode: row.expectedFactorCode,
        resolution: row.expectedResolution,
        emissions: Math.round(normalizedAmount * factor.value * 10) / 10,
      };
    }),
  );
}

/** ファイル別・全体の期待合計（t-CO2e、0.1 丸めの合算） */
export function buildMurataExpectedTotals(specs = buildMurataFileSpecs()): {
  perFile: Array<{ fileName: string; supplierCode: string; total: number }>;
  grandTotal: number;
} {
  const rows = buildMurataExpectedRows(specs);
  const perFileMap = new Map<string, { fileName: string; supplierCode: string; total: number }>();
  for (const row of rows) {
    const entry = perFileMap.get(row.fileName) ?? {
      fileName: row.fileName,
      supplierCode: row.supplierCode,
      total: 0,
    };
    entry.total = Math.round((entry.total + row.emissions) * 10) / 10;
    perFileMap.set(row.fileName, entry);
  }
  const perFile = [...perFileMap.values()];
  const grandTotal = Math.round(perFile.reduce((sum, f) => sum + f.total, 0) * 10) / 10;
  return { perFile, grandTotal };
}

// ----------------------------------------------------------------------
// ファイルのバイト列生成
// ----------------------------------------------------------------------

function tableFor(spec: MurataFileSpec): (string | number)[][] {
  const header = spec.columns.map((c) => c.header);
  const rows: (string | number)[][] = spec.rows.map((row) =>
    spec.columns.map((col): string | number => {
      switch (col.kind) {
        case 'supplier':
          return spec.supplierCode;
        case 'item':
          return row.item;
        case 'dtype':
          return UNIT_NORMALIZATION[row.unitRaw]!.unit === '千円' ? col.monetary : col.physical;
        case 'qty':
          return row.qty;
        case 'unit':
          return row.unitRaw;
        case 'country':
          return row.country ?? '';
        case 'factor':
          return row.factorCode;
        case 'month':
          return row.month;
        case 'price':
          return row.unitPrice ?? '';
      }
    }),
  );

  const table: (string | number)[][] = [...(spec.preamble ?? []), header, ...rows];

  if (spec.totalRow) {
    const qtyIndex = spec.columns.findIndex((c) => c.kind === 'qty');
    const totalCells = spec.columns.map((c, i) => {
      if (i === 0) return spec.totalRow!.label;
      if (i === qtyIndex) return spec.rows.reduce((sum, r) => sum + r.qty, 0);
      return '';
    });
    table.push(totalCells);
  }
  for (const note of spec.noteRows ?? []) {
    table.push([note]);
  }
  return table;
}

export async function buildMurataFiles(
  specs = buildMurataFileSpecs(),
): Promise<Array<DatasetFile & { spec: MurataFileSpec }>> {
  const files: Array<DatasetFile & { spec: MurataFileSpec }> = [];
  for (const spec of specs) {
    const table = tableFor(spec);
    if (spec.format === 'xlsx') {
      files.push({
        name: spec.fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: await buildXlsx([
          { name: spec.sheetName ?? 'Sheet1', rows: table, boldFirstRow: false },
        ]),
        kind: 'table',
        spec,
      });
    } else {
      const text = csv(table.map((r) => r.map((cell) => String(cell))));
      files.push({
        name: spec.fileName,
        mimeType: 'text/csv',
        bytes: spec.encoding === 'sjis' ? encodeSjis(text) : utf8Bom(text),
        kind: 'table',
        spec,
      });
    }
  }
  return files;
}
