import type {
  BlockStatus,
  DataPointStatus,
  IssueStatus,
  JobStatus,
  PbcStatus,
  PermissionKey,
  ResponseStatus,
  SignoffStage,
  TestStatus,
} from '@/types/domain';
import { MAX_SECONDARY_ACTIONS, type ConfirmTier } from './actions';
import { statusLabel } from './status/registry';

/**
 * 状態で変わる操作（docs/ui-redesign/plan.md §1.15）。
 *
 * 主な対象（データ・回答・原稿・取込・PBC・調書・Sign-off・指摘）について、
 * 「いまの状態 × 利用者の権限」から primary 1 つ・secondary 2 つまで・その他 を決める純関数。
 * 画面（Stage B）はこの結果を `PageActions`・`RowActions` の ActionSpec に写すだけにし、
 * 同じ状態で画面ごとに主操作が食い違わないようにする。
 *
 * ここで返すのは「見せる操作」だけで、実行の可否の最終判断はサーバー（assertCan・状態遷移の検査・RLS）が行う。
 * 権限の条件はサーバーの検査と同じものを書く（画面に出したのに押すと権限エラー、を作らない）。
 * ラベルの「…」は、押すと入力（理由など）を求めるダイアログが開くことを表す（plan §1.15 の表記どおり）。
 */

export type Can = (permission: PermissionKey) => boolean;

export interface StateAction<Id extends string = string> {
  id: Id;
  label: string;
  /** 見せるが押せない理由（色ではなく文で伝える。ActionSpec の disabledReason へ写す） */
  disabledReason?: string;
  /** 確認の区分（plan §1.16）。無ければ確認なしで実行する */
  confirm?: ConfirmTier;
  /** 理由の入力が必須（差戻し） */
  reasonRequired?: true;
}

export interface StateActionPlan<Id extends string = string> {
  primary: StateAction<Id> | null;
  /** 2 つまで（MAX_SECONDARY_ACTIONS） */
  secondary: StateAction<Id>[];
  /** 「その他」・行の操作のメニューへ入れるもの */
  more: StateAction<Id>[];
}

function plan<Id extends string>(
  primary: StateAction<Id> | null,
  secondary: Array<StateAction<Id> | null | false> = [],
  more: Array<StateAction<Id> | null | false> = [],
): StateActionPlan<Id> {
  const second = secondary.filter((a): a is StateAction<Id> => Boolean(a));
  const rest = more.filter((a): a is StateAction<Id> => Boolean(a));
  // secondary が 3 つ以上になったら、溢れた分を「その他」の先頭へ（splitPageActions と同じ規則）
  return {
    primary,
    secondary: second.slice(0, MAX_SECONDARY_ACTIONS),
    more: [...second.slice(MAX_SECONDARY_ACTIONS), ...rest],
  };
}

const NONE = <Id extends string>(): StateActionPlan<Id> => plan<Id>(null);

// ----------------------------------------------------------------------
// データ（DataPointStatus）
// ----------------------------------------------------------------------

export type DataPointActionId =
  | 'save'
  | 'submit'
  | 'start-review'
  | 'return'
  | 'approve'
  | 'approve-stage'
  | 'edit-approved'
  | 'ai-explain'
  | 'ai-evidence';

export interface DataPointStateInput {
  status: DataPointStatus;
  can: Can;
  /** 入力欄の値が保存済みか（未保存の変更があれば false） */
  valueSaved: boolean;
  /** 値が入っているか（空のままの提出を防ぐ） */
  hasValue: boolean;
  /**
   * 承認経路がある組織で、いまの段階の名前（例: 「部長承認」）。経路が無ければ null・省略。
   * 経路があるときは見出しの一発承認を出さず、承認フロー節の現段階の承認を primary にする（plan §6 B1）
   */
  approvalStageLabel?: string | null;
}

/** 値が無いと提出できない理由（plan §1.15 データ行） */
export const SUBMIT_WITHOUT_VALUE_REASON = '値を入力して保存してから提出してください。';

export function dataPointStateActions(
  input: DataPointStateInput,
): StateActionPlan<DataPointActionId> {
  const { status, can } = input;
  const canReview = can('enterprise.data.review');
  const canApprove = can('enterprise.data.approve');
  const aiMore: Array<StateAction<DataPointActionId> | false> = can('enterprise.ai.run')
    ? [
        { id: 'ai-explain', label: 'AI に原因を説明させる' },
        { id: 'ai-evidence', label: 'AI に資料候補を探させる' },
      ]
    : [];
  const returnAction: StateAction<DataPointActionId> | false = canReview && {
    id: 'return',
    label: '差戻し…',
    confirm: 'bulk',
    reasonRequired: true,
  };

  switch (status) {
    case 'not_started':
    case 'draft':
    case 'returned': {
      if (!can('enterprise.data.write')) return plan(null, [], aiMore);
      // 未着手は保存して初めて入力中になる（not_started → submitted の遷移は無い）
      if (!input.valueSaved || status === 'not_started') {
        return plan({ id: 'save', label: '保存' }, [], aiMore);
      }
      return plan(
        {
          id: 'submit',
          label: '提出',
          ...(input.hasValue ? {} : { disabledReason: SUBMIT_WITHOUT_VALUE_REASON }),
        },
        [],
        aiMore,
      );
    }
    case 'submitted':
      return plan(
        canReview ? { id: 'start-review', label: 'レビュー開始' } : null,
        [returnAction],
        aiMore,
      );
    case 'in_review': {
      const approve: StateAction<DataPointActionId> | null = !canApprove
        ? null
        : input.approvalStageLabel
          ? { id: 'approve-stage', label: `「${input.approvalStageLabel}」を承認` }
          : { id: 'approve', label: '承認' };
      return plan(approve, [returnAction], aiMore);
    }
    case 'approved':
      return plan(
        null,
        [],
        [(canReview || canApprove) && { id: 'edit-approved', label: '承認済みの値を修正' }],
      );
    default:
      return NONE();
  }
}

// ----------------------------------------------------------------------
// 回答（ResponseStatus）: CDP・CSRD などの質問への回答
// ----------------------------------------------------------------------

export type ResponseActionId =
  'save-draft' | 'request-review' | 'generate-ai-draft' | 'reject-ai-draft' | 'approve' | 'return';

export interface ResponseStateInput {
  status: ResponseStatus;
  can: Can;
  /** 回答の版が 1 つ以上ある（無ければレビュー依頼・承認はできない） */
  hasResponse: boolean;
  /** 現在の版が AI の生成したまま（承認できない。CLAUDE.md §0-4） */
  isAiDraft?: boolean;
  /** 採否の決まっていない AI 下書きがある（「不採用にする」を出す） */
  hasPendingAiDraft?: boolean;
  /**
   * 利用者が回答の現在の版を作った人（職務分離。トライアル対応 NF-39 C-07）。
   * 作った人には下書きの承認を出さず、レビュー中の承認は理由付きで押せなくする
   */
  isCurrentVersionAuthor?: boolean;
}

/** サーバーの検査（disclosure-write.ts transitionDisclosureResponse）と同じ文 */
export const AI_DRAFT_APPROVAL_REASON =
  'AI が生成したままの回答は承認できません。内容を確認し、編集して保存してから承認してください。';

/** サーバーの検査（disclosure-write.ts transitionDisclosureResponse・DB トリガ 0057）と同じ意味の文 */
export const RESPONSE_AUTHOR_APPROVAL_REASON =
  '回答の現在の版を作成した人は承認できません。別の承認者に承認を依頼してください。';

export function responseStateActions(input: ResponseStateInput): StateActionPlan<ResponseActionId> {
  const { status, can, hasResponse } = input;
  const canWrite = can('enterprise.disclosure.write');
  const canApprove = can('enterprise.disclosure.approve');
  const isAuthor = Boolean(input.isCurrentVersionAuthor);
  const approve: StateAction<ResponseActionId> = {
    id: 'approve',
    label: '承認',
    ...(input.isAiDraft
      ? { disabledReason: AI_DRAFT_APPROVAL_REASON }
      : isAuthor
        ? { disabledReason: RESPONSE_AUTHOR_APPROVAL_REASON }
        : {}),
  };
  const aiMore: Array<StateAction<ResponseActionId> | false> = can('enterprise.ai.run')
    ? [
        { id: 'generate-ai-draft', label: 'ドラフトを生成（AI）' },
        Boolean(input.hasPendingAiDraft) && {
          id: 'reject-ai-draft',
          label: 'この下書きを不採用にする',
          confirm: 'irreversible',
        },
      ]
    : [];

  switch (status) {
    case 'not_started':
    case 'draft':
    case 'returned':
      return plan(
        canWrite ? { id: 'save-draft', label: '保存（下書き）' } : null,
        [
          canWrite &&
            hasResponse &&
            status === 'draft' && { id: 'request-review', label: 'レビュー依頼' },
        ],
        // 下書きのまま承認する経路は「その他」へ置く（plan §6 B2）。現在の版を作った人には出さない
        // （作成者が自分の下書きを承認する経路を外した。職務分離 NF-39 C-07。CSRD の回答も同じ）
        [...aiMore, canApprove && hasResponse && status === 'draft' && !isAuthor && approve],
      );
    case 'in_review':
      return plan(
        canApprove && hasResponse ? approve : null,
        // 差戻しはサーバーで disclosure.write を求める
        [canWrite && { id: 'return', label: '差戻し…', confirm: 'bulk', reasonRequired: true }],
        aiMore,
      );
    case 'approved':
    default:
      return NONE();
  }
}

// ----------------------------------------------------------------------
// 原稿（BlockStatus・レビュー）
// ----------------------------------------------------------------------

export type BlockActionId =
  | 'request-review'
  | 'save-version'
  | 'ai-draft'
  | 'complete-review'
  | 'return'
  | 'comment'
  | 'final-approve';

export interface BlockStateInput {
  status: BlockStatus;
  can: Can;
  /** 自分がこの原稿のレビュアーに指名されている */
  isAssignedReviewer: boolean;
  /**
   * 完了・承認を止めている理由（未解決の要対応コメントなど。サーバーの ReviewBlockedError と同じ文）。
   * あれば primary を押せない理由として出す
   */
  blockedReason?: string | null;
}

export function blockStateActions(input: BlockStateInput): StateActionPlan<BlockActionId> {
  const { status, can } = input;
  const blocked = input.blockedReason ? { disabledReason: input.blockedReason } : {};
  const giveBack: StateAction<BlockActionId> = {
    id: 'return',
    label: '差し戻す…',
    confirm: 'bulk',
    reasonRequired: true,
  };

  switch (status) {
    case 'draft':
    case 'returned':
      if (!can('enterprise.disclosure.write')) return NONE();
      return plan(
        { id: 'request-review', label: 'レビュー依頼' },
        [{ id: 'save-version', label: '版として保存' }],
        [can('enterprise.ai.run') && { id: 'ai-draft', label: 'AI 下書き' }],
      );
    case 'review_requested':
      if (!input.isAssignedReviewer) return NONE();
      return plan(
        { id: 'complete-review', label: 'レビューを完了する', ...blocked },
        [giveBack],
        [{ id: 'comment', label: 'コメント' }],
      );
    case 'approval_pending':
      if (!can('enterprise.disclosure.approve')) return NONE();
      return plan(
        {
          id: 'final-approve',
          label: '最終承認する（社内承認）',
          confirm: 'irreversible',
          ...blocked,
        },
        [giveBack],
      );
    case 'approved':
    default:
      return NONE();
  }
}

// ----------------------------------------------------------------------
// 取込ジョブ（JobStatus）: 行の操作と、確認画面の primary
// ----------------------------------------------------------------------

export type ImportJobActionId = 'progress' | 'review' | 'result' | 'errors' | 'confirm-selected';

export function importJobRowAction(status: JobStatus, can: Can): StateAction<ImportJobActionId> {
  switch (status) {
    case 'queued':
    case 'processing':
      return { id: 'progress', label: '進捗を見る' };
    case 'needs_review':
      // 確定は取込の権限が要る。無い利用者には中身を見るだけの行き先にする
      return can('enterprise.import.run')
        ? { id: 'review', label: '確認して確定' }
        : { id: 'result', label: '結果を見る' };
    case 'failed':
      return { id: 'errors', label: 'エラーを見る' };
    case 'completed':
    case 'cancelled':
    default:
      return { id: 'result', label: '結果を見る' };
  }
}

/** 取込の確認画面（needs_review）の primary */
export function importReviewScreenActions(
  status: JobStatus,
  can: Can,
): StateActionPlan<ImportJobActionId> {
  if (status !== 'needs_review' || !can('enterprise.import.run')) return NONE();
  return plan({ id: 'confirm-selected', label: '選択した行を確定' });
}

// ----------------------------------------------------------------------
// PBC（資料依頼）
// ----------------------------------------------------------------------

export type PbcActionId = 'accept' | 'reject' | 'respond';

/** 監査法人側の行: 回答済み（提出済み・確認中）なら「受理」と「差戻し…」 */
export function pbcFirmRowActions(status: PbcStatus, can: Can): StateActionPlan<PbcActionId> {
  if (!can('assurance.pbc.manage')) return NONE();
  if (status !== 'submitted' && status !== 'under_review') return NONE();
  return plan({ id: 'accept', label: '受理' }, [
    { id: 'reject', label: '差戻し…', confirm: 'bulk', reasonRequired: true },
  ]);
}

/**
 * 企業側の行: 依頼中・差戻しなら、行を展開して「回答を提出」（行内の唯一のボタン。secondary の見た目）。
 * 行の主役は回答のフォームそのものなので primary は持たない
 */
export function pbcClientRowActions(status: PbcStatus, can: Can): StateActionPlan<PbcActionId> {
  if (!can('enterprise.pbc.respond')) return NONE();
  const open: readonly PbcStatus[] = ['sent', 'acknowledged', 'overdue', 'rejected'];
  if (!open.includes(status)) return NONE();
  return plan(null, [{ id: 'respond', label: '回答を提出' }]);
}

// ----------------------------------------------------------------------
// 調書（TestStatus）
// ----------------------------------------------------------------------

export type TestActionId = 'prepare' | 'save' | 'ai-summary' | 'review';

export interface TestStateInput {
  status: TestStatus;
  can: Can;
  /** 自分が作成（Prepared）した調書か（自己レビュー禁止） */
  preparedByMe: boolean;
}

/** サーバーの検査（assurance/actions.ts updateTestAction）と同じ趣旨の文 */
export const SELF_REVIEW_REASON =
  '自己レビューはできません（自身が作成した調書は他の人がレビューします）。';

export function testStateActions(input: TestStateInput): StateActionPlan<TestActionId> {
  const { status, can } = input;
  if (!can('assurance.testing.write')) return NONE();
  switch (status) {
    case 'not_started':
    case 'in_progress':
    case 'exception':
      return plan(
        { id: 'prepare', label: '作成完了として記録' },
        [{ id: 'save', label: '保存' }],
        [can('assurance.ai.run') && { id: 'ai-summary', label: 'AI に要約させる' }],
      );
    case 'prepared':
      return plan({
        id: 'review',
        label: 'レビュー完了として記録',
        ...(input.preparedByMe ? { disabledReason: SELF_REVIEW_REASON } : {}),
      });
    case 'reviewed':
    default:
      return NONE();
  }
}

// ----------------------------------------------------------------------
// Sign-off（段階）
// ----------------------------------------------------------------------

export type SignoffActionId = 'signoff';

const SIGNOFF_PERMISSION: Record<SignoffStage, PermissionKey> = {
  prepared: 'assurance.signoff.prepared',
  reviewed: 'assurance.signoff.reviewed',
  partner_approved: 'assurance.signoff.partner',
};

export interface SignoffStateInput {
  stage: SignoffStage;
  can: Can;
  /**
   * その段階を止めている理由（前段が未了・本人が前段を行っている〔代理禁止〕・未解決の指摘など。
   * サーバーの evaluateSignoffBlockers の文をそのまま渡す）
   */
  blockers: readonly string[];
}

export function signoffStateActions(input: SignoffStateInput): StateActionPlan<SignoffActionId> {
  if (!input.can(SIGNOFF_PERMISSION[input.stage])) return NONE();
  const reason = input.blockers.length > 0 ? input.blockers.join(' / ') : undefined;
  return plan({
    id: 'signoff',
    label: `${statusLabel('signoff', input.stage)} として Sign-off`,
    confirm: 'irreversible',
    ...(reason ? { disabledReason: reason } : {}),
  });
}

// ----------------------------------------------------------------------
// 指摘（IssueStatus）
// ----------------------------------------------------------------------

export type IssueActionId = 'resolve';

/** 未解決の行に「解消として記録」（secondary の見た目。解消内容の入力が要る） */
export function issueRowActions(status: IssueStatus, can: Can): StateActionPlan<IssueActionId> {
  if (!can('assurance.issue.manage')) return NONE();
  if (status !== 'open' && status !== 'management_response') return NONE();
  return plan(null, [{ id: 'resolve', label: '解消として記録' }]);
}
