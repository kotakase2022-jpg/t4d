import 'server-only';

import { headers } from 'next/headers';
import { getAppMode, getServiceRoleKey } from '@/lib/config';
import { contentHash, fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type { AuditEvent, AuditEventType, AuthorizationContext, Uuid } from '@/types/domain';

export interface AuditInput {
  eventType: AuditEventType;
  resourceType?: string | null;
  resourceId?: Uuid | null;
  engagementId?: Uuid | null;
  beforeSummary?: string | null;
  afterSummary?: string | null;
  metadata?: Record<string, unknown>;
}

let sequence = 0;

/**
 * 監査ログの書き込みに使う DbClient。
 *
 * ログイン／ログイン失敗はまだ認証が確立していない（anon ロールの）状態で発生するため、
 * ユーザーの JWT クライアントでは INSERT できない。
 * 監査ログの追記は Service Role の許可用途（指示書 11-14）なので、
 * Supabase Mode では Service Role クライアントを使う。
 *
 * Service Role Key が無い場合は呼び出し元の db をそのまま使う（記録できる範囲で記録する）。
 */
async function auditClient(db: DbClient): Promise<DbClient> {
  if (getAppMode() !== 'supabase') return db;
  try {
    if (!getServiceRoleKey()) return db;
    const [{ createSupabaseServiceRoleClient }, { SupabaseDbClient }] = await Promise.all([
      import('@/lib/supabase/server'),
      import('@/lib/repositories/supabase-client'),
    ]);
    return new SupabaseDbClient(createSupabaseServiceRoleClient());
  } catch {
    return db;
  }
}

/**
 * 追記専用の監査ログ。
 *
 * 禁止事項（指示書 17 章）:
 *  - PII や Evidence 本文を丸ごと保存しない → `beforeSummary` / `afterSummary` は要約のみ
 *  - 生 IP を保存しない → ハッシュの先頭 16 文字だけを保存
 */
export async function recordAuditEvent(
  db: DbClient,
  ctx: AuthorizationContext | null,
  input: AuditInput,
): Promise<void> {
  const now = new Date().toISOString();
  sequence += 1;

  let clientIpHash: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    const forwarded = h.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() ?? h.get('x-real-ip');
    clientIpHash = ip ? contentHash(ip).slice(0, 16) : null;
    userAgent = h.get('user-agent')?.slice(0, 300) ?? null;
  } catch {
    // Route Handler 外（テスト等）では headers() が使えない
  }

  const event: AuditEvent = {
    id: fid('audit_event', `${now}-${sequence}-${input.eventType}-${input.resourceId ?? ''}`),
    actorUserId: ctx?.userId ?? null,
    actorOrganizationId: ctx?.workspace.organizationId ?? null,
    eventType: input.eventType,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    engagementId: input.engagementId ?? null,
    clientIpHash,
    userAgent,
    beforeSummary: truncate(input.beforeSummary),
    afterSummary: truncate(input.afterSummary),
    metadata: input.metadata ?? {},
    createdAt: now,
  };

  try {
    const client = await auditClient(db);
    await client.insert('auditEvents', [event]);
  } catch (error) {
    // 監査ログの書き込み失敗で業務処理そのものを落とさない。
    // （記録漏れは重大なので、サーバーログには必ず残す）
    console.error(
      `[t4d] 監査ログの記録に失敗しました: ${event.eventType}`,
      error instanceof Error ? error.message : error,
    );
  }
}

function truncate(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}
