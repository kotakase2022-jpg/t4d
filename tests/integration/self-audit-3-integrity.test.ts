import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  DISCLOSURE_REPORT_TEMPLATE_VERSION,
  renderBlockParagraphs,
  externalMaskedNames,
} from '@/lib/exports/disclosure-report';
import {
  autosaveWorkingBody,
  buildMetricInline,
  getBlockEditorData,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { exportReportSnapshot } from '@/lib/services/disclosure-export';
import {
  ProjectFrameworkConflictError,
  confirmApplicability,
  saveProjectFramework,
  updateProject,
} from '@/lib/services/disclosure-project';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import { completeReview, finalApprove, requestReview } from '@/lib/services/disclosure-review';
import { generateDisclosureDraft } from '@/lib/services/disclosure-write';
import {
  confirmReport,
  evaluateReportReadiness,
  frozenMaskedFileNames,
  listProjectSnapshots,
} from '@/lib/services/report-snapshot';
import { parseDocx } from '@/lib/imports/parsers';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 自己監査 第 3 回（2026-09-30）の指摘の回帰テスト（不変条件 F1〜F7）。
 * 見出しの ID は AI_HANDOFF.md の一覧と対応する。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);

const FY2025 = IDS.projects.fy2025;
const FY2026 = IDS.projects.fy2026;
const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const GOVERNANCE = IDS.blocks.fy2026Governance.block;
const FY2025_GOVERNANCE = IDS.blocks.fy2025Governance.block;

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

async function confirm(
  projectFrameworkId: string,
  applicabilityStatus: 'applicable' | 'voluntary',
  transitionalNote: string | null = null,
) {
  return confirmApplicability(db, author(), {
    projectFrameworkId,
    applicabilityStatus,
    reason: 'テスト: 取締役会で適用を決議（架空）',
    ruleRef: 'SSBJ 適用基準（テスト）',
    confirmedOn: '2026-08-14',
    transitionalNote,
  });
}

/** 節を依頼 → レビュー完了 → 最終承認まで進める */
async function approveThrough(blockId: string) {
  const { request } = await requestReview(db, author(), { blockId });
  await completeReview(db, reviewer(), { requestId: request.id });
  await finalApprove(db, approver(), { requestId: request.id });
  return request;
}

// ----------------------------------------------------------------------
// F1: 適用判断の確定後の再確認
// ----------------------------------------------------------------------

describe('F1 承認の後に適用判断を確定しても、本文を変えずに再承認でき、最初の確定は変更に数えない', () => {
  it('判断を確定し直した後は、同じ本文の版を作って再承認すれば確定を止めない', async () => {
    expect((await evaluateReportReadiness(db, approver(), FY2025)).blockers).toEqual([]);
    // 経過措置の注記を足すためだけに、同じ区分で確定し直す（判断 2）
    await confirm(IDS.projectFrameworks.fy2025Ssbj, 'voluntary', '経過措置の注記（テスト）');

    const blocked = await evaluateReportReadiness(db, approver(), FY2025);
    expect(blocked.blockers.length).toBeGreaterThan(0);
    expect(blocked.blockers.every((b) => b.code === 'applicability_changed')).toBe(true);
    const editor = await getBlockEditorData(db, author(), FY2025, FY2025_GOVERNANCE);
    expect(editor.block.applicabilityRecheckNeeded).toBe(true);

    // 本文は同じまま「判断を確認した」版を作れる（以前は「本文が変わっていません」で断られた）
    for (const blocker of blocked.blockers) {
      const block = blockRow(blocker.blockId!);
      const saved = await saveBlockVersion(db, author(), {
        blockId: block.id,
        baseVersionId: block.currentVersionId,
        body: versionRow(block.currentVersionId).body,
        changeReason: '適用判断の更新を確認（本文の変更なし）',
      });
      expect(saved.version.contentHash).toBe(versionRow(block.approvedVersionId).contentHash);
      expect(blockRow(block.id).status).toBe('draft');
      await approveThrough(block.id);
    }
    const after = await evaluateReportReadiness(db, approver(), FY2025);
    expect(after.blockers).toEqual([]);
  });

  it('判断が変わっていない承認済みの節は、同じ本文では版を作らない', async () => {
    const block = blockRow(FY2025_GOVERNANCE);
    await expect(
      saveBlockVersion(db, author(), {
        blockId: block.id,
        baseVersionId: block.currentVersionId,
        body: versionRow(block.currentVersionId).body,
        changeReason: '変更なし',
      }),
    ).rejects.toThrow('前の版から本文が変わっていません');
  });

  it('判断が無いまま承認した節は、最初の「適用」の確定では再確認にならない（2 回目の確定はなる）', async () => {
    // 新しいプロジェクトと同じく、判断なし（候補）のまま準備を進める
    const index = fixture.projectFrameworks.findIndex(
      (p) => p.id === IDS.projectFrameworks.fy2026Ssbj,
    );
    fixture.projectFrameworks[index] = {
      ...fixture.projectFrameworks[index]!,
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
    };
    fixture.projectFrameworkDecisions = fixture.projectFrameworkDecisions.filter(
      (d) => d.projectFrameworkId !== IDS.projectFrameworks.fy2026Ssbj,
    );
    const request = await approveThrough(RISK);
    expect(request.decisionIds).toEqual([]);

    await confirm(IDS.projectFrameworks.fy2026Ssbj, 'applicable');
    const first = await evaluateReportReadiness(db, approver(), FY2026);
    expect(
      first.blockers.some((b) => b.blockId === RISK && b.code === 'applicability_changed'),
    ).toBe(false);
    expect(
      (await getBlockEditorData(db, author(), FY2026, RISK)).block.applicabilityRecheckNeeded,
    ).toBe(false);

    // 確定した判断を改めて確定し直すのは変更（判断 2）
    await confirm(IDS.projectFrameworks.fy2026Ssbj, 'voluntary');
    const second = await evaluateReportReadiness(db, approver(), FY2026);
    expect(
      second.blockers.some((b) => b.blockId === RISK && b.code === 'applicability_changed'),
    ).toBe(true);
    const risk = blockRow(RISK);
    await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: risk.currentVersionId,
      body: versionRow(risk.currentVersionId).body,
      changeReason: '適用判断の更新を確認（本文の変更なし）',
    });
    expect(blockRow(RISK).status).toBe('draft');
  });

  it('依頼の後の最初の確定では、依頼中の最終承認を止めない', async () => {
    const index = fixture.projectFrameworks.findIndex(
      (p) => p.id === IDS.projectFrameworks.fy2026Ssbj,
    );
    fixture.projectFrameworks[index] = {
      ...fixture.projectFrameworks[index]!,
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
    };
    fixture.projectFrameworkDecisions = fixture.projectFrameworkDecisions.filter(
      (d) => d.projectFrameworkId !== IDS.projectFrameworks.fy2026Ssbj,
    );
    const { request } = await requestReview(db, author(), { blockId: RISK });
    await completeReview(db, reviewer(), { requestId: request.id });
    await confirm(IDS.projectFrameworks.fy2026Ssbj, 'applicable');
    await finalApprove(db, approver(), { requestId: request.id });
    expect(blockRow(RISK).status).toBe('approved');
  });
});

// ----------------------------------------------------------------------
// F2: 現在の版をそのまま提出したときの作業本文
// ----------------------------------------------------------------------

describe('F2 現在の版をそのまま依頼したら、残っていた作業本文をレビュー・承認後に使わない', () => {
  it('作業本文を消し、レビュー担当には審査中の版を見せ、承認後の鮮度も承認した版で見る', async () => {
    const risk = blockRow(RISK);
    const current = versionRow(risk.currentVersionId);
    const inline = await buildMetricInline(db, author(), SCOPE1_CORRECTION.citedVersionId);
    // 自動保存: 古い Scope1 を引用する段落を足した作業本文
    const working: BlockBody = {
      paragraphs: [
        ...current.body.paragraphs,
        {
          id: 'w-1',
          kind: 'paragraph',
          children: [{ t: 'text', text: '自動保存だけの段落。' }, inline],
        },
      ],
    };
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: risk.currentVersionId,
      body: working,
    });
    expect(blockRow(RISK).workingBody).not.toBeNull();

    // 段落を消して、自動保存より先に「レビュー依頼」（画面の本文 = 現在の版）
    const result = await requestReview(db, author(), {
      blockId: RISK,
      body: current.body,
      baseVersionId: risk.currentVersionId,
      knownWorkingSavedAt: blockRow(RISK).workingSavedAt,
    });
    expect(result.createdVersion).toBe(false);
    expect(blockRow(RISK).workingBody).toBeNull();

    const forReviewer = await getBlockEditorData(db, reviewer(), FY2026, RISK);
    expect(forReviewer.bodyFromWorking).toBe(false);
    expect(JSON.stringify(forReviewer.body)).not.toContain('自動保存だけの段落');

    await completeReview(db, reviewer(), { requestId: result.request.id });
    await finalApprove(db, approver(), { requestId: result.request.id });
    const freshness = await computeBlockFreshness(db, author(), blockRow(RISK));
    expect(freshness.items.some((i) => i.oldRefId === SCOPE1_CORRECTION.citedVersionId)).toBe(
      false,
    );
  });

  it('承認済みの節に古い作業本文が残っていても、画面・鮮度・採用はそれを使わない', async () => {
    // 修正前のデータ（依頼で作業本文を消していなかった時期）に残った作業本文
    const governance = blockRow(GOVERNANCE);
    expect(governance.status).toBe('approved');
    const inline = await buildMetricInline(db, author(), SCOPE1_CORRECTION.citedVersionId);
    const index = fixture.disclosureBlocks.findIndex((b) => b.id === GOVERNANCE);
    fixture.disclosureBlocks[index] = {
      ...governance,
      workingBody: {
        paragraphs: [
          ...versionRow(governance.currentVersionId).body.paragraphs,
          { id: 'stale-1', kind: 'paragraph', children: [inline] },
        ],
      },
      workingBaseVersionId: governance.currentVersionId,
      workingSavedAt: new Date().toISOString(),
      workingUpdatedBy: userId('sustainability@demo.local'),
    };
    const editor = await getBlockEditorData(db, author(), FY2026, GOVERNANCE);
    expect(editor.bodyFromWorking).toBe(false);
    const freshness = await computeBlockFreshness(db, author(), blockRow(GOVERNANCE));
    expect(freshness.status).not.toBe('upstream_updated');
    // 作業本文にだけある引用を「採用」しても、内容の同じ版で承認済みの節を下書きへ戻さない
    await expect(
      decideRecheck(db, author(), {
        blockId: GOVERNANCE,
        refKind: 'metric',
        oldRefId: SCOPE1_CORRECTION.citedVersionId,
        decision: 'adopt_new',
        reason: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(blockRow(GOVERNANCE).status).toBe('approved');
  });
});

// ----------------------------------------------------------------------
// F3: 進行中の依頼への二重押下の近道
// ----------------------------------------------------------------------

describe('F3 別の人・古い版・違う本文の依頼を「依頼済み」と返さない', () => {
  it('B の本文は提出されないことをはっきり断り、A の二重押下だけを同じ依頼として返す', async () => {
    const risk = blockRow(RISK);
    const v1 = versionRow(risk.currentVersionId);
    const bodyA = withParagraph(v1.body, 'para-a', '担当 A が足した段落。');
    const first = await requestReview(db, author(), {
      blockId: RISK,
      body: bodyA,
      baseVersionId: v1.id,
    });
    expect(first.createdVersion).toBe(true);

    // B は古い版（v1）を土台に別の段落を書いたまま依頼を押した
    const bodyB = withParagraph(v1.body, 'para-b', '担当 B が足した段落。');
    await expect(
      requestReview(db, approver(), { blockId: RISK, body: bodyB, baseVersionId: v1.id }),
    ).rejects.toThrow('あなたの本文は提出していません');
    // A 自身でも本文が違えば断る
    await expect(
      requestReview(db, author(), { blockId: RISK, body: bodyB, baseVersionId: v1.id }),
    ).rejects.toThrow('あなたの本文は提出していません');

    // A の二重押下（同じ本文・同じ土台）は同じ依頼を返す
    const again = await requestReview(db, author(), {
      blockId: RISK,
      body: bodyA,
      baseVersionId: v1.id,
    });
    expect(again.request.id).toBe(first.request.id);
    expect(again.createdVersion).toBe(false);
    expect(
      fixture.reviewRequests.filter((r) => r.targetId === RISK && r.status === 'open'),
    ).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------
// F4: 翻訳の要確認
// ----------------------------------------------------------------------

describe('F4 翻訳元の修正の後、翻訳を変えずに確認した版で再承認できる', () => {
  it('translation_stale は同じ本文の版と再承認で解消する', async () => {
    const governance = blockRow(GOVERNANCE);
    const sourceVersion = versionRow(governance.approvedVersionId);
    const translationId = fid('disclosure_block', 'test3/governance-en');
    const translationVersionId = fid('disclosure_block_version', 'test3/governance-en/v1');
    fixture.disclosureBlockVersions.push({
      ...sourceVersion,
      id: translationVersionId,
      blockId: translationId,
      versionNo: 1,
      baseVersionId: null,
      createdAt: new Date(new Date(sourceVersion.createdAt).getTime() - 60_000).toISOString(),
    });
    fixture.disclosureBlocks.push({
      ...governance,
      id: translationId,
      sectionKey: 'governance_en',
      language: 'en',
      translationOfBlockId: GOVERNANCE,
      currentVersionId: translationVersionId,
      submittedVersionId: translationVersionId,
      approvedVersionId: translationVersionId,
      status: 'approved',
    });
    const stale = await evaluateReportReadiness(db, approver(), FY2026);
    expect(
      stale.blockers.some((b) => b.blockId === translationId && b.code === 'translation_stale'),
    ).toBe(true);
    expect(
      (await getBlockEditorData(db, author(), FY2026, translationId)).block.translationNeedsCheck,
    ).toBe(true);

    // 翻訳を確認し、直す必要が無かった: 同じ本文で版を作る
    const translation = blockRow(translationId);
    await saveBlockVersion(db, author(), {
      blockId: translationId,
      baseVersionId: translation.currentVersionId,
      body: versionRow(translation.currentVersionId).body,
      changeReason: '翻訳元の版を確認（翻訳の変更なし）',
    });
    await approveThrough(translationId);
    const after = await evaluateReportReadiness(db, approver(), FY2026);
    expect(after.blockers.some((b) => b.code === 'translation_stale')).toBe(false);
  });
});

// ----------------------------------------------------------------------
// F5: 報告範囲の変更を上流の変更として示す
// ----------------------------------------------------------------------

describe('F5 確定したスナップショットの後に報告範囲を変えたら「上流の更新」に出す', () => {
  it('範囲の改訂番号を固定し、後の変更を scope として示す', async () => {
    const snapshot = await confirmReport(db, approver(), FY2025);
    expect(snapshot.frameworkVersions.every((f) => f.scopeRevision === 0)).toBe(true);
    const before = await listProjectSnapshots(db, approver(), FY2025);
    expect(before[0]?.upstreamChanges).toEqual([]);

    const project = fixture.disclosureProjects.find((p) => p.id === FY2025)!;
    const result = await updateProject(
      db,
      author(),
      FY2025,
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
    expect(result.status).toBe('saved');
    const after = await listProjectSnapshots(db, approver(), FY2025);
    expect(after[0]?.upstreamChanges.map((c) => c.kind)).toContain('scope');
  });
});

// ----------------------------------------------------------------------
// F6: CDP・CSRD の AI 下書きに渡す値
// ----------------------------------------------------------------------

describe('F6 開示回答の AI 下書きは、値の無い行を 0 にせず、目標・推計・連結外を実績に足さない', () => {
  async function scope1Response() {
    const mappings = fixture.disclosureMappings.filter(
      (m) => m.organizationId === ORG_IDS.aomi && m.metricId === metricId('AOMI', 'scope1'),
    );
    const response = fixture.disclosureResponses.find(
      (r) =>
        r.reportingPeriodId === PERIOD_IDS.fy2026 && mappings.some((m) => m.itemId === r.itemId),
    );
    if (!response) throw new Error('scope1 response');
    return response;
  }
  function scope1Rows() {
    return fixture.dataPoints.filter(
      (d) => d.metricId === metricId('AOMI', 'scope1') && d.reportingPeriodId === PERIOD_IDS.fy2026,
    );
  }

  it('承認済みでも値の無い行だけなら、その指標を根拠にせず「実績値は 0」と書かない', async () => {
    for (const dp of scope1Rows()) {
      dp.status = 'approved';
      dp.value = null;
      dp.availabilityStatus = 'not_applicable';
      dp.absenceReason = 'テスト: 対象外';
    }
    const response = await scope1Response();
    const result = await generateDisclosureDraft(
      db,
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
      response.id,
    );
    expect(result.version.answerText ?? '').not.toContain('実績値は 0');
    expect(result.version.answerNumeric).not.toBe(0);
    const run = fixture.aiRuns.find((r) => r.id === result.aiRunId)!;
    expect(run.sourceReferences.some((s) => scope1Rows().some((dp) => dp.id === s.id))).toBe(false);
  });

  it('目標の値は実績の合計に入れない', async () => {
    const rows = scope1Rows().filter((d) => d.status === 'approved' && d.value !== null);
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0]!;
    target.valueKind = 'target';
    const response = await scope1Response();
    const result = await generateDisclosureDraft(
      db,
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
      response.id,
    );
    const run = fixture.aiRuns.find((r) => r.id === result.aiRunId)!;
    expect(run.sourceReferences.some((s) => s.id === target.id)).toBe(false);
  });
});

// ----------------------------------------------------------------------
// F7: 出力の再現性（テンプレート版・伏せる資料名の固定）
// ----------------------------------------------------------------------

describe('F7 同じスナップショットの対外用の再出力は、後から登録した資料で本文が変わらない', () => {
  it('伏せる資料名をスナップショットに固定する', async () => {
    const snapshot = await confirmReport(db, approver(), FY2025);
    const frozen = frozenMaskedFileNames(snapshot);
    expect(frozen).not.toBeNull();

    const first = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'external',
    });
    // 本文に書かれた語と同じ名前の機密資料を、後から登録する
    const block = snapshot.blocks.find((b) =>
      b.body.paragraphs.some((p) =>
        p.children.some((c) => c.t === 'text' && c.text.trim().length >= 8),
      ),
    )!;
    const sourceText = block.body.paragraphs
      .flatMap((p) => p.children)
      .find((c) => c.t === 'text' && c.text.trim().length >= 8);
    const word = sourceText && sourceText.t === 'text' ? sourceText.text.trim().slice(0, 5) : '';
    expect(word.length).toBe(5);
    const renderedWith = (names: readonly string[]) =>
      renderBlockParagraphs(block, snapshot, 'external', externalMaskedNames(snapshot, names))
        .map((p) => p.text)
        .join('\n');
    // 出力時の資料一覧から伏せていたら、この語は本文から消えていた（再出力で本文が変わる）
    expect(renderedWith([word])).not.toBe(renderedWith(frozen ?? []));
    const template = fixture.files.find((f) => f.organizationId === ORG_IDS.aomi)!;
    fixture.files.push({
      ...template,
      id: fid('file', 'test3/late-confidential'),
      originalName: word,
      confidentiality: 'confidential',
    });

    const second = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'external',
    });
    const text = async (bytes: Uint8Array) => {
      const parsed = await parseDocx(bytes);
      return parsed.paragraphs.join('\n');
    };
    expect(await text(second.bytes)).toBe(await text(first.bytes));
    expect(second.artifact.templateVersion).toBe(DISCLOSURE_REPORT_TEMPLATE_VERSION);
  });
});

// ----------------------------------------------------------------------
// UX-R3-01: 設定・適用条件の競合
// ----------------------------------------------------------------------

describe('UX-R3-01 古い画面の保存で、別の人の変更を黙って戻さない', () => {
  function inputOf(project: (typeof fixture.disclosureProjects)[number]) {
    return {
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
      scopeGhgBoundaryNote: project.scopeGhgBoundaryNote,
      scopeValueChainNote: project.scopeValueChainNote,
      includedUnitIds: project.includedUnitIds,
    };
  }

  it('B の古い画面の保存は競合として返し、A が変えたレビュアーも範囲の改訂番号も戻さない', async () => {
    const opened = structuredClone(fixture.disclosureProjects.find((p) => p.id === FY2026)!);
    // A: レビュアーを変えて保存（B と同じ画面を開いた後）
    const saved = await updateProject(
      db,
      author(),
      FY2026,
      {
        ...inputOf(opened),
        reviewerUserId: userId('enterprise-admin@demo.local'),
        baseUpdatedAt: opened.updatedAt,
      },
      { confirmImpact: true },
    );
    expect(saved.status).toBe('saved');
    const afterA = structuredClone(fixture.disclosureProjects.find((p) => p.id === FY2026)!);

    // B: 古い画面のまま名前だけ変えて保存
    const result = await updateProject(
      db,
      author(),
      FY2026,
      { ...inputOf(opened), name: 'B が変えた名前', baseUpdatedAt: opened.updatedAt },
      { confirmImpact: true },
    );
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') throw new Error('unreachable');
    const fields = Object.fromEntries(result.fields.map((f) => [f.key, f]));
    expect(fields.reviewerUserId?.label).toBe('レビュアー');
    expect(fields.name?.yours).toBe('B が変えた名前');
    // 何も書き換えていない
    expect(fixture.disclosureProjects.find((p) => p.id === FY2026)).toEqual(afterA);

    // 競合を見たうえで上書きする（最新の時刻を土台にする）と保存できる
    const overwrite = await updateProject(
      db,
      author(),
      FY2026,
      {
        ...inputOf(afterA),
        name: 'B が変えた名前',
        baseUpdatedAt: result.currentUpdatedAt,
      },
      { confirmImpact: true },
    );
    expect(overwrite.status).toBe('saved');
    expect(fixture.disclosureProjects.find((p) => p.id === FY2026)?.reviewerUserId).toBe(
      userId('enterprise-admin@demo.local'),
    );
  });

  it('適用条件も、画面を開いた後に別の人が保存していれば上書きしない', async () => {
    const pf = structuredClone(
      fixture.projectFrameworks.find((p) => p.id === IDS.projectFrameworks.fy2026Esrs40a)!,
    );
    await saveProjectFramework(db, author(), {
      projectFrameworkId: pf.id,
      conditions: {},
      preparationStatus: 'awaiting_confirmation',
      baseUpdatedAt: pf.updatedAt,
    });
    const afterA = structuredClone(fixture.projectFrameworks.find((p) => p.id === pf.id)!);
    await expect(
      saveProjectFramework(db, author(), {
        projectFrameworkId: pf.id,
        conditions: {},
        preparationStatus: 'candidate',
        baseUpdatedAt: pf.updatedAt,
      }),
    ).rejects.toBeInstanceOf(ProjectFrameworkConflictError);
    expect(fixture.projectFrameworks.find((p) => p.id === pf.id)).toEqual(afterA);
  });
});
