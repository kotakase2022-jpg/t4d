import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportedValueNames, isUseServer, parse } from '../support/static-analysis';
import { B1_DANGEROUS_OPS } from './fixtures/dangerous-ops/B1';
import { B2_DANGEROUS_OPS } from './fixtures/dangerous-ops/B2';
import { B3_DANGEROUS_OPS } from './fixtures/dangerous-ops/B3';
import { B4_DANGEROUS_OPS } from './fixtures/dangerous-ops/B4';
import { B5_DANGEROUS_OPS } from './fixtures/dangerous-ops/B5';
import { B6_DANGEROUS_OPS } from './fixtures/dangerous-ops/B6';
import type { DangerousOp } from './fixtures/dangerous-ops/types';

/**
 * 危険な操作が確認を通る（plan §1.16・§5.2）。静的な検査。
 *
 *  - 不可逆（irreversible）・一括／上書き（bulk）: 起点の部品が ConfirmDialog か、確認付きの操作
 *    （kind: 'confirm'・BulkActionSpec の confirm）で Server Action を起動する
 *  - 可逆（reversible）: 実行後の通知に「元に戻す」（FlashMessage の undo）を置く、または確認を通す
 * 表はスライスごと（tests/unit/fixtures/dangerous-ops/B1〜B6.ts）。移したら status を done にする。
 * 表と実装の食い違い（done なのに確認が無い・確認を付けたのに pending のまま）は失敗にする。
 */

const ALL: Array<[string, DangerousOp[]]> = [
  ['B1', B1_DANGEROUS_OPS],
  ['B2', B2_DANGEROUS_OPS],
  ['B3', B3_DANGEROUS_OPS],
  ['B4', B4_DANGEROUS_OPS],
  ['B5', B5_DANGEROUS_OPS],
  ['B6', B6_DANGEROUS_OPS],
];

/** plan §1.16 の 3 区分に割り当てた機能 ID（漏れなく表にあること） */
const PLAN_IDS = [
  'F102',
  'F099',
  'F135',
  'F122',
  'F103',
  'F028',
  'F051',
  'F032',
  'F113',
  'F019',
  'F016',
  'F063',
  'F029',
  'F017',
  'F074',
  'F130',
  'F118',
  'F115',
  'F053',
  'F035',
  'F048',
];

const CONFIRM_PATTERNS = [/<ConfirmDialog\b/, /kind:\s*'confirm'/, /\bconfirm:\s*\{/];
const UNDO_PATTERNS = [/\bundo=\{/, /\bundo:\s*\{/];

function guarded(op: DangerousOp): boolean {
  const name = op.action.split('#')[1]!;
  const patterns =
    op.tier === 'reversible' ? [...UNDO_PATTERNS, ...CONFIRM_PATTERNS] : CONFIRM_PATTERNS;
  return op.origins.some((file) => {
    if (!existsSync(file)) return false;
    const text = readFileSync(file, 'utf8');
    return text.includes(name) && patterns.some((re) => re.test(text));
  });
}

describe('危険な操作の確認', () => {
  const ops = ALL.flatMap(([, list]) => list);

  it('plan §1.16 の全機能が表にあり、重複しない', () => {
    expect(ops.map((op) => op.id).sort()).toEqual([...PLAN_IDS].sort());
  });

  it.each(ops.map((op) => [op.id, op] as const))('%s: Server Action が実在する', (_id, op) => {
    const [file, name] = op.action.split('#') as [string, string];
    const sf = parse(`${process.cwd()}/${file}`);
    expect(isUseServer(sf), file).toBe(true);
    expect(exportedValueNames(sf).map((e) => e.name)).toContain(name);
  });

  it.each(ALL)(
    '%s: done の操作は起点で確認（元に戻す）を通り、pending は表のとおり未対応',
    (_slice, list) => {
      for (const op of list) {
        if (op.status === 'done') {
          expect(guarded(op), `${op.id} ${op.label} は確認を通っていない`).toBe(true);
        } else {
          expect(
            guarded(op),
            `${op.id} ${op.label} は確認を通っている。表の status を done にする`,
          ).toBe(false);
        }
      }
    },
  );
});
