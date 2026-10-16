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

import { isIsoCountryCode, normalizeCountryCode } from './country-code';

export interface FactorHint {
  /** 品目テキストとの照合キーワード（小文字比較・日英） */
  keywords: string[];
  /** 対象地域の表示名（世界平均／日本／中国…／サプライヤー固有） */
  region: string;
  /** 生産国コード（ISO 3166-1 alpha-2）と一致すれば「生産国一致」で推薦する。null は地域非依存 */
  countryCode: string | null;
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

/**
 * 生産国の名前の表記ゆらぎ → 国コード（ISO 3166-1 alpha-2。plan CR-18）。
 * 日本語・英語の国名と alpha-3 を主な国だけ持ち、それ以外は 2 文字のコード（ISO の割り当て済みのもの）で受ける。
 * 表に無い名前・ISO に無いコードは null（勝手に決めない。候補の推薦は「世界平均」か人の選択になる）
 */
const COUNTRY_NAMES: ReadonlyArray<[code: string, label: string, aliases: readonly string[]]> = [
  ['JP', '日本', ['日本', 'japan', 'jpn']],
  ['CN', '中国', ['中国', '中華人民共和国', 'china', 'chn', 'prc']],
  ['TW', '台湾', ['台湾', 'taiwan', 'twn']],
  ['KR', '韓国', ['韓国', '大韓民国', 'korea', 'south korea', 'republic of korea', 'kor']],
  ['MY', 'マレーシア', ['マレーシア', 'malaysia', 'mys']],
  ['ID', 'インドネシア', ['インドネシア', 'indonesia', 'idn']],
  ['TH', 'タイ', ['タイ', 'thailand', 'tha']],
  ['VN', 'ベトナム', ['ベトナム', 'vietnam', 'viet nam', 'vnm']],
  ['PH', 'フィリピン', ['フィリピン', 'philippines', 'phl']],
  ['SG', 'シンガポール', ['シンガポール', 'singapore', 'sgp']],
  ['IN', 'インド', ['インド', 'india', 'ind']],
  ['HK', '香港', ['香港', 'hong kong', 'hkg']],
  ['KH', 'カンボジア', ['カンボジア', 'cambodia', 'khm']],
  ['MM', 'ミャンマー', ['ミャンマー', 'myanmar', 'mmr']],
  ['BD', 'バングラデシュ', ['バングラデシュ', 'bangladesh', 'bgd']],
  ['AU', 'オーストラリア', ['オーストラリア', 'australia', 'aus']],
  ['NZ', 'ニュージーランド', ['ニュージーランド', 'new zealand', 'nzl']],
  [
    'US',
    '米国',
    ['米国', 'アメリカ', 'アメリカ合衆国', 'united states', 'united states of america', 'usa'],
  ],
  ['CA', 'カナダ', ['カナダ', 'canada', 'can']],
  ['MX', 'メキシコ', ['メキシコ', 'mexico', 'mex']],
  ['BR', 'ブラジル', ['ブラジル', 'brazil', 'bra']],
  ['AR', 'アルゼンチン', ['アルゼンチン', 'argentina', 'arg']],
  ['CL', 'チリ', ['チリ', 'chile', 'chl']],
  ['DE', 'ドイツ', ['ドイツ', 'germany', 'deu']],
  ['FR', 'フランス', ['フランス', 'france', 'fra']],
  ['GB', '英国', ['英国', 'イギリス', 'united kingdom', 'uk', 'gbr']],
  ['IT', 'イタリア', ['イタリア', 'italy', 'ita']],
  ['ES', 'スペイン', ['スペイン', 'spain', 'esp']],
  ['NL', 'オランダ', ['オランダ', 'netherlands', 'nld']],
  ['CH', 'スイス', ['スイス', 'switzerland', 'che']],
  ['SE', 'スウェーデン', ['スウェーデン', 'sweden', 'swe']],
  ['PL', 'ポーランド', ['ポーランド', 'poland', 'pol']],
  ['CZ', 'チェコ', ['チェコ', 'czechia', 'czech republic', 'cze']],
  ['TR', 'トルコ', ['トルコ', 'turkey', 'türkiye', 'tur']],
  ['AE', 'アラブ首長国連邦', ['アラブ首長国連邦', 'united arab emirates', 'uae', 'are']],
  ['SA', 'サウジアラビア', ['サウジアラビア', 'saudi arabia', 'sau']],
  ['ZA', '南アフリカ', ['南アフリカ', 'south africa', 'zaf']],
];

const NAME_TO_CODE = new Map<string, string>(
  COUNTRY_NAMES.flatMap(([code, , aliases]) => aliases.map((a) => [a, code] as const)),
);
const COUNTRY_LABELS = new Map<string, string>(COUNTRY_NAMES.map(([code, label]) => [code, label]));

/** 生産国セルの表記ゆらぎ → 国コード（ISO 3166-1 alpha-2）。判定できない値は null（勝手に決めない） */
export function normalizeCountry(raw: string): string | null {
  const v = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (v === '') return null;
  const named = NAME_TO_CODE.get(v);
  if (named) return named;
  return /^[a-z]{2}$/.test(v) && isIsoCountryCode(v) ? normalizeCountryCode(v) : null;
}

/** 国コードの表示名（表に無い国はコードのまま） */
export function countryLabel(code: string | null): string | null {
  return code ? (COUNTRY_LABELS.get(code) ?? code) : null;
}
