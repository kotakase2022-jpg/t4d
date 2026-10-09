import 'server-only';

import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, PermissionKey } from '@/types/domain';

/**
 * 権限で断った操作の記録（トライアル対応 NF-27。監査ログ access_denied）。
 *
 * 記録するのは「どの権限が足りなかったか」と「どの画面・API のパターンか」だけ。
 * URL の ID・クエリ・入力値・メッセージ本文は入れない（個人情報・内部 ID を監査ログに残さない）。
 * 記録に失敗しても元の応答（403・?error=）は変えない（記録のために利用者の操作を失敗させない）。
 */

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
/** 英数字の長い塊（トークン・ハッシュ・コードの類）も ID として伏せる */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;

/** URL の区切りを戻す（壊れた %xx は null） */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * パスをルートのパターンにする（例: /enterprise/disclosure-projects/<uuid>/blocks/<uuid>?tab=x →
 * /enterprise/disclosure-projects/[id]/blocks/[id]）。アプリ内のパスでなければ「(不明)」
 */
export function routePatternOf(pathOrUrl: string): string {
  let path = pathOrUrl;
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) path = new URL(pathOrUrl).pathname;
  } catch {
    return '(不明)';
  }
  path = path.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return '(不明)';
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      const decoded = safeDecode(s);
      if (decoded === null) return '[id]';
      if (
        UUID_SEGMENT.test(decoded) ||
        NUMERIC_SEGMENT.test(decoded) ||
        OPAQUE_SEGMENT.test(decoded)
      ) {
        return '[id]';
      }
      // 日本語・記号を含む区切り（名前など）は伏せる。ルートの区切りは英小文字・数字・ハイフンだけ
      return /^[a-z0-9-]+$/.test(decoded) ? decoded : '[id]';
    });
  return `/${segments.join('/')}`.slice(0, 200);
}

export interface AccessDeniedInput {
  permission?: PermissionKey | null;
  /** 画面・API のパスか URL（パターンにしてから記録する） */
  route: string;
}

/** 監査ログに access_denied を追記する（失敗しても投げない） */
export async function recordAccessDenied(
  db: DbClient,
  ctx: AuthorizationContext | null,
  input: AccessDeniedInput,
): Promise<void> {
  try {
    await recordAuditEvent(db, ctx, {
      eventType: 'access_denied',
      resourceType: null,
      resourceId: null,
      afterSummary: '権限が無いため操作を断りました',
      metadata: {
        permission: input.permission ?? null,
        route: routePatternOf(input.route),
      },
    });
  } catch {
    // 記録できなくても、断った応答はそのまま返す
  }
}

/**
 * 出力 API の共通の 403。記録してから { error: 'forbidden' } を返す（既存の応答の形を変えない）
 */
export async function accessDeniedResponse(
  db: DbClient,
  ctx: AuthorizationContext | null,
  input: {
    permission?: PermissionKey | null;
    request: Request | string;
    body?: Record<string, unknown>;
  },
): Promise<NextResponse> {
  await recordAccessDenied(db, ctx, {
    permission: input.permission ?? null,
    route: typeof input.request === 'string' ? input.request : input.request.url,
  });
  return NextResponse.json(input.body ?? { error: 'forbidden' }, { status: 403 });
}
