import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { measureRatchet, RATCHET_KEYS, RATCHET_LABELS } from './ui-metrics-core';

/**
 * UI の指標を数えて JSON に書く（docs/ui-redesign/plan.md §0.2・§5.1-3）。
 *
 *   pnpm exec tsx scripts/ui-metrics.ts --out docs/ui-redesign/metrics-after.json
 *   pnpm exec tsx scripts/ui-metrics.ts --root <別の作業ツリー> --out …   # 変更前のツリーを数える
 *
 * 画面を開いて数える指標（primary の数・クリック数）は E2E（primary-action-audit・task-paths）が測る。
 * ここはソースから数えられるもの（段階的上限の各項目）だけ。
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const root = resolve(arg('--root') ?? process.cwd());
  const out = arg('--out');
  const report = measureRatchet(root);
  const payload = {
    measuredAt: new Date().toISOString(),
    root: root === resolve(process.cwd()) ? '.' : root,
    labels: RATCHET_LABELS,
    totals: report.totals,
  };
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(payload, null, 2)}\n`);
  }
  // --baseline: 段階的上限の基準値を書き直す（件数を減らしたとき・Stage C が最終値へ下げるとき）
  const baseline = arg('--baseline');
  if (baseline) {
    writeFileSync(
      resolve(baseline),
      `${JSON.stringify(
        {
          note: 'UI の段階的上限（docs/ui-redesign/plan.md §3.4-4）。tests/unit/ui-ratchet.test.ts が「今の件数 ≤ この値」を検査する。Stage B は増やせない（減らしたら数値を下げてよい）。Stage C が最終値へ下げ、0 にできるものは ESLint のエラーにする',
          labels: RATCHET_LABELS,
          totals: report.totals,
        },
        null,
        2,
      )}\n`,
    );
  }
  for (const key of RATCHET_KEYS) {
    console.log(`${String(report.totals[key]).padStart(5)}  ${RATCHET_LABELS[key]}`);
  }
}

if (process.argv[1]?.endsWith('ui-metrics.ts')) main();
