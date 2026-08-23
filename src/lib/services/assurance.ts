import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEngagementMember,
  AuthorizationError,
  NotFoundError,
} from '@/lib/authorization/can';
import { notFound } from 'next/navigation';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { selectSample } from '@/lib/services/sampling';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AssuranceSnapshot,
  AssuranceSnapshotItem,
  AuthorizationContext,
  DataPoint,
  Engagement,
  GrantSubjectType,
  MetricDefinition,
  OrganizationUnit,
  Population,
  PopulationItem,
  Sample,
  SampleItem,
  SamplingMethod,
  SamplingParameters,
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
}

/**
 * 監査法人が読める Data Point だけに絞る。
 *
 * DB 側の `t4d.assurance_can_read_data_point()`（0011_authorization_functions.sql）と
 * **同じ条件**を実装している。企業側で承認済みであること、削除されていないこと、
 * 指標・組織・期間のすべてに有効な（取り消されていない）許諾があること。
 *
 * Demo Mode には RLS が無いため、ここを通さないと
 * 「取り消した許諾が効かない」「未承認の下書きが監査法人に見える」が起きる。
 */
async function filterReadableForAssurance(
  db: DbClient,
  engagementId: Uuid,
  dataPoints: DataPoint[],
): Promise<DataPoint[]> {
  if (dataPoints.length === 0) return [];

  const grants = await db.select('grants', {
    where: { engagementId, revokedAt: { isNull: true } },
  });
  const grantedBySubject = new Map<GrantSubjectType, Set<Uuid>>();
  for (const g of grants) {
    const set = grantedBySubject.get(g.subjectType) ?? new Set<Uuid>();
    set.add(g.subjectId);
    grantedBySubject.set(g.subjectType, set);
  }
  const covers = (subject: GrantSubjectType, id: Uuid): boolean =>
    grantedBySubject.get(subject)?.has(id) ?? false;

  return dataPoints.filter(
    (dp) =>
      dp.status === 'approved' &&
      dp.deletedAt === null &&
      covers('metric', dp.metricId) &&
      covers('organization_unit', dp.unitId) &&
      covers('reporting_period', dp.reportingPeriodId),
  );
}

export async function loadDataRoom(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<{ rows: DataRoomRow[]; snapshot: AssuranceSnapshot | null }> {
  assertEngagementMember(ctx, engagementId);

  const items = await db.select('dataRoomItems', {
    where: { engagementId, sourceType: 'data_point', withdrawnAt: { isNull: true } },
  });
  const snapshot = await loadLatestSnapshot(db, engagementId);
  const snapshotItems = snapshot
    ? await db.select('snapshotItems', { where: { snapshotId: snapshot.id } })
    : [];
  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];
  const changedIds = new Set(changes.map((c) => c.snapshotItemId));

  const dataPointIds = items.map((i) => i.sourceId);
  const allDataPoints =
    dataPointIds.length > 0
      ? await db.select('dataPoints', { where: { id: { in: dataPointIds } } })
      : [];

  // 許諾と承認状態は **アプリ層でも** 見る。
  // Supabase Mode では t4d.assurance_can_read_data_point() が同じ判定をするが、
  // Demo Mode（本番の動作モード）には RLS が無く、ここが唯一の防御になる。
  // 判定条件は上記 SQL 関数と一致させること（片方だけ変えない）。
  const readable = await filterReadableForAssurance(db, engagementId, allDataPoints);
  const dataPoints = readable;
  const readableIds = new Set(readable.map((dp) => dp.id));

  const metricIds = [...new Set(dataPoints.map((dp) => dp.metricId))];
  const unitIds = [...new Set(dataPoints.map((dp) => dp.unitId))];
  const [metrics, units, versions, evidenceLinks] = await Promise.all([
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
  ]);

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const rows: DataRoomRow[] = items
    .filter((item) => readableIds.has(item.sourceId))
    .map((item) => {
      const dp = dataPoints.find((d) => d.id === item.sourceId);
      const version = versions.find((v) => v.id === dp?.currentVersionId);
      const snapshotItem = snapshotItems.find((s) => s.sourceId === item.sourceId);
      return {
        dataPointId: item.sourceId,
        metric: dp ? (metricById.get(dp.metricId) ?? null) : null,
        unit: dp ? (unitById.get(dp.unitId) ?? null) : null,
        currentValue: dp?.value ?? null,
        currentUnitOfMeasure: dp?.unitOfMeasure ?? '',
        currentVersionNo: version?.versionNo ?? null,
        clientStatus: String(item.clientApprovalStatus),
        sharedAt: item.sharedAt,
        snapshotIncluded: Boolean(snapshotItem),
        changedSinceSnapshot: snapshotItem ? changedIds.has(snapshotItem.id) : false,
        evidenceCount: evidenceLinks.filter((l) => l.targetId === item.sourceId).length,
      };
    });

  return { rows, snapshot };
}

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
  const items = await db.select('dataRoomItems', {
    where: { engagementId, sourceType: 'data_point', withdrawnAt: { isNull: true } },
  });
  if (items.length === 0) {
    throw new AuthorizationError('Data Room に共有された対象がありません。');
  }

  const dataPointIds = items.map((i) => i.sourceId);
  const [dataPoints, versions] = await Promise.all([
    db.select('dataPoints', { where: { id: { in: dataPointIds } } }),
    db.select('dataPointVersions', { where: { dataPointId: { in: dataPointIds } } }),
  ]);

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

export async function createSignoff(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  stage: SignoffStage,
  comment: string | null,
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
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'signoff_created',
    resourceType: 'signoff',
    resourceId: engagementId,
    engagementId,
    afterSummary: `${stage} を ${ctx.displayName} が実行`,
  });
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
