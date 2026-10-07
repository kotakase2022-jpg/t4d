import { describe, expect, it } from 'vitest';
import { permissionsFor } from '@/lib/authorization/can';
import { MAX_SECONDARY_ACTIONS } from '@/lib/ui/actions';
import {
  AI_DRAFT_APPROVAL_REASON,
  SELF_REVIEW_REASON,
  SUBMIT_WITHOUT_VALUE_REASON,
  blockStateActions,
  dataPointStateActions,
  importJobRowAction,
  importReviewScreenActions,
  issueRowActions,
  pbcClientRowActions,
  pbcFirmRowActions,
  responseStateActions,
  signoffStateActions,
  testStateActions,
  type Can,
  type StateActionPlan,
} from '@/lib/ui/state-actions';
import {
  BLOCK_STATUSES,
  DATA_POINT_STATUSES,
  JOB_STATUSES,
  PBC_STATUSES,
  RESPONSE_STATUSES,
  SIGNOFF_STAGES,
  TEST_STATUSES,
  type RoleKey,
} from '@/types/domain';

/**
 * 状態で変わる操作（plan §1.15）。状態 × 権限 → primary 1・secondary ≤2・その他。
 * 権限の条件はサーバーの検査と同じ（出したのに押すと権限エラー、を作らない）。
 */

const canOf = (...roles: RoleKey[]): Can => {
  const set = permissionsFor(roles);
  return (permission) => set.has(permission);
};
const none: Can = () => false;
const all: Can = () => true;

const ids = (p: StateActionPlan) => ({
  primary: p.primary?.id ?? null,
  secondary: p.secondary.map((a) => a.id),
  more: p.more.map((a) => a.id),
});

describe('共通の約束', () => {
  it('どの状態・権限でも primary は 1 つ以下、secondary は 2 つ以下、ラベルは空でない', () => {
    const plans: StateActionPlan[] = [
      ...DATA_POINT_STATUSES.flatMap((status) =>
        [true, false].map((valueSaved) =>
          dataPointStateActions({ status, can: all, valueSaved, hasValue: true }),
        ),
      ),
      ...RESPONSE_STATUSES.map((status) =>
        responseStateActions({ status, can: all, hasResponse: true, hasPendingAiDraft: true }),
      ),
      ...BLOCK_STATUSES.map((status) =>
        blockStateActions({ status, can: all, isAssignedReviewer: true }),
      ),
      ...JOB_STATUSES.map((status) => importReviewScreenActions(status, all)),
      ...PBC_STATUSES.flatMap((status) => [
        pbcFirmRowActions(status, all),
        pbcClientRowActions(status, all),
      ]),
      ...TEST_STATUSES.map((status) => testStateActions({ status, can: all, preparedByMe: false })),
      ...SIGNOFF_STAGES.map((stage) => signoffStateActions({ stage, can: all, blockers: [] })),
    ];
    for (const p of plans) {
      expect(p.secondary.length).toBeLessThanOrEqual(MAX_SECONDARY_ACTIONS);
      for (const action of [p.primary, ...p.secondary, ...p.more]) {
        if (action) expect(action.label.trim()).not.toBe('');
      }
    }
  });

  it('権限が無ければ何も出さない（閲覧者に押せない操作を並べない）', () => {
    for (const status of DATA_POINT_STATUSES) {
      expect(
        ids(dataPointStateActions({ status, can: none, valueSaved: true, hasValue: true })),
      ).toEqual({ primary: null, secondary: [], more: [] });
    }
    for (const status of TEST_STATUSES) {
      expect(testStateActions({ status, can: none, preparedByMe: false }).primary).toBeNull();
    }
  });
});

describe('データ', () => {
  const preparer = canOf('sustainability_manager');

  it('入力中: 未保存なら「保存」、保存済みなら「提出」。値が無ければ提出は理由つきで押せない', () => {
    expect(
      dataPointStateActions({ status: 'draft', can: preparer, valueSaved: false, hasValue: true })
        .primary,
    ).toMatchObject({ id: 'save', label: '保存' });
    expect(
      dataPointStateActions({ status: 'draft', can: preparer, valueSaved: true, hasValue: true })
        .primary,
    ).toEqual({ id: 'submit', label: '提出' });
    expect(
      dataPointStateActions({
        status: 'returned',
        can: preparer,
        valueSaved: true,
        hasValue: false,
      }).primary,
    ).toEqual({ id: 'submit', label: '提出', disabledReason: SUBMIT_WITHOUT_VALUE_REASON });
  });

  it('未着手は保存して初めて提出できる（not_started → submitted の遷移は無い）', () => {
    expect(
      dataPointStateActions({
        status: 'not_started',
        can: preparer,
        valueSaved: true,
        hasValue: true,
      }).primary?.id,
    ).toBe('save');
  });

  it('提出済み＋レビュー: 「レビュー開始」と、理由必須の「差戻し…」', () => {
    const p = dataPointStateActions({
      status: 'submitted',
      can: canOf('reviewer'),
      valueSaved: true,
      hasValue: true,
    });
    expect(p.primary).toMatchObject({ id: 'start-review', label: 'レビュー開始' });
    expect(p.secondary).toEqual([
      { id: 'return', label: '差戻し…', confirm: 'bulk', reasonRequired: true },
    ]);
  });

  it('レビュー中＋承認: 経路が無ければ「承認」、あれば現段階の「「段階名」を承認」', () => {
    const can = canOf('approver', 'reviewer');
    expect(
      dataPointStateActions({ status: 'in_review', can, valueSaved: true, hasValue: true }).primary,
    ).toMatchObject({ id: 'approve', label: '承認' });
    expect(
      dataPointStateActions({
        status: 'in_review',
        can,
        valueSaved: true,
        hasValue: true,
        approvalStageLabel: '部長承認',
      }).primary,
    ).toMatchObject({ id: 'approve-stage', label: '「部長承認」を承認' });
  });

  it('承認済み: primary なし。修正は review・approve のときだけ「その他」に', () => {
    const reviewer = dataPointStateActions({
      status: 'approved',
      can: canOf('reviewer'),
      valueSaved: true,
      hasValue: true,
    });
    expect(ids(reviewer)).toEqual({ primary: null, secondary: [], more: ['edit-approved'] });
    const site = dataPointStateActions({
      status: 'approved',
      can: canOf('site_contributor'),
      valueSaved: true,
      hasValue: true,
    });
    expect(ids(site)).toEqual({ primary: null, secondary: [], more: [] });
  });

  it('AI の操作は ai.run のときだけ「その他」に（primary にしない）', () => {
    const withAi = dataPointStateActions({
      status: 'draft',
      can: all,
      valueSaved: true,
      hasValue: true,
    });
    expect(withAi.more.map((a) => a.id)).toEqual(['ai-explain', 'ai-evidence']);
    expect(withAi.primary?.id).toBe('submit');
  });
});

describe('回答', () => {
  it('下書き: 「保存（下書き）」と「レビュー依頼」。承認を兼ねる人の承認は「その他」へ', () => {
    const p = responseStateActions({ status: 'draft', can: all, hasResponse: true });
    expect(ids(p)).toEqual({
      primary: 'save-draft',
      secondary: ['request-review'],
      more: ['generate-ai-draft', 'approve'],
    });
  });

  it('レビュー中＋承認: 「承認」。AI が生成したままなら理由つきで押せない（AI は確定しない）', () => {
    const p = responseStateActions({
      status: 'in_review',
      can: all,
      hasResponse: true,
      isAiDraft: true,
    });
    expect(p.primary).toEqual({
      id: 'approve',
      label: '承認',
      disabledReason: AI_DRAFT_APPROVAL_REASON,
    });
    expect(p.secondary.map((a) => a.id)).toEqual(['return']);
  });

  it('採否の決まっていない AI 下書きがあれば「この下書きを不採用にする」を確認つきで出す', () => {
    const p = responseStateActions({
      status: 'draft',
      can: all,
      hasResponse: true,
      hasPendingAiDraft: true,
    });
    expect(p.more.find((a) => a.id === 'reject-ai-draft')).toMatchObject({
      label: 'この下書きを不採用にする',
      confirm: 'irreversible',
    });
  });
});

describe('原稿', () => {
  it('作成中＋write: 「レビュー依頼」「版として保存」、AI 下書きは「その他」', () => {
    expect(
      ids(blockStateActions({ status: 'draft', can: all, isAssignedReviewer: false })),
    ).toEqual({ primary: 'request-review', secondary: ['save-version'], more: ['ai-draft'] });
  });

  it('レビュー中: 指名レビュアーだけに「レビューを完了する」。止める理由があれば押せない', () => {
    expect(
      blockStateActions({ status: 'review_requested', can: all, isAssignedReviewer: false })
        .primary,
    ).toBeNull();
    const p = blockStateActions({
      status: 'review_requested',
      can: all,
      isAssignedReviewer: true,
      blockedReason: '未解決の要対応コメントが 1 件あります。',
    });
    expect(p.primary).toMatchObject({
      id: 'complete-review',
      disabledReason: '未解決の要対応コメントが 1 件あります。',
    });
    expect(p.secondary[0]).toMatchObject({
      id: 'return',
      label: '差し戻す…',
      reasonRequired: true,
    });
  });

  it('最終承認待ち＋approve: 確認ダイアログつきの「最終承認する（社内承認）」', () => {
    expect(
      blockStateActions({
        status: 'approval_pending',
        can: canOf('approver'),
        isAssignedReviewer: false,
      }).primary,
    ).toMatchObject({
      id: 'final-approve',
      label: '最終承認する（社内承認）',
      confirm: 'irreversible',
    });
  });
});

describe('取込ジョブ', () => {
  it('状態ごとの行の操作（確定は取込の権限があるときだけ）', () => {
    const preparer = canOf('sustainability_manager');
    expect(JOB_STATUSES.map((s) => importJobRowAction(s, preparer).label)).toEqual([
      '進捗を見る',
      '進捗を見る',
      '確認して確定',
      '結果を見る',
      'エラーを見る',
      '結果を見る',
    ]);
    expect(importJobRowAction('needs_review', canOf('reviewer')).id).toBe('result');
    expect(importReviewScreenActions('needs_review', preparer).primary?.label).toBe(
      '選択した行を確定',
    );
    expect(importReviewScreenActions('completed', preparer).primary).toBeNull();
  });
});

describe('PBC・調書・Sign-off・指摘（監査法人）', () => {
  it('PBC: 監査法人は回答済みに「受理」と「差戻し…」、企業は依頼中・差戻しに「回答を提出」', () => {
    const manager = canOf('assurance_manager');
    expect(ids(pbcFirmRowActions('submitted', manager))).toEqual({
      primary: 'accept',
      secondary: ['reject'],
      more: [],
    });
    expect(pbcFirmRowActions('sent', manager).primary).toBeNull();
    const client = canOf('sustainability_manager');
    expect(ids(pbcClientRowActions('rejected', client))).toEqual({
      primary: null,
      secondary: ['respond'],
      more: [],
    });
    expect(pbcClientRowActions('accepted', client).secondary).toEqual([]);
  });

  it('調書: 作成中は「作成完了として記録」、作成済みは本人には自己レビュー禁止の理由で押せない', () => {
    const staff = canOf('assurance_staff');
    expect(
      ids(testStateActions({ status: 'in_progress', can: staff, preparedByMe: false })),
    ).toMatchObject({ primary: 'prepare', secondary: ['save'] });
    expect(
      testStateActions({ status: 'prepared', can: staff, preparedByMe: true }).primary,
    ).toEqual({
      id: 'review',
      label: 'レビュー完了として記録',
      disabledReason: SELF_REVIEW_REASON,
    });
    expect(
      testStateActions({ status: 'prepared', can: staff, preparedByMe: false }).primary
        ?.disabledReason,
    ).toBeUndefined();
  });

  it('Sign-off: その段の権限がある人だけに出し、止める理由（代理禁止など）があれば押せない', () => {
    const partner = canOf('engagement_partner');
    const p = signoffStateActions({
      stage: 'partner_approved',
      can: partner,
      blockers: ['未解決の重要な指摘があります。'],
    });
    expect(p.primary).toMatchObject({
      id: 'signoff',
      label: 'Partner Approved（契約責任者承認） として Sign-off',
      confirm: 'irreversible',
      disabledReason: '未解決の重要な指摘があります。',
    });
    expect(
      signoffStateActions({
        stage: 'partner_approved',
        can: canOf('assurance_staff'),
        blockers: [],
      }).primary,
    ).toBeNull();
  });

  it('指摘: 未解決の行に「解消として記録」（issue.manage のときだけ）', () => {
    expect(issueRowActions('open', canOf('assurance_manager')).secondary[0]?.label).toBe(
      '解消として記録',
    );
    expect(issueRowActions('resolved', canOf('assurance_manager')).secondary).toEqual([]);
    expect(issueRowActions('open', none).secondary).toEqual([]);
  });
});
