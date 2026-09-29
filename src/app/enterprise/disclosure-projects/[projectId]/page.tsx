import Link from 'next/link';
import { LinkPending } from '@/components/shared/link-pending';
import { notFound } from 'next/navigation';
import { CalendarRange, Info } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { DISCLOSURE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { formatJstDate } from '@/lib/format/datetime';
import { getProject, type ProjectDetail } from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import { ProjectStatusBadge } from '../_components/framework-badges';
import { ManuscriptsTab } from './_tabs/manuscripts';
import { OutputsTab } from './_tabs/outputs';
import { OverviewTab } from './_tabs/overview';
import { RequirementsTab } from './_tabs/requirements';
import { ReviewsTab } from './_tabs/reviews';
import { SettingsTab } from './_tabs/settings';

export const metadata = { title: '開示プロジェクト' };

const TABS = [
  { key: 'overview', label: '概要' },
  { key: 'requirements', label: '要求事項' },
  { key: 'manuscripts', label: '原稿' },
  { key: 'reviews', label: 'レビュー・承認' },
  { key: 'outputs', label: '出力' },
  { key: 'settings', label: '設定' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isTabKey(value: unknown): value is TabKey {
  return typeof value === 'string' && TABS.some((t) => t.key === value);
}

/**
 * 開示プロジェクトの詳細（§6.3 のタブ: 概要／要求事項／原稿／レビュー・承認／出力／設定）。
 * タブは ?tab= で持ち、共有・戻る操作で同じ画面に戻れるようにする。
 * 見出しに企業・プロジェクト・報告期間（開始日〜終了日）・対象範囲を出す（§4.2）。
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

  let detail: ProjectDetail;
  try {
    detail = await getProject(shell.db, shell.ctx, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader
            title="開示プロジェクト"
            breadcrumbs={[
              { label: '企業ワークスペース' },
              { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
            ]}
          />
          <PermissionDeniedState description="開示プロジェクトを見るには、開示の閲覧権限が必要です。" />
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

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
          { label: project.name },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{shell.ctx.workspace.organizationName}</span>
            <span className="flex items-center gap-1">
              <CalendarRange className="size-3.5" aria-hidden="true" />
              報告期間 {detail.period?.code ?? '—'}（{formatJstDate(project.periodStart)}〜
              {formatJstDate(project.periodEnd)}）
            </span>
            <span className="max-w-[520px] truncate" title={scopeSummary}>
              対象範囲: {scopeSummary}
            </span>
            <span>{project.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・')}</span>
            <ProjectStatusBadge status={project.status} />
          </span>
        }
      />

      {isOtherPeriod && (
        <p className="flex items-center gap-1.5 border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-[12px] text-ink">
          <Info className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
          このプロジェクトの報告期間は {detail.period?.code} です（画面上部で選択中の期間{' '}
          {shell.currentPeriod.code}
          とは別の年度を表示しています）。
        </p>
      )}

      <nav aria-label="プロジェクトのタブ" className="border-b border-line bg-surface px-4">
        <ul className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={t.key === 'overview' ? base : `${base}?tab=${t.key}`}
                aria-current={tab === t.key ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-3 py-2 text-[13px]',
                  tab === t.key
                    ? 'border-brand-700 font-semibold text-brand-900'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t.label}
                <LinkPending />
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {tab === 'overview' && <OverviewTab projectId={project.id} searchParams={query} />}
        {tab === 'requirements' && <RequirementsTab projectId={project.id} searchParams={query} />}
        {tab === 'manuscripts' && <ManuscriptsTab projectId={project.id} searchParams={query} />}
        {tab === 'reviews' && <ReviewsTab projectId={project.id} searchParams={query} />}
        {tab === 'outputs' && <OutputsTab projectId={project.id} searchParams={query} />}
        {tab === 'settings' && <SettingsTab projectId={project.id} searchParams={query} />}
      </div>
    </>
  );
}
