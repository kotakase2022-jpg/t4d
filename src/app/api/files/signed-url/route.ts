import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { createEvidenceSignedUrl, StorageObjectMissingError } from '@/lib/storage';

/**
 * Evidence の Signed URL を発行し、そのままリダイレクトする。
 *
 * 権限検証は `createEvidenceSignedUrl` が DB（RLS / アプリ層）経由で行う。
 * 権限外は 404（存在を秘匿）。発行は storage_access_events と audit_events へ記録される。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const fileVersionId = url.searchParams.get('fileVersionId');
  const engagementId = url.searchParams.get('engagementId');
  if (!fileVersionId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const db = await getDb();
  let result;
  try {
    result = await createEvidenceSignedUrl(db, session.context, fileVersionId, {
      expiresInSeconds: 120,
      engagementId,
    });
  } catch (error) {
    // 権限は通ったが実体が無い場合。500 にすると「壊れている」ように見えるので、
    // download 経路と同じく 410 と理由を返す。
    if (error instanceof StorageObjectMissingError) {
      return NextResponse.json(
        {
          error: 'content_unavailable',
          message:
            'ファイルの実体がありません（Fixture 由来のファイルは実体を持ちません）。取込からアップロードし直してください。',
        },
        { status: 410 },
      );
    }
    throw error;
  }

  if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.redirect(new URL(result.url, url.origin), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
