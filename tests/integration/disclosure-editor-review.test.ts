import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { collectRefs, paragraphText } from '@/lib/domain/disclosure-block';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  BlockConflictError,
  BlockRefValidationError,
  autosaveWorkingBody,
  createBlock,
  getBlockEditorData,
  listProjectBlocks,
  metricDisplay,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  ReviewBlockedError,
  addReviewComment,
  completeReview,
  finalApprove,
  listMyReviewTasks,
  listProjectReviews,
  requestReview,
  resolveReviewComment,
  returnReview,
  reviewActionsFor,
  withdrawReview,
} from '@/lib/services/disclosure-review';
import type { AuthorizationContext, BlockBody, DataPointVersion, RoleKey } from '@/types/domain';

/**
 * 原稿編集・レビュー・再確認（docs/disclosure-first.md §4・§5、指示書 §6.7〜§6.9・§10）。
 *
 * 受入テスト: A24（依頼後の変更で審査対象・規則が変わらない）、A25（承認後の引用数値の更新）、
 * A26（承認直前の参照元更新をサーバーで検知）、A27（差戻し→再提出の追跡）、A28（作成担当の承認拒否・職務分離）。
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
      organizationName: '青海テクノロジー株式会社',
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
const viewer = () => ctxFor('enterprise-admin@demo.local', ['viewer']);
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

/** 上流の数値に新しい版ができた状態を作る（取込・訂正の代わり） */
function addDataPointVersion(dataPointId: string, value: number): DataPointVersion {
  const dp = fixture.dataPoints.find((d) => d.id === dataPointId);
  if (!dp) throw new Error('data point');
  const versions = fixture.dataPointVersions.filter((v) => v.dataPointId === dataPointId);
  const base = versions[versions.length - 1];
  if (!base) throw new Error('version');
  const version: DataPointVersion = {
    ...base,
    id: fid('data_point_version', `${dataPointId}/test/${versions.length + 1}`),
    versionNo: versions.length + 1,
    value,
    status: 'approved',
    changeReason: 'テスト: 承認後の訂正（架空）',
    createdAt: new Date().toISOString(),
  };
  fixture.dataPointVersions.push(version);
  const index = fixture.dataPoints.findIndex((d) => d.id === dataPointId);
  fixture.dataPoints[index] = { ...dp, currentVersionId: version.id, value, status: 'approved' };
  return version;
}

async function reviseRisk(text: string, reason = 'テストの修正') {
  const block = blockRow(RISK);
  const body = withParagraph(versionRow(block.currentVersionId).body, `t-${Date.now()}`, text);
  return saveBlockVersion(db, author(), {
    blockId: RISK,
    baseVersionId: block.currentVersionId,
    body,
    changeReason: reason,
  });
}

describe('原稿編集の画面データ', () => {
  it('要求事項・引用中の定性情報・コメントを 1 画面に集める', async () => {
    const data = await getBlockEditorData(db, author(), PROJECT, RISK);
    expect(data.block.statusLabel).toBe('下書き');
    expect(data.requirements.map((r) => r.code)).toEqual(
      expect.arrayContaining(['気候-19', '気候-21', '気候-22']),
    );
    const cited = data.narratives.filter((n) => n.paragraphIds.length > 0);
    expect(cited.map((n) => n.versionId)).toEqual(
      expect.arrayContaining([
        IDS.narrativeVersions.riskPhysical,
        IDS.narrativeVersions.riskTransition,
        IDS.narrativeVersions.financialImpact,
      ]),
    );
    // 財務的影響の定性情報は影響額が未記入（不足情報として見せる）。定量化しない理由は、
    // 不足情報の代わりではなく横に示す（原稿一覧・スナップショットと同じ判定: domain/narrative-template.ts）
    const financial = data.narratives.find(
      (n) => n.versionId === IDS.narrativeVersions.financialImpact,
    );
    expect(financial?.missingFieldLabels).toContain('影響額');
    expect(financial?.missingFieldLabels).toContain('算定方法・前提');
    expect(financial?.notQuantifiedNote).toContain('影響額を定量化していない理由');
    expect(financial?.notQuantifiedNote).toContain('評価中のため未確定');
    expect(data.comments).toHaveLength(1);
    expect(data.blockers).toEqual([]);
    expect(data.permissions.editable).toBe(true);
    // 目次は同じプロジェクトの節を並び順どおりに出す
    expect(data.siblings.map((s) => s.id)).toEqual([
      GOVERNANCE,
      RISK,
      METRICS,
      IDS.blocks.fy2026Esrs40aGovernance.block,
    ]);
  });

  it('前年の同じ節と本文・前提の差分を出す（前年比較 §6.8）', async () => {
    const data = await getBlockEditorData(db, author(), PROJECT, GOVERNANCE);
    expect(data.priorYear).not.toBeNull();
    expect(data.priorYear?.projectName).toContain('FY2025');
    const changed = data.priorYear?.paragraphDiff.filter((d) => d.kind === 'changed') ?? [];
    expect(changed.map((d) => d.paragraphId)).toEqual(['gov-1', 'gov-2']);
    const frameworkRow = data.priorYear?.metadata.find((m) => m.label === '基準・版');
    expect(frameworkRow?.changed).toBe(false);
    const periodRow = data.priorYear?.metadata.find((m) => m.label === '対象期間');
    expect(periodRow?.changed).toBe(true);
    const narrativeRow = data.priorYear?.metadata.find((m) => m.label === '引用した定性情報');
    expect(narrativeRow?.current).toContain('版 2');
  });

  it('引用した数値に新しい版があれば、状態バーと鮮度に出す（A25）', async () => {
    const data = await getBlockEditorData(db, author(), PROJECT, METRICS);
    expect(data.statusBar.staleRefs.paragraphIds).toEqual(['met-1']);
    expect(data.freshness.status).toBe('upstream_updated');
    const ref = data.metricRefs[0];
    expect(ref?.stale).toBe(true);
    expect(ref?.current?.changeReason).toBe(SCOPE1_CORRECTION.changeReason);
    expect(data.blockers.map((b) => b.code)).toContain('stale_metric_refs');
  });

  it('手書きの数値に同じ単位の参照可能な値があれば警告する', async () => {
    const block = blockRow(RISK);
    const body = withParagraph(
      versionRow(block.currentVersionId).body,
      'hand-1',
      '本社の Scope1 排出量は 1,190.9 t-CO2e でした。',
    );
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body,
    });
    const data = await getBlockEditorData(db, author(), PROJECT, RISK);
    const warning = data.handwrittenWarnings.find((w) => w.paragraphId === 'hand-1');
    expect(warning?.text).toContain('1,190.9');
    expect(warning?.candidates.some((c) => c.sameValue)).toBe(true);
    expect(data.statusBar.unverifiedClaims.paragraphIds).toContain('hand-1');
  });

  it('別の組織の節は存在ごと見せない', async () => {
    await expect(getBlockEditorData(db, otherTenant(), PROJECT, RISK)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('自動保存と版の保存', () => {
  it('自動保存は作業本文だけを更新し、版を作らない', async () => {
    const block = blockRow(RISK);
    const before = fixture.disclosureBlockVersions.length;
    const body = withParagraph(versionRow(block.currentVersionId).body, 'new-1', '追記した段落。');
    const result = await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body,
    });
    expect(result.status).toBe('saved');
    expect(fixture.disclosureBlockVersions.length).toBe(before);
    expect(blockRow(RISK).workingBody?.paragraphs.map((p) => p.id)).toContain('new-1');
    expect(blockRow(RISK).currentVersionId).toBe(block.currentVersionId);
  });

  it('古い版を土台にした保存は上書きせず、両方の本文を返して止める', async () => {
    const block = blockRow(RISK);
    const staleBase = block.currentVersionId;
    await reviseRisk('先に保存された段落。');
    const mine = withParagraph(versionRow(staleBase).body, 'mine', '自分の変更。');
    const error = await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: staleBase,
      body: mine,
      changeReason: '自分の修正',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockConflictError);
    const conflict = error as BlockConflictError;
    expect(
      conflict.currentBody.paragraphs.some((p) => paragraphText(p) === '先に保存された段落。'),
    ).toBe(true);
    expect(conflict.yourBody.paragraphs.some((p) => p.id === 'mine')).toBe(true);
    // 自動保存も同じく競合として返す（作業本文を上書きしない）
    const autosave = await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: staleBase,
      body: mine,
    });
    expect(autosave.status).toBe('conflict');
  });

  it('別組織の数値・改ざんした表示・一致しない引用文は保存できない', async () => {
    const block = blockRow(RISK);
    const base = versionRow(block.currentVersionId).body;
    // 別テナント（蒼天）の数値の版。ID を知っていても引用できないことを確かめる
    const source = fixture.dataPointVersions.find(
      (v) => v.id === SCOPE1_CORRECTION.correctedVersionId,
    )!;
    const foreignDpId = fid('data_point', 'SOTEN/test/scope1');
    fixture.dataPoints.push({
      ...fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!,
      id: foreignDpId,
      organizationId: ORG_IDS.soten,
    });
    const foreign: DataPointVersion = {
      ...source,
      id: fid('data_point_version', 'SOTEN/test/scope1/v1'),
      dataPointId: foreignDpId,
      organizationId: ORG_IDS.soten,
    };
    fixture.dataPointVersions.push(foreign);
    const foreignBody: BlockBody = {
      paragraphs: [
        ...base.paragraphs,
        {
          id: 'x-1',
          kind: 'paragraph',
          children: [
            {
              t: 'metric',
              dataPointId: foreign.dataPointId,
              dataPointVersionId: foreign.id,
              display: metricDisplay(foreign),
            },
          ],
        },
      ],
    };
    await expect(
      saveBlockVersion(db, author(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body: foreignBody,
        changeReason: '別組織の数値',
      }),
    ).rejects.toBeInstanceOf(BlockRefValidationError);

    const tampered: BlockBody = {
      paragraphs: [
        ...base.paragraphs,
        {
          id: 'x-2',
          kind: 'paragraph',
          children: [
            {
              t: 'metric',
              dataPointId: SCOPE1_CORRECTION.dataPointId,
              dataPointVersionId: SCOPE1_CORRECTION.correctedVersionId,
              display: '1 t-CO2e',
            },
          ],
        },
      ],
    };
    const error = await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: tampered,
      changeReason: '表示の改ざん',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockRefValidationError);
    expect((error as BlockRefValidationError).issues[0]?.paragraphId).toBe('x-2');

    const badQuote: BlockBody = {
      paragraphs: [
        ...base.paragraphs,
        {
          id: 'x-3',
          kind: 'paragraph',
          children: [
            {
              t: 'narrative',
              narrativeVersionId: IDS.narrativeVersions.riskPhysical,
              quote: '定性情報に無い文言。',
            },
          ],
        },
      ],
    };
    await expect(
      saveBlockVersion(db, author(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body: badQuote,
        changeReason: '引用文の不一致',
      }),
    ).rejects.toBeInstanceOf(BlockRefValidationError);
  });

  it('閲覧のみの権限では保存できない', async () => {
    const block = blockRow(RISK);
    await expect(
      autosaveWorkingBody(db, viewer(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body: versionRow(block.currentVersionId).body,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('承認後の修正は新しい版を作って下書きへ戻し、承認済みの版は残す（A25）', async () => {
    const block = blockRow(GOVERNANCE);
    const approvedVersion = structuredClone(versionRow(block.approvedVersionId));
    await expect(
      saveBlockVersion(db, author(), {
        blockId: GOVERNANCE,
        baseVersionId: block.currentVersionId,
        body: withParagraph(approvedVersion.body, 'gov-3', '追記。'),
        changeReason: null,
      }),
    ).rejects.toThrow('変更理由');
    const { block: updated, version } = await saveBlockVersion(db, author(), {
      blockId: GOVERNANCE,
      baseVersionId: block.currentVersionId,
      body: withParagraph(approvedVersion.body, 'gov-3', '追記。'),
      changeReason: '委員会の追加開催を反映',
    });
    expect(updated.status).toBe('draft');
    expect(updated.approvedVersionId).toBe(block.approvedVersionId);
    expect(updated.currentVersionId).toBe(version.id);
    expect(version.versionNo).toBe(2);
    expect(versionRow(block.approvedVersionId)).toEqual(approvedVersion);
  });

  it('翻訳版の節を元の節に紐付けて追加し、登録していない基準には作れない', async () => {
    const created = await createBlock(db, author(), {
      projectId: PROJECT,
      frameworkVersionId: blockRow(GOVERNANCE).frameworkVersionId,
      sectionKey: 'governance',
      title: 'Governance',
      language: 'en',
      translationOfBlockId: GOVERNANCE,
    });
    expect(created.translationOfBlockId).toBe(GOVERNANCE);
    expect(created.currentVersionId).toBeNull();
    expect(created.requirementItemIds).toEqual(blockRow(GOVERNANCE).requirementItemIds);

    const csrdSample = fixture.frameworkVersions.find(
      (v) => v.id !== IDS.esrs40aVersion && v.legalStatus === 'sample',
    );
    await expect(
      createBlock(db, author(), {
        projectId: PROJECT,
        frameworkVersionId: csrdSample!.id,
        sectionKey: 'csrd_gov',
        title: 'CSRD',
        language: 'ja',
      }),
    ).rejects.toThrow('登録していない基準');
  });
});

describe('レビュー依頼（A24）', () => {
  it('依頼時に版・規則・適用判断・引用版を固定し、その後の変更で変わらない', async () => {
    const { request, version } = await requestReview(db, author(), { blockId: RISK });
    expect(request.targetVersionId).toBe(version.id);
    expect(request.policyVersion).toBe('sod-3role-v1');
    expect(request.decisionIds).toEqual([IDS.decisions.fy2026Ssbj]);
    expect(request.referencedVersions.narrativeVersionIds).toEqual(
      collectRefs(version.body).narrativeVersionIds,
    );
    expect(blockRow(RISK).status).toBe('review_requested');
    expect(blockRow(RISK).submittedVersionId).toBe(version.id);
    // レビュアーへの通知（タスク）
    expect(
      fixture.notifications.some(
        (n) => n.userId === userId('reviewer@demo.local') && n.title.includes('レビュー依頼'),
      ),
    ).toBe(true);

    // レビュー中は本文を変えられない（審査中の版を上書きしない）
    await expect(
      autosaveWorkingBody(db, author(), {
        blockId: RISK,
        baseVersionId: version.id,
        body: withParagraph(version.body, 'late', '依頼後の変更。'),
      }),
    ).rejects.toThrow('レビュー依頼中');

    // 適用判断を新しく確定しても、依頼が固定した判断の版は変わらない
    const newDecision = fid('project_framework_decision', 'test/new');
    fixture.projectFrameworkDecisions.push({
      id: newDecision,
      organizationId: ORG_IDS.aomi,
      projectFrameworkId: IDS.projectFrameworks.fy2026Ssbj,
      decisionNo: 2,
      applicabilityStatus: 'applicable',
      reason: 'テスト: 判断の更新',
      ruleRef: 'テスト',
      confirmedOn: '2026-08-14',
      transitionalNote: null,
      conditionsSnapshot: {},
      decidedBy: userId('enterprise-admin@demo.local'),
      decidedAt: new Date().toISOString(),
    });
    const pfIndex = fixture.projectFrameworks.findIndex(
      (p) => p.id === IDS.projectFrameworks.fy2026Ssbj,
    );
    fixture.projectFrameworks[pfIndex] = {
      ...fixture.projectFrameworks[pfIndex]!,
      currentDecisionId: newDecision,
    };
    const stored = fixture.reviewRequests.find((r) => r.id === request.id);
    expect(stored?.decisionIds).toEqual([IDS.decisions.fy2026Ssbj]);
    expect(stored?.targetVersionId).toBe(version.id);

    // 取り下げて次の版で再依頼すると、新しい依頼になる（旧依頼は取下げとして残る）
    await withdrawReview(db, author(), { requestId: request.id });
    expect(blockRow(RISK).status).toBe('draft');
    await reviseRisk('再依頼のための追記。');
    const second = await requestReview(db, author(), { blockId: RISK });
    expect(second.request.id).not.toBe(request.id);
    expect(second.request.targetVersionId).not.toBe(request.targetVersionId);
    expect(second.request.decisionIds).toEqual([newDecision]);
    const history = await listProjectReviews(db, author(), PROJECT);
    const risk = history.filter((h) => h.blockId === RISK);
    expect(risk.map((h) => h.status).sort()).toEqual(['open', 'withdrawn']);
  });

  it('作業本文が現在の版と違えば、依頼の前に版を作って固定する', async () => {
    const block = blockRow(RISK);
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: withParagraph(versionRow(block.currentVersionId).body, 'w-1', '自動保存の段落。'),
    });
    const { version, createdVersion } = await requestReview(db, author(), { blockId: RISK });
    expect(createdVersion).toBe(true);
    expect(version.changeReason).toBe('レビュー依頼時の版');
    expect(version.body.paragraphs.some((p) => p.id === 'w-1')).toBe(true);
    expect(blockRow(RISK).workingBody).toBeNull();
  });

  it('二重押下しても依頼は 1 件', async () => {
    const first = await requestReview(db, author(), { blockId: RISK });
    const second = await requestReview(db, author(), { blockId: RISK });
    expect(second.request.id).toBe(first.request.id);
    expect(fixture.reviewRequests.filter((r) => r.targetId === RISK)).toHaveLength(1);
    expect(fixture.reviewEvents.filter((e) => e.reviewRequestId === first.request.id)).toHaveLength(
      1,
    );
  });

  it('未解決の要対応コメント・古い参照があると依頼できない', async () => {
    const comment = await addReviewComment(db, reviewer(), {
      blockId: RISK,
      paragraphId: 'risk-3',
      body: '財務的影響の記載方針を確認してください。',
      severity: 'major',
    });
    const error = await requestReview(db, author(), { blockId: RISK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect((error as ReviewBlockedError).blockers.map((b) => b.code)).toContain(
      'unresolved_major_comments',
    );
    await resolveReviewComment(db, author(), {
      commentId: comment.id,
      note: '方針を追記しました。',
    });
    await expect(requestReview(db, author(), { blockId: RISK })).resolves.toBeDefined();

    // 指標の節（承認済み・引用した Scope1 に新しい版）は承認後に修正しても、古い参照のままでは依頼できない
    const metrics = blockRow(METRICS);
    await saveBlockVersion(db, author(), {
      blockId: METRICS,
      baseVersionId: metrics.currentVersionId,
      body: withParagraph(versionRow(metrics.currentVersionId).body, 'met-3', '補足。'),
      changeReason: '補足を追記',
    });
    const stale = await requestReview(db, author(), { blockId: METRICS }).catch((e: unknown) => e);
    expect((stale as ReviewBlockedError).blockers.map((b) => b.code)).toContain(
      'stale_metric_refs',
    );
  });

  it('レビュー担当と最終承認者を同じ人にはできない', async () => {
    await expect(
      requestReview(db, author(), {
        blockId: RISK,
        reviewerUserId: userId('approver@demo.local'),
        approverUserId: userId('approver@demo.local'),
      }),
    ).rejects.toThrow('別の人');
  });
});

describe('差戻しと再提出（A27）', () => {
  it('各版・理由・レビュアー・最終判断者を追跡できる', async () => {
    const first = await requestReview(db, author(), { blockId: RISK });

    // 差戻しには理由と段落が必要
    await expect(
      returnReview(db, reviewer(), {
        requestId: first.request.id,
        reason: '',
        paragraphId: 'risk-3',
      }),
    ).rejects.toThrow('理由と対象の段落');
    await expect(
      returnReview(db, reviewer(), {
        requestId: first.request.id,
        reason: '影響額の扱いを明記してください',
        paragraphId: 'no-such',
      }),
    ).rejects.toThrow('段落が、依頼された版に見つかりません');
    await returnReview(db, reviewer(), {
      requestId: first.request.id,
      reason: '影響額を示さない理由を明記してください',
      paragraphId: 'risk-3',
    });
    expect(blockRow(RISK).status).toBe('returned');
    // 依頼者のワークフローに「差し戻された依頼」として出る
    expect((await listMyReviewTasks(db, author())).returnedToMe.map((r) => r.id)).toEqual([
      first.request.id,
    ]);

    // 再提出: 新しい版を作って依頼し直す
    await reviseRisk('影響額は評価中のため記載していません（架空）。', '差戻しの指摘に対応');
    const second = await requestReview(db, author(), { blockId: RISK });
    expect(second.request.targetVersionId).not.toBe(first.request.targetVersionId);
    expect((await listMyReviewTasks(db, author())).returnedToMe).toHaveLength(0);
    await completeReview(db, reviewer(), { requestId: second.request.id });
    expect(blockRow(RISK).status).toBe('approval_pending');
    await finalApprove(db, approver(), { requestId: second.request.id });
    expect(blockRow(RISK).status).toBe('approved');
    expect(blockRow(RISK).approvedVersionId).toBe(second.request.targetVersionId);

    const history = (await listProjectReviews(db, author(), PROJECT)).filter(
      (h) => h.blockId === RISK,
    );
    expect(history).toHaveLength(2);
    const returned = history.find((h) => h.id === first.request.id);
    const approved = history.find((h) => h.id === second.request.id);
    expect(returned?.status).toBe('returned');
    expect(returned?.events.find((e) => e.label === '差戻し')?.reason).toBe(
      '影響額を示さない理由を明記してください',
    );
    expect(returned?.events.find((e) => e.label === '差戻し')?.paragraphId).toBe('risk-3');
    expect(approved?.status).toBe('approved');
    expect(approved?.targetVersionNo).toBe((returned?.targetVersionNo ?? 0) + 1);
    expect(approved?.events.map((e) => e.label)).toEqual([
      'レビュー依頼',
      'レビュー完了',
      '最終承認',
    ]);
    expect(approved?.events.find((e) => e.label === 'レビュー完了')?.actorName).toBe('検見川 涼');
    expect(approved?.events.find((e) => e.label === '最終承認')?.actorName).toBe('承 花子');
  });

  it('同じ判断を 2 回押しても記録は 1 回', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    await completeReview(db, reviewer(), { requestId: request.id });
    await finalApprove(db, approver(), { requestId: request.id });
    await finalApprove(db, approver(), { requestId: request.id });
    const events = fixture.reviewEvents.filter((e) => e.reviewRequestId === request.id);
    expect(events.map((e) => e.eventType)).toEqual(['requested', 'review_completed', 'approved']);
  });

  it('レビュー中に付いた要対応コメントが未解決なら、レビュー完了できない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await addReviewComment(db, reviewer(), {
      blockId: RISK,
      paragraphId: 'risk-1',
      body: '出典の版を確認してください。',
      severity: 'major',
    });
    await expect(completeReview(db, reviewer(), { requestId: request.id })).rejects.toBeInstanceOf(
      ReviewBlockedError,
    );
  });
});

describe('職務分離（A28）', () => {
  it('作成担当が最終承認を直接呼んでも拒否される', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    await expect(finalApprove(db, author(), { requestId: request.id })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    // 管理者（承認権限なし）も同じ
    await expect(finalApprove(db, admin(), { requestId: request.id })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(blockRow(RISK).status).toBe('approval_pending');
  });

  it('依頼者本人はレビューを完了できない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK, reviewerUserId: null });
    await expect(completeReview(db, author(), { requestId: request.id })).rejects.toThrow(
      '依頼した本人',
    );
  });

  it('レビューを完了した人は、同じ依頼を最終承認できない', async () => {
    const { request } = await requestReview(db, author(), {
      blockId: RISK,
      reviewerUserId: userId('approver@demo.local'),
      approverUserId: null,
    });
    await completeReview(db, approver(), { requestId: request.id });
    const actions = await reviewActionsFor(
      db,
      approver(),
      fixture.reviewRequests.find((r) => r.id === request.id)!,
    );
    expect(actions.canApprove).toBe(false);
    expect(actions.reasons.join(' ')).toContain('レビューを完了した本人');
    await expect(finalApprove(db, approver(), { requestId: request.id })).rejects.toThrow(
      'レビューを完了した本人',
    );
    expect(
      fixture.reviewEvents.filter(
        (e) => e.eventType === 'approved' && e.reviewRequestId === request.id,
      ),
    ).toHaveLength(0);
  });

  it('指定された最終承認者以外は承認できない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    const otherApprover = ctxFor('enterprise-admin@demo.local', ['approver']);
    await expect(finalApprove(db, otherApprover, { requestId: request.id })).rejects.toThrow(
      '最終承認者ではありません',
    );
  });

  it('自分のレビュー: 自分の段階の依頼だけが並ぶ', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK });
    expect((await listMyReviewTasks(db, reviewer())).awaitingMe.map((r) => r.id)).toEqual([
      request.id,
    ]);
    expect((await listMyReviewTasks(db, approver())).awaitingMe).toHaveLength(0);
    await completeReview(db, reviewer(), { requestId: request.id });
    expect((await listMyReviewTasks(db, reviewer())).awaitingMe).toHaveLength(0);
    expect((await listMyReviewTasks(db, approver())).awaitingMe.map((r) => r.myStage)).toEqual([
      'final',
    ]);
  });
});

describe('承認直前の参照元の更新（A26）', () => {
  it('引用した数値に承認直前で新しい版ができたら、サーバーで検知して承認しない', async () => {
    // リスクの節に現在の Scope1 を引用してから依頼する
    const block = blockRow(RISK);
    const current = fixture.dataPointVersions.find(
      (v) => v.id === SCOPE1_CORRECTION.correctedVersionId,
    )!;
    const body: BlockBody = {
      paragraphs: [
        ...versionRow(block.currentVersionId).body.paragraphs,
        {
          id: 'risk-4',
          kind: 'paragraph',
          children: [
            { t: 'text', text: '本社の Scope1 排出量は ' },
            {
              t: 'metric',
              dataPointId: SCOPE1_CORRECTION.dataPointId,
              dataPointVersionId: current.id,
              display: metricDisplay(current),
            },
            { t: 'text', text: ' です。' },
          ],
        },
      ],
    };
    await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body,
      changeReason: '数値を引用',
    });
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });

    addDataPointVersion(SCOPE1_CORRECTION.dataPointId, 1201.5);

    const error = await finalApprove(db, approver(), { requestId: request.id }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect((error as Error).message).toContain('承認の直前に引用先が更新');
    expect(blockRow(RISK).status).toBe('approval_pending');
    expect(blockRow(RISK).approvedVersionId).toBeNull();
    expect(
      fixture.reviewEvents.some(
        (e) => e.reviewRequestId === request.id && e.eventType === 'approved',
      ),
    ).toBe(false);
  });
});

describe('上流の変更と再確認（A25）', () => {
  it('新しい版を採用すると次の版を作り、承認済みの版は変えない', async () => {
    const before = blockRow(METRICS);
    const approvedBody = structuredClone(versionRow(before.approvedVersionId).body);
    const freshness = await computeBlockFreshness(db, author(), before);
    expect(freshness.items[0]?.paragraphIds).toEqual(['met-1']);
    expect(freshness.items[0]?.changeReason).toBe(SCOPE1_CORRECTION.changeReason);

    const { newVersionId } = await decideRecheck(db, author(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'adopt_new',
      reason: null,
    });
    const after = blockRow(METRICS);
    expect(after.currentVersionId).toBe(newVersionId);
    expect(after.status).toBe('draft');
    expect(after.approvedVersionId).toBe(before.approvedVersionId);
    expect(versionRow(before.approvedVersionId).body).toEqual(approvedBody);
    expect(collectRefs(versionRow(newVersionId).body).metricVersionIds).toEqual([
      SCOPE1_CORRECTION.correctedVersionId,
    ]);
    expect((await computeBlockFreshness(db, author(), after)).status).toBe('current');
    expect(fixture.recheckDecisions).toHaveLength(1);
  });

  it('引用中の版の維持は理由が必須で、判断後は「再確認済み」になる', async () => {
    await expect(
      decideRecheck(db, author(), {
        blockId: METRICS,
        refKind: 'metric',
        oldRefId: SCOPE1_CORRECTION.citedVersionId,
        decision: 'keep_old',
        reason: '  ',
      }),
    ).rejects.toThrow('理由');
    await decideRecheck(db, author(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'keep_old',
      reason: '値は同じで、注記の訂正のみのため',
    });
    const freshness = await computeBlockFreshness(db, author(), blockRow(METRICS));
    expect(freshness.status).toBe('rechecked');
    expect(blockRow(METRICS).status).toBe('approved');
  });

  it('担当者へ差し戻すと通知し、再確認は未了のまま', async () => {
    await decideRecheck(db, reviewer(), {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision: 'return_to_owner',
      reason: '訂正の内容を担当者に確認してほしい',
    });
    expect(
      fixture.notifications.some(
        (n) => n.userId === userId('sustainability@demo.local') && n.href?.endsWith('/recheck'),
      ),
    ).toBe(true);
    expect((await computeBlockFreshness(db, author(), blockRow(METRICS))).status).toBe(
      'upstream_updated',
    );
  });

  it('最新の版を引用している節には再確認を記録できない', async () => {
    await expect(
      decideRecheck(db, author(), {
        blockId: GOVERNANCE,
        refKind: 'narrative',
        oldRefId: IDS.narrativeVersions.governanceFy2026,
        decision: 'keep_old',
        reason: 'テスト',
      }),
    ).rejects.toThrow('再確認が必要な参照ではありません');
  });
});

describe('原稿一覧（原稿タブの絞り込み）', () => {
  it('本文状態・参照の鮮度・阻害条件・担当で絞り込める', async () => {
    const all = await listProjectBlocks(db, author(), PROJECT);
    expect(all.total).toBe(4);
    expect(all.counts.recheck).toBe(1);
    expect(all.counts.mine).toBe(4);
    expect(all.counts.missing).toBe(0);

    const recheck = await listProjectBlocks(db, author(), PROJECT, 'recheck');
    expect(recheck.rows.map((r) => r.id)).toEqual([METRICS]);
    expect(recheck.rows[0]?.freshnessLabel).toBe('上流に新版あり');
    expect(recheck.rows[0]?.blockers.map((b) => b.code)).toContain('stale_metric_refs');

    await requestReview(db, author(), { blockId: RISK });
    const review = await listProjectBlocks(db, author(), PROJECT, 'review');
    expect(review.rows.map((r) => r.id)).toEqual([RISK]);
    expect((await listProjectBlocks(db, reviewer(), PROJECT, 'mine')).rows).toHaveLength(0);

    // 本文の無い節（新しく追加した節）は「本文なし」に並ぶ
    const created = await createBlock(db, author(), {
      projectId: PROJECT,
      frameworkVersionId: blockRow(GOVERNANCE).frameworkVersionId,
      sectionKey: 'strategy',
      title: '戦略',
      language: 'ja',
    });
    const missing = await listProjectBlocks(db, author(), PROJECT, 'missing');
    expect(missing.rows.map((r) => r.id)).toEqual([created.id]);
    expect(missing.rows[0]?.blockers.map((b) => b.code)).toContain('no_body');
  });
});

describe('翻訳版', () => {
  it('翻訳元が後から修正されると「翻訳の要確認」になる', async () => {
    const translation = await createBlock(db, author(), {
      projectId: PROJECT,
      frameworkVersionId: blockRow(GOVERNANCE).frameworkVersionId,
      sectionKey: 'governance',
      title: 'Governance',
      language: 'en',
      translationOfBlockId: GOVERNANCE,
    });
    await saveBlockVersion(db, author(), {
      blockId: translation.id,
      baseVersionId: null,
      body: {
        paragraphs: [
          {
            id: 'en-1',
            kind: 'paragraph',
            children: [{ t: 'text', text: 'The Board oversees climate-related matters.' }],
          },
        ],
      },
      changeReason: null,
    });
    expect(
      (await getBlockEditorData(db, author(), PROJECT, translation.id)).block.translationNeedsCheck,
    ).toBe(false);

    const source = blockRow(GOVERNANCE);
    await saveBlockVersion(db, author(), {
      blockId: GOVERNANCE,
      baseVersionId: source.currentVersionId,
      body: withParagraph(versionRow(source.currentVersionId).body, 'gov-9', '追記。'),
      changeReason: '翻訳元の修正',
    });
    const data = await getBlockEditorData(db, author(), PROJECT, translation.id);
    expect(data.block.translationOfTitle).toBe('ガバナンス');
    expect(data.block.translationNeedsCheck).toBe(true);
  });
});

describe('版を読めないとき（Demo Mode の別インスタンス）', () => {
  it('空の本文を土台に上書きさせず、読み取り専用にする', async () => {
    const block = blockRow(RISK);
    // 節は版を指しているが、版の行がこのインスタンスに無い状態を再現する
    fixture.disclosureBlockVersions = fixture.disclosureBlockVersions.filter(
      (v) => v.id !== block.currentVersionId,
    );
    db = new DemoDbClient(fixture);
    const data = await getBlockEditorData(db, author(), PROJECT, RISK);
    expect(data.permissions.editable).toBe(false);
    expect(data.permissions.readOnlyReason).toContain('読み込めません');
    await expect(
      saveBlockVersion(db, author(), {
        blockId: RISK,
        baseVersionId: block.currentVersionId,
        body: {
          paragraphs: [
            { id: 'x', kind: 'paragraph', children: [{ t: 'text', text: '新しい本文' }] },
          ],
        },
        changeReason: '上書き',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
