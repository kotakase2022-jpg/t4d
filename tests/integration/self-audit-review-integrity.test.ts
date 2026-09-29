import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { DbClient } from '@/lib/repositories/types';
import {
  AI_RUN_UNAVAILABLE_MESSAGE,
  BlockConflictError,
  BlockRefValidationError,
  VERSION_UNAVAILABLE_MESSAGE,
  autosaveWorkingBody,
  getBlockEditorData,
  listProjectBlocks,
  saveBlockVersion,
  validateBodyRefs,
} from '@/lib/services/disclosure-block';
import { updateProject } from '@/lib/services/disclosure-project';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  ReviewBlockedError,
  addReviewComment,
  completeReview,
  finalApprove,
  requestReview,
  reviewActionsFor,
} from '@/lib/services/disclosure-review';
import {
  evaluateReportReadiness,
  loadOwnedProject,
  loadOwnedSnapshot,
} from '@/lib/services/report-snapshot';
import type { AuthorizationContext, BlockBody, DataPointVersion, RoleKey } from '@/types/domain';

/**
 * 自己監査（2026-09-29）で見つかった、レビュー・承認・再確認の整合の不具合の回帰テスト。
 * 各テストの見出しに指摘の ID を付ける（AI_HANDOFF.md の一覧と対応する）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

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
      organizationName: organizationId === ORG_IDS.aomi ? '青海テクノロジー株式会社' : '蒼天',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const PROJECT = IDS.projects.fy2026;
const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const GOVERNANCE = IDS.blocks.fy2026Governance.block;
const METRICS = IDS.blocks.fy2026Metrics.block;

function blockRow(id: string) {
  const row = fixture.disclosureBlocks.find((b) => b.id === id);
  if (!row) throw new Error(`block ${id}`);
  return row;
}

function versionRow(id: string | null) {
  const row = fixture.disclosureBlockVersions.find((v) => v.id === id);
  if (!row) throw new Error(`version ${id}`);
  return row;
}

function withParagraph(body: BlockBody, id: string, text: string): BlockBody {
  return {
    paragraphs: [...body.paragraphs, { id, kind: 'paragraph', children: [{ t: 'text', text }] }],
  };
}

function riskBody(extraId: string, text: string): BlockBody {
  return withParagraph(versionRow(blockRow(RISK).currentVersionId).body, extraId, text);
}

// ----------------------------------------------------------------------
// INV-F2: 作業本文を書いた人の職務分離
// ----------------------------------------------------------------------

describe('INV-F2 作業本文を自動保存した人は、別の人が依頼した版をレビュー・承認できない', () => {
  it('承認者が自動保存した段落を担当者が依頼すると、承認者を書いた人として版に残す', async () => {
    const block = blockRow(RISK);
    await autosaveWorkingBody(db, approver(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('appr-1', '承認者が書いた段落。'),
    });
    expect(blockRow(RISK).workingContributorIds).toEqual([userId('approver@demo.local')]);

    // 最終承認者（プロジェクトの指定: 承）が本文を書いているため、依頼の時点で止める
    await expect(requestReview(db, author(), { blockId: RISK })).rejects.toThrow(
      '最終承認者に指定した人は、この版の本文を書いています',
    );
    // 最終承認者を未定にして依頼しても、版には承が「書いた人」として残り、承は承認できない
    const { request, version } = await requestReview(db, author(), {
      blockId: RISK,
      approverUserId: null,
    });
    expect(version.createdBy).toBe(userId('sustainability@demo.local'));
    expect(version.contributorUserIds).toEqual([userId('approver@demo.local')]);
    expect(version.body.paragraphs.some((p) => p.id === 'appr-1')).toBe(true);
    await completeReview(db, reviewer(), { requestId: request.id });

    const actions = await reviewActionsFor(
      db,
      approver(),
      fixture.reviewRequests.find((r) => r.id === request.id)!,
    );
    expect(actions.canApprove).toBe(false);
    expect(actions.reasons.join(' ')).toContain('本文を書いた本人');
    await expect(finalApprove(db, approver(), { requestId: request.id })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(blockRow(RISK).status).toBe('approval_pending');
  });

  it('本文を書いた人はレビュー担当としてもレビューを完了できない', async () => {
    const block = blockRow(RISK);
    await autosaveWorkingBody(db, reviewer(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('rev-1', 'レビュー担当が書いた段落。'),
    });
    await expect(requestReview(db, author(), { blockId: RISK })).rejects.toThrow(
      'レビュー担当に指定した人は、この版の本文を書いています',
    );
    const { request } = await requestReview(db, author(), {
      blockId: RISK,
      reviewerUserId: null,
    });
    await expect(completeReview(db, reviewer(), { requestId: request.id })).rejects.toThrow(
      '本文を書いた本人',
    );
  });
});

// ----------------------------------------------------------------------
// INV-F3 / SEC-F1: 第 1 段を飛ばした最終承認
// ----------------------------------------------------------------------

describe('INV-F3 レビュー（第 1 段）の完了記録が無い依頼は最終承認できない', () => {
  it('状態だけ「レビュー完了」に書き換えても、記録が無ければ承認しない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    const approvedBefore = fixture.reviewEvents.filter((e) => e.eventType === 'approved').length;
    // DB を直接書き換えた状態（review_completed の記録なし）
    const index = fixture.reviewRequests.findIndex((r) => r.id === request.id);
    fixture.reviewRequests[index] = { ...request, status: 'reviewed' };
    const blockIndex = fixture.disclosureBlocks.findIndex((b) => b.id === RISK);
    fixture.disclosureBlocks[blockIndex] = { ...blockRow(RISK), status: 'approval_pending' };

    const actions = await reviewActionsFor(db, approver(), fixture.reviewRequests[index]!);
    expect(actions.canApprove).toBe(false);
    expect(actions.reasons.join(' ')).toContain('レビュー（第 1 段）の完了記録が無い');
    await expect(finalApprove(db, approver(), { requestId: request.id })).rejects.toThrow(
      'レビュー（第 1 段）の完了記録が無い',
    );
    expect(fixture.reviewEvents.filter((e) => e.eventType === 'approved')).toHaveLength(
      approvedBefore,
    );
    expect(blockRow(RISK).status).toBe('approval_pending');
  });
});

// ----------------------------------------------------------------------
// INV-F8: 別の人の自動保存を黙って上書き・破棄しない
// ----------------------------------------------------------------------

describe('INV-F8 別の人の作業本文を上書き・破棄しない', () => {
  it('読み込んだ後に別の人が自動保存していれば、自動保存も版の保存も競合として止める', async () => {
    const block = blockRow(RISK);
    // B（検見川）は A の自動保存より前に画面を開いた（作業本文なし）
    const tokenOfB = null;
    const saved = await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('a-1', 'A の段落。'),
      knownWorkingSavedAt: null,
    });
    expect(saved.status).toBe('saved');

    const overwrite = await autosaveWorkingBody(db, reviewer(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('b-1', 'B の段落。'),
      knownWorkingSavedAt: tokenOfB,
    });
    expect(overwrite.status).toBe('conflict');
    expect(overwrite.status === 'conflict' && overwrite.kind).toBe('working');
    // A の作業本文は残る
    expect(blockRow(RISK).workingBody?.paragraphs.some((p) => p.id === 'a-1')).toBe(true);

    const error = await saveBlockVersion(db, reviewer(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('b-1', 'B の段落。'),
      changeReason: 'B の版',
      knownWorkingSavedAt: tokenOfB,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockConflictError);
    expect((error as BlockConflictError).kind).toBe('working');
    expect(blockRow(RISK).workingBody?.paragraphs.some((p) => p.id === 'a-1')).toBe(true);

    // A の本文を読み込んだ（保存時刻を知っている）B は保存でき、A も書いた人として残る
    const token = saved.status === 'saved' ? saved.savedAt : null;
    const merged = await autosaveWorkingBody(db, reviewer(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: withParagraph(riskBody('a-1', 'A の段落。'), 'b-1', 'B の段落。'),
      knownWorkingSavedAt: token,
    });
    expect(merged.status).toBe('saved');
    expect([...blockRow(RISK).workingContributorIds].sort()).toEqual(
      [userId('sustainability@demo.local'), userId('reviewer@demo.local')].sort(),
    );
  });

  it('自分の自動保存（別のタブ・古いトークン）は競合にしない', async () => {
    const block = blockRow(RISK);
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('a-1', 'A の段落。'),
      knownWorkingSavedAt: null,
    });
    const again = await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('a-2', 'A の別の段落。'),
      knownWorkingSavedAt: null,
    });
    expect(again.status).toBe('saved');
  });
});

// ----------------------------------------------------------------------
// INV-F9 / PER-F1: レビュー依頼で作る版
// ----------------------------------------------------------------------

describe('INV-F9 断られたレビュー依頼は版を作らず、自動保存も消さない', () => {
  it('阻害条件があれば、版を作る前に止める', async () => {
    const block = blockRow(RISK);
    await addReviewComment(db, reviewer(), {
      blockId: RISK,
      paragraphId: 'risk-3',
      body: '財務的影響の記載方針を確認してください。',
      severity: 'major',
    });
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: riskBody('w-1', '自動保存の段落。'),
    });
    const before = fixture.disclosureBlockVersions.filter((v) => v.blockId === RISK).length;
    const auditsBefore = fixture.auditEvents.length;
    const error = await requestReview(db, author(), { blockId: RISK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect(fixture.disclosureBlockVersions.filter((v) => v.blockId === RISK)).toHaveLength(before);
    expect(blockRow(RISK).currentVersionId).toBe(block.currentVersionId);
    expect(blockRow(RISK).workingBody?.paragraphs.some((p) => p.id === 'w-1')).toBe(true);
    expect(
      fixture.auditEvents.slice(auditsBefore).some((e) => e.eventType === 'block_version_created'),
    ).toBe(false);
  });
});

describe('PER-F1 画面の本文を提出する（作業本文が別のサーバーにしか無くても古い版を出さない）', () => {
  it('サーバーに作業本文が無くても、送られた本文から版を作って依頼する', async () => {
    const block = blockRow(RISK);
    expect(block.workingBody).toBeNull();
    const body = riskBody('client-1', '画面で書いた段落。');
    const result = await requestReview(db, author(), {
      blockId: RISK,
      body,
      baseVersionId: block.currentVersionId,
      knownWorkingSavedAt: null,
    });
    expect(result.createdVersion).toBe(true);
    expect(result.version.body.paragraphs.some((p) => p.id === 'client-1')).toBe(true);
    expect(result.request.targetVersionId).toBe(result.version.id);
    expect(result.notified).toBe(true);
  });

  it('画面が古い版を土台にしていれば、依頼せず競合として返す', async () => {
    const block = blockRow(RISK);
    const error = await requestReview(db, author(), {
      blockId: RISK,
      body: riskBody('client-1', '画面で書いた段落。'),
      baseVersionId: fid('disclosure_block_version', 'stale'),
      knownWorkingSavedAt: null,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockConflictError);
    expect(fixture.reviewRequests.filter((r) => r.targetId === RISK)).toHaveLength(0);
    expect(blockRow(RISK).currentVersionId).toBe(block.currentVersionId);
  });
});

describe('UX-F10 通知できたかを返す（レビュー担当が未定なら通知したと言わない）', () => {
  it('レビュー担当が未定の依頼は notified = false', async () => {
    const result = await requestReview(db, author(), { blockId: RISK, reviewerUserId: null });
    expect(result.notified).toBe(false);
  });
});

// ----------------------------------------------------------------------
// SEC-F4 / PER-F9: 作業本文の参照
// ----------------------------------------------------------------------

describe('SEC-F4 別組織の行を指す参照は作業本文にも保存できず、名前も漏らさない', () => {
  it('他社の引用位置を自動保存できない', async () => {
    // 蒼天（別テナント）の引用位置。青海の利用者がその ID を本文に入れて送る
    const foreignAnchor = fid('source_anchor', 'test/soten-anchor');
    fixture.sourceAnchors.push({
      ...fixture.sourceAnchors[0]!,
      id: foreignAnchor,
      organizationId: ORG_IDS.soten,
    });
    const block = blockRow(RISK);
    const body: BlockBody = {
      paragraphs: [
        ...versionRow(block.currentVersionId).body.paragraphs,
        { id: 'x-1', kind: 'paragraph', children: [{ t: 'cite', sourceAnchorId: foreignAnchor }] },
      ],
    };
    await expect(
      autosaveWorkingBody(db, author(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body,
      }),
    ).rejects.toBeInstanceOf(BlockRefValidationError);
    expect(blockRow(RISK).workingBody).toBeNull();

    // 既に本文に入っていても（古い Cookie など）、鮮度の表示に他社の資料名・位置を出さない
    const freshness = await computeBlockFreshness(db, author(), block, body);
    const item = freshness.items.find((i) => i.oldRefId === foreignAnchor);
    expect(item?.label).toBe('出典の資料が見つかりません');
    expect(item?.oldDisplay).toBe('—');
  });
});

describe('PER-F9 AI の実行記録が見つからないだけなら、改ざんと同じ文言で責めない', () => {
  it('見つからない実行 ID は、別のサーバーの可能性を示す理由を返す', async () => {
    const body: BlockBody = {
      paragraphs: [
        {
          id: 'ai-1',
          kind: 'paragraph',
          children: [{ t: 'text', text: '採用した段落。' }],
          aiRunId: fid('ai_run', 'missing'),
        },
      ],
    };
    const issues = await validateBodyRefs(db, author(), RISK, body);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(AI_RUN_UNAVAILABLE_MESSAGE);
  });
});

// ----------------------------------------------------------------------
// PER-F4 / UX-F4: 再確認
// ----------------------------------------------------------------------

describe('PER-F4 版を読めない節を「現行」と示さない', () => {
  it('現在の版が無ければ「版を読み込めません」とし、再確認の判断も理由を示して止める', async () => {
    const index = fixture.disclosureBlockVersions.findIndex(
      (v) => v.id === blockRow(METRICS).currentVersionId,
    );
    fixture.disclosureBlockVersions.splice(index, 1);
    const freshness = await computeBlockFreshness(db, author(), blockRow(METRICS));
    expect(freshness.status).toBe('version_unavailable');
    await expect(
      decideRecheck(db, author(), {
        blockId: METRICS,
        refKind: 'metric',
        oldRefId: fid('data_point_version', 'any'),
        decision: 'keep_old',
        reason: '理由',
      }),
    ).rejects.toThrow(VERSION_UNAVAILABLE_MESSAGE);
    const list = await listProjectBlocks(db, author(), PROJECT, 'recheck');
    expect(list.rows.some((r) => r.id === METRICS)).toBe(false);
  });
});

describe('UX-F4 再確認の画面に、選べない判断を理由付きで返す', () => {
  function addUnapprovedVersion(dataPointId: string): DataPointVersion {
    const dp = fixture.dataPoints.find((d) => d.id === dataPointId)!;
    const versions = fixture.dataPointVersions.filter((v) => v.dataPointId === dataPointId);
    const base = versions[versions.length - 1]!;
    const version: DataPointVersion = {
      ...base,
      id: fid('data_point_version', `${dataPointId}/unapproved`),
      versionNo: versions.length + 1,
      status: 'draft',
      changeReason: 'テスト: 未承認の訂正',
      createdAt: new Date().toISOString(),
    };
    fixture.dataPointVersions.push(version);
    const index = fixture.dataPoints.findIndex((d) => d.id === dataPointId);
    fixture.dataPoints[index] = { ...dp, currentVersionId: version.id, status: 'draft' };
    return version;
  }

  it('新しい版が未承認なら「採用」は選べず、承認済みの引用中の版の維持は選べる', async () => {
    const freshness = await computeBlockFreshness(db, author(), blockRow(METRICS));
    const scope1 = freshness.items.find((i) => i.refKind === 'metric')!;
    addUnapprovedVersion(
      fixture.dataPointVersions.find((v) => v.id === scope1.oldRefId)!.dataPointId,
    );
    const after = await computeBlockFreshness(db, author(), blockRow(METRICS));
    const item = after.items.find((i) => i.refKind === 'metric')!;
    expect(item.decisions.adopt_new.allowed).toBe(false);
    expect(item.decisions.adopt_new.reason).toContain('まだ承認されていません');
    expect(item.decisions.keep_old.allowed).toBe(true);
    expect(item.decisions.return_to_owner.allowed).toBe(true);
    // サーバーの判断も画面の表示と同じ（採用は断る）
    await expect(
      decideRecheck(db, author(), {
        blockId: METRICS,
        refKind: 'metric',
        oldRefId: item.oldRefId,
        decision: 'adopt_new',
        reason: null,
      }),
    ).rejects.toThrow('まだ承認されていません');
  });
});

// ----------------------------------------------------------------------
// INV-F6: 報告範囲の変更後の再確認
// ----------------------------------------------------------------------

describe('INV-F6 報告範囲を変えたら、承認済みの節は再確認・再承認が必要', () => {
  async function changeScope() {
    const project = fixture.disclosureProjects.find((p) => p.id === PROJECT)!;
    return updateProject(
      db,
      author(),
      PROJECT,
      {
        name: project.name,
        reportingEntity: project.reportingEntity,
        periodStart: project.periodStart,
        periodEnd: project.periodEnd,
        currency: project.currency,
        dueDate: project.dueDate,
        status: project.status,
        ownerUserId: project.ownerUserId,
        reviewerUserId: project.reviewerUserId,
        finalApproverUserId: project.finalApproverUserId,
        languages: project.languages,
        scopeOrgNote: project.scopeOrgNote,
        scopeConsolidationNote: project.scopeConsolidationNote,
        scopeGhgBoundaryNote: '単体（本社のみ）で集計する（テスト）。',
        scopeValueChainNote: project.scopeValueChainNote,
        includedUnitIds: project.includedUnitIds,
      },
      { confirmImpact: true },
    );
  }

  it('範囲を変えると改訂番号が上がり、確定の阻害条件と原稿画面の注意になる', async () => {
    const result = await changeScope();
    expect(result.status).toBe('saved');
    expect(fixture.disclosureProjects.find((p) => p.id === PROJECT)?.scopeRevision).toBe(1);

    const readiness = await evaluateReportReadiness(db, approver(), PROJECT);
    const scope = readiness.blockers.filter((b) => b.code === 'scope_changed');
    expect(scope.map((b) => b.blockId)).toContain(GOVERNANCE);

    const editor = await getBlockEditorData(db, author(), PROJECT, GOVERNANCE);
    expect(editor.block.scopeRecheckNeeded).toBe(true);

    // 本文を変えなくても、範囲の変更を確認した版として再承認に回せる
    const governance = blockRow(GOVERNANCE);
    const saved = await saveBlockVersion(db, author(), {
      blockId: GOVERNANCE,
      baseVersionId: governance.currentVersionId,
      body: versionRow(governance.currentVersionId).body,
      changeReason: '報告範囲の変更を確認（本文の変更なし）',
    });
    expect(saved.version.versionNo).toBe(2);
    expect(blockRow(GOVERNANCE).status).toBe('draft');
  });

  it('依頼の後に範囲を変えたら、その依頼は最終承認できない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    await changeScope();
    await expect(finalApprove(db, approver(), { requestId: request.id })).rejects.toThrow(
      '報告範囲',
    );
  });
});

// ----------------------------------------------------------------------
// INV-F5 / PER-F8: レポート確定の阻害条件
// ----------------------------------------------------------------------

describe('INV-F5 必須言語と翻訳の鮮度をレポートの確定で確かめる', () => {
  it('プロジェクトの言語に英語があるのに英語の節が無ければ確定できない', async () => {
    const index = fixture.disclosureProjects.findIndex((p) => p.id === PROJECT);
    fixture.disclosureProjects[index] = {
      ...fixture.disclosureProjects[index]!,
      languages: ['ja', 'en'],
    };
    const readiness = await evaluateReportReadiness(db, approver(), PROJECT);
    const missing = readiness.blockers.filter((b) => b.code === 'translation_missing');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]?.message).toContain('英語');
    expect(readiness.canConfirm).toBe(false);
  });

  it('翻訳元の承認済みの版より前の版を訳したままの翻訳版は確定できない', async () => {
    const governance = blockRow(GOVERNANCE);
    const sourceVersion = versionRow(governance.approvedVersionId);
    const translationId = fid('disclosure_block', 'test/governance-en');
    const translationVersionId = fid('disclosure_block_version', 'test/governance-en/v1');
    fixture.disclosureBlockVersions.push({
      ...sourceVersion,
      id: translationVersionId,
      blockId: translationId,
      // 翻訳元の承認済みの版より前に作った翻訳
      createdAt: new Date(new Date(sourceVersion.createdAt).getTime() - 60_000).toISOString(),
    });
    fixture.disclosureBlocks.push({
      ...governance,
      id: translationId,
      language: 'en',
      translationOfBlockId: GOVERNANCE,
      currentVersionId: translationVersionId,
      submittedVersionId: translationVersionId,
      approvedVersionId: translationVersionId,
      status: 'approved',
    });
    const readiness = await evaluateReportReadiness(db, approver(), PROJECT);
    expect(readiness.blockers.some((b) => b.code === 'translation_stale')).toBe(true);
  });
});

describe('PER-F8 承認済みの版を読めないときは「未承認（承認済み）」と矛盾した理由を出さない', () => {
  it('版が見つからない節は version_missing として示す', async () => {
    const governance = blockRow(GOVERNANCE);
    const index = fixture.disclosureBlockVersions.findIndex(
      (v) => v.id === governance.approvedVersionId,
    );
    fixture.disclosureBlockVersions.splice(index, 1);
    const readiness = await evaluateReportReadiness(db, approver(), PROJECT);
    const forGovernance = readiness.blockers.filter((b) => b.blockId === GOVERNANCE);
    expect(forGovernance.map((b) => b.code)).toContain('version_missing');
    expect(forGovernance.some((b) => b.message.includes('未承認（承認済み）'))).toBe(false);
  });
});

// ----------------------------------------------------------------------
// PER-F11: UUID でない ID
// ----------------------------------------------------------------------

describe('PER-F11 UUID でない ID は DB に問い合わせず「見つからない」にする', () => {
  it('Supabase のように不正な UUID で例外を投げる DB でも NotFound になる', async () => {
    const strict = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'findById') {
          return async (table: string, id: string) => {
            if (!/^[0-9a-f-]{36}$/i.test(id)) {
              throw new Error('invalid input syntax for type uuid (22P02)');
            }
            return target.findById(table as never, id);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as DbClient;
    await expect(loadOwnedSnapshot(strict, admin(), 'abc')).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadOwnedProject(strict, admin(), 'abc')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      getBlockEditorData(strict, admin(), 'not-a-uuid', 'not-a-uuid'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('他テナントの節は引き続き見つからない', async () => {
    await expect(getBlockEditorData(db, otherTenant(), PROJECT, RISK)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
