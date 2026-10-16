import type { RouteCatalogEntry } from '../route-catalog';
import { ENTERPRISE_BASE } from './helpers';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S4 既存結果との照合・差異原因 が持つ画面。
 * Stage A が仮ページと一緒に置き、S4 が画面を置き換えるときにここを編集する（menu: 'none'。plan K2）
 */
const CALC = `${ENTERPRISE_BASE}/ghg/calculation`;

export const S4_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${CALC}/reconciliation`,
    label: '既存の算定結果との照合',
    path: ['GHG', 'Scope1・2算定', '照合'],
    href: `${CALC}/reconciliation`,
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['照合', '既存の算定結果', '差異', '原因', '許容差', '整合性', '既存結果の取込'],
    menu: 'none',
  },
  {
    pattern: `${CALC}/reconciliation/[id]`,
    label: '照合の詳細',
    path: ['GHG', 'Scope1・2算定', '照合', '照合の詳細'],
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['照合', '差異の原因', '残差', '仮説の再計算', '原因の記録', '寄与'],
    menu: 'none',
  },
];
