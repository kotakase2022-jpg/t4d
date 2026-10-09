import 'server-only';

import { STORAGE_ACTION_LABEL, auditEventLabel } from '@/app/assurance/_components/labels';
import { assertCan, assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { permissionLabel } from '@/lib/authorization/permission-labels';
import type { DbClient } from '@/lib/repositories/types';
import {
  PERMISSION_KEYS,
  type AuditEvent,
  type AuthorizationContext,
  type IsoDateTime,
  type PermissionKey,
  type StorageAccessEvent,
  type Uuid,
} from '@/types/domain';

/**
 * 企業側の監査ログ（トライアル対応 NF-26・NF-37）。読むだけ。
 *
 * 出すもの（RLS と同じ範囲。Demo Mode は RLS が無いため、ここで同じ条件にする）:
 *  - audit_events: 自社のメンバーの操作（actor_organization_id = 自社）。監査法人の操作の記録は
 *    監査法人の案件の記録であり、企業からは読めない（0013 の SELECT ポリシー）
 *  - storage_access_events: 自社の資料へのアクセス（organization_id = 自社）。監査法人のメンバーが
 *    許諾で開いた・ダウンロードした記録も含む（0012 の SELECT ポリシー。common.audit.read）
 * 監査法人のメンバーの氏名は企業から読めない（profiles の RLS）ので「監査法人のメンバー」と出し、
 * 所属は案件から監査法人の名前を引く。内部 ID・権限キー・生の種類コードを主に出さない。
 */

export const AUDIT_LOG_PERIODS = ['7d', '30d', '90d'] as const;
export type AuditLogPeriod = (typeof AUDIT_LOG_PERIODS)[number];

export const AUDIT_LOG_PERIOD_LABELS: Record<AuditLogPeriod, string> = {
  '7d': '直近 7 日',
  '30d': '直近 30 日',
  '90d': '直近 90 日',
};

const PERIOD_DAYS: Record<AuditLogPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** 資料へのアクセスの種類のキー（監査ログの種類と同じ並びで絞り込む） */
const FILE_KIND_PREFIX = 'file:';
const FILE_ACTIONS = ['signed_url_created', 'downloaded', 'viewed'] as const;
type FileAction = (typeof FILE_ACTIONS)[number];

/** 監査ログの対象の種類（resource_type）の表示名。無いものは「記録」 */
const RESOURCE_LABELS: Record<string, string> = {
  data_point: 'データ',
  data_points: '非財務データ',
  file: '資料',
  file_version: '資料',
  invitation: '招待',
  organization_membership: 'メンバー',
  profile: '利用者',
  organization: '組織',
  approval_route: '承認ルート',
  client_access_grant: 'アクセス許諾',
  pbc_request_response: '資料依頼への回答',
  disclosure_project: '開示プロジェクト',
  disclosure_block: '原稿の節',
  narrative_record: '定性情報',
  report_snapshot: 'レポートの確定版',
  shared_report_copy: '保証側へ共有したレポート',
  quantitative_import_batch: '数値の登録',
  organization_data_terms: 'データ取扱条件',
  organization_feature_settings: '機能設定',
  tenant_export: '全データの書き出し',
  audit_events: '監査ログ',
  trial_feedback: 'ご意見・不具合',
};

export type AuditAffiliationKind = 'own' | 'firm' | 'external' | 'system';

export interface AuditLogEntry {
  /** 行の識別子（表の行の鍵。画面には出さない） */
  id: string;
  at: IsoDateTime;
  source: 'event' | 'file_access';
  /** 絞り込みの値（監査ログの種類か file:<操作>） */
  kindKey: string;
  kindLabel: string;
  actorUserId: Uuid | null;
  actorName: string;
  affiliation: { kind: AuditAffiliationKind; label: string };
  target: string;
  summary: string;
}

export interface AuditLogFilter {
  period?: AuditLogPeriod | null;
  /** 種類（監査ログの種類か file:<操作>） */
  kind?: string | null;
  actorUserId?: Uuid | null;
  /** 監査法人（社外）の資料アクセスだけ */
  firmFilesOnly?: boolean;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /** 絞り込み後の総件数（ページを辿れるように） */
  total: number;
  page: number;
  pageSize: number;
  /** 絞り込みの選択肢: 種類（記録にあるもの）・実行者（自社のメンバー） */
  kinds: Array<{ key: string; label: string }>;
  actors: Array<{ id: Uuid; name: string }>;
}

/** 種類の選択肢（監査ログの全種類と資料アクセスの 3 種） */
export function auditKindOptions(): Array<{ key: string; label: string }> {
  return FILE_ACTIONS.map((action) => ({
    key: `${FILE_KIND_PREFIX}${action}`,
    label: `資料の${STORAGE_ACTION_LABEL[action]}`,
  }));
}

function isPeriod(value: unknown): value is AuditLogPeriod {
  return typeof value === 'string' && (AUDIT_LOG_PERIODS as readonly string[]).includes(value);
}

/** URL の値から絞り込みを作る（形の合わない値は無視する） */
export function auditFilterFrom(
  params: Record<string, string | string[] | undefined>,
): AuditLogFilter {
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);
  const period = one('period');
  const actor = one('actor');
  return {
    period: isPeriod(period) ? period : null,
    kind: one('kind'),
    actorUserId: actor && /^[0-9a-f-]{36}$/i.test(actor) ? actor : null,
    firmFilesOnly: one('scope') === 'firm-files',
  };
}

interface Directory {
  organizationId: Uuid;
  memberIds: Uuid[];
  nameOf: Map<Uuid, string>;
  firmNameOfEngagement: Map<Uuid, string>;
  fileNameOfVersion: Map<Uuid, string>;
}

async function loadDirectory(
  db: DbClient,
  ctx: AuthorizationContext,
  fileVersionIds: Uuid[],
): Promise<Directory> {
  const organizationId = ctx.workspace.organizationId;
  const [memberships, engagements] = await Promise.all([
    db.select('memberships', { where: { organizationId } }),
    db.select('engagements', { where: { clientOrganizationId: organizationId } }),
  ]);
  const memberIds = [...new Set(memberships.map((m) => m.userId))];
  const [profiles, firms, versions] = await Promise.all([
    memberIds.length > 0 ? db.select('profiles', { where: { id: { in: memberIds } } }) : [],
    engagements.length > 0
      ? db.select('organizations', {
          where: { id: { in: [...new Set(engagements.map((e) => e.assuranceFirmId))] } },
        })
      : [],
    fileVersionIds.length > 0
      ? db.select('fileVersions', { where: { organizationId, id: { in: fileVersionIds } } })
      : [],
  ]);
  const files =
    versions.length > 0
      ? await db.select('files', {
          where: { organizationId, id: { in: [...new Set(versions.map((v) => v.fileId))] } },
        })
      : [];
  const fileName = new Map(files.map((f) => [f.id, f.originalName]));
  const firmName = new Map(firms.map((f) => [f.id, f.name]));
  return {
    organizationId,
    memberIds,
    nameOf: new Map(profiles.map((p) => [p.id, p.displayName])),
    firmNameOfEngagement: new Map(
      engagements.map((e) => [e.id, firmName.get(e.assuranceFirmId) ?? '監査法人']),
    ),
    fileNameOfVersion: new Map(versions.map((v) => [v.id, fileName.get(v.fileId) ?? '資料'])),
  };
}

function permissionOf(value: unknown): PermissionKey | null {
  return typeof value === 'string' && (PERMISSION_KEYS as readonly string[]).includes(value)
    ? (value as PermissionKey)
    : null;
}

function eventSummary(event: AuditEvent): string {
  if (event.eventType === 'access_denied') {
    const permission = permissionOf(event.metadata?.permission);
    const route = typeof event.metadata?.route === 'string' ? event.metadata.route : null;
    return `${permission ? `「${permissionLabel(permission)}」の権限が無いため断りました` : '権限が無いため断りました'}${route ? `（${route}）` : ''}`;
  }
  const parts = [event.beforeSummary, event.afterSummary].filter((s): s is string => !!s);
  return parts.length === 2 ? `${parts[0]} → ${parts[1]}` : (parts[0] ?? '—');
}

function toEventEntry(event: AuditEvent, dir: Directory): AuditLogEntry {
  const own = event.actorUserId !== null && dir.memberIds.includes(event.actorUserId);
  return {
    id: `event:${event.id}`,
    at: event.createdAt,
    source: 'event',
    kindKey: event.eventType,
    kindLabel: auditEventLabel(event.eventType),
    actorUserId: event.actorUserId,
    actorName: event.actorUserId
      ? (dir.nameOf.get(event.actorUserId) ?? '（退会した利用者）')
      : 'システム',
    affiliation: event.actorUserId
      ? { kind: 'own', label: own ? '自社' : '自社（退会）' }
      : { kind: 'system', label: '—' },
    target: event.resourceType ? (RESOURCE_LABELS[event.resourceType] ?? '記録') : '—',
    summary: eventSummary(event),
  };
}

function toFileEntry(event: StorageAccessEvent, dir: Directory): AuditLogEntry {
  const own = dir.memberIds.includes(event.actorUserId);
  const firm = event.engagementId ? dir.firmNameOfEngagement.get(event.engagementId) : undefined;
  const action = event.action as FileAction;
  return {
    id: `file:${event.id}`,
    at: event.createdAt,
    source: 'file_access',
    kindKey: `${FILE_KIND_PREFIX}${event.action}`,
    kindLabel: `資料の${STORAGE_ACTION_LABEL[action] ?? '操作'}`,
    actorUserId: event.actorUserId,
    actorName: own ? (dir.nameOf.get(event.actorUserId) ?? '利用者') : '監査法人のメンバー',
    affiliation: own
      ? { kind: 'own', label: '自社' }
      : firm
        ? { kind: 'firm', label: firm }
        : { kind: 'external', label: '社外（監査法人など）' },
    target: dir.fileNameOfVersion.get(event.fileVersionId) ?? '資料',
    summary:
      event.action === 'signed_url_created' && event.expiresAt
        ? '資料を開くリンクを発行（有効期限つき）'
        : event.action === 'viewed'
          ? '資料を画面で表示'
          : '資料をダウンロード',
  };
}

function sinceOf(period: AuditLogPeriod | null | undefined, now: Date): IsoDateTime | null {
  if (!period) return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * 24 * 3600 * 1000).toISOString();
}

/** どちらの表を読むか（種類・社外の資料アクセスの絞り込みで片方だけになる） */
function sourcesFor(filter: AuditLogFilter): { events: boolean; files: boolean } {
  if (filter.firmFilesOnly) return { events: false, files: true };
  if (filter.kind) {
    const isFile = filter.kind.startsWith(FILE_KIND_PREFIX);
    return { events: !isFile, files: isFile };
  }
  return { events: true, files: true };
}

/**
 * 監査ログの 1 ページ（common.audit.read・企業のワークスペースだけ）。
 * 2 つの表を新しい順に読み、上から page × pageSize 件ずつを合わせて並べ替え、ページを切り出す
 * （それぞれの上位 N 件の合併は、合わせた表の上位 N 件を必ず含む）
 */
export async function listOrganizationAudit(
  db: DbClient,
  ctx: AuthorizationContext,
  filter: AuditLogFilter,
  options: { page?: number; pageSize?: number; now?: Date } = {},
): Promise<AuditLogPage> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'common.audit.read');
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 500);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const take = Math.min(page * pageSize, 10_000);
  return collect(db, ctx, filter, { take, now: options.now ?? new Date() }).then((result) => ({
    ...result,
    entries: result.entries.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
  }));
}

/** CSV 用: 絞り込んだ記録を新しい順に上限まで（common.audit.read） */
export async function listOrganizationAuditForExport(
  db: DbClient,
  ctx: AuthorizationContext,
  filter: AuditLogFilter,
  options: { limit?: number; now?: Date } = {},
): Promise<{ entries: AuditLogEntry[]; total: number }> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'common.audit.read');
  const result = await collect(db, ctx, filter, {
    take: Math.min(options.limit ?? 10_000, 10_000),
    now: options.now ?? new Date(),
  });
  return { entries: result.entries, total: result.total };
}

async function collect(
  db: DbClient,
  ctx: AuthorizationContext,
  filter: AuditLogFilter,
  options: { take: number; now: Date },
): Promise<Omit<AuditLogPage, 'page' | 'pageSize'>> {
  const organizationId = ctx.workspace.organizationId;
  const since = sinceOf(filter.period, options.now);
  const sources = sourcesFor(filter);
  const memberships = await db.select('memberships', { where: { organizationId } });
  const memberIds = [...new Set(memberships.map((m) => m.userId))];

  const eventWhere = {
    actorOrganizationId: organizationId,
    ...(since ? { createdAt: { gte: since } } : {}),
    ...(filter.kind && sources.events ? { eventType: filter.kind as AuditEvent['eventType'] } : {}),
    ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
  };
  const fileAction =
    filter.kind && sources.files ? filter.kind.slice(FILE_KIND_PREFIX.length) : null;
  if (fileAction !== null && !(FILE_ACTIONS as readonly string[]).includes(fileAction)) {
    return { entries: [], total: 0, kinds: auditKindOptions(), actors: [] };
  }
  const fileWhere = {
    organizationId,
    ...(since ? { createdAt: { gte: since } } : {}),
    ...(fileAction ? { action: fileAction as FileAction } : {}),
    ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
    ...(filter.firmFilesOnly && memberIds.length > 0 ? { actorUserId: { notIn: memberIds } } : {}),
  };

  const [events, eventTotal, files, fileTotal] = await Promise.all([
    sources.events
      ? db.select('auditEvents', {
          where: eventWhere,
          orderBy: [
            { column: 'createdAt', dir: 'desc' },
            { column: 'id', dir: 'desc' },
          ],
          limit: options.take,
        })
      : [],
    sources.events ? db.count('auditEvents', { where: eventWhere }) : 0,
    sources.files
      ? db.select('storageAccessEvents', {
          where: fileWhere,
          orderBy: [
            { column: 'createdAt', dir: 'desc' },
            { column: 'id', dir: 'desc' },
          ],
          limit: options.take,
        })
      : [],
    sources.files ? db.count('storageAccessEvents', { where: fileWhere }) : 0,
  ]);

  const dir = await loadDirectory(db, ctx, [...new Set(files.map((f) => f.fileVersionId))]);
  const entries = [
    ...events.map((event) => toEventEntry(event, dir)),
    ...files.map((event) => toFileEntry(event, dir)),
  ]
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    .slice(0, options.take);

  return {
    entries,
    total: eventTotal + fileTotal,
    kinds: auditKindOptions(),
    actors: memberIds
      .map((id) => ({ id, name: dir.nameOf.get(id) ?? '利用者' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
  };
}

// ----------------------------------------------------------------------
// 利用状況（NF-37。最終ログイン・直近 30 日の操作数）
// ----------------------------------------------------------------------

export interface MemberActivity {
  /** このワークスペースへ最後に入った日時（ワークスペースの選択の記録）。記録が無ければ null */
  lastActiveAt: IsoDateTime | null;
  /** 直近 30 日の操作の数（ログイン・ワークスペースの選択・ログアウトを除く監査ログ） */
  actions30d: number;
}

const NON_ACTION_EVENTS = [
  'login_success',
  'login_failure',
  'logout',
  'workspace_selected',
] as const;

/**
 * メンバーごとの利用状況。監査ログを読める人（common.audit.read）だけ。持たない人には null を返し、
 * 画面は列を出さない（plan §5 D13 の既定）。画面の閲覧回数は数えない（閲覧を記録していないため）。
 * 自社の名義の記録だけを数える（RLS と同じ。ログインの記録は組織を持たないため、組織を選んだ記録を使う）
 */
export async function memberActivity(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { now?: Date } = {},
): Promise<Map<Uuid, MemberActivity> | null> {
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'common.audit.read')) {
    return null;
  }
  const organizationId = ctx.workspace.organizationId;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const memberships = await db.select('memberships', { where: { organizationId } });
  const userIds = [...new Set(memberships.map((m) => m.userId))];
  const entries = await Promise.all(
    userIds.map(async (userId): Promise<[Uuid, MemberActivity]> => {
      const [last, actions] = await Promise.all([
        db.select('auditEvents', {
          where: {
            actorOrganizationId: organizationId,
            actorUserId: userId,
            eventType: 'workspace_selected',
          },
          orderBy: { column: 'createdAt', dir: 'desc' },
          limit: 1,
        }),
        db.count('auditEvents', {
          where: {
            actorOrganizationId: organizationId,
            actorUserId: userId,
            createdAt: { gte: since },
            eventType: { notIn: [...NON_ACTION_EVENTS] },
          },
        }),
      ]);
      return [userId, { lastActiveAt: last[0]?.createdAt ?? null, actions30d: actions }];
    }),
  );
  return new Map(entries);
}
