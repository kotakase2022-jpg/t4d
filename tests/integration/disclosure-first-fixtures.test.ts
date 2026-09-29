import { beforeEach, describe, expect, it } from 'vitest';
import { collectRefs, detectHandwrittenNumbers, plainTextOf } from '@/lib/domain/disclosure-block';
import {
  canCompleteReview,
  canFinalApprove,
  evaluateBlockBlockers,
  reviewEventIdempotencyKey,
} from '@/lib/domain/disclosure-status';
import {
  NARRATIVE_TEMPLATE_FIELDS,
  missingTemplateFields,
  unknownTemplateKeys,
} from '@/lib/domain/narrative-template';
import { FIXTURE_TODAY } from '@/lib/config';
import { formatNumber } from '@/lib/format/datetime';
import { ORG_IDS, PERIOD_IDS, dataPointId, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import {
  DISCLOSURE_DOCUMENTS,
  disclosureDocumentIds,
  renderDisclosureDocument,
} from '@/lib/fixtures/disclosure-documents';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { looksTabular, parseUploadedFile } from '@/lib/imports/parsers';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { readOwnedFileBytes } from '@/lib/storage';
import type {
  AuthorizationContext,
  DisclosureBlock,
  DisclosureBlockVersion,
  RoleKey,
} from '@/types/domain';

/**
 * 開示優先モードのデモ Fixture（docs/disclosure-first.md §7）の不変条件。
 *
 * デモと E2E はこの筋書きの上で動く。Fixture を直したときに筋書きが黙って崩れないよう、
 * 画面が頼る事実（承認済み・再確認が必要・未確定・同じ版の再利用・職務分離）をここで押さえる。
 */

let fixture: FixtureDb;

beforeEach(() => {
  fixture = createFixtureDb();
});

const AUTHOR = userId('sustainability@demo.local');
const REVIEWER = userId('reviewer@demo.local');
const APPROVER = userId('approver@demo.local');

function block(id: string): DisclosureBlock {
  const row = fixture.disclosureBlocks.find((b) => b.id === id);
  if (!row) throw new Error(`block ${id} が無い`);
  return row;
}

function blockVersion(id: string | null): DisclosureBlockVersion {
  const row = fixture.disclosureBlockVersions.find((v) => v.id === id);
  if (!row) throw new Error(`block version ${id} が無い`);
  return row;
}

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

describe('機能設定', () => {
  it('主役の企業だけに行があり、開示優先モードは false（A01: 切替は発表者・E2E が行う）', () => {
    const rows = fixture.organizationFeatureSettings;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: ORG_IDS.aomi, disclosureFirst: false });
    expect(rows.some((r) => r.organizationId === ORG_IDS.soten)).toBe(false);
  });
});

describe('基準の版メタデータ', () => {
  it('ESRS-40a は公開草案・要求事項未収録で、要求事項を 1 件も持たない', () => {
    const framework = fixture.frameworks.find((f) => f.key === 'esrs_40a');
    expect(framework?.id).toBe(IDS.esrs40aFramework);
    const versions = fixture.frameworkVersions.filter((v) => v.frameworkId === framework?.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: IDS.esrs40aVersion,
      versionCode: 'esrs-40a-ed-2026-07',
      legalStatus: 'draft',
      coverageStatus: 'not_loaded',
      materialityBasis: 'impact',
      jurisdiction: 'EU',
      issuedAt: '2026-07-23',
    });
    expect(
      fixture.disclosureItems.filter((i) => i.frameworkVersionId === IDS.esrs40aVersion),
    ).toEqual([]);
  });

  it('SSBJ は公表済み・一部収録（133 項目）、CSRD は架空サンプル（12 項目）と明示される', () => {
    const ssbj = fixture.frameworkVersions.find(
      (v) => v.id === fid('framework_version', 'ssbj/2026'),
    );
    expect(ssbj).toMatchObject({
      versionCode: 'ssbj-2026-03-13',
      // 「採択済み（未発効）」は EU の委任規則の状態。SSBJ は公表した基準（REG-F4）
      legalStatus: 'promulgated',
      coverageStatus: 'partial',
      issuedAt: '2026-03-13',
      jurisdiction: 'JP',
      materialityBasis: 'financial',
      verifiedAt: '2026-09-29',
    });
    expect(ssbj?.coverageNote).toContain('133項目');
    expect(fixture.disclosureItems.filter((i) => i.frameworkVersionId === ssbj?.id)).toHaveLength(
      133,
    );

    const csrd = fixture.frameworkVersions.find(
      (v) => v.id === fid('framework_version', 'csrd/2026'),
    );
    expect(csrd).toMatchObject({ legalStatus: 'sample', coverageStatus: 'sample' });
    expect(csrd?.coverageNote).toContain('12項目');
    expect(fixture.disclosureItems.filter((i) => i.frameworkVersionId === csrd?.id)).toHaveLength(
      12,
    );
  });
});

describe('根拠資料（架空）と引用位置', () => {
  it('3 資料が利用目的・版・発行日付きで登録され、段落単位の抽出結果を持つ', () => {
    const files = DISCLOSURE_DOCUMENTS.map((spec) => {
      const file = fixture.files.find((f) => f.id === disclosureDocumentIds(spec.key).fileId);
      expect(file, spec.key).toBeDefined();
      return file!;
    });
    expect(files.map((f) => f.usagePurpose)).toEqual([
      'prior_year_text',
      'current_fact',
      'current_fact',
    ]);
    for (const file of files) {
      expect(file.originalName).toContain('架空');
      expect(file.editionLabel).toContain('架空');
      expect(file.issuedOn).not.toBeNull();
      const fragments = fixture.fragments.filter((f) => f.fileVersionId === file.currentVersionId);
      expect(fragments.length).toBeGreaterThanOrEqual(4);
      expect(fragments.every((f) => f.kind === 'text' && f.locator)).toBe(true);
      // ページ番号の重複が無い（抽出テキスト表示のページ送りが崩れない）
      expect(new Set(fragments.map((f) => f.page)).size).toBe(fragments.length);
    }
  });

  it('引用位置は抽出結果から取った段落で、引用文は断片の本文と一致する', () => {
    expect(fixture.sourceAnchors).toHaveLength(Object.keys(IDS.anchors).length);
    for (const anchor of fixture.sourceAnchors) {
      expect(anchor.acquiredBy).toBe('extracted');
      expect(anchor.anchorKind).toBe('heading_paragraph');
      const fragment = fixture.fragments.find((f) => f.id === anchor.fragmentId);
      expect(fragment?.fileVersionId).toBe(anchor.fileVersionId);
      expect(fragment?.text).toContain(anchor.quoteText);
      expect(anchor.locator).toBe(fragment?.locator);
    }
  });

  it('当年度の定性情報は当年度の根拠だけを、前年度の版は過年度の記載だけを引用する', () => {
    const purposeOfAnchor = (anchorId: string) => {
      const anchor = fixture.sourceAnchors.find((a) => a.id === anchorId);
      const version = fixture.fileVersions.find((v) => v.id === anchor?.fileVersionId);
      return fixture.files.find((f) => f.id === version?.fileId)?.usagePurpose;
    };
    for (const version of fixture.narrativeVersions) {
      const expected =
        version.reportingPeriodId === PERIOD_IDS.fy2025 ? 'prior_year_text' : 'current_fact';
      expect(version.sourceAnchorIds.length).toBeGreaterThan(0);
      expect(version.sourceAnchorIds.map(purposeOfAnchor)).toEqual(
        version.sourceAnchorIds.map(() => expected),
      );
    }
  });

  it('Demo Mode のストレージは資料の本文をテキストとして返し、表ではなく資料として読める', async () => {
    const db = new DemoDbClient(fixture);
    const ctx = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    for (const spec of DISCLOSURE_DOCUMENTS) {
      const ids = disclosureDocumentIds(spec.key);
      const stored = await readOwnedFileBytes(db, ctx, ids.fileVersionId);
      expect(stored, spec.key).not.toBeNull();
      // UTF-8 の BOM 付き（Windows のアプリで開いても文字化けしない）。TextDecoder は BOM を外して読む
      expect([...stored!.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const decoded = new TextDecoder().decode(stored!.bytes);
      expect(decoded).toBe(renderDisclosureDocument(spec));
      for (const paragraph of spec.paragraphs) expect(decoded).toContain(paragraph.text);

      const version = fixture.fileVersions.find((v) => v.id === ids.fileVersionId);
      expect(version?.sizeBytes).toBe(stored!.bytes.length);

      expect(looksTabular(decoded)).toBe(false);
      const parsed = await parseUploadedFile(spec.fileName, 'text/plain', stored!.bytes);
      expect(parsed.kind).toBe('text');
    }
  });

  it('他社のユーザーには資料の本文を返さない', async () => {
    const db = new DemoDbClient(fixture);
    const other: AuthorizationContext = {
      ...ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin']),
      workspace: {
        ...ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin']).workspace,
        organizationId: ORG_IDS.soten,
      },
    };
    const ids = disclosureDocumentIds('fy2026-sustainability-committee-3');
    expect(await readOwnedFileBytes(db, other, ids.fileVersionId)).toBeNull();
  });
});

describe('定性情報', () => {
  it('ガバナンスは確認済み（版 2 を検見川が確認）で、前年度の版 1 から引き継いでいる', () => {
    const record = fixture.narrativeRecords.find((r) => r.id === IDS.narratives.governance);
    expect(record).toMatchObject({
      theme: 'governance',
      status: 'confirmed',
      currentVersionId: IDS.narrativeVersions.governanceFy2026,
      confirmedVersionId: IDS.narrativeVersions.governanceFy2026,
      confirmedBy: REVIEWER,
    });
    const v2 = fixture.narrativeVersions.find(
      (v) => v.id === IDS.narrativeVersions.governanceFy2026,
    );
    expect(v2?.carriedFromVersionId).toBe(IDS.narrativeVersions.governanceFy2025);
    expect(v2?.body).toContain('年4回');
    const v1 = fixture.narrativeVersions.find(
      (v) => v.id === IDS.narrativeVersions.governanceFy2025,
    );
    expect(v1?.body).toContain('年2回開催');
  });

  it('ガバナンス以外は下書き', () => {
    const others = fixture.narrativeRecords.filter((r) => r.id !== IDS.narratives.governance);
    expect(others.map((r) => r.theme).sort()).toEqual([
      'financial_impact',
      'risk_opportunity',
      'risk_opportunity',
      'strategy',
    ]);
    expect(others.every((r) => r.status === 'draft' && r.confirmedVersionId === null)).toBe(true);
  });

  it('財務的影響は金額を持たず、示さない理由を持つ（未確定を 0 で埋めない）', () => {
    const version = fixture.narrativeVersions.find(
      (v) => v.id === IDS.narrativeVersions.financialImpact,
    );
    expect(version).toBeDefined();
    expect(Object.keys(version!.fields)).not.toContain('amount');
    expect(version!.fields.noAmountReason).toContain('評価中');
    expect(version!.body).toContain('未確定');
    expect(missingTemplateFields('financial_impact', version!.fields).map((f) => f.key)).toEqual([
      'amount',
      'amountBasis',
    ]);
  });

  it('全ての版の項目キーはテンプレートの項目で、空文字の項目を置かない', () => {
    for (const version of fixture.narrativeVersions) {
      const record = fixture.narrativeRecords.find((r) => r.id === version.narrativeRecordId);
      expect(record).toBeDefined();
      expect(unknownTemplateKeys(record!.theme, version.fields)).toEqual([]);
      expect(Object.values(version.fields).every((value) => value.trim() !== '')).toBe(true);
    }
    expect(Object.keys(NARRATIVE_TEMPLATE_FIELDS).sort()).toEqual([
      'financial_impact',
      'governance',
      'policy_other',
      'risk_opportunity',
      'strategy',
    ]);
  });
});

describe('プロジェクトと適用判断', () => {
  it('FY2026 は進行中で、担当・レビュー・最終承認が別の人に割り当てられている', () => {
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026);
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026);
    expect(project).toMatchObject({
      name: 'FY2026 統合開示（SSBJ・CSRD域外準備）',
      status: 'active',
      purposes: ['ssbj_voluntary', 'csrd_40a_prep'],
      ownerUserId: AUTHOR,
      reviewerUserId: REVIEWER,
      finalApproverUserId: APPROVER,
      periodStart: period?.startDate,
      periodEnd: period?.endDate,
    });
    expect(project!.dueDate! > FIXTURE_TODAY).toBe(true);

    const prior = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2025);
    expect(prior).toMatchObject({ status: 'closed', reportingPeriodId: PERIOD_IDS.fy2025 });
  });

  it('SSBJ は理由・参照規則・確認日付きで「適用と判断」が確定し、ESRS-40a は判断未確定の適用候補', () => {
    const ssbj = fixture.projectFrameworks.find((f) => f.id === IDS.projectFrameworks.fy2026Ssbj);
    expect(ssbj).toMatchObject({
      applicabilityStatus: 'applicable',
      currentDecisionId: IDS.decisions.fy2026Ssbj,
      purpose: 'ssbj_voluntary',
    });
    const decision = fixture.projectFrameworkDecisions.find(
      (d) => d.id === ssbj?.currentDecisionId,
    );
    expect(decision).toMatchObject({
      applicabilityStatus: 'applicable',
      ruleRef: 'SSBJ 2026-03-13 改正基準／任意適用の社内決定（架空）',
      decidedBy: userId('enterprise-admin@demo.local'),
    });
    expect(decision!.reason.trim()).not.toBe('');
    expect(decision!.confirmedOn <= FIXTURE_TODAY).toBe(true);

    const esrs = fixture.projectFrameworks.find(
      (f) => f.id === IDS.projectFrameworks.fy2026Esrs40a,
    );
    expect(esrs).toMatchObject({
      frameworkVersionId: IDS.esrs40aVersion,
      purpose: 'csrd_40a_prep',
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
      conditions: {},
    });
    expect(
      fixture.projectFrameworkDecisions.filter((d) => d.projectFrameworkId === esrs?.id),
    ).toEqual([]);
  });

  it('節の基準は、そのプロジェクトが扱うと決めた版に限られる', () => {
    for (const b of fixture.disclosureBlocks) {
      expect(
        fixture.projectFrameworks.some(
          (f) => f.projectId === b.projectId && f.frameworkVersionId === b.frameworkVersionId,
        ),
        b.sectionKey,
      ).toBe(true);
    }
  });
});

describe('節とレビュー', () => {
  it('指標の節は承認済みだが、引用した Scope1 には承認後の新しい版があり「再確認が必要」になる', () => {
    const metrics = block(IDS.blocks.fy2026Metrics.block);
    expect(metrics.status).toBe('approved');
    const approved = blockVersion(metrics.approvedVersionId);
    expect(approved.metricRefs).toEqual([SCOPE1_CORRECTION.citedVersionId]);

    const dp = fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId);
    expect(dp?.currentVersionId).toBe(SCOPE1_CORRECTION.correctedVersionId);
    const cited = fixture.dataPointVersions.find((v) => v.id === SCOPE1_CORRECTION.citedVersionId);
    const current = fixture.dataPointVersions.find((v) => v.id === dp?.currentVersionId);
    // 引用した版のほうが古い（承認後に新しい版ができた）
    expect(cited!.versionNo).toBeLessThan(current!.versionNo);
    expect(current!.createdAt > approved.createdAt).toBe(true);
    const approvedEvent = fixture.reviewEvents.find(
      (e) => e.reviewRequestId === IDS.blocks.fy2026Metrics.request && e.eventType === 'approved',
    );
    expect(current!.createdAt > approvedEvent!.createdAt).toBe(true);
    expect(current!.changeReason).toBe('集計範囲の訂正（架空）');

    const blockers = evaluateBlockBlockers({
      body: approved.body,
      pendingAiCandidateCount: 0,
      comments: [],
      metricRefs: [
        {
          dataPointId: dp!.id,
          dataPointVersionId: approved.metricRefs[0]!,
          currentVersionId: dp!.currentVersionId,
          label: 'Scope1 排出量',
        },
      ],
      frameworks: [],
    });
    expect(blockers.map((b) => b.code)).toEqual(['stale_metric_refs']);

    // 本文の表示は引用した版の値のまま（黙って新しい値に変わらない）
    expect(plainTextOf(approved.body)).toContain(
      `${formatNumber(cited!.value)} ${cited!.unitOfMeasure}`,
    );
  });

  it('訂正は値を変えず、再承認済みで、既存のデモ（承認済み・検証結果なし・Snapshot 後変更 2 件）を崩さない', () => {
    const dp = fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId)!;
    const cited = fixture.dataPointVersions.find((v) => v.id === SCOPE1_CORRECTION.citedVersionId)!;
    const current = fixture.dataPointVersions.find((v) => v.id === dp.currentVersionId)!;
    expect(current.value).toBe(cited.value);
    expect(dp.value).toBe(cited.value);
    expect(dp.status).toBe('approved');
    expect(dp.changedAfterApproval).toBe(false);
    expect(dp.approvedBy).toBe(APPROVER);
    const approval = fixture.approvals.find((a) => a.id === SCOPE1_CORRECTION.approvalId);
    expect(approval).toMatchObject({ targetVersionId: current.id, decision: 'approved' });

    expect(fixture.validations.filter((v) => v.dataPointId === dp.id)).toEqual([]);

    // Data Room・SNAP-1 は訂正後の版を指す（訂正は Snapshot 固定より前）
    const shared = fixture.dataRoomItems.find((i) => i.sourceId === dp.id);
    expect(shared?.sourceVersionId).toBe(current.id);
    const frozen = fixture.snapshotItems.find((i) => i.sourceId === dp.id);
    expect(frozen?.sourceDataPointVersionId).toBe(current.id);
    expect(frozen?.hash).toBe(current.contentHash);
    const changedSinceSnapshot = fixture.snapshotItems.filter((item) => {
      const point = fixture.dataPoints.find((d) => d.id === item.sourceId);
      const version = fixture.dataPointVersions.find((v) => v.id === point?.currentVersionId);
      return version && version.contentHash !== item.hash;
    });
    expect(changedSinceSnapshot).toHaveLength(2);
  });

  it('承認済みのガバナンスは、依頼者・レビュー完了者・最終承認者が別人で、全ての判断が依頼の版に対するもの', () => {
    const governance = block(IDS.blocks.fy2026Governance.block);
    expect(governance.status).toBe('approved');
    const request = fixture.reviewRequests.find((r) => r.targetId === governance.id);
    expect(request).toMatchObject({
      status: 'approved',
      requestedBy: AUTHOR,
      reviewerUserId: REVIEWER,
      approverUserId: APPROVER,
      targetVersionId: governance.approvedVersionId,
      policyVersion: 'sod-3role-v1',
      decisionIds: [IDS.decisions.fy2026Ssbj],
    });

    const events = fixture.reviewEvents
      .filter((e) => e.reviewRequestId === request!.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    expect(events.map((e) => [e.eventType, e.stage])).toEqual([
      ['requested', 'request'],
      ['review_completed', 'review'],
      ['approved', 'final'],
    ]);
    const [requested, reviewed, approved] = events;
    expect(
      new Set([requested!.actorUserId, reviewed!.actorUserId, approved!.actorUserId]).size,
    ).toBe(3);
    for (const e of events) {
      expect(e.targetVersionId).toBe(request!.targetVersionId);
      expect(e.idempotencyKey).toBe(
        reviewEventIdempotencyKey(request!.id, e.stage, request!.targetVersionId),
      );
    }

    const version = blockVersion(request!.targetVersionId);
    expect(
      canCompleteReview({
        actorId: reviewed!.actorUserId,
        request: { requestedBy: request!.requestedBy, status: 'open' },
        targetVersionCreatedBy: version.createdBy,
      }).ok,
    ).toBe(true);
    expect(
      canFinalApprove({
        actorId: approved!.actorUserId,
        request: { requestedBy: request!.requestedBy, status: 'reviewed' },
        targetVersionCreatedBy: version.createdBy,
        reviewCompletedBy: reviewed!.actorUserId,
      }).ok,
    ).toBe(true);
    // 依頼時点の参照の写しは、依頼した版の本文から集めたものと一致する
    expect(request!.referencedVersions).toEqual(collectRefs(version.body));
  });

  it('承認済みの節には必ずレビュー依頼と 3 件の記録があり、下書きの節には依頼が無い', () => {
    for (const b of fixture.disclosureBlocks) {
      const requests = fixture.reviewRequests.filter((r) => r.targetId === b.id);
      if (b.status === 'approved') {
        expect(requests, b.sectionKey).toHaveLength(1);
        expect(
          fixture.reviewEvents.filter((e) => e.reviewRequestId === requests[0]!.id),
        ).toHaveLength(3);
        expect(b.approvedVersionId).toBe(b.submittedVersionId);
      } else {
        expect(b.status).toBe('draft');
        expect(requests, b.sectionKey).toEqual([]);
        expect(b.submittedVersionId).toBeNull();
      }
    }
  });

  it('同じガバナンスの定性情報の版を、SSBJ と ESRS-40a の節が別々に引用している（A20）', () => {
    const governance = blockVersion(block(IDS.blocks.fy2026Governance.block).approvedVersionId);
    const esrsBlock = block(IDS.blocks.fy2026Esrs40aGovernance.block);
    const esrs = blockVersion(esrsBlock.currentVersionId);
    const shared = IDS.narrativeVersions.governanceFy2026;
    expect(governance.narrativeRefs).toContain(shared);
    expect(esrs.narrativeRefs).toContain(shared);
    expect(block(IDS.blocks.fy2026Governance.block).frameworkVersionId).toBe(
      fid('framework_version', 'ssbj/2026'),
    );
    expect(esrsBlock.frameworkVersionId).toBe(IDS.esrs40aVersion);
    // 承認は基準ごとに独立（ESRS-40a 側は下書きのまま）
    expect(esrsBlock.status).toBe('draft');
    expect(esrsBlock.requirementItemIds).toEqual([]);
  });

  it('リスク・機会は下書きで、財務的影響が未確定である段落を持ち、レビュー依頼の阻害条件が無い', () => {
    const risk = block(IDS.blocks.fy2026RiskOpportunity.block);
    expect(risk.status).toBe('draft');
    const version = blockVersion(risk.currentVersionId);
    expect(plainTextOf(version.body)).toContain('未確定');
    expect(version.narrativeRefs).toContain(IDS.narrativeVersions.financialImpact);
    expect(detectHandwrittenNumbers(version.body)).toEqual([]);

    const comments = fixture.reviewComments.filter((c) => c.blockId === risk.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ severity: 'info', resolvedBy: AUTHOR });
    expect(comments[0]!.resolvedAt).not.toBeNull();

    const frameworks = fixture.projectFrameworks
      .filter((f) => f.projectId === risk.projectId)
      .map((f) => ({
        frameworkVersionId: f.frameworkVersionId,
        label: f.frameworkVersionId,
        applicabilityStatus: f.applicabilityStatus,
      }));
    expect(
      evaluateBlockBlockers({
        body: version.body,
        pendingAiCandidateCount: 0,
        comments,
        metricRefs: [],
        frameworks,
      }),
    ).toEqual([]);
  });

  it('FY2025 の節は承認済みで、前年に公表した文章と同じ段落 ID を持つ（前年比較の元）', () => {
    const prior = block(IDS.blocks.fy2025Governance.block);
    const current = block(IDS.blocks.fy2026Governance.block);
    expect(prior).toMatchObject({ status: 'approved', sectionKey: current.sectionKey });
    const priorBody = blockVersion(prior.approvedVersionId).body;
    const currentBody = blockVersion(current.approvedVersionId).body;
    expect(priorBody.paragraphs.map((p) => p.id)).toEqual(currentBody.paragraphs.map((p) => p.id));
    expect(plainTextOf(priorBody)).toContain('年2回開催');
    expect(plainTextOf(currentBody)).toContain('年4回開催');
    const priorMetrics = block(IDS.blocks.fy2025Metrics.block);
    expect(priorMetrics.status).toBe('approved');
    expect(blockVersion(priorMetrics.approvedVersionId).metricRefs).toEqual([
      fid('data_point_version', `${dataPointId('HQ', 'scope1', 'FY2025')}/v1`),
    ]);
  });

  it('版の本文・参照・ハッシュは本文 AST から計算した値と一致する', () => {
    for (const version of fixture.disclosureBlockVersions) {
      const refs = collectRefs(version.body);
      expect(version.plainText).toBe(plainTextOf(version.body));
      expect(version.metricRefs).toEqual(refs.metricVersionIds);
      expect(version.narrativeRefs).toEqual(refs.narrativeVersionIds);
      expect(version.anchorRefs).toEqual(refs.anchorIds);
      expect(version.origin).toBe('human');
      expect(version.createdBy).toBe(AUTHOR);
      for (const id of refs.anchorIds) {
        expect(fixture.sourceAnchors.some((a) => a.id === id)).toBe(true);
      }
      for (const id of refs.narrativeVersionIds) {
        expect(fixture.narrativeVersions.some((v) => v.id === id)).toBe(true);
      }
    }
  });
});

describe('KPI 目標', () => {
  it('Scope1 の目標は実績と同じ境界、Scope2（マーケット基準）の目標は境界が違う（比較条件の確認が必要）', () => {
    const scope1 = fixture.kpiTargets.find((t) => t.id === IDS.kpiTargets.scope1);
    const scope2 = fixture.kpiTargets.find((t) => t.id === IDS.kpiTargets.scope2Market);
    expect(scope1).toMatchObject({
      metricId: metricId('AOMI', 'scope1'),
      baseYear: 2023,
      targetYear: 2030,
    });
    expect(scope2).toMatchObject({
      metricId: metricId('AOMI', 'scope2'),
      baseYear: 2023,
      targetYear: 2030,
    });

    // 実績（FY2026 の Data Point）の境界の集合
    const boundariesOf = (metric: string) =>
      new Set(
        fixture.dataPoints
          .filter((d) => d.metricId === metric && d.reportingPeriodId === PERIOD_IDS.fy2026)
          .map((d) => d.boundary),
      );
    const hqScope1 = fixture.dataPoints.find((d) => d.id === SCOPE1_CORRECTION.dataPointId);
    expect(scope1!.boundary).toBe(hqScope1?.boundary);
    expect(boundariesOf(scope2!.metricId).has(scope2!.boundary)).toBe(false);
    expect(scope2!.scopeNote).not.toBe(scope1!.scopeNote);
  });
});

describe('架空であること', () => {
  it('Fixture 全体とデモ資料の本文に実在の顧客候補の名称を含まない', () => {
    const everything = JSON.stringify(fixture);
    expect(everything).not.toContain('\u65e5\u6771');
    expect(everything).not.toMatch(/\u006e\u0069\u0074\u0074\u006f/i);
    for (const spec of DISCLOSURE_DOCUMENTS) {
      expect(renderDisclosureDocument(spec)).not.toContain('\u65e5\u6771');
      expect(renderDisclosureDocument(spec)).toContain('架空');
    }
  });
});
