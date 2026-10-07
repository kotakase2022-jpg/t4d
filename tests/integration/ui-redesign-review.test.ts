import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_TODAY } from '@/lib/config';
import {
  DEFAULT_REVIEW_POLICY,
  DEFAULT_REVIEW_POLICY_VERSION,
} from '@/lib/domain/disclosure-status';
import { COMMENT_MAX_LENGTH, RETURN_REASON_MAX_LENGTH } from '@/lib/domain/comment-limits';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, at, day, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { bulkTransition, transitionDataPoint } from '@/lib/services/data-point-workflow';
import { loadDisclosureHome, MY_TASK_LIMIT } from '@/lib/services/disclosure-home';
import { returnDisclosureResponse } from '@/lib/services/disclosure-write';
import { loadMyWork } from '@/lib/services/my-work';
import { searchPalette } from '@/lib/services/palette-search';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * UI シンプル化・UX 再設計（5cb0d11）の検証で確定した所見の回帰テスト（サービス層）。
 * いずれも修正前の実装では失敗する（＝欠陥を捉えている）。
 *
 *  - BIZ-1: 長すぎる差戻し理由で、状態だけが変わり・監査ログが残らず・結果は「失敗」と出ていた
 *  - BIZ-2: 回答の差戻しで、状態は変わったのに理由がどこにも残らないことがあった
 *  - F1/F2（MyWork）: 開示ホームの 5 件に絞った作業から作っていた（件数が少なく出る・最終承認が消える）
 *  - F4（MyWork）: 状態が overdue でない期限超過の資料依頼が、ホームの注意に出なかった
 *  - F5（MyWork）: 原稿の作業に担当（誰の原稿か）が出なかった
 *  - F3（パレット）: 架空の縮小マスターの要求事項が、正式な ESRS・CDP の要求事項のように出ていた
 */

let fixture: FixtureDb;
let db: DemoDbClient;

const AUTHOR = 'sustainability@demo.local';
const REVIEWER = 'reviewer@demo.local';
const APPROVER = 'approver@demo.local';

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const reviewer = () => ctxFor(REVIEWER, ['reviewer']);
const author = () => ctxFor(AUTHOR, ['sustainability_manager']);

function period(): ReportingPeriod {
  const found = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026);
  if (!found) throw new Error('FY2026 が無い');
  return found;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

// ----------------------------------------------------------------------
// BIZ-1 差戻し理由の検証は書き込みより前
// ----------------------------------------------------------------------

describe('BIZ-1 長すぎる差戻し理由は、何も書き換える前に断る', () => {
  function submitted() {
    const target = fixture.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.status === 'submitted' && !d.deletedAt,
    );
    if (!target) throw new Error('提出済みの行が無い');
    return target;
  }
  const returnedApprovals = (id: string) =>
    fixture.approvals.filter((a) => a.targetId === id && a.decision === 'returned').length;
  const returnedAudits = (id: string) =>
    fixture.auditEvents.filter((e) => e.resourceId === id && e.eventType === 'data_returned')
      .length;

  it('単票: 状態・承認の記録・コメント・監査ログのどれも変えず、利用者に見せてよい理由で断る', async () => {
    const target = submitted();
    const before = {
      approvals: returnedApprovals(target.id),
      audits: returnedAudits(target.id),
      comments: fixture.comments.length,
    };

    const error = await transitionDataPoint(db, reviewer(), {
      dataPointId: target.id,
      to: 'returned',
      comment: 'あ'.repeat(COMMENT_MAX_LENGTH + 1),
    }).catch((e: unknown) => e);

    // 素の Error だと本番では文が伏せられ、利用者は識別子だけの画面を見る
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toContain(`${COMMENT_MAX_LENGTH} 文字以内`);
    expect((await db.findById('dataPoints', target.id))!.status).toBe('submitted');
    expect(returnedApprovals(target.id)).toBe(before.approvals);
    expect(returnedAudits(target.id)).toBe(before.audits);
    expect(fixture.comments.length).toBe(before.comments);
  });

  it('一括: 1 行も書き換えずに断り、やり直せる（以前は全行が差戻し済みなのに「0 件を更新」と出た）', async () => {
    const target = submitted();
    await expect(
      bulkTransition(db, reviewer(), [target.id], 'returned', {
        comment: 'あ'.repeat(COMMENT_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await db.findById('dataPoints', target.id))!.status).toBe('submitted');
    expect(returnedApprovals(target.id)).toBe(0);

    // 理由を直せば同じ行を差し戻せる（「returned から returned への遷移」にならない）
    const result = await bulkTransition(db, reviewer(), [target.id], 'returned', {
      comment: '  単位を確認してください  ',
    });
    expect(result).toEqual({ succeeded: 1, failures: [] });
    expect(returnedAudits(target.id)).toBe(1);
    // 承認の記録とコメントには、前後の空白を除いた同じ理由が残る
    const approval = fixture.approvals.find(
      (a) => a.targetId === target.id && a.decision === 'returned',
    );
    expect(approval?.comment).toBe('単位を確認してください');
    expect(
      fixture.comments.some((c) => c.targetId === target.id && c.body === '単位を確認してください'),
    ).toBe(true);
  });

  it('上限ちょうどの理由は受け付ける', async () => {
    const target = submitted();
    await transitionDataPoint(db, reviewer(), {
      dataPointId: target.id,
      to: 'returned',
      comment: 'あ'.repeat(COMMENT_MAX_LENGTH),
    });
    expect((await db.findById('dataPoints', target.id))!.status).toBe('returned');
  });
});

// ----------------------------------------------------------------------
// BIZ-2 回答の差戻しは理由の検証 → 状態 → コメントを 1 つの操作で
// ----------------------------------------------------------------------

describe('BIZ-2 回答の差戻しで、理由を失わない', () => {
  function inReview() {
    const response = fixture.disclosureResponses.find((r) => r.organizationId === ORG_IDS.aomi)!;
    response.status = 'in_review';
    return response;
  }
  const commentsOn = (id: string) => fixture.comments.filter((c) => c.targetId === id);

  it('長すぎる理由は、状態を変える前に断る（理由の無い差戻しを残さない）', async () => {
    const response = inReview();
    await expect(
      returnDisclosureResponse(db, author(), {
        responseId: response.id,
        reason: 'あ'.repeat(RETURN_REASON_MAX_LENGTH + 1),
        href: '/enterprise/disclosures/cdp',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await db.findById('disclosureResponses', response.id))!.status).toBe('in_review');
    expect(commentsOn(response.id)).toHaveLength(0);
  });

  it('空の理由も断る', async () => {
    const response = inReview();
    await expect(
      returnDisclosureResponse(db, author(), {
        responseId: response.id,
        reason: '   ',
        href: '/enterprise/disclosures/cdp',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await db.findById('disclosureResponses', response.id))!.status).toBe('in_review');
  });

  it('差し戻すと、状態と理由のコメントが一緒に残る（上限ちょうどの理由も受け付ける）', async () => {
    const response = inReview();
    const reason = 'い'.repeat(RETURN_REASON_MAX_LENGTH);
    const updated = await returnDisclosureResponse(db, author(), {
      responseId: response.id,
      reason,
      href: '/enterprise/disclosures/cdp',
    });
    expect(updated.status).toBe('returned');
    expect(commentsOn(response.id).map((c) => c.body)).toEqual([`差戻し理由: ${reason}`]);
  });

  it('他の組織の回答は、理由が正しくても見つからない扱い（何も書かない）', async () => {
    const response = inReview();
    const other = { ...author(), workspace: { ...author().workspace, organizationId: 'other' } };
    await expect(
      returnDisclosureResponse(db, other, {
        responseId: response.id,
        reason: '直してください',
        href: '/enterprise/disclosures/cdp',
      }),
    ).rejects.toThrow('回答が見つかりません');
    expect(commentsOn(response.id)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------
// MyWork（F1・F2・F4・F5）
// ----------------------------------------------------------------------

function cloneBlock(index: number, overrides: Record<string, unknown>) {
  const base = fixture.disclosureBlocks.find(
    (b) => b.id === IDS.blocks.fy2026Esrs40aGovernance.block,
  )!;
  fixture.disclosureBlocks.push({
    ...base,
    id: fid('disclosure_block', `test/review/${index}`),
    title: `追加の節 ${index}`,
    sortOrder: 300 + index,
    dueDate: day(30 + index),
    ...overrides,
  });
}

describe('F1/F2 MyWork は開示ホームの 5 件に絞る前の作業から作る', () => {
  it('原稿の作業が 5 件を超えても、すべて数えて並べる（見出しの件数が少なく出ない）', async () => {
    for (let i = 0; i < 6; i += 1) cloneBlock(i, {});
    const home = await loadDisclosureHome(db, author(), {
      period: period(),
      today: FIXTURE_TODAY,
    });
    expect(home.myTasks).toHaveLength(MY_TASK_LIMIT);
    expect(home.allTasks).toHaveLength(home.myTaskTotal);
    expect(home.myTaskTotal).toBeGreaterThan(MY_TASK_LIMIT);

    const work = await loadMyWork(db, author(), {
      period: period(),
      today: FIXTURE_TODAY,
      disclosureHome: home,
    });
    const manuscripts = work.items.filter((i) => i.kind.startsWith('manuscript-'));
    expect(manuscripts).toHaveLength(home.myTaskTotal);
  });

  it('承認者: 差戻しの原稿が 5 件以上あっても、最終承認が先頭に出る（絞ってから並べると消えていた）', async () => {
    const approver = ctxFor(APPROVER, ['approver', 'sustainability_manager']);
    // 承認者が担当する差し戻された節を 6 つ
    for (let i = 0; i < 6; i += 1) {
      cloneBlock(i, { ownerUserId: userId(APPROVER), status: 'returned' });
    }
    // リスク・機会の節がレビュー済み（最終承認待ち）。承認者はレビューしていない
    const risk = IDS.blocks.fy2026RiskOpportunity;
    const blockIndex = fixture.disclosureBlocks.findIndex((b) => b.id === risk.block);
    fixture.disclosureBlocks[blockIndex] = {
      ...fixture.disclosureBlocks[blockIndex]!,
      status: 'approval_pending',
      submittedVersionId: risk.version,
    };
    const requestId = fid('review_request', 'test/review/final');
    fixture.reviewRequests.push({
      id: requestId,
      organizationId: ORG_IDS.aomi,
      projectId: IDS.projects.fy2026,
      targetType: 'disclosure_block',
      targetId: risk.block,
      targetVersionId: risk.version,
      requestedBy: userId(AUTHOR),
      reviewerUserId: userId(REVIEWER),
      approverUserId: userId(APPROVER),
      policyVersion: DEFAULT_REVIEW_POLICY_VERSION,
      policy: { ...DEFAULT_REVIEW_POLICY, stages: [...DEFAULT_REVIEW_POLICY.stages] },
      decisionIds: [IDS.decisions.fy2026Ssbj],
      referencedVersions: { metricVersionIds: [], narrativeVersionIds: [], anchorIds: [] },
      status: 'reviewed',
      projectScopeRevision: 0,
      createdAt: at(2),
      updatedAt: at(1),
      createdBy: userId(AUTHOR),
      updatedBy: userId(AUTHOR),
    });
    fixture.reviewEvents.push({
      id: fid('review_event', 'test/review/final/completed'),
      organizationId: ORG_IDS.aomi,
      reviewRequestId: requestId,
      eventType: 'review_completed',
      stage: 'review',
      actorUserId: userId(REVIEWER),
      targetVersionId: risk.version,
      reason: null,
      paragraphId: null,
      idempotencyKey: 'test/review/final/completed',
      createdAt: at(1),
    } as (typeof fixture.reviewEvents)[number]);

    const home = await loadDisclosureHome(db, approver, { period: period(), today: FIXTURE_TODAY });
    // 開示ホームの 5 件は差戻しで埋まり、最終承認は 6 件目以降
    expect(home.myTasks.map((t) => t.kind)).not.toContain('final_approval');
    expect(home.allTasks.map((t) => t.kind)).toContain('final_approval');

    const work = await loadMyWork(db, approver, {
      period: period(),
      today: FIXTURE_TODAY,
      disclosureHome: home,
    });
    expect(work.profile).toBe('approver');
    expect(work.items[0]?.kind).toBe('manuscript-final');
    expect(work.items[0]?.verb).toBe('最終承認する');
  });
});

describe('F5 原稿の作業に担当（誰の原稿か）を添える', () => {
  it('対象の補足に「担当: 作成担当の名前」が入る', async () => {
    const work = await loadMyWork(db, author(), { period: period(), today: FIXTURE_TODAY });
    const manuscripts = work.items.filter((i) => i.kind.startsWith('manuscript-'));
    expect(manuscripts.length).toBeGreaterThan(0);
    const owner = fixture.profiles.find((p) => p.id === userId(AUTHOR))!.displayName;
    for (const item of manuscripts) expect(item.context).toContain(`担当: ${owner}`);
  });
});

describe('F4 期限を過ぎた資料依頼は、状態が overdue でなくてもホームの注意に出る', () => {
  it('送付済みのまま期限を過ぎた依頼を「期限を過ぎた」に数え、「期限が近い」には数えない', async () => {
    const before = await loadMyWork(db, author(), { period: period(), today: FIXTURE_TODAY });
    const count = (work: typeof before, key: string) =>
      work.attention.find((a) => a.key === key)?.count ?? 0;

    const sent = fixture.pbcRequests.find(
      (r) => r.clientOrganizationId === ORG_IDS.aomi && r.status === 'sent',
    )!;
    // 今日（2026-08-14）の 4 日前が期限。状態は送付済みのまま（overdue へ進めるサービスは無い）
    sent.dueDate = '2026-08-10';
    const after = await loadMyWork(db, author(), { period: period(), today: FIXTURE_TODAY });
    expect(count(after, 'pbc-overdue')).toBe(count(before, 'pbc-overdue') + 1);
    expect(count(after, 'pbc-due-soon')).toBeLessThanOrEqual(count(before, 'pbc-due-soon'));
    // 行は従来どおり「回答する」に出て、期限超過の日数が分かる
    const row = after.items.find((i) => i.key === `pbc-${sent.id}`);
    expect(row?.daysUntilDue).toBe(-4);
  });
});

// ----------------------------------------------------------------------
// F3 パレットのデータ検索で、架空のマスターと分かる
// ----------------------------------------------------------------------

describe('F3 パレットの検索で、架空の縮小マスターの要求事項に「サンプル・架空」を添える', () => {
  const manager = () => ctxFor(AUTHOR, ['sustainability_manager']);

  it('CSRD（架空の縮小版）・CDP（架空）は種類の表示に「（サンプル・架空）」が付く', async () => {
    const csrd = await searchPalette(db, manager(), 'E1');
    const csrdHints = new Set(
      csrd.entries.filter((e) => e.href.includes('/csrd/requirements/')).map((e) => e.hint),
    );
    expect(csrdHints.size).toBeGreaterThan(0);
    expect([...csrdHints]).toEqual(['CSRD 要求事項（サンプル・架空）']);

    const cdp = await searchPalette(db, manager(), '気候');
    const cdpHints = new Set(
      cdp.entries
        .filter((e) => e.href.startsWith('/enterprise/disclosures/cdp/'))
        .map((e) => e.hint),
    );
    expect(cdpHints.size).toBeGreaterThan(0);
    expect([...cdpHints]).toEqual(['CDP 質問（サンプル・架空）']);
  });

  it('正式な基準（SSBJ。転載許可を得た条文）には付けない', async () => {
    const ssbj = await searchPalette(db, manager(), 'ガバナンス');
    const ssbjHints = new Set(
      ssbj.entries
        .filter((e) => e.href.startsWith('/enterprise/disclosures/ssbj/requirements/'))
        .map((e) => e.hint),
    );
    expect(ssbjHints.size).toBeGreaterThan(0);
    expect([...ssbjHints]).toEqual(['SSBJ 要求事項']);
  });
});
