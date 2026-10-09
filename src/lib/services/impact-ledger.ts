import 'server-only';

import { DMA_AXIS_ASSESSMENT_LABEL, DMA_OUTCOME_LABEL, ESRS_TOPIC_LABEL } from '@/lib/domain/csrd';
import {
  IMPACT_DIRECTION_LABEL,
  IMPACT_OCCURRENCE_LABEL,
  IRO_TYPE_LABEL,
  TIME_HORIZON_LABEL,
  VALUE_CHAIN_STAGE_LABEL,
} from '@/lib/domain/dma';
import { NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { assertCsrdRead, findCsrdPeriod, loadCsrdContext } from '@/lib/services/csrd/core';
import type { DbClient } from '@/lib/repositories/types';
import {
  IRO_TYPES,
  type AuthorizationContext,
  type CsrdDmaIro,
  type DmaAxisAssessment,
  type DmaOutcome,
  type EsrsTopic,
  type IroType,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';

/**
 * インパクト・リスク・機会の台帳（トライアル対応 NF-10。スライド 7「インパクト記載情報の格納・整理」）。
 *
 * 格納は既存の CSRD の DMA の IRO（csrd_dma_iros）。新しい表は作らない（0052 で根拠と方針のメモの列だけ足した）。
 * 台帳は読み取り時に毎回導く（保存しない。Demo の Cookie を増やさない）。
 *
 * 列の意味を取り違えない（§5 D7 の既定「別列」）:
 *  - SSBJ: 企業への影響（財務的影響を含む）。IRO を説明する定性情報（narrative_versions.iro_refs）を並べる
 *  - CSRD: DMA の結果（人の判断。EU 法人向け・通常 ESRS の架空サンプル）
 *  - ESRS-40a: 事項のインパクト軸の判断を**参考として表示するだけ**（公開草案に基づく参考。重要性の判断ではない。
 *    財務軸は 40a の重要性に使わない。DMA を書き換えない）
 *
 * 書込は既存の upsertCsrdDmaIro（DMA の確定を外す規則を保つ）と、定性情報の版の保存（iro_refs）だけ。
 * 権限: enterprise.disclosure.read（CSRD の読込と同じ）
 */

/** 40a の列の注記（列見出し・画面の注記に使う。折りたたまない） */
export const ESRS40A_REFERENCE_NOTE = '公開草案に基づく参考（重要性の判断ではありません）';

/** CSRD の列の注記 */
export const CSRD_LEDGER_NOTE = 'EU 法人向け・通常 ESRS の架空サンプル';

/** SSBJ と CSRD・40a の「影響」の違い（列見出しの補足） */
export const LEDGER_PERSPECTIVE_NOTE =
  'SSBJ は企業への影響（財務的影響を含む）、CSRD・ESRS-40a は人・環境へのインパクトを扱います。同じ事項でも列ごとに意味が違います。';

export interface ImpactLedgerNarrativeRef {
  recordId: Uuid;
  title: string;
  themeLabel: string;
  versionNo: number;
}

export interface ImpactLedgerRow {
  iro: CsrdDmaIro;
  topic: EsrsTopic;
  topicLabel: string;
  iroTypeLabel: string;
  occurrenceLabel: string | null;
  directionLabel: string | null;
  valueChainLabel: string;
  timeHorizonLabel: string | null;
  /** 根拠（引用位置）の件数（同じ組織のものだけ数える） */
  evidenceCount: number;
  csrd: { outcome: DmaOutcome; label: string; provisional: boolean };
  /** ESRS-40a の参考（インパクトの IRO だけ。リスク・機会は null） */
  esrs40a: { assessment: DmaAxisAssessment; label: string } | null;
  /** SSBJ: この IRO を説明する定性情報（現在の版が参照しているもの） */
  ssbj: ImpactLedgerNarrativeRef[];
}

export interface ImpactLedgerFilter {
  type?: IroType | null;
  topic?: EsrsTopic | null;
  q?: string | null;
}

export interface ImpactLedger {
  period: ReportingPeriod;
  versionLabel: string;
  legalLabel: string;
  dmaConfirmed: boolean;
  /** 絞り込み後の行 */
  rows: ImpactLedgerRow[];
  /** 絞り込み前の件数 */
  total: number;
  countsByType: Record<IroType, number>;
}

export async function loadImpactLedger(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { periodId: Uuid; filter?: ImpactLedgerFilter },
): Promise<ImpactLedger | null> {
  assertCsrdRead(ctx);
  const period = await findCsrdPeriod(db, ctx, input.periodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  const organizationId = ctx.workspace.organizationId;

  const iros = context.matters.flatMap((m) => m.iros.map((iro) => ({ iro, state: m })));
  const anchorIds = [...new Set(iros.flatMap(({ iro }) => iro.sourceAnchorIds))];
  const [anchors, records, versions] = await Promise.all([
    anchorIds.length > 0
      ? db.select('sourceAnchors', { where: { id: { in: anchorIds } } })
      : Promise.resolve([]),
    db.select('narrativeRecords', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('narrativeVersions', { where: { organizationId } }),
  ]);
  const ownAnchors = new Set(
    anchors.filter((a) => a.organizationId === organizationId).map((a) => a.id),
  );
  const versionById = new Map(versions.map((v) => [v.id, v]));
  // IRO → それを説明する定性情報（現在の版の iro_refs）
  const narrativesByIro = new Map<Uuid, ImpactLedgerNarrativeRef[]>();
  for (const record of records) {
    const current = record.currentVersionId ? versionById.get(record.currentVersionId) : undefined;
    if (!current) continue;
    for (const iroId of current.iroRefs) {
      const list = narrativesByIro.get(iroId) ?? [];
      list.push({
        recordId: record.id,
        title: record.title,
        themeLabel: NARRATIVE_THEME_LABELS[record.theme],
        versionNo: current.versionNo,
      });
      narrativesByIro.set(iroId, list);
    }
  }

  const all: ImpactLedgerRow[] = iros.map(({ iro, state }) => {
    const impactAssessment = state.matter.impactAssessment;
    return {
      iro,
      topic: state.topic,
      topicLabel: `${state.topic} ${ESRS_TOPIC_LABEL[state.topic]}`,
      iroTypeLabel: IRO_TYPE_LABEL[iro.iroType],
      occurrenceLabel: iro.impactOccurrence ? IMPACT_OCCURRENCE_LABEL[iro.impactOccurrence] : null,
      directionLabel: iro.impactDirection ? IMPACT_DIRECTION_LABEL[iro.impactDirection] : null,
      valueChainLabel: VALUE_CHAIN_STAGE_LABEL[iro.valueChainStage],
      timeHorizonLabel: iro.timeHorizon ? TIME_HORIZON_LABEL[iro.timeHorizon] : null,
      evidenceCount: iro.sourceAnchorIds.filter((id) => ownAnchors.has(id)).length,
      csrd: {
        outcome: state.outcome,
        label: DMA_OUTCOME_LABEL[state.outcome],
        provisional: !context.dmaConfirmed,
      },
      // 40a は事項のインパクト軸の判断を参考として出すだけ（財務軸は使わない）
      esrs40a:
        iro.iroType === 'impact'
          ? { assessment: impactAssessment, label: DMA_AXIS_ASSESSMENT_LABEL[impactAssessment] }
          : null,
      ssbj: narrativesByIro.get(iro.id) ?? [],
    };
  });

  const filter = input.filter ?? {};
  const q = (filter.q ?? '').trim().toLowerCase();
  const rows = all.filter(
    (row) =>
      (!filter.type || row.iro.iroType === filter.type) &&
      (!filter.topic || row.topic === filter.topic) &&
      (!q ||
        row.iro.description.toLowerCase().includes(q) ||
        row.iro.subTopic.toLowerCase().includes(q) ||
        row.iro.affectedStakeholders.toLowerCase().includes(q) ||
        row.topicLabel.toLowerCase().includes(q)),
  );
  const countsByType = Object.fromEntries(
    IRO_TYPES.map((t) => [t, all.filter((r) => r.iro.iroType === t).length]),
  ) as Record<IroType, number>;

  return {
    period,
    versionLabel: context.version.label,
    legalLabel: context.legalLabel,
    dmaConfirmed: context.dmaConfirmed,
    rows,
    total: all.length,
    countsByType,
  };
}

/** 定性情報の「関連するインパクト・リスク・機会」の選択肢（その年度の IRO。論理削除を除く） */
export async function listIroOptions(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<Array<{ id: Uuid; label: string; iroType: IroType }>> {
  assertCsrdRead(ctx);
  const period = await findCsrdPeriod(db, ctx, periodId);
  const iros = await db.select('csrdDmaIros', {
    where: {
      organizationId: ctx.workspace.organizationId,
      reportingPeriodId: period.id,
      deletedAt: { isNull: true },
    },
    orderBy: [{ column: 'createdAt' }, { column: 'id' }],
  });
  const matters = await db.select('csrdDmaMatters', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });
  return iros
    .map((iro) => {
      const topic = matters.find((m) => m.id === iro.matterId)?.esrsTopic;
      return {
        id: iro.id,
        iroType: iro.iroType,
        label: `${topic ? `${topic} ` : ''}${IRO_TYPE_LABEL[iro.iroType]}: ${iro.description}`,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}
