/**
 * 基準の版どうしの要求事項の差分（トライアル対応 NF-08）。
 *
 * 項番だけで突き合わせると、改番（項番が変わっただけの要求事項）が「削除＋追加」に見え、
 * 旧版で書いた節・定性情報の対応付け・対象外の判断の引継ぎ先を失う。新しい版の要求事項が
 * previous_item_code（前の版の項番）を持つときはそれを優先して対応を取り、改番として区別する。
 * 対応付けの引継ぎは自動では行わない（差分は人が確認する。公式の条項と社内の要求事項は 1 対 1 とは限らない）。
 *
 * DB にも画面にも依存しない純粋関数。
 */

import type { DisclosureItem, Uuid } from '@/types/domain';

export const FRAMEWORK_DIFF_KINDS = [
  'added',
  'removed',
  'changed',
  'renumbered',
  'unchanged',
] as const;
export type FrameworkDiffKind = (typeof FRAMEWORK_DIFF_KINDS)[number];

export const FRAMEWORK_DIFF_KIND_LABELS: Readonly<Record<FrameworkDiffKind, string>> = {
  added: '追加',
  removed: '削除',
  changed: '文言の変更',
  renumbered: '改番',
  unchanged: '変更なし',
};

export type DiffItem = Pick<
  DisclosureItem,
  'id' | 'code' | 'questionText' | 'guidance' | 'previousItemCode'
>;

export interface FrameworkDiffEntry {
  kind: FrameworkDiffKind;
  fromItemId: Uuid | null;
  toItemId: Uuid | null;
  fromCode: string | null;
  toCode: string | null;
  /** 表示する題名（新しい版があれば新しい版の文言） */
  title: string;
  /** 改番と同時に文言も変わったか（改番の行で使う） */
  textChanged: boolean;
}

export interface FrameworkDiff {
  entries: FrameworkDiffEntry[];
  added: FrameworkDiffEntry[];
  removed: FrameworkDiffEntry[];
  changed: FrameworkDiffEntry[];
  renumbered: FrameworkDiffEntry[];
  unchangedCount: number;
}

function textDiffers(a: DiffItem, b: DiffItem): boolean {
  return a.questionText !== b.questionText || a.guidance !== b.guidance;
}

/**
 * 2 つの版の要求事項を突き合わせる。対応の取り方:
 *  1. 新しい版の要求事項が previous_item_code を持ち、旧版にその項番があれば、その要求事項と対応（項番が違えば改番）
 *  2. それ以外は同じ項番の要求事項と対応（1 で既に対応した旧版の要求事項は使わない）
 *  3. 対応の無い新しい版の要求事項は追加、対応の無い旧版の要求事項は削除
 */
export function diffFrameworkItems(
  fromItems: readonly DiffItem[],
  toItems: readonly DiffItem[],
): FrameworkDiff {
  const fromByCode = new Map(fromItems.map((i) => [i.code, i]));
  const claimed = new Set<Uuid>();
  const matches = new Map<Uuid, DiffItem>();

  // 1. 前の版の項番（改番の手掛かり）を優先する
  for (const item of toItems) {
    const previous = item.previousItemCode ? fromByCode.get(item.previousItemCode) : undefined;
    if (previous && !claimed.has(previous.id)) {
      matches.set(item.id, previous);
      claimed.add(previous.id);
    }
  }
  // 2. 同じ項番
  for (const item of toItems) {
    if (matches.has(item.id)) continue;
    const same = fromByCode.get(item.code);
    if (same && !claimed.has(same.id)) {
      matches.set(item.id, same);
      claimed.add(same.id);
    }
  }

  const entries: FrameworkDiffEntry[] = [];
  for (const item of toItems) {
    const before = matches.get(item.id);
    if (!before) {
      entries.push({
        kind: 'added',
        fromItemId: null,
        toItemId: item.id,
        fromCode: null,
        toCode: item.code,
        title: item.questionText,
        textChanged: false,
      });
      continue;
    }
    const changedText = textDiffers(before, item);
    const kind: FrameworkDiffKind =
      before.code !== item.code ? 'renumbered' : changedText ? 'changed' : 'unchanged';
    entries.push({
      kind,
      fromItemId: before.id,
      toItemId: item.id,
      fromCode: before.code,
      toCode: item.code,
      title: item.questionText,
      textChanged: changedText,
    });
  }
  for (const item of fromItems) {
    if (claimed.has(item.id)) continue;
    entries.push({
      kind: 'removed',
      fromItemId: item.id,
      toItemId: null,
      fromCode: item.code,
      toCode: null,
      title: item.questionText,
      textChanged: false,
    });
  }

  return {
    entries,
    added: entries.filter((e) => e.kind === 'added'),
    removed: entries.filter((e) => e.kind === 'removed'),
    changed: entries.filter((e) => e.kind === 'changed'),
    renumbered: entries.filter((e) => e.kind === 'renumbered'),
    unchangedCount: entries.filter((e) => e.kind === 'unchanged').length,
  };
}

/** 旧版の要求事項 ID → 新しい版の要求事項 ID（改番・文言の変更・変更なしの対応。追加・削除は含めない） */
export function itemMappingOf(diff: FrameworkDiff): Map<Uuid, Uuid> {
  const out = new Map<Uuid, Uuid>();
  for (const entry of diff.entries) {
    if (entry.fromItemId && entry.toItemId) out.set(entry.fromItemId, entry.toItemId);
  }
  return out;
}
