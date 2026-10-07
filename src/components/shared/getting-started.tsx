'use client';

import * as React from 'react';
import Link from 'next/link';
import { Lightbulb, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import {
  addDismissedViewer,
  GETTING_STARTED_DISMISSED_COOKIE,
  parseDismissedViewers,
  type GettingStartedStep,
} from '@/lib/ui/getting-started';
import { LOCAL_KEYS, readLocal, writeLocal } from '@/lib/ui/local-store';
import { cn } from '@/lib/utils';
import { useViewerKey } from './viewer-context';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function readCookie(name: string): string | null {
  try {
    const hit = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  } catch {
    return null;
  }
}

/** 閉じた印を Cookie に残す（次の読み込みからサーバーが最初から出し分ける） */
function rememberDismissedInCookie(viewerKey: string): void {
  try {
    const value = addDismissedViewer(readCookie(GETTING_STARTED_DISMISSED_COOKIE), viewerKey);
    document.cookie = `${GETTING_STARTED_DISMISSED_COOKIE}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  } catch {
    // Cookie を書けない環境では localStorage の印だけで足りる（読み込み後に消える）
  }
}

/**
 * ホームの「はじめに」（plan §1.11 Beginner）。役割ごとの最初の 3 手順を 1 行の帯で示す。
 *
 * 閉じた印は利用者ごと（Cookie と localStorage）。サーバーが Cookie を読んで `initiallyDismissed` を渡すので、
 * 閉じていない人には最初の描画から出し、閉じた人には最初から出さない（読み込んだあとに帯を差し込んで
 * 本文を下へずらさない。plan §1.18）。以前の版で localStorage にだけ印がある人は、読み込み後に 1 度だけ
 * 消して Cookie へ移す。どちらも使えない環境では毎回出る（閉じるボタンはその表示の間だけ効く）。
 */
export function GettingStarted({
  profileLabel,
  steps,
  initiallyDismissed = false,
  className,
}: {
  profileLabel: string;
  steps: GettingStartedStep[];
  /** サーバーが Cookie から読んだ閉じた印 */
  initiallyDismissed?: boolean;
  className?: string;
}) {
  const viewerKey = useViewerKey();
  const key = LOCAL_KEYS.gettingStarted(viewerKey);
  const [dismissed, setDismissed] = React.useState(initiallyDismissed);

  React.useEffect(() => {
    if (initiallyDismissed) return;
    const inCookie = parseDismissedViewers(readCookie(GETTING_STARTED_DISMISSED_COOKIE)).includes(
      viewerKey,
    );
    const inLocal = readLocal(key, (raw) => (raw === true ? true : null)) === true;
    if (inCookie || inLocal) {
      if (!inCookie) rememberDismissedInCookie(viewerKey);
      setDismissed(true);
    }
  }, [initiallyDismissed, key, viewerKey]);

  if (dismissed || steps.length === 0) return null;

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
          rememberDismissedInCookie(viewerKey);
          setDismissed(true);
        }}
      />
    </section>
  );
}
