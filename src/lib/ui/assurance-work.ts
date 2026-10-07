import type { AssuranceHomeProfile } from '@/lib/ui/home-profile';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import type { IsoDate, SignoffStage } from '@/types/domain';

/**
 * 監査法人の「自分が次に行う作業」と「要対応」（plan §1.3 監査法人・§1.14・S13・S22）。React 非依存。
 *
 * 案件ホームと案件の概要が同じ定義を使う（同じ事実を画面ごとに別の数え方で出さない）。
 * 役割（AssuranceHomeProfile）で並びと中身を変える:
 *  - 契約責任者: Sign-off の抑止条件と期限 → 未クリアのレビューNote
 *  - マネージャー: 未受領の資料依頼 → レビュー待ちの調書 → Snapshot 後の変更
 *  - 担当者: 手続が未完了のサンプル → 回答済みの資料依頼
 *  - 専門家: 手続が未完了の調書
 *  - 法人管理者・閲覧: 作業なし（案件の中身を出さない）
 * 行き先は各画面の絞り込み（filter）付き。承認・Sign-off はここから実行しない（開いた画面で人が押す）。
 */

export interface EngagementWorkCounts {
  engagementId: string;
  code: string;
  clientName: string;
  deadlineDate: IsoDate;
  /** 期限までの日数（超過は負） */
  daysUntilDeadline: number | null;
  /** 未完了の資料依頼（下書き・受理・クローズ以外。案件ホームの KPI と同じ数え方） */
  pbcOpen: number;
  /** 送付済みで企業の回答を待っている資料依頼（期限超過を含む） */
  pbcOutstanding: number;
  /** 企業が回答済みで、受理・差戻しの判断待ちの資料依頼 */
  pbcAnswered: number;
  /** 未着手・実施中の調書 */
  testsPending: number;
  /** 作成済みでレビュー待ちの調書 */
  reviewPending: number;
  openHighIssues: number;
  /** Snapshot 固定後の変更（影響評価が未記録のもの） */
  changesSinceSnapshot: number;
  /** クリアされていないレビューNote（取得していない画面は null） */
  openReviewNotes: number | null;
  signoffStages: readonly SignoffStage[];
  /** 最終 Sign-off（契約責任者承認）を止めている条件の数（取得していない画面は null） */
  signoffBlockers: number | null;
}

export interface AssuranceWorkItem {
  key: string;
  verb: string;
  target: string;
  context: string;
  count: number;
  dueDate: IsoDate | null;
  daysUntilDue: number | null;
  reason: string | null;
  href: string;
  ctaLabel: string;
}

export interface AssuranceAttentionItem {
  key: string;
  label: string;
  count: number;
  href: string;
  semantic: StatusSemantic;
}

/** 期限が近いとみなす日数（要対応に出す） */
export const DEADLINE_ATTENTION_DAYS = 14;

export function engagementBase(engagementId: string): string {
  return `/assurance/engagements/${engagementId}`;
}

type Builder = (row: EngagementWorkCounts) => AssuranceWorkItem | null;

function item(
  row: EngagementWorkCounts,
  input: Omit<AssuranceWorkItem, 'key' | 'target' | 'context' | 'dueDate' | 'daysUntilDue'> & {
    kind: string;
  },
): AssuranceWorkItem {
  const { kind, ...rest } = input;
  return {
    key: `${row.engagementId}:${kind}`,
    target: row.code,
    context: row.clientName,
    dueDate: row.deadlineDate,
    daysUntilDue: row.daysUntilDeadline,
    ...rest,
  };
}

const BUILDERS: Record<string, Builder> = {
  signoff: (row) => {
    if (row.signoffStages.includes('partner_approved')) return null;
    const blockers = row.signoffBlockers ?? 0;
    return item(row, {
      kind: 'signoff',
      verb: 'Sign-off を確認する',
      count: Math.max(blockers, 1),
      reason: blockers > 0 ? `抑止条件 ${blockers} 件` : '抑止条件なし（実行できます）',
      href: `${engagementBase(row.engagementId)}/signoffs`,
      ctaLabel: 'Sign-off を開く',
    });
  },
  reviewNotes: (row) =>
    row.openReviewNotes && row.openReviewNotes > 0
      ? item(row, {
          kind: 'review-notes',
          verb: 'レビューNote を確認する',
          count: row.openReviewNotes,
          reason: `未クリア ${row.openReviewNotes} 件`,
          href: `${engagementBase(row.engagementId)}/review-notes?filter=open`,
          ctaLabel: 'レビューNote を開く',
        })
      : null,
  pbcOutstanding: (row) =>
    row.pbcOutstanding > 0
      ? item(row, {
          kind: 'pbc-outstanding',
          verb: '未受領の資料依頼を確認する',
          count: row.pbcOutstanding,
          reason: `企業の回答待ち ${row.pbcOutstanding} 件`,
          href: `${engagementBase(row.engagementId)}/requests?filter=sent`,
          ctaLabel: '資料依頼を開く',
        })
      : null,
  reviewPending: (row) =>
    row.reviewPending > 0
      ? item(row, {
          kind: 'review-pending',
          verb: '調書をレビューする',
          count: row.reviewPending,
          reason: `作成済み・レビュー待ち ${row.reviewPending} 件`,
          href: `${engagementBase(row.engagementId)}/testing`,
          ctaLabel: '調書を開く',
        })
      : null,
  changes: (row) =>
    row.changesSinceSnapshot > 0
      ? item(row, {
          kind: 'changes',
          verb: 'Snapshot 後の変更を評価する',
          count: row.changesSinceSnapshot,
          reason: `固定後の変更 ${row.changesSinceSnapshot} 件`,
          href: `${engagementBase(row.engagementId)}/data-room`,
          ctaLabel: 'Data Room を開く',
        })
      : null,
  testsPending: (row) =>
    row.testsPending > 0
      ? item(row, {
          kind: 'tests-pending',
          verb: '手続を進める',
          count: row.testsPending,
          reason: `未着手・実施中の調書 ${row.testsPending} 件`,
          href: `${engagementBase(row.engagementId)}/testing`,
          ctaLabel: '調書を開く',
        })
      : null,
  pbcAnswered: (row) =>
    row.pbcAnswered > 0
      ? item(row, {
          kind: 'pbc-answered',
          verb: '回答済みの資料依頼を処理する',
          count: row.pbcAnswered,
          reason: `受理・差戻しの判断待ち ${row.pbcAnswered} 件`,
          href: `${engagementBase(row.engagementId)}/requests?filter=submitted`,
          ctaLabel: '資料依頼を開く',
        })
      : null,
};

/** 役割ごとの並び（plan §1.3 監査法人の行） */
export const ASSURANCE_WORK_ORDER: Record<AssuranceHomeProfile, readonly string[]> = {
  partner: ['signoff', 'reviewNotes', 'changes'],
  manager: ['pbcOutstanding', 'reviewPending', 'changes', 'pbcAnswered'],
  staff: ['testsPending', 'pbcAnswered'],
  specialist: ['testsPending'],
  firm_admin: [],
  viewer: [],
};

/** 自分が次に行う作業（役割の並び → 案件の期限が近い順） */
export function assuranceWorkItems(
  profile: AssuranceHomeProfile,
  rows: readonly EngagementWorkCounts[],
): AssuranceWorkItem[] {
  const out: AssuranceWorkItem[] = [];
  for (const kind of ASSURANCE_WORK_ORDER[profile]) {
    const builder = BUILDERS[kind];
    if (!builder) continue;
    const forKind = rows
      .map((row) => builder(row))
      .filter((value): value is AssuranceWorkItem => value !== null)
      .sort(
        (a, b) =>
          (a.daysUntilDue ?? Number.POSITIVE_INFINITY) -
          (b.daysUntilDue ?? Number.POSITIVE_INFINITY),
      );
    out.push(...forKind);
  }
  return out;
}

/**
 * 要対応（放置すると Sign-off を止める事実）。0 件は出さない。
 * 1 案件だけが該当するときはその案件の画面へ、複数なら案件ホームの絞り込みへ（hrefForMany）
 */
export function assuranceAttention(
  rows: readonly EngagementWorkCounts[],
  hrefForMany: (focus: AssuranceFocus) => string,
): AssuranceAttentionItem[] {
  const pick = (
    focus: AssuranceFocus,
    label: string,
    semantic: StatusSemantic,
    count: (row: EngagementWorkCounts) => number,
    single: (row: EngagementWorkCounts) => string,
  ): AssuranceAttentionItem => {
    const hits = rows.filter((row) => count(row) > 0);
    const total = hits.reduce((sum, row) => sum + count(row), 0);
    const href = hits.length === 1 ? single(hits[0]!) : hrefForMany(focus);
    return { key: focus, label, count: total, href, semantic };
  };
  return [
    pick(
      'high_issues',
      '未解決の重要度「高」の指摘',
      'error',
      (row) => row.openHighIssues,
      (row) => `${engagementBase(row.engagementId)}/issues?filter=high`,
    ),
    pick(
      'changes',
      'Snapshot 後の変更',
      'blocked',
      (row) => row.changesSinceSnapshot,
      (row) => `${engagementBase(row.engagementId)}/data-room`,
    ),
    pick(
      'deadline',
      `期限まで ${DEADLINE_ATTENTION_DAYS} 日以内・超過の案件`,
      'pending',
      (row) =>
        row.daysUntilDeadline !== null &&
        row.daysUntilDeadline <= DEADLINE_ATTENTION_DAYS &&
        !row.signoffStages.includes('partner_approved')
          ? 1
          : 0,
      (row) => `${engagementBase(row.engagementId)}/overview`,
    ),
  ].filter((entry) => entry.count > 0);
}

/** 案件ホームの絞り込み（KPI・要対応から案件の表を絞る） */
export const ASSURANCE_FOCUS = [
  'active',
  'pbc',
  'tests',
  'review',
  'high_issues',
  'changes',
  'deadline',
] as const;
export type AssuranceFocus = (typeof ASSURANCE_FOCUS)[number];

export const ASSURANCE_FOCUS_LABEL: Record<AssuranceFocus, string> = {
  active: '進行中の案件',
  pbc: '未完了の資料依頼がある案件',
  tests: '手続が未完了の案件',
  review: 'レビュー待ちの調書がある案件',
  high_issues: '重要度「高」の指摘がある案件',
  changes: 'Snapshot 後の変更がある案件',
  deadline: '期限が近い案件（60 日以内）',
};

export function parseAssuranceFocus(value: unknown): AssuranceFocus | null {
  return typeof value === 'string' && (ASSURANCE_FOCUS as readonly string[]).includes(value)
    ? (value as AssuranceFocus)
    : null;
}

/** 案件ホームの KPI と同じ条件で、該当する件数を持つ案件の行に絞る */
export function matchesAssuranceFocus(
  focus: AssuranceFocus,
  row: EngagementWorkCounts & { completed: boolean },
): boolean {
  switch (focus) {
    case 'active':
      return !row.completed;
    case 'pbc':
      return row.pbcOpen > 0;
    case 'tests':
      return row.testsPending > 0;
    case 'review':
      return row.reviewPending > 0;
    case 'high_issues':
      return row.openHighIssues > 0;
    case 'changes':
      return row.changesSinceSnapshot > 0;
    case 'deadline':
      return row.daysUntilDeadline !== null && row.daysUntilDeadline <= 60;
  }
}
