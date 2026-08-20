import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { getAppMode } from '@/lib/config';
import { contentHash, fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  FileObject,
  FileVersion,
  StorageBucket,
  Uuid,
} from '@/types/domain';

/**
 * Storage 抽象（指示書 12 章）。
 *
 * - Evidence は Private。Download は短時間 Signed URL。
 * - Signed URL 発行前に DB Scope と RLS を検証する。
 * - Original Name と Storage Key を分離する（Path Traversal 防止）。
 * - SHA-256 を保存し、置換ではなく新 Version 追加とする。
 * - Virus Scan の接続点を Interface 化する。
 */

export interface StorageAdapter {
  readonly kind: 'demo' | 'supabase';
  put(bucket: StorageBucket, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(bucket: StorageBucket, key: string): Promise<Uint8Array | null>;
  createSignedUrl(bucket: StorageBucket, key: string, expiresInSeconds: number): Promise<string>;
}

/** ウイルススキャンの接続点。Phase 1 は skipped を返すだけ。 */
export interface VirusScanner {
  scan(bytes: Uint8Array): Promise<'clean' | 'infected' | 'skipped'>;
}

export const noopVirusScanner: VirusScanner = {
  async scan() {
    return 'skipped';
  },
};

// ----------------------------------------------------------------------
// Demo（インメモリ）
// ----------------------------------------------------------------------

const DEMO_STORE_KEY = '__t4d_demo_storage__';
type GlobalWithStore = typeof globalThis & { [DEMO_STORE_KEY]?: Map<string, Uint8Array> };

function demoStore(): Map<string, Uint8Array> {
  const g = globalThis as GlobalWithStore;
  if (!g[DEMO_STORE_KEY]) g[DEMO_STORE_KEY] = new Map();
  return g[DEMO_STORE_KEY];
}

class DemoStorageAdapter implements StorageAdapter {
  readonly kind = 'demo' as const;

  async put(bucket: StorageBucket, key: string, bytes: Uint8Array): Promise<void> {
    demoStore().set(`${bucket}/${key}`, bytes);
  }

  async get(bucket: StorageBucket, key: string): Promise<Uint8Array | null> {
    return demoStore().get(`${bucket}/${key}`) ?? null;
  }

  async createSignedUrl(bucket: StorageBucket, key: string): Promise<string> {
    // Demo Mode では自前の Route Handler が権限検証のうえ本文を返す
    return `/api/files/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`;
  }
}

// ----------------------------------------------------------------------
// Supabase
// ----------------------------------------------------------------------

class SupabaseStorageAdapter implements StorageAdapter {
  readonly kind = 'supabase' as const;

  async put(
    bucket: StorageBucket,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const client = await createSupabaseServerClient();
    const { error } = await client.storage
      .from(bucket)
      .upload(key, bytes, { contentType, upsert: false });
    if (error) throw new Error(`Storage への保存に失敗しました: ${error.message}`);
  }

  async get(bucket: StorageBucket, key: string): Promise<Uint8Array | null> {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const client = await createSupabaseServerClient();
    const { data, error } = await client.storage.from(bucket).download(key);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async createSignedUrl(
    bucket: StorageBucket,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const client = await createSupabaseServerClient();
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) throw new Error(`Signed URL の発行に失敗しました: ${error?.message}`);
    return data.signedUrl;
  }
}

export function getStorageAdapter(): StorageAdapter {
  return getAppMode() === 'demo' ? new DemoStorageAdapter() : new SupabaseStorageAdapter();
}

// ----------------------------------------------------------------------
// 高レベル API
// ----------------------------------------------------------------------

/** Object Path を組み立てる。ファイル名は含めず UUID ベースにする。 */
export function buildStorageKey(params: {
  scope: 'enterprise-original' | 'evidence' | 'assurance-workpaper' | 'export';
  organizationId: Uuid;
  reportingPeriodId?: Uuid;
  engagementId?: Uuid;
  objectId: Uuid;
  extension: string;
}): string {
  const ext = params.extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  switch (params.scope) {
    case 'enterprise-original':
      return `enterprise/${params.organizationId}/originals/${params.reportingPeriodId ?? 'unassigned'}/${params.objectId}/data.${ext}`;
    case 'evidence':
      return `enterprise/${params.organizationId}/evidence/${params.objectId}/data.${ext}`;
    case 'assurance-workpaper':
      return `assurance/${params.organizationId}/engagements/${params.engagementId}/workpapers/${params.objectId}/data.${ext}`;
    case 'export':
      return `exports/${params.organizationId}/${params.objectId}/data.${ext}`;
    default:
      throw new Error('未知の scope');
  }
}

export interface StoreFileInput {
  bucket: StorageBucket;
  scope: Parameters<typeof buildStorageKey>[0]['scope'];
  originalName: string;
  mimeType: string;
  bytes: Uint8Array;
  reportingPeriodId?: Uuid | null;
  documentType?: string | null;
  engagementId?: Uuid;
}

export interface StoredFile {
  file: FileObject;
  version: FileVersion;
}

/** 新規ファイルを保存する（常に version 1）。 */
export async function storeNewFile(
  db: DbClient,
  ctx: AuthorizationContext,
  input: StoreFileInput,
): Promise<StoredFile> {
  const organizationId = ctx.workspace.organizationId;
  const now = new Date().toISOString();
  const fileId = fid('file', `${organizationId}/${input.originalName}/${now}`);
  const versionId = fid('file_version', `${fileId}/v1`);
  const extension = input.originalName.split('.').pop() ?? 'bin';

  const storageKey = buildStorageKey({
    scope: input.scope,
    organizationId,
    reportingPeriodId: input.reportingPeriodId ?? undefined,
    engagementId: input.engagementId,
    objectId: versionId,
    extension,
  });

  const scanStatus = await noopVirusScanner.scan(input.bytes);
  if (scanStatus === 'infected') {
    throw new Error('ウイルススキャンで問題が検出されたため、保存を中止しました。');
  }

  await getStorageAdapter().put(input.bucket, storageKey, input.bytes, input.mimeType);

  const file: FileObject = {
    id: fileId,
    organizationId,
    bucket: input.bucket,
    originalName: input.originalName,
    mimeType: input.mimeType,
    confidentiality: 'confidential',
    currentVersionId: versionId,
    documentType: input.documentType ?? null,
    reportingPeriodId: input.reportingPeriodId ?? null,
    scanStatus,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };

  const version: FileVersion = {
    id: versionId,
    fileId,
    organizationId,
    versionNo: 1,
    storageKey,
    sizeBytes: input.bytes.byteLength,
    sha256: await sha256Hex(input.bytes),
    createdAt: now,
    createdBy: ctx.userId,
  };

  await db.insert('files', [file]);
  await db.insert('fileVersions', [version]);
  await recordAuditEvent(db, ctx, {
    eventType: 'file_uploaded',
    resourceType: 'file',
    resourceId: fileId,
    afterSummary: `${input.originalName}（${version.sizeBytes} bytes）`,
  });

  return { file, version };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const buffer = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // WebCrypto が使えない環境向けフォールバック（決定論的ハッシュ）
    return contentHash(Array.from(bytes.subarray(0, 4096)).join(','));
  }
}

/**
 * この Evidence を、このユーザーが取得してよいか。
 *
 * **アプリ層で明示的に判定する。** 以前は `findById` が返ったかどうかだけを見ていたが、
 * Demo Mode の `DbClient` に行レベルの防御は無く（単なる配列検索）、
 * 結果として**他テナントの Evidence を fileVersionId 指定で取得できていた**。
 * Supabase Mode は RLS が止めるが、本番は Demo Mode で動くため実害があった。
 *
 * 判定:
 *  - 自組織のファイル → 可
 *  - 監査法人 → その案件のメンバーで、Evidence を含む有効な許諾があり、
 *              かつ当該ファイルが案件の Data Room 対象へ紐付いている場合のみ可
 *  - それ以外 → 不可（存在を秘匿するため null を返す）
 */
async function canReadEvidence(
  db: DbClient,
  ctx: AuthorizationContext,
  version: { id: Uuid; organizationId: Uuid },
  engagementId: Uuid | null,
): Promise<boolean> {
  // 自組織の原本
  if (version.organizationId === ctx.workspace.organizationId) return true;

  // ここから先は監査法人がクライアントの Evidence を読む経路だけを許す
  if (ctx.workspace.organizationType !== 'assurance_firm') return false;
  if (!engagementId || !ctx.engagementIds.includes(engagementId)) return false;

  const engagement = await db.findById('engagements', engagementId);
  if (!engagement) return false;
  if (engagement.assuranceFirmId !== ctx.workspace.organizationId) return false;
  // 相手方（クライアント）のファイルであること
  if (engagement.clientOrganizationId !== version.organizationId) return false;

  // Evidence を含む有効な許諾があること（取消済みは不可）
  const grants = await db.select('grants', {
    where: { engagementId, includesEvidence: true, revokedAt: { isNull: true } },
    limit: 1,
  });
  if (grants.length === 0) return false;

  // 当該ファイルが、この案件の Data Room 対象へ紐付いていること
  const links = await db.select('evidenceLinks', {
    where: { fileVersionId: version.id, targetType: 'data_point' },
  });
  if (links.length === 0) return false;

  const sharedItems = await db.select('dataRoomItems', {
    where: { engagementId, sourceType: 'data_point', withdrawnAt: { isNull: true } },
  });
  const shared = new Set(sharedItems.map((i) => i.sourceId));
  return links.some((l) => shared.has(l.targetId));
}

/**
 * Signed URL を発行する。
 *
 * 発行前に必ずアプリ層で認可する（`canReadEvidence`）。
 * Supabase Mode では RLS が二重に効くが、**アプリ層だけでも止まる**ようにしている。
 */
export async function createEvidenceSignedUrl(
  db: DbClient,
  ctx: AuthorizationContext,
  fileVersionId: Uuid,
  options: { expiresInSeconds?: number; engagementId?: Uuid | null } = {},
): Promise<{ url: string; expiresAt: string } | null> {
  const expiresIn = options.expiresInSeconds ?? 120;

  const version = await db.findById('fileVersions', fileVersionId);
  if (!version) return null;

  if (!(await canReadEvidence(db, ctx, version, options.engagementId ?? null))) return null;

  const file = await db.findById('files', version.fileId);
  if (!file || file.deletedAt) return null;

  // 2. Signed URL 発行
  const url = await getStorageAdapter().createSignedUrl(file.bucket, version.storageKey, expiresIn);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await db.insert('storageAccessEvents', [
    {
      id: fid('storage_access_event', `${fileVersionId}/${Date.now()}/${ctx.userId}`),
      organizationId: version.organizationId,
      actorUserId: ctx.userId,
      fileVersionId,
      action: 'signed_url_created',
      engagementId: options.engagementId ?? null,
      expiresAt,
      createdAt: new Date().toISOString(),
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'signed_url_created',
    resourceType: 'file_version',
    resourceId: fileVersionId,
    engagementId: options.engagementId ?? null,
    metadata: { expiresInSeconds: expiresIn },
  });

  return { url, expiresAt };
}

/**
 * 自組織が保存した原本のバイト列を読み出す（過去回答 Import の再解析用）。
 *
 * Signed URL を経由せずサーバー内で直接読むため、
 * **必ず所有組織を照合する**（Demo Mode の DbClient には行レベル防御が無い）。
 */
export async function readOwnedFileBytes(
  db: DbClient,
  ctx: AuthorizationContext,
  fileVersionId: Uuid,
): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string } | null> {
  const version = await db.findById('fileVersions', fileVersionId);
  if (!version || version.organizationId !== ctx.workspace.organizationId) return null;

  const file = await db.findById('files', version.fileId);
  if (!file || file.deletedAt || file.organizationId !== ctx.workspace.organizationId) return null;

  const bytes = await getStorageAdapter().get(file.bucket, version.storageKey);
  if (!bytes) return null;

  return { bytes, fileName: file.originalName, mimeType: file.mimeType };
}
