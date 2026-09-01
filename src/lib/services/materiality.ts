import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
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
 * 課題は固定の一覧から選ぶのではなく、**利用者が自社の言葉で自由記述し**、
 * 当てはまりそうな区分の提示を受けて選ぶ。
 *   マテリアリティ名の入力 → 区分の選択 → 項目（対象指標）→ 評価と理由
 * の順に決まり、課題そのものを追加・編集・削除できる。
 *
 * 削除は論理削除。評価の記録は監査で問われるため、行を物理的に消さない。
 */

/**
 * 追加フォームに例として出す課題の候補。
 *
 * 以前はこの一覧が「固定の課題」としてそのまま画面に並んでいたが、
 * いまは**入力の下書き**でしかない。クリックすると名前が入力欄へ入り、
 * 区分の提示 → 選択という通常の流れに乗る。
 */
export const PRESET_TOPICS: Array<{ title: string }> = [
  { title: '気候変動（GHG 排出）' },
  { title: '水資源の利用' },
  { title: '資源循環・廃棄物' },
  { title: '人的資本（人材の育成・多様性）' },
  { title: '労働安全衛生' },
  { title: 'サプライチェーン管理' },
  { title: 'コーポレートガバナンス' },
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

const MATERIALITY_LEVELS = new Set<MaterialityLevel>([
  'high',
  'medium',
  'low',
  'not_material',
  'not_assessed',
]);
const CATEGORIES = new Set<MaterialityCategory>(['environment', 'social', 'governance']);

export interface MaterialityTopicView {
  /** materiality_topics.id。追加・編集・削除・評価はこの ID で行う */
  id: Uuid;
  topicKey: string;
  title: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  rationale: string;
  metricCodes: string[];
  /** 項目（対象指標）の表示名。マスターに無いコードは含めない */
  metricNames: string[];
  /** 対象指標のうち、当期に承認済みの値がある数 */
  collectedMetricCount: number;
  /** 対象指標の総数 */
  totalMetricCount: number;
  /** 充足度（0〜100）。マテリアルでないトピックは対象外なので null */
  coverage: number | null;
  /** まだ承認済みの値が無い指標名 */
  missingMetricNames: string[];
}

export interface MaterialityOverview {
  period: ReportingPeriod;
  topics: MaterialityTopicView[];
  /** 登録済みトピックがあるか */
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
    where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
    orderBy: { column: 'createdAt', dir: 'asc' },
  });

  // 当期に承認済みの値がある指標（＝収集できている指標）
  const approved = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: period.id, status: 'approved' },
  });
  const collectedMetricIds = new Set(approved.map((dp) => dp.metricId));
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));

  const topics: MaterialityTopicView[] = saved.map((row) => {
    const targets = row.metricCodes
      .map((code) => metricByCode.get(code))
      .filter((m): m is MetricDefinition => Boolean(m));
    const collected = targets.filter((m) => collectedMetricIds.has(m.id));

    return {
      id: row.id,
      topicKey: row.topicKey,
      title: row.title,
      category: row.category,
      materiality: row.materiality,
      rationale: row.rationale,
      metricCodes: row.metricCodes,
      metricNames: targets.map((m) => m.name),
      collectedMetricCount: collected.length,
      totalMetricCount: targets.length,
      coverage: isMaterial(row.materiality)
        ? targets.length === 0
          ? 0
          : Math.round((collected.length / targets.length) * 100)
        : null,
      missingMetricNames: targets.filter((m) => !collectedMetricIds.has(m.id)).map((m) => m.name),
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

/** 自組織・生存中のトピックを引く（他社の ID を差し込まれても存在ごと秘匿する） */
async function findOwnedTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  topicId: Uuid,
): Promise<MaterialityTopic> {
  const topic = await db.findById('materialityTopics', topicId);
  if (!topic || topic.organizationId !== ctx.workspace.organizationId || topic.deletedAt) {
    throw new NotFoundError('マテリアリティの課題が見つかりません。');
  }
  return topic;
}

function validateTitle(raw: string): string {
  // NFKC 正規化はしない。全角括弧・全角英数を勝手に半角へ書き換えると、
  // 利用者が入力したとおりの名前で表示されなくなる（正規化は提示の照合側だけで使う）
  const title = raw.trim();
  if (title === '') throw new ValidationError('マテリアリティ名を入力してください。');
  if (title.length > 100) {
    throw new ValidationError('マテリアリティ名は 100 文字以内で入力してください。');
  }
  return title;
}

function validateCategory(raw: string): MaterialityCategory {
  if (!CATEGORIES.has(raw as MaterialityCategory)) {
    throw new ValidationError('区分を選んでください。');
  }
  return raw as MaterialityCategory;
}

/** 指標コードは指標マスターに実在するものだけ受け付ける（画面偽装への備え） */
function validateMetricCodes(raw: string[], metrics: MetricDefinition[]): string[] {
  const known = new Set(metrics.map((m) => m.code));
  return [...new Set(raw.map((c) => c.trim()).filter((c) => c !== '' && known.has(c)))];
}

export interface AddTopicInput {
  reportingPeriodId: Uuid;
  /** 自由記述のマテリアリティ名 */
  title: string;
  /** 提示から利用者が選んだ区分 */
  category: string;
  /** 提示に基づく項目（対象指標）。マスターに無いコードは捨てる */
  metricCodes: string[];
}

/** マテリアリティの課題を追加する。追加時点では未評価（評価は別の操作）。 */
export async function addMaterialityTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  metrics: MetricDefinition[],
  input: AddTopicInput,
): Promise<MaterialityTopic> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const period = await db.findById('periods', input.reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }

  const title = validateTitle(input.title);
  const category = validateCategory(input.category);
  const metricCodes = validateMetricCodes(input.metricCodes, metrics);

  // 同じ名前の課題を二重登録させない（生きている行の中で）
  const existing = await db.select('materialityTopics', {
    where: {
      organizationId,
      reportingPeriodId: input.reportingPeriodId,
      deletedAt: { isNull: true },
    },
  });
  if (existing.some((t) => t.title === title)) {
    throw new ValidationError(`「${title}」は既に登録されています。`);
  }

  const now = new Date().toISOString();
  const topic: MaterialityTopic = {
    // 決定論 ID（fid）は使わない。時刻を種に混ぜても同一ミリ秒の
    // 「削除 → 同名で再追加」で衝突する。課題はデモの固定 Fixture ではなく
    // 利用者が作る行なので、毎回必ず別になる乱数 ID でよい
    id: crypto.randomUUID(),
    organizationId,
    reportingPeriodId: input.reportingPeriodId,
    topicKey: crypto.randomUUID().slice(0, 8),
    title,
    category,
    materiality: 'not_assessed',
    rationale: '',
    metricCodes,
    assessedAt: null,
    assessedBy: null,
    deletedAt: null,
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
    afterSummary: `マテリアリティを追加: ${title}（${CATEGORY_LABEL[category]}）`,
  });
  return topic;
}

export interface UpdateTopicInput {
  topicId: Uuid;
  title: string;
  category: string;
}

/** 課題の名前・区分を編集する。評価は変えない（評価は別の操作）。 */
export async function updateMaterialityTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  input: UpdateTopicInput,
): Promise<MaterialityTopic> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const topic = await findOwnedTopic(db, ctx, input.topicId);

  const title = validateTitle(input.title);
  const category = validateCategory(input.category);

  const siblings = await db.select('materialityTopics', {
    where: {
      organizationId: topic.organizationId,
      reportingPeriodId: topic.reportingPeriodId,
      deletedAt: { isNull: true },
    },
  });
  if (siblings.some((t) => t.id !== topic.id && t.title === title)) {
    throw new ValidationError(`「${title}」は既に登録されています。`);
  }

  const now = new Date().toISOString();
  const updated = await db.update('materialityTopics', topic.id, {
    title,
    category,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'materiality_topic',
    resourceId: topic.id,
    beforeSummary: `${topic.title}（${CATEGORY_LABEL[topic.category]}）`,
    afterSummary: `マテリアリティを編集: ${title}（${CATEGORY_LABEL[category]}）`,
  });
  return updated;
}

/** 課題を削除する（論理削除。評価の記録は行として残す）。 */
export async function deleteMaterialityTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  topicId: Uuid,
): Promise<void> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const topic = await findOwnedTopic(db, ctx, topicId);

  const now = new Date().toISOString();
  await db.update('materialityTopics', topic.id, {
    deletedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  // 監査イベントの種別に削除専用は無い（追記専用ログ側の制約）。
  // 論理削除は行の状態変更として data_updated で残し、内容で削除と分かるようにする
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'materiality_topic',
    resourceId: topic.id,
    beforeSummary: `${topic.title}（${MATERIALITY_LABEL[topic.materiality]}）`,
    afterSummary: `マテリアリティを削除: ${topic.title}`,
  });
}

export interface AssessTopicInput {
  topicId: Uuid;
  materiality: string;
  rationale: string;
}

/**
 * 課題に評価と理由を付ける。
 *
 * 理由は**評価を付けるとき必須**。重要とした根拠も、重要でないとした根拠も、
 * 後から監査で問われる。未評価へ戻すときだけ理由なしを許す。
 */
export async function assessMaterialityTopic(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AssessTopicInput,
): Promise<MaterialityTopic> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const topic = await findOwnedTopic(db, ctx, input.topicId);

  if (!MATERIALITY_LEVELS.has(input.materiality as MaterialityLevel)) {
    throw new ValidationError('評価の値が不正です。');
  }
  const materiality = input.materiality as MaterialityLevel;

  const rationale = input.rationale.trim();
  if (rationale.length > 1000) {
    throw new ValidationError('評価理由は 1000 文字以内で入力してください。');
  }
  if (materiality !== 'not_assessed' && rationale === '') {
    throw new ValidationError('評価理由を入力してください（必須）。');
  }

  const now = new Date().toISOString();
  const updated = await db.update('materialityTopics', topic.id, {
    materiality,
    rationale,
    assessedAt: materiality === 'not_assessed' ? null : now,
    assessedBy: materiality === 'not_assessed' ? null : ctx.userId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: topic.assessedAt ? 'data_updated' : 'data_created',
    resourceType: 'materiality_topic',
    resourceId: topic.id,
    beforeSummary: `${topic.title} → ${MATERIALITY_LABEL[topic.materiality]}`,
    afterSummary: `マテリアリティを評価: ${topic.title} → ${MATERIALITY_LABEL[materiality]}`,
  });
  return updated;
}
