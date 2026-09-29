import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { DISCLOSURE_DOCUMENTS } from '@/lib/fixtures/disclosure-documents';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { parseDocx } from '@/lib/imports/parsers';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  buildMappingXlsx,
  buildMetricCsv,
  neutralizeFormula,
} from '@/lib/exports/disclosure-report';
import { saveBlockVersion } from '@/lib/services/disclosure-block';
import { exportReportSnapshot, listExportArtifacts } from '@/lib/services/disclosure-export';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import { completeReview, finalApprove, requestReview } from '@/lib/services/disclosure-review';
import {
  computeSnapshotContentHash,
  confirmReport,
  createReviewDraftSnapshot,
  detectUpstreamChanges,
  evaluateReportReadiness,
  listProjectSnapshots,
  loadOwnedSnapshot,
  verifySnapshotIntegrity,
} from '@/lib/services/report-snapshot';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * レポートのスナップショットと出力（指示書 §6.10・§10.2・§10.3、受入 A29・A31・A32）。
 *
 * 出力は必ず固定したスナップショットから作ること、上流が変わっても過去の出力は同じ本文・数値を
 * 再現すること、対外用に社内コメント・非公開資料名が出ないこと、確定の阻害条件と職務分離が
 * サーバー側で効くこと、他テナントの ID では存在も分からないことを確かめる。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
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
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const FY2025 = IDS.projects.fy2025;
const FY2026 = IDS.projects.fy2026;
const COMMITTEE_FILE = DISCLOSURE_DOCUMENTS.find(
  (d) => d.key === 'fy2026-sustainability-committee-3',
)!.fileName;
const RISK_FILE = DISCLOSURE_DOCUMENTS.find(
  (d) => d.key === 'climate-risk-assessment-2026',
)!.fileName;

async function docxText(bytes: Uint8Array): Promise<string> {
  const parsed = await parseDocx(bytes);
  expect(parsed.status).toBe('parsed');
  return parsed.paragraphs.join('\n');
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

// ----------------------------------------------------------------------
// レビュー用草稿
// ----------------------------------------------------------------------

describe('レビュー用草稿のスナップショット', () => {
  it('保存済みの版だけを固定し、自動保存中の作業本文は含めない', async () => {
    const risk = fixture.disclosureBlocks.find(
      (b) => b.id === IDS.blocks.fy2026RiskOpportunity.block,
    )!;
    risk.workingBody = {
      paragraphs: [
        {
          id: 'risk-9',
          kind: 'paragraph',
          children: [{ t: 'text', text: '自動保存中の未保存の文' }],
        },
      ],
    };
    risk.workingBaseVersionId = risk.currentVersionId;

    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);

    expect(snapshot.snapshotKind).toBe('review_draft');
    expect(snapshot.snapshotNo).toBe(1);
    const riskBlock = snapshot.blocks.find((b) => b.blockId === risk.id)!;
    expect(riskBlock.versionId).toBe(IDS.blocks.fy2026RiskOpportunity.version);
    expect(JSON.stringify(riskBlock.body)).not.toContain('自動保存中の未保存の文');
    // 4 節（SSBJ 3 節＋ESRS-40a 準備 1 節）を基準の順に固定する
    expect(snapshot.blocks.map((b) => b.sectionKey)).toEqual([
      'governance',
      'risk_opportunity',
      'metrics_targets',
      'esrs40a_governance',
    ]);
    expect(verifySnapshotIntegrity(snapshot)).toBe(true);
  });

  it('未承認の節・不足情報・再確認が必要な引用を節ごとに記録する', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);
    const byKey = new Map(snapshot.blocks.map((b) => [b.sectionKey, b]));

    expect(byKey.get('governance')!.isApprovedVersion).toBe(true);
    expect(byKey.get('governance')!.issues).toEqual([]);

    const risk = byKey.get('risk_opportunity')!;
    expect(risk.issues.map((i) => i.code)).toContain('not_approved');
    // 財務的影響の影響額は未確定（理由あり）として不足情報に出る。理由は不足情報の横に示す
    // （原稿一覧・開示ホームと同じ判定。理由だけで要件を満たしたことにはしない: 指示書 §6.6・§8.3）
    expect(
      risk.issues.some(
        (i) => i.code === 'narrative_missing_fields' && i.message.includes('影響額'),
      ),
    ).toBe(true);
    expect(risk.issues.find((i) => i.code === 'narrative_not_quantified')?.message).toContain(
      '影響額を定量化していない理由: 財務的影響額は評価中のため未確定',
    );
    // 対応策が未記入の物理的リスクは、引き続き不足情報として出る
    expect(
      risk.issues.some(
        (i) => i.code === 'narrative_missing_fields' && i.message.includes('対応策'),
      ),
    ).toBe(true);

    const metrics = byKey.get('metrics_targets')!;
    expect(metrics.issues.map((i) => i.code)).toContain('stale_metric_refs');
    expect(snapshot.label).toContain('未承認箇所・不足情報あり');

    // 引用した Scope1 は節が引用した v1 のまま固定する（最新の v2 に差し替えない）
    const scope1 = snapshot.metricValues.find(
      (m) => m.dataPointId === SCOPE1_CORRECTION.dataPointId,
    )!;
    expect(scope1.dataPointVersionId).toBe(SCOPE1_CORRECTION.citedVersionId);
    expect(scope1.versionNo).toBe(1);
    expect(scope1.periodStart).toBe('2026-04-01');
    expect(scope1.periodEnd).toBe('2027-03-31');
    expect(scope1.boundary).toBe('連結');
  });

  it('編集権限も出力権限も無い利用者は草稿を作れない', async () => {
    const viewer = ctxFor('site-user@demo.local', ['viewer']);
    await expect(createReviewDraftSnapshot(db, viewer, FY2026)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

// ----------------------------------------------------------------------
// レポートの確定（社内承認済み版）
// ----------------------------------------------------------------------

describe('レポートの確定', () => {
  it('阻害条件があるとサーバー側で拒否し、理由を返す（FY2026: 未承認の節・再確認が必要な数値）', async () => {
    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    const codes = readiness.blockers.map((b) => b.code);
    expect(readiness.canConfirm).toBe(false);
    expect(codes).toContain('not_approved');
    expect(codes).toContain('stale_metric_refs');
    // ESRS-40a は草案基準の準備のため、適用候補のままでも適用判断の阻害にはしない
    expect(codes).not.toContain('framework_applicability_unconfirmed');
    expect(readiness.draftStandardPrep).toBe(true);

    await expect(confirmReport(db, approver(), FY2026)).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.reportSnapshots).toHaveLength(0);
  });

  it('承認権限の無い作成者は確定できない（職務分離・A28 相当）', async () => {
    await expect(confirmReport(db, author(), FY2025)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('全節の版を作った本人は、承認権限があっても確定できない', async () => {
    // 作成者（海野）に承認ロールを持たせても、自分が書いた節だけのレポートは確定させない
    const project = fixture.disclosureProjects.find((p) => p.id === FY2025)!;
    project.finalApproverUserId = userId('sustainability@demo.local');
    const authorAsApprover = ctxFor('sustainability@demo.local', ['approver']);
    const readiness = await evaluateReportReadiness(db, authorAsApprover, FY2025);
    expect(readiness.actorBlockers.join('')).toContain('職務分離');
    await expect(confirmReport(db, authorAsApprover, FY2025)).rejects.toThrow(/職務分離/);
  });

  it('プロジェクトの最終承認者に指定されていない人は確定できない', async () => {
    const otherApprover = ctxFor('enterprise-admin@demo.local', ['approver']);
    await expect(confirmReport(db, otherApprover, FY2025)).rejects.toThrow(/最終承認者/);
  });

  it('全節が承認済みで阻害条件が無ければ社内承認済み版を作る（FY2025）', async () => {
    const snapshot = await confirmReport(db, approver(), FY2025);
    expect(snapshot.snapshotKind).toBe('approved');
    expect(snapshot.label).toBe('社内承認済み版');
    expect(snapshot.label).not.toContain('法定');
    expect(snapshot.blocks.every((b) => b.isApprovedVersion)).toBe(true);
    expect(snapshot.decisionIds).toEqual([IDS.decisions.fy2025Ssbj]);
    expect(snapshot.policyVersion).toBe('sod-3role-v1');
    expect(snapshot.frameworkVersions[0]!.projectName).toBe(
      'FY2025 サステナビリティ開示（SSBJ 任意適用）',
    );
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'report_snapshot_created' && e.resourceId === snapshot.id,
      ),
    ).toBe(true);
  });

  it('草案基準の準備を含むレポートは「草案基準による準備」と表示し、法定準拠の確定にしない', async () => {
    // S-d の画面操作（承認・引用の再確認）を終えた状態を Fixture で作る
    for (const key of ['fy2026RiskOpportunity', 'fy2026Esrs40aGovernance'] as const) {
      const block = fixture.disclosureBlocks.find((b) => b.id === IDS.blocks[key].block)!;
      block.status = 'approved';
      block.submittedVersionId = block.currentVersionId;
      block.approvedVersionId = block.currentVersionId;
    }
    fixture.recheckDecisions.push({
      id: 'recheck-keep-old',
      organizationId: ORG_IDS.aomi,
      blockId: IDS.blocks.fy2026Metrics.block,
      blockVersionId: IDS.blocks.fy2026Metrics.version,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      newRefId: SCOPE1_CORRECTION.correctedVersionId,
      decision: 'keep_old',
      reason: '値は同じで注記の訂正のみのため、引用中の版を維持する。',
      decidedBy: userId('reviewer@demo.local'),
      decidedAt: '2026-08-10T00:00:00.000Z',
      // 訂正版（v2）は承認済み。承認済みの訂正を見たうえでの維持
      newRefApproved: true,
    });

    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    expect(readiness.blockers).toEqual([]);
    const snapshot = await confirmReport(db, approver(), FY2026);
    expect(snapshot.label).toBe('社内承認済み版（草案基準による準備を含む）');
    const esrs = snapshot.frameworkVersions.find(
      (f) => f.frameworkVersionId === IDS.esrs40aVersion,
    )!;
    expect(esrs.draftStandardPrep).toBe(true);
    expect(esrs.applicabilityStatus).toBe('candidate');

    const docx = await exportReportSnapshot(db, approver(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'internal',
      frameworkVersionId: IDS.esrs40aVersion,
    });
    const text = await docxText(docx.bytes);
    expect(text).toContain('草案基準による準備');
    expect(text).toContain('法定準拠の確定ではありません');
    // 表紙の「基準の位置付け」も画面と同じ文言（「草案」だけにしない。§8.1）
    expect(text).toMatch(/基準の位置付け\s*公開草案に基づく準備/);
    expect(text).toContain('要求事項は未収録');
  });
});

// ----------------------------------------------------------------------
// 再確認の判断（原稿画面 S-d）とレポートの確定（S-e）が同じ規則で動くこと
// ----------------------------------------------------------------------

describe('再確認の判断とレポートの確定（原稿画面と同じ規則）', () => {
  const METRICS = IDS.blocks.fy2026Metrics.block;
  const metricsBlock = () => fixture.disclosureBlocks.find((b) => b.id === METRICS)!;

  /** 指標の節以外を承認済みにする（S-d の承認操作を終えた状態。指標の節は実際のサービスで扱う） */
  function approveOtherBlocks() {
    for (const key of ['fy2026RiskOpportunity', 'fy2026Esrs40aGovernance'] as const) {
      const block = fixture.disclosureBlocks.find((b) => b.id === IDS.blocks[key].block)!;
      block.status = 'approved';
      block.submittedVersionId = block.currentVersionId;
      block.approvedVersionId = block.currentVersionId;
    }
  }

  const decide = (
    ctx: AuthorizationContext,
    decision: 'keep_old' | 'adopt_new' | 'return_to_owner',
    reason: string | null,
  ) =>
    decideRecheck(db, ctx, {
      blockId: METRICS,
      refKind: 'metric',
      oldRefId: SCOPE1_CORRECTION.citedVersionId,
      decision,
      reason,
    });

  async function reapprove() {
    const { request } = await requestReview(db, author(), { blockId: METRICS });
    await completeReview(db, reviewer(), { requestId: request.id });
    await finalApprove(db, approver(), { requestId: request.id });
  }

  it('引用中の版を維持（keep_old）すると、承認済みの版のまま確定できる', async () => {
    approveOtherBlocks();
    const before = await evaluateReportReadiness(db, approver(), FY2026);
    expect(before.blockers.map((b) => b.code)).toContain('stale_metric_refs');

    await decide(author(), 'keep_old', '値は同じで、注記の訂正のみのため引用中の版を維持する');
    // 維持は節の版を作らない（承認済みのまま）
    expect(metricsBlock().status).toBe('approved');

    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    expect(readiness.blockers).toEqual([]);
    const snapshot = await confirmReport(db, approver(), FY2026);
    expect(snapshot.blocks.find((b) => b.blockId === METRICS)!.versionId).toBe(
      metricsBlock().approvedVersionId,
    );
    expect(
      snapshot.metricValues.some(
        (mv) => mv.dataPointVersionId === SCOPE1_CORRECTION.citedVersionId,
      ),
    ).toBe(true);
  });

  it('新しい版を採用（adopt_new）すると節は下書きに戻り、再承認するまで確定できない', async () => {
    approveOtherBlocks();
    const { newVersionId } = await decide(author(), 'adopt_new', null);
    expect(metricsBlock().status).toBe('draft');

    const pending = await evaluateReportReadiness(db, approver(), FY2026);
    expect(pending.canConfirm).toBe(false);
    expect(pending.blockers.map((b) => b.code)).toContain('not_approved');
    await expect(confirmReport(db, approver(), FY2026)).rejects.toBeInstanceOf(ValidationError);

    // 依頼 → レビュー完了 → 最終承認（職務分離つき）を経れば確定できる
    await reapprove();
    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    expect(readiness.blockers).toEqual([]);
    const snapshot = await confirmReport(db, approver(), FY2026);
    expect(snapshot.blocks.find((b) => b.blockId === METRICS)!.versionId).toBe(newVersionId);
    expect(
      snapshot.metricValues.some(
        (mv) => mv.dataPointVersionId === SCOPE1_CORRECTION.correctedVersionId,
      ),
    ).toBe(true);
  });

  it('維持の判断は節単位: 同じ旧版を引用したまま節の版を作り直して再承認しても確定できる', async () => {
    approveOtherBlocks();
    await decide(author(), 'keep_old', '値は同じで、注記の訂正のみのため引用中の版を維持する');

    // 承認後に修正（引用はそのまま、段落を 1 つ足す）→ 再承認
    const block = metricsBlock();
    const current = fixture.disclosureBlockVersions.find((v) => v.id === block.currentVersionId)!;
    await saveBlockVersion(db, author(), {
      blockId: METRICS,
      baseVersionId: block.currentVersionId,
      body: {
        paragraphs: [
          ...current.body.paragraphs,
          {
            id: 'met-note',
            kind: 'paragraph',
            children: [{ t: 'text', text: '集計範囲の訂正は開示する値に影響しない。' }],
          },
        ],
      },
      changeReason: '注記を追加',
    });
    await reapprove();
    expect(metricsBlock().approvedVersionId).not.toBe(current.id);

    // 原稿画面（鮮度）とレポートの確定が同じ判定になる
    expect((await computeBlockFreshness(db, author(), metricsBlock())).status).toBe('rechecked');
    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    expect(readiness.blockers).toEqual([]);
  });

  it('維持の後に担当者へ差し戻した組み合わせは再確認済みにしない（最後の判断が有効）', async () => {
    approveOtherBlocks();
    await decide(author(), 'keep_old', '値は同じで、注記の訂正のみのため引用中の版を維持する');
    // 同じミリ秒に 2 件記録されても順序が決まるよう、維持の判断を過去に置く
    fixture.recheckDecisions[0]!.decidedAt = '2026-08-01T00:00:00.000Z';
    await decide(reviewer(), 'return_to_owner', '訂正の内容を担当者に確認してほしい');

    expect((await computeBlockFreshness(db, author(), metricsBlock())).status).toBe(
      'upstream_updated',
    );
    const readiness = await evaluateReportReadiness(db, approver(), FY2026);
    expect(readiness.blockers.map((b) => b.code)).toContain('stale_metric_refs');
  });
});

// ----------------------------------------------------------------------
// 出力（A31: 再出力の一致 / A32: 対外用 / A29: 他テナント）
// ----------------------------------------------------------------------

describe('スナップショットからの出力', () => {
  it('A31: 同じスナップショットを再出力すると内容ハッシュ・本文・数値が一致し、上流の訂正後も変わらない', async () => {
    const snapshot = await confirmReport(db, approver(), FY2025);

    const first = await exportReportSnapshot(db, approver(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'internal',
    });
    const firstText = await docxText(first.bytes);
    expect(firstText).toContain('1,240.5 t-CO2e');
    expect(firstText).toContain('2025-04-01〜2026-03-31');
    expect(firstText).toContain('社内承認済み版（第三者による保証ではありません）');
    expect(firstText).toContain(`No.${snapshot.snapshotNo}`);
    expect(firstText).not.toContain('提出済み');
    expect(firstText).not.toContain('保証済み');
    expect(firstText).toContain('ファイル作成は提出ではありません');

    // 上流の訂正: FY2025 本社 Scope1 に新しい版（値も変える）を足す
    const dpId = dataPointId('HQ', 'scope1', 'FY2025');
    const dp = fixture.dataPoints.find((d) => d.id === dpId)!;
    const v1 = fixture.dataPointVersions.find((v) => v.dataPointId === dpId && v.versionNo === 1)!;
    fixture.dataPointVersions.push({
      ...v1,
      id: 'hq-scope1-fy2025-v2',
      versionNo: 2,
      value: 1300,
      status: 'draft',
      changeReason: '燃料使用量の集計漏れを訂正（架空）',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    dp.currentVersionId = 'hq-scope1-fy2025-v2';
    dp.value = 1300;
    dp.status = 'draft';
    dp.changedAfterApproval = true;

    const second = await exportReportSnapshot(db, approver(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'internal',
    });
    const secondText = await docxText(second.bytes);
    expect(second.artifact.contentHash).toBe(first.artifact.contentHash);
    expect(second.artifact.contentHash).toBe(snapshot.contentHash);
    expect(secondText).toBe(firstText);
    expect(secondText).not.toContain('1,300 t-CO2e');

    // スナップショットは変えず、上流の変更は注意情報として示す（§10.3）
    const reloaded = await loadOwnedSnapshot(db, approver(), snapshot.id);
    expect(computeSnapshotContentHash(reloaded)).toBe(snapshot.contentHash);
    const changes = await detectUpstreamChanges(db, approver(), reloaded);
    expect(
      changes.some((c) => c.kind === 'metric' && c.detail.includes('燃料使用量の集計漏れ')),
    ).toBe(true);

    // 出力のたびに記録が残り、ファイルのハッシュとテンプレート版を持つ
    const artifacts = await listExportArtifacts(db, approver(), [snapshot.id]);
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact.templateVersion).toBe('disclosure-report-v1');
      expect(artifact.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.byteSize).toBeGreaterThan(0);
      expect(artifact.fileName).not.toContain('提出済み');
    }
    expect(fixture.auditEvents.filter((e) => e.eventType === 'export_created')).toHaveLength(2);
  });

  it('A31: 定量 CSV は同じスナップショットならバイト列まで一致する', async () => {
    const snapshot = await confirmReport(db, approver(), FY2025);
    const a = await exportReportSnapshot(db, approver(), {
      snapshotId: snapshot.id,
      format: 'csv',
      audience: 'internal',
    });
    const b = await exportReportSnapshot(db, approver(), {
      snapshotId: snapshot.id,
      format: 'csv',
      audience: 'internal',
    });
    expect(a.artifact.fileSha256).toBe(b.artifact.fileSha256);
    const csv = new TextDecoder().decode(a.bytes);
    expect(csv).toContain('scope1');
    expect(csv).toContain('1240.5');
    expect(csv).toContain('2025-04-01');
  });

  it('A32: 対外用の原稿に社内コメント・非公開資料のファイル名を含めない（社内確認用には含める）', async () => {
    fixture.reviewComments.push({
      id: 'major-comment',
      organizationId: ORG_IDS.aomi,
      blockId: IDS.blocks.fy2026Governance.block,
      blockVersionId: IDS.blocks.fy2026Governance.version,
      paragraphId: 'gov-2',
      body: '【社内】執行役員の報告頻度は人事部に再確認すること',
      severity: 'major',
      createdAt: '2026-08-20T00:00:00.000Z',
      createdBy: userId('reviewer@demo.local'),
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    });
    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);

    const external = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'external',
      frameworkVersionId: fixture.projectFrameworks.find(
        (p) => p.id === IDS.projectFrameworks.fy2026Ssbj,
      )!.frameworkVersionId,
    });
    const externalText = await docxText(external.bytes);
    expect(externalText).not.toContain('【社内】執行役員の報告頻度');
    expect(externalText).not.toContain('要対応コメント');
    expect(externalText).not.toContain(COMMITTEE_FILE);
    expect(externalText).not.toContain(RISK_FILE);
    expect(externalText).toContain('［出典: 社内資料］');
    expect(externalText).toContain('草稿・未承認箇所あり');
    // 作成者などの個人の情報（氏名・利用者 ID）を出さない
    expect(externalText).not.toContain('海野');
    expect(externalText).not.toContain(userId('sustainability@demo.local'));

    const internal = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'internal',
    });
    const internalText = await docxText(internal.bytes);
    expect(internalText).toContain('【社内】執行役員の報告頻度');
    expect(internalText).toContain(COMMITTEE_FILE);

    // 対外用 CSV には内部の ID・承認の内訳を出さない
    const csvExternal = buildMetricCsv(snapshot, 'external');
    expect(csvExternal).not.toContain(SCOPE1_CORRECTION.citedVersionId);
    expect(buildMetricCsv(snapshot, 'internal')).toContain(SCOPE1_CORRECTION.citedVersionId);
  });

  it('A29: 他テナントのスナップショット ID は存在を明かさず「見つからない」とする', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);
    await expect(
      exportReportSnapshot(db, otherTenant(), {
        snapshotId: snapshot.id,
        format: 'docx',
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      exportReportSnapshot(db, otherTenant(), {
        snapshotId: '00000000-0000-4000-8000-000000000000',
        format: 'docx',
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadOwnedSnapshot(db, otherTenant(), snapshot.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(listProjectSnapshots(db, otherTenant(), FY2026)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(createReviewDraftSnapshot(db, otherTenant(), FY2026)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(fixture.exportArtifacts).toHaveLength(0);
  });

  it('出力の権限は再出力のたびに確認し、ID の有無より先に判定する', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);
    // レビュー担当は出力の権限を持たない
    await expect(
      exportReportSnapshot(db, reviewer(), {
        snapshotId: snapshot.id,
        format: 'csv',
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      exportReportSnapshot(db, reviewer(), {
        snapshotId: 'no-such-snapshot',
        format: 'csv',
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('対応表（XLSX）は社内確認用だけで、要求事項 ID・節の版・根拠・指標の版・承認状態を持つ', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);
    await expect(
      exportReportSnapshot(db, author(), {
        snapshotId: snapshot.id,
        format: 'xlsx',
        audience: 'external',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const result = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'xlsx',
      audience: 'internal',
    });
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.bytes as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('対応表')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(
      expect.arrayContaining(['要求事項ID', '原稿の節', '節の版', '承認状態', '指標の版']),
    );
    const rows: string[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) rows.push((row.values as unknown[]).slice(1).join('|'));
    });
    expect(
      rows.some(
        (r) => r.includes('気候-47(1)') && r.includes('指標及び目標') && r.includes('版 1'),
      ),
    ).toBe(true);
    expect(rows.some((r) => r.includes(SCOPE1_CORRECTION.citedVersionId))).toBe(true);
    expect(rows.some((r) => r.includes(COMMITTEE_FILE))).toBe(true);

    // 対応表にもファイル作成が提出ではないことを書く（§6.10）
    const allText: string[] = [];
    workbook.eachSheet((s) =>
      s.eachRow((row) => allText.push((row.values as unknown[]).slice(1).join('|'))),
    );
    expect(allText.join('\n')).toContain('ファイル作成は提出ではありません');
  });
});

// ----------------------------------------------------------------------
// 数式インジェクション
// ----------------------------------------------------------------------

describe('数式インジェクション対策', () => {
  it('先頭が = + - @ の文字列を無害化する', () => {
    expect(neutralizeFormula('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(neutralizeFormula('+cmd')).toBe(`'+cmd`);
    expect(neutralizeFormula('-1+1')).toBe(`'-1+1`);
    expect(neutralizeFormula('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeFormula('ガバナンス')).toBe('ガバナンス');
  });

  it('XLSX と CSV の文字列セルは数式として解釈されない', async () => {
    const block = fixture.disclosureBlocks.find((b) => b.id === IDS.blocks.fy2026Governance.block)!;
    block.title = '=HYPERLINK("http://evil.example","x")';
    const metric = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope1',
    )!;
    metric.name = '+SUM(1,2)';

    const snapshot = await createReviewDraftSnapshot(db, author(), FY2026);
    const bytes = await buildMappingXlsx(snapshot);
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

    let checked = 0;
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          // 数式セルを 1 つも作らない
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
          if (typeof cell.value === 'string') {
            expect(cell.numFmt).toBe('@');
            expect(/^[=+\-@]/.test(cell.value)).toBe(false);
            checked += 1;
          }
        });
      });
    });
    expect(checked).toBeGreaterThan(10);

    const csv = buildMetricCsv(snapshot, 'internal');
    expect(csv).toContain(`'+SUM(1,2)`);
    expect(csv).not.toMatch(/(^|,)\+SUM/m);
  });
});
