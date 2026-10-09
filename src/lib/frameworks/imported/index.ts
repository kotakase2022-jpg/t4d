/**
 * 登録スクリプト（scripts/import-framework-master.ts）が生成する基準マスターの登録簿。手で編集しない。
 * 一次資料で人が確認した構造（項番・節・要約題名・出典・確認日）だけ。条文は入れない。
 * Fixture（src/lib/fixtures/store.ts）がこの一覧を読み、pnpm seed:generate で seed.sql に入る。
 */
import type { DisclosureFrameworkVersion, DisclosureItem, FrameworkKey } from '@/types/domain';

export interface ImportedFrameworkMaster {
  schema: 't4d-framework-master@1';
  frameworkKey: FrameworkKey;
  version: DisclosureFrameworkVersion;
  items: DisclosureItem[];
}

export const IMPORTED_FRAMEWORK_MASTERS: readonly ImportedFrameworkMaster[] = [];
