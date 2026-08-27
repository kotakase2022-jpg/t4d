import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import {
  AGGREGATION_METHODS,
  CONSOLIDATION_METHODS,
  METRIC_CATEGORIES,
  METRIC_DATA_TYPES,
  UNIT_TYPES,
  type AggregationMethod,
  type AuthorizationContext,
  type ConsolidationMethod,
  type MetricCategory,
  type MetricDataType,
  type MetricDefinition,
  type PeriodStatus,
  type ReportingPeriod,
  type OrganizationUnit,
  type UnitType,
  type Uuid,
} from '@/types/domain';

/**
 * マスターデータ（指標・組織）の作成・更新。
 *
 * 要件: MASTER-P0-001（指標マスター）／ORG-P0-001（組織階層・連結範囲）。
 *
 * すべて **自組織のデータに限定**する。更新時は対象行が本当に自組織のものかを
 * 明示的に確認する（Demo Mode の DbClient には行レベルの防御が無いため。
 * Supabase Mode は RLS が二重に守る）。
 */

function oneOf<T extends readonly string[]>(values: T, raw: string, label: string): T[number] {
  if ((values as readonly string[]).includes(raw)) return raw as T[number];
  throw new ValidationError(`${label}の値が不正です: ${raw}`);
}

function requireText(raw: string, label: string, max = 200): string {
  const value = raw.trim();
  if (!value) throw new ValidationError(`${label}を入力してください。`);
  if (value.length > max) throw new ValidationError(`${label}は${max}文字以内で入力してください。`);
  return value;
}

function optionalNumber(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError('数値の形式が不正です。');
  return n;
}

// ----------------------------------------------------------------------
// 指標マスター（MASTER-P0-001）
// ----------------------------------------------------------------------

export interface MetricInput {
  code: string;
  name: string;
  description: string;
  category: MetricCategory;
  unit: string;
  baseUnit: string;
  dataType: MetricDataType;
  aggregationMethod: AggregationMethod;
  formula: string | null;
  requiresEvidence: boolean;
  hqOnly: boolean;
  materiality: 'high' | 'medium' | 'low';
  reportingFrequency: 'annual' | 'quarterly' | 'monthly';
  responsibleDepartment: string | null;
  yoyWarningRatio: number | null;
  /** 妥当な値の下限・上限。検証（範囲外チェック）で使う */
  minValue: number | null;
  maxValue: number | null;
  /** 比率指標の分子・分母（指標コード） */
  numeratorMetricCode: string | null;
  denominatorMetricCode: string | null;
}

/** FormData から MetricInput を組み立てる（検証込み）。 */
export function parseMetricInput(get: (key: string) => string): MetricInput {
  const input = buildMetricInput(get);
  if (input.minValue !== null && input.maxValue !== null && input.minValue > input.maxValue) {
    throw new ValidationError('下限は上限以下にしてください。');
  }
  return input;
}

function buildMetricInput(get: (key: string) => string): MetricInput {
  return {
    code: requireText(get('code'), '指標コード', 40),
    name: requireText(get('name'), '指標名'),
    description: get('description').trim(),
    category: oneOf(METRIC_CATEGORIES, get('category'), 'カテゴリ'),
    unit: requireText(get('unit'), '単位', 40),
    baseUnit: get('baseUnit').trim() || requireText(get('unit'), '単位', 40),
    dataType: oneOf(METRIC_DATA_TYPES, get('dataType'), 'データ型'),
    aggregationMethod: oneOf(AGGREGATION_METHODS, get('aggregationMethod'), '集計方法'),
    formula: get('formula').trim() || null,
    requiresEvidence: get('requiresEvidence') === 'on' || get('requiresEvidence') === 'true',
    hqOnly: get('hqOnly') === 'on' || get('hqOnly') === 'true',
    materiality: oneOf(['high', 'medium', 'low'] as const, get('materiality'), '重要度'),
    reportingFrequency: oneOf(
      ['annual', 'quarterly', 'monthly'] as const,
      get('reportingFrequency'),
      '報告頻度',
    ),
    responsibleDepartment: get('responsibleDepartment').trim() || null,
    yoyWarningRatio: (() => {
      const pct = optionalNumber(get('yoyWarningPercent'));
      if (pct === null) return null;
      // 「±%」なので負値は意味を持たない。0 も「変動を一切許さない」で使い道が無い。
      if (pct <= 0 || pct > 1000) {
        throw new ValidationError('前年変動許容は 0 より大きく 1000 以下の % で入力してください。');
      }
      return pct / 100;
    })(),
    minValue: optionalNumber(get('minValue')),
    maxValue: optionalNumber(get('maxValue')),
    numeratorMetricCode: get('numeratorMetricCode').trim() || null,
    denominatorMetricCode: get('denominatorMetricCode').trim() || null,
  };
}

export async function createMetricDefinition(
  db: DbClient,
  ctx: AuthorizationContext,
  input: MetricInput,
): Promise<MetricDefinition> {
  assertCan(ctx, 'enterprise.metric.manage');
  const organizationId = ctx.workspace.organizationId;

  // コード重複を防ぐ（自組織内で一意）
  const existing = await db.select('metrics', {
    where: { organizationId, code: input.code, deletedAt: { isNull: true } },
    limit: 1,
  });
  if (existing.length > 0) {
    throw new ValidationError(`指標コード「${input.code}」は既に存在します。`);
  }

  const now = new Date().toISOString();
  const metric: MetricDefinition = {
    id: fid('metric', `${organizationId}/${input.code}`),
    organizationId,
    code: input.code,
    name: input.name,
    description: input.description,
    category: input.category,
    unit: input.unit,
    baseUnit: input.baseUnit,
    dataType: input.dataType,
    aggregationMethod: input.aggregationMethod,
    numeratorMetricCode: input.numeratorMetricCode,
    denominatorMetricCode: input.denominatorMetricCode,
    formula: input.formula,
    requiresEvidence: input.requiresEvidence,
    hqOnly: input.hqOnly,
    materiality: input.materiality,
    reportingFrequency: input.reportingFrequency,
    responsibleDepartment: input.responsibleDepartment,
    yoyWarningRatio: input.yoyWarningRatio,
    minValue: input.minValue,
    maxValue: input.maxValue,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };

  await db.insert('metrics', [metric]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'metric_definition',
    resourceId: metric.id,
    afterSummary: `指標マスターを追加: ${metric.code} ${metric.name}`,
  });
  return metric;
}

export async function updateMetricDefinition(
  db: DbClient,
  ctx: AuthorizationContext,
  metricId: Uuid,
  input: MetricInput,
): Promise<MetricDefinition> {
  assertCan(ctx, 'enterprise.metric.manage');
  const metric = await loadOwnedMetric(db, ctx, metricId);

  const now = new Date().toISOString();
  const updated = await db.update('metrics', metric.id, {
    name: input.name,
    description: input.description,
    category: input.category,
    unit: input.unit,
    baseUnit: input.baseUnit,
    dataType: input.dataType,
    aggregationMethod: input.aggregationMethod,
    formula: input.formula,
    requiresEvidence: input.requiresEvidence,
    hqOnly: input.hqOnly,
    materiality: input.materiality,
    reportingFrequency: input.reportingFrequency,
    responsibleDepartment: input.responsibleDepartment,
    yoyWarningRatio: input.yoyWarningRatio,
    minValue: input.minValue,
    maxValue: input.maxValue,
    numeratorMetricCode: input.numeratorMetricCode,
    denominatorMetricCode: input.denominatorMetricCode,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'metric_definition',
    resourceId: metric.id,
    afterSummary: `指標マスターを更新: ${input.code} ${input.name}`,
  });
  return updated;
}

async function loadOwnedMetric(
  db: DbClient,
  ctx: AuthorizationContext,
  metricId: Uuid,
): Promise<MetricDefinition> {
  const metric = await db.findById('metrics', metricId);
  if (!metric || metric.deletedAt || metric.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('指標が見つかりません。');
  }
  return metric;
}

// ----------------------------------------------------------------------
// 組織・拠点（ORG-P0-001）
// ----------------------------------------------------------------------

export interface OrganizationUnitInput {
  code: string;
  name: string;
  unitType: UnitType;
  parentId: Uuid | null;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  consolidationMethod: ConsolidationMethod;
  ownershipPercent: number;
  exclusionReason: string | null;
}

export function parseOrganizationUnitInput(get: (key: string) => string): OrganizationUnitInput {
  const ownership = optionalNumber(get('ownershipPercent')) ?? 100;
  if (ownership < 0 || ownership > 100) {
    throw new ValidationError('持分は 0〜100 の範囲で入力してください。');
  }
  const consolidationMethod = oneOf(CONSOLIDATION_METHODS, get('consolidationMethod'), '連結方法');
  return {
    code: requireText(get('code'), '組織コード', 40),
    name: requireText(get('name'), '組織名'),
    unitType: oneOf(UNIT_TYPES, get('unitType'), '種別'),
    parentId: get('parentId').trim() || null,
    countryCode: requireText(get('countryCode') || 'JP', '国コード', 3),
    currencyCode: requireText(get('currencyCode') || 'JPY', '通貨コード', 3),
    timezone: get('timezone').trim() || 'Asia/Tokyo',
    consolidationMethod,
    ownershipPercent: ownership,
    // 連結対象外のときだけ除外理由を保持する
    exclusionReason:
      consolidationMethod === 'excluded' ? get('exclusionReason').trim() || null : null,
  };
}

export async function createOrganizationUnit(
  db: DbClient,
  ctx: AuthorizationContext,
  input: OrganizationUnitInput,
): Promise<OrganizationUnit> {
  assertCan(ctx, 'enterprise.org.manage');
  const organizationId = ctx.workspace.organizationId;

  if (input.parentId) await loadOwnedUnit(db, ctx, input.parentId); // 親も自組織であること

  const existing = await db.select('units', {
    where: { organizationId, code: input.code, deletedAt: { isNull: true } },
    limit: 1,
  });
  if (existing.length > 0) {
    throw new ValidationError(`組織コード「${input.code}」は既に存在します。`);
  }

  const siblings = await db.select('units', { where: { organizationId } });
  const now = new Date().toISOString();
  const unit: OrganizationUnit = {
    id: fid('unit', `${organizationId}/${input.code}`),
    organizationId,
    parentId: input.parentId,
    code: input.code,
    name: input.name,
    unitType: input.unitType,
    countryCode: input.countryCode,
    currencyCode: input.currencyCode,
    timezone: input.timezone,
    consolidationMethod: input.consolidationMethod,
    ownershipPercent: input.ownershipPercent,
    exclusionReason: input.exclusionReason,
    sortOrder: siblings.length + 1,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };

  await db.insert('units', [unit]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'organization_unit',
    resourceId: unit.id,
    afterSummary: `組織を追加: ${unit.code} ${unit.name}`,
  });
  return unit;
}

export async function updateOrganizationUnit(
  db: DbClient,
  ctx: AuthorizationContext,
  unitId: Uuid,
  input: OrganizationUnitInput,
): Promise<OrganizationUnit> {
  assertCan(ctx, 'enterprise.org.manage');
  const unit = await loadOwnedUnit(db, ctx, unitId);

  // 自分自身を親にできない（循環防止の最小限）
  if (input.parentId === unit.id) throw new ValidationError('自分自身を親組織にはできません。');
  if (input.parentId) await loadOwnedUnit(db, ctx, input.parentId);

  const now = new Date().toISOString();
  const updated = await db.update('units', unit.id, {
    name: input.name,
    unitType: input.unitType,
    parentId: input.parentId,
    countryCode: input.countryCode,
    currencyCode: input.currencyCode,
    timezone: input.timezone,
    consolidationMethod: input.consolidationMethod,
    ownershipPercent: input.ownershipPercent,
    exclusionReason: input.exclusionReason,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'organization_unit',
    resourceId: unit.id,
    afterSummary: `組織を更新: ${input.code} ${input.name}（${input.consolidationMethod} / 持分${input.ownershipPercent}%）`,
  });
  return updated;
}

async function loadOwnedUnit(
  db: DbClient,
  ctx: AuthorizationContext,
  unitId: Uuid,
): Promise<OrganizationUnit> {
  const unit = await db.findById('units', unitId);
  if (!unit || unit.deletedAt || unit.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('組織が見つかりません。');
  }
  return unit;
}

// ----------------------------------------------------------------------
// 収集キャンペーン（ORG-P0-002）
// ----------------------------------------------------------------------

export interface CampaignInput {
  name: string;
  reportingPeriodId: Uuid;
  dueDate: string;
  description: string | null;
  unitIds: Uuid[];
  metricIds: Uuid[];
  ownerUserId: Uuid | null;
}

export async function createCollectionCampaign(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CampaignInput,
): Promise<{ campaignId: Uuid; scopeCount: number }> {
  assertCan(ctx, 'enterprise.period.manage');
  const organizationId = ctx.workspace.organizationId;

  const name = requireText(input.name, 'キャンペーン名');
  if (!input.dueDate) throw new ValidationError('提出期限を入力してください。');
  if (input.unitIds.length === 0) throw new ValidationError('対象組織を 1 つ以上選んでください。');
  if (input.metricIds.length === 0)
    throw new ValidationError('対象指標を 1 つ以上選んでください。');

  // 対象期間・組織・指標がすべて自組織のものであることを確認する
  const period = await db.findById('periods', input.reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  const ownedUnits = await db.select('units', {
    where: { organizationId, id: { in: input.unitIds }, deletedAt: { isNull: true } },
  });
  const ownedMetrics = await db.select('metrics', {
    where: { organizationId, id: { in: input.metricIds }, deletedAt: { isNull: true } },
  });
  if (
    ownedUnits.length !== input.unitIds.length ||
    ownedMetrics.length !== input.metricIds.length
  ) {
    throw new NotFoundError('対象の組織または指標が見つかりません。');
  }

  const now = new Date().toISOString();
  const campaignId = fid('campaign', `${organizationId}/${input.reportingPeriodId}/${name}/${now}`);
  await db.insert('campaigns', [
    {
      id: campaignId,
      organizationId,
      reportingPeriodId: input.reportingPeriodId,
      name,
      status: 'open',
      dueDate: input.dueDate,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  // 対象組織 × 対象指標 の全組み合わせを収集スコープとして展開する
  const scopes = ownedUnits.flatMap((unit) =>
    ownedMetrics.map((metric) => ({
      id: fid('campaign_scope', `${campaignId}/${unit.id}/${metric.id}`),
      campaignId,
      unitId: unit.id,
      metricId: metric.id,
      ownerUserId: input.ownerUserId,
      dueDate: input.dueDate,
    })),
  );
  await db.insert('campaignScopes', scopes);

  // キャンペーンを作っただけでは誰も動けない。
  // 対象の組織ごとにタスクを起こし、担当者へ通知する。
  const tasks = ownedUnits.map((unit) => ({
    id: fid('task', `${campaignId}/${unit.id}`),
    organizationId,
    title: `${name}: ${unit.name} のデータ提出`,
    description: `対象指標 ${ownedMetrics.length} 件。期限までに値と Evidence を登録してください。`,
    targetType: 'collection_campaign',
    targetId: campaignId,
    assigneeUserId: input.ownerUserId,
    dueDate: input.dueDate,
    status: 'open' as const,
    priority: 'medium' as const,
    engagementId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  }));
  if (tasks.length > 0) await db.insert('tasks', tasks);

  if (input.ownerUserId && input.ownerUserId !== ctx.userId) {
    await db.insert('notifications', [
      {
        id: fid('notification', `${campaignId}/${input.ownerUserId}`),
        organizationId,
        userId: input.ownerUserId,
        title: `収集キャンペーン「${name}」の担当になりました`,
        body: `対象 ${ownedUnits.length} 組織 × ${ownedMetrics.length} 指標。期限 ${input.dueDate}`,
        category: 'task' as const,
        href: '/enterprise/workflows',
        readAt: null,
        createdAt: now,
      },
    ]);
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'collection_campaign',
    resourceId: campaignId,
    afterSummary: `収集キャンペーンを作成: ${name}（${scopes.length} スコープ / ${tasks.length} タスク）`,
  });

  return { campaignId, scopeCount: scopes.length };
}

/**
 * 報告年度（Reporting Period）を作る。
 *
 * 期間を作る手段が無いと、収集キャンペーンも非財務データも
 * Fixture 由来の年度しか扱えず、翌年度の運用に入れない。
 */
export interface ReportingPeriodInput {
  code: string;
  label: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  submissionDueDate: string | null;
}

export async function createReportingPeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ReportingPeriodInput,
): Promise<ReportingPeriod> {
  assertCan(ctx, 'enterprise.org.manage');
  const organizationId = ctx.workspace.organizationId;

  const code = input.code.trim();
  const label = input.label.trim();
  if (!code || !label) throw new ValidationError('年度コードと表示名は必須です。');
  if (input.endDate <= input.startDate) {
    throw new ValidationError('終了日は開始日より後の日付にしてください。');
  }

  const existing = await db.select('periods', { where: { organizationId, code }, limit: 1 });
  if (existing.length > 0) {
    throw new ValidationError(`年度コード「${code}」は既に存在します。`);
  }

  const now = new Date().toISOString();
  const period: ReportingPeriod = {
    id: fid('reporting_period', `${organizationId}/${code}`),
    organizationId,
    code,
    label,
    startDate: input.startDate,
    endDate: input.endDate,
    status: input.status,
    submissionDueDate: input.submissionDueDate,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('periods', [period]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'reporting_period',
    resourceId: period.id,
    afterSummary: `報告年度を作成: ${code} ${label}`,
  });

  return period;
}
