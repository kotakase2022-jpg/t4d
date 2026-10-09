import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { can, NotFoundError } from '@/lib/authorization/can';
import { DMA_OUTCOME_LABEL, ESRS_TOPIC_LABEL, dmaOutcome } from '@/lib/domain/csrd';
import { csrdRowIds } from '@/lib/domain/csrd-ids';
import {
  DMA_SCORING_METHOD_LABEL,
  DMA_THRESHOLD_MAX,
  DMA_THRESHOLD_MIN,
  iroFinancialScore,
  iroImpactScore,
  iroSeverity,
  validateIroShape,
  type DmaThresholds,
} from '@/lib/domain/dma';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import {
  DMA_AXIS_ASSESSMENTS,
  DMA_OUTCOMES,
  SSBJ_CONSOLIDATION_SCOPES,
  SSBJ_VALUE_CHAIN_SCOPES,
  type AuthorizationContext,
  type CsrdAnalysisSettings,
  type CsrdDmaIro,
  type CsrdDmaMatter,
  type DmaAxisAssessment,
  type DmaOutcome,
  type EsrsTopic,
  type ImpactDirection,
  type ImpactOccurrence,
  type IroType,
  type ReportingPeriod,
  type SsbjConsolidationScope,
  type SsbjValueChainScope,
  type TimeHorizon,
  type Uuid,
  type ValueChainStage,
} from '@/types/domain';
import {
  assertCsrdWrite,
  cleanText,
  defaultCsrdMatter,
  defaultCsrdSettings,
  displayNameOf,
  findCsrdPeriod,
  isEsrsTopic,
  loadCsrdContext,
  releaseDmaConfirmation,
  type CsrdMatterState,
} from './core';

/**
 * CSRD の設定（報告範囲・評価方法と閾値・ダブル・マテリアリティ評価）（docs/disclosure-first.md §9.4）。
 *
 * 守っていること:
 *  - DMA に関わる書込（報告範囲・閾値・IRO・事項の判断）は、同じ処理で DMA の確定を外す
 *    （前提が変わったのに確定のままだと、要求事項の適用が古い判断のまま「確定」に見える）
 *  - 確定は人の操作でのみ入り、条件（報告範囲の決定・ステークホルダー関与の記載・
 *    10 事項すべての判断）が揃わなければ ValidationError
 *  - 算定結果は提案にすぎず、事項の重要性は人が根拠付きで判断する。AI は DMA に一切書かない
 */

/** 文字数の上限（Demo Mode の Cookie で持ち回せる大きさ） */
const NOTE_MAX = 1000;
const RATIONALE_MAX = 600;
const IRO_TEXT_MAX = 300;
const IRO_SHORT_MAX = 100;

// ----------------------------------------------------------------------
// 読込
// ----------------------------------------------------------------------

export interface CsrdDmaReadiness {
  /** 報告範囲が決まっているか（バリューチェーンを決め、異なる連結範囲なら説明あり） */
  boundaryDecided: boolean;
  /** ステークホルダー関与を記載したか */
  stakeholderNoted: boolean;
  /** 10 事項すべてを判断したか（どちらの軸も未評価でない） */
  allMattersAssessed: boolean;
  unassessedTopics: EsrsTopic[];
  /** 確定できる状態か */
  ready: boolean;
  /** 足りない条件（画面にそのまま出す） */
  missing: string[];
}

export interface CsrdSettingsView {
  period: ReportingPeriod;
  /** 保存済みの行、または既定値の仮想行 */
  settings: CsrdAnalysisSettings;
  settingsPersisted: boolean;
  thresholds: DmaThresholds;
  scoringMethodLabel: string;
  /** ESRS_TOPICS の順に 10 件 */
  matters: CsrdMatterState[];
  /** 人の判断の結果ごとの事項数（n / 10） */
  outcomeCounts: Record<DmaOutcome, number>;
  matterTotal: number;
  readiness: CsrdDmaReadiness;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedByName: string | null;
  /** 判断者の表示名（事項ごと） */
  decidedByNames: Record<string, string>;
  canEdit: boolean;
}

/** DMA の確定の条件（loadCsrdSettings と confirmCsrdDma が同じ判定を使う） */
export function dmaReadiness(
  settings: CsrdAnalysisSettings,
  matters: readonly Pick<CsrdMatterState, 'topic' | 'outcome'>[],
): CsrdDmaReadiness {
  const boundaryDecided =
    settings.valueChainScope !== 'not_decided' &&
    (settings.consolidationScope !== 'custom' || settings.consolidationNote.trim() !== '');
  const stakeholderNoted = settings.stakeholderEngagementNote.trim() !== '';
  const unassessedTopics = matters.filter((m) => m.outcome === 'not_assessed').map((m) => m.topic);
  const allMattersAssessed = unassessedTopics.length === 0;
  const missing: string[] = [];
  if (!boundaryDecided) {
    missing.push(
      '報告範囲（バリューチェーンの扱い。異なる連結範囲ならその説明）を決めてください。',
    );
  }
  if (!stakeholderNoted)
    missing.push('ステークホルダー関与（誰の意見をどう聞いたか）を記載してください。');
  if (!allMattersAssessed) {
    missing.push(
      `未評価の事項があります: ${unassessedTopics.map((t) => `${t} ${ESRS_TOPIC_LABEL[t]}`).join('、')}`,
    );
  }
  return {
    boundaryDecided,
    stakeholderNoted,
    allMattersAssessed,
    unassessedTopics,
    ready: missing.length === 0,
    missing,
  };
}

function countOutcomes(matters: readonly CsrdMatterState[]): Record<DmaOutcome, number> {
  const counts = Object.fromEntries(DMA_OUTCOMES.map((o) => [o, 0])) as Record<DmaOutcome, number>;
  for (const matter of matters) counts[matter.outcome] += 1;
  return counts;
}

/** 設定画面（3 手順＋確定）の読込。書かない。CSRD のマスターが無ければ null */
export async function loadCsrdSettings(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<CsrdSettingsView | null> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  const names: Record<string, string> = {};
  for (const state of context.matters) {
    const by = state.matter.decidedBy;
    if (by && !names[by]) names[by] = (await displayNameOf(db, by)) ?? '';
  }
  return {
    period,
    settings: context.settings,
    settingsPersisted: context.settingsPersisted,
    thresholds: {
      impactThreshold: context.settings.impactThreshold,
      financialThreshold: context.settings.financialThreshold,
    },
    scoringMethodLabel: DMA_SCORING_METHOD_LABEL[context.settings.scoringMethod],
    matters: context.matters,
    outcomeCounts: countOutcomes(context.matters),
    matterTotal: context.matters.length,
    readiness: dmaReadiness(context.settings, context.matters),
    confirmed: context.dmaConfirmed,
    confirmedAt: context.settings.dmaConfirmedAt,
    confirmedByName: await displayNameOf(db, context.settings.dmaConfirmedBy),
    decidedByNames: names,
    canEdit: can(ctx, 'enterprise.disclosure.write'),
  };
}

/** IRO 1 件の算定（画面の表） */
export interface CsrdIroScoreView {
  iro: CsrdDmaIro;
  /** 深刻度（小数 1 桁に丸めた表示用。インパクトのみ） */
  severity: number | null;
  /** インパクトのスコア（インパクトのみ） */
  impactScore: number | null;
  /** リスク・機会のスコア */
  financialScore: number | null;
  /** 関連するインパクト IRO の説明（リスク・機会のみ） */
  relatedImpactDescription: string | null;
}

export interface CsrdMatterDetail {
  period: ReportingPeriod;
  state: CsrdMatterState;
  thresholds: DmaThresholds;
  scoringMethodLabel: string;
  iros: CsrdIroScoreView[];
  /** リスク・機会の「関連するインパクト」に選べる IRO */
  impactIroOptions: Array<{ id: Uuid; description: string }>;
  decidedByName: string | null;
  dmaConfirmed: boolean;
  canEdit: boolean;
}

/** 1 事項の画面（IRO の一覧と軸ごとの判断）。書かない。テーマが不正なら null */
export async function loadCsrdMatterDetail(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  topic: string,
): Promise<CsrdMatterDetail | null> {
  if (!isEsrsTopic(topic)) return null;
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  const state = context.matters.find((m) => m.topic === topic);
  if (!state) return null;
  const byId = new Map(state.iros.map((iro) => [iro.id, iro]));
  const iros = state.iros.map((iro) => {
    const severity = iroSeverity(iro);
    return {
      iro,
      severity: severity === null ? null : Math.round((severity + Number.EPSILON) * 10) / 10,
      impactScore: iroImpactScore(iro),
      financialScore: iroFinancialScore(iro),
      relatedImpactDescription: iro.relatedImpactIroId
        ? (byId.get(iro.relatedImpactIroId)?.description ?? null)
        : null,
    };
  });
  return {
    period,
    state,
    thresholds: {
      impactThreshold: context.settings.impactThreshold,
      financialThreshold: context.settings.financialThreshold,
    },
    scoringMethodLabel: DMA_SCORING_METHOD_LABEL[context.settings.scoringMethod],
    iros,
    impactIroOptions: state.iros
      .filter((iro) => iro.iroType === 'impact')
      .map((iro) => ({ id: iro.id, description: iro.description })),
    decidedByName: await displayNameOf(db, state.matter.decidedBy),
    dmaConfirmed: context.dmaConfirmed,
    canEdit: can(ctx, 'enterprise.disclosure.write'),
  };
}

// ----------------------------------------------------------------------
// 書込: 報告範囲・評価方法
// ----------------------------------------------------------------------

async function upsertSettings(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  patch: Partial<CsrdAnalysisSettings>,
  now: string,
): Promise<{ row: CsrdAnalysisSettings; created: boolean }> {
  const organizationId = ctx.workspace.organizationId;
  const rows = await db.select('csrdAnalysisSettings', {
    where: { organizationId, reportingPeriodId: period.id },
    limit: 1,
  });
  const current = rows[0];
  // 内容を変えたら DMA の確定は外れる（確定は「この前提でよい」という人の判断のため）
  const full = {
    ...patch,
    dmaConfirmedAt: null,
    dmaConfirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  };
  if (current) {
    return { row: await db.update('csrdAnalysisSettings', current.id, full), created: false };
  }
  const row: CsrdAnalysisSettings = {
    ...defaultCsrdSettings(organizationId, period),
    id: csrdRowIds.settings(organizationId, period.id),
    ...full,
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('csrdAnalysisSettings', [row]);
  return { row, created: true };
}

export interface SaveCsrdBoundaryInput {
  reportingPeriodId: Uuid;
  consolidationScope: SsbjConsolidationScope;
  consolidationNote: string;
  includedUnitIds: Uuid[];
  valueChainScope: SsbjValueChainScope;
  valueChainNote: string;
}

/** ①報告範囲を保存する。DMA の確定は外れる */
export async function saveCsrdBoundary(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveCsrdBoundaryInput,
): Promise<CsrdAnalysisSettings> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId);
  if (!SSBJ_CONSOLIDATION_SCOPES.includes(input.consolidationScope)) {
    throw new ValidationError('連結範囲の考え方を選んでください。');
  }
  if (!SSBJ_VALUE_CHAIN_SCOPES.includes(input.valueChainScope)) {
    throw new ValidationError('バリューチェーンの扱いを選んでください。');
  }
  const consolidationNote = cleanText(input.consolidationNote, NOTE_MAX, '連結範囲の説明');
  if (input.consolidationScope === 'custom' && consolidationNote === '') {
    throw new ValidationError(
      '財務諸表と異なる連結範囲にする場合は、その範囲と理由を書いてください。',
    );
  }
  // 報告対象の拠点は自組織のものに限る（他社の拠点 ID を範囲に入れさせない）
  const unitIds = [...new Set(input.includedUnitIds)];
  if (unitIds.length > 0) {
    const units = await db.select('units', {
      where: { organizationId: ctx.workspace.organizationId, id: { in: unitIds } },
    });
    if (units.length !== unitIds.length) {
      throw new ValidationError('報告対象に、この組織の拠点ではないものが含まれています。');
    }
  }
  const now = new Date().toISOString();
  const { row, created } = await upsertSettings(
    db,
    ctx,
    period,
    {
      consolidationScope: input.consolidationScope,
      consolidationNote,
      includedUnitIds: unitIds,
      valueChainScope: input.valueChainScope,
      valueChainNote: cleanText(input.valueChainNote, NOTE_MAX, 'バリューチェーンの説明'),
    },
    now,
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'csrd_analysis_settings',
    resourceId: row.id,
    afterSummary: created
      ? 'CSRD の報告範囲を設定'
      : 'CSRD の報告範囲を変更（DMA の確定は取り消し）',
  });
  return row;
}

export interface SaveCsrdMethodInput {
  reportingPeriodId: Uuid;
  impactThreshold: number;
  financialThreshold: number;
  methodNote: string;
  stakeholderEngagementNote: string;
}

function assertThreshold(value: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < DMA_THRESHOLD_MIN ||
    value > DMA_THRESHOLD_MAX ||
    Math.abs(Math.round(value * 10) - value * 10) > 1e-9
  ) {
    throw new ValidationError(
      `${label}は ${DMA_THRESHOLD_MIN.toFixed(1)}〜${DMA_THRESHOLD_MAX.toFixed(1)} の小数 1 桁で入力してください。`,
    );
  }
  return Math.round(value * 10) / 10;
}

/** ②評価方法・閾値・ステークホルダー関与を保存する。DMA の確定は外れる */
export async function saveCsrdMethod(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveCsrdMethodInput,
): Promise<CsrdAnalysisSettings> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId);
  const impactThreshold = assertThreshold(input.impactThreshold, 'インパクトの閾値');
  const financialThreshold = assertThreshold(input.financialThreshold, '財務の閾値');
  const now = new Date().toISOString();
  const { row, created } = await upsertSettings(
    db,
    ctx,
    period,
    {
      scoringMethod: 'dma-demo-v1',
      impactThreshold,
      financialThreshold,
      methodNote: cleanText(input.methodNote, NOTE_MAX, '評価方法の説明'),
      stakeholderEngagementNote: cleanText(
        input.stakeholderEngagementNote,
        NOTE_MAX,
        'ステークホルダー関与の記載',
      ),
    },
    now,
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'csrd_analysis_settings',
    resourceId: row.id,
    afterSummary: `CSRD の評価方法を${created ? '設定' : '変更'}（閾値 インパクト ${impactThreshold.toFixed(1)}・財務 ${financialThreshold.toFixed(1)}${created ? '' : '。DMA の確定は取り消し'}）`,
  });
  return row;
}

// ----------------------------------------------------------------------
// 書込: IRO
// ----------------------------------------------------------------------

/** 事項の行を用意する（無ければ既定値で作る。IRO・判断の保存の前に要る） */
async function ensureMatter(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  topic: EsrsTopic,
  now: string,
): Promise<CsrdDmaMatter> {
  const organizationId = ctx.workspace.organizationId;
  const rows = await db.select('csrdDmaMatters', {
    where: { organizationId, reportingPeriodId: period.id, esrsTopic: topic },
    limit: 1,
  });
  if (rows[0]) return rows[0];
  const row: CsrdDmaMatter = {
    ...defaultCsrdMatter(organizationId, period, topic),
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('csrdDmaMatters', [row]);
  return row;
}

/** IRO の入力（画面のフォームから） */
export interface CsrdIroInput {
  iroType: IroType;
  subTopic: string;
  description: string;
  valueChainStage: ValueChainStage;
  timeHorizon: TimeHorizon | null;
  impactOccurrence: ImpactOccurrence | null;
  impactDirection: ImpactDirection | null;
  impactScale: number | null;
  impactScope: number | null;
  impactIrremediability: number | null;
  impactLikelihood: number | null;
  financialLikelihood: number | null;
  financialMagnitude: number | null;
  humanRights: boolean;
  affectedStakeholders: string;
  relatedImpactIroId: Uuid | null;
}

export interface UpsertCsrdDmaIroInput extends CsrdIroInput {
  reportingPeriodId: Uuid;
  topic: string;
  /** 既存の IRO を直すときの ID。省略・null は追加 */
  iroId?: Uuid | null;
  /**
   * 方針・取組のメモ（0052。インパクト・リスク・機会の台帳 NF-10）。省略（undefined）は今の値のまま。
   * Demo の Cookie の検査と同じく 400 字まで
   */
  policyActionNote?: string;
}

/** 方針・取組のメモの上限（Demo の Cookie の検査 demo-csrd-checks.ts と同じ値） */
export const IRO_POLICY_NOTE_MAX = 400;

/**
 * IRO を追加・更新する。形の検査（validateIroShape）を通らなければ ValidationError。
 * 関連するインパクト IRO は、同じ事項の（論理削除していない）インパクトに限る。DMA の確定は外れる
 */
export async function upsertCsrdDmaIro(
  db: DbClient,
  ctx: AuthorizationContext,
  input: UpsertCsrdDmaIroInput,
): Promise<CsrdDmaIro> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId);
  if (!isEsrsTopic(input.topic)) throw new NotFoundError('サステナビリティ事項が見つかりません。');
  const topic = input.topic;
  const organizationId = ctx.workspace.organizationId;

  const shape: CsrdIroInput = {
    ...input,
    subTopic: cleanText(input.subTopic, IRO_SHORT_MAX, 'サブトピック'),
    description: cleanText(input.description, IRO_TEXT_MAX, 'IRO の内容'),
    affectedStakeholders: cleanText(input.affectedStakeholders, IRO_TEXT_MAX, '影響を受ける人'),
    humanRights: input.humanRights === true,
  };
  const errors = validateIroShape(shape);
  if (errors.length > 0) throw new ValidationError(errors.join(' '));
  const policyActionNote =
    input.policyActionNote === undefined
      ? undefined
      : cleanText(input.policyActionNote, IRO_POLICY_NOTE_MAX, '方針・取組のメモ');

  const now = new Date().toISOString();
  const existing = input.iroId ? await db.findById('csrdDmaIros', input.iroId) : null;
  if (input.iroId) {
    if (
      !existing ||
      existing.organizationId !== organizationId ||
      existing.reportingPeriodId !== period.id ||
      existing.deletedAt !== null
    ) {
      throw new NotFoundError('IRO が見つかりません。');
    }
  }
  const matter = await ensureMatter(db, ctx, period, topic, now);
  if (existing && existing.matterId !== matter.id) {
    throw new NotFoundError('IRO が見つかりません。');
  }

  if (shape.relatedImpactIroId) {
    const related = await db.findById('csrdDmaIros', shape.relatedImpactIroId);
    if (
      !related ||
      related.organizationId !== organizationId ||
      related.matterId !== matter.id ||
      related.iroType !== 'impact' ||
      related.deletedAt !== null ||
      related.id === existing?.id
    ) {
      throw new ValidationError(
        '関連するインパクトは、同じ事項のインパクト IRO から選んでください。',
      );
    }
  }

  const values = {
    iroType: shape.iroType,
    subTopic: shape.subTopic,
    description: shape.description,
    valueChainStage: shape.valueChainStage,
    timeHorizon: shape.timeHorizon,
    impactOccurrence: shape.impactOccurrence,
    impactDirection: shape.impactDirection,
    impactScale: shape.impactScale,
    impactScope: shape.impactScope,
    impactIrremediability: shape.impactIrremediability,
    impactLikelihood: shape.impactLikelihood,
    financialLikelihood: shape.financialLikelihood,
    financialMagnitude: shape.financialMagnitude,
    humanRights: shape.humanRights,
    affectedStakeholders: shape.affectedStakeholders,
    relatedImpactIroId: shape.relatedImpactIroId,
  };

  let saved: CsrdDmaIro;
  if (existing) {
    saved = await db.update('csrdDmaIros', existing.id, {
      ...values,
      ...(policyActionNote === undefined ? {} : { policyActionNote }),
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    // インパクトでなくなったら、それを関連先にしていたリスク・機会から外す
    if (existing.iroType === 'impact' && values.iroType !== 'impact') {
      await detachRelated(db, ctx, existing.id, now);
    }
  } else {
    saved = {
      id: fid('csrd_dma_iro', `${matter.id}/${values.iroType}/${now}/${values.description}`),
      organizationId,
      reportingPeriodId: period.id,
      matterId: matter.id,
      ...values,
      // 根拠の引用位置（0052）は空から始める（定性情報と同じ引用位置を後から結ぶ）。方針のメモは入力のまま
      sourceAnchorIds: [],
      policyActionNote: policyActionNote ?? '',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    await db.insert('csrdDmaIros', [saved]);
  }
  const released = await releaseDmaConfirmation(db, ctx, period, now);
  await recordAuditEvent(db, ctx, {
    eventType: existing ? 'data_updated' : 'data_created',
    resourceType: 'csrd_dma_iro',
    resourceId: saved.id,
    afterSummary: `${topic} ${ESRS_TOPIC_LABEL[topic]} の IRO を${existing ? '更新' : '追加'}: ${saved.description}${released ? '（DMA の確定は取り消し）' : ''}`,
  });
  return saved;
}

/** 関連するインパクト IRO の参照を外す（削除・種類の変更のとき） */
async function detachRelated(
  db: DbClient,
  ctx: AuthorizationContext,
  impactIroId: Uuid,
  now: string,
): Promise<void> {
  const referencing = await db.select('csrdDmaIros', {
    where: { organizationId: ctx.workspace.organizationId, relatedImpactIroId: impactIroId },
  });
  for (const iro of referencing) {
    await db.update('csrdDmaIros', iro.id, {
      relatedImpactIroId: null,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  }
}

/** IRO を論理削除する（履歴は残る）。DMA の確定は外れる */
export async function deleteCsrdDmaIro(
  db: DbClient,
  ctx: AuthorizationContext,
  iroId: Uuid,
): Promise<void> {
  assertCsrdWrite(ctx);
  const iro = await db.findById('csrdDmaIros', iroId);
  if (!iro || iro.organizationId !== ctx.workspace.organizationId || iro.deletedAt !== null) {
    throw new NotFoundError('IRO が見つかりません。');
  }
  const period = await findCsrdPeriod(db, ctx, iro.reportingPeriodId);
  const now = new Date().toISOString();
  await db.softDelete('csrdDmaIros', iro.id, now);
  if (iro.iroType === 'impact') await detachRelated(db, ctx, iro.id, now);
  const released = await releaseDmaConfirmation(db, ctx, period, now);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_dma_iro',
    resourceId: iro.id,
    beforeSummary: iro.description,
    afterSummary: `IRO を削除（論理削除）${released ? '（DMA の確定は取り消し）' : ''}`,
  });
}

// ----------------------------------------------------------------------
// 書込: 事項の判断・DMA の確定
// ----------------------------------------------------------------------

export interface DecideCsrdDmaMatterInput {
  reportingPeriodId: Uuid;
  topic: string;
  impactAssessment: DmaAxisAssessment;
  impactRationale: string;
  financialAssessment: DmaAxisAssessment;
  financialRationale: string;
  stakeholderNote: string;
}

/**
 * 事項の 2 軸を人が判断する（重要／重要でない／未評価）。評価済みの軸は根拠が必須。
 * 算定結果（提案）と違う判断もできる（判断するのは人で、根拠を残す）。DMA の確定は外れる
 */
export async function decideCsrdDmaMatter(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DecideCsrdDmaMatterInput,
): Promise<CsrdDmaMatter> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId);
  if (!isEsrsTopic(input.topic)) throw new NotFoundError('サステナビリティ事項が見つかりません。');
  const topic = input.topic;
  if (
    !DMA_AXIS_ASSESSMENTS.includes(input.impactAssessment) ||
    !DMA_AXIS_ASSESSMENTS.includes(input.financialAssessment)
  ) {
    throw new ValidationError('判断は「重要」「重要でない」「未評価」から選んでください。');
  }
  const impactRationale = cleanText(input.impactRationale, RATIONALE_MAX, 'インパクトの判断の根拠');
  const financialRationale = cleanText(input.financialRationale, RATIONALE_MAX, '財務の判断の根拠');
  if (input.impactAssessment !== 'not_assessed' && impactRationale === '') {
    throw new ValidationError('インパクトの判断の根拠を入力してください。');
  }
  if (input.financialAssessment !== 'not_assessed' && financialRationale === '') {
    throw new ValidationError('財務の判断の根拠を入力してください。');
  }
  const decided =
    input.impactAssessment !== 'not_assessed' || input.financialAssessment !== 'not_assessed';

  const now = new Date().toISOString();
  const matter = await ensureMatter(db, ctx, period, topic, now);
  const updated = await db.update('csrdDmaMatters', matter.id, {
    impactAssessment: input.impactAssessment,
    impactRationale,
    financialAssessment: input.financialAssessment,
    financialRationale,
    stakeholderNote: cleanText(input.stakeholderNote, NOTE_MAX, 'ステークホルダーの意見'),
    decidedAt: decided ? now : null,
    decidedBy: decided ? ctx.userId : null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  const released = await releaseDmaConfirmation(db, ctx, period, now);
  const beforeOutcome = dmaOutcome(matter.impactAssessment, matter.financialAssessment);
  const afterOutcome = dmaOutcome(input.impactAssessment, input.financialAssessment);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_dma_matter',
    resourceId: matter.id,
    beforeSummary: `${topic}: ${DMA_OUTCOME_LABEL[beforeOutcome]}`,
    afterSummary: `${topic} ${ESRS_TOPIC_LABEL[topic]}: ${DMA_OUTCOME_LABEL[afterOutcome]}${released ? '（DMA の確定は取り消し）' : ''}`,
  });
  // 事項の結果（重要と判断した観点）が変わったら、その事項の節の本文の確定も外す。確定した本文は
  // 前の判断の観点（例:「両面で重要」）で書かれており、対象外・未判定になれば確定の条件も満たさない
  if (beforeOutcome !== afterOutcome) {
    await releaseTopicDraftConfirmation(db, ctx, period, topic, now);
  }
  return updated;
}

/** 事項の節（テーマ別の開示ドラフト）の確定を外す。確定していなければ書かない */
async function releaseTopicDraftConfirmation(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  topic: EsrsTopic,
  now: string,
): Promise<void> {
  const drafts = await db.select('csrdDisclosureDrafts', {
    where: {
      organizationId: ctx.workspace.organizationId,
      reportingPeriodId: period.id,
      section: topic,
    },
    limit: 1,
  });
  const draft = drafts[0];
  if (!draft || draft.confirmedAt === null) return;
  await db.update('csrdDisclosureDrafts', draft.id, {
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_disclosure_draft',
    resourceId: draft.id,
    afterSummary: `${topic} ${ESRS_TOPIC_LABEL[topic]} の重要性の判断が変わったため、節の本文の確定を取り消し（本文は残す）`,
  });
}

/**
 * DMA を確定する（人の操作）。条件（報告範囲の決定・ステークホルダー関与の記載・
 * 10 事項すべての判断）が揃わなければ ValidationError。確定すると要求事項の適用から暫定が外れる
 */
export async function confirmCsrdDma(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
): Promise<CsrdAnalysisSettings> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, reportingPeriodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  if (!context.settingsPersisted) {
    throw new ValidationError('先に報告範囲と評価方法を保存してください。');
  }
  const readiness = dmaReadiness(context.settings, context.matters);
  if (!readiness.ready) {
    throw new ValidationError(`DMA を確定できません。${readiness.missing.join(' ')}`);
  }
  const now = new Date().toISOString();
  const updated = await db.update('csrdAnalysisSettings', context.settings.id, {
    dmaConfirmedAt: now,
    dmaConfirmedBy: ctx.userId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  const counts = countOutcomes(context.matters);
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'csrd_analysis_settings',
    resourceId: context.settings.id,
    afterSummary: `CSRD のダブル・マテリアリティ評価を確定（両面 ${counts.both}・インパクトのみ ${counts.impact_only}・財務のみ ${counts.financial_only}・重要でない ${counts.not_material} / ${context.matters.length} 事項）`,
  });
  return updated;
}
