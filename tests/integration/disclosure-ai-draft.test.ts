import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_TIMEOUT_MESSAGE, setAiProviderForTesting } from '@/lib/ai';
import { buildMockDisclosureDraft } from '@/lib/ai/mock-disclosure-draft';
import { PROMPT_VERSIONS, type AiFeature, type AiOutputOf } from '@/lib/ai/schemas';
import type { AiInvocation, AiProvider, AiResult } from '@/lib/ai/types';
import { paragraphText } from '@/lib/domain/disclosure-block';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEdits,
} from '@/lib/repositories/demo-edit-codec';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
  loadBlockDraftRuns,
  type GenerateBlockDraftResult,
} from '@/lib/services/disclosure-ai-draft';
import {
  autosaveWorkingBody,
  getBlockEditorData,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { ReviewBlockedError, requestReview } from '@/lib/services/disclosure-review';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 開示本文の AI 下書き支援（指示書 §9、docs/disclosure-first.md §2-3）。D0 は Mock での検証。
 *
 * 受入テスト: A15（過年度資料だけでは当年度を断定しない）、A16（相反する根拠）、
 * A17（存在しない資料 ID の拒否）、A18（生成中の編集を上書きしない）、A19（AI 切断・タイムアウトでも続行できる）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

afterEach(() => {
  setAiProviderForTesting(null);
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
const reviewerOnly = () => ctxFor('reviewer@demo.local', ['reviewer']);

const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const GOVERNANCE = IDS.blocks.fy2026Governance.block;
const A = IDS.anchors;

function blockRow(id: string) {
  const row = fixture.disclosureBlocks.find((b) => b.id === id);
  if (!row) throw new Error(`block ${id}`);
  return row;
}

function versionBody(id: string | null): BlockBody {
  const row = fixture.disclosureBlockVersions.find((v) => v.id === id);
  if (!row) throw new Error(`version ${id}`);
  return row.body;
}

function succeeded(result: GenerateBlockDraftResult) {
  if (result.status !== 'succeeded') throw new Error(`AI 実行が失敗: ${result.message}`);
  return result;
}

/** 固定の出力を返す Provider（実モデルの代わりに、返し方の異常を再現する） */
function stubProvider(
  build: (invocation: AiInvocation<AiFeature>) => unknown | Promise<unknown>,
): AiProvider {
  return {
    kind: 'mock',
    model: 'stub',
    async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
      const output = (await build(invocation as AiInvocation<AiFeature>)) as AiOutputOf<F>;
      return {
        output,
        provider: 'mock',
        model: 'stub',
        promptVersion: PROMPT_VERSIONS[invocation.feature],
        latencyMs: 1,
        tokenUsage: { input: 1, output: 1, total: 2 },
        estimatedCostUsd: 0,
      };
    },
  };
}

describe('選択した根拠から下書き（Mock）', () => {
  it('当年度の根拠の文言だけで段落を作り、出典を付け、デモ生成と表示する', async () => {
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
          { kind: 'source_anchor', id: A.riskPhysical },
          { kind: 'source_anchor', id: A.opportunity },
        ],
      }),
    );
    const run = result.run;
    expect(run.providerLabel).toBe('デモ生成（Mock）');
    expect(run.metadata.promptVersion).toBe(PROMPT_VERSIONS.disclosureBlockDraft);
    expect(run.metadata.runId).toBe(run.runId);
    expect(run.candidates.length).toBeGreaterThanOrEqual(2);
    // 定性情報の本文そのものは版を持った引用として入る
    const narrative = run.candidates.find((c) => c.children.some((i) => i.t === 'narrative'));
    expect(narrative).toBeDefined();
    expect(
      narrative?.children.some((i) => i.t === 'cite' && i.sourceAnchorId === A.riskPhysical),
    ).toBe(true);
    // 候補は根拠を丸ごと貼り付けた文ではなく、根拠の事実を言い直した短い段落（主題＋事実＋出典）。
    // 事実の部分は入力の文そのもので、入力に無い事実を作らない。資料のファイル名は本文に書かない
    const inputs = [
      fixture.narrativeVersions.find((v) => v.id === IDS.narrativeVersions.riskPhysical)!.body,
      fixture.sourceAnchors.find((a) => a.id === A.riskPhysical)!.quoteText,
      fixture.sourceAnchors.find((a) => a.id === A.opportunity)!.quoteText,
    ];
    for (const c of run.candidates) {
      expect(inputs).not.toContain(c.text);
      const match = /^リスク及び機会について、(.+。)（出典: .+）$/.exec(c.text);
      expect(match, c.text).not.toBeNull();
      const facts = match![1]!;
      expect(inputs.some((input) => input.includes(facts))).toBe(true);
      expect(c.text).not.toContain('.txt');
    }
    // 定性情報の文は、言い直しの中でも版を持った引用のまま（元情報が変わっても黙って書き換わらない）
    const quote = narrative!.children.find((i) => i.t === 'narrative');
    expect(quote && quote.t === 'narrative' ? inputs[0]!.includes(quote.quote) : false).toBe(true);
  });

  it('同じ入力なら同じ下書きを返す（決定論的）', () => {
    const input = {
      operation: 'draft_from_sources' as const,
      blockTitle: 'ガバナンス',
      periodLabel: 'FY2026',
      currentParagraphIds: [],
      sources: [
        {
          kind: 'source_anchor' as const,
          id: A.committeeGovernance2,
          label: '委員会資料 第2章',
          usage: 'current_fact' as const,
          periodLabel: 'FY2026',
          locator: '第2章 2.2 第1段落',
          text: 'サステナビリティ委員会は代表取締役社長を委員長とし、年4回開催する。委員会は審議の結果を年2回、取締役会に報告する。追加の文。',
        },
      ],
    };
    const first = buildMockDisclosureDraft(input);
    expect(buildMockDisclosureDraft(input)).toEqual(first);
    // 長い根拠は先頭の 2 文だけを使う（短い段落にする）
    expect(first.draftBlocks[0]?.text).toBe(
      'ガバナンスについて、サステナビリティ委員会は代表取締役社長を委員長とし、年4回開催する。委員会は審議の結果を年2回、取締役会に報告する。（出典: 引用位置 第2章 2.2 第1段落）',
    );
  });

  it('過年度の資料だけでは当年度の事実を書かず、不足情報を返す（A15）', async () => {
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.priorGovernance1 },
          { kind: 'source_anchor', id: A.priorGovernance2 },
          { kind: 'narrative_version', id: IDS.narrativeVersions.governanceFy2025 },
        ],
      }),
    );
    expect(result.run.candidates).toHaveLength(0);
    expect(result.run.missingInformation.length).toBeGreaterThanOrEqual(3);
    expect(result.run.missingInformation[0]?.reason).toContain('当年度の事実の根拠');
    expect(result.run.warnings.join(' ')).toContain('過年度');
  });

  it('根拠が食い違えば両方の出典を示し、どちらも本文にしない（A16）', async () => {
    // 同じ委員会の資料から、開催頻度が食い違う抜粋（架空）
    const conflicting = fid('source_anchor', 'test/conflict');
    const committee = fixture.sourceAnchors.find((a) => a.id === A.committeeGovernance2)!;
    fixture.sourceAnchors.push({
      ...committee,
      id: conflicting,
      fragmentId: null,
      anchorKind: 'manual_excerpt',
      locator: '別紙 議事要旨',
      quoteText: 'サステナビリティ委員会は代表取締役社長を委員長とし、年6回開催する。',
      acquiredBy: 'manual',
    });
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.committeeGovernance2 },
          { kind: 'source_anchor', id: conflicting },
          { kind: 'source_anchor', id: A.committeeGovernance1 },
        ],
      }),
    );
    const conflict = result.run.conflicts[0];
    expect(conflict?.subject).toContain('サステナビリティ委員会');
    expect(conflict?.sourceLabels).toHaveLength(2);
    expect(conflict?.detail).toContain('年4回');
    expect(conflict?.detail).toContain('年6回');
    const texts = result.run.candidates.map((c) => c.text);
    expect(texts.some((t) => t.includes('年4回') || t.includes('年6回'))).toBe(false);
    // 食い違いの無い根拠は候補になる（事実の文は根拠の文のまま、短い段落に言い直して入る）
    const agreed = fixture.sourceAnchors.find((a) => a.id === A.committeeGovernance1)!.quoteText;
    expect(texts.some((t) => t.includes(agreed))).toBe(true);
  });

  it('AI が入力に無い資料 ID を返したら、その段落を採用させず根拠なしとして扱う（A17）', async () => {
    const unknownId = fid('source_anchor', 'not-in-input');
    setAiProviderForTesting(
      stubProvider(() => ({
        operation: 'draft_from_sources',
        draftBlocks: [
          {
            paragraphId: null,
            kind: 'paragraph',
            text: '当社は全拠点で再生可能エネルギー100%を達成しました。',
            sourceRefs: [{ kind: 'source_anchor', id: unknownId, locator: 'p.99' }],
          },
          {
            paragraphId: null,
            kind: 'paragraph',
            text: fixture.sourceAnchors.find((a) => a.id === A.riskPhysical)!.quoteText,
            sourceRefs: [{ kind: 'source_anchor', id: A.riskPhysical, locator: null }],
          },
          {
            paragraphId: null,
            kind: 'paragraph',
            text: '根拠の無い主張。',
            sourceRefs: [],
          },
        ],
        missingInformation: [],
        conflicts: [],
        usedRequirementVersions: [],
        confidence: 0.9,
        warnings: [],
        sources: [],
      })),
    );
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [{ kind: 'source_anchor', id: A.riskPhysical }],
      }),
    );
    expect(result.run.candidates.map((c) => c.index)).toEqual([1]);
    expect(result.run.rejectedRefCount).toBe(1);
    expect(result.run.missingInformation.map((m) => m.item).join(' ')).toContain(
      '再生可能エネルギー',
    );
    expect(result.run.missingInformation.map((m) => m.reason).join(' ')).toContain(
      '根拠が示されていない',
    );

    // 拒否した段落は ID を指定しても採用できない
    const block = blockRow(RISK);
    await expect(
      adoptDraftParagraphs(db, author(), {
        blockId: RISK,
        runId: result.run.runId,
        candidateIndexes: [0],
        baseVersionId: block.currentVersionId,
      }),
    ).rejects.toThrow('候補が見つかりません');
  });

  it('二重押下しても同じ実行を返し、候補を 2 度作らない', async () => {
    const input = {
      blockId: RISK,
      operation: 'draft_from_sources' as const,
      sources: [{ kind: 'source_anchor' as const, id: A.riskTransition }],
    };
    const [first, second] = await Promise.all([
      generateBlockDraft(db, author(), input),
      generateBlockDraft(db, author(), input),
    ]);
    const third = succeeded(await generateBlockDraft(db, author(), input));
    expect(succeeded(first).run.runId).toBe(succeeded(second).run.runId);
    expect(third.run.runId).toBe(succeeded(first).run.runId);
    expect(third.reused).toBe(true);
    expect(fixture.aiRuns.filter((r) => r.featureType === 'disclosureBlockDraft')).toHaveLength(1);
  });

  it('AI 実行の権限が無い人（レビュー担当）は下書きを生成できない', async () => {
    // 権限キーは画面の文に出さず（plan §1.17）、エラーの属性で確かめる。文は権限の名前を含む
    const attempt = generateBlockDraft(db, reviewerOnly(), {
      blockId: RISK,
      operation: 'draft_from_sources',
      sources: [{ kind: 'source_anchor', id: A.riskPhysical }],
    });
    await expect(attempt).rejects.toMatchObject({
      name: 'AuthorizationError',
      permission: 'enterprise.ai.run',
    });
    await expect(attempt).rejects.toThrow('「AI の実行」の権限');
  });
});

describe('前年からの変更案・文章を整える', () => {
  it('前年の段落を当年度の根拠で書き直し、変わった頻度を知らせる', async () => {
    // 承認済みの節は、承認後の修正で下書きに戻してから使う
    const gov = blockRow(GOVERNANCE);
    await saveBlockVersion(db, author(), {
      blockId: GOVERNANCE,
      baseVersionId: gov.currentVersionId,
      body: {
        paragraphs: [
          ...versionBody(gov.currentVersionId).paragraphs,
          { id: 'gov-3', kind: 'paragraph', children: [{ t: 'text', text: '見直し中。' }] },
        ],
      },
      changeReason: '前年比較の見直し',
    });
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: GOVERNANCE,
        operation: 'update_from_prior_year',
        sources: [
          { kind: 'source_anchor', id: A.committeeGovernance1 },
          { kind: 'source_anchor', id: A.committeeGovernance2 },
        ],
      }),
    );
    const byParagraph = new Map(result.run.candidates.map((c) => [c.paragraphId, c]));
    expect(byParagraph.get('gov-2')?.text).toContain('年4回');
    expect(result.run.warnings.join(' ')).toMatch(/前年から変更: .*年2回 → 年4回/);
    // 置き換え候補の出典には、当年度の資料と前年の節の両方を示す
    expect(byParagraph.get('gov-2')?.sourceLabels.join(' ')).toContain('FY2025');
  });

  it('当年度の根拠が無ければ、前年の記載を当年度の事実として出さない（A15）', async () => {
    const gov = blockRow(GOVERNANCE);
    await saveBlockVersion(db, author(), {
      blockId: GOVERNANCE,
      baseVersionId: gov.currentVersionId,
      body: {
        paragraphs: [
          ...versionBody(gov.currentVersionId).paragraphs,
          { id: 'gov-3', kind: 'paragraph', children: [{ t: 'text', text: '見直し中。' }] },
        ],
      },
      changeReason: '前年比較の見直し',
    });
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: GOVERNANCE,
        operation: 'update_from_prior_year',
        sources: [],
      }),
    );
    expect(result.run.candidates).toHaveLength(0);
    expect(result.run.missingInformation.map((m) => m.item).join(' ')).toContain('前年の記載');
  });

  it('文章を整えるのは参照を含まない段落だけで、置き換え候補として返す', async () => {
    const block = blockRow(RISK);
    const body: BlockBody = {
      paragraphs: [
        ...versionBody(block.currentVersionId).paragraphs,
        {
          id: 'messy',
          kind: 'paragraph',
          children: [{ t: 'text', text: '当社は 、 対応策を 検討しています 。。' }],
        },
      ],
    };
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body,
    });
    const result = succeeded(
      await generateBlockDraft(db, author(), { blockId: RISK, operation: 'polish', sources: [] }),
    );
    expect(result.run.candidates).toHaveLength(1);
    expect(result.run.candidates[0]?.paragraphId).toBe('messy');
    expect(result.run.candidates[0]?.text).toBe('当社は、対応策を検討しています。');
    expect(result.notes.join(' ')).toContain('数値・定性情報の引用を含む');
  });
});

describe('候補の採用（A18）', () => {
  it('生成中に本文が変わっていたら自動では反映せず、確認後は利用者の編集を残して追加する', async () => {
    const block = blockRow(RISK);
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [{ kind: 'source_anchor', id: A.opportunity }],
      }),
    );
    // 生成の後（候補を採用する前）に利用者が本文を編集した
    const edited: BlockBody = {
      paragraphs: versionBody(block.currentVersionId).paragraphs.map((p) =>
        p.id === 'risk-2'
          ? { ...p, children: [{ t: 'text', text: '利用者が書き直した段落。' }] }
          : p,
      ),
    };
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: edited,
    });

    const conflict = await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: result.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    expect(conflict.status).toBe('conflict');
    expect(blockRow(RISK).workingBody).toEqual(edited);

    const applied = await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: result.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
      allowOnConflict: true,
    });
    expect(applied.status).toBe('applied');
    const working = blockRow(RISK).workingBody!;
    expect(paragraphText(working.paragraphs.find((p) => p.id === 'risk-2')!)).toBe(
      '利用者が書き直した段落。',
    );
    const adopted = working.paragraphs.find((p) => p.aiRunId === result.run.runId);
    expect(adopted).toBeDefined();
    // 同じ候補を 2 度押しても 2 段落にならない
    await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: result.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
      allowOnConflict: true,
    });
    expect(
      blockRow(RISK).workingBody!.paragraphs.filter((p) => p.aiRunId === result.run.runId),
    ).toHaveLength(1);
  });

  it('同じ実行の候補は続けて採用でき、採用による変化は競合に数えない', async () => {
    const block = blockRow(RISK);
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.opportunity },
          { kind: 'source_anchor', id: A.riskTransition },
        ],
      }),
    );
    expect(result.run.candidates).toHaveLength(2);
    for (const index of [0, 1]) {
      const adopted = await adoptDraftParagraphs(db, author(), {
        blockId: RISK,
        runId: result.run.runId,
        candidateIndexes: [index],
        baseVersionId: block.currentVersionId,
      });
      expect(adopted.status).toBe('applied');
    }
    const working = blockRow(RISK).workingBody!;
    expect(working.paragraphs.filter((p) => p.aiRunId === result.run.runId)).toHaveLength(2);
    expect(fixture.aiRuns.find((r) => r.id === result.run.runId)?.status).toBe('accepted');
  });

  it('本文が変わっていなければ置き換え候補で段落を置き換え、段落 ID を保つ', async () => {
    const block = blockRow(RISK);
    const body: BlockBody = {
      paragraphs: [
        ...versionBody(block.currentVersionId).paragraphs,
        { id: 'messy', kind: 'paragraph', children: [{ t: 'text', text: '検討中 です' }] },
      ],
    };
    await autosaveWorkingBody(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body,
    });
    const result = succeeded(
      await generateBlockDraft(db, author(), { blockId: RISK, operation: 'polish', sources: [] }),
    );
    const applied = await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: result.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    expect(applied.status).toBe('applied');
    const messy = blockRow(RISK).workingBody!.paragraphs.find((p) => p.id === 'messy');
    expect(paragraphText(messy!)).toBe('検討中です。');
    expect(messy?.aiRunId).toBe(result.run.runId);
    // すべて採用したので実行の確認は終わり（阻害条件にならない）
    expect(fixture.aiRuns.find((r) => r.id === result.run.runId)?.status).toBe('accepted');
  });

  it('作り直しても利用者の編集と採用済みの段落は残る', async () => {
    const block = blockRow(RISK);
    const first = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.opportunity },
          { kind: 'source_anchor', id: A.riskTransition },
        ],
      }),
    );
    await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: first.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    const afterAdopt = structuredClone(blockRow(RISK).workingBody!);
    const second = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.opportunity },
          { kind: 'source_anchor', id: A.riskTransition },
        ],
        workingBody: afterAdopt,
        regenerate: true,
      }),
    );
    expect(second.run.runId).not.toBe(first.run.runId);
    expect(blockRow(RISK).workingBody).toEqual(afterAdopt);
    // 前の候補の残りは置き換わったものとして閉じる。一部を採用した実行は「破棄」ではなく「採用」
    // （本文に残った段落の出所が「破棄した AI 出力」にならないように）
    const closed = fixture.aiRuns.find((r) => r.id === first.run.runId);
    expect(closed?.status).toBe('accepted');
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'ai_output_accepted' && e.resourceId === first.run.runId,
      ),
    ).toBe(true);
  });

  it('一部だけ採用した実行は、作り直しても確認を終えても「採用」として閉じる（採用は実行に記録する）', async () => {
    const block = blockRow(RISK);
    const first = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'source_anchor', id: A.opportunity },
          { kind: 'source_anchor', id: A.riskTransition },
        ],
      }),
    );
    await adoptDraftParagraphs(db, author(), {
      blockId: RISK,
      runId: first.run.runId,
      candidateIndexes: [0],
      baseVersionId: block.currentVersionId,
    });
    // 採用した事実は実行に残る（作業本文が別のサーバーに無くても判定できる）
    expect(fixture.aiRuns.find((r) => r.id === first.run.runId)?.acceptedAt).not.toBeNull();
    // 作業本文を持たない別インスタンス相当: 作業本文を消し、画面の本文も送らずに確認を終える
    const index = fixture.disclosureBlocks.findIndex((b) => b.id === RISK);
    fixture.disclosureBlocks[index] = { ...fixture.disclosureBlocks[index]!, workingBody: null };
    expect(
      await closeDraftRun(db, author(), { blockId: RISK, runId: first.run.runId, discard: true }),
    ).toBe('accepted');
  });

  it('未確認の候補が残っている間はレビュー依頼できず、確認を終えると依頼できる', async () => {
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [{ kind: 'source_anchor', id: A.opportunity }],
      }),
    );
    const error = await requestReview(db, author(), { blockId: RISK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect((error as ReviewBlockedError).blockers.map((b) => b.code)).toContain(
      'unadopted_ai_candidate',
    );
    expect(await closeDraftRun(db, author(), { blockId: RISK, runId: result.run.runId })).toBe(
      'rejected',
    );
    await expect(requestReview(db, author(), { blockId: RISK })).resolves.toBeDefined();
  });
});

describe('AI の失敗・タイムアウト（A19）', () => {
  it('AI が失敗しても理由を返し、手動の保存とレビュー依頼は続けられる', async () => {
    setAiProviderForTesting(
      stubProvider(() => {
        throw new Error('connection reset');
      }),
    );
    const result = await generateBlockDraft(db, author(), {
      blockId: RISK,
      operation: 'draft_from_sources',
      sources: [{ kind: 'source_anchor', id: A.opportunity }],
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message).toContain('手動での編集・保存・レビュー依頼はそのまま続けられます');
    const runs = await loadBlockDraftRuns(db, author(), RISK);
    expect(runs[0]?.state).toBe('failed');

    const block = blockRow(RISK);
    await saveBlockVersion(db, author(), {
      blockId: RISK,
      baseVersionId: block.currentVersionId,
      body: {
        paragraphs: [
          ...versionBody(block.currentVersionId).paragraphs,
          { id: 'manual', kind: 'paragraph', children: [{ t: 'text', text: '手で書いた段落。' }] },
        ],
      },
      changeReason: 'AI を使わずに追記',
    });
    const { request } = await requestReview(db, author(), { blockId: RISK });
    expect(request.status).toBe('open');
  });

  it('応答が返らなければタイムアウトとして記録し、失敗と区別する', async () => {
    setAiProviderForTesting(stubProvider(() => new Promise<never>(() => undefined)));
    const result = await generateBlockDraft(
      db,
      author(),
      {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [{ kind: 'source_anchor', id: A.opportunity }],
      },
      { timeoutMs: 20 },
    );
    expect(result.status).toBe('timeout');
    const run = fixture.aiRuns.find((r) => r.featureType === 'disclosureBlockDraft');
    expect(run?.status).toBe('failed');
    expect(run?.errorMessage).toBe(AI_TIMEOUT_MESSAGE);
    const views = await loadBlockDraftRuns(db, author(), RISK);
    expect(views[0]?.stateLabel).toBe('タイムアウト');
    // 画面のデータ（手動編集）はそのまま取れる
    const data = await getBlockEditorData(db, author(), IDS.projects.fy2026, RISK);
    expect(data.permissions.editable).toBe(true);
  });
});

describe('Demo Mode の Cookie 持ち回り（別インスタンスでの採用）', () => {
  /**
   * demo-persistence.ts の Cookie 1 つあたりの上限（MAX_BYTES_PER_COOKIE）。
   * これを超える 1 行は Cookie に載らず、実行したインスタンスのメモリにしか残らない。
   * server-only のモジュールなので値をここに写し、変わったらこのテストで気付けるようにする。
   */
  const MAX_CHARS_PER_COOKIE_CHUNK = 3800;

  it('典型的な実行（根拠 3 件）は 1 チャンクに収まり、候補と入力の記録だけで別インスタンスでも採用できる', async () => {
    const result = succeeded(
      await generateBlockDraft(db, author(), {
        blockId: RISK,
        operation: 'draft_from_sources',
        sources: [
          { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
          { kind: 'source_anchor', id: A.riskPhysical },
          { kind: 'source_anchor', id: A.opportunity },
        ],
      }),
    );
    const run = fixture.aiRuns.find((r) => r.id === result.run.runId)!;

    // 実測（2026-09-29）: 生 JSON 約 4.4KB → 符号化後 約 2.2KB（2 チャンク 7.6KB の約 3 割）
    const encoded = encodeDemoEdits([{ t: 'aiRuns', id: run.id, v: { ...run } }]);
    expect(encoded.length).toBeLessThan(MAX_CHARS_PER_COOKIE_CHUNK);

    // 別インスタンス（新しい Fixture）へ Cookie の内容だけを再適用して採用する。
    // 候補（outputJson）と許可リスト・土台の本文ハッシュ（inputReferenceIds）の両方が要る
    const other = createFixtureDb();
    applyDemoEdits(other, decodeDemoEdits(encoded));
    const otherDb = new DemoDbClient(other);
    const adopted = await adoptDraftParagraphs(otherDb, author(), {
      blockId: RISK,
      runId: run.id,
      candidateIndexes: [0],
      baseVersionId: other.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId,
    });
    expect(adopted.status).toBe('applied');
  });
});
