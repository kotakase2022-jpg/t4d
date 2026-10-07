import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  measureRatchet,
  RATCHET_KEYS,
  RATCHET_LABELS,
  type RatchetCounts,
} from '../../scripts/ui-metrics-core';

/**
 * UI の段階的上限（plan §3.4-4・§5.2）。任意値の文字サイズ・hex 直書き・素の details/select/checkbox・
 * Card・Button type="submit"・title= の補足説明などの件数が、基準値（ui-ratchet-baseline.json）以下である。
 *
 * Stage B（6 スライス並行）は件数を増やせない。減らしたら基準値を下げてよい
 * （`pnpm exec tsx scripts/ui-metrics.ts --baseline docs/ui-redesign/ui-ratchet-baseline.json`）。
 * Stage C が最終値へ下げ、0 にしたものは ESLint のエラーにした（eslint.config.mjs の no-restricted-syntax）。
 */

const baseline = JSON.parse(readFileSync('docs/ui-redesign/ui-ratchet-baseline.json', 'utf8')) as {
  totals: RatchetCounts;
};

describe('UI の段階的上限', () => {
  const report = measureRatchet();

  it('基準値はすべての項目を持つ', () => {
    expect(Object.keys(baseline.totals).sort()).toEqual([...RATCHET_KEYS].sort());
  });

  it.each([...RATCHET_KEYS])('%s が基準値を超えない', (key) => {
    const now = report.totals[key];
    const limit = baseline.totals[key];
    const files = Object.entries(report.byFile)
      .filter(([, counts]) => (counts[key] ?? 0) > 0)
      .map(([file, counts]) => `${file}: ${counts[key]}`);
    expect(
      now,
      `${RATCHET_LABELS[key]} が ${now} 件（基準 ${limit} 件）。増やさないでください。\n${files.join('\n')}`,
    ).toBeLessThanOrEqual(limit);
  });

  it('Stage A・C で 0 にした項目は 0 のまま（ESLint のエラーと同じ集合）', () => {
    for (const key of [
      'arbitraryTextSize',
      'hexColorClass',
      'numericZIndex',
      'arbitraryShadow',
      'tailwindRounded',
      'variantOutline',
      'rawDetails',
      'rawSelect',
      'rawCheckbox',
      'buttonTypeSubmit',
      'buttonVariantsDirect',
      'dialogWithManyInputs',
      'legacyEmptyState',
    ] as const) {
      expect(report.totals[key], RATCHET_LABELS[key]).toBe(0);
    }
  });

  it('最終値（plan §0.2 の目標）: Card は 130 以下', () => {
    expect(report.totals.card).toBeLessThanOrEqual(130);
  });
});
