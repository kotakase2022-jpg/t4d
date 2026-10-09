import type { RouteCatalogEntry } from '../route-catalog';
import { DISCLOSURE_READ, ENTERPRISE_BASE } from './helpers';

/**
 * トライアル対応（2026-10）のスライス T8 本文・インパクト・基準版 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 * （定性情報の一覧の「その他」・定性情報の編集の「関連するインパクト・リスク・機会」・台帳の行から）
 */
export const T8_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${ENTERPRISE_BASE}/disclosures/impacts`,
    label: 'インパクト・リスク・機会の台帳',
    path: ['開示対応', 'インパクト・リスク・機会の台帳'],
    href: `${ENTERPRISE_BASE}/disclosures/impacts`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: [
      'インパクト',
      'IRO',
      'リスク',
      '機会',
      '台帳',
      'ESRS-40a',
      'CSRD',
      'SSBJ',
      '影響',
      'ステークホルダー',
    ],
    menu: 'none',
  },
];
