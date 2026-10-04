import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { aggregationNoteOf, formatTrendValue } from '@/lib/domain/metric-trend';
import type { MetricTrendRow, TrendYearDetail } from '@/lib/services/analysis/trends';

/**
 * 指標の「内訳」の中身（docs/disclosure-first.md §10.2 画面 5）。
 * 定義と集計方法、年度ごとの承認の状況（承認済み n/N と未承認の拠点）、参考値（途中集計・推計込み。
 * どちらも比較に使わないと書く）、比較できない理由、全社値を算定できない指標の拠点値、行き先のリンク。
 * 既定で閉じた Collapsible の中に置く（閉じたままでも表の値・前年比・状態は読める）。
 */

function YearBlock({ year, unit }: { year: TrendYearDetail; unit: string }) {
  const { cell } = year;
  const counted = cell.kind !== 'not_entered' && cell.expectedCount > 0;
  return (
    <li className="space-y-0.5">
      <p>
        <span className="font-semibold text-ink">{year.period.code}</span>: {year.stateLabel}
        {counted && (
          <span className="tnum text-ink-muted">
            （承認済み {cell.approvedCount}/{cell.expectedCount} 拠点）
          </span>
        )}
      </p>
      {year.details.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
          {year.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
      {year.partialValue !== null && (
        <p className="text-ink-muted">
          承認済み分のみの途中集計（比較に使いません）:{' '}
          <span className="tnum">
            {formatTrendValue(year.partialValue, unit)} {unit}
          </span>
        </p>
      )}
      {year.referenceWithEstimates !== null && (
        <p className="text-ink-muted">
          参考: 推計込み{' '}
          <span className="tnum">
            {formatTrendValue(year.referenceWithEstimates, unit)} {unit}
          </span>
          （比較に使いません）
        </p>
      )}
      {(year.validation.errors > 0 || year.validation.warnings > 0) && (
        <p className="text-ink-muted">
          未解決の検証結果: エラー {year.validation.errors} 件・警告 {year.validation.warnings} 件
        </p>
      )}
      {year.unitValues.length > 0 && (
        <ul aria-label={`${year.period.code} の拠点の値`} className="space-y-0.5 pl-1">
          {year.unitValues.map((u, index) => (
            <li key={`${u.unitName}-${index}`} className="text-ink-muted">
              {u.unitName}:{' '}
              <span className="tnum text-ink">
                {u.value === null
                  ? '値なし'
                  : `${formatTrendValue(u.value, u.unitOfMeasure)} ${u.unitOfMeasure}`}
              </span>
              （{u.statusLabel}・{u.consolidationLabel}）
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 前年比を出さなかった理由・遡及修正の注記（列ごと） */
function ChangeNotes({ row }: { row: MetricTrendRow }) {
  const items = row.changes.flatMap((change, index) => {
    const label = row.changeLabels[index] ?? '';
    if (change.kind === 'needs_check') {
      return change.reasons.map((reason) => ({ key: `${label}-${reason}`, label, text: reason }));
    }
    if (change.kind === 'unavailable') {
      return [{ key: `${label}-unavailable`, label, text: change.reason }];
    }
    return change.notes.map((note) => ({ key: `${label}-${note}`, label, text: note }));
  });
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="font-semibold text-ink">前年比を出さなかった理由・注記</p>
      <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
        {items.map((item) => (
          <li key={item.key}>
            <span className="text-ink">{item.label}</span>: {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TrendDetail({ row }: { row: MetricTrendRow }) {
  const { metric } = row;
  return (
    <div className="max-w-[320px] space-y-2 whitespace-normal font-normal">
      <dl className="space-y-0.5">
        <div>
          <dt className="inline font-semibold text-ink">定義: </dt>
          <dd className="inline text-ink-muted">
            {metric.description || '（指標マスターに説明がありません）'}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">集計方法: </dt>
          <dd className="inline text-ink-muted">{aggregationNoteOf(metric)}</dd>
        </div>
      </dl>

      <div className="space-y-0.5">
        <p className="font-semibold text-ink">年度ごとの状況</p>
        <ul className="space-y-1.5">
          {row.years.map((year) => (
            <YearBlock key={year.period.id} year={year} unit={metric.unit} />
          ))}
        </ul>
      </div>

      <ChangeNotes row={row} />

      {row.links.length > 0 && (
        <ul aria-label={`${metric.name} の関連画面`} className="space-y-0.5">
          {row.links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                {link.label}
                <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
