import { describe, expect, it } from 'vitest';
import { METRIC_UNIDENTIFIED_WARNING, visibleRowWarnings } from '@/lib/imports/hidden-warnings';
import { NOTE_ROW_WARNING, TOTAL_ROW_WARNING } from '@/lib/imports/row-role';

/**
 * 取込プレビューで出さないと決めた警告の絞り込み。
 *
 * 落とすのは「指標を特定できませんでした」だけで、
 * 二重計上（合計行）や単位違いのような、確定を間違えると台帳が壊れる警告は
 * 必ず残さなければならない。まとめて消えていないことを検査する。
 */

describe('visibleRowWarnings', () => {
  it('「指標を特定できませんでした」を落とす', () => {
    expect(visibleRowWarnings([METRIC_UNIDENTIFIED_WARNING])).toEqual([]);
  });

  it('合計行・注記行の警告は残す（二重計上を防ぐため）', () => {
    expect(visibleRowWarnings([TOTAL_ROW_WARNING, NOTE_ROW_WARNING])).toEqual([
      TOTAL_ROW_WARNING,
      NOTE_ROW_WARNING,
    ]);
  });

  it('他の警告と並んでいても、指標の警告だけを落とす', () => {
    const warnings = [
      TOTAL_ROW_WARNING,
      METRIC_UNIDENTIFIED_WARNING,
      '組織・拠点を特定できませんでした。',
      '数値を検出できませんでした。',
      '単位が指標定義（t-CO2e）と異なります（検出: kg）。',
    ];
    expect(visibleRowWarnings(warnings)).toEqual([
      TOTAL_ROW_WARNING,
      '組織・拠点を特定できませんでした。',
      '数値を検出できませんでした。',
      '単位が指標定義（t-CO2e）と異なります（検出: kg）。',
    ]);
  });

  it('警告が無い行は空のまま', () => {
    expect(visibleRowWarnings([])).toEqual([]);
  });

  it('元の配列を書き換えない（保存済みの行の内容は変えない）', () => {
    const warnings = [METRIC_UNIDENTIFIED_WARNING, TOTAL_ROW_WARNING];
    visibleRowWarnings(warnings);
    expect(warnings).toHaveLength(2);
  });
});
