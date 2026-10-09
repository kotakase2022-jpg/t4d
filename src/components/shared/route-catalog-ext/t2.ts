import type { RouteCatalogEntry } from '../route-catalog';
import { DISCLOSURE_READ, PROJECTS_BASE } from './helpers';

/**
 * トライアル対応（2026-10）のスライス T2 トレース・出力・突合・影響の表示 が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 * （出力タブのスナップショットの行「内容とトレースを開く」・データの詳細・資料の詳細の「固定したレポート」）。
 * 詳細画面なので href は持たない
 */
export const T2_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${PROJECTS_BASE}/[projectId]/snapshots/[snapshotId]`,
    label: 'スナップショットの内容とトレース',
    path: ['開示プロジェクト', '出力', 'スナップショットの内容とトレース'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['トレース', '追跡率', '追跡番号', '承認版', '根拠', '遡る', 'スナップショット'],
    menu: 'none',
  },
];
