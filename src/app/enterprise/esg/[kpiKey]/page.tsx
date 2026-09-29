import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, FileText, History, MessageSquareWarning } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataPointStatusBadge } from '@/components/shared/badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  AVAILABILITY_STATUS_LABELS,
  NARRATIVE_STATUS_LABELS,
  NARRATIVE_THEME_LABELS,
  kpiTargetLabel,
} from '@/lib/domain/disclosure-status';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { isKpiKey, KPI_SPECS, loadKpiDetail } from '@/lib/services/kpi';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DataStateBadge, KpiCard, NeedsCheckBadge, targetText } from '../kpi-card';

export const metadata = { title: 'ESG 経営 KPI の詳細' };

/**
 * KPI の詳細（指示書 §6.11: 年次推移・組織別内訳・関連する定性情報・要因コメント・根拠）。
 * 月次の値は登録されていないため、年次だけを示す（推移をよく見せるための補完はしない）。
 */

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

const CONFIDENTIALITY_TEXT: Record<string, string> = {
  public: '公開',
  internal: '社内',
  confidential: '機密',
  restricted: '厳秘',
};

export default async function KpiDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ kpiKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { kpiKey } = await params;
  const query = await searchParams;
  if (!isKpiKey(kpiKey)) notFound();
  const shell = await loadEnterpriseShell();
  const detail = await loadKpiDetail(shell.db, shell.ctx, kpiKey, {
    periodId: one(query.period) ?? shell.currentPeriod.id,
  });
  const { card } = detail;
  const unit = card.metric?.unit ?? '';
  const spec = KPI_SPECS[kpiKey];

  return (
    <>
      <PageHeader
        title={`${spec.label} の詳細`}
        description={`${card.selectedPeriod.label} ／ 開示業務で承認した数値から計算しています`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'ESG 経営', href: `/enterprise/esg?period=${card.selectedPeriod.id}` },
          { label: spec.label },
        ]}
      />

      <div className="grid gap-3 p-4 xl:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-3">
          <KpiCard card={card} />
          <Card>
            <CardHeader>
              <CardTitle>指標の定義</CardTitle>
            </CardHeader>
            <p className="px-3 py-2 text-[12px] text-ink">{card.definition}</p>
          </Card>
        </div>

        <div className="space-y-3">
          {/* 年次推移 */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <History className="size-4 text-brand-600" aria-hidden="true" />
                年次の推移（承認済みの値）
              </CardTitle>
            </CardHeader>
            {detail.trend.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">
                この指標のデータはまだ登録されていません（0 としては扱いません）。
              </p>
            ) : (
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>年度</TH>
                      <TH align="right">全社値（承認済み）</TH>
                      <TH>状態</TH>
                      <TH>前年との連続性・遡及修正</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detail.trend.map((row) => (
                      <TR key={row.period.id} className="align-top">
                        <TD className="align-top">{row.period.code}</TD>
                        <TD align="right" className="align-top">
                          {!row.state.computable
                            ? '算定できません'
                            : row.state.approvedValue === null
                              ? '承認済みの値なし'
                              : `${formatNumber(row.state.approvedValue)} ${unit}`}
                          {!row.state.complete && row.state.approvedValue !== null && (
                            <span className="block text-[11px] text-ink-muted">承認済み分のみ</span>
                          )}
                        </TD>
                        <TD className="align-top">
                          <DataStateBadge
                            state={{
                              label: !row.state.computable
                                ? '全社値は算定できません'
                                : row.state.complete
                                  ? '確定'
                                  : '集計中',
                              tone:
                                !row.state.computable || !row.state.complete
                                  ? 'warning'
                                  : 'success',
                              details: [],
                            }}
                          />
                        </TD>
                        <TD className="align-top text-[12px]">
                          {row.discontinuityReasons.length > 0 && (
                            <div className="space-y-0.5">
                              <NeedsCheckBadge />
                              <ul className="list-disc pl-4 text-[11px] text-ink-muted">
                                {row.discontinuityReasons.map((reason) => (
                                  <li key={reason}>非連続: {reason}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {row.retroactiveNotes.length > 0 && (
                            <ul className="list-disc pl-4 text-[11px] text-ink-muted">
                              {row.retroactiveNotes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          )}
                          {row.discontinuityReasons.length === 0 &&
                            row.retroactiveNotes.length === 0 && (
                              <span className="text-ink-muted">—</span>
                            )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              月次の値は登録されていないため、年次だけを示します。未承認・未入力の年度を補完して線をつなぐことはしません。
            </p>
          </Card>

          {/* 組織別内訳 */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>組織別の内訳（{card.selectedPeriod.code}）</CardTitle>
            </CardHeader>
            {!card.current || card.current.contributions.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">この年度のデータはありません。</p>
            ) : (
              <div className="max-h-[70vh] overflow-auto">
                <Table>
                  <THead className="sticky top-0 z-10 bg-surface">
                    <TR>
                      <TH>組織・拠点</TH>
                      <TH>連結の扱い</TH>
                      <TH>境界</TH>
                      <TH>状態</TH>
                      <TH align="right">値</TH>
                      <TH>算定方法</TH>
                      <TH align="right">版</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {card.current.contributions.map((c) => (
                      <TR key={c.dataPointId}>
                        <TD>
                          <Link
                            href={`/enterprise/data/${c.dataPointId}`}
                            className="text-brand-700 hover:underline"
                          >
                            {c.unitName}
                          </Link>
                        </TD>
                        <TD className="text-[12px]">{c.consolidationLabel}</TD>
                        <TD className="text-[12px]">{c.boundary}</TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <DataPointStatusBadge status={c.status} />
                            {c.unapprovedCorrection && (
                              <Badge tone="warning">
                                <AlertTriangle className="size-3" aria-hidden="true" />
                                承認後の訂正（未承認）
                              </Badge>
                            )}
                          </div>
                        </TD>
                        <TD align="right">
                          {c.availabilityStatus === 'value_present' && c.value !== null
                            ? `${formatNumber(c.value)} ${c.unitOfMeasure}`
                            : AVAILABILITY_STATUS_LABELS[c.availabilityStatus]}
                        </TD>
                        <TD className="text-[12px]">{c.methodology ?? '—'}</TD>
                        <TD align="right">{c.versionNo ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>

          {/* 目標 */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>目標</CardTitle>
              <Link
                href="/enterprise/esg/targets"
                className="text-[12px] text-brand-700 hover:underline"
              >
                目標の登録・改訂
              </Link>
            </CardHeader>
            {detail.targets.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">目標は登録されていません。</p>
            ) : (
              <ul className="divide-y divide-line">
                {detail.targets.map((view) => (
                  <li key={view.target.targetKey} className="px-3 py-2 text-[12px]">
                    <p className="text-ink">{targetText(view, unit)}</p>
                    <p className="text-[11px] text-ink-muted">
                      {kpiTargetLabel({
                        metricName: detail.card.metric?.name ?? null,
                        targetYear: view.target.targetYear,
                        direction: view.target.direction,
                      })}
                      ・版 {view.target.versionNo}（全 {view.versionCount} 版）
                      {view.ownerName ? `・責任者 ${view.ownerName}` : ''}
                    </p>
                    {!view.comparable && (
                      <div className="mt-0.5 space-y-0.5">
                        <NeedsCheckBadge />
                        <ul className="list-disc pl-4 text-[11px] text-ink-muted">
                          {view.comparabilityReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 関連する定性情報 */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>関連する定性情報（リスク・機会／対応策）</CardTitle>
            </CardHeader>
            {detail.narratives.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">関連する定性情報はありません。</p>
            ) : (
              <ul className="divide-y divide-line">
                {detail.narratives.map((record) => (
                  <li
                    key={record.id}
                    className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]"
                  >
                    <Link
                      href={`/enterprise/narratives/${record.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {record.title}
                    </Link>
                    <span className="text-[11px] text-ink-muted">
                      {NARRATIVE_THEME_LABELS[record.theme]}・
                      {NARRATIVE_STATUS_LABELS[record.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 要因コメント */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <MessageSquareWarning className="size-4 text-brand-600" aria-hidden="true" />
                要因コメント（{card.selectedPeriod.code}）
              </CardTitle>
            </CardHeader>
            {detail.factorComments.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">
                担当者の要因コメント・訂正の理由はありません。
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {detail.factorComments.map((comment, index) => (
                  <li key={index} className="px-3 py-2 text-[12px]">
                    <p className="text-ink">{comment.body}</p>
                    <p className="text-[11px] text-ink-muted">
                      {comment.unitName}・{formatJst(comment.at)}
                      {comment.authorName ? `・${comment.authorName}` : ''}
                      {comment.source === 'version' ? '（値の訂正の記録）' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              数値の相関から原因を断定する表示はしません。要因は担当者のコメントと訂正の記録だけを示します。
            </p>
          </Card>

          {/* 根拠 */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <FileText className="size-4 text-brand-600" aria-hidden="true" />
                根拠（{card.selectedPeriod.code} のデータに紐付く資料）
              </CardTitle>
            </CardHeader>
            {detail.evidence.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-muted">紐付いた資料はありません。</p>
            ) : (
              <ul className="divide-y divide-line">
                {detail.evidence.map((item, index) => (
                  <li key={index} className="px-3 py-2 text-[12px]">
                    <p className="text-ink">{item.fileName}</p>
                    <p className="text-[11px] text-ink-muted">
                      {item.unitName}
                      {item.locator ? `・${item.locator}` : ''}・機密区分{' '}
                      {CONFIDENTIALITY_TEXT[item.confidentiality] ?? item.confidentiality}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
