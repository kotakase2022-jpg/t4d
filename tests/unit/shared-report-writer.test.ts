import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/repositories/types';

/**
 * 共有レポートの写しを書く DbClient（レビュー指摘 SEC-01。unit:shared-report-writer）。
 * 写しは利用者の JWT では書けない（0059）。Supabase Mode では Service Role のクライアントで書き、
 * 利用者のクライアント（呼び出し元の db）へは INSERT しない。Demo Mode はそのままの db。
 */

const serviceRoleClient = { marker: 'service-role' };
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServiceRoleClient: () => serviceRoleClient,
}));

const { sharedReportCopyWriter } = await import('@/lib/repositories/privileged');
const { SupabaseDbClient } = await import('@/lib/repositories/supabase-client');

describe('sharedReportCopyWriter', () => {
  it('Supabase Mode では利用者のクライアントではなく Service Role のクライアントを返す', async () => {
    const userDb = { mode: 'supabase' } as unknown as DbClient;
    const writer = await sharedReportCopyWriter(userDb);
    expect(writer).not.toBe(userDb);
    expect(writer).toBeInstanceOf(SupabaseDbClient);
    expect((writer as unknown as { client: unknown }).client).toBe(serviceRoleClient);
  });

  it('Demo Mode はそのままの db（RLS が無いため、アプリ層の検査だけで書く）', async () => {
    const demoDb = { mode: 'demo' } as unknown as DbClient;
    expect(await sharedReportCopyWriter(demoDb)).toBe(demoDb);
  });
});
