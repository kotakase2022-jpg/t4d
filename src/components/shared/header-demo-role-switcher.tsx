'use client';

import * as React from 'react';
import { unstable_rethrow } from 'next/navigation';
import { AlertTriangle, Check, ChevronDown, Loader2, RotateCcw, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { failureMessageOf } from '@/lib/errors/safe-form-action';

/** 切替候補（サーバーで同じ組織・@demo.local に絞り込み済み） */
export interface DemoRoleChoiceView {
  email: string;
  displayName: string;
  jobTitle: string | null;
  demoRole: string;
  roleLabels: string;
  current: boolean;
}

/**
 * デモの役割切替（Demo Mode のみ。指示書 §14.1）。
 *
 * 作成担当 → レビュアー → 最終承認者を、ログアウトせずに切り替えて実演する。
 * 候補の絞り込みと切替の可否はサーバー（switchDemoRoleAction）で改めて検査する。
 * 戻り先は今いる画面（クエリを含む）。デモ操作の持ち回りは切替の前後で保たれる。
 */
export function DemoRoleSwitcher({
  choices,
  onSwitchAction,
}: {
  choices: DemoRoleChoiceView[];
  onSwitchAction: (formData: FormData) => Promise<void>;
}) {
  const current = choices.find((c) => c.current);
  // 切替中・失敗を示す（以前は投げっぱなしで、切替の間も前の役割のまま操作でき、失敗も黙っていた。§4.2）
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const lastRequest = React.useRef<FormData | null>(null);

  const switchTo = (formData: FormData) => {
    lastRequest.current = formData;
    setError(null);
    startTransition(async () => {
      try {
        await onSwitchAction(formData);
      } catch (caught) {
        // 成功時の遷移（redirect）は Next.js へ返す
        unstable_rethrow(caught);
        setError(`役割を切り替えられませんでした。${failureMessageOf(caught)}`);
      }
    });
  };

  if (choices.length <= 1) return null;

  return (
    <div className="inline-flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex items-center gap-1.5 rounded-t4d border border-dashed border-warning/60 px-2 py-1 text-small text-ink hover:bg-warning-soft disabled:opacity-70"
          // 名前は見えている文言（役割切替（デモ））で始め、現在の利用者と役割を足す（label in name）
          aria-label={`役割切替（デモ） 現在: ${current?.displayName ?? '—'}・${current?.demoRole ?? '—'}${pending ? '（切替中）' : ''}`}
          aria-busy={pending || undefined}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-ink-muted" aria-hidden="true" />
          ) : (
            <Users className="size-3.5 text-ink-muted" aria-hidden="true" />
          )}
          <span className="whitespace-nowrap">{pending ? '切替中…' : '役割切替（デモ）'}</span>
          {current && (
            <span className="hidden max-w-[120px] truncate text-ink-muted xl:inline">
              {current.demoRole}
            </span>
          )}
          <ChevronDown className="size-3.5 text-ink-muted" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[300px]">
          <DropdownMenuLabel>デモの役割切替（同じ組織のデモ利用者）</DropdownMenuLabel>
          <p className="px-2 pb-1.5 text-caption text-ink-muted">
            デモ専用です。切り替えても権限は各利用者のロールのとおりで、本番の認可は変わりません。
          </p>
          <DropdownMenuSeparator />
          {choices.map((choice) => (
            <DropdownMenuItem
              key={choice.email}
              disabled={choice.current}
              // Menu を閉じると中の form が unmount され submit が成立しないため、
              // 選択時に Server Action を直接呼ぶ（selectors.tsx の UserMenu と同じ理由）。
              // 閉じるのは止めない: 戻り先は今いる画面（同じ Layout）なので、止めるとメニューが
              // 開いたまま残り、画面の他の部分が操作できない（aria-hidden）状態で切替が終わってしまう
              onSelect={() => {
                if (choice.current) return;
                const formData = new FormData();
                formData.set('email', choice.email);
                formData.set('returnTo', `${window.location.pathname}${window.location.search}`);
                switchTo(formData);
              }}
            >
              <span className="flex w-4 shrink-0 justify-center">
                {choice.current && <Check className="size-3.5" aria-hidden="true" />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body text-ink">
                  {choice.displayName}
                  <span className="ml-1.5 text-small font-medium text-brand-800">
                    {choice.demoRole}
                  </span>
                  {choice.current && (
                    <span className="ml-1 text-caption text-ink-muted">（現在）</span>
                  )}
                </span>
                <span className="truncate text-caption text-ink-muted">
                  {choice.roleLabels}
                  {choice.jobTitle ? `／${choice.jobTitle}` : ''}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && (
        <span role="status" className="sr-only">
          役割を切り替えています
        </span>
      )}
      {error && !pending && (
        <span
          role="alert"
          className="inline-flex items-center gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-1.5 py-0.5 text-caption text-ink"
        >
          <AlertTriangle className="size-3 shrink-0 text-danger" aria-hidden="true" />
          <span className="max-w-[260px] truncate" title={error}>
            {error}
          </span>
          <button
            type="button"
            onClick={() => lastRequest.current && switchTo(lastRequest.current)}
            className="inline-flex items-center gap-0.5 rounded-t4d px-1 text-brand-800 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            再試行
          </button>
        </span>
      )}
    </div>
  );
}
