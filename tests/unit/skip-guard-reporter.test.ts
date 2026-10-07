import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import SkipGuardReporter from '@tests/support/skip-guard-reporter';

/**
 * skip が増えない（plan §5.2）。基準に無い skip があれば実行全体を失敗にする。
 * test.skip()・test.fixme() の注記があるものだけを数え、serial で「実行されなかった」ものは数えない。
 */

let dir = '';
let baselineFile = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't4d-skip-guard-'));
  baselineFile = join(dir, 'skip-baseline.json');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function testCase(title: string, annotations: Array<{ type: string }>): TestCase {
  return {
    titlePath: () => ['', 'chromium-desktop', 'a.spec.ts', title],
    annotations,
  } as unknown as TestCase;
}

const skipped = { status: 'skipped', annotations: [] } as unknown as TestResult;
const passed = { status: 'passed' } as FullResult;

function reporterWith(known: string[]): SkipGuardReporter {
  writeFileSync(baselineFile, JSON.stringify({ e2e: known }));
  return new SkipGuardReporter({ configName: 'e2e', baselineFile });
}

describe('SkipGuardReporter', () => {
  it('基準に無い test.skip があれば失敗にする', async () => {
    const reporter = reporterWith([]);
    reporter.onTestEnd(testCase('一覧が空なら飛ばす', [{ type: 'skip' }]), skipped);
    expect(await reporter.onEnd(passed)).toEqual({ status: 'failed' });
  });

  it('serial で実行されなかったもの（注記なし）は skip として数えない', async () => {
    const reporter = reporterWith([]);
    reporter.onTestEnd(testCase('前のテストが失敗して実行されなかった', []), skipped);
    expect(await reporter.onEnd(passed)).toBeUndefined();
  });

  it('基準にある skip は許す', async () => {
    const reporter = reporterWith(['chromium-desktop › a.spec.ts › 既知の skip']);
    reporter.onTestEnd(testCase('既知の skip', [{ type: 'fixme' }]), skipped);
    expect(await reporter.onEnd(passed)).toBeUndefined();
  });
});
