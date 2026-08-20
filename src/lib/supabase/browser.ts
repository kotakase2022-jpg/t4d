'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabasePublicConfig } from '@/lib/config';

let cached: SupabaseClient | null = null;

/**
 * ブラウザ用 Supabase クライアント。
 * Publishable(anon) key のみを使用し、Service Role Key は決して渡さない。
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  const config = getSupabasePublicConfig();
  if (!config) return null;
  if (!cached) {
    cached = createBrowserClient(config.url, config.publishableKey);
  }
  return cached;
}
