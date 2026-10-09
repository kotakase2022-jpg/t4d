import type { RouteCatalogEntry } from '../route-catalog';

/**
 * トライアル対応（2026-10）のスライス T6 XBRL が足す画面（ROUTE_CATALOG に合成される）。
 * 新しい page.tsx は無い（開示プロジェクトの ?tab=xbrl とタブの Server Action、出力 API
 * /api/exports/xbrl/[snapshotId] だけ）。プロジェクトの詳細は動的なパターンで固定の行き先を持たないため、
 * 検索語「XBRL」「タクソノミ」の入口は Command Palette の操作（Stage C）に依頼している。
 * 新しい page.tsx を足したら、ここへ同じパターンで載せる（tests/unit/route-catalog.test.ts が足し忘れを検出する）。
 * メニュー木は変えない（menu: 'none'。ユーザーメニューは 'header'）。Command Palette・画面内リンクから届かせる
 */
export const T6_ROUTES: readonly RouteCatalogEntry[] = [];
