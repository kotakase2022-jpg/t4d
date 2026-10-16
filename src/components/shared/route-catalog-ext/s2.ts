import type { RouteCatalogEntry } from '../route-catalog';
import { ENTERPRISE_BASE } from './helpers';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S2 活動量・改良トンキロ法 が持つ画面。
 * メニューの葉は増やさない（menu: 'none'。plan K2）。算定の作業領域のタブ・パレット・画面内のリンクから届く
 */
const CALC = `${ENTERPRISE_BASE}/ghg/calculation`;

export const S2_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${CALC}/activity`,
    label: '活動量（Scope1・2算定）',
    path: ['GHG', 'Scope1・2算定', '活動量'],
    href: `${CALC}/activity`,
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: [
      '活動量',
      'エネルギー',
      '燃料',
      '電力',
      '輸送実績',
      '委託物流',
      '自社便',
      'トンキロ',
      '改良トンキロ法',
      '見なし積載率',
      '公的参照',
      '取込',
    ],
    menu: 'none',
  },
  {
    pattern: `${CALC}/activity/[batchId]`,
    label: '活動量の取込の詳細',
    path: ['GHG', 'Scope1・2算定', '活動量', '活動量の取込の詳細'],
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['活動量', '輸送の試算', '確定', '破棄', '積載率'],
    menu: 'none',
  },
];
