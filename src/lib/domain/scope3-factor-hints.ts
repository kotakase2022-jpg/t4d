/**
 * Scope3 Cat.1 の排出量原単位（排出係数）候補を絞り込むためのヒント（デモ用マスター補助）。
 *
 * EmissionFactor のスキーマを変えずに、係数コードごとの
 * 「品目キーワード」「対象地域」「算定境界」「算定方式」を持つ。
 * 候補の提示・推薦理由（単位一致・品目一致・生産国一致・世界平均フォールバック）は
 * すべてこの表からの決定論で、AI 判定は使わない。
 *
 * ヒントを持つ係数は「材料特化係数」として品目キーワードが一致したときだけ候補になる。
 * ヒントの無い係数（従来の汎用係数）は、材料特化の候補が無いときのフォールバック。
 * `server-only` を付けない純粋モジュール（サービス・画面・テストで共用）。
 */

export interface FactorHint {
  /** 品目テキストとの照合キーワード（小文字比較・日英） */
  keywords: string[];
  /** 対象地域の表示名（世界平均／日本／中国…／サプライヤー固有） */
  region: string;
  /** 生産国コードと一致すれば「生産国一致」で推薦する。null は地域非依存 */
  countryCode: 'JP' | 'CN' | 'TW' | 'KR' | 'MY' | null;
  /** 算定境界（表示用） */
  boundary: string;
  /** 算定方式（表示用） */
  basis: string;
}

const CRADLE_TO_GATE = '原材料調達〜製造（cradle-to-gate）';

export const SCOPE3_FACTOR_HINTS: Record<string, FactorHint> = {
  'DEMO-EF-BACO3-JP-KG': {
    keywords: ['炭酸バリウム', 'barium carbonate', 'baco3'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-TIO2-JP-KG': {
    keywords: ['酸化チタン', 'titanium dioxide', 'tio2'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-NI-JP-KG': {
    keywords: ['ニッケル', 'nickel'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-NI-GLB-KG': {
    keywords: ['ニッケル', 'nickel'],
    region: '世界平均',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-CU-GLB-KG': {
    keywords: ['銅粉', '銅粉末', 'copper'],
    region: '世界平均',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-AGPASTE-JP-KG': {
    keywords: ['銀', 'ペースト', 'silver', 'conductive paste'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-FERRITE-TW-KG': {
    keywords: ['フェライト', 'ferrite'],
    region: '台湾',
    countryCode: 'TW',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-ALLOY-KR-KG': {
    keywords: ['磁性合金', '合金粉', 'magnetic alloy', 'alloy powder'],
    region: '韓国',
    countryCode: 'KR',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-MAGWIRE-JP-KG': {
    keywords: ['エナメル銅線', '巻線', 'magnet wire', 'enameled'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-ALUMINA-GLB-KG': {
    keywords: ['アルミナ', 'alumina'],
    region: '世界平均',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-ALUMINA-MY-KG': {
    keywords: ['アルミナ', 'alumina'],
    region: 'マレーシア',
    countryCode: 'MY',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-CERSUB-CN-M2': {
    keywords: ['セラミック基板', 'ceramic substrate'],
    region: '中国',
    countryCode: 'CN',
    boundary: CRADLE_TO_GATE,
    basis: '数量（m2）',
  },
  'DEMO-EF-RESIN-JP-KG': {
    keywords: ['バインダー', '樹脂', 'binder', 'resin'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-SOLVENT-CN-KG': {
    keywords: ['溶剤', 'solvent'],
    region: '中国',
    countryCode: 'CN',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-PETFILM-JP-KG': {
    keywords: ['pet', '離型フィルム', 'release film'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-LCP-TW-M2': {
    keywords: ['lcp', 'liquid crystal polymer'],
    region: '台湾',
    countryCode: 'TW',
    boundary: CRADLE_TO_GATE,
    basis: '数量（m2）',
  },
  'DEMO-EF-PCB-CN-M2': {
    keywords: ['基板', 'circuit board', 'pcb'],
    region: '中国',
    countryCode: 'CN',
    boundary: CRADLE_TO_GATE,
    basis: '数量（m2）',
  },
  'DEMO-EF-PCB-GLB-M2': {
    keywords: ['基板', 'circuit board', 'pcb'],
    region: '世界平均',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '数量（m2）',
  },
  'DEMO-EF-CFP-IC-PC': {
    keywords: ['ic', 'モジュール用ic', 'integrated circuit', 'semiconductor'],
    region: 'サプライヤー固有（製品CFP）',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '製品CFP（個）',
  },
  'DEMO-EF-CFP-PIEZO-PC': {
    keywords: ['圧電', 'ウエハ', 'piezo', 'wafer'],
    region: 'サプライヤー固有（製品CFP）',
    countryCode: null,
    boundary: CRADLE_TO_GATE,
    basis: '製品CFP（個）',
  },
  'DEMO-EF-TAPE-JP-KG': {
    keywords: ['キャリアテープ', 'carrier tape'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-CARDBOARD-JP-KG': {
    keywords: ['段ボール', '包装材', 'cardboard', 'corrugated'],
    region: '日本',
    countryCode: 'JP',
    boundary: CRADLE_TO_GATE,
    basis: '数量（kg）',
  },
  'DEMO-EF-MACHINING-JP-KJPY': {
    keywords: ['外注加工', '加工サービス', 'machining', 'processing service'],
    region: '日本',
    countryCode: 'JP',
    boundary: '外注加工工程の上流排出（支給材の負荷は含まない）',
    basis: '金額（千円）',
  },
};

/** 生産国セルの表記ゆらぎ → 国コード。判定できない値は null（勝手に決めない） */
export function normalizeCountry(raw: string): FactorHint['countryCode'] {
  const v = raw.normalize('NFKC').trim().toLowerCase();
  if (v === '') return null;
  if (/^(日本|japan|jp|jpn)$/.test(v)) return 'JP';
  if (/^(中国|china|cn|chn|prc)$/.test(v)) return 'CN';
  if (/^(台湾|taiwan|tw|twn)$/.test(v)) return 'TW';
  if (/^(韓国|korea|south korea|kr|kor)$/.test(v)) return 'KR';
  if (/^(マレーシア|malaysia|my|mys)$/.test(v)) return 'MY';
  return null;
}

const COUNTRY_LABELS: Record<NonNullable<FactorHint['countryCode']>, string> = {
  JP: '日本',
  CN: '中国',
  TW: '台湾',
  KR: '韓国',
  MY: 'マレーシア',
};

export function countryLabel(code: FactorHint['countryCode']): string | null {
  return code ? COUNTRY_LABELS[code] : null;
}
