import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fid } from '@/lib/fixtures/ids';
import { getDb } from '@/lib/repositories';
import { readEvidenceFileBytes } from '@/lib/storage';

/**
 * Evidence の画面内表示用に実体を同一オリジンで返す（EVID-P0-002）。
 *
 * - ダウンロードではなく inline 表示（CSP が同一オリジン iframe / img のみ許可のため、
 *   Supabase Mode でも Signed URL ではなくサーバー経由で返す）。
 * - 認可は `readEvidenceFileBytes`（自組織の所有ファイルで、資料の閲覧権限がある人のみ。
 *   Demo Mode ではこれが唯一の防御なので、URL 直打ちでも他社ファイル・権限外は 404）。
 * - 表示を許すのは画像と PDF だけ。それ以外（HTML 等）は inline にすると
 *   XSS の持ち込み口になるため拒否する。
 * - 画面で表示した記録を storage_access_events（action='viewed'）に残す（トライアル対応 NF-26。
 *   企業側の監査ログ画面に出る）。記録の失敗で表示を止めない。
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const fileVersionId = url.searchParams.get('fileVersionId');
  if (!fileVersionId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const db = await getDb();
  // 資料の閲覧権限が無い人（登録だけの取引先の入力担当など）にも、他社・削除済みと同じ 404 を返す
  const stored = await readEvidenceFileBytes(db, session.context, fileVersionId);
  if (!stored) {
    return NextResponse.json(
      {
        error: 'content_unavailable',
        message:
          '実体を取得できません（他社のファイル、削除済み、または Demo Mode の再起動で実体が失われた場合）。',
      },
      { status: 404 },
    );
  }

  if (!INLINE_TYPES.has(stored.mimeType)) {
    return NextResponse.json(
      { error: 'unsupported_inline_type', message: 'この形式は画面内表示に対応していません。' },
      { status: 415 },
    );
  }

  // 読めたのは自組織の資料だけ（readEvidenceFileBytes が所有を確かめる）。本人名義で記録する
  try {
    const now = new Date().toISOString();
    await db.insert('storageAccessEvents', [
      {
        id: fid('storage_access_event', `${fileVersionId}/viewed/${now}/${session.context.userId}`),
        organizationId: session.context.workspace.organizationId,
        actorUserId: session.context.userId,
        fileVersionId,
        action: 'viewed',
        engagementId: null,
        expiresAt: null,
        createdAt: now,
      },
    ]);
  } catch (error) {
    console.error(
      '[t4d] 資料の表示の記録に失敗しました',
      error instanceof Error ? error.message : error,
    );
  }

  return new NextResponse(Buffer.from(stored.bytes), {
    headers: {
      'Content-Type': stored.mimeType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
