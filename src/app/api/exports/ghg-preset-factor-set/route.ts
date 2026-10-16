import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES, toCsv } from '@/lib/exports';
import {
  isPresetFuelCo2Edition,
  presetFactorSetFileName,
  presetFactorSetSheet,
} from '@/lib/exports/ghg-preset-factor-set';
import { getDb } from '@/lib/repositories';

/**
 * 公的参照プリセット（告示・算定省令の値）の係数セットの取込のファイル（E21。?fuelCo2=shk_r5|shk_h21）。
 *
 * 組織が採用を決めたときに、排出係数の画面の「係数セットを取り込む」で出所「公的参照」の下書きのセットとして
 * 取り込むためのファイル。値は公的資料の転記で、架空の Fixture ではないため Demo・Supabase のどちらでも出す。
 * 閲覧の権限（enterprise.data.read）で取れる。権限は何かを読む前に確かめ、断ったら 403 と監査ログ access_denied。
 * 出したら監査ログ export_created。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = await getDb();
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.data.read')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.data.read', request });
  }
  const edition = new URL(request.url).searchParams.get('fuelCo2');
  if (!isPresetFuelCo2Edition(edition)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const sheet = presetFactorSetSheet(edition);
  const fileName = presetFactorSetFileName(edition);

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'ghg_preset_factor_set',
    resourceId: null,
    afterSummary: `公的参照プリセット（改良トンキロ法・燃料の値）の係数セットの取込のファイルを出力（${sheet.rows.length} 行）`,
    metadata: { fuelCo2: edition },
  });

  return new NextResponse(toCsv(sheet), {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.csv,
      'Content-Disposition': contentDisposition(fileName),
      'Cache-Control': 'private, no-store',
    },
  });
}

export const dynamic = 'force-dynamic';
