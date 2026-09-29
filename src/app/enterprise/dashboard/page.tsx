import Link from 'next/link';
import { ArrowRight, ChartLine } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { can } from '@/lib/authorization/can';
import { businessToday } from '@/lib/clock';
import { getAppMode } from '@/lib/config';
import { formatJstDate } from '@/lib/format/datetime';
import { loadDisclosureHome } from '@/lib/services/disclosure-home';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import { DisclosureHomeView } from './disclosure-home-view';
import { LegacyHomeBody } from './legacy-home';

export const metadata = { title: 'ホーム' };

type HomeTab = 'disclosure' | 'esg';

export default async function EnterpriseDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  // 期限・超過の判定は業務上の今日（デモは基準日、Supabase Mode は実時計。src/lib/clock.ts）
  const today = businessToday();
  const { disclosureFirst } = await getFeatureSettings(shell.db, shell.ctx);

  // 開示優先モードが無効の組織は、従来のホームをそのまま出す（A39）
  if (!disclosureFirst) {
    return (
      <>
        <PageHeader
          title="ホーム"
          description={
            <>
              {shell.ctx.workspace.organizationName} ／ {shell.currentPeriod.label} ／ 提出期限{' '}
              {formatJstDate(shell.currentPeriod.submissionDueDate)}
            </>
          }
          breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'ホーム' }]}
        />
        <LegacyHomeBody shell={shell} today={today} />
      </>
    );
  }

  // 初期表示は「開示業務」。ESG経営は ?tab=esg（URL で共有・戻るで復元できる）
  const tab: HomeTab = params.tab === 'esg' ? 'esg' : 'disclosure';

  return (
    <>
      <PageHeader
        title="ホーム"
        description={
          <>
            {shell.ctx.workspace.organizationName} ／ {shell.currentPeriod.label}
            {/* 期間の名称に日付が入っている場合（例: 2026年度（2026-04-01〜2027-03-31））は重ねて出さない */}
            {!shell.currentPeriod.label.includes(shell.currentPeriod.startDate) && (
              <>
                （{formatJstDate(shell.currentPeriod.startDate)}〜
                {formatJstDate(shell.currentPeriod.endDate)}）
              </>
            )}
          </>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'ホーム' }]}
      />
      <nav aria-label="ホームの表示切替" className="border-b border-line bg-surface px-4">
        <ul className="flex items-center gap-0.5">
          {(
            [
              ['disclosure', '開示業務', '/enterprise/dashboard'],
              ['esg', 'ESG経営', '/enterprise/dashboard?tab=esg'],
            ] as const
          ).map(([key, label, href]) => (
            <li key={key}>
              <Link
                href={href}
                aria-current={tab === key ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-block border-b-2 px-2.5 py-1.5 text-[13px] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100',
                  tab === key
                    ? 'border-brand-700 font-medium text-brand-800'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-4 pt-3">
        <FlashMessage searchParams={params} />
      </div>

      {tab === 'esg' ? (
        <>
          <div className="px-4 pt-1">
            <Card>
              <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink">
                <ChartLine className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                KPI・目標・推移は「ESG経営」画面にまとめています。以下はデータ収集の進み具合です。
                <Link
                  href="/enterprise/esg"
                  className="ml-auto inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                >
                  ESG経営を開く <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              </div>
            </Card>
          </div>
          <LegacyHomeBody shell={shell} today={today} />
        </>
      ) : (
        <DisclosureHomeView
          home={await loadDisclosureHome(shell.db, shell.ctx, {
            period: shell.currentPeriod,
            today,
            projectId: typeof params.project === 'string' ? params.project : null,
          })}
          // リセットは Demo Mode かつ開示の編集権限を持つ利用者だけに出す（Service でも同じ条件を検査する）
          showDemoReset={
            shell.ctx.demo &&
            getAppMode() === 'demo' &&
            can(shell.ctx, 'enterprise.disclosure.write')
          }
        />
      )}
    </>
  );
}
