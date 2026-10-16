import type {
  CarrierKind,
  FuelEconomyClass,
  GhgActivityKind,
  GhgScope,
  RoundingMethod,
  RoundingStage,
  VehicleUse,
} from '@/types/domain';

/**
 * 取込の表の語を値へ読む（既存の算定結果・活動量の取込で共通。純関数）。
 * 読めない語は null（推測で決めない。取込の検証でエラーとして人に返す）。
 */

function norm(raw: string | null | undefined): string {
  return (
    (raw ?? '')
      .normalize('NFKC')
      // NFKC の後は全角の空白・括弧も半角になる（全角の文字を正規表現に書かない）
      .replace(/[\s・()[\]_\-‐]/g, '')
      .toLowerCase()
  );
}

/** 区分（Scope） */
export function parseScope(raw: string | null | undefined): GhgScope | null {
  const v = norm(raw);
  if (v === '') return null;
  if (/^(scope|スコープ)?1$/.test(v)) return 'scope1';
  if (/^(scope|スコープ)?3(カテゴリ|cat|category)?4$/.test(v) || v === 'scope3cat4')
    return 'scope3_cat4';
  if (/^(scope|スコープ)?2/.test(v)) {
    if (/ロケーション|location/.test(v)) return 'scope2_location';
    return 'scope2';
  }
  return null;
}

/** 活動（種類とコード）。「軽油」「電力」「委託物流」など、またはコード（fuel:diesel） */
export function parseActivity(
  raw: string | null | undefined,
): { kind: GhgActivityKind; code: string } | null {
  const text = (raw ?? '').normalize('NFKC').trim();
  const coded = /^(fuel|electricity|gas|heat|transport):([a-z0-9_-]+)$/i.exec(text);
  if (coded) return { kind: coded[1]!.toLowerCase() as GhgActivityKind, code: coded[2]! };
  const v = norm(raw);
  const table: Array<[RegExp, GhgActivityKind, string]> = [
    [/^軽油$|^diesel$/, 'fuel', 'diesel'],
    [/^(揮発油|ガソリン|gasoline)$/, 'fuel', 'gasoline'],
    [/^灯油$|^kerosene$/, 'fuel', 'kerosene'],
    [/^a重油$/, 'fuel', 'heavy_oil_a'],
    [/^lpg$|^液化石油ガス$/, 'fuel', 'lpg'],
    [/^都市ガス$|^citygas$/, 'gas', 'city_gas'],
    [/^電力|^電気|^electricity/, 'electricity', 'grid'],
    [/^熱|^蒸気|^heat/, 'heat', 'heat'],
    [/^委託物流|^委託輸送|^contracted/, 'transport', 'contracted'],
    [/^自社便|^自社配送|^ownfleet/, 'transport', 'own_fleet'],
  ];
  const hit = table.find(([re]) => re.test(v));
  return hit ? { kind: hit[1], code: hit[2] } : null;
}

/** 燃料（輸送の燃料の種類） */
export function parseFuelCode(raw: string | null | undefined): string | null {
  const activity = parseActivity(raw);
  return activity && activity.kind === 'fuel' ? activity.code : null;
}

/** 月（YYYY-MM・YYYY/MM・YYYY-MM-DD・2025年1月）→ 月初日 */
export function parseMonth(raw: string | null | undefined): string | null {
  const v = (raw ?? '').normalize('NFKC').trim();
  const m = /^(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2})日?)?月?$/.exec(v);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-01`;
}

export function parseVehicleUse(raw: string | null | undefined): VehicleUse | null {
  const v = norm(raw);
  if (/^(事業用|営業用|commercial)$/.test(v)) return 'commercial';
  if (/^(自家用|private)$/.test(v)) return 'private';
  return null;
}

export function parseEconomyClass(raw: string | null | undefined): FuelEconomyClass | null {
  const v = norm(raw);
  if (v === '') return null;
  if (/2025/.test(v)) return 'y2025';
  if (/2022/.test(v)) return 'y2022';
  if (/2015/.test(v)) return 'y2015';
  if (/未確認|不明|unverified|その他/.test(v)) return 'unverified';
  return null;
}

export function parseCarrierKind(raw: string | null | undefined): CarrierKind | null {
  const v = norm(raw);
  if (/^(委託|外部|contracted)/.test(v)) return 'contracted';
  if (/^(自社|ownfleet|own)/.test(v)) return 'own_fleet';
  return null;
}

const STAGE_WORDS: Array<[RegExp, RoundingStage]> = [
  [/行ごと|明細ごと|line/, 'line'],
  [/月ごと|月次|month/, 'month'],
  [/活動ごと|拠点×?活動|siteactivity/, 'site_activity'],
  [/拠点ごと|拠点×?scope|拠点×?区分|sitescope/, 'site_scope'],
  [/合計|total/, 'total'],
];

const METHOD_WORDS: Array<[RegExp, RoundingMethod]> = [
  [/偶数丸め|銀行丸め|halfeven/, 'half_even'],
  [/四捨五入|halfup/, 'half_up'],
  [/切り?捨て|truncate/, 'truncate'],
  [/切り?上げ|ceil/, 'ceil'],
  [/floor|小さい側/, 'floor'],
];

/**
 * 丸めの記述（「月ごと・kg・切り捨て」「行ごと・t・小数3桁・四捨五入」）を読む。段・単位・方式のどれかが
 * 読めなければ null（不明。照合で丸めの原因を適用しない）
 */
export function parseRoundingNote(raw: string | null | undefined): {
  stage: RoundingStage;
  unit: 'kg' | 't';
  digits: number;
  method: RoundingMethod;
} | null {
  const v = norm(raw);
  if (v === '') return null;
  const stage = STAGE_WORDS.find(([re]) => re.test(v))?.[1];
  const method = METHOD_WORDS.find(([re]) => re.test(v))?.[1];
  const unit = /kg/.test(v) ? 'kg' : /(^|[^k])t($|[^a-z])|トン/.test(v) ? 't' : null;
  if (!stage || !method || !unit) return null;
  const digitsMatch = /小数(\d+)桁|(\d+)decimal/.exec(v);
  const digits = digitsMatch ? Number(digitsMatch[1] ?? digitsMatch[2]) : 0;
  return { stage, unit, digits, method };
}
