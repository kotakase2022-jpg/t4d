import 'server-only';

import { createHash } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { getBuildInfo } from '@/lib/build-info';
import { toCsv, type ExportColumn } from '@/lib/exports';
import { buildZip, type ZipEntry } from '@/lib/exports/zip';
import { backupResidualText } from '@/lib/domain/data-disposal';
import { SQL_TABLE_NAMES, toSnake } from '@/lib/repositories/table-names';
import { getStorageAdapter } from '@/lib/storage';
import type { DbClient, TableName } from '@/lib/repositories/types';
import type { AuthorizationContext, IsoDateTime, Uuid } from '@/types/domain';

/**
 * 全データの返却書き出し（トライアル対応 NF-29。トライアル終了時の継続移行・返却に使う）。
 *
 *  - 自社の行だけ（organization_id＝自社。許諾・回答など企業が書いた保証連携の行は client_organization_id
 *    ＝自社）。監査法人の調書・案件の内部の記録・全テナント共通のマスターは含めない（理由を manifest に書く）
 *  - 表ごとの CSV（UTF-8 BOM・数式に見える値は無害化）＋ manifest.json（表・行数・sha256・生成者・版）
 *    ＋ README.md。資料の実体は別の ZIP（part=files）に分ける（応答の大きさの上限を避ける）
 *  - 組織の管理者が出力の権限も持つときだけ（enterprise.org.manage＋enterprise.export.run）
 *  - 書き出しは監査ログ export_created（resource_type tenant_export）に残す
 * 表の分類は TENANT_EXPORT_TABLES・TENANT_EXPORT_CHILDREN・TENANT_EXPORT_EXCLUDED のどれか 1 つに必ず入る
 * （tests/integration/tenant-export.test.ts が、新しい表の分類漏れを検出する）。
 */

/** 自社の organization_id で読む表 */
export const TENANT_EXPORT_TABLES = [
  'memberships',
  'invitations',
  'units',
  'periods',
  'campaigns',
  'metrics',
  'aggregationRules',
  'metricAssignments',
  'emissionFactors',
  'dataPoints',
  'dataPointVersions',
  'calculations',
  'validations',
  'files',
  'fileVersions',
  'evidenceLinks',
  'fragments',
  'storageAccessEvents',
  'tasks',
  'approvals',
  'approvalRoutes',
  'approvalRouteStages',
  'dataPointApprovalSteps',
  'comments',
  'alerts',
  'applicabilityResults',
  'materialityTopics',
  'disclosureResponses',
  'disclosureResponseVersions',
  'disclosureMappings',
  'responseEvidenceLinks',
  'ssbjAssessments',
  'ssbjActionPlans',
  'ssbjAnalysisSettings',
  'ssbjDisclosureDrafts',
  'csrdAnalysisSettings',
  'csrdDmaMatters',
  'csrdDmaIros',
  'csrdAssessments',
  'csrdActionPlans',
  'csrdDisclosureDrafts',
  'organizationFeatureSettings',
  'disclosureProjects',
  'projectFrameworks',
  'projectFrameworkDecisions',
  'narrativeRecords',
  'narrativeVersions',
  'sourceAnchors',
  'disclosureBlocks',
  'disclosureBlockVersions',
  'reviewRequests',
  'reviewEvents',
  'reviewComments',
  'recheckDecisions',
  'reportSnapshots',
  'exportArtifacts',
  'kpiTargets',
  'quantitativeImportBatches',
  'ingestionJobs',
  'ingestionJobFiles',
  'ingestionRows',
  'aiRuns',
  'aiFeedback',
  'projectRequirementAssessments',
  'projectRequirementAssessmentEvents',
  'requirementExclusionEvents',
  'narrativeRequirementLinks',
  'exportReconciliations',
  'organizationFilingIdentifiers',
  'xbrlTagMappings',
  'xbrlTagMappingEvents',
  'trialPrograms',
  'trialScenarios',
  'trialScenarioRuns',
  'trialScenarioJudgements',
  'trialFeedbackItems',
  'trialTaskTimings',
  'organizationDataTerms',
  'organizationOptions',
  'responseContentLinks',
  // Scope1・2 の算定と既存結果との照合（0061〜0065。返却・削除の対象。plan CR-29）
  'emissionFactorSets',
  'emissionFactorAssignments',
  'ghgCalculationPolicies',
  'ghgClassificationRules',
  'ghgActivityBatches',
  'ghgActivityLines',
  'ghgCalculationRuns',
  'ghgCalculationLines',
  'ghgBaselineResults',
  'ghgReconciliations',
  'ghgReconciliationNotes',
] as const satisfies readonly TableName[];

/** organization_id 以外の列で自社の行を読む表（企業が書いた保証連携の行・自社のメンバーの操作の記録） */
export const TENANT_EXPORT_OTHER_KEYS = {
  grants: 'clientOrganizationId',
  pbcResponses: 'clientOrganizationId',
  managementResponses: 'clientOrganizationId',
  reviewNoteResponses: 'clientOrganizationId',
  sharedReportCopies: 'clientOrganizationId',
  auditEvents: 'actorOrganizationId',
} as const satisfies Partial<Record<TableName, string>>;

/** 自社の行に属する子の表（親の表の ID で読む）・自社の組織とメンバーの利用者 */
export const TENANT_EXPORT_CHILDREN = {
  membershipRoles: { parent: 'memberships', key: 'membershipId' },
  campaignScopes: { parent: 'campaigns', key: 'campaignId' },
  profiles: { parent: 'memberships', key: 'id', parentColumn: 'userId' },
  organizations: { parent: null, key: 'id' },
} as const;

const MASTER = '全テナント共通のマスター（基準・要求事項・タクソノミ・横断対応表）。返却の対象外';
const ASSURANCE = '監査法人の調書・案件の記録（監査法人が所有。合意した扱いに従う）';

/** 書き出さない表と理由（manifest にも書く） */
export const TENANT_EXPORT_EXCLUDED: Readonly<Partial<Record<TableName, string>>> = {
  frameworks: MASTER,
  frameworkVersions: MASTER,
  disclosureItems: MASTER,
  itemConditions: MASTER,
  requirementCrosswalks: MASTER,
  xbrlTaxonomyPackages: MASTER,
  xbrlConcepts: MASTER,
  xbrlConceptRequirements: MASTER,
  relationships: '監査法人との接続（契約）の記録。運営と監査法人が管理する',
  notifications: '利用者ごとの通知（本人だけが読める受信箱。組織の記録ではない）',
  engagements: ASSURANCE,
  engagementMembers: ASSURANCE,
  engagementScopes: ASSURANCE,
  dataRoomItems: ASSURANCE,
  snapshots: ASSURANCE,
  snapshotItems: ASSURANCE,
  snapshotChanges: ASSURANCE,
  populations: ASSURANCE,
  populationItems: ASSURANCE,
  samples: ASSURANCE,
  sampleItems: ASSURANCE,
  procedures: ASSURANCE,
  tests: ASSURANCE,
  testResults: ASSURANCE,
  pbcRequests: ASSURANCE,
  issues: ASSURANCE,
  reviewNotes: ASSURANCE,
  signoffs: ASSURANCE,
};

export const TENANT_EXPORT_FORMAT = 't4d-tenant-export';
export const TENANT_EXPORT_FORMAT_VERSION = 1;
export const TENANT_EXPORT_PARTS = ['data', 'files'] as const;
export type TenantExportPart = (typeof TENANT_EXPORT_PARTS)[number];

/** 1 回の読み込みの行数（Supabase の既定の上限 1,000 行に合わせてページを送る） */
const PAGE = 1000;
/** 表ごとの上限（これを超える表は manifest に「上限で打ち切り」と書く。黙って切らない） */
const TABLE_ROW_LIMIT = 200_000;

type Row = Record<string, unknown>;

export interface TenantExportTableEntry {
  table: string;
  file: string;
  rows: number;
  sha256: string;
  truncated: boolean;
}

export interface TenantExportFileEntry {
  path: string;
  fileVersionId: Uuid;
  bytes: number;
  sha256: string;
}

export interface TenantExportManifest {
  format: typeof TENANT_EXPORT_FORMAT;
  formatVersion: number;
  part: TenantExportPart;
  organizationId: Uuid;
  generatedAt: IsoDateTime;
  generatedBy: Uuid;
  appVersion: string;
  tables: TenantExportTableEntry[];
  files: TenantExportFileEntry[];
  /** 実体の無い資料（Demo Mode の Fixture・再起動で失われたもの） */
  missingFiles: Uuid[];
  excluded: Array<{ table: string; reason: string }>;
}

export interface TenantExportPlan {
  tables: number;
  rows: number;
  files: number;
}

function assertCanExport(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
  assertCan(ctx, 'enterprise.export.run');
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function selectAll(
  db: DbClient,
  table: TableName,
  where: Row,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let offset = 0; offset < TABLE_ROW_LIMIT; offset += PAGE) {
    const page = (await db.select(table, {
      where: where as never,
      orderBy: { column: 'id' as never, dir: 'asc' },
      limit: PAGE,
      offset,
    })) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** id を持たない子の表（membership_roles）はページを id で並べられないので、親ごとに読む */
async function selectByParents(
  db: DbClient,
  table: TableName,
  key: string,
  parentIds: Uuid[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < parentIds.length; i += 200) {
    const chunk = parentIds.slice(i, i + 200);
    rows.push(
      ...((await db.select(table, {
        where: { [key]: { in: chunk } } as never,
      })) as unknown as Row[]),
    );
  }
  return rows;
}

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/** 行の列（最初に現れた順。全行の列の合併） */
function columnsOf(rows: readonly Row[]): ExportColumn<Row>[] {
  const keys: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  return keys.map((key) => ({ key, header: toSnake(key), value: (row) => cell(row[key]) }));
}

/** 表ごとの自社の行（分類どおりに読む） */
async function loadTenantRows(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<Array<{ table: TableName; rows: Row[]; truncated: boolean }>> {
  const organizationId = ctx.workspace.organizationId;
  const out: Array<{ table: TableName; rows: Row[]; truncated: boolean }> = [];
  for (const table of TENANT_EXPORT_TABLES) {
    out.push({ table, ...(await selectAll(db, table, { organizationId })) });
  }
  for (const [table, key] of Object.entries(TENANT_EXPORT_OTHER_KEYS) as Array<
    [TableName, string]
  >) {
    out.push({ table, ...(await selectAll(db, table, { [key]: organizationId })) });
  }
  const memberships = out.find((t) => t.table === 'memberships')?.rows ?? [];
  const campaigns = out.find((t) => t.table === 'campaigns')?.rows ?? [];
  const ids = (rows: Row[], column = 'id') => [
    ...new Set(rows.map((r) => r[column]).filter((v): v is string => typeof v === 'string')),
  ];
  out.push({
    table: 'membershipRoles',
    rows: await selectByParents(db, 'membershipRoles', 'membershipId', ids(memberships)),
    truncated: false,
  });
  out.push({
    table: 'campaignScopes',
    rows: await selectByParents(db, 'campaignScopes', 'campaignId', ids(campaigns)),
    truncated: false,
  });
  out.push({
    table: 'profiles',
    rows: await selectByParents(db, 'profiles', 'id', ids(memberships, 'userId')),
    truncated: false,
  });
  const organization = await db.findById('organizations', organizationId);
  out.push({
    table: 'organizations',
    rows: organization ? [organization as unknown as Row] : [],
    truncated: false,
  });
  return out;
}

/** 確認ダイアログの範囲（表 n・行 n・資料 n） */
export async function planTenantExport(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<TenantExportPlan> {
  assertCanExport(ctx);
  const organizationId = ctx.workspace.organizationId;
  let rows = 0;
  let tables = 0;
  for (const table of TENANT_EXPORT_TABLES) {
    rows += await db.count(table, { where: { organizationId } as never });
    tables += 1;
  }
  for (const [table, key] of Object.entries(TENANT_EXPORT_OTHER_KEYS) as Array<
    [TableName, string]
  >) {
    rows += await db.count(table, { where: { [key]: organizationId } as never });
    tables += 1;
  }
  tables += Object.keys(TENANT_EXPORT_CHILDREN).length;
  const files = await db.count('fileVersions', { where: { organizationId } });
  return { tables, rows, files };
}

/**
 * README の本文。削除の後のバックアップの扱いは、データの取扱いの画面・削除完了の報告と同じ固定の文
 * （合意した残存期間の日数入り。未合意ならそう書く。2026-10-16 の要望 ⑦）
 */
export function tenantExportReadme(
  manifest: TenantExportManifest,
  backupResidualDays: number | null = null,
): string {
  const lines = [
    '# T4D 全データの書き出し（返却用）',
    '',
    `- 形式: ${manifest.format} 第 ${manifest.formatVersion} 版（${manifest.part === 'data' ? 'データ' : '資料の実体'}）`,
    `- 生成日時（UTC）: ${manifest.generatedAt}`,
    `- アプリの版: ${manifest.appVersion}`,
    '',
    '## 内容',
    '',
    manifest.part === 'data'
      ? "- `data/<表>.csv`: 自社の行（UTF-8 BOM 付き。先頭が = + - @ の値は表計算ソフトで数式にならないよう先頭に ' を付けています）"
      : '- `files/<資料の版の ID>/<元のファイル名>`: 資料の実体（実体の無い資料は manifest.json の missingFiles）',
    '- `manifest.json`: 表・行数・各ファイルの sha256・生成者・版',
    '',
    '## 確かめ方',
    '',
    '各ファイルの sha256 を計算し、manifest.json の値と一致することを確かめてください',
    '（例: PowerShell `Get-FileHash -Algorithm SHA256 <ファイル>`、macOS `shasum -a 256 <ファイル>`）。',
    '',
    '## 含まないもの',
    '',
    ...manifest.excluded.map((e) => `- ${e.table}: ${e.reason}`),
    '',
    'データの削除（テナントの終了）は、返却を受け取ったことの確認のあと、運営が手順書に従って行います。',
    '',
    '## 削除の後のバックアップ',
    '',
    backupResidualText(backupResidualDays),
    '削除を実施したら、運営が削除完了の報告（削除日・削除した件数・この manifest の sha256・消去の見込み日）を渡します。',
    '',
  ];
  return lines.join('\n');
}

function excludedList(): Array<{ table: string; reason: string }> {
  return Object.entries(TENANT_EXPORT_EXCLUDED).map(([table, reason]) => ({
    table: SQL_TABLE_NAMES[table as TableName],
    reason: reason ?? '',
  }));
}

function safeName(name: string): string {
  // パスの区切り・制御文字は除く（展開した先の外へ書かせない）
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'file';
}

export interface TenantExportResult {
  zip: Uint8Array;
  manifest: TenantExportManifest;
  /** ZIP に入れたファイル（テストと確かめ用） */
  entries: ZipEntry[];
  fileName: string;
}

/**
 * 書き出しを作る（part=data は表の CSV、part=files は資料の実体）。監査ログに残す。
 * 戻り値の ZIP をそのまま返すか（Demo）、非公開の保管庫へ置いて署名付きリンクを返すか（Supabase）は API が決める
 */
export async function buildTenantExport(
  db: DbClient,
  ctx: AuthorizationContext,
  part: TenantExportPart,
  options: { now?: Date } = {},
): Promise<TenantExportResult> {
  assertCanExport(ctx);
  const organizationId = ctx.workspace.organizationId;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const tables: TenantExportTableEntry[] = [];
  const files: TenantExportFileEntry[] = [];
  const missingFiles: Uuid[] = [];

  if (part === 'data') {
    for (const { table, rows, truncated } of await loadTenantRows(db, ctx)) {
      const sqlName = SQL_TABLE_NAMES[table];
      const csv = toCsv({ name: sqlName, columns: columnsOf(rows), rows });
      const bytes = encoder.encode(csv);
      const file = `data/${sqlName}.csv`;
      entries.push({ name: file, bytes });
      tables.push({ table: sqlName, file, rows: rows.length, sha256: sha256(bytes), truncated });
    }
  } else {
    const versions = (await selectAll(db, 'fileVersions', { organizationId })).rows;
    const fileRows = (await selectAll(db, 'files', { organizationId })).rows;
    const fileById = new Map(fileRows.map((f) => [f.id as string, f]));
    const storage = getStorageAdapter();
    for (const version of versions) {
      const file = fileById.get(version.fileId as string);
      const versionId = version.id as Uuid;
      if (!file || typeof version.storageKey !== 'string') {
        missingFiles.push(versionId);
        continue;
      }
      const bytes = await storage.get(file.bucket as never, version.storageKey).catch(() => null);
      if (!bytes) {
        missingFiles.push(versionId);
        continue;
      }
      const path = `files/${versionId}/${safeName(String(file.originalName ?? 'file'))}`;
      entries.push({ name: path, bytes });
      files.push({ path, fileVersionId: versionId, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }

  const manifest: TenantExportManifest = {
    format: TENANT_EXPORT_FORMAT,
    formatVersion: TENANT_EXPORT_FORMAT_VERSION,
    part,
    organizationId,
    generatedAt,
    generatedBy: ctx.userId,
    appVersion: getBuildInfo().label,
    tables,
    files,
    missingFiles,
    excluded: excludedList(),
  };
  entries.push({ name: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)) });
  // 削除の後のバックアップの残存期間は、データ取扱条件の最新の版の合意値（未合意は null）
  const [terms] = await db.select('organizationDataTerms', {
    where: { organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  entries.push({
    name: 'README.md',
    bytes: encoder.encode(tenantExportReadme(manifest, terms?.backupResidualDays ?? null)),
  });
  const zip = buildZip(entries, new Date(generatedAt));

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'tenant_export',
    afterSummary:
      part === 'data'
        ? `全データを書き出し（返却用・データ）: 表 ${tables.length}・行 ${tables.reduce((n, t) => n + t.rows, 0)}`
        : `全データを書き出し（返却用・資料）: 資料 ${files.length}（実体なし ${missingFiles.length}）`,
    metadata: { part, manifestSha256: sha256(JSON.stringify(manifest)) },
  });

  const stamp = generatedAt.slice(0, 10).replace(/-/g, '');
  return {
    zip,
    manifest,
    entries,
    fileName: `T4D_全データ_${part === 'data' ? 'データ' : '資料'}_${stamp}.zip`,
  };
}
