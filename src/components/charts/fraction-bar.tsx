import { fractionText, fractionWidthPercent, wholePercent } from '@/lib/charts/breakdown';
import { cn } from '@/lib/utils';

/**
 * 分母付きの 1 本の帯（docs/disclosure-first.md §10.4）。「n / N 件」を独立した要素で必ず書き、
 * 帯は補助（role="img"・aria-label「label: n / N 件」）。分母 0 は帯の代わりに「対象なし」と書く（0% と書かない）。
 * % は既定で出さない（showPercent で「（n%）」を添える）。色は中立（良し悪しを示さない）。
 */
export function FractionBar({
  label,
  numerator,
  denominator,
  unit = '件',
  showPercent = false,
  format,
  className,
}: {
  /** 何の割合か（例「承認済み」）。帯の名前にも使う */
  label: string;
  numerator: number;
  denominator: number;
  /** 件数の単位（既定「件」。例「拠点」「項目」） */
  unit?: string;
  showPercent?: boolean;
  /** 分子・分母の書式（既定は素の数。量を出すときは桁区切りを渡す）。見える文字と帯の名前の両方に使う */
  format?: (n: number) => string;
  className?: string;
}) {
  const fraction = fractionText(numerator, denominator, unit, format);
  const percent = wholePercent(numerator, denominator);
  const width = fractionWidthPercent(numerator, denominator);
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-small">
        <span className="text-ink">{label}</span>
        <span className="flex items-baseline gap-1">
          <span className="tnum font-medium text-ink">{fraction}</span>
          {showPercent && percent !== null && (
            <span className="tnum text-caption text-ink-muted">（{percent}%）</span>
          )}
        </span>
      </div>
      {denominator > 0 ? (
        <div
          role="img"
          aria-label={`${label}: ${fraction}`}
          className="h-2 w-full overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-brand-700" style={{ width: `${width}%` }} />
        </div>
      ) : (
        <p className="text-caption text-ink-muted">対象なし</p>
      )}
    </div>
  );
}
