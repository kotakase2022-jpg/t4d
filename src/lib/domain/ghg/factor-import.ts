import { isIsoCountryCode, normalizeCountryCode } from '@/lib/domain/country-code';
import { CO2_PER_C } from './fuel-co2';
import { kindHasBasis } from './factor-resolution';
import { parseActivity, parseEconomyClass, parseVehicleUse } from './labels';
import {
  parseNumberWithSeparator,
  unreadableNumberMessage,
  type DecimalSeparator,
} from './number-format';
import { cleanFloat } from './rounding';
import type { TransportDefaultRow, TransportFormulaClass } from './tonkm';
import { parseUnit, splitFactorUnit } from './units';
import type {
  EmissionBasis,
  EmissionFactor,
  FactorActivityKind,
  FuelEconomyClass,
  IsoDate,
  VehicleUse,
} from '@/types/domain';

/**
 * 係数セットの取込（plan §2.4 P91・CR-01。S1）。純関数（DB・画面・AI に依存しない）。
 *
 * 組織が使っている係数（電力の国・基準ごとの係数、燃料の 2 段係数、改良トンキロ法の式の係数と
 * 見なし積載率の原単位表）を、CSV・XLSX の表から係数セットの行へ読む。係数はデータで、コードに固定しない（plan K5）。
 *  - 列の対応付けは利用者が選ぶ（見出しの語から候補を出すだけ。推測で確定しない）
 *  - 読めない値・単位の次元が合わない値・同じコードと年度の重複はエラーにする（黙って捨てない・黙って代えない。plan K6）
 *  - 数の表記（「0.437」は 0.437 とも 437 とも読める）は小数点の記号を利用者が選ぶ（number-format.ts）
 *  - 単位発熱量は「GJ / 活動量の単位」、炭素排出係数は「tC/GJ」か「kgC/GJ」に限る（算定は単位発熱量を換算しないため、
 *    違う単位の値を黙って同じ数として使わない）
 *  - 改良トンキロ法の式は燃費区分ごとに 1 行（A・B・S・対数式の定数・最大積載量の範囲）、見なし積載率の原単位表は
 *    用途 × 最大積載量の区分 × 燃費区分ごとに 1 行。同じ係数コードの行を 1 つの係数（params）にまとめる
 */

export const FACTOR_IMPORT_FIELDS = [
  'code',
  'name',
  'kind',
  'activity',
  'contract',
  'country',
  'basis',
  'activityUnit',
  'calorificValue',
  'calorificUnit',
  'carbonFactor',
  'carbonFactorUnit',
  'factorValue',
  'factorUnit',
  'year',
  'validFrom',
  'validTo',
  'source',
  'region',
  'economyClass',
  'formulaA',
  'formulaB',
  'formulaS',
  'formulaLnA',
  'payloadMinKg',
  'payloadMaxKg',
  'vehicleUse',
  'loadPct',
  'intensity',
] as const;
export type FactorImportField = (typeof FACTOR_IMPORT_FIELDS)[number];

/** 列の対応付けの画面の項目名 */
export const FACTOR_IMPORT_FIELD_LABELS: Record<FactorImportField, string> = {
  code: '係数コード',
  name: '名称',
  kind: '種類',
  activity: '活動（燃料・ガスなど）',
  contract: '電力の契約',
  country: '国（ISO 2 文字）',
  basis: '基準（電力・熱）',
  activityUnit: '活動量の単位',
  calorificValue: '単位発熱量',
  calorificUnit: '単位発熱量の単位',
  carbonFactor: '炭素排出係数',
  carbonFactorUnit: '炭素排出係数の単位',
  factorValue: '排出係数（1 段）',
  factorUnit: '排出係数の単位',
  year: '年度',
  validFrom: '適用開始',
  validTo: '適用終了',
  source: '出典',
  region: '地域',
  economyClass: '燃費区分',
  formulaA: '式の係数 A',
  formulaB: '式の係数 B',
  formulaS: '式の係数 S',
  formulaLnA: '対数式の定数',
  payloadMinKg: '最大積載量の下限（kg）',
  payloadMaxKg: '最大積載量の上限（kg）',
  vehicleUse: '用途（事業用・自家用）',
  loadPct: '見なし積載率（%）',
  intensity: '原単位（L/t·km）',
};

/** どの係数にも要る列（無ければ対応付けのエラー） */
export const REQUIRED_FACTOR_FIELDS: readonly FactorImportField[] = [
  'code',
  'name',
  'kind',
  'activity',
];

/** 列の対応付けの段の分け方（画面の節） */
export const FACTOR_FIELD_GROUPS: ReadonlyArray<{
  title: string;
  fields: readonly FactorImportField[];
}> = [
  { title: '共通', fields: ['code', 'name', 'kind', 'activity', 'activityUnit', 'year'] },
  { title: '電力・熱・国', fields: ['country', 'basis', 'contract', 'region'] },
  {
    title: '係数の値',
    fields: [
      'calorificValue',
      'calorificUnit',
      'carbonFactor',
      'carbonFactorUnit',
      'factorValue',
      'factorUnit',
    ],
  },
  { title: '適用期間・出典', fields: ['validFrom', 'validTo', 'source'] },
  {
    title: '改良トンキロ法',
    fields: [
      'economyClass',
      'formulaA',
      'formulaB',
      'formulaS',
      'formulaLnA',
      'payloadMinKg',
      'payloadMaxKg',
      'vehicleUse',
      'loadPct',
      'intensity',
    ],
  },
];

/** 係数の種類の表示名 */
export const FACTOR_KIND_LABELS: Record<FactorActivityKind, string> = {
  fuel: '燃料',
  electricity: '電力',
  gas: 'ガス',
  heat: '熱',
  transport_formula: '改良トンキロ法の式',
  transport_default: '見なし積載率の原単位表',
};

export const EMISSION_BASIS_LABELS: Record<EmissionBasis, string> = {
  location: 'ロケーション基準',
  market: 'マーケット基準',
};

export const FUEL_ECONOMY_CLASS_LABELS: Record<FuelEconomyClass, string> = {
  y2025: '2025 年度燃費基準',
  y2022: '2022 年度燃費基準',
  y2015: '2015 年度燃費基準',
  unverified: '燃費基準の達成を確認できない車両',
};

export const VEHICLE_USE_LABELS: Record<VehicleUse, string> = {
  commercial: '事業用',
  private: '自家用',
};

/** 見出しの語（正規化した形）→ 項目。完全一致だけで当てる（似た語で推測しない） */
const HEADER_ALIASES: Record<FactorImportField, readonly string[]> = {
  code: ['係数コード', 'コード', '排出係数コード', 'code', 'factorcode'],
  name: ['名称', '係数名', '名前', 'name', 'factorname'],
  kind: ['種類', '係数の種類', 'kind', 'type'],
  activity: ['活動', '活動の種類', '燃料', '燃料種', 'activity', 'fuel'],
  contract: ['契約', '契約コード', '電力の契約', 'contract', 'contractcode'],
  country: ['国', '国コード', 'country', 'countrycode'],
  basis: ['基準', '算定基準', '電力の基準', '熱の基準', 'basis'],
  activityUnit: ['活動量の単位', '活動量単位', 'activityunit'],
  calorificValue: ['単位発熱量', '発熱量', 'calorificvalue', 'heatingvalue'],
  calorificUnit: ['単位発熱量の単位', '発熱量の単位', 'calorificunit'],
  carbonFactor: ['炭素排出係数', 'carbonfactor', 'carbonemissionfactor'],
  carbonFactorUnit: ['炭素排出係数の単位', 'carbonfactorunit'],
  factorValue: ['排出係数', '係数', '係数値', 'factor', 'factorvalue', 'emissionfactor'],
  factorUnit: ['排出係数の単位', '係数の単位', 'factorunit'],
  year: ['年度', '係数年度', '係数の年度', 'year', 'factoryear'],
  validFrom: ['適用開始', '適用開始日', 'validfrom'],
  validTo: ['適用終了', '適用終了日', 'validto'],
  source: ['出典', 'source'],
  region: ['地域', 'region'],
  economyClass: ['燃費区分', '燃費の区分', '燃費基準', 'economyclass'],
  formulaA: ['a', '係数a', '式のa', '式の係数a'],
  formulaB: ['b', '係数b', '式のb', '式の係数b'],
  formulaS: ['s', '係数s', '式のs', '式の係数s'],
  formulaLnA: ['lna', '対数式の定数', '対数式のa'],
  payloadMinKg: ['最大積載量の下限', '最大積載量下限', 'payloadmin', 'payloadminkg'],
  payloadMaxKg: ['最大積載量の上限', '最大積載量上限', 'payloadmax', 'payloadmaxkg'],
  vehicleUse: ['用途', '事業用自家用', '事業用または自家用', 'vehicleuse'],
  loadPct: ['見なし積載率', '積載率', 'loadpct', 'loadfactor'],
  intensity: ['原単位', '燃料使用原単位', 'intensity'],
};

/** 見出しの正規化（全角・空白・括弧の中の単位〔(kg)・(%)〕・区切り記号を落とす） */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s・_\-‐/]/g, '')
    .toLowerCase();
}

export type FactorColumnMapping = Partial<Record<FactorImportField, string>>;

/** 見出しから列の対応の候補を作る（同じ見出しを 2 つの項目に当てない） */
export function suggestFactorMapping(headers: readonly string[]): FactorColumnMapping {
  const mapping: FactorColumnMapping = {};
  const used = new Set<string>();
  for (const field of FACTOR_IMPORT_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const hit = headers.find(
      (h) => !used.has(h) && aliases.includes(normalizeHeader(h)) && h.trim() !== '',
    );
    if (hit) {
      mapping[field] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

/** 対応付けの検査（必須の列・存在しない見出し・同じ見出しの重複） */
export function validateFactorMapping(
  headers: readonly string[],
  mapping: FactorColumnMapping,
): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_FACTOR_FIELDS) {
    if (!mapping[field])
      errors.push(`「${FACTOR_IMPORT_FIELD_LABELS[field]}」の列を選んでください。`);
  }
  const seen = new Map<string, FactorImportField>();
  for (const field of FACTOR_IMPORT_FIELDS) {
    const header = mapping[field];
    if (!header) continue;
    if (!headers.includes(header)) {
      errors.push(
        `「${FACTOR_IMPORT_FIELD_LABELS[field]}」に選んだ列「${header}」がファイルにありません。`,
      );
      continue;
    }
    const other = seen.get(header);
    if (other) {
      errors.push(
        `列「${header}」を「${FACTOR_IMPORT_FIELD_LABELS[other]}」と「${FACTOR_IMPORT_FIELD_LABELS[field]}」の両方に選んでいます。`,
      );
    }
    seen.set(header, field);
  }
  return errors;
}

// ----------------------------------------------------------------------
// 値の読み方
// ----------------------------------------------------------------------

function norm(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s・()[\]_\-‐]/g, '')
    .toLowerCase();
}

/** 係数の種類（読めなければ null） */
export function parseFactorKind(raw: string): FactorActivityKind | null {
  const v = norm(raw);
  if (v === '') return null;
  if (/^(fuel|燃料)$/.test(v)) return 'fuel';
  if (/^(electricity|電力|電気)$/.test(v)) return 'electricity';
  if (/^(gas|ガス|都市ガス)$/.test(v)) return 'gas';
  if (/^(heat|熱|蒸気)$/.test(v)) return 'heat';
  if (/^(transportformula|改良トンキロ法の式|トンキロ法の式|式)$/.test(v))
    return 'transport_formula';
  if (/^(transportdefault|見なし積載率の原単位表|原単位表|見なし原単位)$/.test(v)) {
    return 'transport_default';
  }
  return null;
}

/** 電力の基準 */
export function parseBasis(raw: string): EmissionBasis | null {
  const v = norm(raw);
  if (v === '') return null;
  if (/^(location|ロケーション|ロケーション基準|locationbased)$/.test(v)) return 'location';
  if (/^(market|マーケット|マーケット基準|marketbased)$/.test(v)) return 'market';
  return null;
}

/** 日付（YYYY-MM-DD・YYYY/M/D・YYYY年M月D日）。読めなければ null */
export function parseIsoDate(raw: string): IsoDate | null {
  const v = raw.normalize('NFKC').trim();
  const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:T.*)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 活動のコードに使える文字（燃料種・契約のコード） */
const CODE_LIKE = /^[A-Za-z0-9_.-]{1,60}$/;

function activityCodeFor(
  kind: FactorActivityKind,
  activityRaw: string,
  contractRaw: string,
): string | null {
  const contract = contractRaw.normalize('NFKC').trim();
  if (kind === 'electricity') {
    if (contract !== '') return CODE_LIKE.test(contract) ? contract : null;
    const parsed = parseActivity(activityRaw);
    if (activityRaw.trim() === '' || parsed?.kind === 'electricity') return 'grid';
  }
  const parsed = parseActivity(activityRaw);
  const expected: Record<FactorActivityKind, string> = {
    fuel: 'fuel',
    electricity: 'electricity',
    gas: 'gas',
    heat: 'heat',
    transport_formula: 'fuel',
    transport_default: 'fuel',
  };
  if (parsed && parsed.kind === expected[kind]) return parsed.code;
  const text = activityRaw.normalize('NFKC').trim();
  return CODE_LIKE.test(text) ? text : null;
}

/** 炭素排出係数の単位（tC/GJ か kgC/GJ だけ） */
function carbonUnitOk(raw: string): boolean {
  const v = raw.normalize('NFKC').replace(/[\s-]/g, '').toLowerCase();
  return v === 'tc/gj' || v === 'kgc/gj';
}

/** 単位発熱量の単位（GJ / 活動量の単位だけ。算定は単位発熱量を換算しない） */
function calorificUnitOk(raw: string, activityUnitCode: string): boolean {
  const index = raw.lastIndexOf('/');
  if (index <= 0) return false;
  const numerator = parseUnit(raw.slice(0, index));
  const denominator = parseUnit(raw.slice(index + 1));
  return numerator?.code === 'GJ' && denominator?.code === activityUnitCode;
}

// ----------------------------------------------------------------------
// 表から係数へ
// ----------------------------------------------------------------------

export interface FactorImportTable {
  headers: readonly string[];
  rows: ReadonlyArray<Record<string, string>>;
  /** 元ファイルの行番号（ヘッダーを含む 1 始まり）。無ければ 2 から数える */
  rowNumbers?: readonly number[];
}

export interface FactorImportOptions {
  decimalSeparator?: DecimalSeparator | null;
  /** 年度の列・適用開始が無い行に使う年度（セットの基準年） */
  defaultYear?: number | null;
  /** 出典の列が無い・空の行に使う出典（セットの出典） */
  defaultSource: string;
  /** 1 ファイルの行の上限 */
  maxRows?: number;
}

/** 取り込む係数（ID・組織・セット・作成日時は確定のときに付ける） */
export type ImportedFactor = Omit<
  EmissionFactor,
  'id' | 'organizationId' | 'factorSetId' | 'createdAt'
> & {
  /** 元ファイルの行番号 */
  lines: number[];
};

export interface FactorImportIssue {
  /** 元ファイルの行番号（ファイル全体のときは null） */
  line: number | null;
  message: string;
}

export interface FactorImportResult {
  factors: ImportedFactor[];
  errors: FactorImportIssue[];
  warnings: FactorImportIssue[];
  /** 読んだ行（空の行を除く） */
  rowCount: number;
}

/** 1 ファイルの行の上限（既定） */
export const FACTOR_IMPORT_MAX_ROWS = 2000;

interface RowValues {
  line: number;
  get: (field: FactorImportField) => string;
}

interface DraftRow {
  line: number;
  code: string;
  name: string;
  kind: FactorActivityKind;
  activityCode: string;
  year: number;
  country: string | null;
  region: string | null;
  basis: EmissionBasis | null;
  activityUnit: string;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  source: string;
  calorific: [number, string] | null;
  carbon: [number, string] | null;
  factorValue: number | null;
  factorUnit: string | null;
  formula: { economyClass: FuelEconomyClass; cls: TransportFormulaClass; S: number } | null;
  defaults: {
    vehicleUse: VehicleUse;
    minKg: number | null;
    maxKg: number | null;
    loadPct: number;
    economyClass: FuelEconomyClass;
    value: number;
  } | null;
}

function readRow(
  values: RowValues,
  options: FactorImportOptions,
  errors: FactorImportIssue[],
): DraftRow | null {
  const { line, get } = values;
  const before = errors.length;
  const fail = (message: string) => errors.push({ line, message });
  const num = (field: FactorImportField): number | null => {
    const text = get(field).trim();
    if (text === '') return null;
    const n = parseNumberWithSeparator(text, options.decimalSeparator);
    if (n === null) {
      fail(
        unreadableNumberMessage(FACTOR_IMPORT_FIELD_LABELS[field], text, options.decimalSeparator),
      );
    }
    return n;
  };

  const code = get('code').normalize('NFKC').trim();
  if (code === '') fail('係数コードが空です。');
  else if (code.length > 80) fail('係数コードは 80 文字までです。');
  const name = get('name').trim();
  if (name === '') fail('名称が空です。');
  else if (name.length > 200) fail('名称は 200 文字までです。');

  const kindText = get('kind');
  const kind = parseFactorKind(kindText);
  if (!kind) {
    fail(
      `種類「${kindText}」を読めません（燃料・電力・ガス・熱・改良トンキロ法の式・見なし積載率の原単位表のどれか）。`,
    );
    return null;
  }
  const activityCode = activityCodeFor(kind, get('activity'), get('contract'));
  if (!activityCode) fail(`活動「${get('activity')}」を読めません（燃料種のコード・名前）。`);

  const countryText = get('country').trim();
  let country: string | null = null;
  if (countryText !== '') {
    if (isIsoCountryCode(countryText)) country = normalizeCountryCode(countryText);
    else fail(`国「${countryText}」は ISO 3166-1 の 2 文字のコードで書いてください（例 JP）。`);
  }
  const region = get('region').trim() || null;
  if (region && region.length > 100) fail('地域は 100 文字までです。');

  const basisText = get('basis');
  const basis = parseBasis(basisText);
  // 購入した電力・熱は Scope2 の 2 基準で別々に算定する（どちらの基準の係数かを決めずに取り込まない）
  if (kindHasBasis(kind) && !basis) {
    fail(
      kind === 'heat'
        ? '熱の係数には基準（ロケーション基準・マーケット基準）が要ります。'
        : '電力の係数には基準（ロケーション基準・マーケット基準）が要ります。',
    );
  }
  if (!kindHasBasis(kind) && basisText.trim() !== '') {
    fail('基準（ロケーション・マーケット）は電力・熱の係数にだけ書きます。');
  }

  const transport = kind === 'transport_formula' || kind === 'transport_default';
  const unitText = get('activityUnit').trim();
  let activityUnit = 'tkm';
  if (transport) {
    if (unitText !== '' && parseUnit(unitText)?.code !== 'tkm') {
      fail('改良トンキロ法の係数の活動量の単位は t·km です。');
    }
  } else {
    const unit = parseUnit(unitText);
    if (!unit) fail(`活動量の単位「${unitText}」を読めません。`);
    else activityUnit = unit.code;
  }

  const validFromText = get('validFrom').trim();
  const validToText = get('validTo').trim();
  const validFrom = validFromText === '' ? null : parseIsoDate(validFromText);
  const validTo = validToText === '' ? null : parseIsoDate(validToText);
  if (validFromText !== '' && !validFrom)
    fail(`適用開始「${validFromText}」を日付として読めません。`);
  if (validToText !== '' && !validTo) fail(`適用終了「${validToText}」を日付として読めません。`);
  if (validFrom && validTo && validFrom > validTo) fail('適用開始が適用終了より後です。');

  const yearText = get('year').trim();
  let year: number | null = null;
  if (yearText !== '') {
    const y = Number(yearText.normalize('NFKC').replace(/年度?$/, ''));
    if (!Number.isInteger(y) || y < 1990 || y > 2100) fail(`年度「${yearText}」を読めません。`);
    else year = y;
  } else if (validFrom) {
    year = Number(validFrom.slice(0, 4));
  } else if (options.defaultYear) {
    year = options.defaultYear;
  } else {
    fail('年度が分かりません（年度の列・適用開始・セットの基準年のどれかが要ります）。');
  }

  const source = (get('source').trim() || options.defaultSource).trim();
  if (source.length > 300) fail('出典は 300 文字までです。');

  let calorific: DraftRow['calorific'] = null;
  let carbon: DraftRow['carbon'] = null;
  let factorValue: number | null = null;
  let factorUnit: string | null = null;
  let formula: DraftRow['formula'] = null;
  let defaults: DraftRow['defaults'] = null;

  if (!transport) {
    const cal = num('calorificValue');
    const car = num('carbonFactor');
    const direct = num('factorValue');
    if ((cal === null) !== (car === null)) {
      fail('2 段係数は単位発熱量と炭素排出係数の両方が要ります。');
    } else if (cal !== null && car !== null) {
      const calUnit = get('calorificUnit').trim();
      const carUnit = get('carbonFactorUnit').trim() || 'tC/GJ';
      if (!(cal > 0) || !(car > 0)) fail('単位発熱量と炭素排出係数は 0 より大きい値です。');
      if (!calorificUnitOk(calUnit, activityUnit)) {
        fail(
          `単位発熱量の単位「${calUnit}」は「GJ/${activityUnit}」にしてください（算定は単位発熱量を換算しません）。`,
        );
      }
      if (!carbonUnitOk(carUnit)) {
        fail(`炭素排出係数の単位「${carUnit}」は tC/GJ か kgC/GJ にしてください。`);
      }
      // 2 段係数があれば 1 段の列（排出係数）は使わない（どちらで算定したかが行ごとに変わらないように）
      calorific = [cal, calUnit];
      carbon = [car, carUnit];
    } else if (direct === null) {
      fail('係数の値がありません（2 段係数〔単位発熱量・炭素排出係数〕か 1 段の排出係数）。');
    } else {
      const unitText2 = get('factorUnit').trim();
      const split = splitFactorUnit(unitText2);
      if (!(direct >= 0)) fail('排出係数は 0 以上の値です。');
      if (!split) {
        fail(`排出係数の単位「${unitText2}」を読めません（例 kg-CO2/kWh・t-CO2/kL）。`);
      } else if (split.activity.code !== activityUnit) {
        fail(
          `排出係数の単位「${unitText2}」の分母が活動量の単位（${activityUnit}）と違います（算定は係数の単位を換算しません）。`,
        );
      }
      factorValue = direct;
      factorUnit = unitText2;
    }
  } else if (kind === 'transport_formula') {
    const economyClass = parseEconomyClass(get('economyClass'));
    if (!economyClass) fail(`燃費区分「${get('economyClass')}」を読めません。`);
    const A = num('formulaA');
    const B = num('formulaB');
    const S = num('formulaS');
    const lnA = num('formulaLnA');
    const minKg = num('payloadMinKg');
    const maxKg = num('payloadMaxKg');
    if (A === null || !(A > 0)) fail('改良トンキロ法の式の係数 A（0 より大きい値）が要ります。');
    if (B === null) fail('改良トンキロ法の式の係数 B が要ります。');
    if (S === null || !(S > 0)) fail('改良トンキロ法の式の係数 S（0 より大きい値）が要ります。');
    if (minKg !== null && minKg < 0) fail('最大積載量の下限は 0 以上です。');
    if (minKg !== null && maxKg !== null && !(minKg < maxKg)) {
      fail('最大積載量の下限は上限より小さい値です。');
    }
    if (economyClass && A !== null && B !== null && S !== null) {
      const cls: TransportFormulaClass = { A, B };
      if (lnA !== null) cls.lnA = lnA;
      if (minKg !== null) cls.payloadMinKg = minKg;
      if (maxKg !== null) cls.payloadMaxKg = maxKg;
      formula = { economyClass, cls, S };
    }
  } else {
    const economyClass = parseEconomyClass(get('economyClass'));
    if (!economyClass) fail(`燃費区分「${get('economyClass')}」を読めません。`);
    const vehicleUse = parseVehicleUse(get('vehicleUse'));
    if (!vehicleUse) fail(`用途「${get('vehicleUse')}」を読めません（事業用・自家用）。`);
    const minKg = num('payloadMinKg');
    const maxKg = num('payloadMaxKg');
    const loadPct = num('loadPct');
    const value = num('intensity');
    if (loadPct === null || !(loadPct > 0 && loadPct <= 100)) {
      fail('見なし積載率（0 より大きく 100 以下の %）が要ります。');
    }
    if (value === null || !(value > 0)) fail('原単位（L/t·km。0 より大きい値）が要ります。');
    if (minKg !== null && minKg < 0) fail('最大積載量の下限は 0 以上です。');
    if (minKg !== null && maxKg !== null && !(minKg < maxKg)) {
      fail('最大積載量の下限は上限より小さい値です。');
    }
    if (economyClass && vehicleUse && loadPct !== null && value !== null) {
      defaults = { vehicleUse, minKg, maxKg, loadPct, economyClass, value };
    }
  }

  if (errors.length > before || !activityCode || year === null) return null;
  return {
    line,
    code,
    name,
    kind,
    activityCode,
    year,
    country,
    region,
    basis: kindHasBasis(kind) ? basis : null,
    activityUnit,
    validFrom,
    validTo,
    source,
    calorific,
    carbon,
    factorValue,
    factorUnit,
    formula,
    defaults,
  };
}

function baseFactor(row: DraftRow): Omit<ImportedFactor, 'factorValue' | 'factorUnit' | 'params'> {
  return {
    code: row.code,
    name: row.name,
    category: 'scope12',
    activityUnit: row.activityUnit,
    factorYear: row.year,
    factorSource: row.source,
    countryCode: row.country,
    regionLabel: row.region,
    basis: row.basis,
    activityKind: row.kind,
    activityCode: row.activityCode,
    gas: 'co2e',
    calorificValue: row.calorific ? row.calorific[0] : null,
    calorificUnit: row.calorific ? row.calorific[1] : null,
    carbonFactor: row.carbon ? row.carbon[0] : null,
    carbonFactorUnit: row.carbon ? row.carbon[1] : null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    lines: [row.line],
  };
}

/** 2 段係数の 1 段にした値（t-CO2 / 活動量の単位。表示用。算定は 2 段で行う） */
function effectiveTwoStage(row: DraftRow): number {
  const [cal] = row.calorific!;
  const [car, carUnit] = row.carbon!;
  const carbonT = carUnit.normalize('NFKC').toLowerCase().startsWith('kg') ? car / 1000 : car;
  return cleanFloat(cal * carbonT * CO2_PER_C);
}

/** 同じコード・年度の行を 1 つの係数にまとめる */
function mergeGroup(rows: DraftRow[], errors: FactorImportIssue[]): ImportedFactor | null {
  const first = rows[0]!;
  const label = `係数コード「${first.code}」（${first.year} 年度）`;
  if (rows.some((r) => r.kind !== first.kind || r.activityCode !== first.activityCode)) {
    for (const r of rows.slice(1)) {
      errors.push({ line: r.line, message: `${label} の行で種類か活動が違います。` });
    }
    return null;
  }
  if (first.kind !== 'transport_formula' && first.kind !== 'transport_default') {
    for (const r of rows.slice(1)) {
      errors.push({ line: r.line, message: `${label} が 2 回あります（行 ${first.line}）。` });
    }
    if (rows.length > 1) return null;
    const twoStage = first.calorific !== null && first.carbon !== null;
    return {
      ...baseFactor(first),
      factorValue: twoStage ? effectiveTwoStage(first) : first.factorValue!,
      factorUnit: twoStage ? `t-CO2/${first.activityUnit}` : first.factorUnit!,
      params: {},
    };
  }
  const lines = rows.map((r) => r.line);
  if (first.kind === 'transport_formula') {
    const S = first.formula!.S;
    const classes: Partial<Record<FuelEconomyClass, TransportFormulaClass>> = {};
    let ok = true;
    for (const r of rows) {
      if (r.formula!.S !== S) {
        errors.push({ line: r.line, message: `${label} の式の係数 S が行によって違います。` });
        ok = false;
      }
      if (classes[r.formula!.economyClass]) {
        errors.push({
          line: r.line,
          message: `${label} に燃費区分「${FUEL_ECONOMY_CLASS_LABELS[r.formula!.economyClass]}」が 2 回あります。`,
        });
        ok = false;
      }
      classes[r.formula!.economyClass] = r.formula!.cls;
    }
    if (!ok) return null;
    return {
      ...baseFactor(first),
      lines,
      factorValue: 0,
      factorUnit: 'L/tkm',
      params: { S, classes },
    };
  }
  const table: TransportDefaultRow[] = [];
  let ok = true;
  for (const r of rows) {
    const d = r.defaults!;
    let entry = table.find(
      (e) =>
        e.vehicleUse === d.vehicleUse &&
        e.minKg === d.minKg &&
        e.maxKg === d.maxKg &&
        e.loadPct === d.loadPct,
    );
    if (!entry) {
      const overlapping = table.find(
        (e) =>
          e.vehicleUse === d.vehicleUse &&
          (e.maxKg === null || d.minKg === null || d.minKg < e.maxKg) &&
          (d.maxKg === null || e.minKg === null || e.minKg < d.maxKg),
      );
      if (overlapping) {
        errors.push({
          line: r.line,
          message: `${label} の最大積載量の区分が他の行と重なっています（${VEHICLE_USE_LABELS[d.vehicleUse]}）。`,
        });
        ok = false;
        continue;
      }
      entry = {
        vehicleUse: d.vehicleUse,
        minKg: d.minKg,
        maxKg: d.maxKg,
        loadPct: d.loadPct,
        values: {},
      };
      table.push(entry);
    }
    if (entry.values[d.economyClass] !== undefined) {
      errors.push({
        line: r.line,
        message: `${label} の同じ区分に燃費区分「${FUEL_ECONOMY_CLASS_LABELS[d.economyClass]}」が 2 回あります。`,
      });
      ok = false;
      continue;
    }
    entry.values[d.economyClass] = d.value;
  }
  if (!ok) return null;
  table.sort(
    (a, b) => a.vehicleUse.localeCompare(b.vehicleUse) || (a.minKg ?? -1) - (b.minKg ?? -1),
  );
  return {
    ...baseFactor(first),
    lines,
    factorValue: 0,
    factorUnit: 'L/tkm',
    params: { table },
  };
}

/**
 * 表を係数の行へ読む。エラーが 1 つでもあれば確定させない（呼び出し側が errors を見る）。
 * 警告は確定を止めない（例: 同じ活動・基準・国の係数がセットに 2 つある）
 */
export function extractFactorRows(
  table: FactorImportTable,
  mapping: FactorColumnMapping,
  options: FactorImportOptions,
): FactorImportResult {
  const errors: FactorImportIssue[] = [];
  const warnings: FactorImportIssue[] = [];
  const mappingErrors = validateFactorMapping(table.headers, mapping);
  if (mappingErrors.length > 0) {
    return {
      factors: [],
      errors: mappingErrors.map((message) => ({ line: null, message })),
      warnings,
      rowCount: 0,
    };
  }
  const maxRows = options.maxRows ?? FACTOR_IMPORT_MAX_ROWS;
  const nonEmpty = table.rows
    .map((row, index) => ({ row, line: table.rowNumbers?.[index] ?? index + 2 }))
    .filter(({ row }) => Object.values(row).some((v) => (v ?? '').trim() !== ''));
  if (nonEmpty.length === 0) {
    return {
      factors: [],
      errors: [{ line: null, message: '係数の行がありません。' }],
      warnings,
      rowCount: 0,
    };
  }
  if (nonEmpty.length > maxRows) {
    return {
      factors: [],
      errors: [
        {
          line: null,
          message: `1 ファイルの行は ${maxRows} 行までです（${nonEmpty.length} 行）。`,
        },
      ],
      warnings,
      rowCount: nonEmpty.length,
    };
  }

  const drafts: DraftRow[] = [];
  for (const { row, line } of nonEmpty) {
    const get = (field: FactorImportField) => {
      const header = mapping[field];
      return header ? (row[header] ?? '') : '';
    };
    const draft = readRow({ line, get }, options, errors);
    if (draft) drafts.push(draft);
  }

  const groups = new Map<string, DraftRow[]>();
  for (const draft of drafts) {
    const key = `${draft.code}\u0000${draft.year}`;
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }
  const factors: ImportedFactor[] = [];
  for (const rows of groups.values()) {
    const merged = mergeGroup(rows, errors);
    if (merged) factors.push(merged);
  }
  factors.sort((a, b) => a.code.localeCompare(b.code) || a.factorYear - b.factorYear);

  // 同じ活動・基準・国・年度の係数が 2 つあると、割当では選び分けられるが、仮説の再計算で
  // 「別のセットの同じ係数」へ置き換えるときに区別できない（止めないが知らせる）
  const seen = new Map<string, ImportedFactor>();
  for (const f of factors) {
    const key = [
      f.activityKind,
      f.activityCode,
      f.basis ?? '',
      f.countryCode ?? '',
      f.factorYear,
    ].join('|');
    const other = seen.get(key);
    if (other) {
      warnings.push({
        line: f.lines[0] ?? null,
        message: `係数コード「${f.code}」と「${other.code}」は同じ活動・基準・国・年度の係数です（割当では選び分けられますが、仮説の再計算でセットを置き換えるときに区別できません）。`,
      });
    } else {
      seen.set(key, f);
    }
  }
  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { factors, errors, warnings, rowCount: nonEmpty.length };
}
