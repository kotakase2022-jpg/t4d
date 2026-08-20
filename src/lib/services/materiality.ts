import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  MaterialityCategory,
  MaterialityLevel,
  MaterialityTopic,
  MetricDefinition,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * マテリアリティ評価（SSBJ 開示の起点）。
 *
 * SSBJ は「自社にとって重要なリスク・機会」を特定したうえで開示する。
 * 開示項目の一覧から入るのではなく、
 *   マテリアリティの登録 → 対象データの収集 → 充足度の確認 → 不足項目の対応
 * という順に進むため、その 1 段目と 3 段目をここで扱う。
 */

/** 初期表示する標準トピック（登録されていない期間ではこれを候補として出す）。 */
export const DEFAULT_TOPICS: Array<{
  topicKey: string;
  title: string;
  category: MaterialityCategory;
  metricCodes: string[];
}> = [
  {
    topicKey: 'climate_ghg',
    title: '気候変動（GHG 排出）',
    category: 'environment',
    metricCodes: ['scope1', 'scope2', 'scope3_cat1', 'energy'],
  },
  {
    topicKey: 'water',
    title: '水資源の利用',
    category: 'environment',
    metricCodes: ['water'],
  },
  {
    topicKey: 'circular',
    title: '資源循環・廃棄物',
    category: 'environment',
    metricCodes: ['waste'],
  },
  {
    topicKey: 'human_capital',
    title: '人的資本（人材の育成・多様性）',
    category: 'social',
    metricCodes: [
      'employees',
      'female_employees',
      'female_manager_ratio',
      'training_hours',
      'avg_tenure',
    ],
  },
  {
    topicKey: 'safety',
    title: '労働安全衛生',
    category: 'social',
    metricCodes: ['ltifr'],
  },
  {
    topicKey: 'supply_chain',
    title: 'サプライチェーン管理',
    category: 'social',
    metricCodes: ['scope3_cat1'],
  },
  {
    topicKey: 'governance',
    title: 'コーポレートガバナンス',
    category: 'governance',
    metricCodes: ['officers_total', 'female_officers', 'directors_count'],
  },
];

export const MATERIALITY_LABEL: Record<MaterialityLevel, string> = {
  high: '重要度：高',
  medium: '重要度：中',
  low: '重要度：低',
  not_material: '重要ではない',
  not_assessed: '未評価',
};

export const CATEGORY_LABEL: Record<MaterialityCategory, string> = {
  environment: '環境',
  social: '社会',
  governance: 'ガバナンス',
};

/** マテリアルと見なす水準（充足度の対象） */
export function isMaterial(level: MaterialityLevel): boolean {
  return level === 'high' || level === 'medium';
}

export interface MaterialityTopicView {
  topicKey: string;
  title: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  rationale: string;
  metricCodes: string[];
  /** 対象指標のうち、当期に承認済みの値がある数 */
  collectedMetricCount: number;
  /** 対象指標の総数 */
  totalMetricCount: number;
  /** 充足度（0〜100）。マテリアルでないトピックは対象外なので null */
  coverage: number | null;
  /** まだ承認済みの値が無い指標名 */
  missingMetricNames: string[];
  /** 保存済みか（未保存なら候補として表示） */
  saved: boolean;
}

export interface MaterialityOverview {
  period: ReportingPeriod;
  topics: MaterialityTopicView[];
  /** 登録済み（保存済み）トピックがあるか */
  registered: boolean;
  /** マテリアルなトピック数 */
  materialCount: number;
  /** マテリアルなトピック全体の充足度（0〜100） */
  overallCoverage: number;
}

/** 期間のマテリアリティ評価と、対象指標の収集状況をまとめて読む。 */
export async function loadMateriality(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  metrics: MetricDefinition[],
): Promise<MaterialityOverview> {
  const organizationId = ctx.workspace.organizationId;

  const saved = await db.select('materialityTopics', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const savedByKey = new Map(saved.map((t) => [t.topicKey, t]));

  // 当期に承認済みの値がある指標（＝収集できている指標）
  const approved = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: period.id, status: 'approved' },
  });
  const collectedMetricIds = new Set(approved.map((dp) => dp.metricId));
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));

  const topics: MaterialityTopicView[] = DEFAULT_TOPICS.map((base) => {
    const row = savedByKey.get(base.topicKey);
    const metricCodes = row?.metricCodes.length ? row.metricCodes : base.metricCodes;
    const targets = metricCodes
      .map((code) => metricByCode.get(code))
      .filter((m): m is MetricDefinition => Boolean(m));
    const collected = targets.filter((m) => collectedMetricIds.has(m.id));
    const level = row?.materiality ?? 'not_assessed';

    return {
      topicKey: base.topicKey,
      title: row?.title ?? base.title,
      category: row?.category ?? base.category,
      materiality: level,
      rationale: row?.rationale ?? '',
      metricCodes,
      collectedMetricCount: collected.length,
      totalMetricCount: targets.length,
      coverage: isMaterial(level)
        ? targets.length === 0
          ? 0
          : Math.round((collected.length / targets.length) * 100)
        : null,
      missingMetricNames: targets.filter((m) => !collectedMetricIds.has(m.id)).map((m) => m.name),
      saved: Boolean(row),
    };
  });

  const material = topics.filter((t) => isMaterial(t.materiality));
  const overallCoverage =
    material.length === 0
      ? 0
      : Math.round(material.reduce((sum, t) => sum + (t.coverage ?? 0), 0) / material.length);

  return {
    period,
    topics,
    registered: saved.length > 0,
    materialCount: material.length,
    overallCoverage,
  };
}

/** マテリアリティ評価の登録・更新（1 トピック）。 */
export async function saveMaterialityTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    reportingPeriodId: Uuid;
    topicKey: string;
    materiality: MaterialityLevel;
    rationale: string;
  },
): Promise<MaterialityTopic> {
  assertCan(ctx, 'enterprise.disclosure.write');

  const base = DEFAULT_TOPICS.find((t) => t.topicKey === input.topicKey);
  if (!base) throw new NotFoundError('トピックが見つかりません。');

  const rationale = input.rationale.trim();
  if (rationale.length > 1000) {
    throw new Error('評価理由は 1000 文字以内で入力してください。');
  }
  // 重要と判断したものは、なぜ重要なのかを残す（後から監査で問われる）
  if (isMaterial(input.materiality) && !rationale) {
    throw new Error('重要と評価する場合は、その理由を入力してください。');
  }

  const organizationId = ctx.workspace.organizationId;
  const now = new Date().toISOString();

  const existing = await db.select('materialityTopics', {
    where: { organizationId, reportingPeriodId: input.reportingPeriodId, topicKey: input.topicKey },
    limit: 1,
  });

  if (existing[0]) {
    await db.update('materialityTopics', existing[0].id, {
      materiality: input.materiality,
      rationale,
      assessedAt: now,
      assessedBy: ctx.userId,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'materiality_topic',
      resourceId: existing[0].id,
      afterSummary: `マテリアリティを更新: ${base.title} → ${MATERIALITY_LABEL[input.materiality]}`,
    });
    return { ...existing[0], materiality: input.materiality, rationale };
  }

  const topic: MaterialityTopic = {
    id: fid('materiality_topic', `${organizationId}/${input.reportingPeriodId}/${input.topicKey}`),
    organizationId,
    reportingPeriodId: input.reportingPeriodId,
    topicKey: base.topicKey,
    title: base.title,
    category: base.category,
    materiality: input.materiality,
    rationale,
    metricCodes: base.metricCodes,
    assessedAt: now,
    assessedBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('materialityTopics', [topic]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'materiality_topic',
    resourceId: topic.id,
    afterSummary: `マテリアリティを登録: ${base.title} → ${MATERIALITY_LABEL[input.materiality]}`,
  });
  return topic;
}
