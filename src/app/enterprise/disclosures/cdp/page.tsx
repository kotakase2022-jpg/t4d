import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Check,
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
import { ActionButton } from '@/components/shared/action-button';
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
import { FRAMEWORK_DIFF_KIND_LABELS } from '@/lib/domain/framework-diff';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  filterDisclosureRows,
  isFrameworkAvailable,
  listResponseAssignees,
  loadDisclosureWorkspace,
  type DisclosureQuestionRow,
} from '@/lib/services/disclosure';
import { loadApplicability, type Applicability } from '@/lib/services/disclosure-applicability';
import { loadQuestionMapping } from '@/lib/services/ai-assist';
import { loadConsistencyCheck, loadLatestConsistencyIssues } from '@/lib/services/disclosure-check';
import { loadDisclosureOnboarding } from '@/lib/services/disclosure-onboarding';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { statusLabel } from '@/lib/ui/status/registry';
import type { ItemChangeType } from '@/types/domain';
import {
  evaluateApplicabilityAction,
  runConsistencyCheckAction,
  runQuestionMappingAction,
} from '../../actions';
import { confirmMappingCandidateAction } from './actions';
import { CdpBulkAssignBar } from './_components/bulk-assign-bar';
import { CdpNotContracted } from './_components/cdp-not-contracted';

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
const BULK_FORM_ID = 'cdp-bulk-assign';

/** 増減（%）。色ではなく符号で向きを示す（良し悪しを色で決めない） */
function deltaOf(row: DisclosureQuestionRow): number | null {
  return row.currentValue !== null && row.previousValue !== null && row.previousValue !== 0
    ? ((row.currentValue - row.previousValue) / row.previousValue) * 100
    : null;
}

/** 不足の内訳（色ではなく文で示す） */
function gapParts(row: DisclosureQuestionRow): string[] {
  return [
    ...(row.gaps.dataMissing > 0 ? [`データ不足 ${row.gaps.dataMissing}`] : []),
    ...(row.gaps.unmapped ? ['未対応付け'] : []),
    ...(row.gaps.aiMissing.length > 0 ? [`AI の不足情報 ${row.gaps.aiMissing.length}`] : []),
  ];
}

/**
 * CDP 開示対応（plan §2 S18）。
 *
 * - CDP は組織ごとに契約するオプション（トライアル対応 NF-38）。契約が無ければ理由だけを出す（404 にしない）
 * - 見出しの操作は「適用判定を実行」（secondary）だけを出し、AI の実行・過去回答の取込・出力は「その他」へ。
 *   出力は出力の権限があるときだけ（R3。権限の無い役割に押すと 403 になるリンクを見せない）
 * - 主操作は工程（DisclosureSteps）の現在の段の操作（過去回答を取り込む）
 * - 質問の表は DataTable。既定の列は 質問・適用・前年差分・状態・当年値・担当・不足。残りは「列」から出す
 * - 版の選択は一覧に効く（その版の質問構成で出す。C-09）。期間の版と違う版は確かめるための表示で、回答は始めない
 * - 担当の一括割当（C-01）・不足の列と保存ビュー（C-06）・AI の対応付けの候補の確定（不具合 B-3）
 */
export default async function CdpWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  if (!(await isFrameworkAvailable(shell.db, shell.ctx, 'cdp'))) {
    return <CdpNotContracted title="CDP 開示対応" />;
  }

  // 準備段階（版の選択 → 過去データの取込）の到達状況。版の選択（?version=）は一覧にも効かせる
  const onboarding = await loadDisclosureOnboarding(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    typeof params.version === 'string' ? params.version : null,
  );
  const workspace = await loadDisclosureWorkspace(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
    { versionId: onboarding?.selectedVersionId ?? null },
  );
  if (!workspace) notFound();

  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');
  const canExport = can(shell.ctx, 'enterprise.export.run');
  const isPeriodVersion = workspace.version.id === workspace.periodVersionId;
  const periodVersion = workspace.versions.find((v) => v.id === workspace.periodVersionId);

  // 整合チェック結果は ?check=<aiRunId> で読み直す（CDP-P0-006）
  const checkRunId = typeof params.check === 'string' ? params.check : null;
  // 質問マッピングの候補は ?mapping=<aiRunId> で読み直す（候補のまま。確定は人が行う）
  const mappingRunId = typeof params.mapping === 'string' ? params.mapping : null;
  const [mapping, check, latestIssues, assignees] = await Promise.all([
    mappingRunId ? loadQuestionMapping(shell.db, shell.ctx, mappingRunId) : null,
    checkRunId ? loadConsistencyCheck(shell.db, shell.ctx, checkRunId) : null,
    loadLatestConsistencyIssues(shell.db, shell.ctx, workspace),
    listResponseAssignees(shell.db, shell.ctx),
  ]);
  const nameOf = (id: string | null | undefined) =>
    id ? (assignees.nameById.get(id) ?? '—') : null;

  // 適用判定（CDP-P0-002）。未実行なら空の Map なので列は「未判定」になる
  const applicability = await loadApplicability(shell.db, shell.ctx, workspace.period.id);
  const applicabilityCounts = {
    applicable: 0,
    not_applicable: 0,
    needs_check: 0,
  };
  for (const result of applicability.values()) applicabilityCounts[result.applicability] += 1;
  const hasApplicability = applicability.size > 0;

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
          新規 {workspace.summary.newItems} 件 ／ 未着手 {workspace.summary.notStarted} 件 ／
          不足あり {workspace.summary.withGaps} 件
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
    owner: typeof params.owner === 'string' ? params.owner : undefined,
    currentUserId: shell.ctx.userId,
    gap: typeof params.gap === 'string' ? params.gap : undefined,
  });
  const pageSize = parsePageSize(params.size);
  const lastPage = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageNo = Math.min(parsePage(params.page), lastPage);
  const pageRows = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);

  // 出力は画面と同じ期間・版で（期間を渡さないと常に collecting 期間が出力され、画面の選択と食い違う）
  const exportQuery = `period=${workspace.period.id}${
    isPeriodVersion ? '' : `&version=${workspace.version.id}`
  }`;
  const mappedCodes = new Set(
    workspace.rows.flatMap((r) => r.mappedMetrics.map((m) => `${r.item.code}|${m.code}`)),
  );

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
  const overflowFilters: FilterGroup[] = [
    {
      key: 'owner',
      label: '担当',
      multiple: false,
      options: [
        { value: 'me', label: '自分の担当' },
        { value: 'none', label: '作成担当なし' },
      ],
    },
    {
      key: 'gap',
      label: '不足',
      multiple: false,
      options: [{ value: '1', label: '不足あり' }],
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
      key: 'owner',
      header: '担当',
      importance: 'secondary',
      cell: (row) => {
        const owner = nameOf(row.response?.ownerUserId);
        return owner ? (
          <span className="whitespace-nowrap text-small text-ink">{owner}</span>
        ) : (
          <span className="text-caption text-ink-muted">未割当</span>
        );
      },
    },
    {
      key: 'gaps',
      header: '不足',
      importance: 'secondary',
      cell: (row) => {
        const parts = gapParts(row);
        if (parts.length === 0) return <span className="text-caption text-ink-muted">なし</span>;
        return (
          <div className="space-y-0.5" data-gap-total={row.gaps.total}>
            <Badge tone="warning">
              <TriangleAlert className="size-3" aria-hidden="true" />
              不足 {row.gaps.total}
            </Badge>
            <div className="text-caption text-ink-muted">{parts.join('・')}</div>
          </div>
        );
      },
    },
    {
      key: 'current',
      header: '当年値',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="tnum">{formatNumber(row.currentValue)}</span>,
    },
    {
      key: 'reviewer',
      header: 'レビュー担当',
      importance: 'detail',
      cell: (row) => (
        <span className="whitespace-nowrap text-small text-ink">
          {nameOf(row.response?.reviewerUserId) ?? '—'}
        </span>
      ),
    },
    {
      key: 'evidence',
      header: '根拠',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.evidenceCount} 件</span>,
    },
    {
      key: 'issues',
      header: '整合チェックの指摘',
      importance: 'detail',
      cell: (row) => {
        const issues = latestIssues?.byItemId.get(row.item.id) ?? [];
        return issues.length === 0 ? (
          <span className="text-caption text-ink-muted">—</span>
        ) : (
          <Badge tone="warning">
            <ShieldCheck className="size-3" aria-hidden="true" />
            指摘 {issues.length}
          </Badge>
        );
      },
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

  const diff = workspace.versionDiff;

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
                href: `/api/exports/cdp?${exportQuery}&format=xlsx`,
                download: true,
                hidden: !canExport,
              },
              {
                kind: 'link',
                id: 'export-xlsx-approved',
                group: 'export',
                label: '承認済みだけ XLSX で出力',
                icon: <Download aria-hidden="true" />,
                href: `/api/exports/cdp?${exportQuery}&format=xlsx&approvedOnly=1`,
                download: true,
                hidden: !canExport,
              },
              {
                kind: 'link',
                id: 'export-docx',
                group: 'export',
                label: 'DOCX（回答原稿）で出力',
                icon: <Download aria-hidden="true" />,
                href: `/api/exports/cdp?${exportQuery}&format=docx`,
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
        {/* 提供範囲（スライド 15 の「含まない」）は画面にも書く。閉じない */}
        <p className="text-caption text-ink-muted" data-cdp-scope="">
          CDP ポータルへの自動送信・API
          連携・スコアの保証は含みません。回答は出力して内容を確認のうえ転記してください。
        </p>

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

        {!isPeriodVersion && (
          <Notice tone="info" title="期間の質問書と違う版を表示しています">
            {workspace.versionLabel} の質問構成を表示しています。{workspace.period.label}{' '}
            の回答の対象は {periodVersion?.label ?? '期間の版'}{' '}
            です。この表示は版の確認用で、ここから回答は始められません。
            <Link href={BASE_PATH} className="ml-2 underline">
              {workspace.period.label} の質問書に戻る
            </Link>
          </Notice>
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
            label="不足あり"
            value={workspace.summary.withGaps}
            denominator={workspace.summary.total}
            href="/enterprise/disclosures/cdp?gap=1"
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

        {diff && workspace.previousVersion && (
          <Section
            id="cdp-version-diff"
            collapsible
            title={`前の版（${workspace.previousVersion.label}）との比較`}
            summary={`${FRAMEWORK_DIFF_KIND_LABELS.added} ${diff.added.length}・${FRAMEWORK_DIFF_KIND_LABELS.changed} ${diff.changed.length}・${FRAMEWORK_DIFF_KIND_LABELS.renumbered} ${diff.renumbered.length}・${FRAMEWORK_DIFF_KIND_LABELS.removed} ${diff.removed.length}・${FRAMEWORK_DIFF_KIND_LABELS.unchanged} ${diff.unchangedCount} 件`}
          >
            <p className="pb-1 text-caption text-ink-muted">
              版どうしの質問を比べた結果です（前の版の項番を手掛かりに改番も区別します）。表の「前年差分」は質問書の記載です。回答の引継ぎは自動では行いません。
            </p>
            {diff.entries.filter((e) => e.kind !== 'unchanged').length === 0 ? (
              <p className="pb-2 text-small text-ink-muted">前の版から変わった質問はありません。</p>
            ) : (
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>区分</TH>
                      <TH>前の版</TH>
                      <TH>この版</TH>
                      <TH>質問</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {diff.entries
                      .filter((e) => e.kind !== 'unchanged')
                      .map((entry) => (
                        <TR key={`${entry.fromItemId ?? ''}-${entry.toItemId ?? ''}`}>
                          <TD className="whitespace-nowrap text-small">
                            {FRAMEWORK_DIFF_KIND_LABELS[entry.kind]}
                          </TD>
                          <TD className="font-mono text-caption">{entry.fromCode ?? '—'}</TD>
                          <TD className="font-mono text-caption">{entry.toCode ?? '—'}</TD>
                          <TD className="text-small text-ink">{entry.title}</TD>
                        </TR>
                      ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Section>
        )}

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
                    <TH>確定</TH>
                  </TR>
                </THead>
                <TBody>
                  {mapping.mappings.map((row) => {
                    const confirmed = row.metricCode
                      ? mappedCodes.has(`${row.itemCode}|${row.metricCode}`)
                      : false;
                    return (
                      <TR key={row.itemCode}>
                        <TD className="font-medium">{row.itemCode}</TD>
                        <TD>{row.metricCode ?? '—'}</TD>
                        <TD className="text-small text-ink-muted">{row.rationale}</TD>
                        <TD align="right">{Math.round(row.confidence * 100)}%</TD>
                        <TD>
                          {!row.metricCode ? (
                            <span className="text-caption text-ink-muted">対応する指標なし</span>
                          ) : confirmed ? (
                            <Badge tone="success">
                              <Check className="size-3" aria-hidden="true" />
                              確定済み
                            </Badge>
                          ) : canWrite ? (
                            <ActionButton
                              size="xs"
                              action={{
                                kind: 'submit',
                                id: `confirm-mapping-${row.itemCode}`,
                                label: `${row.itemCode} の対応付けを確定`,
                                action: confirmMappingCandidateAction,
                                fields: {
                                  aiRunId: mapping.run.id,
                                  itemCode: row.itemCode,
                                  metricCode: row.metricCode,
                                },
                                pendingLabel: '確定中…',
                              }}
                            />
                          ) : (
                            <span className="text-caption text-ink-muted">
                              確定は開示の編集権限が必要です
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
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
            getRowStatus={(row) => statusLabel('response', row.response?.status ?? 'not_started')}
            searchParams={params}
            basePath={BASE_PATH}
            filters={filters}
            overflowFilters={overflowFilters}
            search={{ placeholder: '質問コード・質問文で検索' }}
            savedViews={[
              {
                label: '前年差分だけ回答',
                query: 'diff=1',
                description: '新規・変更のあった質問だけを表示します',
              },
              {
                label: '自分の担当',
                query: 'owner=me',
                description: '自分が作成担当かレビュー担当の質問',
              },
              {
                label: '不足あり',
                query: 'gap=1',
                description: 'データ不足・未対応付け・AI の不足情報のある質問',
              },
              { label: '未着手のみ', query: 'status=not_started' },
              { label: '承認済み', query: 'status=approved' },
            ]}
            userViews
            page={{ page: pageNo, pageSize, total: rows.length, sizes: DEFAULT_PAGE_SIZES }}
            selection={canWrite && isPeriodVersion ? { formId: BULK_FORM_ID } : undefined}
            bulkBar={
              canWrite && isPeriodVersion ? (
                <CdpBulkAssignBar
                  formId={BULK_FORM_ID}
                  periodId={workspace.period.id}
                  owners={assignees.owners}
                  reviewers={assignees.reviewers}
                />
              ) : undefined
            }
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
