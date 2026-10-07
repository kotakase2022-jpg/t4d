import Link from 'next/link';
import {
  ArrowRight,
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
import { AttentionStrip, type AttentionItem } from '@/components/shared/attention-strip';
import { AiGeneratedBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SsbjFlow, currentStepIndex } from '@/components/shared/ssbj-flow';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { loadCsrdOverview } from '@/lib/services/csrd/requirements';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { loadConsistencyCheck } from '@/lib/services/disclosure-check';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import { runConsistencyCheckAction } from '../../actions';
import { SampleMasterBadge } from './_components/csrd-badges';
import { ApplicabilityCard, CoverageCountsCard, DmaSummaryCard } from './_overview/overview-cards';
import { csrdFlowSteps, nextStepAction, workspaceSummary } from './_overview/overview-model';
import {
  CSRD_OPEN_HIGH_PRIORITY_QUERY,
  CSRD_REQUIREMENT_DATA_COLS,
} from './requirements/form-input';

export const metadata = { title: 'CSRD 対応状況' };

const ISSUE_KIND_LABEL: Record<string, string> = {
  missing_information: '不足情報',
  stale_content: '古い記述',
  period_mismatch: '年度不一致',
  contradiction: '回答間の矛盾',
  evidence_gap: '根拠資料の不足',
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
const REQUIREMENTS = `${BASE}/requirements`;
const CHECK_ID = 'csrd-consistency-check';

/**
 * CSRD 対応状況（docs/disclosure-first.md §9.4・plan E24）。SSBJ と同じ工程（①設定 ②要求事項の評価
 * ③対応計画 ④データ収集 ⑤開示ドラフト）で進める。CSRD はダブル・マテリアリティで、要求事項の適用は
 * 設定の DMA（人の判断）から導出する。
 *
 * 並び（plan §1.14）: Attention（放置すると問題になる事実。0 件は出さない）→ 工程（主操作は今の段の
 * 次の作業 1 つ）→ Status（分母付きの件数・DMA の要約・適用・3 観点）→ 整合チェックの結果。
 * 以前のギャップ分析表は要求事項の評価と同じ母集団の 2 つ目の表だったため、要求事項の一覧へ寄せ
 * （データの揃い具合・当年値・回答状況は一覧の「列」で出す）、ここでは件数付きの絞り込みリンクにした（plan T8）。
 *
 * 文字量を減らす（§10.4）: 画面の使い方は「この画面について」（既定で閉じる）、件数は内訳の図。
 * 架空の縮小マスター・DMA 未確定・暫定の注記と、分母付きの「評価対象 n / N 件」は常に見せる。
 */
export default async function CsrdOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 開示対応（ESRS）" autoBreadcrumbs />
        <PermissionDeniedState
          description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。"
          permission="enterprise.disclosure.read"
        />
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
        <PageHeader title="CSRD 開示対応（ESRS）" autoBreadcrumbs />
        <div className="p-4">
          <EmptyState
            kind="not-applicable"
            title="ESRS 項目マスターが登録されていません"
            description="CSRD の要求事項マスター（架空の縮小サンプル）が登録されると、工程と件数がここに並びます。マスターの登録は管理者が行います。"
          />
        </div>
      </>
    );
  }

  const checkRunId = typeof params.check === 'string' ? params.check : null;
  const check = checkRunId ? await loadConsistencyCheck(db, ctx, checkRunId) : null;

  const summary = workspaceSummary(workspace.rows);
  const steps = csrdFlowSteps(overview);
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const next = nextStepAction(steps, currentStepIndex(steps));

  // 主操作は「今の工程の次の作業」1 つ（編集できる人だけ。閲覧だけの人には主操作を置かない）
  const primary: ActionSpec | undefined = canWrite
    ? {
        kind: 'link',
        id: 'next-step',
        label: next.label,
        href: next.href,
        icon: <ArrowRight aria-hidden="true" />,
      }
    : undefined;
  const secondary: ActionSpec[] = [
    {
      kind: 'link',
      id: 'requirements',
      label: '要求事項の評価',
      href: REQUIREMENTS,
      icon: <ListChecks aria-hidden="true" />,
      // 主操作が要求事項の評価へ移るときは同じ行き先を 2 つ並べない
      hidden: primary?.kind === 'link' && primary.href === REQUIREMENTS,
    },
    {
      kind: 'submit',
      id: 'consistency-check',
      label: '整合チェックを実行',
      action: runConsistencyCheckAction,
      fields: { framework: 'csrd' },
      pendingLabel: '実行中…',
      icon: <ShieldCheck aria-hidden="true" />,
      hidden: !can(ctx, 'enterprise.ai.run'),
    },
  ];
  // 各工程の画面へは工程の帯からも開ける。以前の画面下部のボタンは「その他」に残す
  const more: MenuActionSpec[] = [
    {
      kind: 'link',
      id: 'plans',
      label: '対応計画を管理する',
      href: `${BASE}/plans`,
      icon: <ClipboardList aria-hidden="true" />,
    },
    {
      kind: 'link',
      id: 'collection',
      label: 'データ収集を管理する',
      href: `${BASE}/collection`,
      icon: <Database aria-hidden="true" />,
    },
    {
      kind: 'link',
      id: 'draft',
      label: '開示ドラフト',
      href: `${BASE}/draft`,
      icon: <FileText aria-hidden="true" />,
    },
  ];

  const attention: AttentionItem[] = [
    {
      key: 'check',
      label: '整合チェックの指摘',
      count: check?.issues.length ?? 0,
      href: `#${CHECK_ID}`,
      semantic: 'error',
    },
    {
      key: 'awaiting',
      label: 'AI の候補を担当者が未確認',
      count: overview.awaitingReview,
      href: `${REQUIREMENTS}?review=awaiting`,
      semantic: 'pending',
    },
    {
      key: 'high',
      label: '優先度「高」で未対応',
      count: overview.highPriority,
      href: `${REQUIREMENTS}?${CSRD_OPEN_HIGH_PRIORITY_QUERY}`,
      semantic: 'blocked',
    },
    {
      key: 'unassessed',
      label: '人の判断が未評価の事項',
      count: overview.dma.outcomeCounts.not_assessed,
      href: `${BASE}/settings`,
      semantic: 'todo',
    },
    {
      // DMA が未確定の間、テーマ別の要求事項の適用は暫定（確定すると外れる）
      key: 'provisional',
      label: 'DMA 未確定のため暫定の適用',
      count: overview.dma.confirmed ? 0 : overview.applicabilityCounts.provisional,
      href: `${BASE}/settings?step=dma`,
      semantic: 'blocked',
    },
  ];

  const dataView = (filter: string) =>
    `${REQUIREMENTS}?${filter}&cols=${encodeURIComponent(CSRD_REQUIREMENT_DATA_COLS)}`;

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
                <span className="text-caption">
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
        help={
          <>
            <p>
              SSBJ と同じ工程（①設定 → ②要求事項の評価 → ③対応計画 → ④データ収集 →
              ⑤開示ドラフト）で進めます。要求事項の適用は、設定のダブル・マテリアリティ評価（人の判断）から決まります。
            </p>
            <p>
              要求事項ごとのデータの揃い具合・当年値・回答状況は、要求事項の評価の一覧（「列」で表示）で確認できます。件数を選ぶと、その条件で絞った一覧を開きます。件数は分母と並べ、重み付きの対応度は出しません。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={<PageActions primary={primary} secondary={secondary} more={more} />}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} />

        <AttentionStrip items={attention} label="要対応" />

        <SsbjFlow steps={steps} />

        {/* 件数は分母と並べる。押すとその条件で絞った要求事項の一覧へ（ギャップ分析表の代わり） */}
        <MetricStrip label="要求事項の件数">
          <MetricTile
            label="評価対象"
            value={overview.applicabilityCounts.inScope}
            denominator={overview.applicabilityCounts.total}
            unit="件"
            hint="常に適用・重要と判断"
            href={`${REQUIREMENTS}?applicability=always&applicability=material`}
          />
          <MetricTile
            label="必須項目の準備"
            value={summary.requiredReady}
            denominator={summary.requiredTotal}
            unit="件"
            hint="データが揃う・回答本文あり"
            status={
              summary.requiredReady === summary.requiredTotal
                ? { semantic: 'done', label: 'すべて準備済み' }
                : { semantic: 'pending', label: '未準備あり' }
            }
            href={dataView('required=1')}
          />
          <MetricTile
            label="データあり（承認済み）"
            value={summary.withData}
            denominator={summary.mapped}
            unit="件"
            hint={`指標の対応あり ${summary.mapped} 件${summary.partialData > 0 ? `（一部のみ ${summary.partialData}）` : ''}`}
            status={
              summary.withData === summary.mapped
                ? { semantic: 'done', label: 'すべてデータあり' }
                : { semantic: 'pending', label: '不足あり' }
            }
            href={dataView('data=full')}
          />
          <MetricTile
            label="回答済み"
            value={summary.answered}
            denominator={summary.total}
            unit="件"
            hint="回答（版・承認）"
            href={dataView('answer=answered')}
          />
        </MetricStrip>

        <div className="grid grid-cols-[1.25fr_1fr] gap-3">
          <DmaSummaryCard dma={overview.dma} />
          <ApplicabilityCard counts={overview.applicabilityCounts} />
        </div>

        <CoverageCountsCard
          counts={overview.coverageCounts}
          inScope={overview.applicabilityCounts.inScope}
        />

        <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
          <ListChecks className="size-3.5 text-ink-muted" aria-hidden="true" />
          要求事項ごとのデータの揃い具合・当年値・回答状況（{summary.total} 項目）は
          <Link
            href={`${REQUIREMENTS}?cols=${encodeURIComponent(CSRD_REQUIREMENT_DATA_COLS)}`}
            className="text-brand-700 underline"
          >
            要求事項の評価の一覧
          </Link>
          で確認できます。
        </p>

        {check && (
          <Section
            id={CHECK_ID}
            title={`整合チェックの結果（${check.issues.length} 件の指摘）`}
            actions={
              <span className="flex items-center gap-2">
                <AiGeneratedBadge provider={check.run.provider} />
                <span className="text-caption text-ink-muted">
                  {formatJst(check.run.createdAt)} 実行
                </span>
                <Link href={BASE} className="text-caption text-brand-800 underline">
                  閉じる
                </Link>
              </span>
            }
          >
            {check.issues.length === 0 ? (
              <EmptyState
                kind="done"
                size="compact"
                title="不足・陳腐化・矛盾は検出されませんでした。"
              />
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
                        <TD className="whitespace-nowrap text-small">
                          {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                        </TD>
                        <TD className="font-mono text-caption">{issue.subject}</TD>
                        <TD className="text-small text-ink">{issue.detail}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
            {/* AI は指摘だけ（修正・承認は人）であることは閉じずに見せる */}
            <p className="border-t border-line px-3 py-1.5 text-caption text-ink-muted">
              AI は指摘のみを行います。回答の修正・承認は人が行ってください。
            </p>
          </Section>
        )}
      </div>
    </>
  );
}
