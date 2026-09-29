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

/** テンプレートに無いキー（取り違え・古い版のキー）。空なら全てテンプレートの項目 */
export function unknownTemplateKeys(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): string[] {
  const known = new Set(NARRATIVE_TEMPLATE_FIELDS[theme].map((f) => f.key));
  return Object.keys(fields).filter((key) => !known.has(key));
}
