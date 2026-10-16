import { defineConfig, devices } from '@playwright/test';

/**
 * 「すべてのリクエストが別インスタンスに届く」最悪の場合の E2E（Demo Mode）。
 *
 *   E2E_PORT=3219 pnpm test:e2e:stateless
 *
 * 本番（Vercel の Demo Mode）は外部ストアを持たず、状態はインスタンスのメモリと Cookie にしか無い。
 * 2026-09-30 に本番で実演の流れ（zz-disclosure-project.spec.ts）を流したところ、標準 CSV の
 * 「検証」と「登録を確定」が別インスタンスに届き、確定が「検証結果の有効期限が切れました」で止まった。
 * ローカルの 1 プロセスではメモリが残るため再現しない。
 *
 * そこでサーバーを `T4D_DEMO_FRESH_FIXTURE_PER_REQUEST=1` で起動し、リクエストごとに Fixture を
 * 作り直す（src/lib/repositories/demo-fresh-fixture.ts）。Cookie とブラウザが持ち回した状態だけが残る。
 *
 * ブラウザ側は、実演の発表者と同じく**1 つのブラウザの Cookie を最後まで持ち回す**
 * （metadata.carryDemoState。tests/e2e/helpers.ts）。通常の E2E はテストごとに新しいブラウザの
 * 文脈を作り、共有のメモリを通じて前のテストの状態を引き継いでいるが、ここではメモリが残らないため。
 *
 * - 既存のサーバーは再利用しない（切替の無いサーバーに当たると、何も確かめずに通ってしまう）。
 * - 他の E2E と同時に流さない（ビルドの出力 .next を共有する。記憶: E2E は単独で実行）。
 */
const PORT = Number(process.env.E2E_PORT ?? 3219);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // 実演の流れ（zz-disclosure-project）と読み取りだけの導線、この構成でだけ意味のある作業本文の控えの確認、
  // CSRD の流れ（zzz-csrd-chain。DMA の判断・確定 → AI 分析の採用 → 計画 → 収集項目 → 草案の確定。
  // docs/disclosure-first.md §9.7）。CSRD の流れは前の spec の Cookie を捨てて初期状態から始める
  testMatch: [
    'disclosure-first-nav.spec.ts',
    'editor-draft-restore.stateless.ts',
    'zz-disclosure-project.spec.ts',
    'zzz-csrd-chain.spec.ts',
    // 報告年度・収集キャンペーンの作成（結果の画面が別のサーバーに届いても行が出る）
    'zzzz-master-create.stateless.ts',
    // トライアル対応の「試行の流れ」（plan §4.3-6。開示デモのリセットから始め、Cookie だけで最後まで通す）
    'zzzzz-trial-chain.stateless.ts',
    // Scope1・2 の算定と照合の流れ（2026-10-16 の要望。リセット → 区分規則の承認 → 算定 → 照合 → 原因の記録
    // → 仮説の再計算 → トライアル概要。最後に開示デモを初期状態に戻す）
    'zzzzzz-ghg-chain.stateless.ts',
  ],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['./tests/support/skip-guard-reporter.ts', { configName: 'stateless' }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium-stateless',
      metadata: { carryDemoState: true },
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_APP_MODE: 'demo',
      NEXT_TELEMETRY_DISABLED: '1',
      OPENAI_API_KEY: '',
      T4D_DEMO_FRESH_FIXTURE_PER_REQUEST: '1',
    },
  },
});
