import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * skip が増えない（docs/ui-redesign/plan.md §5.2）。
 *
 * 既存の spec には条件付きの `test.skip(count === 0, …)` が 36 か所ある。操作を L2（その他・行の操作・
 * 折りたたみ）へ移すと、失敗ではなく skip になって緑のまま通ってしまう。実行で skip になったテストを
 * 基準（tests/e2e/fixtures/skip-baseline.json。設定の名前ごと）と比べ、基準に無い skip があれば
 * 実行全体を失敗にする。
 *
 * 基準を記録するとき: SKIP_GUARD_RECORD=1 で全件を流す（部分実行・--list では記録しない。基準を広げる
 * 変更はレビューで理由を確かめる）。基準ファイルに設定の項目が無いときは検査できないので、警告だけを出す。
 */

const DEFAULT_BASELINE_FILE = 'tests/e2e/fixtures/skip-baseline.json';

type Baseline = Record<string, string[]>;

function readBaseline(file: string): Baseline {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return {};
  }
}

export default class SkipGuardReporter implements Reporter {
  private readonly skipped = new Set<string>();
  private readonly configName: string;
  private readonly baselineFile: string;

  constructor(options: { configName?: string; baselineFile?: string } = {}) {
    this.configName = options.configName ?? 'default';
    this.baselineFile = options.baselineFile ?? DEFAULT_BASELINE_FILE;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') return;
    // test.skip()・test.fixme() で飛ばしたものだけを数える。serial の describe で前のテストが失敗して
    // 「実行されなかった」もの（注記なし）は skip ではない（その実行は失敗として既に赤い）
    const annotations = [...test.annotations, ...(result.annotations ?? [])];
    if (!annotations.some((a) => a.type === 'skip' || a.type === 'fixme')) return;
    // 先頭はプロジェクト名（空のこともある）。ファイル名 › describe › テスト名で一意にする
    this.skipped.add(
      test
        .titlePath()
        .filter((part) => part !== '')
        .join(' › '),
    );
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    const baseline = readBaseline(this.baselineFile);
    const known = baseline[this.configName];
    const skipped = [...this.skipped].sort();

    if (process.env.SKIP_GUARD_RECORD === '1') {
      baseline[this.configName] = skipped;
      mkdirSync(dirname(this.baselineFile), { recursive: true });
      writeFileSync(this.baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
      console.warn(
        `[skip-guard] ${this.configName}: 基準を記録しました（skip ${skipped.length} 件）。${this.baselineFile}`,
      );
      return;
    }
    if (known === undefined) {
      console.warn(
        `[skip-guard] ${this.configName}: 基準（${this.baselineFile}）が無いため検査していません。` +
          'SKIP_GUARD_RECORD=1 で全件を流して記録してください。',
      );
      return;
    }

    const added = skipped.filter((title) => !known.includes(title));
    if (added.length === 0) return;
    console.error(
      `[skip-guard] ${this.configName}: 基準に無い skip が ${added.length} 件あります（操作を L2 へ移して` +
        '前提の要素が見つからなくなった可能性。テストを「開いてから確かめる」に直す）:\n' +
        added.map((title) => `  - ${title}`).join('\n'),
    );
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}
