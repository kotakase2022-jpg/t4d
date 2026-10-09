/**
 * 状態の表示の型（React 非依存。サーバー・クライアント・テストのどこからでも読める）。
 *
 * 状態は「意味（semantic）」で 10 種類に寄せ、色とアイコンは意味から 1 通りに決める。
 * 画面ごとに tone を選ぶと、同じ「差戻し」が画面によって赤・黄に揺れ、色だけを見て判断する
 * 利用者を誤らせる（指示書 §17・§23）。色だけで状態を示さないため、ラベルとアイコンを必ず併記する。
 */

/** Badge の tone（src/components/ui/badge.tsx と同じ値） */
export type StatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'outline';

/** StatusBadge が描くアイコンの名前（lucide-react の名前。Loader2 は回転を連想させるため使わない） */
export type StatusIconName =
  | 'circle-dashed'
  | 'file-pen'
  | 'hourglass'
  | 'eye'
  | 'undo-2'
  | 'circle-check'
  | 'alert-triangle'
  | 'x-circle'
  | 'info'
  | 'minus-circle'
  | 'circle-help';

export const STATUS_SEMANTICS = [
  'todo',
  'draft',
  'pending',
  'in_review',
  'returned',
  'done',
  'blocked',
  'error',
  'info',
  'excluded',
  // 追加の確認が要る（トライアル対応: 要求事項の「追加確認が必要」・横断対応の「一部」など）
  'question',
] as const;
export type StatusSemantic = (typeof STATUS_SEMANTICS)[number];

export interface StatusEntry {
  /** 画面に出す業務の言葉（生の enum・英語のシステム語は出さない） */
  label: string;
  semantic: StatusSemantic;
  /** 状態の意味の補足（Hint と読み上げ用。title= には入れない） */
  description?: string;
}

/** 意味ごとの色とアイコン（同じ意味は全画面で同じ見た目） */
export const SEMANTIC_STYLE: Record<StatusSemantic, { tone: StatusTone; icon: StatusIconName }> = {
  todo: { tone: 'neutral', icon: 'circle-dashed' },
  draft: { tone: 'outline', icon: 'file-pen' },
  pending: { tone: 'warning', icon: 'hourglass' },
  in_review: { tone: 'brand', icon: 'eye' },
  returned: { tone: 'warning', icon: 'undo-2' },
  done: { tone: 'success', icon: 'circle-check' },
  blocked: { tone: 'warning', icon: 'alert-triangle' },
  error: { tone: 'danger', icon: 'x-circle' },
  info: { tone: 'neutral', icon: 'info' },
  excluded: { tone: 'neutral', icon: 'minus-circle' },
  question: { tone: 'warning', icon: 'circle-help' },
};
