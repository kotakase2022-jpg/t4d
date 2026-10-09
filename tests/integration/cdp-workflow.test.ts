import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { metricId, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { RESPONSE_AUTHOR_APPROVAL_REASON } from '@/lib/ui/state-actions';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * CDP 回答管理の強化（トライアル対応 NF-39。int:cdp-workflow）。
 *
 *  - C-01 担当: 組織の有効なメンバーだけ・作成とレビューは別の人・すべて検査してから書く・「自分の担当」
 *  - C-02 回答の開始: 読込では作らず、最初の保存・AI 草案で作る。前の期間の同じ質問の回答を前年回答にする
 *  - C-03 対応付け: AI の候補の確定（候補に無い組み合わせは不可）・手動の追加・外す（確定を外す）、
 *    確認済みの定性情報・承認済みの原稿・SSBJ の要求事項との対応付け（外すときは deleted_at）
 *  - C-04 根拠の再利用: 対応付けた指標の承認済みデータの根拠だけを候補にし、人が選ぶ
 *  - C-06 不足: データ不足・未対応付け・AI の不足情報、整合チェックの指摘を質問ごとに
 *  - C-07 承認の職務分離: 現在の版を作った人は承認できない（CDP・CSRD 共通）
 *  - C-08 出力: 承認済みだけ・担当・承認者・承認日時・版の列
 *  - C-09 年度更新: 期間の版で一覧を出し、版を選べば一覧に効く。前の版との比較
 */

const state = vi.hoisted(() => ({
  ctx: null as AuthorizationContext | null,
  db: null as unknown,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.ctx,
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({ getDb: async () => state.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { GET } = await import('@/app/api/exports/cdp/route');
const { bulkAssignResponsesAction } = await import('@/app/enterprise/disclosures/cdp/actions');
const { runQuestionMapping } = await import('@/lib/services/ai-assist');
const { filterDisclosureRows, loadDisclosureWorkspace, loadQuestionLinks, evidenceEntriesForRow } =
  await import('@/lib/services/disclosure');
const { issueTargetsCode, loadLatestConsistencyIssues, runDisclosureConsistencyCheck } =
  await import('@/lib/services/disclosure-check');
const write = await import('@/lib/services/disclosure-write');

let fixture: FixtureDb;
let db: DemoDbClient;
let periods: ReportingPeriod[];

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
/** 承認だけを持つ別の人（職務分離の確認用） */
const secondApprover = () => ctxFor('enterprise-admin@demo.local', ['approver']);
const viewer = () => ctxFor('enterprise-admin@demo.local', ['viewer']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const FY2026 = () => periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
const cdpItemId = (code: string, year = 2026) => fid('disclosure_item', `cdp/${year}/${code}`);
const responseOf = (code: string, periodId: string = PERIOD_IDS.fy2026) =>
  fixture.disclosureResponses.find(
    (r) => r.itemId === cdpItemId(code) && r.reportingPeriodId === periodId,
  )!;

async function workspace(
  ctx: AuthorizationContext = manager(),
  period: ReportingPeriod = FY2026(),
  versionId?: string,
) {
  const metrics = fixture.metrics.filter((m) => m.organizationId === ctx.workspace.organizationId);
  return (await loadDisclosureWorkspace(db, ctx, 'cdp', period, periods, metrics, {
    versionId,
  }))!;
}
async function rowOf(code: string, period: ReportingPeriod = FY2026()) {
  return (await workspace(manager(), period)).rows.find((r) => r.item.code === code)!;
}

function csrdItems() {
  const framework = fixture.frameworks.find((f) => f.key === 'csrd')!;
  const version = fixture.frameworkVersions.find((v) => v.frameworkId === framework.id)!;
  return fixture.disclosureItems.filter((i) => i.frameworkVersionId === version.id);
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = manager();
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
});

// ----------------------------------------------------------------------
// C-01 担当
// ----------------------------------------------------------------------

describe('担当（C-01）', () => {
  it('作成担当・レビュー担当を割り当て、監査ログに残し、「自分の担当」で絞り込める', async () => {
    const updated = await write.assignDisclosureItems(db, manager(), {
      periodId: PERIOD_IDS.fy2026,
      itemIds: [cdpItemId('C6.1'), cdpItemId('C6.3')],
      ownerUserId: userId('approver@demo.local'),
      reviewerUserId: userId('reviewer@demo.local'),
    });
    expect(updated).toHaveLength(2);
    expect(responseOf('C6.1').ownerUserId).toBe(userId('approver@demo.local'));
    expect(responseOf('C6.3').reviewerUserId).toBe(userId('reviewer@demo.local'));
    expect(
      fixture.auditEvents.some(
        (e) => e.resourceType === 'disclosure_response' && e.afterSummary?.includes('担当を割当'),
      ),
    ).toBe(true);

    const rows = (await workspace()).rows;
    const mine = filterDisclosureRows(rows, {
      owner: 'me',
      currentUserId: userId('approver@demo.local'),
    });
    expect(mine.map((r) => r.item.code).sort()).toEqual(['C6.1', 'C6.3']);
  });

  it('「変更しない」側の担当は残し、null で外す', async () => {
    const before = responseOf('C0.1').reviewerUserId;
    await write.assignDisclosureResponses(db, manager(), {
      responseIds: [responseOf('C0.1').id],
      ownerUserId: null,
    });
    expect(responseOf('C0.1').ownerUserId).toBeNull();
    expect(responseOf('C0.1').reviewerUserId).toBe(before);
    expect(
      filterDisclosureRows((await workspace()).rows, { owner: 'none' }).map((r) => r.item.code),
    ).toEqual(['C0.1']);
  });

  it('作成とレビューを同じ人にしない・編集できない人・組織外の人は選べない', async () => {
    const id = responseOf('C6.1').id;
    await expect(
      write.assignDisclosureResponses(db, manager(), {
        responseIds: [id],
        ownerUserId: userId('approver@demo.local'),
        reviewerUserId: userId('approver@demo.local'),
      }),
    ).rejects.toThrow('作成担当とレビュー担当は別の人にしてください。');
    await expect(
      write.assignDisclosureResponses(db, manager(), {
        responseIds: [id],
        ownerUserId: userId('site-user@demo.local'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      write.assignDisclosureResponses(db, manager(), {
        responseIds: [id],
        reviewerUserId: userId('other-enterprise-admin@demo.local'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      write.assignDisclosureResponses(db, manager(), { responseIds: [id] }),
    ).rejects.toThrow('作成担当かレビュー担当を選んでください。');
  });

  it('閲覧者は割り当てられない。他組織の回答は「見つかりません」で、1 件も書き換えない', async () => {
    await expect(
      write.assignDisclosureResponses(db, viewer(), {
        responseIds: [responseOf('C6.1').id],
        ownerUserId: userId('sustainability@demo.local'),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const sotenResponse = {
      ...responseOf('C6.1'),
      id: fid('disclosure_response', 'SOTEN/FY2026/C6.1'),
      organizationId: ORG_IDS.soten,
    };
    fixture.disclosureResponses.push(sotenResponse);
    const before = responseOf('C6.3').ownerUserId;
    await expect(
      write.assignDisclosureResponses(db, manager(), {
        responseIds: [responseOf('C6.3').id, sotenResponse.id],
        ownerUserId: userId('approver@demo.local'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(responseOf('C6.3').ownerUserId).toBe(before);
  });

  it('一括割当の Action は件数と理由を返す（BulkActionBar の結果）', async () => {
    const data = new FormData();
    data.append('periodId', PERIOD_IDS.fy2026);
    data.append('selected', cdpItemId('C8.2'));
    data.append('selected', cdpItemId('C10.1'));
    data.append('ownerUserId', userId('approver@demo.local'));
    data.append('reviewerUserId', '');
    const ok = await bulkAssignResponsesAction(null, data);
    expect(ok).toEqual({ ok: true, message: '2 件の担当を割り当てました。' });
    expect(responseOf('C8.2').ownerUserId).toBe(userId('approver@demo.local'));
    // レビュー担当は「変更しない」（Fixture のまま）
    expect(responseOf('C8.2').reviewerUserId).toBe(userId('reviewer@demo.local'));

    // 作成担当とレビュー担当が同じ人になる割当は、理由を返して 1 件も書き換えない
    const conflict = new FormData();
    conflict.append('periodId', PERIOD_IDS.fy2026);
    conflict.append('selected', cdpItemId('C10.1'));
    conflict.append('ownerUserId', userId('reviewer@demo.local'));
    expect(await bulkAssignResponsesAction(null, conflict)).toEqual({
      ok: false,
      message: '作成担当とレビュー担当は別の人にしてください。',
    });
    expect(responseOf('C10.1').ownerUserId).toBe(userId('approver@demo.local'));

    const same = new FormData();
    same.append('periodId', PERIOD_IDS.fy2026);
    same.append('selected', cdpItemId('C8.2'));
    same.append('ownerUserId', 'none');
    same.append('reviewerUserId', 'none');
    expect(await bulkAssignResponsesAction(null, same)).toEqual({
      ok: true,
      message: '1 件の担当を割り当てました。',
    });

    const none = new FormData();
    none.append('periodId', PERIOD_IDS.fy2026);
    none.append('ownerUserId', userId('reviewer@demo.local'));
    expect(await bulkAssignResponsesAction(null, none)).toEqual({
      ok: false,
      message: '質問を 1 件以上選んでください。',
    });
  });
});

// ----------------------------------------------------------------------
// C-02 回答の開始・C-09 年度更新
// ----------------------------------------------------------------------

describe('回答の開始（C-02）と年度更新（C-09）', () => {
  function addFy2027(): ReportingPeriod {
    const fy2026 = FY2026();
    const fy2027: ReportingPeriod = {
      ...fy2026,
      id: fid('period', 'AOMI/FY2027'),
      code: 'FY2027',
      label: '2027年度',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
      status: 'collecting',
    };
    fixture.periods.push(fy2027);
    periods = [...periods, fy2027];
    return fy2027;
  }

  it('回答の行が無い年度は、読込では行を作らない（一覧は未着手）', async () => {
    const fy2027 = addFy2027();
    const spy = new WriteDetectingDbClient(db);
    const ws = (await loadDisclosureWorkspace(spy, manager(), 'cdp', fy2027, periods, []))!;
    expect(spy.writes).toEqual([]);
    expect(ws.rows.every((r) => r.response === null)).toBe(true);
    // 同じ年の版が無い期間は公開中の版（2026 年版）
    expect(ws.versionLabel).toBe('CDP 2026（架空）');
  });

  it('最初の保存で回答を作り、前の期間の同じ質問の回答を前年回答にする', async () => {
    const fy2027 = addFy2027();
    const version = await write.startDisclosureResponse(db, manager(), {
      itemId: cdpItemId('C6.1'),
      periodId: fy2027.id,
      answerText: '2027 年度の回答',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    const created = fixture.disclosureResponses.find(
      (r) => r.itemId === cdpItemId('C6.1') && r.reportingPeriodId === fy2027.id,
    )!;
    expect(created.status).toBe('draft');
    expect(created.currentVersionId).toBe(version.id);
    expect(created.previousResponseId).toBe(responseOf('C6.1').id);
    // 2 回目は同じ行を返す（重複して作らない）
    const again = await write.ensureDisclosureResponse(db, manager(), {
      itemId: cdpItemId('C6.1'),
      periodId: fy2027.id,
    });
    expect(again.id).toBe(created.id);
  });

  it('最初の AI 草案でも回答を作る（草案は下書きの版。承認しない）', async () => {
    const fy2027 = addFy2027();
    const result = await write.startDisclosureDraft(db, manager(), {
      itemId: cdpItemId('C12.1'),
      periodId: fy2027.id,
    });
    expect(result.version.originatedFromAiRunId).toBe(result.aiRunId);
    const created = fixture.disclosureResponses.find(
      (r) => r.itemId === cdpItemId('C12.1') && r.reportingPeriodId === fy2027.id,
    )!;
    expect(created.status).toBe('draft');
  });

  it('期間の版でない質問・SSBJ の要求事項・閲覧者は回答を始められない', async () => {
    await expect(
      write.ensureDisclosureResponse(db, manager(), {
        itemId: cdpItemId('C0.1', 2025),
        periodId: PERIOD_IDS.fy2026,
      }),
    ).rejects.toThrow(/2026年度|FY2026|含まれないため/);
    const ssbjItem = fixture.disclosureItems.find((i) => i.code === '一般-9')!;
    await expect(
      write.ensureDisclosureResponse(db, manager(), {
        itemId: ssbjItem.id,
        periodId: PERIOD_IDS.fy2026,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      write.ensureDisclosureResponse(db, viewer(), {
        itemId: cdpItemId('C6.1'),
        periodId: PERIOD_IDS.fy2026,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('期間の版で一覧を出す（FY2025 は 2025 年版と FY2025 の承認済みの回答）', async () => {
    const fy2025 = periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const ws = await workspace(manager(), fy2025);
    expect(ws.versionLabel).toBe('CDP 2025（架空）');
    expect(ws.periodVersionId).toBe(fid('framework_version', 'cdp/2025'));
    expect(ws.rows).toHaveLength(10);
    expect(ws.rows.every((r) => r.response?.status === 'approved')).toBe(true);
  });

  it('版を選ぶと一覧に効く（FY2026 で 2025 年版を選ぶと、その版の質問構成。回答は無い）', async () => {
    const ws = await workspace(manager(), FY2026(), fid('framework_version', 'cdp/2025'));
    expect(ws.version.id).toBe(fid('framework_version', 'cdp/2025'));
    expect(ws.periodVersionId).toBe(fid('framework_version', 'cdp/2026'));
    expect(ws.rows).toHaveLength(10);
    expect(ws.rows.every((r) => r.response === null)).toBe(true);
    // 他の基準の版は無視する（期間の版のまま）
    const ignored = await workspace(manager(), FY2026(), fid('framework_version', 'ssbj/2026'));
    expect(ignored.version.id).toBe(fid('framework_version', 'cdp/2026'));
  });

  it('前の版との比較は版どうしを比べて出す（2026 年版の追加は新規の 2 問）', async () => {
    const ws = await workspace();
    expect(ws.previousVersion?.label).toBe('CDP 2025（架空）');
    expect(ws.versionDiff!.added.map((e) => e.toCode).sort()).toEqual(['C1.2', 'C12.1']);
    expect(ws.versionDiff!.removed).toEqual([]);
  });
});

// ----------------------------------------------------------------------
// C-03 対応付け
// ----------------------------------------------------------------------

describe('指標の対応付け（C-03・不具合 B-3）', () => {
  it('外すと一覧・不足に効き、AI の候補を人が確定すると戻る（候補のまま確定はしない）', async () => {
    const mapping = fixture.disclosureMappings.find(
      (m) => m.itemId === cdpItemId('C6.1') && m.metricId === metricId('AOMI', 'scope1'),
    )!;
    await write.removeDisclosureMapping(db, manager(), { mappingId: mapping.id });
    // 行は消さずに確定を外す（物理削除しない）
    const after = fixture.disclosureMappings.find((m) => m.id === mapping.id)!;
    expect(after.confirmedAt).toBeNull();
    expect(after.confirmedBy).toBeNull();
    const removed = await rowOf('C6.1');
    expect(removed.mappedMetrics).toEqual([]);
    expect(removed.gaps.unmapped).toBe(true);

    const { run, mappings } = await runQuestionMapping(db, manager(), 'cdp', FY2026(), periods);
    expect(mappings.some((m) => m.itemCode === 'C6.1' && m.metricCode === 'scope1')).toBe(true);
    // AI を実行しただけでは対応付けは戻らない
    expect((await rowOf('C6.1')).mappedMetrics).toEqual([]);

    const confirmed = await write.confirmQuestionMappingCandidate(db, manager(), {
      aiRunId: run.id,
      itemCode: 'C6.1',
      metricCode: 'scope1',
    });
    expect(confirmed).toMatchObject({
      mappingSource: 'ai_suggested',
      aiRunId: run.id,
      confirmedBy: userId('sustainability@demo.local'),
    });
    expect((await rowOf('C6.1')).mappedMetrics.map((m) => m.code)).toEqual(['scope1']);
  });

  it('候補に無い組み合わせ・他組織の実行は確定できない', async () => {
    const mapping = fixture.disclosureMappings.find((m) => m.itemId === cdpItemId('C6.1'))!;
    await write.removeDisclosureMapping(db, manager(), { mappingId: mapping.id });
    const { run } = await runQuestionMapping(db, manager(), 'cdp', FY2026(), periods);
    await expect(
      write.confirmQuestionMappingCandidate(db, manager(), {
        aiRunId: run.id,
        itemCode: 'C6.1',
        metricCode: 'energy',
      }),
    ).rejects.toThrow('この組み合わせは AI の候補にありません。');
    await expect(
      write.confirmQuestionMappingCandidate(db, otherOrg(), {
        aiRunId: run.id,
        itemCode: 'C6.1',
        metricCode: 'scope1',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('手動で追加でき、重複は断る。CSRD の項目の対応付けはこの画面から変えない', async () => {
    await write.addDisclosureMapping(db, manager(), {
      itemId: cdpItemId('C12.1'),
      metricId: metricId('AOMI', 'energy'),
    });
    expect((await rowOf('C12.1')).mappedMetrics.map((m) => m.code)).toEqual(['energy']);
    await expect(
      write.addDisclosureMapping(db, manager(), {
        itemId: cdpItemId('C12.1'),
        metricId: metricId('AOMI', 'energy'),
      }),
    ).rejects.toThrow('この指標は既に対応付けています。');
    await expect(
      write.addDisclosureMapping(db, manager(), {
        itemId: csrdItems()[0]!.id,
        metricId: metricId('AOMI', 'energy'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('T4D の情報との対応付け（C-03）', () => {
  const governanceBlock = () =>
    fixture.disclosureBlocks.find((b) => b.approvedVersionId && b.title === 'ガバナンス')!;
  const draftBlock = () => fixture.disclosureBlocks.find((b) => !b.approvedVersionId)!;

  it('確認済みの定性情報・承認済みの原稿・SSBJ の要求事項を対応付け、外せる', async () => {
    const narrative = await write.addResponseContentLink(db, manager(), {
      itemId: cdpItemId('C12.1'),
      targetKind: 'narrative_record',
      targetId: DISCLOSURE_FIRST_IDS.narratives.governance,
    });
    await write.addResponseContentLink(db, manager(), {
      itemId: cdpItemId('C12.1'),
      targetKind: 'disclosure_block',
      targetId: governanceBlock().id,
    });
    const ssbj = fixture.disclosureItems.find((i) => i.code === '一般-9')!;
    await write.addResponseContentLink(db, manager(), {
      itemId: cdpItemId('C12.1'),
      targetKind: 'requirement_item',
      targetId: ssbj.id,
    });

    const row = await rowOf('C12.1');
    expect(row.contentLinks).toHaveLength(3);
    expect(row.gaps.unmapped).toBe(false);
    const links = await loadQuestionLinks(db, manager(), row, FY2026(), []);
    expect(links.narratives[0]).toMatchObject({ usable: true, label: '気候関連のガバナンス体制' });
    expect(links.narratives[0]!.versionNo).not.toBeNull();
    expect(links.blocks[0]!.usable).toBe(true);
    expect(links.requirements[0]!.label).toContain('一般-9');
    // 既に対応付けたものは候補に出さない
    expect(links.candidates.narratives.map((c) => c.id)).not.toContain(
      DISCLOSURE_FIRST_IDS.narratives.governance,
    );

    const removed = await write.removeResponseContentLink(db, manager(), { linkId: narrative.id });
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.deletedBy).toBe(userId('sustainability@demo.local'));
    expect((await rowOf('C12.1')).contentLinks).toHaveLength(2);
    await expect(
      write.removeResponseContentLink(db, manager(), { linkId: narrative.id }),
    ).rejects.toThrow('この対応付けは既に外れています。');
  });

  it('下書きの定性情報・未承認の原稿・SSBJ 以外の項目・重複は対応付けない', async () => {
    await expect(
      write.addResponseContentLink(db, manager(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'narrative_record',
        targetId: DISCLOSURE_FIRST_IDS.narratives.riskPhysical,
      }),
    ).rejects.toThrow('確認済みの版がある定性情報だけを対応付けられます。');
    await expect(
      write.addResponseContentLink(db, manager(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'disclosure_block',
        targetId: draftBlock().id,
      }),
    ).rejects.toThrow('承認済みの原稿の節だけを対応付けられます。');
    await expect(
      write.addResponseContentLink(db, manager(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'requirement_item',
        targetId: cdpItemId('C6.1'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await write.addResponseContentLink(db, manager(), {
      itemId: cdpItemId('C0.1'),
      targetKind: 'narrative_record',
      targetId: DISCLOSURE_FIRST_IDS.narratives.governance,
    });
    await expect(
      write.addResponseContentLink(db, manager(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'narrative_record',
        targetId: DISCLOSURE_FIRST_IDS.narratives.governance,
      }),
    ).rejects.toThrow('この情報は既に対応付けています。');
  });

  it('他組織の定性情報は「見つかりません」。閲覧者は対応付けられない', async () => {
    // 越権テスト用の組織にも契約があるものとして、テナントの検査だけを確かめる
    for (const option of fixture.organizationOptions) {
      if (option.organizationId === ORG_IDS.soten) option.enabled = true;
    }
    await expect(
      write.addResponseContentLink(db, otherOrg(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'narrative_record',
        targetId: DISCLOSURE_FIRST_IDS.narratives.governance,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      write.addResponseContentLink(db, viewer(), {
        itemId: cdpItemId('C0.1'),
        targetKind: 'narrative_record',
        targetId: DISCLOSURE_FIRST_IDS.narratives.governance,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

// ----------------------------------------------------------------------
// C-04 根拠の再利用
// ----------------------------------------------------------------------

describe('根拠の再利用（C-04）', () => {
  it('対応付けた指標の承認済みデータの根拠を候補にし、人が選んで紐付ける（一覧の根拠件数に数える）', async () => {
    const row = await rowOf('C6.1');
    const candidates = await evidenceEntriesForRow(db, ORG_IDS.aomi, row, FY2026());
    expect(candidates.length).toBeGreaterThan(0);
    const before = row.evidenceCount;

    await write.linkResponseEvidence(db, manager(), {
      responseId: responseOf('C6.1').id,
      evidenceLinkId: candidates[0]!.evidenceLinkId,
    });
    expect((await rowOf('C6.1')).evidenceCount).toBe(before + 1);
    const links = await loadQuestionLinks(db, manager(), await rowOf('C6.1'), FY2026(), []);
    expect(links.evidence.linked.map((e) => e.evidenceLinkId)).toContain(
      candidates[0]!.evidenceLinkId,
    );
    expect(links.evidence.candidates.map((e) => e.evidenceLinkId)).not.toContain(
      candidates[0]!.evidenceLinkId,
    );

    await expect(
      write.linkResponseEvidence(db, manager(), {
        responseId: responseOf('C6.1').id,
        evidenceLinkId: candidates[0]!.evidenceLinkId,
      }),
    ).rejects.toThrow('この根拠は既に紐付けています。');
  });

  it('対応付けていない指標の根拠・閲覧者の操作は受け付けない', async () => {
    const energy = await evidenceEntriesForRow(db, ORG_IDS.aomi, await rowOf('C8.2'), FY2026());
    await expect(
      write.linkResponseEvidence(db, manager(), {
        responseId: responseOf('C6.1').id,
        evidenceLinkId: energy[0]!.evidenceLinkId,
      }),
    ).rejects.toThrow('対応付けた指標の承認済みデータに付いた根拠だけを紐付けられます。');
    const scope1 = await evidenceEntriesForRow(db, ORG_IDS.aomi, await rowOf('C6.1'), FY2026());
    await expect(
      write.linkResponseEvidence(db, viewer(), {
        responseId: responseOf('C6.1').id,
        evidenceLinkId: scope1[0]!.evidenceLinkId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

// ----------------------------------------------------------------------
// C-06 不足
// ----------------------------------------------------------------------

describe('不足（C-06）', () => {
  it('データ不足・未対応付けを数え、「不足あり」で絞り込める', async () => {
    const ws = await workspace();
    const c12 = ws.rows.find((r) => r.item.code === 'C12.1')!;
    expect(c12.gaps.unmapped).toBe(true);
    const c12Ratio = ws.rows.find((r) => r.item.code === 'C1.2')!;
    expect(c12Ratio.gaps.dataMissing).toBe(1);
    expect(ws.summary.withGaps).toBe(ws.rows.filter((r) => r.gaps.total > 0).length);
    const filtered = filterDisclosureRows(ws.rows, { gap: '1' });
    expect(filtered.length).toBe(ws.summary.withGaps);
    expect(filtered.every((r) => r.gaps.total > 0)).toBe(true);
  });

  it('AI 草案の「埋められなかった情報」を不足に数える（承認済みの回答では数えない）', async () => {
    await write.generateDisclosureDraft(db, manager(), responseOf('C12.1').id);
    const row = await rowOf('C12.1');
    expect(row.gaps.aiMissing.length).toBeGreaterThan(0);
    expect(row.gaps.total).toBe(1 + row.gaps.aiMissing.length);
  });

  it('整合チェックの指摘を質問ごとに引ける（直近の実行）', async () => {
    const { run } = await runDisclosureConsistencyCheck(db, manager(), 'cdp', FY2026(), periods);
    const latest = (await loadLatestConsistencyIssues(db, manager(), await workspace()))!;
    expect(latest.run.id).toBe(run.id);
    expect(latest.byItemId.size).toBeGreaterThan(0);
    expect(issueTargetsCode('C1.1', 'C1.1')).toBe(true);
    expect(issueTargetsCode('C1.1b の記述', 'C1.1')).toBe(false);
    expect(issueTargetsCode('C1.1b の記述', 'C1.1b')).toBe(true);
    expect(issueTargetsCode('（C6.1）前年と同じ', 'C6.1')).toBe(true);
  });
});

// ----------------------------------------------------------------------
// C-07 承認の職務分離
// ----------------------------------------------------------------------

describe('承認の職務分離（C-07。CDP・CSRD 共通）', () => {
  it('現在の版を作った人は承認できず、別の承認者は承認できる（CDP）', async () => {
    const response = responseOf('C0.1');
    await write.saveDisclosureResponse(db, approver(), {
      responseId: response.id,
      answerText: '承認者が自分で書いた回答',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    await expect(
      write.transitionDisclosureResponse(db, approver(), response.id, 'approved'),
    ).rejects.toThrow(RESPONSE_AUTHOR_APPROVAL_REASON);
    expect(responseOf('C0.1').status).toBe('draft');

    const approved = await write.transitionDisclosureResponse(
      db,
      secondApprover(),
      response.id,
      'approved',
    );
    expect(approved.approvedBy).toBe(userId('enterprise-admin@demo.local'));
  });

  it('CSRD の回答も同じ（作成者は承認できない）', async () => {
    const itemIds = new Set(csrdItems().map((i) => i.id));
    const response = fixture.disclosureResponses.find(
      (r) => itemIds.has(r.itemId) && r.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    await write.saveDisclosureResponse(db, approver(), {
      responseId: response.id,
      answerText: 'CSRD の回答',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    await expect(
      write.transitionDisclosureResponse(db, approver(), response.id, 'approved'),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await write.transitionDisclosureResponse(db, secondApprover(), response.id, 'approved');
  });
});

// ----------------------------------------------------------------------
// C-08 出力
// ----------------------------------------------------------------------

describe('出力（C-08）', () => {
  function csvLines(text: string): string[] {
    // 先頭の BOM（Excel 向け）を外して行に分ける
    return text
      .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')
      .split(/\r?\n/)
      .filter(Boolean);
  }

  it('担当・承認者・承認日時・版の列があり、?approvedOnly=1 で承認済みだけを出す', async () => {
    await write.saveDisclosureResponse(db, manager(), {
      responseId: responseOf('C0.1').id,
      answerText: '承認する回答',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    await write.transitionDisclosureResponse(db, approver(), responseOf('C0.1').id, 'approved');

    const all = await GET(new Request('http://localhost/api/exports/cdp?format=csv'));
    expect(all.status).toBe(200);
    const allLines = csvLines(await all.text());
    for (const header of ['作成担当', 'レビュー担当', '承認者', '承認日時', '版']) {
      expect(allLines[0]).toContain(header);
    }
    expect(allLines).toHaveLength(1 + 12);

    const approvedOnly = await GET(
      new Request('http://localhost/api/exports/cdp?format=csv&approvedOnly=1'),
    );
    const lines = csvLines(await approvedOnly.text());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('C0.1');
    expect(lines[1]).toContain('承認する回答');
    expect(decodeURIComponent(approvedOnly.headers.get('Content-Disposition') ?? '')).toContain(
      '承認済み',
    );
  });
});
