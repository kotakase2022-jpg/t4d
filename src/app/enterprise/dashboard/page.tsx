import Link from 'next/link';
import { ArrowRight, ChartLine } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { GettingStarted } from '@/components/shared/getting-started';
import { MyWork } from '@/components/shared/my-work';
import { NavTabs } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { MoreInfo } from '@/components/ui/more-info';
import { can } from '@/lib/authorization/can';
import { businessToday } from '@/lib/clock';
import { getAppMode } from '@/lib/config';
import { formatJstDate } from '@/lib/format/datetime';
import { loadDisclosureHome, loadHeaderProjects } from '@/lib/services/disclosure-home';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { loadMyWork } from '@/lib/services/my-work';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { gettingStartedSteps } from '@/lib/ui/getting-started';
import {
  HOME_PROFILE_LABELS,
  canFor,
  homeProfileOf,
  resolveHomeTab,
  type HomeTab,
} from '@/lib/ui/home-profile';
import { defaultProjectId } from '@/lib/ui/task-verbs';
import { DEMO_RESET_ID, demoResetMenuItem } from './demo-reset';
import { DisclosureHomeView } from './disclosure-home-view';
import { LegacyHomeBody } from './legacy-home';

export const metadata = { title: 'ホーム' };

/**
 * ホーム（plan §1.3・§1.14・S2）。先頭に役割別の「自分の作業」（Attention → Action）を置き、
 * その下に従来の Status（KPI・拠点別進捗）／開示業務の状況を続ける。
 * 従来ホーム・開示業務の本文の整理は Stage B1 が行う（ここは取り付けと既定のタブだけ）。
 */
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
  const userCan = canFor(shell.ctx);
  // 「はじめに」の 3 手順（役割別。行き先はパレット・ホームと同じタスク動詞）
  const profile = homeProfileOf(shell.ctx);
  const headerProjects = await loadHeaderProjects(shell.db, shell.ctx);
  const gettingStarted = (
    <GettingStarted
      profileLabel={HOME_PROFILE_LABELS[profile]}
      steps={gettingStartedSteps(profile, userCan, {
        unitScopeIds: shell.ctx.workspace.unitScopeIds,
        currentProjectId: defaultProjectId(headerProjects, shell.currentPeriod.id),
        demo: shell.ctx.demo,
        disclosureFirst,
      })}
      className="mx-4 mt-2"
    />
  );

  // 開示優先モードが無効の組織は、従来のホームをそのまま出す（A39）。先頭に自分の作業を足す
  if (!disclosureFirst) {
    const work = await loadMyWork(shell.db, shell.ctx, { period: shell.currentPeriod, today });
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
        <MyWork work={work} className="px-4 pt-3" />
        {gettingStarted}
        <LegacyHomeBody shell={shell} today={today} />
      </>
    );
  }

  // 初期表示は役割で決める: 開示の閲覧権限が無い利用者は「ESG経営」（権限なしの表示を先頭に出さない。
  // N-04）。?tab= で明示されればそれに従う（URL で共有・戻るで復元できる）
  const tab: HomeTab = resolveHomeTab(params.tab, userCan);
  const canReadDisclosure = userCan('enterprise.disclosure.read');
  // 開示の閲覧権限が無くても ?tab=disclosure を明示したときは、従来どおり権限なしの説明を出す
  const disclosureHome =
    canReadDisclosure || tab === 'disclosure'
      ? await loadDisclosureHome(shell.db, shell.ctx, {
          period: shell.currentPeriod,
          today,
          projectId: typeof params.project === 'string' ? params.project : null,
        })
      : null;
  const work = await loadMyWork(shell.db, shell.ctx, {
    period: shell.currentPeriod,
    today,
    disclosureHome: canReadDisclosure ? (disclosureHome ?? undefined) : undefined,
  });
  // リセットは Demo Mode かつ開示の編集権限を持つ利用者だけに出す（Service でも同じ条件を検査する）
  const showDemoReset =
    shell.ctx.demo && getAppMode() === 'demo' && can(shell.ctx, 'enterprise.disclosure.write');
  const tabs: Array<{ key: HomeTab; label: string; href: string }> = [
    ...(canReadDisclosure || tab === 'disclosure'
      ? [{ key: 'disclosure' as const, label: '開示業務', href: '/enterprise/dashboard' }]
      : []),
    { key: 'esg', label: 'ESG経営', href: '/enterprise/dashboard?tab=esg' },
  ];
  const project = canReadDisclosure ? (disclosureHome?.project ?? null) : null;

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
        actions={
          showDemoReset ? (
            <PageActions
              more={[demoResetMenuItem()]}
              openConfirmId={params.confirm === DEMO_RESET_ID ? DEMO_RESET_ID : undefined}
            />
          ) : undefined
        }
      />
      <NavTabs ariaLabel="ホームの表示切替" items={tabs} current={tab} />

      <div className="px-4 pt-3">
        <FlashMessage searchParams={params} />
      </div>

      <MyWork
        work={work}
        className="px-4"
        moreLinks={
          project
            ? [
                {
                  label: '自分の原稿をすべて見る',
                  href: `${project.href}?tab=manuscripts&filter=mine`,
                },
              ]
            : []
        }
      />
      {gettingStarted}

      {tab === 'esg' || !disclosureHome ? (
        <>
          <div className="px-4 pt-3">
            {/* タブの説明は既定で閉じ、ESG経営への導線だけを常に見せる（docs/disclosure-first.md §10.4） */}
            <div className="rounded-t4d-lg border border-line bg-surface">
              <div className="flex items-start gap-2 px-3 py-2 text-small text-ink">
                <ChartLine className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <MoreInfo label="このタブに出ているもの" className="pt-0.5">
                  <p>
                    KPI・目標・推移は「ESG経営」画面にまとめています。以下はデータ収集の進み具合です。
                  </p>
                </MoreInfo>
                <Link
                  href="/enterprise/esg"
                  className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-brand-700 hover:underline"
                >
                  ESG経営を開く <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
          <LegacyHomeBody shell={shell} today={today} />
        </>
      ) : (
        <DisclosureHomeView home={disclosureHome} />
      )}
    </>
  );
}
