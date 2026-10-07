import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_COVERAGE, NO_E2E_YET } from '../e2e/feature-coverage';
import { exportedValueNames, isUseServer, listFiles, parse } from '../support/static-analysis';

/**
 * 機能 → E2E の対応表（plan §5.1-1・IF §7.4）。
 *  (a) 棚卸し（inventory-features.md §3）の全機能（F001〜F144）が表にある
 *  (b) 参照先の spec が実在する
 *  (c) Action の名前が 'use server' の export として実在する（改名・削除で表が古くならない）
 */

const inventory = readFileSync('docs/ui-redesign/inventory-features.md', 'utf8');
const inventoryIds = [...inventory.matchAll(/^\| (F\d{3}) +\|/gm)].map((m) => m[1]!);

const actionNames = new Set(
  listFiles('src')
    .map((file) => parse(file))
    .filter((sf) => isUseServer(sf))
    .flatMap((sf) => exportedValueNames(sf).map((e) => e.name)),
);

describe('機能 → E2E の対応表', () => {
  it('棚卸しの全機能（F001〜F144）が表にあり、表にだけある機能は無い', () => {
    expect(inventoryIds).toHaveLength(144);
    expect(Object.keys(FEATURE_COVERAGE).sort()).toEqual([...inventoryIds].sort());
  });

  it('参照先の spec が実在する', () => {
    const missing = Object.entries(FEATURE_COVERAGE).flatMap(([id, entry]) =>
      entry.specs === NO_E2E_YET
        ? []
        : entry.specs.filter((spec) => !existsSync(spec)).map((spec) => `${id}: ${spec}`),
    );
    expect(missing).toEqual([]);
  });

  it('Action の名前が実在する', () => {
    const missing = Object.entries(FEATURE_COVERAGE)
      .filter(([, entry]) => entry.action !== null && !actionNames.has(entry.action))
      .map(([id, entry]) => `${id}: ${entry.action}`);
    expect(missing).toEqual([]);
  });

  it('E2E の無い機能の数を増やさない（足したら表を直して数を下げる）', () => {
    const without = Object.values(FEATURE_COVERAGE).filter((e) => e.specs === NO_E2E_YET).length;
    expect(without).toBeLessThanOrEqual(33);
  });
});
