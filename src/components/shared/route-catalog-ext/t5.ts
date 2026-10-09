import type { RouteCatalogEntry } from '../route-catalog';

/**
 * トライアル対応（2026-10）のスライス T5 管理・権限・ログ・データ取扱・運用 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる。
 * 設定の新しいタブ（承認ルート・役割と権限・データの取扱い）は既存の「設定」の画面の中（?tab=）なので、ここには載せない
 */
export const T5_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: '/enterprise/audit-log',
    label: '監査ログ',
    path: ['管理', '監査ログ'],
    href: '/enterprise/audit-log',
    // ページのゲートと同じ（企業管理者が持つ監査ログの閲覧権限）
    permission: 'common.audit.read',
    workspace: 'enterprise',
    keywords: [
      '監査ログ',
      '操作履歴',
      '証跡',
      'ログ',
      '資料アクセス',
      'ダウンロード履歴',
      '監査法人のアクセス',
    ],
    menu: 'none',
  },
];
