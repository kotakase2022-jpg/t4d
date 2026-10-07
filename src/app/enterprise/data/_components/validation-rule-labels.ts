/**
 * 検証ルールの種類の表示名（アラート・データの画面）。ルールのキー（missing_evidence など）を画面に出さない
 * （plan §1.17 規則 3）。知らないキーは「その他の検証」にする（画面を落とさず、生の値も出さない）。
 */
const VALIDATION_RULE_LABELS: Readonly<Record<string, string>> = {
  required: '必須項目の未入力',
  data_type: 'データ型',
  range: '値の範囲',
  unit_mismatch: '単位の不一致',
  unit_inconsistent_across_units: '拠点間の単位の不一致',
  yoy_deviation: '前年からの大きな変動',
  duplicate: '重複',
  formula_mismatch: '計算式との不一致',
  ratio_numerator_exceeds_denominator: '比率の分子が分母を超えている',
  missing_evidence: '根拠資料の不足',
  changed_after_approval: '承認後の変更',
};

export function validationRuleLabel(ruleKey: string): string {
  return Object.prototype.hasOwnProperty.call(VALIDATION_RULE_LABELS, ruleKey)
    ? VALIDATION_RULE_LABELS[ruleKey]!
    : 'その他の検証';
}
