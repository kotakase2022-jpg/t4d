import type { RouteCatalogEntry } from '../route-catalog';
import { DISCLOSURE_READ, ENGAGEMENT_BASE, ENGAGEMENT_READ, engagementRoute } from './helpers';

/**
 * トライアル対応（2026-10）のスライス T3 保証連携 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 *
 * 開示レポートは監査法人ツリーの「実施」の葉（plan K2 の例外。nav-config.ts の assuranceNav）。
 * 内容の画面（[copyId]）は一覧の行から開く
 */
export const T3_ROUTES: readonly RouteCatalogEntry[] = [
  engagementRoute('reports', '開示レポート', '実施', [
    '開示レポート',
    '共有レポート',
    '承認済みレポート',
    '原稿',
    'トレース',
    'コメント',
  ]),
  {
    pattern: `${ENGAGEMENT_BASE}/reports/[copyId]`,
    label: '開示レポートの内容',
    path: ['案件', '実施', '開示レポート', '内容'],
    permission: ENGAGEMENT_READ,
    workspace: 'assurance',
    menu: 'none',
  },
  {
    pattern: '/enterprise/assurance-comments',
    label: '保証側のコメント',
    path: ['業務管理', '保証側のコメント'],
    href: '/enterprise/assurance-comments',
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['保証', '監査法人', 'コメント', '回答', 'レビューNote', '指摘'],
    menu: 'none',
  },
];
