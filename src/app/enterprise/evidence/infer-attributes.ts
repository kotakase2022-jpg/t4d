/**
 * 資料のファイル名から属性を推定する（plan S23・§1.8: システムが分かる値を入力させない）。
 * 推定は候補として空欄に入れるだけで、人が入れた値は上書きしない（呼び出し側の約束）。
 * 当たらないときは空文字（入れない）。
 */

/** 文書種別の手がかり（ファイル名に含まれる語 → 種別）。上から順に最初に当たったもの */
const DOCUMENT_TYPE_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/請求書|invoice/i, '請求書'],
  [/議事録|minutes/i, '議事録'],
  [/検針|メーター|meter/i, '検針票'],
  [/マニフェスト|manifest/i, 'マニフェスト'],
  [/規程|規則|規定|方針|policy/i, '規程・方針'],
  [/手順書|マニュアル|manual|procedure/i, '手順書'],
  [/報告書|レポート|report/i, '報告書'],
  [/契約|contract/i, '契約書'],
  [/証明書|certificate/i, '証明書'],
  [/集計|一覧|台帳|list/i, '集計表'],
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 実在する日付か（2026-02-30 などを候補にしない） */
function validDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1990 ||
    year > 2100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** ファイル名の日付（2026-06-30・2026_06_30・20260630・2026年6月30日）。無ければ空 */
export function inferIssuedOn(fileName: string): string {
  const separated = /(\d{4})[-_.年](\d{1,2})[-_.月](\d{1,2})日?/.exec(fileName);
  if (separated) return validDate(Number(separated[1]), Number(separated[2]), Number(separated[3]));
  const compact = /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(fileName);
  if (compact) return validDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  return '';
}

export function inferEvidenceAttributes(fileName: string): {
  title: string;
  documentType: string;
  issuedOn: string;
} {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  const documentType = DOCUMENT_TYPE_HINTS.find(([pattern]) => pattern.test(base))?.[1] ?? '';
  return { title: base, documentType, issuedOn: inferIssuedOn(base) };
}
