import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { parseDocx } from '@/lib/imports/docx-text';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import { demoEditsWereEvicted, readDemoEdits } from '@/lib/repositories/demo-persistence';
import { decideApprovalStep } from '@/lib/services/approval-route';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
} from '@/lib/services/disclosure-ai-draft';
import {
  autosaveWorkingBody,
  getBlockEditorData,
  metricDisplay,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { exportReportSnapshot } from '@/lib/services/disclosure-export';
import { computeBlockFreshness, decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  addReviewComment,
  completeReview,
  finalApprove,
  requestReview,
  returnReview,
} from '@/lib/services/disclosure-review';
import { transitionDataPoint } from '@/lib/services/data-point-workflow';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import { confirmNarrative, createNarrative } from '@/lib/services/narrative';
import {
  commitQuantitativeImport,
  listQuantitativeImportBatches,
  QuantitativeImportConflictError,
  validateQuantitativeImport,
  type ValidateQuantitativeImportInput,
} from '@/lib/services/quantitative-import';
import { confirmReport, listProjectSnapshots } from '@/lib/services/report-snapshot';
import { createAnchorFromFragment } from '@/lib/services/source-anchor';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 「すべてのリクエストが別インスタンスに届く」最悪の場合の実演の流れ（§14.1・zz-disclosure-project.spec.ts）。
 *
 * 本番（Vercel の Demo Mode）はインスタンスのメモリを共有しない。手順ごとに Fixture を作り直し、
 * Cookie の操作だけを適用した DB（fresh）で次の手順を行う。Cookie とブラウザが持ち回した状態
 * （標準 CSV の元の入力・画面の本文）だけで最後まで進むこと、押し出しが起きないこと、Cookie の大きさを確かめる。
 * E2E（pnpm test:e2e:stateless）と同じ流れを Service の層で速く回す。
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

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
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);

const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const ESRS = IDS.blocks.fy2026Esrs40aGovernance.block;
const METRICS = IDS.blocks.fy2026Metrics.block;
const WATER_EU = dataPointId('EU', 'water', 'FY2026');

function standardCsv(value: string): Uint8Array {
  const text = [
    'metric_code,period_start,period_end,entity_code,value,unit,source_reference',
    `water,2026-04-01,2027-03-31,EU,${value},m3,欧州販売子会社 検針票の再集計（架空）`,
  ].join('\n');
  // 表計算ソフトから保存した CSV と同じく BOM 付き UTF-8 にする
  return new TextEncoder().encode(`${String.fromCharCode(0xfeff)}${text}\n`);
}

function csvSource(name: string, value: string): ValidateQuantitativeImportInput {
  return {
    reportingPeriodId: PERIOD_IDS.fy2026,
    source: { kind: 'file', fileName: name, bytes: standardCsv(value) },
  };
}

/**
 * 起動直後の別インスタンス: Fixture を作り直し、Cookie の操作だけを適用する（getDb と同じ手順。
 * demo-fresh-fixture.ts の切替で本番の最悪の場合を再現するときと同じ）
 */
async function fresh(): Promise<{ db: DemoDbClient; fixture: FixtureDb }> {
  const fixture = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
}

function editsBytes(): number {
  return [...jar.entries()]
    .filter(([name]) => name.startsWith('t4d.demo-edits'))
    .reduce((sum, [, value]) => sum + value.length, 0);
}

const sizes: Array<{ step: string; bytes: number }> = [];
function measure(step: string): void {
  sizes.push({ step, bytes: editsBytes() });
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const parsed = await parseDocx(bytes);
  expect(parsed.status).toBe('parsed');
  return parsed.paragraphs.join('\n');
}

beforeEach(() => {
  jar.clear();
  sizes.length = 0;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('実演の流れ（§14.1）は、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('CSV → 数値の承認 → 定性情報と引用 → AI 下書き → 版・依頼 → 差戻し → 再依頼 → 承認 → 確定 → DOCX → 訂正 → 再確認 → リセット', async () => {
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
    if (adopted.status !== 'applied') return;
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

    expect(await demoEditsWereEvicted()).toBe(false);

    // 8. 後片付け: 開示デモのリセット。別のインスタンスでも初期状態（版 1・下書き）に戻る
    await resetDisclosureDemoData((await fresh()).db, author());
    {
      const { fixture } = await fresh();
      const risk = fixture.disclosureBlocks.find((b) => b.id === RISK)!;
      expect(risk.status).toBe('draft');
      expect(risk.currentVersionId).toBe(v1.id);
      expect(fixture.narrativeRecords.some((r) => r.id === narrative.record.id)).toBe(false);
    }

    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-chain] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 3×3800B）`,
    );
    expect(peak).toBeLessThanOrEqual(3 * 3800);
  });

  it('作業本文の無いインスタンスでも、最後に自動保存した本人かを示す（開示デモのリセット・版の保存の後は示さない）', async () => {
    const { fixture: f0 } = await fresh();
    const risk = f0.disclosureBlocks.find((b) => b.id === RISK)!;
    const v1 = f0.disclosureBlockVersions.find((v) => v.id === risk.currentVersionId)!;
    const typed: BlockBody = {
      paragraphs: [
        ...v1.body.paragraphs,
        { id: 'typed', kind: 'paragraph', children: [{ t: 'text', text: 'リハーサルの入力' }] },
      ],
    };
    await autosaveWorkingBody((await fresh()).db, author(), {
      blockId: RISK,
      baseVersionId: v1.id,
      body: typed,
    });
    const editorOf = async (ctx: AuthorizationContext) =>
      getBlockEditorData((await fresh()).db, ctx, IDS.projects.fy2026, RISK);
    const mine = await editorOf(author());
    // 作業本文そのものは Cookie で持ち回さない（このインスタンスには無い）が、書いた本人の記録は届く
    expect(mine.bodyFromWorking).toBe(false);
    expect(mine.block.workingSavedByViewer).toBe(true);
    expect((await editorOf(reviewer())).block.workingSavedByViewer).toBe(false);

    // 開示デモのリセットの後は、タブに残った控えを戻す根拠が無い
    await resetDisclosureDemoData((await fresh()).db, author());
    expect((await editorOf(author())).block.workingSavedByViewer).toBe(false);

    // 版として保存した後も同じ
    await autosaveWorkingBody((await fresh()).db, author(), {
      blockId: RISK,
      baseVersionId: v1.id,
      body: typed,
    });
    expect((await editorOf(author())).block.workingSavedByViewer).toBe(true);
    await saveBlockVersion((await fresh()).db, author(), {
      blockId: RISK,
      baseVersionId: v1.id,
      body: typed,
      changeReason: 'テスト',
    });
    expect((await editorOf(author())).block.workingSavedByViewer).toBe(false);
  });

  it('確定の成功後の再送が、検証したインスタンス（検証済みのバッチを持つ）に届いても最初の結果を返す', async () => {
    const input = csvSource('eu-water-fy2026.csv', '23480.5');
    // 検証はインスタンス A。A は起動したまま（検証済みのバッチを自分のメモリに持つ）
    const a = await fresh();
    const preview = await validateQuantitativeImport(a.db, author(), input);
    const commitInput = {
      batchId: preview.batchId,
      previewHash: preview.previewHash,
      idempotencyKey: randomUUID(),
      mode: 'all' as const,
      correctionReason: 'E2E: 検針票の再集計により訂正',
      source: input,
    };
    // 確定はインスタンス B（バッチが無いので検証し直して確定する）
    const first = await commitQuantitativeImport((await fresh()).db, author(), commitInput);
    expect(first.updated).toBe(1);

    // 応答が届かず同じ確定キーで押し直し、A に届く。A は getDb で Cookie の操作を適用してから処理する
    applyDemoEdits(a.fixture, await readDemoEdits());
    const retry = await commitQuantitativeImport(a.db, author(), commitInput);
    expect(retry.replayed).toBe(true);
    expect(retry.updated).toBe(first.updated);
    expect(retry.writtenRows).toEqual(first.writtenRows);
    // A の履歴も確定済みとして示し、同じ内容の再投入には重複の注意を出す（A03）
    const history = await listQuantitativeImportBatches(a.db, author());
    expect(history.find((h) => h.id === preview.batchId)?.status).toBe('committed');
    const again = await validateQuantitativeImport(
      a.db,
      author(),
      csvSource('eu-water-fy2026-copy.csv', '23480.5'),
    );
    expect(again.fileWarnings.join(' ')).toContain('確定済みです');
    // 二重に版を作らない
    expect(
      a.fixture.dataPointVersions.filter((v) => v.dataPointId === WATER_EU && v.value === 23480.5),
    ).toHaveLength(1);
  });

  it('確定の前に既存値が変わっていたら、検証し直した結果が確認した差分と違うとして競合で止める（A05）', async () => {
    const input = csvSource('eu-water-fy2026.csv', '23480.5');
    const preview = await validateQuantitativeImport((await fresh()).db, author(), input);
    // 別のタブで同じ値を先に確定する
    const other = await validateQuantitativeImport((await fresh()).db, author(), input);
    await commitQuantitativeImport((await fresh()).db, author(), {
      batchId: other.batchId,
      previewHash: other.previewHash,
      idempotencyKey: randomUUID(),
      mode: 'all',
      correctionReason: '先に確定（テスト）',
      source: input,
    });
    const error = await commitQuantitativeImport((await fresh()).db, author(), {
      batchId: preview.batchId,
      previewHash: preview.previewHash,
      idempotencyKey: randomUUID(),
      mode: 'all',
      correctionReason: '後から確定（テスト）',
      source: input,
      confirmedRows: preview.rows.map((r) => ({
        rowNo: r.rowNo,
        diffKind: r.diffKind,
        previousVersionNo: r.previous?.versionNo ?? null,
        previousStatus: r.previous?.status ?? null,
        previousDisplay: r.previous?.valueDisplay ?? '—',
      })),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuantitativeImportConflictError);
    expect((error as QuantitativeImportConflictError).conflicts[0]?.reason).toContain(
      '新しい版があります',
    );
    // 二重に版を作らない
    const { fixture } = await fresh();
    expect(
      fixture.dataPointVersions.filter((v) => v.dataPointId === WATER_EU && v.value === 23480.5),
    ).toHaveLength(1);
  });

  it('検証した人と別の人が同じ入力を送り直しても確定しない（検証した本人だけが確定できる）', async () => {
    const input = csvSource('eu-water-fy2026.csv', '23480.5');
    const preview = await validateQuantitativeImport((await fresh()).db, author(), input);
    await expect(
      commitQuantitativeImport((await fresh()).db, admin(), {
        batchId: preview.batchId,
        previewHash: preview.previewHash,
        idempotencyKey: randomUUID(),
        mode: 'all',
        correctionReason: '別の人（テスト）',
        source: input,
      }),
    ).rejects.toBeInstanceOf(QuantitativeImportConflictError);
  });

  it('送り直した入力が検証したものと違えば（改ざん・別のファイル）確定しない', async () => {
    const preview = await validateQuantitativeImport(
      (await fresh()).db,
      author(),
      csvSource('eu-water-fy2026.csv', '23480.5'),
    );
    await expect(
      commitQuantitativeImport((await fresh()).db, author(), {
        batchId: preview.batchId,
        previewHash: preview.previewHash,
        idempotencyKey: randomUUID(),
        mode: 'all',
        correctionReason: '改ざん（テスト）',
        source: csvSource('eu-water-fy2026.csv', '99999'),
      }),
    ).rejects.toBeInstanceOf(QuantitativeImportConflictError);
    const { fixture } = await fresh();
    expect(fixture.dataPointVersions.some((v) => v.value === 99999)).toBe(false);
  });
});
