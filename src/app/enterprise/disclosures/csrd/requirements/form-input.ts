import type { DataCoverage } from '@/lib/services/aggregation';
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
  // 「候補を採用」は AI の候補をサービスが写す。画面の値を混ぜない。
  // 画面が表示した候補の実行日時だけを渡し、表示の後に分析がやり直されていればサービスが断る
  if (decision !== 'modified') return { ...base, aiEvaluatedAt: text(form, 'aiEvaluatedAt') };
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

/**
 * データの揃い具合・回答の状況を出した要求事項の一覧の列（URL の cols）。
 * 対応状況の画面にあったギャップ分析表（要求事項と同じ母集団の 2 つ目の表）を一覧へ寄せたため、
 * 対応状況の件数からはこの列の組で一覧を開く（plan T8。列は「列 ▾」でいつでも出し入れできる）
 */
export const CSRD_REQUIREMENT_DATA_COLS =
  'applicability,combined,review,required,availability,metrics,current,response';

/** データ・回答・必須での絞り込み（?data=&answer=&required=1）。サービスの絞り込みに無い、画面の表示用の条件 */
export interface RequirementDataFilters {
  data: string[];
  answer: string[];
  required: boolean;
}

/** 1 要求事項のデータ・回答の事実（ギャップ分析と同じ数え方。answered は回答本文のある未着手以外） */
export interface RequirementDataFacts {
  dataCoverage: DataCoverage;
  answered: boolean;
  required: boolean;
}

export function parseRequirementDataQuery(query: SearchParams): RequirementDataFilters {
  const required = query.required;
  return {
    data: toList(query.data),
    answer: toList(query.answer),
    required: required === '1' || (Array.isArray(required) && required.includes('1')),
  };
}

/** 条件に合うか。事実が無い（ギャップ分析の行が無い）要求事項は、条件があれば外す */
export function matchesRequirementData(
  facts: RequirementDataFacts | undefined,
  filters: RequirementDataFilters,
): boolean {
  const active = filters.data.length > 0 || filters.answer.length > 0 || filters.required;
  if (!active) return true;
  if (!facts) return false;
  if (filters.data.length > 0 && !filters.data.includes(facts.dataCoverage)) return false;
  if (
    filters.answer.length > 0 &&
    !filters.answer.includes(facts.answered ? 'answered' : 'not_answered')
  ) {
    return false;
  }
  if (filters.required && !facts.required) return false;
  return true;
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
