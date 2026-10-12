import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEngagementMember,
  AuthorizationError,
  can,
  NotFoundError,
} from '@/lib/authorization/can';
import { notFound } from 'next/navigation';
import {
  parseSharedReportCopy,
  sharedReportCopyHash,
  type SharedReportCopyContent,
} from '@/lib/domain/report-copy';
import { buildReportTrace, type TraceSummary, type TraceUnit } from '@/lib/domain/report-trace';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import {
  clientNoteStateOf,
  listNotesForClient,
  listNotesForCopy,
  type ClientNoteEntry,
  type FirmNoteEntry,
} from '@/lib/services/assurance-notes';
import { listDataRoomDataPoints } from '@/lib/services/data-room-sync';
import {
  listSharedReports,
  listSharedReportsForClient,
  loadSharedReport,
  type LoadedSharedReport,
} from '@/lib/services/report-share';
import { selectSample } from '@/lib/services/sampling';
import type { ClientNoteState } from '@/lib/ui/status/clientNote';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AssuranceSnapshot,
  AssuranceSnapshotItem,
  AuthorizationContext,
  DataPoint,
  IsoDateTime,
  Engagement,
  MetricDefinition,
  OrganizationUnit,
  Population,
  PopulationItem,
  ReportNoteTargetType,
  ReviewNote,
  ReviewNoteResponse,
  Sample,
  SampleItem,
  SamplingMethod,
  SamplingParameters,
  SharedReportCopy,
  Signoff,
  SignoffBlocker,
  SignoffStage,
  SnapshotChange,
  Uuid,
} from '@/types/domain';

/**
 * 監査法人ワークスペースのサービス層（指示書 7.2 / 16 章）。
 *
 * 重要な設計:
 *  - 監査法人は企業原本を一切更新しない（更新系メソッドを持たない）。
 *  - Snapshot は Immutable。作成のみ。
 *  - Snapshot 後変更は「固定値」と「現在の Version」を突き合わせて動的に検出する。
 *  - Sign-off は抑止条件を満たさない限り作成できない。
 */

// ----------------------------------------------------------------------
// 案件ロード
// ----------------------------------------------------------------------

export interface EngagementContext {
  engagement: Engagement;
  clientName: string;
  periodLabel: string;
  periodCode: string;
}

/**
 * 画面（RSC）用。権限外・不存在はすべて 404 として扱い、案件の存在を秘匿する
 * （指示書 8 章「URL を直接入力しても認可を通らない限り閲覧不可」）。
 */
export async function loadEngagementOr404(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<EngagementContext> {
  try {
    return await loadEngagement(db, ctx, engagementId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof AuthorizationError) {
      notFound();
    }
    throw error;
  }
}

export async function loadEngagement(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<EngagementContext> {
  // Engagement Member でなければ「存在しない」として扱う（URL 直打ち対策）
  assertEngagementMember(ctx, engagementId);

  const engagement = await db.findById('engagements', engagementId);
  if (!engagement || engagement.assuranceFirmId !== ctx.workspace.organizationId) {
    throw new NotFoundError('案件が見つかりません。');
  }
  const client = await db.findById('organizations', engagement.clientOrganizationId);
  const period = await db.findById('periods', engagement.clientReportingPeriodId);

  return {
    engagement,
    clientName: client?.name ?? '（クライアント）',
    periodLabel: period?.label ?? '',
    periodCode: period?.code ?? '',
  };
}

// ----------------------------------------------------------------------
// Data Room（許諾された企業データの Read-only ビュー）
// ----------------------------------------------------------------------

export interface DataRoomRow {
  dataPointId: Uuid;
  metric: MetricDefinition | null;
  unit: OrganizationUnit | null;
  currentValue: number | null;
  currentUnitOfMeasure: string;
  currentVersionNo: number | null;
  clientStatus: string;
  sharedAt: string;
  snapshotIncluded: boolean;
  changedSinceSnapshot: boolean;
  evidenceCount: number;
  /** 指標の許諾が Evidence を含むか（含まなければ資料の実体は開けない） */
  includesEvidence: boolean;
}

/** Data Room の「取得元: 開示レポート」の行（企業が共有した承認済みレポートの写し。NF-20） */
export interface DataRoomReportRow {
  copyId: Uuid;
  /** 例「No.1 社内承認済み版」 */
  label: string;
  frameworkNames: string[];
  sharedAt: IsoDateTime;
  copyHash: string;
}

/**
 * Data Room に出す Data Point（トライアル対応 NF-22。読み取り時に導出し、書き込まない）。
 *
 * 許諾（指標×組織×期間）と企業側承認済みの Data Point から導く（data-room-sync.ts。条件は DB 関数
 * `t4d.assurance_can_read_data_point()` と同じ）。そのうえで data_room_items の **取り下げの記録** を守る:
 * 企業が明示的に取り下げた Data Point（取り下げた行だけがあり、有効な行が無いもの）は出さない。
 * Data Room の表示・Snapshot の固定・資料依頼の対象の 3 か所が同じこの関数を使う
 * （画面ごとに別の条件で「共有中」を数えない）。
 *
 * 認可は呼び出し側（assertEngagementMember）で確かめる。
 */
export { listDataRoomDataPoints };

/** 写しの表示名（例「No.1 社内承認済み版」） */
export function sharedReportLabel(content: Pick<SharedReportCopyContent, 'snapshotNo' | 'label'>) {
  return `No.${content.snapshotNo} ${content.label}`;
}

export async function loadDataRoom(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<{
  rows: DataRoomRow[];
  snapshot: AssuranceSnapshot | null;
  reports: DataRoomReportRow[];
}> {
  assertEngagementMember(ctx, engagementId);

  // 許諾と承認状態は **アプリ層でも** 見る。
  // Supabase Mode では t4d.assurance_can_read_data_point() が同じ判定をするが、
  // Demo Mode（本番の動作モード）には RLS が無く、ここが唯一の防御になる。
  // 判定条件は上記 SQL 関数と一致させること（片方だけ変えない。data-room-sync.ts）。
  const shared = await listDataRoomDataPoints(db, engagementId);
  const snapshot = await loadLatestSnapshot(db, engagementId);
  const snapshotItems = snapshot
    ? await db.select('snapshotItems', { where: { snapshotId: snapshot.id } })
    : [];
  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];
  const changedIds = new Set(changes.map((c) => c.snapshotItemId));

  const dataPoints = shared.map((s) => s.dataPoint);
  const dataPointIds = dataPoints.map((dp) => dp.id);
  const metricIds = [...new Set(dataPoints.map((dp) => dp.metricId))];
  const unitIds = [...new Set(dataPoints.map((dp) => dp.unitId))];
  const [metrics, units, versions, evidenceLinks, copies] = await Promise.all([
    metricIds.length > 0 ? db.select('metrics', { where: { id: { in: metricIds } } }) : [],
    unitIds.length > 0 ? db.select('units', { where: { id: { in: unitIds } } }) : [],
    dataPointIds.length > 0
      ? db.select('dataPointVersions', { where: { dataPointId: { in: dataPointIds } } })
      : [],
    dataPointIds.length > 0
      ? db.select('evidenceLinks', {
          where: { targetType: 'data_point', targetId: { in: dataPointIds } },
        })
      : [],
    // 開示レポートの写しは案件の閲覧権限で読む（report-share.ts の listSharedReports と同じ条件）
    can(ctx, 'assurance.engagement.read')
      ? db.select('sharedReportCopies', {
          where: { engagementId, withdrawnAt: { isNull: true } },
          orderBy: [
            { column: 'sharedAt', dir: 'desc' },
            { column: 'id', dir: 'desc' },
          ],
        })
      : [],
  ]);

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const rows: DataRoomRow[] = shared.map(({ dataPoint: dp, sharedAt, includesEvidence }) => {
    const version = versions.find((v) => v.id === dp.currentVersionId);
    const snapshotItem = snapshotItems.find((s) => s.sourceId === dp.id);
    return {
      dataPointId: dp.id,
      metric: metricById.get(dp.metricId) ?? null,
      unit: unitById.get(dp.unitId) ?? null,
      currentValue: dp.value,
      currentUnitOfMeasure: dp.unitOfMeasure,
      currentVersionNo: version?.versionNo ?? null,
      clientStatus: dp.status,
      sharedAt,
      snapshotIncluded: Boolean(snapshotItem),
      changedSinceSnapshot: snapshotItem ? changedIds.has(snapshotItem.id) : false,
      evidenceCount: evidenceLinks.filter((l) => l.targetId === dp.id).length,
      includesEvidence,
    };
  });

  const reports: DataRoomReportRow[] = [];
  for (const copy of copies) {
    const content = parseSharedReportCopy(copy.copy);
    if (!content) continue;
    reports.push({
      copyId: copy.id,
      label: sharedReportLabel(content),
      frameworkNames: content.frameworkVersions.map((f) => f.frameworkName),
      sharedAt: copy.sharedAt,
      copyHash: copy.copyHash,
    });
  }

  return { rows, snapshot, reports };
}

/** 続けて表示した記録をひとまとまりの閲覧とみなす間隔（これより空いたら別の閲覧） */
export const DATA_ROOM_SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * 前回の閲覧の最後の表示日時。検索・絞込・ページ送り・再読込のたびに表示を記録するため、直前の記録は
 * 数秒前の同じ閲覧の記録になる。間が DATA_ROOM_SESSION_GAP_MS 以内で続く記録を今回の閲覧として飛ばし、
 * その前の閲覧の最後の時刻を返す（無ければ null）。previousDesc は新しい順
 */
export function previousSessionViewAt(
  previousDesc: readonly IsoDateTime[],
  now: IsoDateTime,
  gapMs: number = DATA_ROOM_SESSION_GAP_MS,
): IsoDateTime | null {
  let boundary = Date.parse(now);
  for (const at of previousDesc) {
    const time = Date.parse(at);
    if (boundary - time <= gapMs) {
      boundary = time;
      continue;
    }
    return at;
  }
  return null;
}

/**
 * Data Room を表示したことを監査ログ（監査法人の記録）に残し、この人の前回の閲覧の日時を返す
 * （NF-26 の閲覧記録の補完）。
 *
 * 1 画面の表示につき 1 件・要約だけ（件数）を残す（個々の値・指標名は入れない）。記録は監査法人の
 * 監査ログに残る（企業側の監査ログには出ない。企業側が辿れるのは資料のダウンロード・閲覧の記録
 * storage_access_events だけ。known-limitations §13）。前回の閲覧の日時は「前回表示以降に共有された n 件」の
 * 絞込に使う（続けて表示した記録は 1 回の閲覧にまとめる。Demo Mode の監査ログは同じインスタンスの記録
 * だけのため、別のインスタンスでは前回が分からないことがある）。
 */
export async function recordDataRoomView(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  summary: { dataPoints: number; reports: number },
): Promise<{ previousViewedAt: IsoDateTime | null }> {
  assertEngagementMember(ctx, engagementId);
  const previous = await db.select('auditEvents', {
    where: {
      engagementId,
      eventType: 'record_viewed',
      resourceType: DATA_ROOM_VIEW_RESOURCE,
      actorUserId: ctx.userId,
    },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
    limit: 200,
  });
  const now = new Date().toISOString();
  await recordAuditEvent(db, ctx, {
    eventType: 'record_viewed',
    resourceType: DATA_ROOM_VIEW_RESOURCE,
    resourceId: engagementId,
    engagementId,
    afterSummary: `Data Room を表示（非財務データ ${summary.dataPoints} 件・開示レポート ${summary.reports} 件）`,
  });
  return {
    previousViewedAt: previousSessionViewAt(
      previous.map((e) => e.createdAt),
      now,
    ),
  };
}

/** 閲覧記録の対象の種類（監査ログの resource_type） */
export const DATA_ROOM_VIEW_RESOURCE = 'data_room';
export const SHARED_REPORT_VIEW_RESOURCE = 'shared_report_copy';

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

export async function loadLatestSnapshot(
  db: DbClient,
  engagementId: Uuid,
): Promise<AssuranceSnapshot | null> {
  const rows = await db.select('snapshots', {
    where: { engagementId },
    orderBy: { column: 'frozenAt', dir: 'desc' },
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function createSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  label: string,
): Promise<AssuranceSnapshot> {
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.snapshot.create');

  const { engagement } = await loadEngagement(db, ctx, engagementId);
  // 固定の対象は Data Room の表示と同じ導出（許諾×承認済み。取り下げの記録を守る）。
  // 以前は data_room_items だけを読んでいたため、許諾を足しても承認しても固定の対象に入らなかった
  const shared = await listDataRoomDataPoints(db, engagementId);
  if (shared.length === 0) {
    throw new AuthorizationError('Data Room に共有された対象がありません。');
  }

  const dataPoints = shared.map((s) => s.dataPoint);
  const dataPointIds = dataPoints.map((dp) => dp.id);
  const versions = await db.select('dataPointVersions', {
    where: { dataPointId: { in: dataPointIds } },
  });

  const frozenAt = new Date().toISOString();
  const snapshotId = fid('snapshot', `${engagementId}/${frozenAt}`);

  const snapshotItems: AssuranceSnapshotItem[] = [];
  for (const dp of dataPoints) {
    const version = versions.find((v) => v.id === dp.currentVersionId);
    if (!version) continue;
    snapshotItems.push({
      id: fid('snapshot_item', `${snapshotId}/${dp.id}`),
      snapshotId,
      engagementId,
      assuranceFirmId: engagement.assuranceFirmId,
      sourceType: 'data_point',
      sourceId: dp.id,
      sourceVersionId: version.id,
      sourceDataPointVersionId: version.id,
      sourceFileVersionId: null,
      valueSnapshot: {
        value: version.value,
        unitOfMeasure: version.unitOfMeasure,
        status: version.status,
        metricId: dp.metricId,
        unitId: dp.unitId,
        reportingPeriodId: dp.reportingPeriodId,
        versionNo: version.versionNo,
      },
      hash: version.contentHash,
      frozenAt,
      frozenBy: ctx.userId,
    });
  }

  const snapshot: AssuranceSnapshot = {
    id: snapshotId,
    engagementId,
    assuranceFirmId: engagement.assuranceFirmId,
    label,
    frozenAt,
    frozenBy: ctx.userId,
    itemCount: snapshotItems.length,
    hash: contentHash(snapshotItems.map((i) => i.hash).join('|')),
    note: null,
  };

  await db.insert('snapshots', [snapshot]);
  await db.insert('snapshotItems', snapshotItems);

  // 母集団は「Snapshot から構成した固定の集合」（CLAUDE.md §8）。
  // Snapshot を固定しても母集団が作られないと、サンプリング画面が
  // 「母集団が作成されていません」のままで手続へ進めない。
  await buildPopulationFromSnapshot(db, ctx, engagement, snapshot, snapshotItems, dataPoints);

  await recordAuditEvent(db, ctx, {
    eventType: 'snapshot_created',
    resourceType: 'assurance_snapshot',
    resourceId: snapshotId,
    engagementId,
    afterSummary: `${snapshotItems.length} 件を固定（hash=${snapshot.hash.slice(0, 12)}）`,
  });

  return snapshot;
}

/**
 * Snapshot から母集団を構成する。
 *
 * 固定した各項目をそのまま母集団項目にし、組織名を層（stratum）に使う。
 * 網羅性の突合として、Scope 上「対象」の件数と実際に入った件数の差を欠損として持つ。
 */
async function buildPopulationFromSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  engagement: Engagement,
  snapshot: AssuranceSnapshot,
  snapshotItems: AssuranceSnapshotItem[],
  dataPoints: DataPoint[],
): Promise<Population | null> {
  if (snapshotItems.length === 0) return null;

  const existing = await db.select('populations', {
    where: { engagementId: engagement.id },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const versionNo = (existing[0]?.versionNo ?? 0) + 1;
  const populationId = fid('population', `${engagement.id}/${snapshot.id}`);

  const unitIds = [...new Set(dataPoints.map((dp) => dp.unitId))];
  const units =
    unitIds.length > 0 ? await db.select('units', { where: { id: { in: unitIds } } }) : [];
  const unitById = new Map(units.map((u) => [u.id, u]));

  const items: PopulationItem[] = [];
  for (const item of snapshotItems) {
    const dp = dataPoints.find((d) => d.id === item.sourceId);
    if (!dp) continue;
    items.push({
      id: fid('population_item', `${populationId}/${dp.id}`),
      populationId,
      engagementId: engagement.id,
      assuranceFirmId: engagement.assuranceFirmId,
      snapshotItemId: item.id,
      sourceDataPointId: dp.id,
      metricId: dp.metricId,
      unitId: dp.unitId,
      value: Number(item.valueSnapshot.value ?? 0),
      unitOfMeasure: String(item.valueSnapshot.unitOfMeasure ?? ''),
      stratum: unitById.get(dp.unitId)?.name ?? null,
      excluded: false,
      exclusionReason: null,
    });
  }
  if (items.length === 0) return null;

  const scopes = await db.select('engagementScopes', {
    where: { engagementId: engagement.id, inclusion: 'included' },
  });

  const population: Population = {
    id: populationId,
    engagementId: engagement.id,
    assuranceFirmId: engagement.assuranceFirmId,
    snapshotId: snapshot.id,
    name: `保証対象 Data Point 母集団（${snapshot.label}）`,
    versionNo,
    filter: {
      metricIds: [...new Set(items.map((i) => i.metricId))],
      unitIds: [...new Set(items.map((i) => i.unitId))],
      reportingPeriodIds: [...new Set(dataPoints.map((dp) => dp.reportingPeriodId))],
      minValue: null,
      maxValue: null,
    },
    itemCount: items.length,
    totalValue: Math.round(items.reduce((sum, i) => sum + i.value, 0) * 1000) / 1000,
    missingCount: Math.max(0, scopes.length - items.length),
    duplicateCount: 0,
    excludedCount: 0,
    reconciliationNote:
      'Snapshot 固定時点の共有済み Data Point を母集団とした。差異は未承認または許諾範囲外による。',
    completenessProcedureNote:
      'Scope 上「対象」の件数と母集団件数を突合し、差分を欠損として記録した。',
    createdAt: snapshot.frozenAt,
    createdBy: ctx.userId,
  };

  await db.insert('populations', [population]);
  await db.insert('populationItems', items);
  return population;
}

/**
 * Snapshot 後の企業側変更を検出する。
 *
 * 固定値（valueSnapshot）と現在の Data Point Version を突き合わせる。
 * 保存済みの `snapshot_changes` があればそれとマージし、評価済みの判定を保持する。
 */
export async function detectSnapshotChanges(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotId: Uuid,
): Promise<SnapshotChange[]> {
  const snapshot = await db.findById('snapshots', snapshotId);
  if (!snapshot) return [];
  assertEngagementMember(ctx, snapshot.engagementId);

  const items = await db.select('snapshotItems', { where: { snapshotId } });
  if (items.length === 0) return [];

  const dataPointIds = items.map((i) => i.sourceId);
  const [dataPoints, versions, stored] = await Promise.all([
    db.select('dataPoints', { where: { id: { in: dataPointIds } } }),
    db.select('dataPointVersions', { where: { dataPointId: { in: dataPointIds } } }),
    db.select('snapshotChanges', { where: { snapshotId } }),
  ]);

  const storedByItem = new Map(stored.map((c) => [c.snapshotItemId, c]));
  const out: SnapshotChange[] = [];

  for (const item of items) {
    const dp = dataPoints.find((d) => d.id === item.sourceId);
    if (!dp) continue;
    const current = versions.find((v) => v.id === dp.currentVersionId);
    if (!current) continue;

    // Snapshot 固定時の Version と現在の Version が同じなら変更なし
    if (current.contentHash === item.hash) continue;

    const existing = storedByItem.get(item.id);
    const before = `${item.valueSnapshot.value ?? '—'} ${item.valueSnapshot.unitOfMeasure ?? ''} (v${item.valueSnapshot.versionNo ?? '?'})`;
    const after = `${current.value ?? '—'} ${current.unitOfMeasure} (v${current.versionNo})`;

    out.push({
      id: existing?.id ?? fid('snapshot_change', `${item.id}/${current.id}`),
      snapshotId,
      engagementId: snapshot.engagementId,
      assuranceFirmId: snapshot.assuranceFirmId,
      snapshotItemId: item.id,
      changeKind:
        Number(item.valueSnapshot.value) !== current.value ? 'value_changed' : 'version_added',
      beforeSummary: before,
      afterSummary: after,
      detectedAt: existing?.detectedAt ?? new Date().toISOString(),
      assessedBy: existing?.assessedBy ?? null,
      assessedAt: existing?.assessedAt ?? null,
      assessment: existing?.assessment ?? null,
    });
  }

  return out;
}

// ----------------------------------------------------------------------
// 母集団 / サンプル
// ----------------------------------------------------------------------

export interface PopulationSummaryView {
  population: Population;
  items: Array<PopulationItem & { metricName: string; unitName: string }>;
  expectedInScope: number;
}

export async function loadPopulation(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<PopulationSummaryView | null> {
  assertEngagementMember(ctx, engagementId);
  const populations = await db.select('populations', {
    where: { engagementId },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const population = populations[0];
  if (!population) return null;

  const items = await db.select('populationItems', { where: { populationId: population.id } });
  const metricIds = [...new Set(items.map((i) => i.metricId))];
  const unitIds = [...new Set(items.map((i) => i.unitId))];
  const [metrics, units, scopes] = await Promise.all([
    metricIds.length > 0 ? db.select('metrics', { where: { id: { in: metricIds } } }) : [],
    unitIds.length > 0 ? db.select('units', { where: { id: { in: unitIds } } }) : [],
    db.select('engagementScopes', { where: { engagementId, inclusion: 'included' } }),
  ]);
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  return {
    population,
    items: items.map((item) => ({
      ...item,
      metricName: metricById.get(item.metricId)?.name ?? '—',
      unitName: unitById.get(item.unitId)?.name ?? '—',
    })),
    expectedInScope: scopes.length,
  };
}

export interface CreateSampleInput {
  engagementId: Uuid;
  populationId: Uuid;
  name: string;
  method: SamplingMethod;
  seed: string;
  parameters: SamplingParameters;
  rationale: string;
}

export async function createSample(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateSampleInput,
): Promise<Sample> {
  assertEngagementMember(ctx, input.engagementId);
  assertCan(ctx, 'assurance.sampling.run');

  const population = await db.findById('populations', input.populationId);
  if (!population || population.engagementId !== input.engagementId) {
    throw new NotFoundError('母集団が見つかりません。');
  }

  const items = await db.select('populationItems', { where: { populationId: population.id } });
  const unitIds = [...new Set(items.map((i) => i.unitId))];
  const units =
    unitIds.length > 0 ? await db.select('units', { where: { id: { in: unitIds } } }) : [];
  const unitById = new Map(units.map((u) => [u.id, u]));

  const selection = selectSample({
    candidates: items
      .filter((i) => !i.excluded)
      .map((i) => ({
        id: i.id,
        value: i.value,
        stratum: unitById.get(i.unitId)?.name ?? null,
        label: i.id,
      })),
    method: input.method,
    seed: input.seed,
    parameters: input.parameters,
  });

  if (selection.length === 0) {
    // 方式ごとに「なぜ 0 件になったか」を分けて伝える。
    // 判断による抽出で対象未選択のときに一般的な文言を出すと、
    // 入力ミスだと誤解されて原因にたどり着けない。
    if (input.method === 'judgmental') {
      throw new AuthorizationError(
        '判断による抽出では、対象の項目を 1 件以上選んでください（「判断による抽出の対象を選ぶ」から選択できます）。',
      );
    }
    throw new AuthorizationError('抽出条件に一致する項目がありません。条件を見直してください。');
  }

  const now = new Date().toISOString();
  const sampleId = fid('sample', `${input.engagementId}/${input.name}/${now}`);

  const sample: Sample = {
    id: sampleId,
    populationId: population.id,
    engagementId: input.engagementId,
    assuranceFirmId: population.assuranceFirmId,
    populationVersionNo: population.versionNo,
    name: input.name,
    method: input.method,
    seed: input.seed,
    parameters: input.parameters,
    size: selection.length,
    rationale: input.rationale,
    createdAt: now,
    createdBy: ctx.userId,
  };

  const sampleItems: SampleItem[] = selection.map((sel) => ({
    id: fid('sample_item', `${sampleId}/${sel.populationItemId}`),
    sampleId,
    populationItemId: sel.populationItemId,
    engagementId: input.engagementId,
    assuranceFirmId: population.assuranceFirmId,
    selectionReason: sel.selectionReason,
    stratum: sel.stratum,
    sortOrder: sel.sortOrder,
  }));

  await db.insert('samples', [sample]);
  await db.insert('sampleItems', sampleItems);

  // サンプル項目ごとに調書（テスト）を用意する
  await db.insert(
    'tests',
    sampleItems.map((item) => ({
      id: fid('test', `${input.engagementId}/${item.id}`),
      engagementId: input.engagementId,
      assuranceFirmId: population.assuranceFirmId,
      sampleItemId: item.id,
      status: 'not_started' as const,
      conclusionDraft: null,
      preparedBy: null,
      preparedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      workpaperRef: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })),
  );

  await recordAuditEvent(db, ctx, {
    eventType: 'sample_created',
    resourceType: 'sample',
    resourceId: sampleId,
    engagementId: input.engagementId,
    afterSummary: `${input.method} / seed=${input.seed} / ${selection.length} 件`,
  });

  return sample;
}

// ----------------------------------------------------------------------
// Testing
// ----------------------------------------------------------------------

export interface SampleTestView {
  sampleItemId: Uuid;
  populationItem: PopulationItem;
  metricName: string;
  unitName: string;
  testId: Uuid;
  status: string;
  preparedBy: Uuid | null;
  reviewedBy: Uuid | null;
  conclusionDraft: string | null;
  workpaperRef: string | null;
  /** 調書そのものの更新日時。画面の描画時刻と取り違えない */
  updatedAt: IsoDateTime;
  completedProcedureIds: Uuid[];
  hasException: boolean;
  selectionReason: string;
  /** 現在の企業側値（Snapshot 固定値との差分表示用） */
  currentValue: number | null;
  snapshotValue: number;
}

export async function loadTestingWorkspace(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<{
  sample: Sample | null;
  rows: SampleTestView[];
  procedures: Awaited<ReturnType<typeof loadProcedures>>;
}> {
  assertEngagementMember(ctx, engagementId);

  const samples = await db.select('samples', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 1,
  });
  const sample = samples[0] ?? null;
  const procedures = await loadProcedures(db, engagementId);
  if (!sample) return { sample: null, rows: [], procedures };

  const sampleItems = await db.select('sampleItems', {
    where: { sampleId: sample.id },
    orderBy: { column: 'sortOrder' },
  });
  const populationItems = await db.select('populationItems', {
    where: { id: { in: sampleItems.map((i) => i.populationItemId) } },
  });
  const tests = await db.select('tests', {
    where: { sampleItemId: { in: sampleItems.map((i) => i.id) } },
  });
  const results =
    tests.length > 0
      ? await db.select('testResults', { where: { testId: { in: tests.map((t) => t.id) } } })
      : [];

  const metricIds = [...new Set(populationItems.map((i) => i.metricId))];
  const unitIds = [...new Set(populationItems.map((i) => i.unitId))];
  const dataPointIds = [...new Set(populationItems.map((i) => i.sourceDataPointId))];
  const [metrics, units, dataPoints] = await Promise.all([
    metricIds.length > 0 ? db.select('metrics', { where: { id: { in: metricIds } } }) : [],
    unitIds.length > 0 ? db.select('units', { where: { id: { in: unitIds } } }) : [],
    dataPointIds.length > 0 ? db.select('dataPoints', { where: { id: { in: dataPointIds } } }) : [],
  ]);
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const dataPointById = new Map(dataPoints.map((d) => [d.id, d]));

  const rows: SampleTestView[] = [];
  for (const item of sampleItems) {
    const populationItem = populationItems.find((p) => p.id === item.populationItemId);
    const test = tests.find((t) => t.sampleItemId === item.id);
    if (!populationItem || !test) continue;
    const testResults = results.filter((r) => r.testId === test.id);
    rows.push({
      sampleItemId: item.id,
      populationItem,
      metricName: metricById.get(populationItem.metricId)?.name ?? '—',
      unitName: unitById.get(populationItem.unitId)?.name ?? '—',
      testId: test.id,
      status: test.status,
      preparedBy: test.preparedBy,
      reviewedBy: test.reviewedBy,
      conclusionDraft: test.conclusionDraft,
      workpaperRef: test.workpaperRef,
      updatedAt: test.updatedAt,
      completedProcedureIds: testResults.map((r) => r.procedureId),
      hasException: testResults.some((r) => r.result === 'exception'),
      selectionReason: item.selectionReason,
      currentValue: dataPointById.get(populationItem.sourceDataPointId)?.value ?? null,
      snapshotValue: populationItem.value,
    });
  }

  return { sample, rows, procedures };
}

export async function loadProcedures(db: DbClient, engagementId: Uuid) {
  return db.select('procedures', { where: { engagementId }, orderBy: { column: 'sortOrder' } });
}

// ----------------------------------------------------------------------
// Sign-off 抑止条件（指示書 16.10）
// ----------------------------------------------------------------------

export async function evaluateSignoffBlockers(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  stage: SignoffStage,
): Promise<SignoffBlocker[]> {
  assertEngagementMember(ctx, engagementId);
  const base = `/assurance/engagements/${engagementId}`;
  const blockers: SignoffBlocker[] = [];

  const [procedures, samples, issues, pbcRequests, signoffs] = await Promise.all([
    db.select('procedures', { where: { engagementId, required: true } }),
    db.select('samples', {
      where: { engagementId },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 1,
    }),
    db.select('issues', { where: { engagementId } }),
    db.select('pbcRequests', { where: { engagementId } }),
    db.select('signoffs', { where: { engagementId } }),
  ]);

  // 1. 必須手続の未完了
  const sample = samples[0];
  if (!sample) {
    blockers.push({
      code: 'required_sample_incomplete',
      message: 'サンプルが未作成です。母集団からサンプルを抽出してください。',
      count: 1,
      href: `${base}/sampling`,
    });
  } else {
    const sampleItems = await db.select('sampleItems', { where: { sampleId: sample.id } });
    const tests = await db.select('tests', {
      where: { sampleItemId: { in: sampleItems.map((i) => i.id) } },
    });
    const results =
      tests.length > 0
        ? await db.select('testResults', { where: { testId: { in: tests.map((t) => t.id) } } })
        : [];

    const incompleteTests = tests.filter(
      (t) => t.status === 'not_started' || t.status === 'in_progress',
    );
    if (incompleteTests.length > 0) {
      blockers.push({
        code: 'required_sample_incomplete',
        message: `未着手・実施中のサンプルテストが ${incompleteTests.length} 件あります。`,
        count: incompleteTests.length,
        href: `${base}/testing`,
      });
    }

    const requiredIds = new Set(procedures.map((p) => p.id));
    let missingProcedures = 0;
    for (const test of tests) {
      const done = new Set(results.filter((r) => r.testId === test.id).map((r) => r.procedureId));
      for (const id of requiredIds) if (!done.has(id)) missingProcedures += 1;
    }
    if (missingProcedures > 0) {
      blockers.push({
        code: 'required_procedure_incomplete',
        message: `必須手続の未実施が ${missingProcedures} 件あります（必須手続 ${procedures.length} × サンプル ${tests.length}）。`,
        count: missingProcedures,
        href: `${base}/testing`,
      });
    }
  }

  // 2. 未解決の重要度「高」指摘
  const highOpen = issues.filter(
    (i) => i.severity === 'high' && i.status !== 'resolved' && i.status !== 'closed',
  );
  if (highOpen.length > 0) {
    blockers.push({
      code: 'high_issue_unresolved',
      message: `未解決の重要度「高」の指摘が ${highOpen.length} 件あります。`,
      count: highOpen.length,
      href: `${base}/issues`,
    });
  }

  // 3. Critical PBC の未受領
  const criticalPbc = pbcRequests.filter(
    (r) => r.priority === 'critical' && r.status !== 'accepted' && r.status !== 'closed',
  );
  if (criticalPbc.length > 0) {
    blockers.push({
      code: 'critical_pbc_outstanding',
      message: `最優先の資料依頼が ${criticalPbc.length} 件未受領です。`,
      count: criticalPbc.length,
      href: `${base}/requests`,
    });
  }

  // 4. Snapshot 後変更の未評価
  const snapshot = await loadLatestSnapshot(db, engagementId);
  if (snapshot) {
    const changes = await detectSnapshotChanges(db, ctx, snapshot.id);
    const unassessed = changes.filter((c) => c.assessment === null);
    if (unassessed.length > 0) {
      blockers.push({
        code: 'snapshot_change_unassessed',
        message: `Snapshot 固定後の変更 ${unassessed.length} 件が未評価です。`,
        count: unassessed.length,
        href: `${base}/data-room`,
      });
    }
  }

  // 5. 前段の Sign-off
  const stageOrder: SignoffStage[] = ['prepared', 'reviewed', 'partner_approved'];
  const index = stageOrder.indexOf(stage);
  if (index > 0) {
    const previousStage = stageOrder[index - 1];
    if (previousStage && !signoffs.some((s) => s.signoffStage === previousStage)) {
      blockers.push({
        code: 'previous_stage_missing',
        message: `前段の Sign-off（${previousStage}）が未実施です。`,
        count: 1,
        href: `${base}/signoffs`,
      });
    }
  }

  return blockers;
}

export interface CreateSignoffOptions {
  /**
   * 対象とした共有レポートの写し（任意。NF-23）。同じ案件で共有中の写しだけを結び付けられる。
   * 内容ハッシュはクライアントから受け取らず、写しの copy_hash を記録する
   */
  sharedReportCopyId?: Uuid | null;
}

export async function createSignoff(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  stage: SignoffStage,
  comment: string | null,
  options: CreateSignoffOptions = {},
): Promise<void> {
  assertEngagementMember(ctx, engagementId);

  const permission =
    stage === 'prepared'
      ? 'assurance.signoff.prepared'
      : stage === 'reviewed'
        ? 'assurance.signoff.reviewed'
        : 'assurance.signoff.partner';
  assertCan(ctx, permission);

  const blockers = await evaluateSignoffBlockers(db, ctx, engagementId, stage);
  if (blockers.length > 0) {
    throw new AuthorizationError(
      `Sign-off の抑止条件を満たしていません: ${blockers.map((b) => b.message).join(' / ')}`,
    );
  }

  const { engagement } = await loadEngagement(db, ctx, engagementId);
  const report = options.sharedReportCopyId
    ? await signoffTargetCopy(db, engagementId, options.sharedReportCopyId)
    : null;
  const existing = await db.select('signoffs', { where: { engagementId, signoffStage: stage } });
  const snapshot = await loadLatestSnapshot(db, engagementId);
  const roleKey =
    ctx.workspace.roleKeys.find((r) => r.startsWith('assurance') || r === 'engagement_partner') ??
    'assurance_staff';

  await db.insert('signoffs', [
    {
      id: fid('signoff', `${engagementId}/${stage}/${ctx.userId}/${existing.length + 1}`),
      engagementId,
      assuranceFirmId: engagement.assuranceFirmId,
      signoffStage: stage,
      // 代理 Sign-off 禁止: 常に実行者本人
      userId: ctx.userId,
      roleKey: roleKey as never,
      version: existing.length + 1,
      snapshotId: snapshot?.id ?? null,
      comment,
      createdAt: new Date().toISOString(),
      // 結び付けた写しと、その時点の写しの内容ハッシュ（DB のトリガ 0050 も同じ組を検査する）
      sharedReportCopyId: report?.copy.id ?? null,
      sharedReportContentHash: report?.copy.copyHash ?? null,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'signoff_created',
    resourceType: 'signoff',
    resourceId: engagementId,
    engagementId,
    afterSummary: report
      ? `${stage} を ${ctx.displayName} が実行（対象の開示レポート: ${report.label}）`
      : `${stage} を ${ctx.displayName} が実行`,
    metadata: report
      ? { sharedReportCopyId: report.copy.id, sharedReportContentHash: report.copy.copyHash }
      : undefined,
  });
}

/**
 * Sign-off に結び付ける写しを確かめる。同じ案件の共有中の写しだけ（他の案件の写しは存在を秘匿して
 * 「見つからない」、取り下げた写しは理由を返す）。DB のトリガ t4d.signoff_shared_report_guard と同じ条件
 */
async function signoffTargetCopy(
  db: DbClient,
  engagementId: Uuid,
  copyId: Uuid,
): Promise<{ copy: SharedReportCopy; label: string }> {
  const copy = isUuid(copyId) ? await db.findById('sharedReportCopies', copyId) : null;
  if (!copy || copy.engagementId !== engagementId) {
    throw new NotFoundError('対象の開示レポートが見つかりません。');
  }
  if (copy.withdrawnAt !== null) {
    throw new ValidationError(
      'この開示レポートは企業が共有を取り下げたため、Sign-off に結び付けられません。',
    );
  }
  const content = parseSharedReportCopy(copy.copy);
  if (!content || sharedReportCopyHash(content) !== copy.copyHash) {
    throw new ValidationError(
      'この開示レポートの写しは内容ハッシュが一致しないため、Sign-off に結び付けられません。',
    );
  }
  return { copy, label: sharedReportLabel(content) };
}

/** Sign-off と共有レポートの注意（NF-23。保存せず、Sign-off と写しから毎回導く） */
export interface SignoffReportAttention {
  /** 写しを結び付けた最新の Sign-off */
  signoff: Signoff;
  /** 結び付けた写し（読めなければ null） */
  linkedCopy: SharedReportCopy | null;
  /** Sign-off の後に共有された別の写し（共有中のもの） */
  newerCopies: SharedReportCopy[];
  /** 結び付けた写しが後から取り下げられた */
  linkedWithdrawn: boolean;
}

/**
 * Sign-off の後に別の承認版が共有された（または結び付けた写しが取り下げられた）かを導く純粋関数。
 * 写しを結び付けた Sign-off が無ければ null（注意を出さない）
 */
export function signoffReportAttentionOf(
  signoffs: readonly Signoff[],
  copies: readonly SharedReportCopy[],
): SignoffReportAttention | null {
  const linked = signoffs
    .filter((s) => s.sharedReportCopyId !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  if (!linked) return null;
  const linkedCopy = copies.find((c) => c.id === linked.sharedReportCopyId) ?? null;
  const newerCopies = copies.filter(
    (c) =>
      c.withdrawnAt === null && c.id !== linked.sharedReportCopyId && c.sharedAt > linked.createdAt,
  );
  // 保証側は取り下げた写しを読めない（0059 の SELECT ポリシー）。写しは消えないため、案件の写しの中に
  // 見当たらない結び付け先は取り下げられたもの
  const linkedWithdrawn = linkedCopy === null || linkedCopy.withdrawnAt !== null;
  if (newerCopies.length === 0 && !linkedWithdrawn) return null;
  return { signoff: linked, linkedCopy, newerCopies, linkedWithdrawn };
}

/** 案件の Sign-off と共有レポートの注意（案件のメンバーだけ） */
export async function loadSignoffReportAttention(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<SignoffReportAttention | null> {
  assertEngagementMember(ctx, engagementId);
  const [signoffs, copies] = await Promise.all([
    db.select('signoffs', { where: { engagementId } }),
    // 保証側が読めるのは共有中の写しだけ（DB の SELECT ポリシーと同じ条件を Demo でも当てる）
    db.select('sharedReportCopies', { where: { engagementId, withdrawnAt: { isNull: true } } }),
  ]);
  return signoffReportAttentionOf(signoffs, copies);
}

// ----------------------------------------------------------------------
// 案件ダッシュボード
// ----------------------------------------------------------------------

export interface AssuranceDashboardRow {
  engagement: Engagement;
  clientName: string;
  periodCode: string;
  progressPercent: number;
  pbcOutstanding: number;
  testsPending: number;
  reviewPending: number;
  openHighIssues: number;
  changesSinceSnapshot: number;
  signoffStages: SignoffStage[];
}

export async function loadAssuranceDashboard(
  db: DbClient,
  ctx: AuthorizationContext,
  engagements: Engagement[],
): Promise<AssuranceDashboardRow[]> {
  const rows: AssuranceDashboardRow[] = [];

  for (const engagement of engagements) {
    const [client, period, pbcRequests, issues, signoffs] = await Promise.all([
      db.findById('organizations', engagement.clientOrganizationId),
      db.findById('periods', engagement.clientReportingPeriodId),
      db.select('pbcRequests', { where: { engagementId: engagement.id } }),
      db.select('issues', { where: { engagementId: engagement.id } }),
      db.select('signoffs', { where: { engagementId: engagement.id } }),
    ]);

    const samples = await db.select('samples', {
      where: { engagementId: engagement.id },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 1,
    });
    const sample = samples[0];
    let tests: Array<{ status: string }> = [];
    if (sample) {
      const sampleItems = await db.select('sampleItems', { where: { sampleId: sample.id } });
      tests = await db.select('tests', {
        where: { sampleItemId: { in: sampleItems.map((i) => i.id) } },
      });
    }

    const reviewed = tests.filter((t) => t.status === 'reviewed').length;
    const prepared = tests.filter((t) => t.status === 'prepared').length;
    const pending = tests.filter(
      (t) => t.status === 'not_started' || t.status === 'in_progress',
    ).length;

    const snapshot = await loadLatestSnapshot(db, engagement.id);
    const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];

    rows.push({
      engagement,
      clientName: client?.name ?? '—',
      periodCode: period?.code ?? '—',
      progressPercent: tests.length === 0 ? 0 : Math.round((reviewed / tests.length) * 100),
      pbcOutstanding: pbcRequests.filter(
        (r) => r.status !== 'accepted' && r.status !== 'closed' && r.status !== 'draft',
      ).length,
      testsPending: pending,
      reviewPending: prepared,
      openHighIssues: issues.filter(
        (i) => i.severity === 'high' && i.status !== 'resolved' && i.status !== 'closed',
      ).length,
      changesSinceSnapshot: changes.length,
      signoffStages: [...new Set(signoffs.map((s) => s.signoffStage))],
    });
  }

  return rows;
}

// ----------------------------------------------------------------------
// 開示レポート（企業が共有した承認済みレポートの写し）の保証側の閲覧（NF-20・NF-21）
// ----------------------------------------------------------------------

export interface SharedReportListRow {
  copy: SharedReportCopy;
  /** 写しを読めない（形が崩れている）ときは null */
  content: SharedReportCopyContent | null;
  label: string;
  frameworkNames: string[];
  /** 写しが作成時のハッシュと一致するか（一致しなければ内容を出さない） */
  integrityOk: boolean;
  noteCount: number;
  /** クリアしていないコメント */
  openNoteCount: number;
}

/** 案件に共有された開示レポートの一覧（保証側。取り下げた写しは出さない） */
export async function loadSharedReportList(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<SharedReportListRow[]> {
  const copies = await listSharedReports(db, ctx, engagementId);
  const notes =
    copies.length > 0
      ? await db.select('reviewNotes', {
          where: { engagementId, targetCopyId: { in: copies.map((c) => c.id) } },
        })
      : [];
  return copies.map((copy) => {
    const content = parseSharedReportCopy(copy.copy);
    const own = notes.filter((n) => n.targetCopyId === copy.id);
    return {
      copy,
      content,
      label: content ? sharedReportLabel(content) : '（写しを読み込めません）',
      frameworkNames: content ? content.frameworkVersions.map((f) => f.frameworkName) : [],
      integrityOk: content !== null && sharedReportCopyHash(content) === copy.copyHash,
      noteCount: own.length,
      openNoteCount: own.filter((n) => n.status !== 'cleared').length,
    };
  });
}

/**
 * 写しのトレース（NF-14 と同じ純関数）。写しには定性情報の版の根拠（引用位置）が無く、監査法人は
 * 企業の定性情報を読めないため、定性情報の引用だけを根拠とする段落は「根拠なし」と数える
 * （narrativeEvidenceUnknown で画面に断り書きを出す）
 */
export function sharedReportTrace(
  content: Pick<SharedReportCopyContent, 'blocks' | 'metricValues' | 'narrativeVersionIds'>,
  options: { frameworkVersionId?: Uuid | null } = {},
): { units: TraceUnit[]; summary: TraceSummary; narrativeEvidenceUnknown: boolean } {
  const trace = buildReportTrace(
    {
      blocks: content.blocks,
      metricValues: content.metricValues,
      narrativeVersionsWithEvidence: new Set<Uuid>(),
    },
    { frameworkVersionId: options.frameworkVersionId ?? null },
  );
  return { ...trace, narrativeEvidenceUnknown: content.narrativeVersionIds.length > 0 };
}

export interface SharedReportView extends LoadedSharedReport {
  label: string;
  notes: FirmNoteEntry[];
}

/** 開示レポートの内容を開く（保証側。案件のメンバーだけ。取り下げ・他の案件は「見つからない」） */
export async function loadSharedReportView(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { engagementId: Uuid; copyId: Uuid },
): Promise<SharedReportView> {
  const loaded = await loadSharedReport(db, ctx, input);
  const notes = await listNotesForCopy(db, ctx, input);
  return { ...loaded, label: sharedReportLabel(loaded.content), notes };
}

/**
 * 開示レポートの内容を表示したことを監査ログ（監査法人の記録）に残す（1 画面 1 件・要約だけ。NF-26）。
 * 企業側の監査ログには出ない（監査ログの読み取りは記録した組織の範囲。known-limitations §13）
 */
export async function recordSharedReportView(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { engagementId: Uuid; copyId: Uuid; label: string },
): Promise<void> {
  assertEngagementMember(ctx, input.engagementId);
  await recordAuditEvent(db, ctx, {
    eventType: 'record_viewed',
    resourceType: SHARED_REPORT_VIEW_RESOURCE,
    resourceId: input.copyId,
    engagementId: input.engagementId,
    afterSummary: `開示レポート ${input.label} を表示`,
  });
}

/** コメントの対象の表示（段落・数値）。写しから作る（企業・保証側の両方が同じ表示を使う） */
export interface ReportNoteTargetLabel {
  kind: ReportNoteTargetType;
  copyId: Uuid;
  /** 例「No.1 社内承認済み版」。写しを読めなければ null */
  reportLabel: string | null;
  /** 例「ガバナンス 段落 2」「Scope1 排出量 ／ 本社 ／ FY2025」 */
  place: string;
  /** 追跡番号（写しに見つからなければ null） */
  traceId: string | null;
  /** 段落の本文・数値の表示（先頭 120 字） */
  excerpt: string;
}

/** コメントの対象を「節・段落／数値」の言葉にする（写しに見つからなければ、その旨を書く） */
export function describeReportNoteTarget(
  note: Pick<
    ReviewNote,
    | 'targetType'
    | 'targetCopyId'
    | 'targetBlockId'
    | 'targetParagraphId'
    | 'targetDataPointVersionId'
  >,
  content: SharedReportCopyContent | null,
  units: readonly TraceUnit[] = content ? sharedReportTrace(content).units : [],
): ReportNoteTargetLabel | null {
  if (!note.targetCopyId) return null;
  if (note.targetType !== 'report_paragraph' && note.targetType !== 'report_metric') return null;
  const kind = note.targetType;
  const reportLabel = content ? sharedReportLabel(content) : null;
  if (kind === 'report_paragraph') {
    const block = content?.blocks.find((b) => b.blockId === note.targetBlockId) ?? null;
    const unit = units.find(
      (u) =>
        u.kind === 'paragraph' &&
        u.blockId === note.targetBlockId &&
        u.paragraphId === note.targetParagraphId,
    );
    return {
      kind,
      copyId: note.targetCopyId,
      reportLabel,
      place: block
        ? unit
          ? `${block.title} 段落 ${unit.paragraphNo}`
          : `${block.title}（段落が写しに見つかりません）`
        : '節が写しに見つかりません',
      traceId: unit?.traceId ?? null,
      excerpt: excerptOf(unit?.text ?? ''),
    };
  }
  const metric =
    content?.metricValues.find((m) => m.dataPointVersionId === note.targetDataPointVersionId) ??
    null;
  const unit = units.find(
    (u) => u.kind === 'number' && u.dataPointVersionId === note.targetDataPointVersionId,
  );
  return {
    kind,
    copyId: note.targetCopyId,
    reportLabel,
    place: metric
      ? `${metric.metricName} ／ ${metric.unitName} ／ ${metric.periodCode}`
      : '数値が写しに見つかりません',
    traceId: unit?.traceId ?? null,
    excerpt: excerptOf(unit?.text ?? ''),
  };
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** 企業側の「保証側のコメント」の 1 行（クライアントへ共有されたコメントと回答・対象の表示） */
export interface ClientCommentRow extends ClientNoteEntry {
  /** 開示レポートの段落・数値へのコメントなら対象の表示（案件全体へのコメントは null） */
  target: ReportNoteTargetLabel | null;
  /** 対象の写しの開示プロジェクト（案件全体へのコメントは null） */
  projectId: Uuid | null;
  projectName: string | null;
}

/**
 * 企業側: 保証側のコメント（クライアントへ共有されたものだけ）を、対象の段落・数値の言葉と一緒に読む。
 * 監査法人の行（review_notes）は読むだけで更新しない。projectId で開示プロジェクトに絞れる
 * （プロジェクトの「レビュー・承認」タブ）
 */
export async function loadClientAssuranceComments(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { engagementId?: Uuid | null; projectId?: Uuid | null } = {},
): Promise<ClientCommentRow[]> {
  const entries = await listNotesForClient(db, ctx, { engagementId: options.engagementId ?? null });
  const copyIds = new Set(
    entries.map((e) => e.note.targetCopyId).filter((id): id is Uuid => id !== null),
  );
  const copies =
    copyIds.size > 0
      ? (await listSharedReportsForClient(db, ctx)).filter((e) => copyIds.has(e.copy.id))
      : [];
  const contentById = new Map<Uuid, SharedReportCopyContent | null>(
    copies.map((e) => [e.copy.id, parseSharedReportCopy(e.copy.copy)]),
  );
  const rows = entries.map((entry) => {
    const content = entry.note.targetCopyId
      ? (contentById.get(entry.note.targetCopyId) ?? null)
      : null;
    return {
      ...entry,
      target: describeReportNoteTarget(entry.note, content),
      projectId: content?.projectId ?? null,
      projectName: content?.frameworkVersions[0]?.projectName ?? null,
    };
  });
  return options.projectId ? rows.filter((r) => r.projectId === options.projectId) : rows;
}

/** 開示プロジェクトの「レビュー・承認」タブの「保証側のコメント」節（行と、回答できるか） */
export async function loadProjectAssuranceComments(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<{ rows: ClientCommentRow[]; canRespond: boolean }> {
  const rows = await loadClientAssuranceComments(db, ctx, { projectId });
  return { rows, canRespond: can(ctx, 'enterprise.disclosure.write') };
}

export interface EngagementNoteEntry {
  note: ReviewNote;
  /** 企業の回答（クライアントへ共有したコメントだけに付く） */
  responses: ReviewNoteResponse[];
  /** 企業側から見た状態（クライアントへ共有したコメントだけ。内部限定は null） */
  clientState: ClientNoteState | null;
  /** 開示レポートの段落・数値へのコメントなら対象の表示 */
  target: ReportNoteTargetLabel | null;
}

/** 案件のレビュー Note（案件全体・開示レポートの段落・数値）と企業の回答（案件のメンバーだけ） */
export async function loadEngagementReviewNotes(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<EngagementNoteEntry[]> {
  assertEngagementMember(ctx, engagementId);
  const notes = await db.select('reviewNotes', {
    where: { engagementId },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  const copyIds = [
    ...new Set(notes.map((n) => n.targetCopyId).filter((id): id is Uuid => id !== null)),
  ];
  const [responses, copies] = await Promise.all([
    notes.length > 0
      ? db.select('reviewNoteResponses', {
          where: { reviewNoteId: { in: notes.map((n) => n.id) } },
          orderBy: [{ column: 'respondedAt' }, { column: 'id' }],
        })
      : [],
    // 取り下げた写しの本文（段落の抜粋）は保証側に出さない（DB の SELECT ポリシーと同じ。0059）
    copyIds.length > 0
      ? db.select('sharedReportCopies', {
          where: { engagementId, id: { in: copyIds }, withdrawnAt: { isNull: true } },
        })
      : [],
  ]);
  const contentById = new Map<Uuid, SharedReportCopyContent | null>(
    copies.map((c) => [c.id, parseSharedReportCopy(c.copy)]),
  );
  const unitsById = new Map<Uuid, TraceUnit[]>(
    [...contentById].map(([id, content]) => [id, content ? sharedReportTrace(content).units : []]),
  );
  return notes.map((note) => {
    const own = responses.filter((r) => r.reviewNoteId === note.id);
    const content = note.targetCopyId ? (contentById.get(note.targetCopyId) ?? null) : null;
    return {
      note,
      responses: own,
      clientState: note.sharedWithClient ? clientNoteStateOf(note, own) : null,
      target: describeReportNoteTarget(
        note,
        content,
        note.targetCopyId ? (unitsById.get(note.targetCopyId) ?? []) : [],
      ),
    };
  });
}
