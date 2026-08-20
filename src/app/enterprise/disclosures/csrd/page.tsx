import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FlaskConical,
  Minus,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { AiGeneratedBadge, ResponseStatusBadge } from '@/components/shared/badges';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { loadConsistencyCheck } from '@/lib/services/disclosure-check';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { runConsistencyCheckAction } from '../../actions';

export const metadata = { title: 'CSRD' };

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

/**
 * CSRD ワークスペース（機能追加要望 ②）。
 *
 * 当社は CSRD 初年度対応のため、CDP のような前年差分ではなく
 * 「ESRS 項目 × 保有データ」のギャップ分析を主とする。
 * 回答作成・AI ドラフト・承認は CDP と同じ質問詳細（共有ビュー）で行う。
 */
export default async function CsrdWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const workspace = await loadDisclosureWorkspace(
    shell.db,
    shell.ctx,
    'csrd',
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
  );
  if (!workspace) notFound();

  const checkRunId = typeof params.check === 'string' ? params.check : null;
  const check = checkRunId ? await loadConsistencyCheck(shell.db, shell.ctx, checkRunId) : null;

  const rows = workspace.rows;
  const answered = rows.filter(
    (r) => r.response && r.response.status !== 'not_started' && r.response.answerText,
  ).length;
  const withData = rows.filter((r) => r.currentValue !== null).length;
  const mapped = rows.filter((r) => r.mappedMetrics.length > 0).length;
  const requiredTotal = rows.filter((r) => r.item.required).length;
  const requiredReady = rows.filter(
    (r) => r.item.required && (r.currentValue !== null || r.response?.answerText),
  ).length;

  return (
    <>
      <PageHeader
        title="CSRD 開示対応（ESRS）"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {workspace.versionLabel} ／ {workspace.period.label} ／ 初年度対応
            </span>
            {workspace.isFixture && (
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                架空の縮小マスター（正式な ESRS 全量ではありません）
              </Badge>
            )}
          </span>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'CSRD' }]}
        actions={
          can(shell.ctx, 'enterprise.ai.run') ? (
            <form action={runConsistencyCheckAction}>
              <input type="hidden" name="framework" value="csrd" />
              <Button type="submit" variant="secondary" size="sm">
                <ShieldCheck aria-hidden="true" />
                整合チェックを実行
              </Button>
            </form>
          ) : undefined
        }
      />

      <div className="space-y-3 p-4">
        <ul className="grid grid-cols-4 gap-2">
          <li>
            <KpiCard
              href="/enterprise/disclosures/csrd"
              label="ESRS 項目"
              value={rows.length}
              suffix="件"
              tone="brand"
            />
          </li>
          <li>
            <KpiCard
              href="/enterprise/disclosures/csrd"
              label="必須項目の準備度"
              value={requiredTotal === 0 ? 0 : Math.round((requiredReady / requiredTotal) * 100)}
              suffix="%"
              tone={requiredReady === requiredTotal ? 'success' : 'warning'}
            />
          </li>
          <li>
            <KpiCard
              href="/enterprise/data?status=approved"
              label="データあり（承認済み）"
              value={withData}
              suffix={`/ ${mapped} マッピング済み`}
              tone={withData === mapped ? 'success' : 'warning'}
            />
          </li>
          <li>
            <KpiCard
              href="/enterprise/disclosures/csrd"
              label="回答済み"
              value={answered}
              suffix={`/ ${rows.length}`}
              tone={answered > 0 ? 'brand' : 'neutral'}
            />
          </li>
        </ul>

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
                  <Link
                    href="/enterprise/disclosures/csrd"
                    className="text-[11px] text-brand-800 underline"
                  >
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
              <Table>
                <THead>
                  <TR>
                    <TH>重要度</TH>
                    <TH>種別</TH>
                    <TH>対象</TH>
                    <TH>指摘</TH>
                  </TR>
                </THead>
                <TBody>
                  {check.issues.map((issue, i) => (
                    <TR key={`${issue.subject}-${i}`}>
                      <TD>
                        <Badge tone={SEVERITY_TONE[issue.severity]}>
                          {(() => {
                            const Icon = SEVERITY_ICON[issue.severity] ?? Minus;
                            return <Icon className="size-3" aria-hidden="true" />;
                          })()}
                          {SEVERITY_LABEL[issue.severity]}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-[12px]">
                        {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                      </TD>
                      <TD className="font-mono text-[11px]">{issue.subject}</TD>
                      <TD className="text-[12px] text-ink">{issue.detail}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              AI は指摘のみを行います。回答の修正・承認は人が行ってください。
            </p>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle title={`ギャップ分析（${rows.length} 項目）`} />
          {rows.length === 0 ? (
            <EmptyState title="ESRS 項目マスターが登録されていません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>セクション</TH>
                    <TH>開示項目</TH>
                    <TH>必須</TH>
                    <TH>データ</TH>
                    <TH>マッピング指標</TH>
                    <TH align="right">当年値</TH>
                    <TH>回答状況</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.item.id}>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                        {row.item.section}
                      </TD>
                      <TD className="max-w-[420px]">
                        <Link
                          href={`/enterprise/disclosures/csrd/${row.item.id}`}
                          className="font-mono text-[12px] font-medium text-brand-800 hover:underline"
                        >
                          {row.item.code}
                        </Link>
                        <div className="truncate text-[12px] text-ink">{row.item.questionText}</div>
                      </TD>
                      <TD>{row.item.required ? <Badge tone="brand">必須</Badge> : '—'}</TD>
                      <TD>
                        {row.mappedMetrics.length === 0 ? (
                          <span className="text-[11px] text-ink-muted">記述式</span>
                        ) : row.currentValue !== null ? (
                          <Badge tone="success">
                            <CircleCheck className="size-3" aria-hidden="true" />
                            データあり
                          </Badge>
                        ) : (
                          <Badge tone="warning">
                            <CircleDashed className="size-3" aria-hidden="true" />
                            承認済みデータなし
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-[12px]">
                        {row.mappedMetrics.map((m) => m.name).join('、') || '—'}
                      </TD>
                      <TD align="right" className="tnum">
                        {formatNumber(row.currentValue)}
                      </TD>
                      <TD>
                        <ResponseStatusBadge status={row.response?.status ?? 'not_started'} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
