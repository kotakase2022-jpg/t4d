import type { RouteCatalogEntry } from '../route-catalog';
import { DISCLOSURE_READ, PROJECTS_BASE } from './helpers';

/**
 * トライアル対応（2026-10）のスライス T1 要求事項・判断・対応表 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 * （要求事項タブ・横断対応表の行・原稿エディタの要求事項）。詳細画面なので href は持たない
 */
export const T1_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${PROJECTS_BASE}/[projectId]/requirements/[itemId]`,
    label: '要求事項の詳細（プロジェクト）',
    path: ['開示プロジェクト', '要求事項', '要求事項の詳細（プロジェクト）'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['要求事項', '適用判断', '対象外の承認', '3 観点', '横断対応'],
    menu: 'none',
  },
];
