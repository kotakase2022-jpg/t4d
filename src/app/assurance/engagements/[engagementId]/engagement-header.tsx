import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { formatJstDate } from '@/lib/format/datetime';
import type { EngagementContext } from '@/lib/services/assurance';

/** 案件配下ページ共通のヘッダー（指示書 16.2 Engagement Header）。 */
export function EngagementHeader({
  context,
  page,
  actions,
}: {
  context: EngagementContext;
  page: string;
  actions?: React.ReactNode;
}) {
  const { engagement, clientName, periodCode } = context;
  return (
    <PageHeader
      title={`${engagement.code} ${clientName}`}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span>{engagement.name}</span>
          <Badge tone="neutral">{periodCode}</Badge>
          <Badge tone="brand">
            {engagement.assuranceLevel === 'limited' ? '限定的保証' : '合理的保証'}
          </Badge>
          <Badge tone="neutral">{engagement.frameworkKey.toUpperCase()}</Badge>
          <span className="text-ink-muted">期限 {formatJstDate(engagement.deadlineDate)}</span>
        </span>
      }
      breadcrumbs={[
        { label: '監査法人ワークスペース' },
        { label: '保証契約', href: '/assurance/engagements' },
        { label: engagement.code, href: `/assurance/engagements/${engagement.id}/overview` },
        { label: page },
      ]}
      actions={actions}
    />
  );
}
