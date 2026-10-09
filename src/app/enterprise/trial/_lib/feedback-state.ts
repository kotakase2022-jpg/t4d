/**
 * 「ご意見・不具合」のダイアログの状態（クライアントとサーバーの両方から読む。'server-only' を付けない）。
 *
 * どの画面からでも送れるため、送れたら画面を移らずにダイアログの中で結果を示す（sent）。
 * 断られたとき（入力の誤り・権限）は理由と送った値を返し、入力を残す（error）。
 */
export interface FeedbackFormState {
  status: 'idle' | 'error' | 'sent';
  message: string | null;
  /** 送った値（error のときにフォームへ戻す） */
  values: Array<[string, string]> | null;
  /** 送れた件名（sent のとき） */
  sentTitle: string | null;
  /** 送るたびに変わる値（続けて送るときにフォームを作り直す） */
  nonce: number;
}

export const IDLE_FEEDBACK_STATE: FeedbackFormState = {
  status: 'idle',
  message: null,
  values: null,
  sentTitle: null,
  nonce: 0,
};

/** フィードバックの欄の名前（ダイアログと Server Action で同じ名前を使う） */
export const FEEDBACK_FIELDS = {
  kind: 'kind',
  title: 'title',
  body: 'body',
  severity: 'severity',
  scenarioId: 'scenarioId',
  route: 'route',
} as const;
