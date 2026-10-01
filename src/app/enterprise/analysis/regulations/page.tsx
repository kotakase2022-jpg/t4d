import Link from 'next/link';
import { ArrowRight, Bot, Info, UserCheck } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { loadRegulatoryCoverage, type RegulationRow } from '@/lib/services/analysis/regulations';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SSBJ_COVERAGE_STATUSES } from '@/types/domain';
import { PositioningBadge } from '../_components/analysis-badges';

export const metadata = { title: '規制対応度' };

/**
 * 各規制への対応度（docs/disclosure-first.md §9.6）。閲覧専用。
 * 重み付きの割合・単一の総合点は出さず、件数と分母、人の確認と AI 判定のみを分けて示す。
 */

function InScopeCell({ row }: { row: RegulationRow }) {
  if (!row.inScope) return <span className="text-ink-muted">—</span>;
  return (
    <>
      <span className="tnum font-semibold">
        {row.inScope.count} / {row.inScope.denominator} 件
      </span>
      {row.inScope.provisional ? (
        <span className="block text-[11px] text-ink">
          うち暫定（DMA 確定前） {row.inScope.provisional} 件
        </span>
      ) : null}
      <span className="block text-[11px] text-ink-muted">分母: {row.inScope.denominatorLabel}</span>
    </>
  );
}

function BreakdownCell({ row }: { row: RegulationRow }) {
  if (!row.breakdown) {
    return <span className="text-[11px] text-ink-muted">{row.breakdownNote ?? '—'}</span>;
  }
  const { counts, humanConfirmed, aiOnly } = row.breakdown;
  return (
    <div className="space-y-1">
      <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
        {SSBJ_COVERAGE_STATUSES.map((status) => (
          <li key={status} className="whitespace-nowrap">
            {COVERAGE_LABEL[status]} <span className="tnum font-semibold">{counts[status]}</span> 件
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <UserCheck className="size-3" aria-hidden="true" />
          人が確認済み <span className="tnum font-semibold text-ink">{humanConfirmed}</span> 件
        </span>
        <span className="inline-flex items-center gap-1">
          <Bot className="size-3" aria-hidden="true" />
          AI 判定のみ（人が未確認） <span className="tnum font-semibold text-ink">{aiOnly}</span> 件
        </span>
      </p>
    </div>
  );
}

function ResponsesCell({ row }: { row: RegulationRow }) {
  if (!row.responses) {
    return <span className="text-[11px] text-ink-muted">{row.responsesNote ?? '—'}</span>;
  }
  return (
    <>
      <span className="tnum font-semibold">
        承認済み {row.responses.approved} / {row.responses.total} 件
      </span>
      <span className="block text-[11px] text-ink-muted">下書き・レビュー中は数えません</span>
    </>
  );
}

export default async function RegulationsPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const header = (
    <PageHeader
      title="規制対応度"
      description={`${shell.currentPeriod.label} ／ 基準ごとの位置付け・評価対象・対応状況の内訳（年度はヘッダーで切り替えます）`}
      breadcrumbs={[{ label: '企業ワークスペース' }, { label: '分析' }, { label: '規制対応度' }]}
    />
  );
  if (!can(ctx, 'enterprise.disclosure.read')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState description="規制対応度は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
        </div>
      </>
    );
  }

  const coverage = await loadRegulatoryCoverage(db, ctx, shell.currentPeriod);

  return (
    <>
      {header}
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface px-3 py-2 text-[12px] text-ink-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
          <div className="space-y-0.5">
            <p>
              基準をまたいだ単一の点数や、重み付きの割合は出しません。評価対象の件数と分母、対応状況の内訳（3
              観点のうち最も遅れている観点）を件数で示し、人が確認した件数と AI
              判定だけの件数を分けます。
            </p>
            <p>
              要求事項・評価項目を収録していない基準（ESRS-40a・MSCI・FTSE）は算定せず、理由を示します。CSRD
              の要求事項は架空のサンプル 12 項目です。
            </p>
          </div>
        </div>

        <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
          <Table className="min-w-[1180px]">
            <caption className="px-3 py-2 text-left text-[13px] font-semibold text-ink">
              各規制への対応度（{coverage.period.label}）
            </caption>
            <THead>
              <TR>
                {/* 1 列目（基準）は横スクロールしても見えるよう固定する */}
                <TH className="sticky left-0 z-[1] bg-surface">基準</TH>
                <TH>位置付け</TH>
                <TH>重要性の考え方</TH>
                <TH>収録状況</TH>
                <TH>評価対象</TH>
                <TH>状況の内訳（評価対象のうち）</TH>
                <TH>回答</TH>
                <TH>算定しない理由・注記</TH>
                <TH>直す画面</TH>
              </TR>
            </THead>
            <TBody>
              {coverage.rows.map((row) => (
                <TR key={row.key} className="align-top">
                  <th
                    scope="row"
                    className="sticky left-0 z-[1] bg-surface px-2 py-2 text-left align-top text-[12px]"
                  >
                    <span className="font-semibold text-ink">{row.name}</span>
                    {row.versionLabel && (
                      <span className="block text-[11px] font-normal text-ink-muted">
                        {row.versionLabel}
                      </span>
                    )}
                  </th>
                  <TD className="py-2 align-top text-[12px]">
                    <PositioningBadge kind={row.positioning.kind} label={row.positioning.label} />
                  </TD>
                  <TD className="py-2 align-top text-[12px]">{row.materialityLabel}</TD>
                  <TD className="py-2 align-top text-[12px]">
                    {row.coverage.label}
                    {row.coverage.itemCount !== null && (
                      <span className="block tnum">{row.coverage.itemCount} 件</span>
                    )}
                    {row.coverage.note && (
                      <span className="block max-w-[220px] text-[11px] text-ink-muted">
                        {row.coverage.note}
                      </span>
                    )}
                  </TD>
                  <TD className="py-2 align-top text-[12px]">
                    <InScopeCell row={row} />
                  </TD>
                  <TD className="max-w-[300px] py-2 align-top text-[12px]">
                    <BreakdownCell row={row} />
                  </TD>
                  <TD className="py-2 align-top text-[12px]">
                    <ResponsesCell row={row} />
                  </TD>
                  <TD className="max-w-[260px] py-2 align-top text-[12px]">
                    {row.notCalculatedReason && (
                      <p className="font-semibold text-ink">{row.notCalculatedReason}</p>
                    )}
                    {row.notes.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
                        {row.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                    {!row.notCalculatedReason && row.notes.length === 0 && (
                      <span className="text-ink-muted">—</span>
                    )}
                  </TD>
                  <TD className="py-2 align-top text-[12px]">
                    <ul className="space-y-0.5">
                      {row.links.map((link) => (
                        <li key={link.href}>
                          <Link
                            href={link.href}
                            className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                          >
                            {link.label}
                            <ArrowRight className="size-3" aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </div>
    </>
  );
}
