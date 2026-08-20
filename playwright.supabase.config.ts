import { defineConfig, devices } from '@playwright/test';

/**
 * Supabase Mode の E2E。
 *
 *   supabase start && supabase db reset
 *   pnpm test:e2e:supabase
 *
 * 既定の playwright.config.ts は Demo Mode を検証する。
 * こちらは **実 Supabase（Auth + Postgres + RLS + Storage）** に接続した状態で
 * アプリが動くことを確認する。
 *
 * 接続先は `supabase status` が出力するローカル既定値。
 * これは Supabase CLI が全環境で共有する公開のローカル開発用キーであり、秘密情報ではない。
 */

const PORT = Number(process.env.E2E_SUPABASE_PORT ?? 3200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

export default defineConfig({
  testDir: './tests/e2e-supabase',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
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
      name: 'chromium-supabase',
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
      NEXT_PUBLIC_APP_MODE: 'supabase',
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SUPABASE_KEY,
      // 監査ログの追記は Service Role の許可用途（指示書 11-14）。
      // これは Supabase CLI のローカル既定値であり、秘密情報ではない。
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz',
      NEXT_TELEMETRY_DISABLED: '1',
      // E2E は決定論的な MockAIProvider で回す。
      // .env.local に OPENAI_API_KEY があると next start が読み込んでしまい、
      // テストが課金 API を叩き非決定的になるため、ここで明示的に空へ落とす。
      OPENAI_API_KEY: '',
    },
  },
});
