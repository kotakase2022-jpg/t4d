import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { AuthorizationError, assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { EXPORT_CONTENT_TYPES } from '@/lib/exports';
import {
  DISCLOSURE_REPORT_TEMPLATE_VERSION,
  buildDisclosureDocx,
  buildMappingXlsx,
  buildMetricCsv,
  exportFileName,
} from '@/lib/exports/disclosure-report';
import {
  loadOwnedSnapshot,
  verifySnapshotIntegrity,
  type ReportSnapshotDetail,
} from '@/lib/services/report-snapshot';
import type { DbClient } from '@/lib/repositories/types';
import {
  EXPORT_ARTIFACT_FORMATS,
  EXPORT_AUDIENCES,
  type AuthorizationContext,
  type ExportArtifact,
  type ExportArtifactFormat,
  type ExportAudience,
  type Uuid,
} from '@/types/domain';

/**
 * スナップショットからの出力（指示書 §6.10・§10.2「承認済み版を出力」・§10.3 過去スナップショットの再出力）。
 *
 * - 出力は必ず 1 つのスナップショットから作る（ライブの最新値から組み立て直さない）。
 * - 権限（enterprise.export.run）とテナントは**出力のたびに**確認する。過去のスナップショットの
 *   再出力も同じ経路で、作成時に権限があったことを理由に通さない。
 * - 他テナントのスナップショット ID は「見つからない」として扱い、存在を漏らさない（A29）。
 * - 出力ごとに export_artifacts へ形式・区分・テンプレート版・サイズ・ファイルのハッシュ・
 *   スナップショットの内容ハッシュを記録し、監査ログ（export_created）を残す。
 *   ファイルのハッシュは生成日時を含むため出力ごとに変わりうるが、内容ハッシュは同じスナップショット
 *   なら一致する（A31: 違いを説明できるように両方を残す）。
 * - 出力は開示先への提出ではない。記録にも画面にも「提出済み」とは書かない。
 */

export interface ExportSnapshotRequest {
  snapshotId: Uuid;
  format: ExportArtifactFormat;
  audience: ExportAudience;
  /** DOCX の対象の基準（スナップショットに含まれる版）。省略時は先頭の基準 */
  frameworkVersionId?: Uuid | null;
}

export interface ExportSnapshotResult {
  artifact: ExportArtifact;
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  snapshot: ReportSnapshotDetail;
}

export function parseExportFormat(value: string | null | undefined): ExportArtifactFormat | null {
  return EXPORT_ARTIFACT_FORMATS.includes(value as ExportArtifactFormat)
    ? (value as ExportArtifactFormat)
    : null;
}

export function parseExportAudience(value: string | null | undefined): ExportAudience | null {
  return EXPORT_AUDIENCES.includes(value as ExportAudience) ? (value as ExportAudience) : null;
}

/** 組織の非公開の資料のファイル名（対外用の原稿で伏せる） */
async function nonPublicFileNames(db: DbClient, ctx: AuthorizationContext): Promise<string[]> {
  const files = await db.select('files', {
    where: { organizationId: ctx.workspace.organizationId },
  });
  return files.filter((f) => f.confidentiality !== 'public').map((f) => f.originalName);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function exportReportSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ExportSnapshotRequest,
): Promise<ExportSnapshotResult> {
  assertEnterpriseWorkspace(ctx);
  // 権限は ID の検索より先に確かめる（権限の無い人に、ID の有無で応答を変えない）
  if (!can(ctx, 'enterprise.export.run')) {
    throw new AuthorizationError('出力には出力の権限（enterprise.export.run）が必要です。');
  }
  const snapshot = await loadOwnedSnapshot(db, ctx, request.snapshotId);

  // 保存後に内容が書き換わっていないか（追記専用の前提が崩れていれば出力しない）
  if (!verifySnapshotIntegrity(snapshot)) {
    throw new Error(
      `スナップショット ${snapshot.id} の内容ハッシュが一致しません。出力を中止しました。`,
    );
  }

  if (request.format === 'xlsx' && request.audience !== 'internal') {
    throw new ValidationError('対応表（XLSX）は社内確認用だけです。対外用には出力できません。');
  }

  const framework =
    request.format !== 'docx'
      ? null
      : request.frameworkVersionId
        ? (snapshot.frameworkVersions.find(
            (f) => f.frameworkVersionId === request.frameworkVersionId,
          ) ?? null)
        : (snapshot.frameworkVersions[0] ?? null);

  let bytes: Uint8Array;
  if (request.format === 'docx') {
    if (!framework) {
      throw new ValidationError('指定した基準はこのスナップショットに含まれていません。');
    }
    bytes = await buildDisclosureDocx(snapshot, {
      audience: request.audience,
      frameworkVersionId: framework.frameworkVersionId,
      // 対外用は、本文に書かれた非公開資料の名前も伏せる（出典印の伏せ字と同じ扱い）
      nonPublicFileNames: request.audience === 'external' ? await nonPublicFileNames(db, ctx) : [],
    });
  } else if (request.format === 'xlsx') {
    bytes = await buildMappingXlsx(snapshot);
  } else {
    bytes = new TextEncoder().encode(buildMetricCsv(snapshot, request.audience));
  }

  const fileName = exportFileName(snapshot, request.format, request.audience, framework);
  const artifact: ExportArtifact = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    snapshotId: snapshot.id,
    format: request.format,
    audience: request.audience,
    templateVersion: DISCLOSURE_REPORT_TEMPLATE_VERSION,
    fileName,
    byteSize: bytes.byteLength,
    fileSha256: sha256Hex(bytes),
    contentHash: snapshot.contentHash,
    generatedAt: new Date().toISOString(),
    // RLS は generated_by = auth.uid() を求める
    generatedBy: ctx.userId,
  };
  await db.insert('exportArtifacts', [artifact]);

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} を ${request.format.toUpperCase()}（${request.audience === 'internal' ? '社内確認用' : '対外用'}）で出力`,
    metadata: {
      exportArtifactId: artifact.id,
      format: request.format,
      audience: request.audience,
      frameworkVersionId: framework?.frameworkVersionId ?? null,
      templateVersion: artifact.templateVersion,
      fileSha256: artifact.fileSha256,
      contentHash: artifact.contentHash,
    },
  });

  return {
    artifact,
    bytes,
    contentType: EXPORT_CONTENT_TYPES[request.format],
    fileName,
    snapshot,
  };
}

export interface ExportArtifactView extends ExportArtifact {
  generatedByName: string;
}

/** スナップショットごとの出力記録（新しい順）。スナップショットが自組織のものであることを前提に呼ぶ */
export async function listExportArtifacts(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotIds: readonly Uuid[],
): Promise<ExportArtifactView[]> {
  assertEnterpriseWorkspace(ctx);
  if (snapshotIds.length === 0) return [];
  const rows = await db.select('exportArtifacts', {
    where: { organizationId: ctx.workspace.organizationId, snapshotId: { in: [...snapshotIds] } },
    orderBy: [
      { column: 'generatedAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  const userIds = [...new Set(rows.map((r) => r.generatedBy))];
  const profiles =
    userIds.length === 0 ? [] : await db.select('profiles', { where: { id: { in: userIds } } });
  return rows.map((row) => ({
    ...row,
    generatedByName: profiles.find((p) => p.id === row.generatedBy)?.displayName ?? '—',
  }));
}
