/**
 * 国コード（ISO 3166-1 alpha-2）の検査（plan CR-18）。純関数。
 *
 * 国別の係数の割当（拠点 ＞ 国 ＞ 全社既定）は拠点の国コードで引く。自由入力のまま「JPN」「Japan」が入ると、
 * 国の割当が黙って外れて全社既定の係数が使われる（係数の解決は国の一致で決まる）。登録の時点で 2 文字の
 * コードに限る。表は ISO 3166-1 alpha-2 の割り当て済みのコード（2026 年時点）。
 */

const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

export const ISO_3166_ALPHA2: ReadonlySet<string> = new Set(CODES.split(' '));

/** 表記ゆれ（小文字・前後の空白・全角）を揃える */
export function normalizeCountryCode(raw: string): string {
  return raw.normalize('NFKC').trim().toUpperCase();
}

export function isIsoCountryCode(raw: string): boolean {
  return ISO_3166_ALPHA2.has(normalizeCountryCode(raw));
}
