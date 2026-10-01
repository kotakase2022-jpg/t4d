import 'server-only';

import { assertCan, assertEnterpriseWorkspace, can, NotFoundError } from '@/lib/authorization/can';
import { dmaOutcome } from '@/lib/domain/csrd';
import { csrdRowIds } from '@/lib/domain/csrd-ids';
import { frameworkLegalLabel } from '@/lib/domain/disclosure-status';
import {
  DEFAULT_DMA_THRESHOLD,
  calcMatterAxes,
  proposedAxisAssessment,
  type MatterAxes,
} from '@/lib/domain/dma';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import {
  ESRS_TOPICS,
  IRO_TYPES,
  type AuthorizationContext,
  type CsrdActionPlan,
  type CsrdAnalysisSettings,
  type CsrdAssessment,
  type CsrdDmaIro,
  type CsrdDmaMatter,
  type DisclosureFrameworkVersion,
  type DisclosureItem,
  type DmaOutcome,
  type EsrsTopic,
  type MetricDefinition,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';

/**
 * CSRD（ESRS サンプル）の共通の読込（docs/disclosure-first.md §9.4）。
 *
 * 守っていること:
 *  - **読込関数は一切書かない**。行が無い期間（FY2025 など）は既定値の「仮想行」として返し、
 *    最初の保存で同じ ID の行を作る（SSBJ の評価行の一括作成のように、表示で行を作らない）
 *  - SSBJ の表（ssbj_*）を読まない・書かない（CSRD の行を SSBJ の画面へ混入させない）
 *  - 読込は enterprise.disclosure.read（write でも可、定性情報と同じ）。企業ワークスペースに限る
 */

/** 読込の権限（閲覧か編集のどちらか）。企業ワークスペースに限る */
export function assertCsrdRead(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
}

/** 書込の権限 */
export function assertCsrdWrite(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
}

/** 自組織の報告期間（他組織の期間 ID は「見つからない」と同じ扱い） */
export async function findCsrdPeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
): Promise<ReportingPeriod> {
  const period = await db.findById('periods', reportingPeriodId);
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new ValidationError('報告期間が見つかりません。');
  }
  return period;
}

/** 渡された期間が自組織のものか（画面から渡る期間オブジェクトも信用しない） */
export function assertOwnPeriod(ctx: AuthorizationContext, period: ReportingPeriod): void {
  if (period.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
}

/** ESRS のテーマか（URL の [topic] などから渡る文字列を検査する） */
export function isEsrsTopic(value: string): value is EsrsTopic {
  return (ESRS_TOPICS as readonly string[]).includes(value);
}

// ----------------------------------------------------------------------
// 既定値の仮想行
// ----------------------------------------------------------------------

/** 分析条件の既定値（行が無い期間）。閾値 3.0／3.0、バリューチェーン未決定、DMA 未確定 */
export function defaultCsrdSettings(
  organizationId: Uuid,
  period: ReportingPeriod,
): CsrdAnalysisSettings {
  return {
    id: csrdRowIds.settings(organizationId, period.id),
    organizationId,
    reportingPeriodId: period.id,
    consolidationScope: 'same_as_financial',
    consolidationNote: '',
    includedUnitIds: [],
    valueChainScope: 'not_decided',
    valueChainNote: '',
    scoringMethod: 'dma-demo-v1',
    impactThreshold: DEFAULT_DMA_THRESHOLD,
    financialThreshold: DEFAULT_DMA_THRESHOLD,
    methodNote: '',
    stakeholderEngagementNote: '',
    dmaConfirmedAt: null,
    dmaConfirmedBy: null,
    createdAt: period.createdAt,
    updatedAt: period.createdAt,
    createdBy: null,
    updatedBy: null,
  };
}

/** 事項の既定値（行が無い事項）。両軸とも未評価 */
export function defaultCsrdMatter(
  organizationId: Uuid,
  period: ReportingPeriod,
  topic: EsrsTopic,
): CsrdDmaMatter {
  return {
    id: csrdRowIds.matter(organizationId, period.id, topic),
    organizationId,
    reportingPeriodId: period.id,
    esrsTopic: topic,
    impactAssessment: 'not_assessed',
    financialAssessment: 'not_assessed',
    impactRationale: '',
    financialRationale: '',
    stakeholderNote: '',
    decidedAt: null,
    decidedBy: null,
    createdAt: period.createdAt,
    updatedAt: period.createdAt,
    createdBy: null,
    updatedBy: null,
  };
}

// ----------------------------------------------------------------------
// 共通の読込
// ----------------------------------------------------------------------

/** サステナビリティ事項 1 件の状態（人の判断・IRO・算定結果） */
export interface CsrdMatterState {
  topic: EsrsTopic;
  /** 保存済みの行、または既定値の仮想行 */
  matter: CsrdDmaMatter;
  persisted: boolean;
  /** 論理削除を除く IRO（インパクト → リスク → 機会、同じ種類は登録順） */
  iros: CsrdDmaIro[];
  /** 算定結果（提案。自社の方法・閾値） */
  axes: MatterAxes;
  /** 算定結果から見た結果（提案）。人の判断ではない */
  proposedOutcome: DmaOutcome;
  /** 人の判断から導いた結果 */
  outcome: DmaOutcome;
}

export interface CsrdContext {
  period: ReportingPeriod;
  /** CSRD（架空サンプル）の版 */
  version: DisclosureFrameworkVersion;
  /** 版の表示（「サンプル（架空）」など） */
  legalLabel: string;
  /** 要求事項（並び順） */
  items: DisclosureItem[];
  /** 要求事項 → 対応付いた指標（disclosure_mappings 経由） */
  metricsByItem: Map<Uuid, MetricDefinition[]>;
  settings: CsrdAnalysisSettings;
  settingsPersisted: boolean;
  /** ESRS_TOPICS の順に 10 件 */
  matters: CsrdMatterState[];
  dmaConfirmed: boolean;
  /** 保存済みの評価（版の要求事項のものだけ） */
  assessments: CsrdAssessment[];
  plans: CsrdActionPlan[];
}

/** CSRD の版と要求事項。マスターが無ければ null */
async function loadCsrdMaster(
  db: DbClient,
): Promise<{ version: DisclosureFrameworkVersion; items: DisclosureItem[] } | null> {
  const frameworks = await db.select('frameworks', { where: { key: 'csrd' }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const version = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!version) return null;
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: version.id },
    orderBy: { column: 'sortOrder' },
  });
  return { version, items };
}

/**
 * 版・12 項目・対応指標・設定・事項＋IRO・評価・計画をまとめて読む（書かない）。
 * CSRD のマスターが無ければ null
 */
export async function loadCsrdContext(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<CsrdContext | null> {
  assertCsrdRead(ctx);
  assertOwnPeriod(ctx, period);
  const organizationId = ctx.workspace.organizationId;

  const master = await loadCsrdMaster(db);
  if (!master) return null;
  const itemIds = master.items.map((i) => i.id);

  const [mappings, metrics, settingsRows, matterRows, iroRows, assessmentRows, plans] =
    await Promise.all([
      db.select('disclosureMappings', { where: { organizationId, itemId: { in: itemIds } } }),
      db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
      db.select('csrdAnalysisSettings', {
        where: { organizationId, reportingPeriodId: period.id },
        limit: 1,
      }),
      db.select('csrdDmaMatters', { where: { organizationId, reportingPeriodId: period.id } }),
      db.select('csrdDmaIros', {
        where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
        orderBy: [{ column: 'createdAt' }, { column: 'id' }],
      }),
      db.select('csrdAssessments', { where: { organizationId, reportingPeriodId: period.id } }),
      db.select('csrdActionPlans', {
        where: { organizationId, reportingPeriodId: period.id },
        orderBy: [{ column: 'createdAt' }, { column: 'id' }],
      }),
    ]);

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const metricsByItem = new Map<Uuid, MetricDefinition[]>();
  for (const mapping of mappings) {
    const metric = metricById.get(mapping.metricId);
    if (!metric) continue;
    const list = metricsByItem.get(mapping.itemId) ?? [];
    if (!list.some((m) => m.id === metric.id)) list.push(metric);
    metricsByItem.set(mapping.itemId, list);
  }

  const persistedSettings = settingsRows[0] ?? null;
  // numeric(2,1) は接続方法によって文字列で返りうるため、数値にそろえる
  const settings = persistedSettings
    ? {
        ...persistedSettings,
        impactThreshold: Number(persistedSettings.impactThreshold),
        financialThreshold: Number(persistedSettings.financialThreshold),
      }
    : defaultCsrdSettings(organizationId, period);
  const thresholds = {
    impactThreshold: settings.impactThreshold,
    financialThreshold: settings.financialThreshold,
  };

  const matterByTopic = new Map(matterRows.map((m) => [m.esrsTopic, m]));
  const matters: CsrdMatterState[] = ESRS_TOPICS.map((topic) => {
    const persisted = matterByTopic.get(topic) ?? null;
    const matter = persisted ?? defaultCsrdMatter(organizationId, period, topic);
    const iros = persisted
      ? iroRows
          .filter((iro) => iro.matterId === persisted.id)
          .sort((a, b) => IRO_TYPES.indexOf(a.iroType) - IRO_TYPES.indexOf(b.iroType))
      : [];
    const axes = calcMatterAxes(iros, thresholds);
    return {
      topic,
      matter,
      persisted: persisted !== null,
      iros,
      axes,
      proposedOutcome: dmaOutcome(
        proposedAxisAssessment(axes.impact),
        proposedAxisAssessment(axes.financial),
      ),
      outcome: dmaOutcome(matter.impactAssessment, matter.financialAssessment),
    };
  });

  const itemIdSet = new Set(itemIds);
  return {
    period,
    version: master.version,
    legalLabel: frameworkLegalLabel(master.version),
    items: master.items,
    metricsByItem,
    settings,
    settingsPersisted: persistedSettings !== null,
    matters,
    dmaConfirmed: settings.dmaConfirmedAt !== null,
    assessments: assessmentRows.filter((a) => itemIdSet.has(a.itemId)),
    plans,
  };
}

// ----------------------------------------------------------------------
// 書込の共通処理
// ----------------------------------------------------------------------

/**
 * 入力の文字列を整える（前後の空白を落とし、長さの上限を確かめる）。
 * 上限は Demo Mode の Cookie（3 × 3,800B）で操作を持ち回せる大きさに合わせている
 */
export function cleanText(value: unknown, max: number, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) {
    throw new ValidationError(`${label}は ${max} 字以内で入力してください。`);
  }
  return text;
}

/**
 * DMA の確定を外す（DMA に関わる書込と同じ処理で呼ぶ）。確定していなければ書かない
 * （書く必要の無い更新で Cookie の容量を使わない）。外したら true
 */
export async function releaseDmaConfirmation(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  now: string,
): Promise<boolean> {
  const rows = await db.select('csrdAnalysisSettings', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
    limit: 1,
  });
  const settings = rows[0];
  if (!settings || settings.dmaConfirmedAt === null) return false;
  await db.update('csrdAnalysisSettings', settings.id, {
    dmaConfirmedAt: null,
    dmaConfirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  return true;
}

/** 名前の引き当て（判断者・確定者の表示用） */
export async function displayNameOf(db: DbClient, userId: Uuid | null): Promise<string | null> {
  if (!userId) return null;
  const profile = await db.findById('profiles', userId);
  return profile?.displayName ?? null;
}
