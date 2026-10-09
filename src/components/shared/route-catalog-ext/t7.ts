import type { RouteCatalogEntry } from '../route-catalog';

/**
 * トライアル対応（2026-10）のスライス T7 CDP オプション が足す画面（ROUTE_CATALOG に合成される）。
 * 予定: （新ルートなし）
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 */
export const T7_ROUTES: readonly RouteCatalogEntry[] = [];
