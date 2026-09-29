import Link from 'next/link';
import { AlertTriangle, Bell } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { logoutAction, selectWorkspaceAction } from '@/lib/auth/actions';
import { switchDemoRoleAction } from '@/lib/auth/demo-role-actions';
import { selectPeriodAction } from '@/lib/auth/preferences';
import { can } from '@/lib/authorization/can';
import { describeReferenceDate } from '@/lib/clock';
import { formatJstDate } from '@/lib/format/datetime';
import type { AuthorizationContext, IsoDate } from '@/types/domain';
import { BrandLogo } from './brand-logo';
import { DemoDataBadge } from './badges';
import { CommandPalette } from './command-palette';
import { HeaderProjectContext, type HeaderProject } from './header-context';
import { ReferenceDateBadge } from './header-badges';
import { DemoRoleSwitcher, type DemoRoleChoiceView } from './header-demo-role-switcher';
import { HelpDialog } from './help-dialog';
import { RecordShortcuts } from './record-shortcuts';
import { navTreeFor, type NavVariant } from './nav-config';
import {
  EngagementSelector,
  ReportingPeriodSelector,
  UserMenu,
  WorkspaceSelector,
  type EngagementChoice,
  type PeriodChoice,
  type WorkspaceChoice,
} from './selectors';
import { Sidebar } from './sidebar';

/** ヘッダーに出すプロジェクト（AppShell が期間を整形して HeaderProject にする） */
export interface AppShellProject {
  id: string;
  name: string;
  reportingEntity: string;
  scopeOrgNote: string;
  scopeConsolidationNote: string;
  scopeGhgBoundaryNote: string;
  scopeValueChainNote: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  reportingPeriodId: string;
}

export interface AppShellProps {
  ctx: AuthorizationContext;
  workspaces: WorkspaceChoice[];
  /** 企業ワークスペースのみ */
  periods?: PeriodChoice[];
  currentPeriodId?: string;
  /** 企業ワークスペースのみ: 選択中の報告期間の開始日・終了日（FY だけでなく日付で示す。指示書 §4.2） */
  currentPeriodRange?: { startDate: IsoDate; endDate: IsoDate };
  /** 企業ワークスペースのみ: 開示優先モード（組織の機能設定）。true なら開示業務中心のメニュー */
  disclosureFirst?: boolean;
  /** 企業ワークスペースのみ: プロジェクトの画面でヘッダーに名前・対象範囲を出すための一覧 */
  projects?: AppShellProject[];
  /**
   * Demo Mode のみ: 操作の記録（Cookie）の容量が足りず、古い操作を押し出した。
   * 別のサーバーではその操作が戻らないため、帯で知らせる
   */
  demoEditsEvicted?: boolean;
  /** Demo Mode のみ: 役割切替の候補（同じ組織の @demo.local 利用者）。空なら出さない */
  demoRoleChoices?: DemoRoleChoiceView[];
  /** 監査法人ワークスペースのみ */
  engagements?: EngagementChoice[];
  unreadNotifications: number;
  children: React.ReactNode;
}

/**
 * 権限が無いために非表示にするナビ項目の href を返す。
 * NavItem 自体は Client 側で解決する（LucideIcon が RSC 境界を越えられないため）。
 * 判定には画面に出すのと同じツリー（従来／開示優先）を使う。
 */
function hiddenNavHrefs(ctx: AuthorizationContext, variant: NavVariant): string[] {
  const source = navTreeFor(variant, null);
  // 子項目（例: 管理 > 設定）にも権限が付くため、階層をたどって集める
  const collect = (items: typeof source): string[] =>
    items.flatMap((item) => [
      ...(item.permission && !can(ctx, item.permission) ? [item.href] : []),
      ...collect(item.children ?? []),
    ]);
  return collect(source);
}

function periodText(start: IsoDate, end: IsoDate): string {
  return `${formatJstDate(start)}〜${formatJstDate(end)}`;
}

function toHeaderProject(
  project: AppShellProject,
  periods: PeriodChoice[] | undefined,
): HeaderProject {
  const scope = [
    project.scopeOrgNote,
    project.scopeConsolidationNote,
    project.scopeGhgBoundaryNote,
    project.scopeValueChainNote,
  ]
    .map((note) => note.trim())
    .filter(Boolean)
    .join(' ');
  return {
    id: project.id,
    name: project.name,
    reportingEntity: project.reportingEntity,
    scopeDetail: scope || project.reportingEntity,
    periodText: periodText(project.periodStart, project.periodEnd),
    reportingPeriodId: project.reportingPeriodId,
    reportingPeriodCode: periods?.find((p) => p.id === project.reportingPeriodId)?.code ?? null,
  };
}

/**
 * 共通 App Shell（指示書 5.5）。
 * Top Bar 48px / Sidebar 224px（折畳 64px）/ Compact Density。
 */
export function AppShell({
  ctx,
  workspaces,
  periods,
  currentPeriodId,
  currentPeriodRange,
  disclosureFirst = false,
  projects = [],
  demoRoleChoices = [],
  demoEditsEvicted = false,
  engagements,
  unreadNotifications,
  children,
}: AppShellProps) {
  const isEnterprise = ctx.workspace.organizationType === 'enterprise';
  const variant: NavVariant = isEnterprise
    ? disclosureFirst
      ? 'enterprise-disclosure'
      : 'enterprise'
    : 'assurance';
  const hidden = hiddenNavHrefs(ctx, variant);
  // 期限判定の基準日。デモでは「デモ基準日」を出す（実時計の Supabase Mode では null）
  const referenceLabel = ctx.demo ? describeReferenceDate().label : null;
  const currentPeriodCode = periods?.find((p) => p.id === currentPeriodId)?.code ?? null;

  return (
    <div className="t4d-min-canvas flex h-screen flex-col overflow-hidden bg-surface-muted">
      <header className="t4d-no-print flex h-[48px] shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <BrandLogo
          href={isEnterprise ? '/enterprise/dashboard' : '/assurance/dashboard'}
          priority
        />

        {/*
          中央の列は幅が足りないときに右の操作（役割切替・通知）へはみ出して重ならないよう、はみ出しを切る。
          並びは重要な順（企業 → 報告期間 → 開示プロジェクト → デモの表示）で、足りないときは末尾から見えなくなる
        */}
        <div className="group/hdr flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          <WorkspaceSelector
            current={{
              organizationId: ctx.workspace.organizationId,
              organizationName: ctx.workspace.organizationName,
              organizationType: ctx.workspace.organizationType,
            }}
            choices={workspaces}
            onSelectAction={selectWorkspaceAction}
          />
          {isEnterprise && periods && periods.length > 0 && currentPeriodId && (
            <div className="flex shrink-0 items-center gap-1">
              <ReportingPeriodSelector
                periods={periods}
                currentId={currentPeriodId}
                onSelectAction={selectPeriodAction}
              />
              {currentPeriodRange && (
                <span
                  // 開示プロジェクトの画面では、プロジェクトの表示を優先する（広い画面でだけ期間の日付を並べる）
                  className="tnum whitespace-nowrap text-[11px] text-ink-muted max-[1599px]:group-has-[[data-testid=header-project-context]]/hdr:hidden"
                  data-testid="header-period-range"
                >
                  <span className="sr-only">報告期間の開始日と終了日: </span>
                  {periodText(currentPeriodRange.startDate, currentPeriodRange.endDate)}
                </span>
              )}
            </div>
          )}
          {isEnterprise && projects.length > 0 && (
            <HeaderProjectContext
              projects={projects.map((p) => toHeaderProject(p, periods))}
              currentPeriodId={currentPeriodId ?? null}
              currentPeriodCode={currentPeriodCode}
            />
          )}
          {!isEnterprise && engagements && <EngagementSelector engagements={engagements} />}
          {ctx.demo && <DemoDataBadge />}
          {ctx.demo && demoEditsEvicted && (
            <Badge
              tone="warning"
              title="デモの操作の記録が容量を超えたため、古い操作から保持をやめました。別のサーバーで開くと、その操作は反映されていないことがあります。"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              古い操作の一部を保持できませんでした
            </Badge>
          )}
          {referenceLabel && <ReferenceDateBadge label={referenceLabel} />}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {ctx.demo && demoRoleChoices.length > 1 && (
            <DemoRoleSwitcher choices={demoRoleChoices} onSwitchAction={switchDemoRoleAction} />
          )}
          <Button variant="ghost" size="sm" asChild>
            <Link href="/notifications" aria-label={`通知（未読 ${unreadNotifications} 件）`}>
              <Bell aria-hidden="true" />
              {unreadNotifications > 0 && (
                <Badge tone="danger" className="ml-0.5">
                  {unreadNotifications}
                </Badge>
              )}
            </Link>
          </Button>
          <HelpDialog />
          <UserMenu
            displayName={ctx.displayName}
            email={ctx.email}
            roleKeys={ctx.workspace.roleKeys}
            onLogoutAction={logoutAction}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar variant={variant} hiddenHrefs={hidden} />
        <main id="t4d-main" className="min-w-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      <CommandPalette variant={variant} hiddenHrefs={hidden} />
      <RecordShortcuts />
    </div>
  );
}
