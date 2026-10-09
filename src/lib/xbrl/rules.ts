/**
 * XBRL の簡易検査の規則（V01〜V16。plan §3.5）。T4D が独自に行う構造の確認で、EDINET・ESEF の
 * 公式の検証（検証器・規則）を再現したものではない（画面・出力にもそう書く）。
 *
 * 重大度: エラー（出力を止める）・警告（出力はできるが確認が要る）・注記（常に知らせる事実）。
 * 同じ規則でも状況で重大度が変わるものがある（V05 の精度・V11 の SAMPLE）。
 */

export const XBRL_RULE_IDS = [
  'V01',
  'V02',
  'V03',
  'V04',
  'V05',
  'V06',
  'V07',
  'V08',
  'V09',
  'V10',
  'V11',
  'V12',
  'V13',
  'V14',
  'V15',
  'V16',
] as const;
export type XbrlRuleId = (typeof XBRL_RULE_IDS)[number];

export type XbrlSeverity = 'error' | 'warning' | 'note';

export const XBRL_SEVERITY_LABELS: Record<XbrlSeverity, string> = {
  error: 'エラー',
  warning: '警告',
  note: '注記',
};

export const XBRL_RULES: Record<XbrlRuleId, { title: string; severity: XbrlSeverity }> = {
  V01: { title: '適用する要求事項に確定した対応付けがない', severity: 'warning' },
  V02: { title: '対応付け先に承認済みの値がない（事実を出さない）', severity: 'warning' },
  V03: { title: '概念の型と単位・値が合わない', severity: 'error' },
  V04: { title: '期間型（期間・時点）が合わない', severity: 'error' },
  V05: { title: '数値の精度（decimals）がない・矛盾する', severity: 'error' },
  V06: { title: '同じ概念・コンテキスト・単位に異なる値がある', severity: 'error' },
  V07: { title: '本文の表示値と事実の値が一致しない', severity: 'error' },
  V08: { title: '推計・目標の値を実績として対応付けた', severity: 'warning' },
  V09: { title: '未承認の版の値を対応付けた', severity: 'warning' },
  V10: { title: 'テキストブロックの節が空・未承認', severity: 'warning' },
  V11: { title: '提出者の識別子がない', severity: 'error' },
  V12: { title: 'タクソノミと基準の版が対応しない', severity: 'warning' },
  V13: { title: '境界に対応する軸メンバーがない・不正', severity: 'error' },
  V14: { title: '抽象・軸・メンバー（値を持たない概念）に値を付けた', severity: 'error' },
  V15: { title: '前年・基準年の対応付けに、その期間の版がない', severity: 'warning' },
  V16: { title: 'パッケージが提出用ではない（SAMPLE・草案・ライセンス未取得）', severity: 'note' },
};

/** 検査の版（規則を変えたら上げる。出力の記録の検証の要約に残す） */
export const XBRL_VALIDATOR_VERSION = 't4d-xbrl-check-v1';

export interface XbrlFinding {
  rule: XbrlRuleId;
  severity: XbrlSeverity;
  message: string;
  /** どの対応付けの指摘か（全体の指摘は null） */
  mappingId: string | null;
  factId: string | null;
  /** 要求事項の指摘（V01） */
  itemId: string | null;
}

export function finding(
  rule: XbrlRuleId,
  message: string,
  refs: { mappingId?: string | null; factId?: string | null; itemId?: string | null } = {},
  severity: XbrlSeverity = XBRL_RULES[rule].severity,
): XbrlFinding {
  return {
    rule,
    severity,
    message,
    mappingId: refs.mappingId ?? null,
    factId: refs.factId ?? null,
    itemId: refs.itemId ?? null,
  };
}

const SEVERITY_ORDER: Record<XbrlSeverity, number> = { error: 0, warning: 1, note: 2 };

/** 指摘の並び（重い順 → 規則の番号 → 文） */
export function sortFindings(findings: readonly XbrlFinding[]): XbrlFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}
