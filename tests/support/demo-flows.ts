import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import type { FixtureDb } from '@/lib/fixtures/store';
import { parseDocx } from '@/lib/imports/docx-text';
import type { DemoDbClient } from '@/lib/repositories/demo-client';
import { decideApprovalStep } from '@/lib/services/approval-route';
import {
  adoptCsrdDraft,
  confirmCsrdDraft,
  generateCsrdDraft,
  saveCsrdDraftBody,
} from '@/lib/services/csrd/draft';
import {
  createCsrdActionPlan,
  createCsrdCollectionItem,
  updateCsrdActionPlan,
} from '@/lib/services/csrd/plans';
import { reviewCsrdAssessment, runCsrdGapAnalysis } from '@/lib/services/csrd/requirements';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import { transitionDataPoint } from '@/lib/services/data-point-workflow';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
} from '@/lib/services/disclosure-ai-draft';
import { metricDisplay, saveBlockVersion } from '@/lib/services/disclosure-block';
import { exportReportSnapshot } from '@/lib/services/disclosure-export';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  addReviewComment,
  completeReview,
  finalApprove,
  requestReview,
  returnReview,
} from '@/lib/services/disclosure-review';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import { confirmNarrative, createNarrative } from '@/lib/services/narrative';
import {
  commitQuantitativeImport,
  validateQuantitativeImport,
  type ValidateQuantitativeImportInput,
} from '@/lib/services/quantitative-import';
import { confirmReport, listProjectSnapshots } from '@/lib/services/report-snapshot';
import { createAnchorFromFragment } from '@/lib/services/source-anchor';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 「すべてのリクエストが別インスタンスに届く」最悪の場合の実演の流れ（Service の層）。
 * 手順ごとに Fixture を作り直し、Cookie の操作だけを適用した DB（fresh）で次の手順を行う。
 *  - playMainDemoFlow: §14.1 の実演（zz-disclosure-project.spec.ts と同じ）。リセットの手前まで
 *  - playCsrdChain: §9.7 の CSRD の流れ（zzz-csrd-chain.spec.ts と同じ）
 * 呼び出し側（テストファイル）が next/headers の cookies() を差し替え、fresh を渡す。
 */

export type Fresh = () => Promise<{ db: DemoDbClient; fixture: FixtureDb }>;

export function demoCtx(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

export const author = () => demoCtx('sustainability@demo.local', ['sustainability_manager']);
export const reviewer = () => demoCtx('reviewer@demo.local', ['reviewer']);
export const approver = () => demoCtx('approver@demo.local', ['approver', 'reviewer']);
export const admin = () => demoCtx('enterprise-admin@demo.local', ['enterprise_admin']);

export const RISK = IDS.blocks.fy2026RiskOpportunity.block;
export const ESRS = IDS.blocks.fy2026Esrs40aGovernance.block;
export const METRICS = IDS.blocks.fy2026Metrics.block;
export const WATER_EU = dataPointId('EU', 'water', 'FY2026');

function standardCsv(value: string): Uint8Array {
  const text = [
    'metric_code,period_start,period_end,entity_code,value,unit,source_reference',
    `water,2026-04-01,2027-03-31,EU,${value},m3,欧州販売子会社 検針票の再集計（架空）`,
  ].join('\n');
  // 表計算ソフトから保存した CSV と同じく BOM 付き UTF-8 にする
  return new TextEncoder().encode(`${String.fromCharCode(0xfeff)}${text}\n`);
}

export function csvSource(name: string, value: string): ValidateQuantitativeImportInput {
  return {
    reportingPeriodId: PERIOD_IDS.fy2026,
    source: { kind: 'file', fileName: name, bytes: standardCsv(value) },
  };
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const parsed = await parseDocx(bytes);
  expect(parsed.status).toBe('parsed');
  return parsed.paragraphs.join('\n');
}

export interface MainDemoFlowResult {
  snapshotId: string;
  /** 対外用 DOCX の内容ハッシュと本文（訂正の後も変わらないことを確かめる） */
  externalHash: string;
  externalText: string;
  ssbjVersionId: string;
  v1Id: string;
  v3Id: string;
  narrativeRecordId: string;
}

/**
 * §14.1 の実演: CSV → 数値の承認 → 定性情報と引用 → AI 下書き → 版・依頼 → 差戻し → 再依頼 → 承認 →
 * 確定 → DOCX → 訂正 → 再確認（リセットの手前まで）。measure は手順ごとに Cookie の大きさを記録する
 */
export async function playMainDemoFlow(
  fresh: Fresh,
  measure: (step: string) => void = () => {},
): Promise<MainDemoFlowResult> {
  // 1. 開示優先モードを有効にする（管理者）
  await setDisclosureFirst((await fresh()).db, admin(), true);
  measure('A01 開示優先モード');

  // 2. 標準 CSV: 検証と確定が別のインスタンスに届く。確定は元の入力を送り直し、サーバーが検証し直す
  const firstCsv = csvSource('eu-water-fy2026.csv', '23480.5');
  const preview = await validateQuantitativeImport((await fresh()).db, author(), firstCsv);
  expect(preview.counts.changed).toBe(1);
  const key = randomUUID();
  const commitInput = {
    batchId: preview.batchId,
    previewHash: preview.previewHash,
    idempotencyKey: key,
    mode: 'all' as const,
    correctionReason: 'E2E: 検針票の再集計により訂正',
    source: firstCsv,
  };
  const committed = await commitQuantitativeImport((await fresh()).db, author(), commitInput);
  expect(committed.updated).toBe(1);
  // 成功した確定の再送は、別のインスタンスでも二重に書かない（確定の控えを Cookie で持ち回す）
  const retry = await commitQuantitativeImport((await fresh()).db, author(), commitInput);
  expect(retry.replayed).toBe(true);
  // 同じ内容を別名で検証し直しても「変更なし」（取り込んだ版が別インスタンスにも届いている）
  const duplicate = await validateQuantitativeImport(
    (await fresh()).db,
    author(),
    csvSource('eu-water-fy2026-copy.csv', '23480.5'),
  );
  expect(duplicate.rows[0]?.diffKind).toBe('unchanged');
  {
    const { fixture } = await fresh();
    const versions = fixture.dataPointVersions.filter((v) => v.dataPointId === WATER_EU);
    expect(versions.filter((v) => v.value === 23480.5)).toHaveLength(1);
  }
  // 提出 → 5 段階の承認（段階ごとに別のインスタンス）
  await transitionDataPoint((await fresh()).db, author(), {
    dataPointId: WATER_EU,
    to: 'submitted',
    comment: null,
  });
  for (const actor of [reviewer(), author(), reviewer(), admin(), approver()]) {
    const { db } = await fresh();
    const result = await decideApprovalStep(db, actor, {
      dataPointId: WATER_EU,
      decision: 'approved',
      comment: '',
    });
    if (result.completed) {
      await transitionDataPoint(db, actor, {
        dataPointId: WATER_EU,
        to: 'approved',
        comment: null,
      });
    }
  }
  {
    const { fixture } = await fresh();
    expect(fixture.dataPoints.find((d) => d.id === WATER_EU)?.status).toBe('approved');
  }
  measure('CSV 登録 → 承認');

  // 3. 委員会資料の一部を引用して定性情報を登録し、確認する
  const { fixture: f3 } = await fresh();
  const fragment = f3.fragments.find((f) => f.text.includes('識別したリスク及び機会を審議した'));
  expect(fragment).toBeDefined();
  const anchor = await createAnchorFromFragment((await fresh()).db, author(), {
    fragmentId: fragment!.id,
    quoteText: '識別したリスク及び機会を審議した',
  });
  const narrative = await createNarrative((await fresh()).db, author(), {
    theme: 'risk_opportunity',
    title: 'E2E 委員会でのリスク・機会の審議（架空）',
    ownerDepartment: '',
    tags: [],
    reportingPeriodId: PERIOD_IDS.fy2026,
    scopeNote: '',
    fields: {},
    body: '2026年度第3回サステナビリティ委員会で、識別したリスク及び機会を審議しました。財務的影響の算定は継続中です。',
    sourceAnchorIds: [anchor.id],
  });
  await confirmNarrative((await fresh()).db, author(), {
    narrativeId: narrative.record.id,
    versionId: narrative.version.id,
  });
  measure('定性情報と引用');

  // 4. 原稿: 画面の本文（数値参照・定性情報の引用）で AI 下書きを作り、採用して版を作り、依頼する
  const { fixture: f4 } = await fresh();
  const riskBlock = f4.disclosureBlocks.find((b) => b.id === RISK)!;
  const v1 = f4.disclosureBlockVersions.find((v) => v.id === riskBlock.currentVersionId)!;
  const water = f4.dataPoints.find((d) => d.id === WATER_EU)!;
  const waterVersion = f4.dataPointVersions.find((v) => v.id === water.currentVersionId)!;
  const onScreen: BlockBody = {
    paragraphs: [
      ...v1.body.paragraphs,
      {
        id: 'e2e-metric',
        kind: 'paragraph',
        children: [
          { t: 'text', text: 'E2E確認: 欧州販売子会社の2026年度の水使用量は ' },
          {
            t: 'metric',
            dataPointId: WATER_EU,
            dataPointVersionId: waterVersion.id,
            display: metricDisplay(waterVersion),
          },
          { t: 'text', text: ' です。' },
        ],
      },
      {
        id: 'e2e-quote',
        kind: 'paragraph',
        children: [
          {
            t: 'narrative',
            narrativeVersionId: narrative.version.id,
            quote: narrative.version.body,
          },
        ],
      },
    ],
  };
  const draft = await generateBlockDraft((await fresh()).db, author(), {
    blockId: RISK,
    operation: 'draft_from_sources',
    sources: [
      { kind: 'narrative_version', id: narrative.version.id },
      { kind: 'source_anchor', id: anchor.id },
    ],
    workingBody: onScreen,
  });
  if (draft.status !== 'succeeded') throw new Error('AI 下書きに失敗しました');
  // 採用は別のインスタンス（作業本文が無い）でも、画面の本文に足す（画面の段落を失わない）
  const adopted = await adoptDraftParagraphs((await fresh()).db, author(), {
    blockId: RISK,
    runId: draft.run.runId,
    candidateIndexes: [0],
    workingBody: onScreen,
    baseVersionId: v1.id,
  });
  expect(adopted.status).toBe('applied');
  if (adopted.status !== 'applied') throw new Error('採用できませんでした');
  expect(adopted.body.paragraphs.map((p) => p.id)).toEqual(
    expect.arrayContaining(['e2e-metric', 'e2e-quote']),
  );
  await closeDraftRun((await fresh()).db, author(), {
    blockId: RISK,
    runId: draft.run.runId,
    workingBody: adopted.body,
  });
  const v2 = (
    await saveBlockVersion((await fresh()).db, author(), {
      blockId: RISK,
      baseVersionId: v1.id,
      body: adopted.body,
      changeReason: 'E2E: 数値参照・定性情報・AI 候補の採用を反映',
    })
  ).version;
  expect(v2.versionNo).toBe(2);
  const firstRequest = await requestReview((await fresh()).db, author(), {
    blockId: RISK,
    body: adopted.body,
    baseVersionId: v2.id,
  });
  expect(firstRequest.version.id).toBe(v2.id);
  const { fixture: f4b } = await fresh();
  const esrsBlock = f4b.disclosureBlocks.find((b) => b.id === ESRS)!;
  const esrsBody = f4b.disclosureBlockVersions.find(
    (v) => v.id === esrsBlock.currentVersionId,
  )!.body;
  const esrsRequest = await requestReview((await fresh()).db, author(), {
    blockId: ESRS,
    body: esrsBody,
    baseVersionId: esrsBlock.currentVersionId,
  });
  const metricsBlock = (await fresh()).fixture.disclosureBlocks.find((b) => b.id === METRICS)!;
  const staleItem = (
    await computeBlockFreshness((await fresh()).db, author(), metricsBlock)
  ).items.find((i) => i.refKind === 'metric' && i.newRefId);
  expect(staleItem).toBeDefined();
  await decideRecheck((await fresh()).db, author(), {
    blockId: METRICS,
    refKind: 'metric',
    oldRefId: staleItem!.oldRefId,
    decision: 'keep_old',
    reason: 'E2E: 訂正は集計範囲の注記のみで、本文が引用した承認済みの値は変わらないため',
  });
  measure('原稿・AI 下書き・依頼・再確認');

  // 5. レビュー: コメント → 差戻し → 修正の版 → 再依頼 → レビュー完了 → 最終承認（手順ごとに別インスタンス）
  await addReviewComment((await fresh()).db, reviewer(), {
    blockId: RISK,
    paragraphId: 'e2e-metric',
    body: 'E2E社内メモ: 集計範囲の書き方は社内の表記基準に合わせています。',
    severity: 'info',
  });
  await returnReview((await fresh()).db, reviewer(), {
    requestId: firstRequest.request.id,
    reason: 'E2E: 数値の集計範囲を本文に明記してください。',
    paragraphId: 'e2e-metric',
  });
  await completeReview((await fresh()).db, reviewer(), { requestId: esrsRequest.request.id });
  const fixed: BlockBody = {
    paragraphs: adopted.body.paragraphs.map((p) =>
      p.id === 'e2e-metric'
        ? {
            ...p,
            children: p.children.map((c) =>
              c.t === 'text' && c.text === ' です。'
                ? { t: 'text' as const, text: ' です（集計範囲は欧州販売子会社の全拠点）。' }
                : c,
            ),
          }
        : p,
    ),
  };
  const v3 = (
    await saveBlockVersion((await fresh()).db, author(), {
      blockId: RISK,
      baseVersionId: v2.id,
      body: fixed,
      changeReason: 'E2E: 差戻しを受けて集計範囲を明記',
    })
  ).version;
  expect(v3.versionNo).toBe(3);
  const secondRequest = await requestReview((await fresh()).db, author(), {
    blockId: RISK,
    body: fixed,
    baseVersionId: v3.id,
  });
  await completeReview((await fresh()).db, reviewer(), { requestId: secondRequest.request.id });
  // 作成者は最終承認できない（別インスタンスでも、Cookie から戻した版の作成者で職務分離を確かめる）
  await expect(
    finalApprove((await fresh()).db, author(), { requestId: secondRequest.request.id }),
  ).rejects.toThrow();
  await finalApprove((await fresh()).db, approver(), { requestId: secondRequest.request.id });
  await finalApprove((await fresh()).db, approver(), { requestId: esrsRequest.request.id });
  {
    const { fixture } = await fresh();
    const risk = fixture.disclosureBlocks.find((b) => b.id === RISK)!;
    expect(risk.status).toBe('approved');
    expect(risk.approvedVersionId).toBe(v3.id);
    expect(fixture.disclosureBlockVersions.find((v) => v.id === v3.id)?.contentHash).toBe(
      v3.contentHash,
    );
  }
  measure('差戻し → 再依頼 → 承認');

  // 6. レポートを確定し、承認済みスナップショットから対外用・社内確認用の DOCX を出力する
  const snapshot = await confirmReport((await fresh()).db, approver(), IDS.projects.fy2026);
  const listed = await listProjectSnapshots((await fresh()).db, approver(), IDS.projects.fy2026);
  const again = listed.find((entry) => entry.snapshot.id === snapshot.id);
  expect(again?.integrityOk).toBe(true);
  const ssbjVersion = snapshot.frameworkVersions.find(
    (f) => f.frameworkVersionId !== IDS.esrs40aVersion,
  )!.frameworkVersionId;
  const external = await exportReportSnapshot((await fresh()).db, approver(), {
    snapshotId: snapshot.id,
    format: 'docx',
    audience: 'external',
    frameworkVersionId: ssbjVersion,
  });
  const externalText = await docxText(external.bytes);
  expect(externalText).toContain('23,480.5 m3 です（集計範囲は欧州販売子会社の全拠点）。');
  expect(externalText).not.toContain('E2E社内メモ');
  const internal = await exportReportSnapshot((await fresh()).db, approver(), {
    snapshotId: snapshot.id,
    format: 'docx',
    audience: 'internal',
    frameworkVersionId: ssbjVersion,
  });
  expect(await docxText(internal.bytes)).toContain('E2E社内メモ');
  {
    const { fixture } = await fresh();
    expect(fixture.exportArtifacts.filter((a) => a.snapshotId === snapshot.id)).toHaveLength(2);
  }
  measure('確定・DOCX');

  // 7. 元データを訂正する。原稿は再確認が必要になり、承認済みスナップショットと出力は変わらない
  const correction = csvSource('eu-water-fy2026-correction.csv', '23512.8');
  const correctionPreview = await validateQuantitativeImport(
    (await fresh()).db,
    author(),
    correction,
  );
  expect(correctionPreview.rows[0]?.warnings.join(' ')).toContain('承認済みの値です');
  await commitQuantitativeImport((await fresh()).db, author(), {
    batchId: correctionPreview.batchId,
    previewHash: correctionPreview.previewHash,
    idempotencyKey: randomUUID(),
    mode: 'all',
    correctionReason: 'E2E: 検針票の差し替えにより再訂正',
    source: correction,
  });
  {
    const { db, fixture } = await fresh();
    const risk = fixture.disclosureBlocks.find((b) => b.id === RISK)!;
    const freshness = await computeBlockFreshness(db, author(), risk);
    expect(freshness.items.some((i) => i.refKind === 'metric' && i.newRefId)).toBe(true);
  }
  const reExported = await exportReportSnapshot((await fresh()).db, approver(), {
    snapshotId: snapshot.id,
    format: 'docx',
    audience: 'external',
    frameworkVersionId: ssbjVersion,
  });
  expect(reExported.artifact.contentHash).toBe(external.artifact.contentHash);
  expect(await docxText(reExported.bytes)).toBe(externalText);
  measure('訂正 → 再確認');

  return {
    snapshotId: snapshot.id,
    externalHash: external.artifact.contentHash,
    externalText,
    ssbjVersionId: ssbjVersion,
    v1Id: v1.id,
    v3Id: v3.id,
    narrativeRecordId: narrative.record.id,
  };
}

export interface CsrdChainResult {
  planId: string;
  draftId: string;
}

/**
 * §9.7 の zzz-csrd-chain と同じ流れ（操作ごとに別インスタンス）。採用・保存・確定は、画面と同じく
 * 表示したときの版（AI の候補の実行日時・草案の updatedAt）を送る
 */
export async function playCsrdChain(
  fresh: Fresh,
  measure: (step: string) => void = () => {},
): Promise<CsrdChainResult> {
  const manager = author;
  // 設定: G1 をインパクト=重要でない・財務=重要と判断 → DMA を確定
  await decideCsrdDmaMatter((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '贈収賄への関与の算定結果 2.2 で閾値未満（E2E）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（E2E）',
    stakeholderNote: '',
  });
  await confirmCsrdDma((await fresh()).db, manager(), PERIOD_IDS.fy2026);
  measure('CSRD G1 の判断 → DMA 確定');

  // E1-6 の AI 分析（デモ生成）→ 候補を採用 → 対応計画を追加 → 対応中へ
  const { assessment } = await runCsrdGapAnalysis((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: CSRD_IDS.items['ESRS-E1-6']!,
  });
  await reviewCsrdAssessment((await fresh()).db, manager(), {
    assessmentId: assessment.id,
    decision: 'approved',
    comment: '',
    aiEvaluatedAt: assessment.aiEvaluatedAt,
  });
  measure('CSRD E1-6 の AI 分析 → 採用');
  const plan = await createCsrdActionPlan((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: CSRD_IDS.items['ESRS-E1-6']!,
    gapKind: 'data',
    title: 'Scope2 ロケーション基準の排出量を集める（架空）',
    detail: '',
    actionType: 'data_collection',
    department: '環境管理部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high',
  });
  await updateCsrdActionPlan((await fresh()).db, manager(), {
    planId: plan.id,
    status: 'in_progress',
    department: '環境管理部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high',
    baseUpdatedAt: plan.updatedAt,
  });
  // 収集画面で scope2_location の収集項目を作る
  await createCsrdCollectionItem((await fresh()).db, manager(), {
    planId: plan.id,
    metricCode: 'scope2_location',
    metricName: 'Scope2（ロケーション基準）',
    unit: 't-CO2e',
    unitId: UNIT_IDS.hq,
    ownerUserId: userId('sustainability@demo.local'),
    dueDate: '2026-12-01',
    requiresEvidence: false,
    department: '環境管理部',
  });
  measure('CSRD 計画 → 収集項目');

  // 開示ドラフト E1: 生成 → 本文に採用 → 保存 → 確定
  const generated = await generateCsrdDraft(
    (await fresh()).db,
    manager(),
    (await (await fresh()).db.findById('periods', PERIOD_IDS.fy2026))!,
    'E1',
  );
  const adopted = await adoptCsrdDraft((await fresh()).db, manager(), {
    draftId: generated.id,
    baseUpdatedAt: generated.updatedAt,
  });
  const saved = await saveCsrdDraftBody((await fresh()).db, manager(), {
    draftId: generated.id,
    body: `${generated.aiBody}（人が確認して加筆）`,
    baseUpdatedAt: adopted.updatedAt,
  });
  await confirmCsrdDraft((await fresh()).db, manager(), {
    draftId: generated.id,
    baseUpdatedAt: saved.updatedAt,
  });
  measure('CSRD 草案の生成・採用・保存・確定');
  return { planId: plan.id, draftId: generated.id };
}
