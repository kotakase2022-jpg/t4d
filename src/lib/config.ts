/**
 * アプリ動作モードの判定。
 *
 * - `demo`     : Supabase 環境変数なしでも全画面が動く。架空 Fixture のみ。
 * - `supabase` : Supabase Auth / Postgres / Storage / RLS を使用。
 *
 * `NEXT_PUBLIC_APP_MODE` が明示されていればそれを優先し、
 * 無ければ Supabase 環境変数の有無から自動判定する。
 */

export const APP_MODES = ['demo', 'supabase'] as const;
export type AppMode = (typeof APP_MODES)[number];

function readPublicEnv(key: string): string | undefined {
  // Next.js は NEXT_PUBLIC_* をビルド時に静的置換するため、
  // 動的アクセスではなく個別参照する必要がある。
  switch (key) {
    case 'NEXT_PUBLIC_APP_MODE':
      return process.env.NEXT_PUBLIC_APP_MODE;
    case 'NEXT_PUBLIC_SUPABASE_URL':
      return process.env.NEXT_PUBLIC_SUPABASE_URL;
    case 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY':
      return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    case 'NEXT_PUBLIC_APP_URL':
      return process.env.NEXT_PUBLIC_APP_URL;
    default:
      return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getSupabasePublicConfig(): { url: string; publishableKey: string } | null {
  const url = nonEmpty(readPublicEnv('NEXT_PUBLIC_SUPABASE_URL'));
  const publishableKey = nonEmpty(readPublicEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

export function getAppMode(): AppMode {
  const explicit = nonEmpty(readPublicEnv('NEXT_PUBLIC_APP_MODE'));
  if (explicit === 'supabase') return 'supabase';
  if (explicit === 'demo') return 'demo';
  return getSupabasePublicConfig() ? 'supabase' : 'demo';
}

export function isDemoMode(): boolean {
  return getAppMode() === 'demo';
}

export function getAppUrl(): string {
  return nonEmpty(readPublicEnv('NEXT_PUBLIC_APP_URL')) ?? 'http://localhost:3000';
}

/** Server 専用。ブラウザから呼ばれた場合は例外を投げる。 */
export function getServiceRoleKey(): string | null {
  if (typeof window !== 'undefined') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must never be read on the client.');
  }
  return nonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY) ?? null;
}

/** Server 専用。 */
export function getOpenAiConfig(): {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxRetries: number;
} {
  if (typeof window !== 'undefined') {
    throw new Error('OPENAI_API_KEY must never be read on the client.');
  }
  return {
    apiKey: nonEmpty(process.env.OPENAI_API_KEY) ?? null,
    model: nonEmpty(process.env.OPENAI_MODEL) ?? 'gpt-4.1-mini',
    timeoutMs: Number(nonEmpty(process.env.OPENAI_TIMEOUT_MS) ?? 60_000),
    maxRetries: Number(nonEmpty(process.env.OPENAI_MAX_RETRIES) ?? 2),
  };
}

export const APP_NAME = 'TERRAST for Disclosure';
export const APP_SHORT_NAME = 'T4D';
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';
export const DEFAULT_LOCALE = 'ja-JP';
/** 実装・Fixture の基準日（docs/assumptions.md E-3）。 */
export const FIXTURE_TODAY = '2026-08-14';
