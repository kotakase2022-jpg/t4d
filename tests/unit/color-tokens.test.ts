import { describe, expect, it } from 'vitest';
import { findUndefinedColorClasses } from '../../scripts/check-color-tokens';

/**
 * Tailwind v4 は未定義の色名を書いてもエラーにせず、単に何も適用しない。
 * 「充足度バーが無色」「警告枠が出ない」といった欠落がビルドを通ってしまうので、
 * ここで止める。
 */
describe('色トークン', () => {
  it('未定義の色クラスを参照していない', () => {
    const bad = findUndefinedColorClasses();
    const detail = [...bad.entries()].map(([cls, files]) => `${cls} (${files.join(', ')})`);
    expect(detail).toEqual([]);
  });
});
