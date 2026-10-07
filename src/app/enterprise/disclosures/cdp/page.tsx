import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Download,
  FlaskConical,
  ListChecks,
  Minus,
  ShieldCheck,
  TriangleAlert,
  Sparkles,
  Upload,
} from 'lucide-react';
import { AiGeneratedBadge, PriorityBadge, ResponseStatusBadge } from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { DisclosureSteps, type DisclosureStep } from '@/components/shared/disclosure-steps';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  filterDisclosureRows,
  loadDisclosureWorkspace,
  type DisclosureQuestionRow,
} from '@/lib/services/disclosure';
import { loadApplicability, type Applicability } from '@/lib/services/disclosure-applicability';
import { loadQuestionMapping } from '@/lib/services/ai-assist';
import { loadConsistencyCheck } from '@/lib/services/disclosure-check';
import { loadDisclosureOnboarding } from '@/lib/services/disclosure-onboarding';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { ItemChangeType } from '@/types/domain';
import {
  evaluateApplicabilityAction,
  runConsistencyCheckAction,
  runQuestionMappingAction,
} from '../../actions';

export const metadata = { title: 'CDP' };

const CHANGE_LABEL: Record<
  ItemChangeType,
  { label: string; tone: 'brand' | 'warning' | 'neutral' | 'danger' }
> = {
  new: { label: '新規', tone: 'warning' },
  changed: { label: '変更', tone: 'brand' },
  carry_forward: { label: '継続', tone: 'neutral' },
  retired: { label: '廃止', tone: 'danger' },
};

const ISSUE_KIND_LABEL: Record<string, string> = {
  missing_information: '不足情報',
  stale_content: '古い記述',
  period_mismatch: '年度不一致',
  contradiction: '回答間の矛盾',
  evidence_gap: 'Evidence 不足',
};

/** 適用判定（CDP-P0-002）。色だけで区別させないためアイコンとラベルを併記する。 */
const APPLICABILITY_LABEL: Record<
  Applicability,
  { label: string; tone: 'brand' | 'neutral' | 'warning'; Icon: typeof CircleCheck }
> = {
  applicable: { label: '適用', tone: 'brand', Icon: CircleCheck },
  not_applicable: { label: '非適用', tone: 'neutral', Icon: CircleSlash },
  needs_check: { label: '要確認', tone: 'warning', Icon: CircleHelp },
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

const BASE_PATH = '/enterprise/disclosures/cdp';

/** 増減（%）。色ではなく符号で向きを示す（良し悪しを色で決めない） */
function deltaOf(row: DisclosureQuestionRow): number | null {
  return row.currentValue !== null && row.previousValue !== null && row.previousValue !== 0
    ? ((row.currentValue - row.previousValue) / row.previousValue) * 100
    : null;
}

/**
 * CDP 開示対応（plan §2 S18）。
 *
 * - 見出しの操作は「適用判定を実行」（secondary）だけを出し、AI の実行・過去回答の取込・XLSX 出力は「その他」へ。
 *   出力は出力の権限があるときだけ（R3。権限の無い役割に押すと 403 になるリンクを見せない）
 * - 主操作は工程（DisclosureSteps）の現在の段の操作（過去回答を取り込む）
 * - 質問の表は DataTable。既定の列は 質問・適用・前年差分・状態・当年値。残りは「列」から出す
 */
export default async function CdpWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const workspace = await loadDisclosureWorkspace(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
  );
  if (!workspace) notFound();

  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');
  const canExport = can(shell.ctx, 'enterprise.export.run');

  // 整合チェック結果は ?check=<aiRunId> で読み直す（CDP-P0-006）
  const checkRunId = typeof params.check === 'string' ? params.check : null;
  // 質問マッピングの候補は ?mapping=<aiRunId> で読み直す（候補のまま。確定は人が行う）
  const mappingRunId = typeof params.mapping === 'string' ? params.mapping : null;
  const mapping = mappingRunId
    ? await loadQuestionMapping(shell.db, shell.ctx, mappingRunId)
    : null;
  const check = checkRunId ? await loadConsistencyCheck(shell.db, shell.ctx, checkRunId) : null;

  // 適用判定（CDP-P0-002）。未実行なら空の Map なので列は「未判定」になる
  const applicability = await loadApplicability(shell.db, shell.ctx, workspace.period.id);
  const applicabilityCounts = {
    applicable: 0,
    not_applicable: 0,
    needs_check: 0,
  };
  for (const result of applicability.values()) applicabilityCounts[result.applicability] += 1;
  const hasApplicability = applicability.size > 0;

  // 準備段階（版の選択 → 過去データの取込）の到達状況
  const onboarding = await loadDisclosureOnboarding(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    typeof params.version === 'string' ? params.version : null,
  );
  const selectedVersion = onboarding?.versions.find((v) => v.id === onboarding.selectedVersionId);
  const importedPeriods = (onboarding?.periods ?? []).filter((p) => p.responseCount > 0);
  const steps: DisclosureStep[] = [
    {
      title: 'バージョン（FY）を選ぶ',
      description: '回答する質問書の年度を決めます。年度が変わると質問の新規・変更が発生します。',
      state: selectedVersion ? 'done' : 'current',
      detail: selectedVersion ? (
        <span>
          {selectedVersion.label}（質問 {selectedVersion.itemCount} 件）
        </span>
      ) : undefined,
    },
    {
      title: '過去データを取り込む',
      description:
        '前年以前の回答を取り込むと、継続項目を引き継げます。複数年分をまとめて取り込めます。',
      state: onboarding?.hasPastData ? 'done' : 'current',
      detail:
        importedPeriods.length > 0 ? (
          <span>
            取込済み:{' '}
            {importedPeriods.map((p) => `${p.periodLabel}（${p.responseCount} 件）`).join(' ／ ')}
          </span>
        ) : (
          <span className="text-warning-ink">まだ過去回答がありません</span>
        ),
      // 工程の現在の段の操作がこの画面の主操作（DisclosureSteps が現在の段だけ primary で描く）
      action: canWrite
        ? { label: '過去回答を取り込む', href: '/enterprise/disclosures/cdp/import' }
        : undefined,
    },
    {
      title: '新規分・不足分に対応する',
      description: '取り込んだ内容と当年度の質問を突き合わせ、新規・変更・不足を埋めます。',
      state: onboarding?.hasPastData ? 'current' : 'todo',
      detail: (
        <span>
          新規 {workspace.summary.newItems} 件 ／ 未着手 {workspace.summary.notStarted} 件
        </span>
      ),
    },
  ];

  const onlyDiff = params.diff === '1';
  const rows = filterDisclosureRows(workspace.rows, {
    changeType: typeof params.change === 'string' ? params.change : undefined,
    status: typeof params.status === 'string' ? params.status : undefined,
    search: typeof params.q === 'string' ? params.q : undefined,
    onlyDiff,
  });
  const pageSize = parsePageSize(params.size);
  const lastPage = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageNo = Math.min(parsePage(params.page), lastPage);
  const pageRows = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);

  const filters: FilterGroup[] = [
    {
      key: 'change',
      label: '前年差分',
      multiple: false,
      options: [
        { value: 'new', label: '新規' },
        { value: 'changed', label: '変更' },
        { value: 'carry_forward', label: '継続' },
      ],
    },
    {
      key: 'status',
      label: '状態',
      multiple: false,
      options: [
        { value: 'not_started', label: '未着手' },
        { value: 'draft', label: '下書き' },
        { value: 'in_review', label: 'レビュー中' },
        { value: 'returned', label: '差戻し' },
        { value: 'approved', label: '承認済み' },
      ],
    },
  ];

  const columns: DataTableColumn<DisclosureQuestionRow>[] = [
    {
      key: 'question',
      header: '質問',
      importance: 'primary',
      lockVisible: true,
      cell: (row) => (
        <div className="max-w-col-xl">
          <Link
            href={`${BASE_PATH}/${row.item.id}`}
            className="font-medium text-brand-800 hover:underline"
          >
            {row.item.code}
          </Link>
          <div className="truncate text-small text-ink">{row.item.questionText}</div>
        </div>
      ),
    },
    {
      key: 'applicability',
      header: '適用',
      importance: 'secondary',
      cell: (row) => {
        const result = applicability.get(row.item.id);
        if (!result) {
          return <span className="text-caption text-ink-muted">未判定</span>;
        }
        const a = APPLICABILITY_LABEL[result.applicability];
        return (
          <span title={result.reason} className="inline-flex">
            <Badge tone={a.tone}>
              <a.Icon className="size-3" aria-hidden="true" />
              {a.label}
            </Badge>
          </span>
        );
      },
    },
    {
      key: 'change',
      header: '前年差分',
      importance: 'primary',
      cell: (row) => {
        const change = CHANGE_LABEL[row.item.changeType];
        return <Badge tone={change.tone}>{change.label}</Badge>;
      },
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <ResponseStatusBadge status={row.response?.status ?? 'not_started'} />,
    },
    {
      key: 'current',
      header: '当年値',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="tnum">{formatNumber(row.currentValue)}</span>,
    },
    {
      key: 'section',
      header: 'セクション',
      importance: 'detail',
      cell: (row) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">{row.item.section}</span>
      ),
    },
    {
      key: 'priority',
      header: '優先度',
      importance: 'detail',
      cell: (row) => <PriorityBadge priority={row.priority} />,
    },
    {
      key: 'mapped',
      header: 'マッピング指標',
      importance: 'detail',
      cell: (row) => (
        <span className="text-caption">
          {row.mappedMetrics.length === 0 ? '—' : row.mappedMetrics.map((m) => m.name).join(' / ')}
        </span>
      ),
    },
    {
      key: 'previous',
      header: '前年値',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{formatNumber(row.previousValue)}</span>,
    },
    {
      key: 'delta',
      header: '増減',
      importance: 'detail',
      align: 'right',
      cell: (row) => {
        const delta = deltaOf(row);
        return (
          <span className="tnum">
            {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="CDP 開示対応"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {workspace.versionLabel} ／ {workspace.period.label}
            </span>
            {workspace.isFixture && (
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                架空の縮小マスター（正式質問書ではありません）
              </Badge>
            )}
          </span>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                kind: 'submit',
                id: 'evaluate-applicability',
                label: '適用判定を実行',
                icon: <ListChecks aria-hidden="true" />,
                action: evaluateApplicabilityAction,
                fields: { framework: 'cdp' },
                pendingLabel: '判定中…',
                hidden: !canWrite,
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'import',
                label: '過去回答の取込',
                icon: <Upload aria-hidden="true" />,
                href: '/enterprise/disclosures/cdp/import',
                hidden: !canWrite,
              },
              {
                kind: 'link',
                id: 'export-xlsx',
                group: 'export',
                label: 'XLSX で出力',
                icon: <Download aria-hidden="true" />,
                // 期間を渡さないと常に collecting 期間が出力され、画面の選択と食い違う
                href: `/api/exports/cdp?period=${workspace.period.id}&format=xlsx`,
                download: true,
                hidden: !canExport,
              },
              {
                kind: 'submit',
                id: 'question-mapping',
                group: 'advanced',
                label: '質問マッピングを実行（AI）',
                icon: <Sparkles aria-hidden="true" />,
                action: runQuestionMappingAction,
                fields: { frameworkKey: 'cdp' },
                hidden: !canRunAi,
              },
              {
                kind: 'submit',
                id: 'consistency-check',
                group: 'advanced',
                label: '整合チェックを実行（AI）',
                icon: <ShieldCheck aria-hidden="true" />,
                action: runConsistencyCheckAction,
                fields: { framework: 'cdp' },
                hidden: !canRunAi,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <DisclosureSteps steps={steps} />

        {onboarding && onboarding.versions.length > 1 && (
          <nav
            aria-label="質問書の年度"
            className="flex flex-wrap items-center gap-2 border-b border-line pb-2"
          >
            <span className="text-small font-semibold text-ink">バージョン（FY）</span>
            {onboarding.versions.map((v) => (
              <Button
                key={v.id}
                size="xs"
                variant={v.id === onboarding.selectedVersionId ? 'quiet' : 'secondary'}
                asChild
              >
                <Link
                  href={`?version=${v.id}`}
                  aria-current={v.id === onboarding.selectedVersionId ? 'true' : undefined}
                >
                  {v.label}
                  <span className="ml-1 text-ink-muted">
                    {v.status === 'published' ? '（最新）' : '（過年度）'}
                  </span>
                </Link>
              </Button>
            ))}
            <span className="text-caption text-ink-muted">
              質問書の年度。過年度を選ぶと、その版の質問構成で確認できます。
            </span>
          </nav>
        )}

        <MetricStrip label="回答の進み具合">
          <MetricTile
            label="準備度"
            value={workspace.summary.readiness}
            unit="%"
            href="/enterprise/disclosures/cdp"
          />
          <MetricTile
            label="承認済み"
            value={workspace.summary.approved}
            denominator={workspace.summary.total}
            href="/enterprise/disclosures/cdp?status=approved"
          />
          <MetricTile
            label="下書き"
            value={workspace.summary.draft}
            unit="件"
            href="/enterprise/disclosures/cdp?status=draft"
          />
          <MetricTile
            label="未着手"
            value={workspace.summary.notStarted}
            unit="件"
            href="/enterprise/disclosures/cdp?status=not_started"
          />
          <MetricTile
            label="新規質問"
            value={workspace.summary.newItems}
            unit="件"
            href="/enterprise/disclosures/cdp?change=new"
          />
          <MetricTile
            label="変更質問"
            value={workspace.summary.changedItems}
            unit="件"
            href="/enterprise/disclosures/cdp?change=changed"
          />
        </MetricStrip>

        {hasApplicability && (
          <div className="flex flex-wrap items-center gap-2 rounded-t4d border border-line bg-surface px-3 py-1.5 text-small">
            <span className="text-ink-muted">適用判定:</span>
            {(['applicable', 'not_applicable', 'needs_check'] as const).map((key) => {
              const a = APPLICABILITY_LABEL[key];
              return (
                <span key={key} className="inline-flex items-center gap-1">
                  <Badge tone={a.tone}>
                    <a.Icon className="size-3" aria-hidden="true" />
                    {a.label}
                  </Badge>
                  <span className="text-ink">{applicabilityCounts[key]} 件</span>
                </span>
              );
            })}
            <span className="text-caption text-ink-muted">
              非適用の質問も一覧には残ります。判定根拠はバッジにカーソルを合わせると表示されます。
            </span>
          </div>
        )}

        {mapping && (
          <Section
            title={`質問マッピングの候補（${mapping.mappings.length} 件）`}
            actions={
              <span className="flex items-center gap-2">
                <AiGeneratedBadge provider={mapping.run.provider} />
                <span className="text-caption text-ink-muted">
                  候補です。実際の紐付けは質問ごとに確定してください
                </span>
              </span>
            }
          >
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>質問</TH>
                    <TH>指標コード</TH>
                    <TH>根拠</TH>
                    <TH align="right">確信度</TH>
                  </TR>
                </THead>
                <TBody>
                  {mapping.mappings.map((row) => (
                    <TR key={row.itemCode}>
                      <TD className="font-medium">{row.itemCode}</TD>
                      <TD>{row.metricCode ?? '—'}</TD>
                      <TD className="text-small text-ink-muted">{row.rationale}</TD>
                      <TD align="right">{Math.round(row.confidence * 100)}%</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Section>
        )}

        {check && (
          <Section
            title={`整合チェックの結果（${check.issues.length} 件の指摘）`}
            actions={
              <span className="flex items-center gap-2">
                <AiGeneratedBadge provider={check.run.provider} />
                <span className="text-caption text-ink-muted">
                  {formatJst(check.run.createdAt)} 実行
                </span>
                <Link
                  href="/enterprise/disclosures/cdp"
                  className="text-caption text-brand-800 underline"
                >
                  閉じる
                </Link>
              </span>
            }
          >
            {check.issues.length === 0 ? (
              <p className="pb-2 text-small text-ink-muted">
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
                      <TD className="whitespace-nowrap text-small">
                        {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                      </TD>
                      <TD className="font-mono text-caption">{issue.subject}</TD>
                      <TD className="text-small text-ink">{issue.detail}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <p className="border-t border-line py-1.5 text-caption text-ink-muted">
              AI は指摘のみを行います。回答の修正・承認は人が行ってください。
            </p>
          </Section>
        )}

        {onlyDiff && (
          <Notice tone="info">
            「前年差分だけ回答」モード: 継続（前年から変わらない）質問を非表示にしています。
            <Link href="/enterprise/disclosures/cdp" className="ml-2 underline">
              すべて表示
            </Link>
          </Notice>
        )}

        <Section title="質問" divider="none">
          <DataTable
            id="cdp-questions"
            caption="CDP の質問"
            columns={columns}
            rows={pageRows}
            getRowId={(row) => row.item.id}
            getRowLabel={(row) => row.item.code}
            getRowStatus={(row) => row.response?.status ?? 'not_started'}
            searchParams={params}
            basePath={BASE_PATH}
            filters={filters}
            search={{ placeholder: '質問コード・質問文で検索' }}
            savedViews={[
              {
                label: '前年差分だけ回答',
                query: 'diff=1',
                description: '新規・変更のあった質問だけを表示します',
              },
              { label: '未着手のみ', query: 'status=not_started' },
              { label: '承認済み', query: 'status=approved' },
            ]}
            userViews
            page={{ page: pageNo, pageSize, total: rows.length, sizes: DEFAULT_PAGE_SIZES }}
            empty={{
              noData: {
                title: onlyDiff ? '前年から変わった質問はありません' : 'この版の質問がありません',
                description: onlyDiff
                  ? '継続の質問も含めて表示すると、すべての質問を確認できます。'
                  : '質問書の版を選び直してください。質問マスターの登録は管理者が行います。',
                action: (
                  <Link
                    href="/enterprise/disclosures/cdp"
                    className="text-small text-brand-700 hover:underline"
                  >
                    すべての質問を表示する
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
