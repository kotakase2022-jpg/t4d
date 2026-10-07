'use client';

import * as React from 'react';
import Link from 'next/link';
import { Lightbulb, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import type { GettingStartedStep } from '@/lib/ui/getting-started';
import { LOCAL_KEYS, readLocal, writeLocal } from '@/lib/ui/local-store';
import { cn } from '@/lib/utils';
import { useViewerKey } from './viewer-context';

/**
 * ホームの「はじめに」（plan §1.11 Beginner）。役割ごとの最初の 3 手順を 1 行の帯で示す。
 *
 * 閉じた印は利用者ごと・端末ごと（localStorage）。サーバーは localStorage を読めないため、
 * 描画は読み込み後に決める（閉じた人に一瞬だけ出して消す、を避けるため、決まるまでは何も描かない）。
 * localStorage が使えない環境では毎回出る（閉じるボタンはその表示の間だけ効く）。
 */
export function GettingStarted({
  profileLabel,
  steps,
  className,
}: {
  profileLabel: string;
  steps: GettingStartedStep[];
  className?: string;
}) {
  const viewerKey = useViewerKey();
  const key = LOCAL_KEYS.gettingStarted(viewerKey);
  // null: まだ読んでいない（サーバー描画と最初の描画）。true/false: 閉じた印の有無
  const [dismissed, setDismissed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    setDismissed(readLocal(key, (raw) => (raw === true ? true : null)) === true);
  }, [key]);

  if (dismissed !== false || steps.length === 0) return null;

  return (
    <section
      aria-labelledby="getting-started-title"
      data-getting-started=""
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t4d-lg border border-line bg-surface px-3 py-2',
        className,
      )}
    >
      <h2
        id="getting-started-title"
        className="flex shrink-0 items-center gap-1 text-body font-semibold text-ink"
      >
        <Lightbulb className="size-4 text-ink-muted" aria-hidden="true" />
        はじめに
        <span className="text-small font-normal text-ink-muted">（{profileLabel}）</span>
      </h2>
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {steps.map((step, index) => (
          <li key={step.key} className="flex min-w-0 items-baseline gap-1 text-small">
            <span className="tnum shrink-0 font-medium text-ink-muted" aria-hidden="true">
              {index + 1}.
            </span>
            <Link href={step.href} className="font-medium text-brand-700 hover:underline">
              {step.label}
            </Link>
            <span className="truncate text-ink-muted">{step.note}</span>
          </li>
        ))}
      </ol>
      <span className="text-caption text-ink-muted">ショートカットと用語集は ? キー</span>
      <IconButton
        label="「はじめに」を閉じる"
        icon={<X aria-hidden="true" />}
        onClick={() => {
          writeLocal(key, true);
          setDismissed(true);
        }}
      />
    </section>
  );
}
