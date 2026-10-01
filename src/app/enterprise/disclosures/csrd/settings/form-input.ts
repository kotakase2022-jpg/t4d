import type {
  DecideCsrdDmaMatterInput,
  SaveCsrdBoundaryInput,
  SaveCsrdMethodInput,
  UpsertCsrdDmaIroInput,
} from '@/lib/services/csrd/settings';
import {
  ESRS_TOPICS,
  type DmaAxisAssessment,
  type EsrsTopic,
  type ImpactDirection,
  type ImpactOccurrence,
  type IroType,
  type SsbjConsolidationScope,
  type SsbjValueChainScope,
  type TimeHorizon,
  type ValueChainStage,
} from '@/types/domain';

/**
 * CSRD 設定の Server Action が使う、フォームからの入力の取り出し（docs/disclosure-first.md §9.4）。
 *
 * 値の検査（範囲・形・根拠の有無）はサービス（services/csrd/settings.ts）が一か所で行う。
 * ここで検査を重ねると規則が二重になり、片方だけ直す事故が起きるため、文字列を型へ写すだけにする。
 * ただし次の 2 点はここで決める:
 *  - 空欄は null／NaN のまま渡す（黙って 0 にすると「入力していない」が「1 未満」に化ける）
 *  - IRO は種類（インパクト／リスク・機会）と、実在／潜在・負／正に合わない欄を使わない
 *    （画面はその欄を出していない。前に選んだ種類の値が残って送られても形の検査で弾かれないように）
 */

export const CSRD_BASE_PATH = '/enterprise/disclosures/csrd';
export const CSRD_SETTINGS_PATH = `${CSRD_BASE_PATH}/settings`;

/** FormData と同じ読み方ができるもの（テストでは FormData をそのまま渡す） */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

function text(form: FormLike, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function optionalText(form: FormLike, name: string): string | null {
  const value = text(form, name).trim();
  return value === '' ? null : value;
}

/** 数値の欄。空欄は null、読めない入力は NaN（サービスが理由付きで拒否する）。全角も読む */
function optionalNumber(form: FormLike, name: string): number | null {
  const value = text(form, name).normalize('NFKC').trim();
  if (value === '') return null;
  return Number(value);
}

/** 必須の数値の欄。空欄も NaN にする（Number('') は 0 になるため使わない） */
function requiredNumber(form: FormLike, name: string): number {
  return optionalNumber(form, name) ?? Number.NaN;
}

/** URL に使ってよい事項コード（ESRS のテーマ）か。それ以外は null */
export function safeTopic(value: unknown): EsrsTopic | null {
  return typeof value === 'string' && (ESRS_TOPICS as readonly string[]).includes(value)
    ? (value as EsrsTopic)
    : null;
}

/** 事項の画面のパス。事項コードが不正なら設定画面 */
export function matterPath(topic: EsrsTopic | null): string {
  return topic ? `${CSRD_SETTINGS_PATH}/matters/${topic}` : CSRD_SETTINGS_PATH;
}

/** ①報告範囲 */
export function parseBoundaryForm(form: FormLike): SaveCsrdBoundaryInput {
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    consolidationScope: text(form, 'consolidationScope') as SsbjConsolidationScope,
    consolidationNote: text(form, 'consolidationNote'),
    // 未選択は空配列＝全社。個別に選んだときだけ絞り込む（SSBJ と同じ）
    includedUnitIds: form
      .getAll('includedUnitIds')
      .filter((v): v is string => typeof v === 'string' && v !== ''),
    valueChainScope: text(form, 'valueChainScope') as SsbjValueChainScope,
    valueChainNote: text(form, 'valueChainNote'),
  };
}

/** ②評価方法・閾値・ステークホルダー関与 */
export function parseMethodForm(form: FormLike): SaveCsrdMethodInput {
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    impactThreshold: requiredNumber(form, 'impactThreshold'),
    financialThreshold: requiredNumber(form, 'financialThreshold'),
    methodNote: text(form, 'methodNote'),
    stakeholderEngagementNote: text(form, 'stakeholderEngagementNote'),
  };
}

/** IRO の追加・更新 */
export function parseIroForm(form: FormLike): UpsertCsrdDmaIroInput {
  const iroType = text(form, 'iroType') as IroType;
  const isImpact = iroType === 'impact';
  const occurrence = isImpact
    ? (optionalText(form, 'impactOccurrence') as ImpactOccurrence | null)
    : null;
  const direction = isImpact
    ? (optionalText(form, 'impactDirection') as ImpactDirection | null)
    : null;
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    topic: text(form, 'topic'),
    iroId: optionalText(form, 'iroId'),
    iroType,
    subTopic: text(form, 'subTopic'),
    description: text(form, 'description'),
    valueChainStage: text(form, 'valueChainStage') as ValueChainStage,
    timeHorizon: optionalText(form, 'timeHorizon') as TimeHorizon | null,
    impactOccurrence: occurrence,
    impactDirection: direction,
    impactScale: isImpact ? optionalNumber(form, 'impactScale') : null,
    impactScope: isImpact ? optionalNumber(form, 'impactScope') : null,
    // 正のインパクトに回復困難性は無い。方向が未選択のときは送られた値を渡し、形の検査に任せる
    impactIrremediability:
      isImpact && direction !== 'positive' ? optionalNumber(form, 'impactIrremediability') : null,
    // 実在のインパクトに発生可能性は無い
    impactLikelihood:
      isImpact && occurrence !== 'actual' ? optionalNumber(form, 'impactLikelihood') : null,
    financialLikelihood: isImpact ? null : optionalNumber(form, 'financialLikelihood'),
    financialMagnitude: isImpact ? null : optionalNumber(form, 'financialMagnitude'),
    // 人権フラグはインパクトにだけ付ける
    humanRights: isImpact && form.get('humanRights') === 'on',
    affectedStakeholders: text(form, 'affectedStakeholders'),
    // 関連するインパクト IRO はリスク・機会だけが持つ
    relatedImpactIroId: isImpact ? null : optionalText(form, 'relatedImpactIroId'),
  };
}

/** 事項の 2 軸の判断 */
export function parseMatterDecisionForm(form: FormLike): DecideCsrdDmaMatterInput {
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    topic: text(form, 'topic'),
    impactAssessment: text(form, 'impactAssessment') as DmaAxisAssessment,
    impactRationale: text(form, 'impactRationale'),
    financialAssessment: text(form, 'financialAssessment') as DmaAxisAssessment,
    financialRationale: text(form, 'financialRationale'),
    stakeholderNote: text(form, 'stakeholderNote'),
  };
}
