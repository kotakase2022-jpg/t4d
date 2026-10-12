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

/** 開示の閲覧権限が無い人に、件数（0）の代わりに出す文（影響が無いと取り違えさせない） */
export const USAGE_HIDDEN_TEXT = '開示の閲覧権限が無いため、影響先（原稿・レポート）は表示しません';

/**
 * 影響の要約（承認済みの値を修正する確認ダイアログ・節の要点で同じ言い方）。開示の閲覧権限が無い人には
 * 件数を出さない（読めないものを 0 件と書くと、影響が無いと誤解させる）
 */
export function usageSummaryText(
  counts: UsageCountsLike,
  options: { disclosureHidden?: boolean } = {},
): string {
  if (options.disclosureHidden) return USAGE_HIDDEN_TEXT;
  return `影響する節 ${counts.blocks}・承認済みレポート ${counts.approvedReports}・保証側へ共有中 ${counts.sharedWithAssurance}`;
}

/** 節の見出し（件数付き。開示の閲覧権限が無ければ件数を出さない） */
export function usageSectionTitle(
  subject: '資料' | '数値',
  count: number,
  disclosureHidden: boolean,
): string {
  const base = `この${subject}を使っている原稿・レポート`;
  return disclosureHidden ? `${base}（権限が無いため表示しません）` : `${base}（${count}）`;
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
