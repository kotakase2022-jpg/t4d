import type { CreateCsrdActionPlanInput } from '@/lib/services/csrd/plans';
import type {
  CsrdRequirementFilters,
  CsrdRequirementView,
  ReviewCsrdAssessmentInput,
  SaveCsrdAssessmentInput,
} from '@/lib/services/csrd/requirements';
import type { SsbjActionType, SsbjCoverageStatus, SsbjGapKind, SsbjPriority } from '@/types/domain';

/**
 * CSRD 要求事項の Server Action と一覧の URL 絞り込みが使う、入力の取り出し（docs/disclosure-first.md §9.4）。
 * 値の検査（5 値・評価対象か・コメント必須など）はサービスが一か所で行い、ここでは型へ写すだけにする。
 * 戻り先の URL には UUID の要求事項 ID だけを使う（送られた文字列で別の画面へ飛ばさない）。
 */

export const CSRD_REQUIREMENTS_PATH = '/enterprise/disclosures/csrd/requirements';

/**
 * 優先度「高」（評価対象・未対応）の一覧。対応状況の件数（評価対象かつ総合が対応済み以外）と同じ母集団。
 * 優先度は評価対象だけが持つため、対象外・未判定はこの絞り込みに入らない
 */
export const CSRD_OPEN_HIGH_PRIORITY_QUERY =
  'priority=high&coverage=mostly_covered&coverage=partial&coverage=not_covered&coverage=unconfirmed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FormLike {
  get(name: string): FormDataEntryValue | null;
}

function text(form: FormLike, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function optionalText(form: FormLike, name: string): string | null {
  const value = text(form, name).trim();
  return value === '' ? null : value;
}

/** URL に使ってよい要求事項 ID（UUID）か。それ以外は null */
export function safeItemId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** 要求事項の詳細のパス。ID が不正なら一覧 */
export function requirementDetailPath(itemId: unknown): string {
  const id = safeItemId(itemId);
  return id ? `${CSRD_REQUIREMENTS_PATH}/${id}` : CSRD_REQUIREMENTS_PATH;
}

/** 担当者の入力（3 観点） */
export function parseAssessmentForm(form: FormLike): SaveCsrdAssessmentInput {
  const ownerDepartment = form.get('ownerDepartment');
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    itemId: text(form, 'itemId'),
    disclosureStatus: text(form, 'disclosureStatus') as SsbjCoverageStatus,
    dataStatus: text(form, 'dataStatus') as SsbjCoverageStatus,
    processStatus: text(form, 'processStatus') as SsbjCoverageStatus,
    comment: text(form, 'comment'),
    // 欄の無いフォームからは担当部署を変えない（空欄で上書きしない）
    ...(typeof ownerDepartment === 'string' ? { ownerDepartment } : {}),
  };
}

/** 担当者の確認（候補を採用／修正して確定） */
export function parseReviewForm(form: FormLike): ReviewCsrdAssessmentInput {
  const decision = text(form, 'decision') as ReviewCsrdAssessmentInput['decision'];
  const base = {
    assessmentId: text(form, 'assessmentId'),
    decision,
    comment: text(form, 'comment'),
  };
  // 「候補を採用」は AI の候補をサービスが写す。画面の値を混ぜない
  if (decision !== 'modified') return base;
  return {
    ...base,
    disclosureStatus: text(form, 'disclosureStatus') as SsbjCoverageStatus,
    dataStatus: text(form, 'dataStatus') as SsbjCoverageStatus,
    processStatus: text(form, 'processStatus') as SsbjCoverageStatus,
  };
}

/** 対応計画の追加 */
export function parsePlanForm(form: FormLike): CreateCsrdActionPlanInput {
  return {
    reportingPeriodId: text(form, 'reportingPeriodId'),
    itemId: text(form, 'itemId'),
    gapKind: text(form, 'gapKind') as SsbjGapKind,
    title: text(form, 'title'),
    detail: text(form, 'detail'),
    actionType: text(form, 'actionType') as SsbjActionType,
    department: text(form, 'department'),
    assigneeUserId: optionalText(form, 'assigneeUserId'),
    dueDate: optionalText(form, 'dueDate'),
    priority: text(form, 'priority') as SsbjPriority,
  };
}

type SearchParams = Record<string, string | string[] | undefined>;

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 一覧の URL（?applicability=&perspective=&coverage=&priority=&review=awaiting&q=） */
export function parseRequirementQuery(query: SearchParams): {
  filters: Required<CsrdRequirementFilters>;
  q: string;
} {
  const q = query.q;
  return {
    filters: {
      applicability: toList(query.applicability),
      perspective: toList(query.perspective),
      coverage: toList(query.coverage),
      priority: toList(query.priority),
      review: toList(query.review),
    },
    q: (typeof q === 'string' ? q : '').trim(),
  };
}

/** 検索語（要求事項コード・見出し）。大文字小文字を区別しない。空なら全件 */
export function searchCsrdRequirements(
  views: CsrdRequirementView[],
  q: string,
): CsrdRequirementView[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return views;
  return views.filter((v) =>
    `${v.item.code} ${v.item.questionText}`.toLowerCase().includes(needle),
  );
}
