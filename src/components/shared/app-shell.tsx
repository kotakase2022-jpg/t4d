import Link from 'next/link';
import { Bell } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { logoutAction, selectWorkspaceAction } from '@/lib/auth/actions';
import { selectPeriodAction } from '@/lib/auth/preferences';
import { can } from '@/lib/authorization/can';
import type { AuthorizationContext } from '@/types/domain';
import { BrandLogo } from './brand-logo';
import { DemoDataBadge } from './badges';
import { CommandPalette } from './command-palette';
import { HelpDialog } from './help-dialog';
import { RecordShortcuts } from './record-shortcuts';
import { ENTERPRISE_NAV, assuranceNav } from './nav-config';
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

export interface AppShellProps {
  ctx: AuthorizationContext;
  workspaces: WorkspaceChoice[];
  /** 企業ワークスペースのみ */
  periods?: PeriodChoice[];
  currentPeriodId?: string;
  /** 監査法人ワークスペースのみ */
  engagements?: EngagementChoice[];
  unreadNotifications: number;
  children: React.ReactNode;
}

/**
 * 権限が無いために非表示にするナビ項目の href を返す。
 * NavItem 自体は Client 側で解決する（LucideIcon が RSC 境界を越えられないため）。
 */
function hiddenNavHrefs(ctx: AuthorizationContext): string[] {
  const source =
    ctx.workspace.organizationType === 'enterprise' ? ENTERPRISE_NAV : assuranceNav(null);
  return source
    .filter((item) => item.permission && !can(ctx, item.permission))
    .map((item) => item.href);
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
  engagements,
  unreadNotifications,
  children,
}: AppShellProps) {
  const isEnterprise = ctx.workspace.organizationType === 'enterprise';
  const variant = isEnterprise ? 'enterprise' : 'assurance';
  const hidden = hiddenNavHrefs(ctx);

  return (
    <div className="t4d-min-canvas flex h-screen flex-col overflow-hidden bg-surface-muted">
      <header className="t4d-no-print flex h-[48px] shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <BrandLogo
          href={isEnterprise ? '/enterprise/dashboard' : '/assurance/dashboard'}
          priority
        />

        <div className="flex min-w-0 flex-1 items-center gap-3">
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
            <ReportingPeriodSelector
              periods={periods}
              currentId={currentPeriodId}
              onSelectAction={selectPeriodAction}
            />
          )}
          {!isEnterprise && engagements && <EngagementSelector engagements={engagements} />}
          {ctx.demo && <DemoDataBadge />}
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
