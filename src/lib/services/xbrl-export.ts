import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  can,
} from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import {
  loadOwnedSnapshot,
  verifySnapshotIntegrity,
  type ReportSnapshotDetail,
} from '@/lib/services/report-snapshot';
import { entityFor, type XbrlEntity } from '@/lib/xbrl/context';
import {
  buildFacts,
  factTraceSummary,
  mappingsInScope,
  type FactBuildInput,
  type FactBuildResult,
  type RequirementLabel,
} from '@/lib/xbrl/facts';
import { buildIxbrlPreview } from '@/lib/xbrl/ixbrl';
import { buildTaxonomyPackage, type TaxonomyPackage } from '@/lib/xbrl/taxonomy';
import { validateXbrl, validationSummaryOf, type XbrlValidationResult } from '@/lib/xbrl/validate';
import {
  XBRL_GENERATOR_VERSION,
  buildTraceCsv,
  buildXbrlJson,
  mappingSetHash,
  xbrlContentHash,
} from '@/lib/xbrl/xbrl-json';
import type {
  AggregationMethod,
  AuthorizationContext,
  ExportArtifact,
  ExportAudience,
  OrganizationFilingIdentifier,
  ProjectFramework,
  Uuid,
  XbrlTagMapping,
} from '@/types/domain';

/**
 * XBRL の評価（事実・検証）と社内確認用の出力（トライアル対応 NF-42 Stage 1。plan §3.4 xbrl-export.ts）。
 *
 * - 値は必ずスナップショットだけから作る（ライブの数値・本文を引かない）。対応付け・パッケージ・提出者の
 *   識別子は出力の設定として読む（XBRL の内容ハッシュに対応付け集合のハッシュとパッケージ key を入れる）
 * - 出力は社内確認用だけ（対外用は断る）。提出用ではない（SAMPLE・公式の検証なし）と、ファイルの先頭・
 *   ファイル名に書く
 * - 権限（enterprise.export.run）は ID の検索より先に確かめる。他テナントのスナップショットは「見つからない」
 * - 検証（V01〜V16）にエラーがあれば出力を止める（画面には理由と指摘を出す）
 * - 監査ログ export_created。ファイルとして渡した出力（xBRL-JSON・保存用の iXBRL）は export_artifacts に
 *   パッケージ・対応付け集合のハッシュ・検証の要約を残す。画面で開くプレビュー・照合表は監査ログだけ
 *   （トライアルの実演を書き込みなしで回すため。plan §4.3-6）
 */

export const XBRL_EXPORT_FORMATS = ['xbrl_json', 'ixbrl_html', 'trace_csv'] as const;
export type XbrlExportFormat = (typeof XBRL_EXPORT_FORMATS)[number];

export function parseXbrlExportFormat(value: string | null | undefined): XbrlExportFormat | null {
  return XBRL_EXPORT_FORMATS.includes(value as XbrlExportFormat)
    ? (value as XbrlExportFormat)
    : null;
}

/** 画面へ戻すときの理由の符号（URL に任意の文を載せない） */
export type XbrlExportErrorCode = 'blocked' | 'no_package' | 'external' | 'framework';

export class XbrlExportError extends ValidationError {
  readonly code: XbrlExportErrorCode;
  constructor(code: XbrlExportErrorCode, message: string) {
    super(message);
    this.name = 'XbrlExportError';
    this.code = code;
  }
}

export const XBRL_EXPORT_ERROR_MESSAGES: Record<XbrlExportErrorCode | 'not_found', string> = {
  blocked:
    '検証（T4D の簡易検査）にエラーがあるため出力しませんでした。XBRL タブの「検証の結果」を確認し、対応付けを直してください。',
  no_package:
    'この基準に XBRL のタクソノミが設定されていないため出力できません。XBRL タブでタクソノミを設定してください。',
  external: 'XBRL は社内確認用だけです。対外用には出力できません。',
  framework: '指定した基準はこのスナップショットに含まれていません。',
  not_found:
    'スナップショットが見つからないため出力できませんでした。デモ環境では、別のブラウザで作成したもの・Cookie の容量不足で押し出されたものは見つからないことがあります。',
};

// ----------------------------------------------------------------------
// 入力の読み込み
// ----------------------------------------------------------------------

export interface XbrlInputs {
  snapshot: ReportSnapshotDetail;
  projectFramework: ProjectFramework | null;
  frameworkVersionId: Uuid;
  pkg: TaxonomyPackage | null;
  mappings: XbrlTagMapping[];
  identifiers: OrganizationFilingIdentifier[];
  entity: XbrlEntity | null;
  requirementLabels: Map<Uuid, RequirementLabel>;
  metrics: Array<{ id: Uuid; aggregationMethod: AggregationMethod; name: string }>;
}

/** パッケージ（マスター）と概念を読む。無ければ null */
export async function loadTaxonomyPackage(
  db: DbClient,
  packageId: Uuid | null,
): Promise<TaxonomyPackage | null> {
  if (!packageId) return null;
  const row = await db.findById('xbrlTaxonomyPackages', packageId);
  if (!row) return null;
  const concepts = await db.select('xbrlConcepts', { where: { packageId: row.id } });
  return buildTaxonomyPackage(row, concepts);
}

/**
 * スナップショット（自組織・権限は呼び出し側で確認済み）から評価の入力を読む。
 * 基準の指定が無ければ、タクソノミを設定した最初の基準（無ければ先頭の基準）
 */
export async function loadXbrlInputs(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
  frameworkVersionId?: Uuid | null,
): Promise<XbrlInputs> {
  const organizationId = ctx.workspace.organizationId;
  const projectFrameworks = await db.select('projectFrameworks', {
    where: { organizationId, projectId: snapshot.projectId },
  });
  const inSnapshot = snapshot.frameworkVersions.map((f) => f.frameworkVersionId);
  let chosen: Uuid | undefined;
  if (frameworkVersionId) {
    if (!inSnapshot.includes(frameworkVersionId)) {
      throw new XbrlExportError('framework', XBRL_EXPORT_ERROR_MESSAGES.framework);
    }
    chosen = frameworkVersionId;
  } else {
    chosen =
      inSnapshot.find((id) =>
        projectFrameworks.some((pf) => pf.frameworkVersionId === id && pf.taxonomyPackageId),
      ) ?? inSnapshot[0];
  }
  if (!chosen) throw new XbrlExportError('framework', XBRL_EXPORT_ERROR_MESSAGES.framework);
  const projectFramework = projectFrameworks.find((pf) => pf.frameworkVersionId === chosen) ?? null;
  const pkg = await loadTaxonomyPackage(db, projectFramework?.taxonomyPackageId ?? null);
  const [mappingRows, identifiers] = await Promise.all([
    pkg
      ? db.select('xbrlTagMappings', { where: { organizationId, packageId: pkg.id } })
      : Promise.resolve([] as XbrlTagMapping[]),
    db.select('organizationFilingIdentifiers', { where: { organizationId } }),
  ]);
  const mappings = pkg
    ? mappingsInScope(mappingRows, {
        packageId: pkg.id,
        projectId: snapshot.projectId,
        frameworkVersionId: chosen,
      })
    : [];

  // 対応付けの要求事項の表示（スナップショットの節に無い要求事項の分）
  const blockItemIds = new Set(snapshot.blocks.flatMap((b) => b.requirements.map((r) => r.itemId)));
  const extraItemIds = [
    ...new Set(
      mappings.flatMap((m) =>
        m.disclosureItemId && !blockItemIds.has(m.disclosureItemId) ? [m.disclosureItemId] : [],
      ),
    ),
  ];
  const items =
    extraItemIds.length === 0
      ? []
      : await db.select('disclosureItems', { where: { id: { in: extraItemIds } } });
  const requirementLabels = new Map<Uuid, RequirementLabel>(
    items.map((i) => [i.id, { code: i.code, title: i.questionText }]),
  );
  const metricIds = [...new Set(mappings.flatMap((m) => (m.metricId ? [m.metricId] : [])))];
  const metrics =
    metricIds.length === 0
      ? []
      : await db.select('metrics', { where: { organizationId, id: { in: metricIds } } });

  return {
    snapshot,
    projectFramework,
    frameworkVersionId: chosen,
    pkg,
    mappings,
    identifiers,
    entity: pkg ? entityFor(pkg.profile, identifiers) : null,
    requirementLabels,
    metrics: metrics.map((m) => ({
      id: m.id,
      aggregationMethod: m.aggregationMethod,
      name: m.name,
    })),
  };
}

// ----------------------------------------------------------------------
// 評価（純粋。書き込みなし）
// ----------------------------------------------------------------------

export interface XbrlEvaluation {
  pkg: TaxonomyPackage;
  input: FactBuildInput;
  built: FactBuildResult;
  validation: XbrlValidationResult;
  trace: { traceable: number; total: number };
  mappingSetHash: string;
  contentHash: string;
}

export function evaluateXbrl(inputs: XbrlInputs): XbrlEvaluation | null {
  if (!inputs.pkg) return null;
  const input: FactBuildInput = {
    snapshot: inputs.snapshot,
    frameworkVersionId: inputs.frameworkVersionId,
    pkg: inputs.pkg,
    mappings: inputs.mappings,
    entity: inputs.entity,
    requirementLabels: inputs.requirementLabels,
  };
  const built = buildFacts(input);
  const validation = validateXbrl(input, built, {
    metrics: inputs.metrics,
    assignedPackageId: inputs.projectFramework?.taxonomyPackageId ?? null,
  });
  const setHash = mappingSetHash(built.confirmedMappings, built.entity);
  return {
    pkg: inputs.pkg,
    input,
    built,
    validation,
    trace: factTraceSummary(built.facts),
    mappingSetHash: setHash,
    contentHash: xbrlContentHash({
      snapshotContentHash: inputs.snapshot.contentHash,
      mappingSetHash: setHash,
      packageKey: inputs.pkg.key,
    }),
  };
}

/**
 * 画面の評価（事実・検証の一覧）。開示の閲覧権限。書き込みはしない（監査ログも残さない。出力ではないため）
 */
export async function previewXbrl(
  db: DbClient,
  ctx: AuthorizationContext,
  request: { snapshotId: Uuid; frameworkVersionId?: Uuid | null },
): Promise<{ inputs: XbrlInputs; evaluation: XbrlEvaluation | null; integrityOk: boolean }> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const snapshot = await loadOwnedSnapshot(db, ctx, request.snapshotId);
  const integrityOk = verifySnapshotIntegrity(snapshot);
  const inputs = await loadXbrlInputs(db, ctx, snapshot, request.frameworkVersionId);
  return { inputs, evaluation: integrityOk ? evaluateXbrl(inputs) : null, integrityOk };
}

// ----------------------------------------------------------------------
// 出力（社内確認用）
// ----------------------------------------------------------------------

export interface XbrlExportRequest {
  snapshotId: Uuid;
  format: XbrlExportFormat;
  audience: ExportAudience;
  frameworkVersionId?: Uuid | null;
  /** iXBRL を画面で開く（プレビュー）か、ファイルとして保存するか。既定はプレビュー */
  download?: boolean;
}

export interface XbrlExportResult {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  /** ファイルとして渡したときの出力の記録（プレビュー・照合表は null） */
  artifact: ExportArtifact | null;
  inline: boolean;
  contentHash: string;
  mappingSetHash: string;
  snapshotContentHash: string;
  validation: XbrlValidationResult;
}

export const XBRL_CONTENT_TYPES: Record<XbrlExportFormat, string> = {
  xbrl_json: 'application/json; charset=utf-8',
  ixbrl_html: 'text/html; charset=utf-8',
  trace_csv: 'text/csv; charset=utf-8',
};

const FORMAT_SUMMARY: Record<XbrlExportFormat, string> = {
  xbrl_json: 'XBRL（xBRL-JSON・社内確認用）',
  ixbrl_html: 'インライン XBRL（社内確認用）',
  trace_csv: 'XBRL の照合表（社内確認用）',
};

function safeFilePart(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

export function xbrlFileName(
  snapshot: Pick<ReportSnapshotDetail, 'snapshotKind' | 'snapshotNo' | 'frameworkVersions'>,
  format: XbrlExportFormat,
  pkg: Pick<TaxonomyPackage, 'key' | 'isSample'>,
): string {
  const projectName = snapshot.frameworkVersions[0]?.projectName ?? 'report';
  const kind = snapshot.snapshotKind === 'approved' ? '社内承認済み' : '草稿';
  const taxonomy = `${pkg.isSample ? 'SAMPLE_' : ''}${safeFilePart(pkg.key)}`;
  const base = `T4D_${safeFilePart(projectName)}_${kind}No${snapshot.snapshotNo}_XBRL_${taxonomy}`;
  if (format === 'trace_csv') return `${base}_照合表_社内確認用.csv`;
  const ext = format === 'xbrl_json' ? 'json' : 'html';
  return `${base}_社内確認用_提出用ではない.${ext}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function exportXbrl(
  db: DbClient,
  ctx: AuthorizationContext,
  request: XbrlExportRequest,
): Promise<XbrlExportResult> {
  assertEnterpriseWorkspace(ctx);
  // 権限は ID の検索より先に（権限の無い人に、ID の有無で応答を変えない）
  if (!can(ctx, 'enterprise.export.run')) {
    throw new AuthorizationError(
      '出力には出力の権限（enterprise.export.run）が必要です。',
      'enterprise.export.run',
    );
  }
  if (request.audience !== 'internal') {
    throw new XbrlExportError('external', XBRL_EXPORT_ERROR_MESSAGES.external);
  }
  const snapshot = await loadOwnedSnapshot(db, ctx, request.snapshotId);
  if (!verifySnapshotIntegrity(snapshot)) {
    throw new Error(
      `スナップショット ${snapshot.id} の内容ハッシュが一致しません。出力を中止しました。`,
    );
  }
  const inputs = await loadXbrlInputs(db, ctx, snapshot, request.frameworkVersionId);
  const evaluation = evaluateXbrl(inputs);
  if (!evaluation) throw new XbrlExportError('no_package', XBRL_EXPORT_ERROR_MESSAGES.no_package);
  if (evaluation.validation.blocking) {
    throw new XbrlExportError('blocked', XBRL_EXPORT_ERROR_MESSAGES.blocked);
  }

  const meta = {
    snapshotNo: snapshot.snapshotNo,
    snapshotLabel: snapshot.label,
    snapshotContentHash: snapshot.contentHash,
    mappingSetHash: evaluation.mappingSetHash,
    contentHash: evaluation.contentHash,
  };
  const text =
    request.format === 'xbrl_json'
      ? buildXbrlJson(evaluation.built, evaluation.pkg, meta)
      : request.format === 'ixbrl_html'
        ? buildIxbrlPreview({
            result: evaluation.built,
            pkg: evaluation.pkg,
            snapshot,
            meta,
            validation: evaluation.validation,
          })
        : buildTraceCsv(evaluation.built);
  const bytes = new TextEncoder().encode(text);
  const fileName = xbrlFileName(snapshot, request.format, evaluation.pkg);
  const inline = request.format === 'ixbrl_html' && !request.download;
  const summary = validationSummaryOf(evaluation.validation, evaluation.trace);

  // ファイルとして渡した XBRL（xBRL-JSON・保存用の iXBRL）だけを出力の記録に残す
  let artifact: ExportArtifact | null = null;
  if (request.format !== 'trace_csv' && !inline) {
    artifact = {
      id: randomUUID(),
      organizationId: ctx.workspace.organizationId,
      snapshotId: snapshot.id,
      format: request.format,
      audience: 'internal',
      templateVersion: XBRL_GENERATOR_VERSION,
      fileName,
      byteSize: bytes.byteLength,
      fileSha256: sha256Hex(bytes),
      // スナップショットの内容ハッシュ（出力の記録の約束。XBRL の内容ハッシュは対応付け集合のハッシュ・
      // パッケージ・生成器の版から再計算できる）
      contentHash: snapshot.contentHash,
      generatedAt: new Date().toISOString(),
      generatedBy: ctx.userId,
      reconciledParagraphs: null,
      reconciledNumbers: null,
      reconciledRows: null,
      mismatchCount: null,
      checkerVersion: null,
      taxonomyPackageId: evaluation.pkg.id,
      mappingSetHash: evaluation.mappingSetHash,
      validationSummary: summary,
    };
    await db.insert('exportArtifacts', [artifact]);
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} を ${FORMAT_SUMMARY[request.format]}${inline ? 'のプレビューで表示' : 'で出力'}（提出用ではない）`,
    metadata: {
      exportArtifactId: artifact?.id ?? null,
      format: request.format,
      audience: 'internal',
      preview: inline,
      frameworkVersionId: inputs.frameworkVersionId,
      taxonomyPackageKey: evaluation.pkg.key,
      sampleTaxonomy: evaluation.pkg.isSample,
      generator: XBRL_GENERATOR_VERSION,
      mappingSetHash: evaluation.mappingSetHash,
      contentHash: evaluation.contentHash,
      snapshotContentHash: snapshot.contentHash,
      validation: summary,
    },
  });

  return {
    bytes,
    contentType: XBRL_CONTENT_TYPES[request.format],
    fileName,
    artifact,
    inline,
    contentHash: evaluation.contentHash,
    mappingSetHash: evaluation.mappingSetHash,
    snapshotContentHash: snapshot.contentHash,
    validation: evaluation.validation,
  };
}
