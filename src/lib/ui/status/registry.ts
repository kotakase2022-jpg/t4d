/**
 * 状態登録簿（docs/ui-redesign/plan.md §3.2）。React 非依存。
 *
 * 画面ごとに状態の表（ラベル・色・アイコン）を持つと、同じ状態が画面によって別の語・別の色になる
 * （IC §4.4: 20 個の共通バッジと約 45 個の画面ローカルの表）。ドメインごとのファイルに 1 つずつ置き、
 * ここで集約する。各ドメインは domain.ts の enum を網羅する Record なので、値を足し忘れると型で落ちる。
 *
 * ドメイン別ファイルの所有（Stage B で各スライスが plan §1.17 の文言へ直す）:
 *  B1 dataPoint・job・task・quantitativeImport・scan・approvalStep
 *  B2 response・ssbjCoverage・ssbjAction
 *  B3 csrdDraft・csrdPlan・dmaOutcome・applicabilityCsrd
 *  B4 block・review・narrative・applicabilityProject
 *  B5 period・aiRun
 *  B6 pbc・test・issue・reviewNote・engagement・membership・signoff・samplingMethod
 */
import { aiRun } from './aiRun';
import { applicabilityCsrd } from './applicabilityCsrd';
import { applicabilityProject } from './applicabilityProject';
import { approvalStep } from './approvalStep';
import { block } from './block';
import { csrdDraft } from './csrdDraft';
import { csrdPlan } from './csrdPlan';
import { dataPoint } from './dataPoint';
import { dmaOutcome } from './dmaOutcome';
import { engagement } from './engagement';
import { issue } from './issue';
import { job } from './job';
import { membership } from './membership';
import { narrative } from './narrative';
import { pbc } from './pbc';
import { period } from './period';
import { quantitativeImport } from './quantitativeImport';
import { response } from './response';
import { review } from './review';
import { reviewNote } from './reviewNote';
import { samplingMethod } from './samplingMethod';
import { scan } from './scan';
import { signoff } from './signoff';
import { ssbjAction } from './ssbjAction';
import { ssbjCoverage } from './ssbjCoverage';
import { task } from './task';
import { test } from './test';
import { SEMANTIC_STYLE, type StatusEntry, type StatusSemantic } from './types';

export * from './types';
export { CSRD_DRAFT_STATES, type CsrdDraftStateKey } from './csrdDraft';

export const STATUS = {
  dataPoint,
  response,
  block,
  review,
  job,
  task,
  pbc,
  test,
  issue,
  reviewNote,
  engagement,
  membership,
  period,
  aiRun,
  ssbjCoverage,
  ssbjAction,
  applicabilityProject,
  applicabilityCsrd,
  narrative,
  quantitativeImport,
  csrdDraft,
  csrdPlan,
  dmaOutcome,
  signoff,
  scan,
  approvalStep,
  samplingMethod,
} as const;

export type StatusDomain = keyof typeof STATUS;

/** そのドメインで使える値（例: StatusValue<'dataPoint'> = DataPointStatus） */
export type StatusValue<D extends StatusDomain> = keyof (typeof STATUS)[D] & string;

/** 知らない値（古い Cookie に残った行など）でも画面を落とさず、生の値も出さない */
const UNKNOWN_ENTRY: StatusEntry = { label: '状態不明', semantic: 'info' };

export function statusEntry(domain: StatusDomain, value: string): StatusEntry {
  const table = STATUS[domain] as Readonly<Record<string, StatusEntry>>;
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value]! : UNKNOWN_ENTRY;
}

/** 表示ラベル（バッジ以外の場所: 表の文字列・選択肢・Notice の文など） */
export function statusLabel(domain: StatusDomain, value: string): string {
  return statusEntry(domain, value).label;
}

export function statusStyle(semantic: StatusSemantic) {
  return SEMANTIC_STYLE[semantic];
}

/** 選択肢（NativeSelect・絞り込みチップ）に使う、登録順の値とラベル */
export function statusOptions<D extends StatusDomain>(
  domain: D,
): Array<{ value: StatusValue<D>; label: string }> {
  return Object.entries(STATUS[domain] as Readonly<Record<string, StatusEntry>>).map(
    ([value, entry]) => ({ value: value as StatusValue<D>, label: entry.label }),
  );
}
