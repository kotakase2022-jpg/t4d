import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 通知の枠（plan §3.1 Notice）。結果の通知・警告・エラー・補足を 1 つの部品で描く
 * （警告枠の直書き 68 か所・独自の <p> 19 ファイルを寄せる先）。
 *
 * - 色だけで種類を示さない: アイコンを必ず付け、title があれば種類の分かる見出しにする
 * - 消えない（自動で閉じない）: 必要な情報を利用者が読む前に消さない（指示書 §37 Toast の代替）
 * - role は呼び出し側が決める（結果の通知は status、エラーは alert。常設の注記には付けない:
 *   読み上げが騒がしくなり、getByRole('status') が複数に当たるため）
 * - action に「元に戻す」などの操作を置ける（plan §1.16 区分 3）
 */
export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: 'border-brand-200 bg-brand-50', icon: 'text-brand-700', Icon: Info },
  success: { box: 'border-success/40 bg-success-soft', icon: 'text-success', Icon: CheckCircle2 },
  warning: {
    box: 'border-warning/50 bg-warning-soft',
    icon: 'text-warning-ink',
    Icon: AlertTriangle,
  },
  danger: { box: 'border-danger/40 bg-danger-soft', icon: 'text-danger', Icon: XCircle },
};

export interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  role?: 'status' | 'alert';
  /** 右に置く操作（元に戻す・詳細へ など） */
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function Notice({ tone, title, role, action, className, children }: NoticeProps) {
  const style = TONE[tone];
  const Icon = tone === 'danger' && !title ? AlertTriangle : style.Icon;
  return (
    <div
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      data-notice-tone={tone}
      className={cn(
        'mb-2 flex items-start gap-1.5 rounded-t4d border px-3 py-1.5 text-small text-ink',
        style.box,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', style.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  );
}

/**
 * useActionState の結果（成功・失敗）の表示（plan §1.18 結果通知）。
 * idle のときは何も出さない。失敗は alert、成功は status
 */
export interface ActionResultState {
  status: 'idle' | 'success' | 'error';
  message: string | null;
}

export function ActionResult({
  state,
  id,
  className,
}: {
  state: ActionResultState | null | undefined;
  /** 入力欄の aria-describedby から指すとき */
  id?: string;
  className?: string;
}) {
  if (!state || state.status === 'idle' || !state.message) return null;
  const failed = state.status === 'error';
  return (
    <div id={id}>
      <Notice
        tone={failed ? 'danger' : 'success'}
        role={failed ? 'alert' : 'status'}
        className={className}
      >
        {state.message}
      </Notice>
    </div>
  );
}
