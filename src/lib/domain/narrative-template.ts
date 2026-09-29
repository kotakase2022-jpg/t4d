/**
 * 定性情報のテンプレート項目（narrative_versions.fields のキー。docs/disclosure-first.md §3 0036）。
 *
 * テーマごとに「何が書かれていれば足りるか」を項目として持ち、値が無い項目はキー自体を持たない
 * （空文字で「入力済み」に見せない）。未記入の項目は不足情報として画面・AI 下書きに示す。
 * Fixture・画面・AI 下書きが同じキーを使うよう、定義はここだけに置く。
 */

import type { NarrativeTheme } from '@/types/domain';

export interface NarrativeTemplateField {
  key: string;
  label: string;
}

export const NARRATIVE_TEMPLATE_FIELDS: Readonly<
  Record<NarrativeTheme, readonly NarrativeTemplateField[]>
> = {
  governance: [
    { key: 'oversightBody', label: '監督する機関' },
    { key: 'oversightProcess', label: '監督の方法・頻度' },
    { key: 'committee', label: '委員会等の体制' },
    { key: 'managementRole', label: '経営者の役割' },
  ],
  risk_opportunity: [
    { key: 'riskCategory', label: '区分（物理的リスク・移行リスク・機会）' },
    { key: 'description', label: '内容' },
    { key: 'timeHorizon', label: '時間軸' },
    { key: 'affectedAssets', label: '影響を受ける拠点・事業' },
    { key: 'response', label: '対応策' },
  ],
  financial_impact: [
    { key: 'relatedRisk', label: '関連するリスク・機会' },
    { key: 'impactDescription', label: '影響の内容' },
    // 影響額は「分からない」を 0 や空欄で埋めない。未確定ならキーを持たず、理由を noAmountReason に書く
    { key: 'amount', label: '影響額' },
    { key: 'amountBasis', label: '算定方法・前提' },
    { key: 'estimationStatus', label: '算定の状況' },
    { key: 'noAmountReason', label: '影響額を示さない理由' },
  ],
  strategy: [
    { key: 'relatedRiskOpportunity', label: '対応するリスク・機会' },
    { key: 'initiative', label: '取組' },
    { key: 'target', label: '関連する目標' },
    { key: 'progress', label: '進捗' },
  ],
  policy_other: [
    { key: 'policyName', label: '方針の名称' },
    { key: 'content', label: '内容' },
    { key: 'scope', label: '適用範囲' },
  ],
};

/** テンプレートのうち記入されていない項目（キーが無い・空白だけ）。並びはテンプレートの順 */
export function missingTemplateFields(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): NarrativeTemplateField[] {
  return NARRATIVE_TEMPLATE_FIELDS[theme].filter((f) => !(fields[f.key] ?? '').trim());
}

/** 定性情報のテンプレート項目の充足状況（画面・スナップショット・AI 下書きが同じ判定を使う） */
export interface NarrativeFieldAssessment {
  /** 未記入の項目 */
  missing: NarrativeTemplateField[];
  /**
   * 財務的影響を定量化しない理由（記載があるときだけ）。未確定の影響額・算定方法・前提と並べて示す。
   * 理由の記載は基準上の免除とは別であり、判断はレビュー・承認で人が行う（指示書 §6.6・§8.3）
   */
  notQuantifiedReason: string | null;
}

/**
 * テンプレートの項目を必須として判定する（開示ホーム・原稿一覧・スナップショットの不足情報が
 * すべてこの 1 か所を通る。以前は一覧とスナップショットで財務的影響の数え方が違っていた）。
 *
 * 財務的影響:
 *  - 影響額がある … 示さない理由は不要（未記入に数えない）
 *  - 影響額が無い … 影響額・算定方法・前提は、理由の記載があっても未確定のまま不足情報に残す。
 *    理由は「要件を満たした」ことにはならない（理由だけで充足とみなす一律の免除は置かない。
 *    指示書 §6.6・§8.3）。理由があれば notQuantifiedReason として不足情報の横に示す
 *  - 影響額も理由も無い … 影響額・算定方法・前提・示さない理由をすべて未記入とする
 */
export function assessNarrativeFields(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): NarrativeFieldAssessment {
  const missing = missingTemplateFields(theme, fields);
  if (theme !== 'financial_impact') return { missing, notQuantifiedReason: null };
  const hasAmount = Boolean(fields.amount?.trim());
  const reason = fields.noAmountReason?.trim() || null;
  return {
    missing: missing.filter((f) => f.key !== 'noAmountReason' || !hasAmount),
    notQuantifiedReason: hasAmount ? null : reason,
  };
}

/** 定量化しない理由の表示（不足情報の代わりに示す一文） */
export function notQuantifiedNote(reason: string): string {
  return `影響額を定量化していない理由: ${reason}`;
}

/**
 * 引用した定性情報の未記入項目（表示ラベル）。「未解決の必須情報」の数え方で、
 * 開示ホームのカード・原稿一覧の絞り込み・スナップショットの不足情報が同じ判定
 * （assessNarrativeFields）を使う（件数と一覧を食い違わせない）。
 */
export function unresolvedNarrativeFields(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): string[] {
  return assessNarrativeFields(theme, fields).missing.map((f) => f.label);
}

/** テンプレートに無いキー（取り違え・古い版のキー）。空なら全てテンプレートの項目 */
export function unknownTemplateKeys(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): string[] {
  const known = new Set(NARRATIVE_TEMPLATE_FIELDS[theme].map((f) => f.key));
  return Object.keys(fields).filter((key) => !known.has(key));
}
