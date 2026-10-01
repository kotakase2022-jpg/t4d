import Link from 'next/link';
import { ArrowRight, Clock, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  DIAGNOSIS_STATE_LABEL,
  type DiagnosisArea,
  type DiagnosisFact,
} from '@/lib/services/analysis/diagnosis';
import { DiagnosisStateBadge } from './analysis-badges';

/**
 * 現状診断の 1 領域（docs/disclosure-first.md §9.6）。
 * 事実は「n / 分母 単位」で示し、割合・点数にしない。各事実と領域に直す画面へのリンクを置く。
 */

function factValue(f: DiagnosisFact): string {
  if (f.count === null) return f.text ?? '—';
  return f.denominator === null
    ? `${f.count} ${f.unitLabel}`
    : `${f.count} / ${f.denominator} ${f.unitLabel}`;
}

function AttentionBadge({ attention }: { attention: DiagnosisFact['attention'] }) {
  if (attention === 'gap') {
    return (
      <Badge tone="warning">
        <TriangleAlert className="size-3" aria-hidden="true" />
        要対応
      </Badge>
    );
  }
  if (attention === 'pending') {
    return (
      <Badge tone="brand">
        <Clock className="size-3" aria-hidden="true" />
        確認待ち
      </Badge>
    );
  }
  return null;
}

function FactList({ facts }: { facts: DiagnosisFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
      {facts.map((f) => (
        <div key={f.key} className="min-w-0 rounded-t4d border border-line px-2.5 py-1.5">
          <dt className="text-[11px] text-ink-muted">
            {f.href ? (
              <Link href={f.href} className="text-brand-700 hover:underline">
                {f.label}
              </Link>
            ) : (
              f.label
            )}
          </dt>
          <dd className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="tnum text-[15px] font-semibold text-ink">{factValue(f)}</span>
            <AttentionBadge attention={f.attention} />
          </dd>
          {f.denominatorLabel && f.count !== null && (
            <dd className="text-[11px] text-ink-muted">分母: {f.denominatorLabel}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

const nameList = (names: string[]) => (names.length === 0 ? '—' : names.join('、'));

export function DiagnosisAreaSection({ area }: { area: DiagnosisArea }) {
  const headingId = `diagnosis-${area.key}`;
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2.5 rounded-t4d-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-[14px] font-semibold text-ink">
          {area.title}
        </h2>
        <DiagnosisStateBadge state={area.state} label={area.stateLabel} />
      </div>
      <p className="text-[12px] text-ink">{area.stateReason}</p>
      <p className="text-[11px] text-ink-muted">出所: {area.source}</p>

      <FactList facts={area.facts} />

      {area.units && area.units.length > 0 && (
        <div className="t4d-scroll-x">
          <Table>
            <caption className="px-2 pb-1 text-left text-[12px] font-medium text-ink">
              拠点別の承認状況（サプライヤーを除く）
            </caption>
            <THead>
              <TR>
                <TH>拠点</TH>
                <TH align="right">承認済み / 総数</TH>
                <TH align="right">未提出</TH>
                <TH align="right">レビュー待ち</TH>
                <TH align="right">検証エラー</TH>
              </TR>
            </THead>
            <TBody>
              {area.units.map((row) => (
                <TR key={row.unitId}>
                  <th scope="row" className="px-2 text-left text-[12px] font-medium">
                    <Link href={row.href} className="text-brand-700 hover:underline">
                      {row.unitName}
                    </Link>
                  </th>
                  <TD align="right" className="text-[12px]">
                    {row.total === 0 ? '項目なし' : `${row.approved} / ${row.total} 件`}
                  </TD>
                  <TD align="right" className="text-[12px]">
                    {row.notSubmitted} 件
                  </TD>
                  <TD align="right" className="text-[12px]">
                    {row.reviewPending} 件
                  </TD>
                  <TD align="right" className="text-[12px]">
                    {row.validationErrors} 件
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {area.ghg && (
        <div className="space-y-1.5">
          <div className="t4d-scroll-x">
            <Table>
              <caption className="px-2 pb-1 text-left text-[12px] font-medium text-ink">
                Scope1・Scope2 の承認済み拠点（連結対象の拠点が分母）
              </caption>
              <THead>
                <TR>
                  <TH>区分</TH>
                  <TH align="right">承認済み / 対象</TH>
                  <TH>レビュー待ち</TH>
                  <TH>未提出</TH>
                  <TH>未入力</TH>
                  <TH>実績なし（推計・目標値のみ等）</TH>
                </TR>
              </THead>
              <TBody>
                {area.ghg.map((row) => (
                  <TR key={row.code}>
                    <th scope="row" className="px-2 text-left text-[12px] font-medium">
                      <Link href={row.href} className="text-brand-700 hover:underline">
                        {row.label}
                      </Link>
                    </th>
                    <TD align="right" className="text-[12px]">
                      {row.registered
                        ? `${row.approvedUnits} / ${row.expectedUnits} 拠点`
                        : '指標が未登録'}
                    </TD>
                    <TD className="text-[12px]">{nameList(row.reviewUnits)}</TD>
                    <TD className="text-[12px]">{nameList(row.unsubmittedUnits)}</TD>
                    <TD className="text-[12px]">{nameList(row.missingUnits)}</TD>
                    <TD className="text-[12px]">{nameList(row.noActualUnits)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {area.excludedUnitNames && area.excludedUnitNames.length > 0 && (
            <p className="text-[11px] text-ink-muted">
              持分法・連結対象外の拠点は分母に含めません: {area.excludedUnitNames.join('、')}
            </p>
          )}
          {area.scope3 && (
            <p className="text-[12px] text-ink">
              Scope3: 値あり {area.scope3.presentCount}・対象外と判断{' '}
              {area.scope3.notApplicableCount}・未登録または未算定 {area.scope3.pendingCount}（
              {area.scope3.categoryTotal} カテゴリ中）
              {area.scope3.pendingLabels.length > 0 && (
                <span className="text-ink-muted">
                  {' '}
                  未登録・未算定: {area.scope3.pendingLabels.join('、')}
                </span>
              )}
              。合計は
              {area.scope3.totalValue === null
                ? '未算定です（Cat.1 だけを Scope3 全量として扱いません）。'
                : '登録値があります（カテゴリの合計とは照合のみ行い、足し合わせません）。'}
            </p>
          )}
        </div>
      )}

      {area.frameworks && (
        <ul className="space-y-1.5">
          {area.frameworks.map((f) => (
            <li
              key={f.key}
              className="flex flex-wrap items-start gap-2 rounded-t4d border border-line px-2.5 py-1.5 text-[12px]"
            >
              <span className="min-w-[96px] font-medium text-ink">{f.name}</span>
              <DiagnosisStateBadge state={f.state} label={DIAGNOSIS_STATE_LABEL[f.state]} />
              <span className="min-w-0 flex-1 text-ink">{f.line}</span>
            </li>
          ))}
        </ul>
      )}

      <nav aria-label={`${area.title}を直す画面`} className="flex flex-wrap gap-x-3 gap-y-1">
        {area.links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
          >
            {link.label}
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </section>
  );
}
