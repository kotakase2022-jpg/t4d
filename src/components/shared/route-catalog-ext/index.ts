import type { RouteCatalogEntry } from '../route-catalog';
import { T1_ROUTES } from './t1';
import { T2_ROUTES } from './t2';
import { T3_ROUTES } from './t3';
import { T4_ROUTES } from './t4';
import { T5_ROUTES } from './t5';
import { T6_ROUTES } from './t6';
import { T7_ROUTES } from './t7';
import { T8_ROUTES } from './t8';
import { S1_ROUTES } from './s1';
import { S2_ROUTES } from './s2';
import { S3_ROUTES } from './s3';
import { S4_ROUTES } from './s4';
import { S5_ROUTES } from './s5';

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
  // Scope1・2 の算定と照合（2026-10-16 の要望）。スライス S1〜S5 は自分のファイルだけを編集する
  ...S1_ROUTES,
  ...S2_ROUTES,
  ...S3_ROUTES,
  ...S4_ROUTES,
  ...S5_ROUTES,
];
