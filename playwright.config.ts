import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // skip-guard: 基準に無い skip があれば実行を失敗にする（操作を L2 へ移して黙って skip になるのを防ぐ。
  // docs/ui-redesign/plan.md §5.2）
  reporter: [
    ['list'],
    ...(process.env.CI ? [['html', { open: 'never' }] as const] : []),
    ['./tests/support/skip-guard-reporter.ts', { configName: 'e2e' }],
  ],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // PC 専用アプリのため最小想定幅 1280px を下回らない
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_APP_MODE: 'demo',
      NEXT_TELEMETRY_DISABLED: '1',
      // E2E は決定論的な MockAIProvider で回す。
      // .env.local に OPENAI_API_KEY があると next start が読み込んでしまい、
      // テストが課金 API を叩き非決定的になるため、ここで明示的に空へ落とす。
      OPENAI_API_KEY: '',
    },
  },
});
