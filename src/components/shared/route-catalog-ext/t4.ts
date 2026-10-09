import type { RouteCatalogEntry } from '../route-catalog';

/**
 * トライアル対応（2026-10）のスライス T4 トライアル評価 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（ユーザーメニューは 'header'。§5 D22）。Command Palette・ヘルプ・ご意見のダイアログから届かせる
 */
export const T4_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: '/enterprise/trial',
    label: 'トライアルの評価',
    path: ['トライアルの評価'],
    href: '/enterprise/trial',
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: [
      'トライアル',
      '試行',
      '評価',
      '検証シナリオ',
      '改善管理表',
      'ご意見',
      '不具合',
      'フィードバック',
      '作業時間',
      '費用対効果',
      '試算',
      '検証結果',
      '選定ケース',
      '導入判断',
    ],
    menu: 'header',
  },
];
