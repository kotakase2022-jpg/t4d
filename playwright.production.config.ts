import { defineConfig, devices } from '@playwright/test';

/**
 * 本番スモークテスト専用の設定。
 *
 *   PROD_BASE_URL=https://terrast-t4d.vercel.app pnpm test:e2e:prod
 *
 * ローカルの E2E（tests/e2e）とは分ける。ローカル一式に混ぜると
 * 本番へのアクセスが常時発生し、失敗の切り分けもできなくなるため。
 * webServer は起動しない（本番を叩く）。
 */
const BASE_URL = process.env.PROD_BASE_URL ?? 'https://terrast-t4d.vercel.app';

export default defineConfig({
  testDir: './tests/e2e-production',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 90_000,
  reporter: [['list']],
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
      name: 'chromium-production',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
