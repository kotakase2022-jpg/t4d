import { describe, expect, it } from 'vitest';
import { diffFrameworkItems, itemMappingOf, type DiffItem } from '@/lib/domain/framework-diff';

/**
 * 基準の版どうしの差分（トライアル対応 NF-08。unit:framework-diff）。
 * 改番（previous_item_code で対応が取れる要求事項）を削除＋追加と区別する。
 */

function item(
  id: string,
  code: string,
  text: string,
  previousItemCode: string | null = null,
): DiffItem {
  return { id, code, questionText: text, guidance: '', previousItemCode };
}

describe('diffFrameworkItems', () => {
  const from = [
    item('a1', 'A-1', 'ガバナンス'),
    item('a2', 'A-2', '戦略'),
    item('a3', 'A-3', 'リスク管理'),
    item('a4', 'A-4', '指標'),
  ];

  it('改番・文言の変更・追加・削除・変更なしを区別する', () => {
    const to = [
      item('b1', 'A-1', 'ガバナンス'),
      item('b2', 'B-2', '戦略', 'A-2'),
      item('b3', 'A-3', 'リスク管理（改）'),
      item('b5', 'A-5', '移行計画'),
    ];
    const diff = diffFrameworkItems(from, to);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.renumbered.map((e) => [e.fromCode, e.toCode, e.textChanged])).toEqual([
      ['A-2', 'B-2', false],
    ]);
    expect(diff.changed.map((e) => e.toCode)).toEqual(['A-3']);
    expect(diff.added.map((e) => e.toCode)).toEqual(['A-5']);
    expect(diff.removed.map((e) => e.fromCode)).toEqual(['A-4']);
    expect([...itemMappingOf(diff).entries()].sort()).toEqual(
      [
        ['a1', 'b1'],
        ['a2', 'b2'],
        ['a3', 'b3'],
      ].sort(),
    );
  });

  it('前の版の項番を優先する（同じ項番が別の要求事項に使われても改番として取る）', () => {
    const to = [item('b1', 'A-2', '新しい要求事項'), item('b2', 'A-3', '戦略', 'A-2')];
    const diff = diffFrameworkItems(from.slice(0, 2), to);
    expect(diff.renumbered.map((e) => [e.fromItemId, e.toItemId])).toEqual([['a2', 'b2']]);
    expect(diff.added.map((e) => e.toItemId)).toEqual(['b1']);
    expect(diff.removed.map((e) => e.fromItemId)).toEqual(['a1']);
  });

  it('改番と同時に文言が変われば textChanged', () => {
    const diff = diffFrameworkItems([item('a1', 'A-1', '旧')], [item('b1', 'B-1', '新', 'A-1')]);
    expect(diff.renumbered[0]!.textChanged).toBe(true);
  });
});
