import type { RouteCatalogEntry } from '../route-catalog';
import { T1_ROUTES } from './t1';
import { T2_ROUTES } from './t2';
import { T3_ROUTES } from './t3';
import { T4_ROUTES } from './t4';
import { T5_ROUTES } from './t5';
import { T6_ROUTES } from './t6';
import { T7_ROUTES } from './t7';
import { T8_ROUTES } from './t8';

/**
 * トライアル対応（2026-10）でスライスごとに足す画面。スライスは自分のファイル（t1〜t8）だけを編集し、
 * route-catalog.ts は合成するだけ（並行作業で同じファイルを取り合わない）
 */
export const TRIAL_ROUTE_EXTENSIONS: readonly RouteCatalogEntry[] = [
  ...T1_ROUTES,
  ...T2_ROUTES,
  ...T3_ROUTES,
  ...T4_ROUTES,
  ...T5_ROUTES,
  ...T6_ROUTES,
  ...T7_ROUTES,
  ...T8_ROUTES,
];
