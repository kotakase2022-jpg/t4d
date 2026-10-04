import Link from 'next/link';
import { countText, funnelWidths } from '@/lib/charts/breakdown';
import { cn } from '@/lib/utils';

/**
 * 件数が絞られていく流れ（例: 収録 → 適用 → 評価対象。docs/disclosure-first.md §10.4）。
 * 件数は文字で必ず書き、帯は最も多い段を 100% とした相対幅（aria-hidden。文字と同じ内容）。
 */

export interface FunnelStep {
  /** 段の名前（画面の既存の文言そのまま） */
  label: string;
  count: number;
  /** 件数の単位（既定「件」） */
  unit?: string;
  href?: string;
}

export function FunnelSteps({
  label,
  steps,
  className,
}: {
  /** 流れのリストの名前（getByRole('list', { name: label })） */
  label: string;
  steps: readonly FunnelStep[];
  className?: string;
}) {
  const widths = funnelWidths(steps.map((step) => step.count));
  return (
    <ol aria-label={label} className={cn('space-y-1', className)}>
      {steps.map((step, index) => (
        <li
          key={`${step.label}-${index}`}
          className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-2 text-[12px]"
        >
          <span className="truncate text-ink" title={step.label}>
            {step.href ? (
              <Link href={step.href} className="text-brand-700 hover:underline">
                {step.label}
              </Link>
            ) : (
              step.label
            )}
          </span>
          <span aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-line">
            <span
              className="block h-full rounded-full bg-brand-600"
              style={{ width: `${widths[index] ?? 0}%` }}
            />
          </span>
          <span className="tnum text-right font-medium text-ink">
            {countText(step.count, step.unit)}
          </span>
        </li>
      ))}
    </ol>
  );
}
