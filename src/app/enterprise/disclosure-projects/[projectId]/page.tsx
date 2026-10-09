import { notFound } from 'next/navigation';
import { CalendarRange, Info } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { NavTabs, type NavTabItem } from '@/components/shared/nav-tabs';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { DISCLOSURE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { formatJstDate } from '@/lib/format/datetime';
import { listProjectBlocks } from '@/lib/services/disclosure-block';
import { getProject, type ProjectDetail } from '@/lib/services/disclosure-project';
import { listProjectReviews } from '@/lib/services/disclosure-review';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { ProjectStatusBadge } from '../_components/framework-badges';
import { CrosswalkTab } from './_tabs/crosswalk';
import { ManuscriptsTab } from './_tabs/manuscripts';
import { OutputsTab } from './_tabs/outputs';
import { OverviewTab } from './_tabs/overview';
import { RequirementsTab } from './_tabs/requirements';
import { ReviewsTab } from './_tabs/reviews';
import { SettingsTab } from './_tabs/settings';
import { XbrlTab } from './_tabs/xbrl';

export const metadata = { title: '開示プロジェクト' };

/**
 * タブのキー・URL（?tab=）・ラベルは変えない（E2E・共有 URL のため。plan S1）。設定は右端（L3）。
 * トライアル対応（2026-10。K3）で「横断対応表」を要求事項の右、「XBRL」を出力の右に足した
 */
const TABS = [
  { key: 'overview', label: '概要' },
  { key: 'requirements', label: '要求事項' },
  { key: 'crosswalk', label: '横断対応表' },
  { key: 'manuscripts', label: '原稿' },
  { key: 'reviews', label: 'レビュー・承認' },
  { key: 'outputs', label: '出力' },
  { key: 'xbrl', label: 'XBRL' },
  { key: 'settings', label: '設定' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isTabKey(value: unknown): value is TabKey {
  return typeof value === 'string' && TABS.some((t) => t.key === value);
}

/** 原稿・レビューの「要対応」の件数（タブに文字で併記する）。読めないときは件数を出さない */
async function attentionCounts(
  shell: Awaited<ReturnType<typeof loadEnterpriseShell>>,
  detail: ProjectDetail,
): Promise<Partial<Record<TabKey, number>>> {
  const projectId = detail.project.id;
  const [manuscripts, reviews] = await Promise.all([
    listProjectBlocks(shell.db, shell.ctx, projectId).catch(() => null),
    listProjectReviews(shell.db, shell.ctx, projectId).catch(() => null),
  ]);
  return {
    // 差戻し・引用先の再確認・承認後の変更がある節（どれも本文の手直しが要る）
    manuscripts: manuscripts?.rows.filter(
      (row) =>
        row.status === 'returned' ||
        row.freshness === 'upstream_updated' ||
        row.freshness === 'evidence_invalid' ||
        row.changedAfterApproval,
    ).length,
    // 自分がレビュー・最終承認する段の依頼
    reviews: reviews?.filter((item) => item.myStage !== null).length,
    // 適用判断が未確定の基準（確定は設定タブで行う）
    settings: detail.frameworks.filter((f) => !f.confirmed).length,
  };
}

/**
 * 開示プロジェクトの詳細（§6.3 のタブ: 概要／要求事項／横断対応表／原稿／レビュー・承認／出力／XBRL／設定）。
 * タブは ?tab= で持ち、共有・戻る操作で同じ画面に戻れるようにする。
 * 見出しに企業・プロジェクト・報告期間（開始日〜終了日）・対象範囲を出す（§4.2）。
 * 主操作はタブごとに 1 つ（各タブの先頭）。タブには要対応の件数を文字で併記する（plan S1）。
 */
export default async function DisclosureProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  const breadcrumbsBase = [
    { label: 'ホーム', href: '/enterprise/dashboard' },
    { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
  ];

  let detail: ProjectDetail;
  try {
    detail = await getProject(shell.db, shell.ctx, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="開示プロジェクト" breadcrumbs={breadcrumbsBase} />
          <PermissionDeniedState
            description="開示プロジェクトを見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }

  const project = detail.project;
  const tab: TabKey = isTabKey(query.tab) ? query.tab : 'overview';
  const base = `/enterprise/disclosure-projects/${project.id}`;
  const isOtherPeriod = detail.period !== null && detail.period.id !== shell.currentPeriod.id;
  const scopeSummary = project.scopeOrgNote || '（対象組織の記載なし）';
  const counts = await attentionCounts(shell, detail);
  const tabs: NavTabItem[] = TABS.map((t) => {
    const count = counts[t.key];
    return {
      key: t.key,
      label: t.label,
      href: t.key === 'overview' ? base : `${base}?tab=${t.key}`,
      ...(count ? { count, attention: true } : {}),
    };
  });

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[...breadcrumbsBase, { label: project.name }]}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{shell.ctx.workspace.organizationName}</span>
            <span className="flex items-center gap-1">
              <CalendarRange className="size-3.5" aria-hidden="true" />
              報告期間 {detail.period?.code ?? '—'}（{formatJstDate(project.periodStart)}〜
              {formatJstDate(project.periodEnd)}）
            </span>
            {/* 全文は概要タブの「プロジェクトの前提」にある */}
            <span className="max-w-[520px] truncate">対象範囲: {scopeSummary}</span>
            <span>{project.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・')}</span>
            <ProjectStatusBadge status={project.status} />
          </span>
        }
      />

      {isOtherPeriod && (
        <p className="flex items-center gap-1.5 border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-small text-ink">
          <Info className="size-3.5 text-warning-ink" aria-hidden="true" />
          このプロジェクトの報告期間は {detail.period?.code} です（画面上部で選択中の期間{' '}
          {shell.currentPeriod.code}
          とは別の年度を表示しています）。
        </p>
      )}

      <NavTabs ariaLabel="プロジェクトのタブ" items={tabs} current={tab} />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {tab === 'overview' && <OverviewTab projectId={project.id} searchParams={query} />}
        {tab === 'requirements' && <RequirementsTab projectId={project.id} searchParams={query} />}
        {tab === 'crosswalk' && <CrosswalkTab projectId={project.id} searchParams={query} />}
        {tab === 'manuscripts' && <ManuscriptsTab projectId={project.id} searchParams={query} />}
        {tab === 'reviews' && <ReviewsTab projectId={project.id} searchParams={query} />}
        {tab === 'outputs' && <OutputsTab projectId={project.id} searchParams={query} />}
        {tab === 'xbrl' && <XbrlTab projectId={project.id} searchParams={query} />}
        {tab === 'settings' && <SettingsTab projectId={project.id} searchParams={query} />}
      </div>
    </>
  );
}
