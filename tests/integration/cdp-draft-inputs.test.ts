import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import type { AiFeature } from '@/lib/ai/schemas';
import type { AiInvocation, AiProvider } from '@/lib/ai/types';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { addResponseContentLink, generateDisclosureDraft } from '@/lib/services/disclosure-write';
import type { AuthorizationContext, ResponseContentLink } from '@/types/domain';

/**
 * CDP の AI 草案の入力（トライアル対応 NF-41。int:cdp-draft-inputs）。
 *
 * 承認済みデータ・前年回答に加え、回答に人が対応付けた T4D の情報を材料にする:
 *  - 定性情報は確認済みの版、原稿は承認済みの版、SSBJ の要求事項は題名
 *  - 根拠の引用位置は、資料の閲覧権限がある人の実行で、同じ組織の削除されていない資料だけ
 * 権限外・他組織・削除済み・未確認・未承認・外した対応付けは Prompt に入れない。
 * AI は候補だけ（草案は下書きの版。承認しない）。
 */

/** 資料の閲覧権限が無い利用者（この試験だけの印。役割の組合せでは作れないため can を差し替える） */
const NO_EVIDENCE_EMAIL = 'no-evidence-read@test.invalid';

vi.mock('@/lib/authorization/can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authorization/can')>();
  return {
    ...actual,
    can: (ctx: AuthorizationContext, permission: Parameters<typeof actual.can>[1]) =>
      permission === 'enterprise.evidence.read' && ctx.email === NO_EVIDENCE_EMAIL
        ? false
        : actual.can(ctx, permission),
  };
});

const calls: Array<AiInvocation<AiFeature>> = [];
const mock = new MockAIProvider();
const recording: AiProvider = {
  kind: 'mock',
  model: mock.model,
  run: (invocation) => {
    calls.push(invocation as AiInvocation<AiFeature>);
    return mock.run(invocation);
  },
};

let fixture: FixtureDb;
let db: DemoDbClient;

function manager(email = 'sustainability@demo.local'): AuthorizationContext {
  return {
    userId: userId('sustainability@demo.local'),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys: ['sustainability_manager'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const C01 = fid('disclosure_item', 'cdp/2026/C0.1');
const responseId = () =>
  fixture.disclosureResponses.find(
    (r) => r.itemId === C01 && r.reportingPeriodId === PERIOD_IDS.fy2026,
  )!.id;
const governance = () =>
  fixture.narrativeRecords.find((r) => r.id === DISCLOSURE_FIRST_IDS.narratives.governance)!;
const governanceVersion = () =>
  fixture.narrativeVersions.find((v) => v.id === governance().confirmedVersionId)!;
const approvedBlock = () =>
  fixture.disclosureBlocks.find(
    (b) => b.approvedVersionId && b.projectId === DISCLOSURE_FIRST_IDS.projects.fy2026,
  )!;
const ssbjItem = () => fixture.disclosureItems.find((i) => i.code === '一般-9')!;

/** 直接 Fixture に置く対応付け（画面の検査を通らない古い・不正な行を作る） */
function injectLink(
  targetKind: ResponseContentLink['targetKind'],
  targetId: string,
  extra: Partial<ResponseContentLink> = {},
): void {
  fixture.responseContentLinks.push({
    id: fid(
      'response_content_link',
      `test/${targetKind}/${targetId}/${fixture.responseContentLinks.length}`,
    ),
    organizationId: ORG_IDS.aomi,
    itemId: C01,
    targetKind,
    targetId,
    linkSource: 'manual',
    aiRunId: null,
    confirmedBy: userId('sustainability@demo.local'),
    confirmedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    deletedBy: null,
    ...extra,
  });
}

async function linkStandardContent(): Promise<void> {
  await addResponseContentLink(db, manager(), {
    itemId: C01,
    targetKind: 'narrative_record',
    targetId: governance().id,
  });
  await addResponseContentLink(db, manager(), {
    itemId: C01,
    targetKind: 'disclosure_block',
    targetId: approvedBlock().id,
  });
  await addResponseContentLink(db, manager(), {
    itemId: C01,
    targetKind: 'requirement_item',
    targetId: ssbjItem().id,
  });
}

function lastInput() {
  const invocation = calls.filter((c) => c.feature === 'cdpDraftGeneration').at(-1)!;
  return invocation.input as {
    narratives: Array<{ title: string; versionNo: number; body: string }>;
    approvedBlocks: Array<{ title: string; versionNo: number; text: string }>;
    requirements: Array<{ code: string; title: string }>;
    evidenceQuotes: Array<{ label: string; quote: string }>;
  };
}

beforeEach(() => {
  calls.length = 0;
  setAiProviderForTesting(recording);
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

afterAll(() => {
  setAiProviderForTesting(null);
});

describe('AI 草案の入力（NF-41）', () => {
  it('対応付けた確認済みの定性情報・承認済みの原稿・SSBJ の要求事項・根拠の引用位置を入力にする', async () => {
    await linkStandardContent();
    const result = await generateDisclosureDraft(db, manager(), responseId());

    const input = lastInput();
    expect(input.narratives).toEqual([
      expect.objectContaining({
        title: governance().title,
        versionNo: governanceVersion().versionNo,
        body: governanceVersion().body,
      }),
    ]);
    const blockVersion = fixture.disclosureBlockVersions.find(
      (v) => v.id === approvedBlock().approvedVersionId,
    )!;
    expect(input.approvedBlocks).toEqual([
      expect.objectContaining({ title: approvedBlock().title, versionNo: blockVersion.versionNo }),
    ]);
    expect(input.requirements).toEqual([{ code: '一般-9', title: ssbjItem().questionText }]);
    const anchors = [...governanceVersion().sourceAnchorIds, ...blockVersion.anchorRefs];
    expect(anchors.length).toBeGreaterThan(0);
    expect(input.evidenceQuotes.length).toBe(new Set(anchors).size);

    // 参照元（AI の実行記録）に版・引用位置が残る
    const run = fixture.aiRuns.find((r) => r.id === result.aiRunId)!;
    const kinds = new Set(run.sourceReferences.map((s) => s.kind));
    for (const kind of ['narrative_version', 'prior_block', 'requirement', 'source_anchor']) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    expect(run.sourceReferences.find((s) => s.kind === 'narrative_version')!.id).toBe(
      governanceVersion().id,
    );
    expect(run.inputReferenceIds[0]).toBe(responseId());

    // 草案は下書きの版で、承認しない（AI は確定しない）
    expect(result.version.status).toBe('draft');
    expect(result.version.originatedFromAiRunId).toBe(result.aiRunId);
  });

  it('未確認の定性情報・未承認の原稿・外した対応付け・他組織の情報は入力に入れない', async () => {
    injectLink('narrative_record', DISCLOSURE_FIRST_IDS.narratives.riskPhysical);
    const draftBlock = fixture.disclosureBlocks.find((b) => !b.approvedVersionId)!;
    injectLink('disclosure_block', draftBlock.id);
    injectLink('narrative_record', governance().id, {
      deletedAt: '2026-09-02T00:00:00.000Z',
      deletedBy: userId('sustainability@demo.local'),
    });
    // 他組織の定性情報（同じ ID を指す行が誤って入っても、組織が違えば使わない）
    const foreign = {
      ...governance(),
      id: fid('narrative_record', 'SOTEN/foreign'),
      organizationId: ORG_IDS.soten,
    };
    fixture.narrativeRecords.push(foreign);
    injectLink('narrative_record', foreign.id);

    await generateDisclosureDraft(db, manager(), responseId());
    const input = lastInput();
    expect(input.narratives).toEqual([]);
    expect(input.approvedBlocks).toEqual([]);
    expect(input.evidenceQuotes).toEqual([]);
  });

  it('他組織の資料・削除した資料の引用位置は入れない', async () => {
    await linkStandardContent();
    const version = governanceVersion();
    const [firstAnchorId] = version.sourceAnchorIds;
    const anchor = fixture.sourceAnchors.find((a) => a.id === firstAnchorId)!;
    // 他組織の引用位置を版に紛れ込ませる
    const foreignAnchor = {
      ...anchor,
      id: fid('source_anchor', 'SOTEN/foreign'),
      organizationId: ORG_IDS.soten,
    };
    fixture.sourceAnchors.push(foreignAnchor);
    version.sourceAnchorIds = [...version.sourceAnchorIds, foreignAnchor.id];
    // 先頭の引用位置の資料を削除済みにする
    const fileVersion = fixture.fileVersions.find((v) => v.id === anchor.fileVersionId)!;
    const file = fixture.files.find((f) => f.id === fileVersion.fileId)!;
    file.deletedAt = '2026-09-03T00:00:00.000Z';

    const result = await generateDisclosureDraft(db, manager(), responseId());
    const run = fixture.aiRuns.find((r) => r.id === result.aiRunId)!;
    const anchorIds = run.sourceReferences
      .filter((s) => s.kind === 'source_anchor')
      .map((s) => s.id);
    expect(anchorIds).not.toContain(foreignAnchor.id);
    const deletedFileAnchors = fixture.sourceAnchors
      .filter((a) => a.fileVersionId === anchor.fileVersionId)
      .map((a) => a.id);
    for (const id of deletedFileAnchors) expect(anchorIds).not.toContain(id);
    for (const quote of lastInput().evidenceQuotes) {
      expect(quote.label).not.toContain(file.originalName);
    }
  });

  it('資料の閲覧権限が無い人の実行では、資料の引用を入力に入れない（定性情報・原稿は入れる）', async () => {
    await linkStandardContent();
    const result = await generateDisclosureDraft(db, manager(NO_EVIDENCE_EMAIL), responseId());
    const input = lastInput();
    expect(input.evidenceQuotes).toEqual([]);
    expect(input.narratives).toHaveLength(1);
    const run = fixture.aiRuns.find((r) => r.id === result.aiRunId)!;
    expect(run.sourceReferences.some((s) => s.kind === 'source_anchor')).toBe(false);
  });

  it('対応付けが無ければ従来どおり（承認済みデータ・前年回答だけ）。不足情報を返す', async () => {
    const result = await generateDisclosureDraft(db, manager(), responseId());
    const input = lastInput();
    expect(input.narratives).toEqual([]);
    expect(input.approvedBlocks).toEqual([]);
    expect(input.requirements).toEqual([]);
    expect(Array.isArray(result.missingInformation)).toBe(true);
  });
});
