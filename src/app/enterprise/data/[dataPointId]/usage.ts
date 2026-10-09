import type { FrameworkKey, Uuid } from '@/types/domain';

/**
 * データの詳細・資料の詳細の「この数値（資料）を使っている原稿・レポート」の表示の規則
 * （トライアル対応 NF-16・NF-38）。画面とテストで同じ関数を使う。DB に依存しない。
 */

export interface UsageCountsLike {
  blocks: number;
  approvedReports: number;
  sharedWithAssurance: number;
}

/** 影響の要約（承認済みの値を修正する確認ダイアログ・節の要点で同じ言い方） */
export function usageSummaryText(counts: UsageCountsLike): string {
  return `影響する節 ${counts.blocks}・承認済みレポート ${counts.approvedReports}・保証側へ共有中 ${counts.sharedWithAssurance}`;
}

/** 節の見出しの件数（引用している節と、固定したスナップショット） */
export function usageItemCount(usage: {
  blocks: readonly unknown[];
  snapshots: readonly unknown[];
}): number {
  return usage.blocks.length + usage.snapshots.length;
}

/**
 * 開示マッピングに出す開示項目。CDP 対応オプションの契約が無い組織では CDP の項目を出さない
 * （NF-38。契約は役割の権限ではないため、項目の基準で判定する）
 */
export function visibleMappedItems<T extends { frameworkVersionId: Uuid }>(
  items: readonly T[],
  frameworkKeyByVersionId: ReadonlyMap<Uuid, FrameworkKey | undefined>,
  options: { cdpContracted: boolean },
): T[] {
  return items.filter(
    (item) =>
      options.cdpContracted || frameworkKeyByVersionId.get(item.frameworkVersionId) !== 'cdp',
  );
}

/**
 * 確定している対応付けだけ（確定を外した対応付けは行を残すため、確定日時の無い行は出さない。
 * AI の候補のまま確定していない対応付けも出さない）
 */
export function confirmedMappings<T extends { confirmedAt: string | null }>(
  mappings: readonly T[],
): T[] {
  return mappings.filter((m) => m.confirmedAt !== null);
}
