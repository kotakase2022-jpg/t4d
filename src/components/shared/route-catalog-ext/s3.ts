import type { RouteCatalogEntry } from '../route-catalog';
import { ENTERPRISE_BASE } from './helpers';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S3 算定の実行・結果 が持つ画面。
 * 概要（P90 /enterprise/ghg/calculation）はメニューの葉なので route-catalog.ts に置く。
 * 算定明細（P96）はメニューに出さない（概要の「算定の記録」・拠点名・Command Palette から届かせる。plan K2）
 */
const CALC = `${ENTERPRISE_BASE}/ghg/calculation`;

export const S3_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${CALC}/runs/[runId]`,
    label: '算定明細',
    path: ['GHG', 'Scope1・2算定', '算定明細'],
    // 記録の閲覧は enterprise.data.read（services/ghg/calculation.ts の loadRun と同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: [
      '算定の記録',
      '明細',
      '報告区分',
      '既定区分',
      '二重表示',
      '算定行',
      'Data Point に下書き反映',
      'CSV',
    ],
    menu: 'none',
  },
];
