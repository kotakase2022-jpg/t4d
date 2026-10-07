import { PageHeader } from '@/components/shared/page-header';
import { formatJstDate } from '@/lib/format/datetime';
import type { EngagementContext } from '@/lib/services/assurance';
import { assuranceLevelLabel, frameworkLabel } from '../../_components/labels';

/**
 * 案件配下ページ共通のヘッダー（指示書 16.2 Engagement Header・plan S13）。
 *
 * h1 は画面名（メニューの名前と同じ）。案件コードとクライアントは h1 の下の 1 行（context）に出す。
 * 12 画面の h1 がすべて案件コードだと、どの画面にいるかが見出しから分からなかったため。
 * パンくずは「案件ホーム / 保証契約 / 案件コード / 画面名」（メニューのツリーに案件コードが無いため手書き）。
 */
export function EngagementHeader({
  context,
  page,
  description,
  help,
  actions,
}: {
  context: EngagementContext;
  /** 画面名（メニューの名前と同じにする） */
  page: string;
  description?: React.ReactNode;
  help?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { engagement, clientName, periodCode } = context;
  return (
    <PageHeader
      title={page}
      context={
        // 装飾のバッジを並べず、区切りの文字で 1 行に収める（指示書 §15）
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="font-mono font-medium" data-engagement-code="">
            {engagement.code}
          </span>
          <span className="font-medium">{clientName}</span>
          <span className="text-ink-muted">
            ／ {engagement.name} ／ {periodCode} ／ {assuranceLevelLabel(engagement.assuranceLevel)}{' '}
            ／ {frameworkLabel(engagement.frameworkKey)} ／ 期限{' '}
            {formatJstDate(engagement.deadlineDate)}
          </span>
        </span>
      }
      description={description}
      help={help}
      breadcrumbs={[
        { label: '案件ホーム', href: '/assurance/dashboard' },
        { label: '保証契約', href: '/assurance/engagements' },
        { label: engagement.code, href: `/assurance/engagements/${engagement.id}/overview` },
        { label: page },
      ]}
      actions={actions}
    />
  );
}
