import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { isMaterial, loadMateriality } from '@/lib/services/materiality';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  MetricDefinition,
  ReportingPeriod,
  SsbjAnalysisSettings,
  SsbjConsolidationScope,
  SsbjValueChainScope,
  Uuid,
} from '@/types/domain';

/**
 * SSBJ 対応の「①マテリアリティ・分析条件の設定」。
 *
 * 8 ステップの入口。ここで決めるのは、後続すべての前提になる 3 つ。
 *   ① どの基準を適用するか（一般開示基準／気候関連開示基準／実務対応基準）
 *   ② どこまでを報告の範囲にするか（連結範囲・バリューチェーン）
 *   ③ どのサステナビリティ課題に重要性があるか（マテリアリティ）
 *
 * ③は materiality_topics が持つので、ここでは①②と「確定したか」を扱い、
 * ③の登録状況を合わせて 1 つの完了判定にする。
 *
 * 確定は人の操作でのみ起きる（AI は確定しない。CLAUDE.md §0.4）。
 * 未確定のまま先へ進めることは止めない——実務では並行して動くため——が、
 * 「まだ前提が決まっていない」ことは画面に出し続ける。
 */

/** 設定の 3 つの決めごと。画面はこの順に並べる */
export type SsbjSettingStepKey = 'standards' | 'boundary' | 'materiality';

export interface SsbjSettingStep {
  key: SsbjSettingStepKey;
  title: string;
  description: string;
  done: boolean;
  /** 未完了のときに何をすればよいか */
  todo: string;
  /** 完了しているときの要約 */
  summary: string;
}

export interface SsbjSettingsView {
  period: ReportingPeriod;
  settings: SsbjAnalysisSettings | null;
  steps: SsbjSettingStep[];
  /** 3 つすべて決まっているか（確定操作ができる状態か） */
  ready: boolean;
  /** 人が確定したか */
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedByName: string | null;
  /** マテリアリティの登録状況 */
  materialTopicCount: number;
  assessedTopicCount: number;
  totalTopicCount: number;
  /** 適用する基準から決まる、評価対象の要求事項の節 */
  includedSections: string[];
  canEdit: boolean;
}

const CONSOLIDATION_LABEL: Record<SsbjConsolidationScope, string> = {
  same_as_financial: '財務諸表と同一の連結範囲',
  custom: '財務諸表とは異なる範囲',
};

const VALUE_CHAIN_LABEL: Record<SsbjValueChainScope, string> = {
  not_decided: '未決定',
  upstream: '上流のみ',
  downstream: '下流のみ',
  both: '上流・下流の両方',
  none: '含めない',
};

export const SSBJ_CONSOLIDATION_OPTIONS = CONSOLIDATION_LABEL;
export const SSBJ_VALUE_CHAIN_OPTIONS = VALUE_CHAIN_LABEL;

/**
 * 適用する基準から、評価対象になる要求事項の節を決める。
 * 要求事項マスターの section は「一般：〜」「気候：〜」「実務対応第1号：〜」で始まる。
 */
export function includedSectionPrefixes(settings: SsbjAnalysisSettings | null): string[] {
  // 未設定のうちは既定（一般・気候）で見せる。設定してから絞り込む
  if (!settings) return ['一般', '気候'];
  const prefixes: string[] = [];
  if (settings.applyGeneral) prefixes.push('一般');
  if (settings.applyClimate) prefixes.push('気候');
  if (settings.applyPractical) prefixes.push('実務対応');
  return prefixes;
}

export async function loadSsbjSettings(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  metrics: MetricDefinition[],
): Promise<SsbjSettingsView> {
  const organizationId = ctx.workspace.organizationId;

  const [rows, materiality] = await Promise.all([
    db.select('ssbjAnalysisSettings', {
      where: { organizationId, reportingPeriodId: period.id },
      limit: 1,
    }),
    loadMateriality(db, ctx, period, metrics),
  ]);
  const settings = rows[0] ?? null;

  const assessed = materiality.topics.filter((t) => t.materiality !== 'not_assessed');
  const material = materiality.topics.filter((t) => isMaterial(t.materiality));

  // ①適用する基準: 1 つ以上選んでいれば決まったとみなす
  const standardsDone = Boolean(
    settings && (settings.applyGeneral || settings.applyClimate || settings.applyPractical),
  );
  // ②報告の範囲: バリューチェーンの扱いを「未決定」から動かしていれば決まったとみなす。
  //   SSBJ はバリューチェーンの範囲を決めないと Scope3 の対象が定まらない
  const boundaryDone = Boolean(settings && settings.valueChainScope !== 'not_decided');
  // ③マテリアリティ: 全トピックを評価し終えていること。
  //   一部だけ評価した状態は「重要でない」と判断したのか未着手なのか区別できない
  const materialityDone =
    materiality.topics.length > 0 && assessed.length === materiality.topics.length;

  const appliedNames = settings
    ? [
        settings.applyGeneral ? '一般開示基準' : null,
        settings.applyClimate ? '気候関連開示基準' : null,
        settings.applyPractical ? '実務対応基準第1号' : null,
      ].filter((v): v is string => Boolean(v))
    : [];

  const steps: SsbjSettingStep[] = [
    {
      key: 'standards',
      title: '適用する基準を決める',
      description:
        'SSBJ は基準ごとに適用の要否が分かれます。適用しない基準の要求事項は評価対象から外れます。',
      done: standardsDone,
      todo: '一般開示基準・気候関連開示基準・実務対応基準のうち、当年度に適用するものを選んでください。',
      summary:
        appliedNames.length > 0
          ? `${appliedNames.join(' ／ ')}${settings?.firstTimeAdoption ? '（初年度適用の経過措置あり）' : ''}`
          : '未選択',
    },
    {
      key: 'boundary',
      title: '報告の範囲を決める',
      description:
        '連結範囲とバリューチェーンの扱いを決めます。ここが決まらないと Scope3 の対象範囲が定まりません。',
      done: boundaryDone,
      todo: 'バリューチェーンを報告に含めるかどうかを決めてください（「未決定」のままでは先の工程で範囲が定まりません）。',
      summary: settings
        ? `${CONSOLIDATION_LABEL[settings.consolidationScope]} ／ バリューチェーン: ${VALUE_CHAIN_LABEL[settings.valueChainScope]}`
        : '未設定',
    },
    {
      key: 'materiality',
      title: 'マテリアリティを特定・評価する',
      description:
        '自社の重要課題を自由記述で登録し、区分を選び、重要性を判断します。重要性なしとした課題は、要求事項の評価でも重要性なしの根拠になります。',
      done: materialityDone,
      todo:
        materiality.topics.length === 0
          ? 'マテリアリティがまだ登録されていません。自社の重要課題を自由記述で入力してください。'
          : `${materiality.topics.length - assessed.length} 件の課題が未評価です。すべての課題に重要性の判断と理由（必須）を入れてください。`,
      summary: `${materiality.topics.length} 件中 ${assessed.length} 件を評価済み（重要性あり ${material.length} 件）`,
    },
  ];

  const ready = steps.every((s) => s.done);

  let confirmedByName: string | null = null;
  if (settings?.confirmedBy) {
    const profile = await db.findById('profiles', settings.confirmedBy);
    confirmedByName = profile?.displayName ?? null;
  }

  return {
    period,
    settings,
    steps,
    ready,
    confirmed: Boolean(settings?.confirmedAt),
    confirmedAt: settings?.confirmedAt ?? null,
    confirmedByName,
    materialTopicCount: material.length,
    assessedTopicCount: assessed.length,
    totalTopicCount: materiality.topics.length,
    includedSections: includedSectionPrefixes(settings),
    canEdit: can(ctx, 'enterprise.disclosure.write'),
  };
}

export interface SaveSsbjSettingsInput {
  reportingPeriodId: Uuid;
  applyGeneral: boolean;
  applyClimate: boolean;
  applyPractical: boolean;
  firstTimeAdoption: boolean;
  consolidationScope: SsbjConsolidationScope;
  consolidationNote: string;
  includedUnitIds: Uuid[];
  valueChainScope: SsbjValueChainScope;
  valueChainNote: string;
}

/**
 * 分析条件を保存する。保存しただけでは確定にならない。
 * 内容を変えたら確定は外れる（前提が変わったのに確定のままだと、
 * 後続の工程が古い前提のまま進む）。
 */
export async function saveSsbjSettings(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveSsbjSettingsInput,
): Promise<SsbjAnalysisSettings> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const period = await db.findById('periods', input.reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new ValidationError('報告期間が見つかりません。');
  }
  if (!input.applyGeneral && !input.applyClimate && !input.applyPractical) {
    throw new ValidationError('適用する基準を 1 つ以上選んでください。');
  }
  if (input.consolidationScope === 'custom' && input.consolidationNote.trim() === '') {
    throw new ValidationError(
      '財務諸表と異なる連結範囲にする場合は、その範囲と理由を書いてください。',
    );
  }

  const now = new Date().toISOString();
  const existing = await db.select('ssbjAnalysisSettings', {
    where: { organizationId, reportingPeriodId: input.reportingPeriodId },
    limit: 1,
  });
  const current = existing[0];

  const patch = {
    applyGeneral: input.applyGeneral,
    applyClimate: input.applyClimate,
    applyPractical: input.applyPractical,
    firstTimeAdoption: input.firstTimeAdoption,
    consolidationScope: input.consolidationScope,
    consolidationNote: input.consolidationNote.trim(),
    includedUnitIds: input.includedUnitIds,
    valueChainScope: input.valueChainScope,
    valueChainNote: input.valueChainNote.trim(),
    // 前提を変えたら確定は外れる。確定は「この内容でよい」という人の判断なので、
    // 内容が変わった時点でその判断は当てはまらなくなる
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  };

  if (current) {
    const updated = await db.update('ssbjAnalysisSettings', current.id, patch);
    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'ssbj_analysis_settings',
      resourceId: current.id,
      afterSummary: `SSBJ の分析条件を変更（確定は取り消し）`,
    });
    return updated;
  }

  const row: SsbjAnalysisSettings = {
    id: fid('ssbj_analysis_settings', `${organizationId}/${input.reportingPeriodId}`),
    organizationId,
    reportingPeriodId: input.reportingPeriodId,
    ...patch,
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('ssbjAnalysisSettings', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ssbj_analysis_settings',
    resourceId: row.id,
    afterSummary: 'SSBJ の分析条件を設定',
  });
  return row;
}

/**
 * 分析条件を確定する。
 *
 * 3 つの決めごとがすべて済んでいないと確定できない。
 * 確定できないまま先へ進むこと自体は止めないが、確定という記録は残させない。
 */
export async function confirmSsbjSettings(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
  metrics: MetricDefinition[],
): Promise<SsbjAnalysisSettings> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const period = await db.findById('periods', reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new ValidationError('報告期間が見つかりません。');
  }

  const view = await loadSsbjSettings(db, ctx, period, metrics);
  if (!view.settings) {
    throw new ValidationError('先に分析条件を保存してください。');
  }
  if (!view.ready) {
    const remaining = view.steps.filter((s) => !s.done).map((s) => s.title);
    throw new ValidationError(`まだ決まっていない項目があります: ${remaining.join(' ／ ')}`);
  }

  const now = new Date().toISOString();
  const updated = await db.update('ssbjAnalysisSettings', view.settings.id, {
    confirmedAt: now,
    confirmedBy: ctx.userId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_analysis_settings',
    resourceId: view.settings.id,
    afterSummary: `SSBJ の分析条件を確定（${view.materialTopicCount} 件の課題を重要性ありと判断）`,
  });
  return updated;
}
