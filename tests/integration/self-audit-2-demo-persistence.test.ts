import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, getDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import { applyPendingDemoResetFor, getDb } from '@/lib/repositories';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEdits,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  EVICTED_COOKIE,
  MAX_BYTES_PER_COOKIE,
  appendDemoEdit,
  clearDemoEviction,
  demoEditsWereEvicted,
  markDemoReset,
  markDemoResetApplied,
  packIntoChunks,
  pendingDemoReset,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import {
  demoResetEpochTime,
  isNewerDemoReset,
  newDemoResetEpoch,
} from '@/lib/repositories/demo-reset-sync';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
} from '@/lib/services/disclosure-ai-draft';
import { saveBlockVersion } from '@/lib/services/disclosure-block';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { addReviewComment, requestReview, returnReview } from '@/lib/services/disclosure-review';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import { saveNarrative } from '@/lib/services/narrative';
import {
  commitQuantitativeImport,
  validateQuantitativeImport,
} from '@/lib/services/quantitative-import';
import type { AuthorizationContext, BlockBody, ReviewEvent, RoleKey } from '@/types/domain';

/**
 * 自己監査 第 2 回（2026-09-29）: Demo Mode の Cookie による持ち回りの回帰テスト。
 * next/headers の cookies() をテスト用の入れ物に差し替え、実際の Cookie の容量・押し出し・
 * リセットの印を確かめる（Cookie はブラウザ 1 つぶん）。
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

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  jar.clear();
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  // 反映済みのリセットはインスタンス（globalThis）ごと。テストごとに起動し直した状態にする
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
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
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);

const RISK = IDS.blocks.fy2026RiskOpportunity;

/** 圧縮が効かない（乱数の）文字列で、Cookie 上の大きさを制御した編集 */
function sizedEdit(id: string, bytes: number, n: number): DemoEdit {
  return { t: 'comments', id, v: { id, body: randomBytes(bytes).toString('base64') }, n };
}

/** 以前の詰め方（先頭から入るだけを前のチャンクへ）。比較のため */
function prefixPackOverflows(edits: readonly DemoEdit[], chunks: number = COOKIE_CHUNKS): boolean {
  let rest = [...edits];
  for (let i = 0; i < chunks && rest.length > 0; i += 1) {
    let take = rest.length;
    while (take > 0 && encodeDemoEdits(rest.slice(0, take)).length > MAX_BYTES_PER_COOKIE) {
      take -= 1;
    }
    if (take === 0) break;
    rest = rest.slice(take);
  }
  return rest.length > 0;
}

// ----------------------------------------------------------------------
// F3（永続化）: チャンクの詰め方
// ----------------------------------------------------------------------

describe('F3 Cookie のチャンクは空きを残したまま押し出さない', () => {
  // 2026-09-30: 編集を Cookie ごとに分けて圧縮する形式から、1 本に圧縮して切り分ける形式へ変えた
  // （demo-persistence.ts の packIntoChunks）。チャンクの境界で空きが残ることはもう起きない
  it('大きな編集と小さな編集が混ざっても、全チャンクの容量まで詰めてから押し出す', () => {
    // チャンクの数によらず、先頭から詰めると 1 つ前のチャンクに空きを残す並び
    // （中くらい・大きいの組を「チャンク数 - 1」回、最後に小さい 2 件）
    const edits: DemoEdit[] = [];
    for (let i = 0; i < COOKIE_CHUNKS - 1; i += 1) {
      edits.push(sizedEdit(`a${i}`, 1300, edits.length + 1));
      edits.push(sizedEdit(`big${i}`, 1900, edits.length + 1));
    }
    edits.push(sizedEdit('b', 600, edits.length + 1), sizedEdit('c', 500, edits.length + 1));
    // 以前の詰め方では入りきらない組み合わせであることを確かめる（空振りのテストにしない）
    expect(prefixPackOverflows(edits)).toBe(true);
    const packed = packIntoChunks(edits);
    expect(packed.overflow).toEqual([]);
    expect(packed.chunks.every((c) => c.length <= MAX_BYTES_PER_COOKIE)).toBe(true);
    // 1 本の圧縮列を切り分けたもの。つなげてから戻す
    const restored = decodeDemoEdits(packed.chunks.join(''));
    expect(restored.map((e) => e.id).sort()).toEqual(edits.map((e) => e.id).sort());
  });

  it('読み出しは追記の順（押し出しは古いものから）', async () => {
    for (const [i, id] of ['a', 'big', 'b', 'c'].entries()) {
      await appendDemoEdit('comments', id, {
        id,
        body: randomBytes(i === 1 ? 1900 : 700).toString('base64'),
      });
    }
    expect((await readDemoEdits()).map((e) => e.id)).toEqual(['a', 'big', 'b', 'c']);
  });

  it('実演の流れ（取込 → 定性 → AI 下書き → 依頼 → コメント → 差戻し → 修正 → 再依頼）で取込の数値を押し出さない', async () => {
    await setDisclosureFirst(db, admin(), true);

    // 3 手目: 標準 CSV で数値を登録（E2E の水使用量の行と、配布している標準 CSV のひな形）
    const header =
      'metric_code,period_start,period_end,entity_code,boundary_code,value,unit,value_kind,availability_status,absence_reason,methodology_code,breakdown_key,source_reference';
    const water = [
      header,
      'water,2026-04-01,2027-03-31,EU,連結,4321,m3,actual,value_present,,,,欧州販売子会社 検針票の再集計（架空）',
    ].join('\r\n');
    const template = readFileSync(
      join(process.cwd(), 'public', 'templates', 'standard-metrics.csv'),
      'utf8',
    );
    for (const [fileName, text] of [
      ['eu-water.csv', water],
      ['standard-metrics.csv', template],
    ] as const) {
      const preview = await validateQuantitativeImport(db, author(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        source: { kind: 'file', fileName, bytes: new TextEncoder().encode(text) },
      });
      await commitQuantitativeImport(db, author(), {
        batchId: preview.batchId,
        previewHash: preview.previewHash,
        idempotencyKey: randomUUID(),
        mode: 'all',
        correctionReason: '検針票の再集計により訂正（テスト）',
      });
    }
    const importedIds = (await readDemoEdits())
      .filter((e) => e.t === 'dataPoints' || e.t === 'dataPointVersions')
      .map((e) => `${e.t}:${e.id}`);
    expect(importedIds.length).toBeGreaterThan(0);

    // 4 手目: 定性情報を保存
    // 原稿（リスク・機会）が引用していない定性情報を更新する（引用の再確認は別の手順のため）
    const record = fixture.narrativeRecords.find((r) => r.id === IDS.narratives.strategy)!;
    const narrativeVersion = fixture.narrativeVersions.find(
      (v) => v.id === record.currentVersionId,
    )!;
    await saveNarrative(db, author(), {
      narrativeId: record.id,
      baseVersionId: record.currentVersionId,
      reportingPeriodId: narrativeVersion.reportingPeriodId,
      scopeNote: narrativeVersion.scopeNote,
      fields: narrativeVersion.fields,
      body: `${narrativeVersion.body} 省電力製品の比率を高めます（架空）。`,
      sourceAnchorIds: narrativeVersion.sourceAnchorIds,
      changeReason: '方針を追記（テスト）',
      acknowledgeImpact: true,
    });

    // 5 手目: 根拠 3 件で AI 下書きを作り、1 段落を採用して版にする
    const draft = await generateBlockDraft(db, author(), {
      blockId: RISK.block,
      operation: 'draft_from_sources',
      sources: [
        { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
        { kind: 'source_anchor', id: IDS.anchors.riskPhysical },
        { kind: 'source_anchor', id: IDS.anchors.opportunity },
      ],
    });
    if (draft.status !== 'succeeded') throw new Error('AI 下書きに失敗しました');
    const block = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    await adoptDraftParagraphs(db, author(), {
      blockId: RISK.block,
      runId: draft.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    // 残りの候補は閉じる（採用した段落の実行記録は残る）
    await closeDraftRun(db, author(), { blockId: RISK.block, runId: draft.run.runId });

    // 6 手目: 依頼 → コメント → 差戻し → 修正 → 再依頼
    const first = await requestReview(db, author(), { blockId: RISK.block });
    await addReviewComment(db, reviewer(), {
      blockId: RISK.block,
      paragraphId: first.version.body.paragraphs[0]!.id,
      body: '集計範囲を本文に明記してください。',
      severity: 'info',
    });
    await returnReview(db, reviewer(), {
      requestId: first.request.id,
      reason: '集計範囲を本文に明記してください。',
      paragraphId: first.version.body.paragraphs[0]!.id,
    });
    const returned = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    const body: BlockBody = {
      paragraphs: [
        ...first.version.body.paragraphs,
        { id: 'fix-1', kind: 'paragraph', children: [{ t: 'text', text: '集計範囲は連結。' }] },
      ],
    };
    await saveBlockVersion(db, author(), {
      blockId: RISK.block,
      baseVersionId: returned.currentVersionId,
      body,
      changeReason: '差戻しを受けて集計範囲を明記',
    });
    await requestReview(db, author(), { blockId: RISK.block });

    // この時点の編集は 1 つのチャンクには入りきらない（チャンクをまたいで詰めることを確かめる。空振りでない確認）。
    // 確認を終えた AI 実行の縮小（自己監査 第 3 回 F3）の後は、以前の 2 チャンクにも収まる大きさになった
    expect(prefixPackOverflows(await readDemoEdits(), 1)).toBe(true);
    // 取込の数値は押し出されず、押し出しの知らせも出ない
    const remaining = new Set((await readDemoEdits()).map((e) => `${e.t}:${e.id}`));
    expect(importedIds.filter((id) => !remaining.has(id))).toEqual([]);
    expect(await demoEditsWereEvicted()).toBe(false);
  });
});

// ----------------------------------------------------------------------
// F4（永続化）/ F2（回帰）: 押し出しの知らせ
// ----------------------------------------------------------------------

describe('F4 押し出しの知らせは、押し出した表をリセット・ログアウトしたら消える', () => {
  async function overflowWith(table: 'reviewComments' | 'comments' | 'ingestionRows') {
    for (let i = 0; i < 12; i += 1) {
      const id = `${table}-${i}`;
      // 取込の行は取込ジョブを持つ（同じ取込の行どうしの押し出しだけを黙る）
      const jobId = table === 'ingestionRows' ? { jobId: 'job-1' } : {};
      await appendDemoEdit(table, id, {
        id,
        ...jobId,
        body: randomBytes(1400).toString('base64'),
      });
    }
  }

  it('開示の表の押し出しは、開示デモのリセットで知らせが消える', async () => {
    await overflowWith('reviewComments');
    expect(await demoEditsWereEvicted()).toBe(true);
    await resetDisclosureDemoData(db, author());
    expect(await demoEditsWereEvicted()).toBe(false);
  });

  it('開示以外の表の押し出しは、開示デモのリセットでは消えない（まだ正しい注意のため）', async () => {
    await overflowWith('comments');
    await resetDisclosureDemoData(db, author());
    expect(await demoEditsWereEvicted()).toBe(true);
    // ログアウトでは消す（次に使う人へ持ち越さない）
    await clearDemoEviction();
    expect(await demoEditsWereEvicted()).toBe(false);
    expect(jar.has(EVICTED_COOKIE)).toBe(false);
  });

  it('取込の行どうしの押し出しでは知らせない（取込の画面が案内する）', async () => {
    await overflowWith('ingestionRows');
    expect(await demoEditsWereEvicted()).toBe(false);
  });

  it('以前の形式の知らせ（値 1）も読める', async () => {
    jar.set(EVICTED_COOKIE, '1');
    expect(await demoEditsWereEvicted()).toBe(true);
  });
});

// ----------------------------------------------------------------------
// F1（永続化）/ F4（セキュリティ）: リセットの印の新旧
// ----------------------------------------------------------------------

describe('F1 リセットの印は時刻の順に並び、古い印で戻し合わない', () => {
  it('世代は時刻を持ち、新しいものだけを未反映とする', () => {
    const older = newDemoResetEpoch(1_700_000_000_000, 'aaa');
    const newer = newDemoResetEpoch(1_700_000_100_000, 'bbb');
    expect(demoResetEpochTime(older)).toBe(1_700_000_000_000);
    const baseline = newDemoResetEpoch(1_600_000_000_000, '0');
    const mark = (epoch: string) => ({ organizationId: ORG_IDS.aomi, epoch });
    expect(isNewerDemoReset(mark(older), undefined, baseline)).toBe(true);
    expect(isNewerDemoReset(mark(older), newer, baseline)).toBe(false);
    expect(isNewerDemoReset(mark(newer), older, baseline)).toBe(true);
    // インスタンスの起動より前のリセットは、起動時のメモリに含まれている
    expect(isNewerDemoReset(mark(older), undefined, newer)).toBe(false);
    // 以前の形式（時刻なし）の印は比べられないため反映しない
    expect(isNewerDemoReset(mark(randomUUID()), undefined, baseline)).toBe(false);
  });

  it('2 つのブラウザの印が交互に来ても、反映は新しい印の 1 回だけ', async () => {
    // このインスタンスは印より前に起動していた
    (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets = {
      baseline: newDemoResetEpoch(Date.now() - 60_000, '0'),
      byOrganization: new Map(),
    };
    await markDemoReset(ORG_IDS.aomi);
    const browserV = jar.get('t4d.demo-reset')!;
    // 別のインスタンスでの反映をやり直すため、反映済みの記録だけを起動時点へ戻す
    (
      globalThis as { __t4dAppliedDemoResets?: { byOrganization: Map<string, string> } }
    ).__t4dAppliedDemoResets!.byOrganization.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await markDemoReset(ORG_IDS.aomi);
    const browserP = jar.get('t4d.demo-reset')!;
    (
      globalThis as { __t4dAppliedDemoResets?: { byOrganization: Map<string, string> } }
    ).__t4dAppliedDemoResets!.byOrganization.clear();

    const applied: string[] = [];
    for (const cookie of [browserV, browserP, browserV, browserP, browserV]) {
      jar.set('t4d.demo-reset', cookie);
      const pending = await pendingDemoReset();
      if (pending) {
        applied.push(pending.epoch);
        markDemoResetApplied(pending);
      }
    }
    // 古い印（V）は最初に 1 回だけ反映し、新しい印（P）を反映した後は古い印では戻さない
    expect(applied).toHaveLength(2);
    expect(applied[1]).toBe(browserP.split(':')[1]);
  });
});

// ----------------------------------------------------------------------
// F3（セキュリティ）/ F2（永続化）: リセットの印はログインした利用者で確かめてから反映する
// ----------------------------------------------------------------------

describe('F3 署名の無いリセットの印は、印の組織で開示を編集できる利用者のときだけ反映する', () => {
  it('ログイン前（getDb）では反映せず、別組織・閲覧だけの利用者でも反映しない', async () => {
    const shared = getDemoDb();
    const demoRecordId = fid('narrative_record', `demo-created/${randomUUID()}`);
    const template = shared.narrativeRecords.find((r) => r.organizationId === ORG_IDS.aomi)!;
    shared.narrativeRecords.push({ ...template, id: demoRecordId, currentVersionId: null });
    // このインスタンスは印より前に起動していた
    (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets = {
      baseline: newDemoResetEpoch(Date.now() - 60_000, '0'),
      byOrganization: new Map(),
    };
    jar.set(
      't4d.demo-reset',
      `${ORG_IDS.aomi}:${newDemoResetEpoch(Date.now(), randomUUID().replace(/-/g, ''))}`,
    );
    const exists = () => shared.narrativeRecords.some((r) => r.id === demoRecordId);

    // 未ログインの経路（getDb）は印を見ない
    await getDb();
    expect(exists()).toBe(true);
    // 別の組織の利用者・閲覧だけの利用者では反映しない
    const otherOrg: AuthorizationContext = {
      ...admin(),
      userId: userId('other-enterprise-admin@demo.local'),
      workspace: { ...admin().workspace, organizationId: ORG_IDS.soten },
    };
    expect(await applyPendingDemoResetFor(otherOrg)).toBe(false);
    expect(await applyPendingDemoResetFor(ctxFor('reviewer@demo.local', ['viewer']))).toBe(false);
    expect(exists()).toBe(true);
    // 印の組織で開示を編集できる利用者なら反映し、同じ印は二度反映しない
    expect(await applyPendingDemoResetFor(author())).toBe(true);
    expect(exists()).toBe(false);
    expect(await pendingDemoReset()).toBeNull();
  });
});

// ----------------------------------------------------------------------
// F6（永続化）: リセットで孤立した編集も取り除く
// ----------------------------------------------------------------------

describe('F6 リセットは、このインスタンスが受け付けなかった開示の編集も Cookie から取り除く', () => {
  it('依頼が押し出されて適用できない記録・節の状態は、リセット後に Cookie に残らない', async () => {
    const orphanEvent = fid('review_event', 'orphan');
    const orphanRequest = fid('review_request', 'orphan-evicted');
    const edits: Array<[DemoEdit['t'], string, Record<string, unknown>]> = [
      [
        'reviewEvents',
        orphanEvent,
        {
          id: orphanEvent,
          organizationId: ORG_IDS.aomi,
          reviewRequestId: orphanRequest,
          eventType: 'requested',
          stage: 'request',
          actorUserId: userId('sustainability@demo.local'),
          targetVersionId: RISK.version,
          reason: null,
          paragraphId: null,
          idempotencyKey: null,
          createdAt: new Date().toISOString(),
        } satisfies ReviewEvent,
      ],
      // 別インスタンスで作られた節の部分更新（組織を持たない。この節はメモリにも Fixture にも無い）
      ['disclosureBlocks', fid('disclosure_block', 'elsewhere'), { status: 'review_requested' }],
      // 他の画面の操作は残す
      ['comments', 'keep-me', { id: 'keep-me', body: 'x' }],
    ];
    for (const [table, id, v] of edits) {
      await appendDemoEdit(table as never, id, v);
    }
    applyDemoEdits(fixture, await readDemoEdits());
    expect(fixture.reviewEvents.some((e) => e.id === orphanEvent)).toBe(false);

    await resetDisclosureDemoData(db, author());
    const left = (await readDemoEdits()).map((e) => `${e.t}:${e.id}`);
    expect(left).not.toContain(`reviewEvents:${orphanEvent}`);
    expect(left).not.toContain(`disclosureBlocks:${fid('disclosure_block', 'elsewhere')}`);
    expect(left).toContain('comments:keep-me');
  });
});

// ----------------------------------------------------------------------
// F4（回帰）: レビューの通知
// ----------------------------------------------------------------------

describe('F4 レビューの通知は、別のサーバーでも届く（本文を省いて持ち回す）', () => {
  it('依頼の通知を Cookie に残し、別インスタンスの一覧・未読件数に出す', async () => {
    const { notified } = await requestReview(db, author(), { blockId: RISK.block });
    expect(notified).toBe(true);
    const edits = await readDemoEdits();
    const notification = edits.find((e) => e.t === 'notifications');
    expect(notification?.v).toMatchObject({
      userId: userId('reviewer@demo.local'),
      category: 'review',
      body: '',
    });

    const other = createFixtureDb();
    applyDemoEdits(other, edits);
    const received = other.notifications.filter(
      (n) => n.userId === userId('reviewer@demo.local') && n.readAt === null,
    );
    expect(received.some((n) => n.title.includes('レビュー依頼'))).toBe(true);
  });
});

// ----------------------------------------------------------------------
// INV-7 / INV-3 / F5（永続化）/ F2（セキュリティ）: Cookie から戻す内容の検査
// ----------------------------------------------------------------------

describe('INV-7 追記専用の数値の版・適用判断は、Cookie から既存の行を書き換えられない', () => {
  it('承認済みの版の値・確定した適用判断の理由は変わらず、新しい行は従来どおり追加できる', () => {
    const version = fixture.dataPointVersions.find((v) => v.status === 'approved')!;
    const decision = fixture.projectFrameworkDecisions[0]!;
    const before = structuredClone({ version, decision });
    const newVersionId = fid('data_point_version', 'cookie-new');
    const forgedApprovedId = fid('data_point_version', 'cookie-new-approved');
    applyDemoEdits(fixture, [
      { t: 'dataPointVersions', id: version.id, v: { value: 1 } },
      { t: 'projectFrameworkDecisions', id: decision.id, v: { reason: '改ざん' } },
      // 画面の操作と同じく、新しい版は下書きで作られる
      {
        t: 'dataPointVersions',
        id: newVersionId,
        v: { ...version, id: newVersionId, status: 'draft' },
      },
      // 承認済みを名乗る新しい版は、承認の道筋を経ていないため受け付けない（SEC-2）
      {
        t: 'dataPointVersions',
        id: forgedApprovedId,
        v: { ...version, id: forgedApprovedId },
      },
    ]);
    expect(fixture.dataPointVersions.find((v) => v.id === version.id)).toEqual(before.version);
    expect(fixture.projectFrameworkDecisions.find((d) => d.id === decision.id)).toEqual(
      before.decision,
    );
    expect(fixture.dataPointVersions.some((v) => v.id === newVersionId)).toBe(true);
    expect(fixture.dataPointVersions.some((v) => v.id === forgedApprovedId)).toBe(false);
  });
});

describe('INV-3 Demo Mode でも、指名外の判断・終わった依頼への承認を Cookie から戻さない', () => {
  const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);

  function edit<T extends { id: string }>(t: string, row: T): DemoEdit {
    return { t, id: row.id, v: { ...row } };
  }

  it('差し戻して終わった依頼に承認の記録を足しても、依頼も節も承認済みにならない', async () => {
    const { request, version } = await requestReview(db, author(), { blockId: RISK.block });
    const { completeReview } = await import('@/lib/services/disclosure-review');
    await completeReview(db, reviewer(), { requestId: request.id });
    await returnReview(db, approver(), {
      requestId: request.id,
      reason: '根拠の版を確認してください',
      paragraphId: version.body.paragraphs[0]!.id,
    });
    const events = fixture.reviewEvents.filter((e) => e.reviewRequestId === request.id);
    const returned = fixture.reviewRequests.find((r) => r.id === request.id)!;
    expect(returned.status).toBe('returned');
    const forgedApproval: ReviewEvent = {
      ...events.find((e) => e.eventType === 'review_completed')!,
      id: fid('review_event', 'forged-approval'),
      eventType: 'approved',
      stage: 'final',
      actorUserId: userId('approver@demo.local'),
      idempotencyKey: 'forged',
    };
    const approveBlock: DemoEdit = {
      t: 'disclosureBlocks',
      id: RISK.block,
      v: { status: 'approved', approvedVersionId: version.id, submittedVersionId: version.id },
    };
    // 1) 依頼が差し戻されたインスタンス: 承認の記録・依頼の状態・節の承認のどれも受け付けない
    applyDemoEdits(fixture, [
      edit('reviewEvents', forgedApproval),
      { t: 'reviewRequests', id: returned.id, v: { ...returned, status: 'approved' } },
      approveBlock,
    ]);
    expect(fixture.reviewEvents.some((e) => e.id === forgedApproval.id)).toBe(false);
    expect(fixture.reviewRequests.find((r) => r.id === request.id)?.status).toBe('returned');
    expect(fixture.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe('returned');

    // 2) 別インスタンス: Cookie の依頼は「差戻し」。偽の承認の記録と節の承認は受け付けない
    //    （版は Cookie に載らないため、版の行だけは写しておく）
    const other = createFixtureDb();
    other.disclosureBlockVersions.push(structuredClone(version));
    applyDemoEdits(other, [
      ...events.map((e) => edit('reviewEvents', e)),
      edit('reviewEvents', forgedApproval),
      edit('reviewRequests', returned),
      approveBlock,
    ]);
    expect(other.reviewEvents.some((e) => e.id === forgedApproval.id)).toBe(false);
    expect(other.reviewRequests.find((r) => r.id === request.id)?.status).toBe('returned');
    expect(other.disclosureBlocks.find((b) => b.id === RISK.block)?.status).not.toBe('approved');
  });

  it('指名されたレビュー担当以外のレビュー完了は戻さない', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK.block });
    const requested = fixture.reviewEvents.filter((e) => e.reviewRequestId === request.id);
    const notDesignated: ReviewEvent = {
      ...requested[0]!,
      id: fid('review_event', 'not-designated'),
      eventType: 'review_completed',
      stage: 'review',
      actorUserId: userId('enterprise-admin@demo.local'),
      idempotencyKey: 'not-designated',
    };
    const other = createFixtureDb();
    applyDemoEdits(other, [
      { t: 'reviewRequests', id: request.id, v: { ...request, status: 'reviewed' } },
      ...requested.map((e) => edit('reviewEvents', e)),
      edit('reviewEvents', notDesignated),
    ]);
    expect(other.reviewEvents.some((e) => e.id === notDesignated.id)).toBe(false);
    expect(other.reviewRequests.find((r) => r.id === request.id)?.status).not.toBe('reviewed');
  });
});

describe('F5 依頼の編集が押し出されても、節を「レビュー依頼中」のまま動けなくしない', () => {
  it('対応する依頼が無い「レビュー依頼中」は下書きへ戻し、ほかの変更は残す', () => {
    const other = createFixtureDb();
    applyDemoEdits(other, [
      {
        t: 'disclosureBlocks',
        id: RISK.block,
        v: { status: 'review_requested', submittedVersionId: RISK.version, title: '題名の変更' },
      },
    ]);
    const block = other.disclosureBlocks.find((b) => b.id === RISK.block)!;
    expect(block.status).toBe('draft');
    expect(block.submittedVersionId).toBeNull();
    expect(block.title).toBe('題名の変更');
  });

  it('依頼が一緒に戻れば「レビュー依頼中」のまま戻す', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK.block });
    const block = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    const events = fixture.reviewEvents.filter((e) => e.reviewRequestId === request.id);
    const other = createFixtureDb();
    applyDemoEdits(other, [
      {
        t: 'disclosureBlocks',
        id: RISK.block,
        v: { status: block.status, submittedVersionId: block.submittedVersionId },
      },
      { t: 'reviewRequests', id: request.id, v: { ...request } },
      ...events.map((e) => ({ t: 'reviewEvents', id: e.id, v: { ...e } })),
    ]);
    expect(other.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe(
      'review_requested',
    );
  });
});

describe('F2 Demo Mode でも、範囲の改訂番号を下げたり先の番号を名乗ったりできない', () => {
  it('プロジェクトの番号の引き下げと、先の番号を名乗る依頼は戻さない', async () => {
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!;
    const other = createFixtureDb();
    other.disclosureProjects.find((p) => p.id === project.id)!.scopeRevision = 2;
    const forgedRequestId = fid('review_request', 'forged-revision');
    applyDemoEdits(other, [
      { t: 'disclosureProjects', id: project.id, v: { scopeRevision: 0 } },
      {
        t: 'reviewRequests',
        id: forgedRequestId,
        v: {
          ...fixture.reviewRequests[0]!,
          id: forgedRequestId,
          projectId: project.id,
          targetId: RISK.block,
          targetVersionId: RISK.version,
          status: 'open',
          projectScopeRevision: 99,
        },
      },
    ]);
    expect(other.disclosureProjects.find((p) => p.id === project.id)?.scopeRevision).toBe(2);
    expect(other.reviewRequests.some((r) => r.id === forgedRequestId)).toBe(false);
  });
});
