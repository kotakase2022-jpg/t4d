import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { readOwnedFileBytes } from '@/lib/storage';

/**
 * Evidence の画面内表示用に実体を同一オリジンで返す（EVID-P0-002）。
 *
 * - ダウンロードではなく inline 表示（CSP が同一オリジン iframe / img のみ許可のため、
 *   Supabase Mode でも Signed URL ではなくサーバー経由で返す）。
 * - 認可は `readOwnedFileBytes`（自組織の所有ファイルのみ。Demo Mode では
 *   これが唯一の防御なので、URL 直打ちでも他社ファイルは 404）。
 * - 表示を許すのは画像と PDF だけ。それ以外（HTML 等）は inline にすると
 *   XSS の持ち込み口になるため拒否する。
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
  const stored = await readOwnedFileBytes(db, session.context, fileVersionId);
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

  return new NextResponse(Buffer.from(stored.bytes), {
    headers: {
      'Content-Type': stored.mimeType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
