import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_TODAY } from '@/lib/config';
import {
  DEFAULT_REVIEW_POLICY,
  DEFAULT_REVIEW_POLICY_VERSION,
  reviewEventIdempotencyKey,
} from '@/lib/domain/disclosure-status';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, at, day, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { listProjectBlocks } from '@/lib/services/disclosure-block';
import { getProject, summarizeProject } from '@/lib/services/disclosure-project';
import { decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  blockHref,
  loadDisclosureHome,
  loadHeaderProjects,
  unresolvedNarrativeFields,
  type DisclosureHome,
} from '@/lib/services/disclosure-home';
import type {
  AuthorizationContext,
  ReportingPeriod,
  ReviewEventType,
  ReviewRequestStatus,
  ReviewStage,
  RoleKey,
} from '@/types/domain';

/**
 * 開示ホーム（指示書 §6.1）の集計。
 *
 * - 「自分が次に行う作業」は利用者ごとに違う（作成担当とレビュアーで中身が入れ替わる）
 * - 4 カードの件数と遷移先
 * - 進捗は分母を明示し（適用確定済み N 項目中、承認済み M 項目）、適用未判定を別に数える（A21）
 * - 対象期間を一致させ、別年度のプロジェクトへ黙って移らない（A02）
 */

let fixture: FixtureDb;
let db: DemoDbClient;

const AUTHOR = 'sustainability@demo.local';
const REVIEWER = 'reviewer@demo.local';
const APPROVER = 'approver@demo.local';

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  options: { organizationId?: string; unitScopeIds?: string[] } = {},
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: options.organizationId ?? ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: options.unitScopeIds ?? [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor(AUTHOR, ['sustainability_manager']);
const reviewer = () => ctxFor(REVIEWER, ['reviewer']);
const approver = () => ctxFor(APPROVER, ['approver', 'reviewer']);

function period(id: string): ReportingPeriod {
  const found = fixture.periods.find((p) => p.id === id);
  if (!found) throw new Error(`period ${id} が無い`);
  return found;
}

async function homeFor(
  ctx: AuthorizationContext,
  periodId: string = PERIOD_IDS.fy2026,
): Promise<DisclosureHome> {
  return loadDisclosureHome(db, ctx, { period: period(periodId), today: FIXTURE_TODAY });
}

const risk = IDS.blocks.fy2026RiskOpportunity;
const projectId = IDS.projects.fy2026;

/** リスク・機会の節（版 1）にレビュー依頼を出した状態を作る（S-d の画面操作に相当する行） */
function requestReviewOnRisk(
  status: ReviewRequestStatus,
  events: Array<[ReviewEventType, ReviewStage, string, { reason?: string; paragraphId?: string }?]>,
) {
  const requestId = fid('review_request', 'test/risk/1');
  const blockIndex = fixture.disclosureBlocks.findIndex((b) => b.id === risk.block);
  const block = fixture.disclosureBlocks[blockIndex]!;
  fixture.disclosureBlocks[blockIndex] = {
    ...block,
    status:
      status === 'open'
        ? 'review_requested'
        : status === 'reviewed'
          ? 'approval_pending'
          : status === 'returned'
            ? 'returned'
            : block.status,
    submittedVersionId: risk.version,
  };
  fixture.reviewRequests.push({
    id: requestId,
    organizationId: ORG_IDS.aomi,
    projectId,
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
    status,
    projectScopeRevision: 0,
    createdAt: at(2),
    updatedAt: at(1),
    createdBy: userId(AUTHOR),
    updatedBy: userId(AUTHOR),
  });
  for (const [index, [eventType, stage, actor, extra]] of events.entries()) {
    fixture.reviewEvents.push({
      id: fid('review_event', `test/risk/1/${index}`),
      organizationId: ORG_IDS.aomi,
      reviewRequestId: requestId,
      eventType,
      stage,
      actorUserId: userId(actor),
      targetVersionId: risk.version,
      reason: extra?.reason ?? null,
      paragraphId: extra?.paragraphId ?? null,
      idempotencyKey: reviewEventIdempotencyKey(requestId, stage, risk.version),
      createdAt: at(1, index),
    });
  }
  return requestId;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('現在のプロジェクト（A02: 対象期間を一致させる）', () => {
  it('FY2026 を選んでいれば FY2026 の進行中プロジェクトと期限を出す', async () => {
    const home = await homeFor(author());
    expect(home.canRead).toBe(true);
    expect(home.project).toMatchObject({
      id: projectId,
      name: 'FY2026 統合開示（SSBJ・CSRD域外準備）',
      statusLabel: '進行中',
      periodStart: '2026-04-01',
      periodEnd: '2027-03-31',
      dueDate: day(45),
      daysUntilDue: 45,
      purposeLabels: ['SSBJ（任意）', 'CSRD 域外（40a）準備'],
    });
    expect(home.otherProjectCount).toBe(1);
  });

  it('FY2025 を選べば FY2025（完了）のプロジェクト。別年度へ黙って移らない', async () => {
    const home = await homeFor(author(), PERIOD_IDS.fy2025);
    expect(home.project?.id).toBe(IDS.projects.fy2025);
    expect(home.project?.statusLabel).toBe('完了');
  });

  it('プロジェクトの無い期間は空（他年度のプロジェクトで埋めない）', async () => {
    const fy2024 = fixture.periods.find(
      (p) => p.code === 'FY2024' && p.organizationId === ORG_IDS.aomi,
    )!;
    const home = await homeFor(author(), fy2024.id);
    expect(home.canRead).toBe(true);
    expect(home.project).toBeNull();
    expect(home.cards).toBeNull();
    expect(home.otherProjectCount).toBe(2);
  });

  it('別テナントには主役の企業のプロジェクトを出さない', async () => {
    const other = ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], {
      organizationId: ORG_IDS.soten,
    });
    const sotenPeriod = fixture.periods.find(
      (p) => p.organizationId === ORG_IDS.soten && p.status === 'collecting',
    );
    const home = await loadDisclosureHome(db, other, {
      period: sotenPeriod ?? period(PERIOD_IDS.fy2026),
      today: FIXTURE_TODAY,
      // 別テナントのプロジェクト ID を URL で指定しても使わない
      projectId,
    });
    expect(home.project).toBeNull();
    expect(home.otherProjectCount).toBe(0);
    expect(await loadHeaderProjects(db, other)).toEqual([]);
  });
});

describe('4 カード', () => {
  it('未解決の必須情報・レビュー待ち・承認後に変更・次の提出期限と、その一覧への遷移先', async () => {
    const { cards } = await homeFor(author());
    expect(cards).not.toBeNull();
    // リスク・機会の節: 引用した定性情報に未記入（対応策・影響額など）がある
    expect(cards!.unresolvedRequired.count).toBe(1);
    expect(cards!.unresolvedRequired.href).toBe(
      `/enterprise/disclosure-projects/${projectId}?tab=manuscripts&filter=unresolved`,
    );
    expect(cards!.reviewPending).toMatchObject({ count: 0, reviewStage: 0, finalStage: 0 });
    expect(cards!.reviewPending.href).toBe(
      `/enterprise/disclosure-projects/${projectId}?tab=reviews`,
    );
    // 指標の節: 承認済みだが、引用した Scope1 に承認後の新しい版がある
    expect(cards!.changedAfterApproval.count).toBe(1);
    expect(cards!.changedAfterApproval.href).toBe(
      `/enterprise/disclosure-projects/${projectId}?tab=manuscripts&filter=changed_after_approval`,
    );
    // 未承認の節（リスク・機会: 20 日後）がプロジェクトの期限（45 日後）より早い
    expect(cards!.nextDeadline).toEqual({
      date: day(20),
      daysUntil: 20,
      label: 'リスク及び機会',
      href: blockHref(projectId, risk.block),
    });
  });

  it('カードの件数と、クリック先の原稿一覧の件数が一致する（§6.1: 根拠となる項目一覧へ移動）', async () => {
    const count = async (filter: 'unresolved' | 'changed_after_approval') =>
      (await listProjectBlocks(db, author(), projectId, filter)).rows.length;

    const { cards } = await homeFor(author());
    expect(await count('unresolved')).toBe(cards!.unresolvedRequired.count);
    expect(await count('changed_after_approval')).toBe(cards!.changedAfterApproval.count);

    // 新しい版を採用した後（節は下書きに戻り、承認済みの版は古い数値を引用したまま）も一致する
    await decideRecheck(db, author(), {
      blockId: IDS.blocks.fy2026Metrics.block,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'adopt_new',
      reason: null,
    });
    const after = await homeFor(author());
    expect(after.cards!.changedAfterApproval.count).toBe(1);
    expect(await count('changed_after_approval')).toBe(after.cards!.changedAfterApproval.count);
    expect(await count('unresolved')).toBe(after.cards!.unresolvedRequired.count);
  });

  it('引用中の版を維持と判断した節は「承認後に変更」「再確認する」から外す（原稿画面・確定と同じ規則）', async () => {
    await decideRecheck(db, author(), {
      blockId: IDS.blocks.fy2026Metrics.block,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'keep_old',
      reason: '値は同じで、注記の訂正のみのため引用中の版を維持する',
    });
    const home = await homeFor(author());
    expect(home.cards!.changedAfterApproval.count).toBe(0);
    expect(home.myTasks.some((t) => t.kind === 'recheck')).toBe(false);
  });

  it('レビュー依頼が出るとレビュー待ちに数え、未解決の必須情報からは外す（未承認のまま）', async () => {
    requestReviewOnRisk('open', [['requested', 'request', AUTHOR]]);
    const { cards } = await homeFor(author());
    expect(cards!.reviewPending).toMatchObject({ count: 1, reviewStage: 1, finalStage: 0 });
    // 依頼中でも不足は不足（承認されるまで数える）
    expect(cards!.unresolvedRequired.count).toBe(1);
  });
});

describe('自分が次に行う作業（利用者ごとに違う）', () => {
  it('作成担当（海野）: 承認後の再確認 → 不足を補う → レビュー依頼の順で、理由と CTA を 1 行に出す', async () => {
    const home = await homeFor(author());
    expect(home.myTasks.map((t) => [t.kind, t.itemName, t.cta.label])).toEqual([
      ['recheck', '指標及び目標', '再確認する'],
      ['missing_info', 'リスク及び機会', '不足を補う'],
      ['ready_for_review', 'ガバナンス（ESRS-40a 準備）', 'レビューを依頼'],
    ]);
    expect(home.myTaskTotal).toBe(3);

    const [recheck, missing, ready] = home.myTasks;
    expect(recheck!.blockerReason).toContain('Scope1 排出量');
    expect(recheck!.blockerReason).toContain('新しい版');
    expect(missing!.blockerReason).toContain('対応策');
    expect(missing!.frameworkLabel).toBe('SSBJ 2026年3月13日改正基準');
    expect(missing!.ownerName).toBe('海野 みどり');
    expect(missing!.dueDate).toBe(day(20));
    expect(missing!.daysUntilDue).toBe(20);
    expect(missing!.cta.href).toBe(blockHref(projectId, risk.block));
    // ESRS-40a は草案・適用判断が未確定であることを項目に添える（正式準拠と見せない: A22）
    expect(ready!.frameworkNote).toContain('公開草案に基づく準備');
    expect(ready!.frameworkNote).toContain('適用判断が未確定');
    expect(ready!.blockerReason).toBeNull();
  });

  it('レビュアー（検見川）: 初期状態では作業なし。依頼が届くと「レビューする」が出る', async () => {
    expect((await homeFor(reviewer())).myTasks).toEqual([]);

    requestReviewOnRisk('open', [['requested', 'request', AUTHOR]]);
    const home = await homeFor(reviewer());
    expect(home.myTasks).toHaveLength(1);
    expect(home.myTasks[0]).toMatchObject({
      kind: 'review',
      itemName: 'リスク及び機会',
      ownerName: '海野 みどり',
      blockerReason: null,
      cta: { label: 'レビューする', href: blockHref(projectId, risk.block) },
    });

    // 作成担当の側では、依頼中の節は自分の作業から外れる（相手の番）
    const authorHome = await homeFor(author());
    expect(authorHome.myTasks.map((t) => t.itemName)).not.toContain('リスク及び機会');
  });

  it('最終承認者（承）: レビュー完了後に「最終承認する」が出る', async () => {
    requestReviewOnRisk('reviewed', [
      ['requested', 'request', AUTHOR],
      ['review_completed', 'review', REVIEWER],
    ]);
    const home = await homeFor(approver());
    expect(home.myTasks.map((t) => [t.kind, t.cta.label, t.blockerReason])).toEqual([
      ['final_approval', '最終承認する', null],
    ]);
    // レビュアーの側には、もう作業は無い
    expect((await homeFor(reviewer())).myTasks).toEqual([]);
  });

  it('同じ依頼のレビューを完了した本人には、最終承認の阻害理由（職務分離）を示す', async () => {
    requestReviewOnRisk('reviewed', [
      ['requested', 'request', AUTHOR],
      ['review_completed', 'review', APPROVER],
    ]);
    const [task] = (await homeFor(approver())).myTasks;
    expect(task?.kind).toBe('final_approval');
    expect(task?.blockerReason).toContain('職務分離');
  });

  it('差し戻された節は作成担当の先頭に出て、差戻し理由と段落を示す', async () => {
    requestReviewOnRisk('returned', [
      ['requested', 'request', AUTHOR],
      [
        'returned',
        'review',
        REVIEWER,
        { reason: '対応策の記載を追加してください', paragraphId: 'risk-1' },
      ],
    ]);
    const [first] = (await homeFor(author())).myTasks;
    expect(first).toMatchObject({
      kind: 'returned',
      itemName: 'リスク及び機会',
      cta: { label: '差戻しに対応' },
    });
    expect(first?.blockerReason).toBe('差戻し理由: 対応策の記載を追加してください（段落 risk-1）');
  });

  it('最大 5 件に絞り、総数は別に返す', async () => {
    // 作成担当の下書きを 6 節足す（期限の早い順に並ぶ）
    for (let i = 0; i < 6; i += 1) {
      const base = fixture.disclosureBlocks.find(
        (b) => b.id === IDS.blocks.fy2026Esrs40aGovernance.block,
      )!;
      fixture.disclosureBlocks.push({
        ...base,
        id: fid('disclosure_block', `test/extra/${i}`),
        title: `追加の節 ${i}`,
        sortOrder: 200 + i,
        dueDate: day(30 + i),
      });
    }
    const home = await homeFor(author());
    expect(home.myTasks).toHaveLength(5);
    expect(home.myTaskTotal).toBe(9);
  });

  it('閲覧のみのロール（外部支援者）には作業を出さない', async () => {
    const advisor = ctxFor(AUTHOR, ['external_advisor']);
    const home = await homeFor(advisor);
    expect(home.canRead).toBe(true);
    expect(home.myTasks).toEqual([]);
  });
});

describe('進捗は分母を明示する（率にまとめない）', () => {
  it('分母は要求事項ごとに「適用（重要）」と確定したものだけ。概要タブと同じ数で、対象外・未判定は別枠（REG-F3）', async () => {
    const { progress } = await homeFor(author());
    expect(progress).not.toBeNull();
    // 収録 133 項目のうち、SSBJ 評価で対象外・非重要と判断した 9 項目と未判定の項目は分母に入れない
    // （以前は基準単位の「適用」だけを見て 133 項目すべてを「適用確定済み」と数えていた）
    const detail = await getProject(db, author(), IDS.projects.fy2026);
    const overview = (await summarizeProject(db, author(), detail)).find(
      (s) => s.framework.projectFramework.id === IDS.projectFrameworks.fy2026Ssbj,
    )!.summary;
    expect(progress!.confirmedItemCount).toBe(overview.applicableConfirmed);
    expect(progress!.approvedItemCount).toBe(overview.approvedOfApplicable);
    expect(progress!.excludedItemCount).toBe(overview.excludedDecided);
    expect(progress!.notAssessedItemCount).toBe(overview.notAssessed);
    expect(progress!.confirmedItemCount).toBe(104);
    expect(progress!.excludedItemCount).toBe(9);
    expect(
      progress!.confirmedItemCount + progress!.excludedItemCount + progress!.notAssessedItemCount,
    ).toBe(133);
    expect(progress!.assignedItemCount).toBeLessThanOrEqual(progress!.confirmedItemCount);
    expect(progress!.approvedItemCount).toBeLessThanOrEqual(progress!.assignedItemCount);
    expect(progress!.notAssessedCount).toBe(1);
    expect(progress!.excludedFrameworkCount).toBe(0);

    const esrs = progress!.rows.find((r) => r.frameworkVersionId === IDS.esrs40aVersion);
    expect(esrs).toMatchObject({
      decided: false,
      inScope: false,
      applicabilityLabel: '適用候補',
      legalStatusLabel: '草案',
      coverageStatusLabel: '要求事項は未収録',
      itemCount: 0,
      blockCount: 1,
    });
    const ssbj = progress!.rows.find(
      (r) => r.projectFrameworkId === IDS.projectFrameworks.fy2026Ssbj,
    );
    expect(ssbj).toMatchObject({ decided: true, inScope: true, decidedOn: day(-46) });
  });

  it('未判定の基準を「対象外」にしても、判断の記録が無ければ分母から外さない（A21）', async () => {
    const index = fixture.projectFrameworks.findIndex(
      (pf) => pf.id === IDS.projectFrameworks.fy2026Esrs40a,
    );
    // 状態だけ書き換えて判断（decision）の行が無い: 確定とはみなさない
    fixture.projectFrameworks[index] = {
      ...fixture.projectFrameworks[index]!,
      applicabilityStatus: 'not_applicable',
    };
    const { progress } = await homeFor(author());
    expect(progress!.notAssessedCount).toBe(1);
    expect(progress!.excludedFrameworkCount).toBe(0);
  });
});

describe('拠点の未提出（補助表示）と閲覧権限', () => {
  it('未提出のある拠点だけを、未提出の多い順に返す', async () => {
    const home = await homeFor(author());
    expect(home.unitSubmissions.length).toBeGreaterThan(0);
    for (const row of home.unitSubmissions) {
      expect(row.notSubmitted).toBeGreaterThan(0);
      expect(row.notSubmitted).toBeLessThanOrEqual(row.total);
    }
    const counts = home.unitSubmissions.map((r) => r.notSubmitted);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('開示の閲覧権限が無い拠点担当には開示の集計を出さず、担当拠点の未提出だけを返す', async () => {
    const site = ctxFor('site-user@demo.local', ['site_contributor'], {
      unitScopeIds: [UNIT_IDS.east],
    });
    const home = await homeFor(site);
    expect(home.canRead).toBe(false);
    expect(home.project).toBeNull();
    expect(home.cards).toBeNull();
    expect(home.unitSubmissions.every((r) => r.unitId === UNIT_IDS.east)).toBe(true);
    expect(await loadHeaderProjects(db, site)).toEqual([]);
  });
});

describe('ヘッダーのプロジェクト表示', () => {
  it('プロジェクトの名前・対象範囲・期間を返す', async () => {
    const projects = await loadHeaderProjects(db, author());
    const fy2026 = projects.find((p) => p.id === projectId);
    expect(fy2026).toMatchObject({
      name: 'FY2026 統合開示（SSBJ・CSRD域外準備）',
      reportingEntity: '青海テクノロジー株式会社及び連結子会社',
      periodStart: '2026-04-01',
      periodEnd: '2027-03-31',
      reportingPeriodId: PERIOD_IDS.fy2026,
    });
    expect(fy2026?.scopeGhgBoundaryNote).toContain('財務支配力基準');
  });
});

describe('定性情報の未記入の数え方', () => {
  it('財務的影響: 影響額があれば「示さない理由」は不要。定量化しない理由があれば影響額・算定方法は未記入に数えない（スナップショットと同じ規則）', () => {
    expect(
      unresolvedNarrativeFields('financial_impact', {
        relatedRisk: 'x',
        impactDescription: 'x',
        amount: '1.2 億円',
        amountBasis: 'x',
        estimationStatus: '確定',
      }),
    ).toEqual([]);
    expect(
      unresolvedNarrativeFields('financial_impact', {
        relatedRisk: 'x',
        impactDescription: 'x',
        estimationStatus: '評価中',
        noAmountReason: '評価中のため',
      }),
    ).toEqual([]);
    // どちらも無ければ、影響額・算定方法・示さない理由のすべてが未記入
    expect(
      unresolvedNarrativeFields('financial_impact', {
        relatedRisk: 'x',
        impactDescription: 'x',
        estimationStatus: '評価中',
      }),
    ).toEqual(['影響額', '算定方法・前提', '影響額を示さない理由']);
  });
});
