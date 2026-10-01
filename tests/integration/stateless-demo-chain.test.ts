import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { PERIOD_IDS } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  MAX_BYTES_PER_COOKIE,
  demoEditsWereEvicted,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import { loadCsrdDrafts } from '@/lib/services/csrd/draft';
import { loadCsrdOverview } from '@/lib/services/csrd/requirements';
import {
  autosaveWorkingBody,
  getBlockEditorData,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { exportReportSnapshot } from '@/lib/services/disclosure-export';
import {
  commitQuantitativeImport,
  listQuantitativeImportBatches,
  QuantitativeImportConflictError,
  validateQuantitativeImport,
} from '@/lib/services/quantitative-import';
import { listProjectSnapshots } from '@/lib/services/report-snapshot';
import type { AuthorizationContext, BlockBody } from '@/types/domain';
import {
  RISK,
  WATER_EU,
  admin,
  approver,
  author,
  csvSource,
  playCsrdChain,
  playMainDemoFlow,
  reviewer,
} from '../support/demo-flows';

/**
 * 「すべてのリクエストが別インスタンスに届く」最悪の場合の実演の流れ（§14.1・zz-disclosure-project.spec.ts）。
 *
 * 本番（Vercel の Demo Mode）はインスタンスのメモリを共有しない。手順ごとに Fixture を作り直し、
 * Cookie の操作だけを適用した DB（fresh）で次の手順を行う。Cookie とブラウザが持ち回した状態
 * （標準 CSV の元の入力・画面の本文）だけで最後まで進むこと、押し出しが起きないこと、Cookie の大きさを確かめる。
 * E2E（pnpm test:e2e:stateless）と同じ流れを Service の層で速く回す。
 * 実演の流れの後に、同じブラウザで CSRD の流れ（§9.7）を続けても押し出しが起きないことも確かめる
 * （顧客の新しい画面を同じ実演で見せる。CSRD の操作が前半の確定版・出力を押し出していた。自己監査 F1）。
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

beforeEach(() => {
  jar.clear();
  sizes.length = 0;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('実演の流れ（§14.1）は、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('CSV → 数値の承認 → 定性情報と引用 → AI 下書き → 版・依頼 → 差戻し → 再依頼 → 承認 → 確定 → DOCX → 訂正 → 再確認 → リセット', async () => {
    const result = await playMainDemoFlow(fresh, measure);

    expect(await demoEditsWereEvicted()).toBe(false);

    // 8. 後片付け: 開示デモのリセット。別のインスタンスでも初期状態（版 1・下書き）に戻る
    await resetDisclosureDemoData((await fresh()).db, author());
    {
      const { fixture } = await fresh();
      const risk = fixture.disclosureBlocks.find((b) => b.id === RISK)!;
      expect(risk.status).toBe('draft');
      expect(risk.currentVersionId).toBe(result.v1Id);
      expect(fixture.narrativeRecords.some((r) => r.id === result.narrativeRecordId)).toBe(false);
    }

    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-chain] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 3×3800B）`,
    );
    expect(peak).toBeLessThanOrEqual(3 * 3800);
  });

  it('実演の流れの後に同じブラウザで CSRD の流れを続けても押し出しが起きず、確定版・出力・CSRD の結果がすべて別インスタンスに残る', async () => {
    const main = await playMainDemoFlow(fresh, measure);
    await playCsrdChain(fresh, measure);

    // 押し出し（容量不足で古い操作を捨てること）が 0
    expect(await demoEditsWereEvicted()).toBe(false);
    const { db, fixture } = await fresh();
    // 前半の確定版（承認済みスナップショット）と DOCX の出力記録が別インスタンスに残る
    expect(fixture.reportSnapshots.filter((s) => s.id === main.snapshotId)).toHaveLength(1);
    expect(fixture.exportArtifacts.filter((a) => a.snapshotId === main.snapshotId)).toHaveLength(3);
    const listed = await listProjectSnapshots(db, approver(), IDS.projects.fy2026);
    expect(listed.find((entry) => entry.snapshot.id === main.snapshotId)?.integrityOk).toBe(true);
    const reExported = await exportReportSnapshot(db, approver(), {
      snapshotId: main.snapshotId,
      format: 'docx',
      audience: 'external',
      frameworkVersionId: main.ssbjVersionId,
    });
    expect(reExported.artifact.contentHash).toBe(main.externalHash);
    // 前半の CSV の数値の版も残る
    expect(
      fixture.dataPointVersions.filter((v) => v.dataPointId === WATER_EU && v.value === 23480.5),
    ).toHaveLength(1);
    // CSRD の結果（DMA 確定・E1-6 の採用・E1 の確定）も残る
    const fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
    const overview = await loadCsrdOverview(db, author(), fy2026, { referenceDate: '2026-08-14' });
    expect(overview!.dma.confirmed).toBe(true);
    expect(
      overview!.views.find((v) => v.item.id === CSRD_IDS.items['ESRS-E1-6'])!.assessment!
        .reviewDecision,
    ).toBe('approved');
    const drafts = await loadCsrdDrafts(db, author(), fy2026);
    expect(drafts!.sections.find((s) => s.section === 'E1')!.draft!.confirmedAt).not.toBeNull();

    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-chain+csrd] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${COOKIE_CHUNKS}×${MAX_BYTES_PER_COOKIE}B）`,
    );
    expect(peak).toBeLessThanOrEqual(COOKIE_CHUNKS * MAX_BYTES_PER_COOKIE);
  });

  it('CSRD の流れを先に行い、その後に実演の流れを続けても押し出しが起きない（逆の順）', async () => {
    await playCsrdChain(fresh, measure);
    await playMainDemoFlow(fresh, measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    const { db } = await fresh();
    const fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
    const overview = await loadCsrdOverview(db, author(), fy2026, { referenceDate: '2026-08-14' });
    // G1 の判断が押し出されると DMA の確定が外れる（以前の不具合）。押し出しが無ければ確定のまま
    expect(overview!.dma.confirmed).toBe(true);
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
