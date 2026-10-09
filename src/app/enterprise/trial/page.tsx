import type { ReactNode } from 'react';
import { ClipboardPen, Download, PlayCircle, Timer } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { NavTabs } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { can } from '@/lib/authorization/can';
import { getBuildInfo } from '@/lib/build-info';
import { isDemoMode } from '@/lib/config';
import { TRIAL_MIN_SAMPLE } from '@/lib/domain/trial-metrics';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import {
  businessCompletion,
  measuredValueCandidates,
  summarizeScenarios,
} from '@/lib/services/trial-evaluation';
import { summarizeOpenIssues } from '@/lib/services/trial-feedback';
import {
  canManageTrial,
  loadTrialFormChoices,
  loadTrialOverview,
  trialTextLimits,
} from '@/lib/services/trial-program';
import { summarizeTimings } from '@/lib/services/trial-timing';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { FeedbackDialog } from './_components/feedback-dialog';
import { FeedbackTab } from './_components/feedback-tab';
import { OverviewTab } from './_components/overview-tab';
import { RoiTab } from './_components/roi-tab';
import { ScenariosTab } from './_components/scenarios-tab';
import { TimingTab } from './_components/timing-tab';
import {
  isAnyPanelOpen,
  resolveTrialTab,
  TRIAL_TAB_LABELS,
  TRIAL_REPORT_HREF,
  TRIAL_TABS,
  trialHref,
  type TrialTab,
} from './_lib/tabs';

export const metadata = { title: 'トライアルの評価' };

/**
 * トライアルの評価（トライアル対応 NF-32〜NF-36・NF-37 の概要の合計。plan §2.5）。
 *
 * タブ: 概要（計画と実績・選定ケース・判断）・シナリオ（実施・判定・完遂率）・改善管理表・作業時間・費用対効果（試算）。
 * 閲覧は企業の組織メンバー（enterprise.data.read）。計画・判定・改善の対応・出力は企業管理者（enterprise.org.manage）。
 * 実施・ご意見・作業時間の記録は組織メンバー本人の名義。利用者の操作は自動で追跡しない（外部の計測サービスも使わない）。
 * Demo Mode では先頭に「架空のトライアル記録」の注記を常に出す（折りたたまない）。率は件数（n）と測り方を併記する。
 */
export default async function TrialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  if (!can(ctx, 'enterprise.data.read')) {
    return (
      <>
        <PageHeader title="トライアルの評価" autoBreadcrumbs />
        <PermissionDeniedState
          permission="enterprise.data.read"
          description="トライアルの評価は、組織のデータを閲覧できるメンバーだけが開けます。"
        />
      </>
    );
  }

  const tab: TrialTab = resolveTrialTab(params);
  const canManage = canManageTrial(ctx);
  const limits = trialTextLimits(db, ctx);
  const build = getBuildInfo();
  const demo = isDemoMode() || ctx.demo;
  const panelOpen = isAnyPanelOpen(params);

  // タブの中身に要るものだけを読む（シナリオの一覧はご意見のダイアログの選択肢にも使う）
  const scenarios = await summarizeScenarios(db, ctx);
  const scenarioChoices = scenarios.rows.map((row) => ({
    id: row.scenario.id,
    code: row.scenario.code,
    title: row.scenario.title,
  }));

  const exportItem: MenuActionSpec = {
    kind: 'link',
    id: 'export-trial-report',
    label: '検証結果・改善管理表を出力（XLSX）',
    icon: <Download aria-hidden="true" />,
    href: TRIAL_REPORT_HREF,
    download: true,
    group: 'export',
    hidden: !canManage,
  };

  let primary: ActionSpec | undefined;
  let secondary: ActionSpec[] = [];
  let body: ReactNode = null;
  switch (tab) {
    case 'overview': {
      const overview = await loadTrialOverview(db, ctx);
      const choices = canManage ? await loadTrialFormChoices(db, ctx, overview.program) : null;
      primary = {
        kind: 'link',
        id: 'edit-trial-plan',
        label: overview.program ? '計画を編集' : '計画を作成',
        icon: <ClipboardPen aria-hidden="true" />,
        href: trialHref('overview', { edit: '1' }),
        hidden: !canManage || panelOpen,
      };
      body = (
        <OverviewTab
          overview={overview}
          choices={choices}
          params={params}
          canManage={canManage}
          limits={limits}
        />
      );
      break;
    }
    case 'scenarios': {
      const [business, candidates] = await Promise.all([
        businessCompletion(db, ctx),
        canManage ? measuredValueCandidates(db, ctx) : Promise.resolve(null),
      ]);
      primary = {
        kind: 'link',
        id: 'record-trial-run',
        shortcut: 'new',
        label: 'シナリオを実施して記録',
        icon: <PlayCircle aria-hidden="true" />,
        href: trialHref('scenarios', { new: '1' }),
        hidden: panelOpen,
      };
      body = (
        <ScenariosTab
          summary={scenarios}
          business={business}
          candidates={candidates}
          params={params}
          canManage={canManage}
          limits={limits}
          viewerId={ctx.userId}
        />
      );
      break;
    }
    case 'feedback': {
      const overview = await summarizeOpenIssues(db, ctx);
      secondary = [
        {
          kind: 'link',
          id: 'record-meeting-feedback',
          label: '定例会などの論点を記録',
          icon: <ClipboardPen aria-hidden="true" />,
          href: trialHref('feedback', { new: '1' }),
          hidden: !canManage || panelOpen,
        },
      ];
      body = (
        <FeedbackTab
          overview={overview}
          scenarios={scenarios.rows.map((row) => row.scenario)}
          params={params}
          canManage={canManage}
          limits={limits}
          build={build.commit}
        />
      );
      break;
    }
    case 'timing': {
      const summary = await summarizeTimings(db, ctx);
      primary = {
        kind: 'link',
        id: 'record-trial-timing',
        shortcut: 'new',
        label: '作業時間を記録',
        icon: <Timer aria-hidden="true" />,
        href: trialHref('timing', { new: '1' }),
        hidden: panelOpen,
      };
      body = <TimingTab summary={summary} params={params} limits={limits} viewerId={ctx.userId} />;
      break;
    }
    case 'roi': {
      const summary = await summarizeTimings(db, ctx);
      body = <RoiTab params={params} tasks={summary.tasks} />;
      break;
    }
  }

  // 改善管理表のタブでは、ご意見のダイアログが主な操作（作成・対応の欄を開いているときは欄の送信が主）
  const feedbackPrimary = tab === 'feedback' && !panelOpen;
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <PageActions primary={primary} secondary={secondary} more={[exportItem]} />
      <FeedbackDialog
        scenarios={scenarioChoices}
        titleMaxLength={limits.title}
        bodyMaxLength={limits.text}
        triggerVariant={feedbackPrimary ? 'primary' : 'secondary'}
      />
    </div>
  );

  return (
    <>
      <PageHeader
        title="トライアルの評価"
        description="試行の計画・検証の記録・改善の管理と効果の試算"
        context={<span className="text-caption text-ink-muted">この環境の版: {build.label}</span>}
        autoBreadcrumbs
        actions={actions}
        help={
          <>
            <p>
              率（自力完遂率・合格率・短縮率）は件数（n）と測り方を併記します。件数が{' '}
              {TRIAL_MIN_SAMPLE} 件に満たないときは率を出さず「件数不足」と表示します。
            </p>
            <p>
              利用者の操作は自動で追跡していません。実施・ご意見・作業時間は本人が記録し、業務の完遂状況は既存の業務記録（取込・レビュー・承認段階）から数えます。外部の計測サービスは使いません。
            </p>
            <p>
              計画・判定・改善管理表の対応・出力は企業管理者が行います。終了時の扱い・導入判断は人が入力します（AI
              は関与しません）。
            </p>
          </>
        }
      />
      <NavTabs
        ariaLabel="トライアルの評価の節"
        current={tab}
        items={TRIAL_TABS.map((key) => ({
          key,
          label: TRIAL_TAB_LABELS[key],
          href: trialHref(key),
        }))}
      />
      <div className="space-y-3 p-4">
        {/* 誠実さの注記（Demo Mode では常に。折りたたまない） */}
        {demo && (
          <Notice tone="warning">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <HonestyBadge kind="fictional" />
              架空のトライアル記録です。実測値・実際の効果ではありません。
            </span>
          </Notice>
        )}
        <FlashMessage searchParams={params} />
        {body}
      </div>
    </>
  );
}
