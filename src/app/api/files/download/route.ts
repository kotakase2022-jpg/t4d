import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { getAppMode } from '@/lib/config';
import { getDb } from '@/lib/repositories';
import { getStorageAdapter } from '@/lib/storage';
import { contentDisposition } from '@/lib/exports';
import type { StorageBucket } from '@/types/domain';

/**
 * Demo Mode の Signed URL 実体。
 *
 * Supabase Mode では Supabase Storage の Signed URL が直接使われるため、
 * このハンドラは Demo Mode でのみ有効。
 * 直接叩かれても、必ず DB（file_versions）で権限を再検証する。
 */
export async function GET(request: Request) {
  if (getAppMode() !== 'demo') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket') as StorageBucket | null;
  const key = url.searchParams.get('key');
  if (!bucket || !key) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const db = await getDb();

  // Storage Key から DB を引き直し、閲覧権限を再検証する（URL 直打ち対策）
  const versions = await db.select('fileVersions', { where: { storageKey: key }, limit: 1 });
  const version = versions[0];
  if (!version) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const file = await db.findById('files', version.fileId);
  if (!file || file.deletedAt || file.bucket !== bucket) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // storageKey を推測して直接叩かれても通さない。
  // Demo Mode の DbClient に行レベルの防御は無いので、ここで所有者を明示的に確認する
  // （bucket 一致だけでは他テナントのファイルが通ってしまう）。
  if (version.organizationId !== session.context.workspace.organizationId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const bytes = await getStorageAdapter().get(bucket, key);
  if (!bytes) {
    return NextResponse.json(
      {
        error: 'content_unavailable',
        message:
          'Demo Mode ではサーバー再起動でアップロード実体が失われます（Fixture 由来のファイルは実体を持ちません）。',
      },
      { status: 410 },
    );
  }

  await db.insert('storageAccessEvents', [
    {
      id: `${version.id}-${Date.now()}`,
      organizationId: version.organizationId,
      actorUserId: session.context.userId,
      fileVersionId: version.id,
      action: 'downloaded',
      engagementId: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    },
  ]);
  await recordAuditEvent(db, session.context, {
    eventType: 'file_downloaded',
    resourceType: 'file_version',
    resourceId: version.id,
  });

  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': contentDisposition(file.originalName),
      'Cache-Control': 'no-store',
    },
  });
}
