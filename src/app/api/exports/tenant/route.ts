import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import {
  buildTenantExport,
  TENANT_EXPORT_PARTS,
  type TenantExportPart,
} from '@/lib/services/tenant-export';

/** 画面（設定のデータの取扱い）から送ったときの印。失敗したら JSON ではなく画面へ理由を戻す */
const TENANT_EXPORT_FROM_SETTINGS = 'settings';

/** 画面へ戻すときの失敗の種類（画面は決まった文だけを出す。URL の文をそのまま出さない） */
type TenantExportError = 'part' | 'storage' | 'link';

/**
 * 全データの返却書き出し（トライアル対応 NF-29）。`?part=data`（表の CSV）・`?part=files`（資料の実体）。
 *
 * 組織の管理（enterprise.org.manage）と出力（enterprise.export.run）の両方を、ほかの何より先に検査する
 * （403 は JSON・監査ログ access_denied）。
 *  - Demo Mode: ZIP をそのまま返す（架空のデータで小さい）
 *  - Supabase Mode: 応答の大きさの上限を避けるため、非公開の保管庫（tenant-exports-private）に置き、
 *    有効期限つきの署名付きリンクへ移す。読めるのは組織の管理者だけ（0056 のポリシー）
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  const db = await getDb();
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.org.manage')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.org.manage', request });
  }
  if (!can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.export.run', request });
  }

  const url = new URL(request.url);
  // 設定の画面のフォームから送ったときは、失敗を生の JSON ではなく画面（データの取扱いのタブ）へ戻す
  const fromSettings = url.searchParams.get('from') === TENANT_EXPORT_FROM_SETTINGS;
  const failure = (kind: TenantExportError, body: Record<string, string>, status: number) => {
    if (!fromSettings) return NextResponse.json(body, { status });
    const back = new URL('/enterprise/settings', url.origin);
    back.searchParams.set('tab', 'data-handling');
    back.searchParams.set('exportError', kind);
    return NextResponse.redirect(back, 303);
  };
  const part = (url.searchParams.get('part') ?? 'data') as TenantExportPart;
  if (!(TENANT_EXPORT_PARTS as readonly string[]).includes(part)) {
    return failure('part', { error: 'unsupported_part' }, 400);
  }

  const result = await buildTenantExport(db, ctx, part);

  if (getAppMode() === 'supabase') {
    const { createSupabaseServerClient, createSupabaseServiceRoleClient } =
      await import('@/lib/supabase/server');
    // パスの 2 番目は組織 ID（読み取りのポリシーがここで組織の管理者かを見る）
    const path = `exports/${ctx.workspace.organizationId}/${result.manifest.generatedAt.replace(/[:.]/g, '')}-${part}.zip`;
    // 書き込みのポリシーは作っていない（生成はサーバーだけ）。Service Role で置く
    const { error: uploadError } = await createSupabaseServiceRoleClient()
      .storage.from('tenant-exports-private')
      .upload(path, result.zip, { contentType: 'application/zip', upsert: false });
    if (uploadError) {
      return failure(
        'storage',
        {
          error: 'export_failed',
          message: '書き出しを保管できませんでした。時間をおいて再試行してください。',
        },
        500,
      );
    }
    // 読むのは利用者の権限で（RLS が組織の管理者かを確かめる）
    const { data, error } = await (
      await createSupabaseServerClient()
    ).storage
      .from('tenant-exports-private')
      .createSignedUrl(path, 600, { download: result.fileName });
    if (error || !data) {
      return failure(
        'link',
        { error: 'export_failed', message: '書き出しのリンクを発行できませんでした。' },
        500,
      );
    }
    return NextResponse.redirect(data.signedUrl, { headers: { 'Cache-Control': 'no-store' } });
  }

  return new NextResponse(result.zip as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(result.fileName),
      'Cache-Control': 'no-store',
    },
  });
}
