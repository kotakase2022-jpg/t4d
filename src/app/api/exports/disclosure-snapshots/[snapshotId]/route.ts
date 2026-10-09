import { NextResponse } from 'next/server';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { getSession } from '@/lib/auth/session';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentDisposition } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { isUuid } from '@/lib/validation/uuid';
import {
  exportReportSnapshot,
  exportSnapshotReconciliation,
  exportSnapshotTrace,
  parseExportAudience,
  parseExportFormat,
} from '@/lib/services/disclosure-export';
import { ExportReconciliationBlockedError } from '@/lib/services/export-reconciliation';
import { parseTraceCodes } from '@/lib/services/report-trace';

/** 出力するスナップショットが見つからないときの説明（存在の有無・所属は区別しない） */
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  'スナップショットが見つからないため出力できませんでした。デモ環境ではスナップショットをこのブラウザの Cookie で持ち回すため、別のブラウザで作成したもの・Cookie の容量不足で古い操作が押し出された後のもの・固定した元の行が変わったものは見つからないことがあります。一覧を開き直し、無ければ作成し直してから出力してください。';

/** 追跡表・突合結果（社内確認用の XLSX。出力の記録には足さない補助の出力） */
const AUXILIARY_FORMATS = ['trace_xlsx', 'reconciliation_xlsx'] as const;
type AuxiliaryFormat = (typeof AUXILIARY_FORMATS)[number];

function isAuxiliaryFormat(value: string | null): value is AuxiliaryFormat {
  return AUXILIARY_FORMATS.includes(value as AuxiliaryFormat);
}

/**
 * 開示レポートのスナップショットからの出力（DOCX 原稿 / XLSX 対応表 / 定量 CSV、追跡表・突合結果の XLSX）。
 *
 * GET /api/exports/disclosure-snapshots/[snapshotId]?format=docx|xlsx|csv&audience=internal|external
 *     [&framework=<frameworkVersionId>]（DOCX の対象の基準）
 * GET …?format=trace_xlsx[&framework=…][&codes=<要求事項コード,…>]（追跡表。トライアル対応 NF-14）
 * GET …?format=reconciliation_xlsx（突合結果。トライアル対応 NF-15）
 *
 * 認証・権限・テナントの確認はサービスが毎回行う（権限は ID より先）。
 * 他テナントの ID・存在しない ID は同じ 404 を返し、存在を漏らさない（A29）。
 * 生成したファイルと承認版の突合で不一致があれば、ファイルを渡さない（画面のリンクからなら出力タブへ戻して
 * 理由と突合の記録を示す。API としては 422）。
 */
export async function GET(request: Request, context: { params: Promise<{ snapshotId: string }> }) {
  const { snapshotId } = await context.params;
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise') {
    // 企業のスナップショットは企業ワークスペースからだけ扱う（監査法人には存在も示さない）
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const rawFormat = url.searchParams.get('format');
  const auxiliary = isAuxiliaryFormat(rawFormat) ? rawFormat : null;
  const format = auxiliary ? null : parseExportFormat(rawFormat);
  const audience = parseExportAudience(url.searchParams.get('audience') ?? 'internal');
  if ((!format && !auxiliary) || !audience) {
    return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  }
  const project = url.searchParams.get('project');
  /** 画面の出力リンク（project 付き）からなら、出力タブへ戻して理由を示す（JSON をダウンロードとして見せない） */
  const backToOutputs = (params: Record<string, string>) => {
    if (!project || !isUuid(project)) return null;
    const back = new URL(`/enterprise/disclosure-projects/${project}`, url.origin);
    back.searchParams.set('tab', 'outputs');
    for (const [key, value] of Object.entries(params)) back.searchParams.set(key, value);
    return NextResponse.redirect(back, 303);
  };

  const db = await getDb();
  try {
    if (auxiliary) {
      const result =
        auxiliary === 'trace_xlsx'
          ? await exportSnapshotTrace(db, ctx, {
              snapshotId,
              frameworkVersionId: url.searchParams.get('framework'),
              codes: parseTraceCodes(url.searchParams.get('codes')),
            })
          : await exportSnapshotReconciliation(db, ctx, { snapshotId });
      return new NextResponse(result.bytes as unknown as BodyInit, {
        headers: {
          'Content-Type': result.contentType,
          'Content-Disposition': contentDisposition(result.fileName),
          'Cache-Control': 'no-store',
          'X-T4D-Content-Hash': result.snapshot.contentHash,
        },
      });
    }
    const result = await exportReportSnapshot(db, ctx, {
      snapshotId,
      format: format!,
      audience,
      frameworkVersionId: url.searchParams.get('framework'),
    });
    return new NextResponse(result.bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': contentDisposition(result.fileName),
        'Cache-Control': 'no-store',
        // 同じスナップショットからの再出力で一致する値（ファイルのハッシュは生成日時で変わりうる）
        'X-T4D-Content-Hash': result.artifact.contentHash,
        'X-T4D-File-Sha256': result.artifact.fileSha256,
        // 突合の結果（NF-15。渡すファイルは常に不一致 0 件）
        'X-T4D-Reconciliation': `mismatches=${result.artifact.mismatchCount ?? 0}; paragraphs=${result.artifact.reconciledParagraphs ?? 0}; numbers=${result.artifact.reconciledNumbers ?? 0}; rows=${result.artifact.reconciledRows ?? 0}`,
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      // デモではスナップショットがサーバーのメモリにだけあり、一覧を描いたサーバーと出力を受けたサーバーが
      // 違うと見つからない。他テナントの ID と同じ文言にする（A29）
      return (
        backToOutputs({ outputError: SNAPSHOT_UNAVAILABLE_MESSAGE }) ??
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      );
    }
    if (error instanceof AuthorizationError) {
      return accessDeniedResponse(db, ctx, { permission: error.permission ?? null, request });
    }
    if (error instanceof ExportReconciliationBlockedError) {
      return (
        backToOutputs({ outputError: error.message, reconciliation: error.reconciliationId }) ??
        NextResponse.json(
          {
            error: 'reconciliation_mismatch',
            message: error.message,
            reconciliationId: error.reconciliationId,
            mismatchCount: error.mismatchCount,
          },
          { status: 422 },
        )
      );
    }
    if (error instanceof ValidationError) {
      return NextResponse.json(
        { error: 'invalid_request', message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}

export const dynamic = 'force-dynamic';
