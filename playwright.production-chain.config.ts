import { defineConfig, devices } from '@playwright/test';

/**
 * 本番（Vercel の Demo Mode）で、開示優先モードの実演の流れを 1 つのブラウザで通す。
 *
 *   PROD_BASE_URL=https://terrast-t4d.vercel.app pnpm exec playwright test --config playwright.production-chain.config.ts
 *
 * 本番ではリクエストごとに別インスタンスへ届き得るため、状態は Cookie にしか残らない。
 * 発表者と同じく 1 つのブラウザの Cookie を最後まで持ち回す（metadata.carryDemoState）。
 * 最後のテストで開示デモを初期状態に戻し、開示優先モードを OFF にする（共有のデモ状態を既定へ戻す）。
 * Scope1・2 の算定と照合の流れ（zzzzzz-ghg-chain）も最後に開示デモを初期状態に戻す（GHG の表もリセットの範囲）。
 * サーバーは起動しない（本番に当てる）。
 */
const BASE_URL = process.env.PROD_BASE_URL ?? 'https://terrast-t4d.vercel.app';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'zz-disclosure-project.spec.ts',
    'zzz-csrd-chain.spec.ts',
    'zzzzz-trial-chain.stateless.ts',
    // Scope1・2 の算定と照合の流れ（最後に開示デモを初期状態に戻す）
    'zzzzzz-ghg-chain.stateless.ts',
  ],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 20_000 },
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
      name: 'chromium-production-chain',
      metadata: { carryDemoState: true },
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
