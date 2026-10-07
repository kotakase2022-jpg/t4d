import * as React from 'react';
import Link from 'next/link';
import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 段階の表示（plan §3.1 StepNav・指示書 §10 Wizard）。標準 CSV・プロジェクト作成・CSRD 設定・
 * サプライヤー取込・キャンペーン作成の段階 UI を揃える。
 *
 * - 状態は done／current／todo／blocked。色だけでなく、番号・チェック・鍵のアイコンと語で示す
 * - 現在の段は aria-current="step"
 * - href がある段はリンク（戻って直せる）。blocked はリンクにしない（理由を文字で）
 */
export type StepState = 'done' | 'current' | 'todo' | 'blocked';

export interface StepItem {
  key: string;
  label: string;
  state: StepState;
  href?: string;
  /** blocked の理由など（1 行） */
  note?: string;
}

const STATE_LABEL: Record<StepState, string> = {
  done: '完了',
  current: '現在の段階',
  todo: '未着手',
  blocked: '前の段階が必要',
};

export function StepNav({
  ariaLabel,
  steps,
  className,
}: {
  ariaLabel: string;
  steps: readonly StepItem[];
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {steps.map((step, index) => {
          const marker =
            step.state === 'done' ? (
              <Check className="size-3" aria-hidden="true" />
            ) : step.state === 'blocked' ? (
              <Lock className="size-3" aria-hidden="true" />
            ) : (
              <span aria-hidden="true">{index + 1}</span>
            );
          const content = (
            <>
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold',
                  step.state === 'current'
                    ? 'bg-brand-700 text-white'
                    : step.state === 'done'
                      ? 'bg-success-soft text-success'
                      : 'bg-surface-muted text-ink-muted',
                )}
              >
                {marker}
              </span>
              <span className={cn(step.state === 'current' && 'font-semibold text-ink')}>
                {step.label}
              </span>
              <span className="sr-only">（{STATE_LABEL[step.state]}）</span>
              {step.note && <span className="text-caption text-ink-muted">{step.note}</span>}
            </>
          );
          return (
            <li key={step.key} className="flex items-center gap-1">
              {index > 0 && <span aria-hidden="true" className="mx-0.5 h-px w-4 bg-line" />}
              {step.href && step.state !== 'blocked' ? (
                <Link
                  href={step.href}
                  aria-current={step.state === 'current' ? 'step' : undefined}
                  data-step-state={step.state}
                  className="inline-flex items-center gap-1.5 rounded-t4d px-1 py-0.5 text-small text-ink-muted hover:bg-brand-50 hover:text-ink"
                >
                  {content}
                </Link>
              ) : (
                <span
                  aria-current={step.state === 'current' ? 'step' : undefined}
                  data-step-state={step.state}
                  className="inline-flex items-center gap-1.5 px-1 py-0.5 text-small text-ink-muted"
                >
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
