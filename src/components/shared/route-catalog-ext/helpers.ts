import type { PermissionKey } from '@/types/domain';
import type { RouteCatalogEntry } from '../route-catalog';

/**
 * ROUTE_CATALOG の項目を作る小道具（route-catalog.ts と、トライアル対応のスライスごとの拡張
 * route-catalog-ext/t1.ts〜t8.ts の両方が使う）。React・アイコンに依存しない。
 */

export const ENTERPRISE_BASE = '/enterprise';
export const PROJECTS_BASE = `${ENTERPRISE_BASE}/disclosure-projects`;
export const ENGAGEMENT_BASE = '/assurance/engagements/[engagementId]';

export const DISCLOSURE_READ: PermissionKey = 'enterprise.disclosure.read';
export const DISCLOSURE_WRITE: PermissionKey = 'enterprise.disclosure.write';
export const ENGAGEMENT_READ: PermissionKey = 'assurance.engagement.read';

/** 案件の画面（`{engagementId}` を埋めて開く。監査法人ツリーの葉） */
export function engagementRoute(
  segment: string,
  label: string,
  group: string,
  keywords: readonly string[],
): RouteCatalogEntry {
  return {
    pattern: `${ENGAGEMENT_BASE}/${segment}`,
    label,
    path: ['案件', group, label],
    href: `/assurance/engagements/{engagementId}/${segment}`,
    permission: ENGAGEMENT_READ,
    workspace: 'assurance',
    keywords,
    menu: 'assurance',
    engagement: true,
  };
}
