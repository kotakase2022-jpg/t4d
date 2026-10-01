import Link from 'next/link';
import {
  CircleAlert,
  ClipboardList,
  Database,
  FileText,
  ListChecks,
  Minus,
  Scale,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  AiGeneratedBadge,
  DataCoverageBadge,
  ResponseStatusBadge,
} from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { SsbjFlow } from '@/components/shared/ssbj-flow';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadCsrdOverview } from '@/lib/services/csrd/requirements';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { loadConsistencyCheck } from '@/lib/services/disclosure-check';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { runConsistencyCheckAction } from '../../actions';
import { ApplicabilityBadge, SampleMasterBadge } from './_components/csrd-badges';
import { ApplicabilityCard, CoverageCountsCard, DmaSummaryCard } from './_overview/overview-cards';
import { csrdFlowSteps, workspaceSummary } from './_overview/overview-model';
import { CSRD_OPEN_HIGH_PRIORITY_QUERY } from './requirements/form-input';

export const metadata = { title: 'CSRD 対応状況' };

const ISSUE_KIND_LABEL: Record<string, string> = {
  missing_information: '不足情報',
  stale_content: '古い記述',
  period_mismatch: '年度不一致',
  contradiction: '回答間の矛盾',
  evidence_gap: 'Evidence 不足',
};
/** 指摘の重要度。色だけに頼らず、ラベルとアイコンを併記する。 */
const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};
const SEVERITY_ICON: Record<string, typeof CircleAlert> = {
  high: CircleAlert,
  medium: TriangleAlert,
  low: Minus,
};

const BASE = '/enterprise/disclosures/csrd';

/**
 * CSRD 対応状況（docs/disclosure-first.md §9.4）。SSBJ と同じ工程（①設定 ②要求事項の評価 ③対応計画
 * ④データ収集 ⑤開示ドラフト）で進める。CSRD はダブル・マテリアリティで、要求事項の適用は
 * 設定の DMA（人の判断）から導出する。
 *
 * 以前の画面で使われていたもの（初年度対応の表示・整合チェック・ESRS 項目 × 保有データの
 * ギャップ分析表・回答の状況）はそのまま残す。表はギャップ分析表 1 つだけで、
 * 要求事項コードから要求事項の詳細（適用の根拠・3 観点・計画・回答への導線）へ進む。
 */
export default async function CsrdOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const breadcrumbs = [{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'CSRD' }];

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 開示対応（ESRS）" breadcrumbs={breadcrumbs} />
        <PermissionDeniedState description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
      </>
    );
  }

  const [overview, workspace] = await Promise.all([
    loadCsrdOverview(db, ctx, shell.currentPeriod),
    loadDisclosureWorkspace(db, ctx, 'csrd', shell.currentPeriod, shell.periods, shell.metrics),
  ]);

  if (!overview || !workspace) {
    return (
      <>
        <PageHeader title="CSRD 開示対応（ESRS）" breadcrumbs={breadcrumbs} />
        <div className="p-4">
          <EmptyState title="ESRS 項目マスターが登録されていません" />
        </div>
      </>
    );
  }

  const checkRunId = typeof params.check === 'string' ? params.check : null;
  const check = checkRunId ? await loadConsistencyCheck(db, ctx, checkRunId) : null;

  const rows = workspace.rows;
  const summary = workspaceSummary(rows);
  const viewByItem = new Map(overview.views.map((v) => [v.item.id, v]));

  return (
    <>
      <PageHeader
        title="CSRD 開示対応（ESRS）"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {overview.versionLabel} ／ {shell.currentPeriod.label} ／ 初年度対応
            </span>
            {overview.isFixture && (
              <>
                <SampleMasterBadge />
                <span className="text-[11px]">
                  架空の縮小マスター（正式な ESRS 全量ではありません）
                </span>
              </>
            )}
            <Badge tone="brand">
              <Scale className="size-3" aria-hidden="true" />
              ダブル・マテリアリティ
            </Badge>
          </span>
        }
        breadcrumbs={breadcrumbs}
        actions={
          <div className="flex items-center gap-1.5">
            <Button size="sm" asChild>
              <Link href={`${BASE}/requirements`}>
                <ListChecks aria-hidden="true" />
                要求事項の評価
              </Link>
            </Button>
            {can(ctx, 'enterprise.ai.run') && (
              <form action={runConsistencyCheckAction}>
                <input type="hidden" name="framework" value="csrd" />
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  icon={<ShieldCheck aria-hidden="true" />}
                  pendingLabel="実行中…"
                >
                  整合チェックを実行
                </SubmitButton>
              </form>
            )}
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} />

        <SsbjFlow steps={csrdFlowSteps(overview)} />

        <ul className="grid grid-cols-6 gap-2">
          <li>
            <KpiCard
              href={`${BASE}/requirements?applicability=always&applicability=material`}
              label="評価対象"
              value={overview.applicabilityCounts.inScope}
              suffix={`/ ${overview.applicabilityCounts.total} 件`}
              tone="brand"
              hint="常に適用・重要と判断"
            />
          </li>
          <li>
            <KpiCard
              href={`${BASE}/requirements?review=awaiting`}
              label="確認待ち"
              value={overview.awaitingReview}
              suffix="件"
              tone={overview.awaitingReview > 0 ? 'warning' : 'neutral'}
              hint="AI の候補を担当者が未確認"
            />
          </li>
          <li>
            <KpiCard
              href={`${BASE}/requirements?${CSRD_OPEN_HIGH_PRIORITY_QUERY}`}
              label="優先度「高」"
              value={overview.highPriority}
              suffix="件"
              tone={overview.highPriority > 0 ? 'danger' : 'neutral'}
              hint="評価対象・未対応"
            />
          </li>
          <li>
            <KpiCard
              href={`${BASE}/requirements`}
              label="必須項目の準備"
              value={summary.requiredReady}
              suffix={`/ ${summary.requiredTotal} 件`}
              tone={summary.requiredReady === summary.requiredTotal ? 'success' : 'warning'}
              hint="データが揃う・回答本文あり"
            />
          </li>
          <li>
            <KpiCard
              href="/enterprise/data?status=approved"
              label="データあり（承認済み）"
              value={summary.withData}
              suffix={`/ ${summary.mapped} 件`}
              tone={summary.withData === summary.mapped ? 'success' : 'warning'}
              hint={`指標の対応あり ${summary.mapped} 件${summary.partialData > 0 ? `（一部のみ ${summary.partialData}）` : ''}`}
            />
          </li>
          <li>
            <KpiCard
              href={`${BASE}/requirements`}
              label="回答済み"
              value={summary.answered}
              suffix={`/ ${summary.total} 件`}
              tone={summary.answered > 0 ? 'brand' : 'neutral'}
              hint="回答（版・承認）"
            />
          </li>
        </ul>

        <div className="grid grid-cols-[1.25fr_1fr] gap-3">
          <DmaSummaryCard dma={overview.dma} />
          <ApplicabilityCard counts={overview.applicabilityCounts} />
        </div>

        <CoverageCountsCard
          counts={overview.coverageCounts}
          inScope={overview.applicabilityCounts.inScope}
        />

        {check && (
          <Card className="overflow-hidden">
            <SectionTitle
              title={`整合チェックの結果（${check.issues.length} 件の指摘）`}
              action={
                <span className="flex items-center gap-2">
                  <AiGeneratedBadge provider={check.run.provider} />
                  <span className="text-[11px] text-ink-muted">
                    {formatJst(check.run.createdAt)} 実行
                  </span>
                  <Link href={BASE} className="text-[11px] text-brand-800 underline">
                    閉じる
                  </Link>
                </span>
              }
            />
            {check.issues.length === 0 ? (
              <p className="px-3 pb-3 text-[12px] text-ink-muted">
                不足・陳腐化・矛盾は検出されませんでした。
              </p>
            ) : (
              <Table aria-label="整合チェックの指摘">
                <THead>
                  <TR>
                    <TH>重要度</TH>
                    <TH>種別</TH>
                    <TH>対象</TH>
                    <TH>指摘</TH>
                  </TR>
                </THead>
                <TBody>
                  {check.issues.map((issue, i) => {
                    const Icon = SEVERITY_ICON[issue.severity] ?? Minus;
                    return (
                      <TR key={`${issue.subject}-${i}`}>
                        <TD>
                          <Badge tone={SEVERITY_TONE[issue.severity]}>
                            <Icon className="size-3" aria-hidden="true" />
                            {SEVERITY_LABEL[issue.severity]}
                          </Badge>
                        </TD>
                        <TD className="whitespace-nowrap text-[12px]">
                          {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                        </TD>
                        <TD className="font-mono text-[11px]">{issue.subject}</TD>
                        <TD className="text-[12px] text-ink">{issue.detail}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              AI は指摘のみを行います。回答の修正・承認は人が行ってください。
            </p>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle
            title={`ギャップ分析（${rows.length} 項目）`}
            action={
              <span className="text-[11px] text-ink-muted">
                コードを選ぶと要求事項の詳細（適用の根拠・3 観点・回答への導線）を開きます
              </span>
            }
          />
          {rows.length === 0 ? (
            <EmptyState title="ESRS 項目マスターが登録されていません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label="ESRS 要求事項とデータの対応" className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>セクション</TH>
                    <TH>開示項目</TH>
                    <TH>適用</TH>
                    <TH>必須</TH>
                    <TH>データ</TH>
                    <TH>マッピング指標</TH>
                    <TH align="right">当年値</TH>
                    <TH>回答状況</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const view = viewByItem.get(row.item.id);
                    return (
                      <TR key={row.item.id}>
                        <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                          {row.item.section}
                        </TD>
                        <TD className="max-w-[360px]">
                          <Link
                            href={`${BASE}/requirements/${row.item.id}`}
                            className="font-mono text-[12px] font-medium text-brand-800 hover:underline"
                          >
                            {row.item.code}
                          </Link>
                          <div className="truncate text-[12px] text-ink">
                            {row.item.questionText}
                          </div>
                        </TD>
                        <TD>
                          {view ? (
                            <ApplicabilityBadge applicability={view.applicability} />
                          ) : (
                            <span className="text-[11px] text-ink-muted">—</span>
                          )}
                        </TD>
                        <TD>{row.item.required ? <Badge tone="brand">必須</Badge> : '—'}</TD>
                        <TD>
                          {row.dataCoverage === 'not_mapped' ? (
                            <span className="text-[11px] text-ink-muted">記述式</span>
                          ) : (
                            <DataCoverageBadge
                              coverage={row.dataCoverage}
                              missingNames={row.missingMetrics.map((m) => m.name)}
                              noneLabel="承認済みデータなし"
                            />
                          )}
                        </TD>
                        <TD className="text-[12px]">
                          {row.mappedMetrics.map((m) => m.name).join('、') || '—'}
                        </TD>
                        <TD align="right" className="tnum">
                          {row.metricValues.length > 1 ? (
                            // 異なる指標は足さず、指標ごとに並べる（Scope2 の 2 方式も別々）
                            <ul className="space-y-0.5 text-[11px]">
                              {row.metricValues.map((v) => (
                                <li key={v.metric.id} className="whitespace-nowrap">
                                  <span className="text-ink-muted">{v.metric.name}: </span>
                                  {v.currentValue === null ? (
                                    <span className="text-[#8a5d00]">値なし</span>
                                  ) : (
                                    formatNumber(v.currentValue)
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            formatNumber(row.currentValue)
                          )}
                        </TD>
                        <TD>
                          <ResponseStatusBadge status={row.response?.status ?? 'not_started'} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`${BASE}/plans`}>
              <ClipboardList aria-hidden="true" />
              対応計画を管理する
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`${BASE}/collection`}>
              <Database aria-hidden="true" />
              データ収集を管理する
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`${BASE}/draft`}>
              <FileText aria-hidden="true" />
              開示ドラフト
            </Link>
          </Button>
        </div>
      </div>
    </>
  );
}
