import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { fid } from '@/lib/fixtures/ids';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
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
 *
 * `engagementId` を付けて呼ばれたら、その案件がこの資料の組織の案件で、利用者がその案件のメンバーのときだけ
 * アクセスの記録に案件を残す（トライアル対応 NF-26。保証側のアクセスを企業側の監査ログで案件ごとに辿る）。
 * 案件の値は記録にだけ使い、認可には使わない（権限の判定は変えない）。企業の利用者の取得は案件に結び付けない
 * （監査法人の案件の記録へ企業側の操作を混ぜない）。
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
  // 署名付きリンクの発行（canReadEvidence）と同じく、資料の閲覧権限が要る。
  // 登録だけの権限の人には、存在の有無を区別しない 404 を返す
  if (!can(session.context, 'enterprise.evidence.read')) {
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

  const engagementId = await engagementOfFile(
    db,
    url.searchParams.get('engagementId'),
    version,
    session.context.engagementIds,
  );
  const now = new Date().toISOString();
  await db.insert('storageAccessEvents', [
    {
      id: fid('storage_access_event', `${version.id}/downloaded/${now}/${session.context.userId}`),
      organizationId: version.organizationId,
      actorUserId: session.context.userId,
      fileVersionId: version.id,
      action: 'downloaded',
      engagementId,
      expiresAt: null,
      createdAt: now,
    },
  ]);
  await recordAuditEvent(db, session.context, {
    eventType: 'file_downloaded',
    resourceType: 'file_version',
    resourceId: version.id,
    engagementId,
  });

  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': contentDisposition(file.originalName),
      'Cache-Control': 'no-store',
    },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 記録に残す案件（この資料の組織がクライアントで、利用者がメンバーの案件だけ。形の合わない値・他の案件は残さない）
 */
async function engagementOfFile(
  db: Awaited<ReturnType<typeof getDb>>,
  raw: string | null,
  version: { organizationId: string },
  memberOf: readonly string[],
): Promise<string | null> {
  if (!raw || !UUID_PATTERN.test(raw) || !memberOf.includes(raw)) return null;
  const engagement = await db.findById('engagements', raw);
  return engagement && engagement.clientOrganizationId === version.organizationId
    ? engagement.id
    : null;
}
