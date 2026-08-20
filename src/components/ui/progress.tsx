import { cn } from '@/lib/utils';

export function Progress({
  value,
  className,
  tone = 'brand',
  label,
}: {
  value: number;
  className?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const bar =
    tone === 'success'
      ? 'bg-success'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'danger'
          ? 'bg-danger'
          : 'bg-brand-600';
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? '進捗'}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', bar)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
