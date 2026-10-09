import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setAiProviderForTesting,
  type AiInvocation,
  type AiProvider,
  type AiResult,
} from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import type { AiFeature, RequirementMappingSuggestionOutput } from '@/lib/ai/schemas';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  adoptBlockMappingCandidates,
  blockNeedsMappingReason,
  listRequirementOptions,
  loadBlockMappingSuggestion,
  rejectBlockMappingCandidates,
  updateBlockRequirements,
} from '@/lib/services/block-requirements';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 原稿の節と要求事項の対応付けの編集（NF-05）と、AI の対応候補の採用（NF-11 の節。int:block-requirements）。
 *  - 別の版の要求事項は対応付けられない・他の組織は「見つかりません」
 *  - 承認済みの節は理由が必須で、承認済みの版・スナップショットは変わらない
 *  - AI の候補は採用の操作でだけ対応付けに入る（候補に無い ID は受け付けない）
 */

let fixture: FixtureDb;
let db: DemoDbClient;

/** 要求事項の候補を、入力の候補一覧の先頭（まだ対応付けていないもの）にする Provider（決定論的） */
class FirstCandidateProvider implements AiProvider {
  readonly kind = 'mock' as const;
  readonly model = 'mock-first-candidate';
  private readonly inner = new MockAIProvider();
  constructor(private readonly exclude: ReadonlySet<string>) {}
  async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
    const result = await this.inner.run(invocation);
    if (invocation.feature !== 'requirementMappingSuggestion') return result;
    const input = invocation.input as unknown as {
      candidates: Array<{ itemId: string; itemCode: string }>;
    };
    const pick = input.candidates.filter((c) => !this.exclude.has(c.itemId)).slice(0, 2);
    const output = result.output as unknown as RequirementMappingSuggestionOutput;
    output.candidates = pick.map((c) => ({
      itemId: c.itemId,
      itemCode: c.itemCode,
      relation: null,
      rationale: '（テスト）語句が重なっています。',
      confidence: 0.6,
    }));
    return result;
  }
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

afterEach(() => {
  setAiProviderForTesting(null);
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
      organizationName: 'テスト（架空）',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const viewer = () => ctxFor('enterprise-admin@demo.local', ['viewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const GOVERNANCE = IDS.blocks.fy2026Governance.block;

function blockOf(id: string) {
  return fixture.disclosureBlocks.find((b) => b.id === id)!;
}

function ssbjItem(code: string, versionId: string) {
  return fixture.disclosureItems.find(
    (i) => i.code === code && i.frameworkVersionId === versionId,
  )!;
}

describe('節と要求事項の対応付け（NF-05）', () => {
  it('節の基準の版の要求事項を足すと、要求事項タブ・対応表の行に節が出る', async () => {
    const block = blockOf(RISK);
    expect(block.status).not.toBe('approved');
    const extra = ssbjItem('気候-23', block.frameworkVersionId);
    const before = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
    expect(before.rows.find((r) => r.itemId === extra.id)!.blocks).toEqual([]);

    const result = await updateBlockRequirements(db, author(), {
      blockId: RISK,
      itemIds: [...block.requirementItemIds, extra.id],
    });
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['気候-23']);
    expect(blockOf(RISK).requirementItemIds).toContain(extra.id);
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'requirement_mapping_changed' && e.resourceId === RISK,
      ),
    ).toBe(true);

    const after = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
    expect(after.rows.find((r) => r.itemId === extra.id)!.blocks.map((b) => b.blockId)).toEqual([
      RISK,
    ]);
  });

  it('別の基準の版の要求事項は対応付けられない（何も変えない）', async () => {
    const before = [...blockOf(RISK).requirementItemIds];
    await expect(
      updateBlockRequirements(db, author(), {
        blockId: RISK,
        itemIds: [...before, esrs40aSampleItemId('40A-S02')],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(blockOf(RISK).requirementItemIds).toEqual(before);
  });

  it('変更が無ければ書かない', async () => {
    const audits = fixture.auditEvents.length;
    const result = await updateBlockRequirements(db, author(), {
      blockId: RISK,
      itemIds: [...blockOf(RISK).requirementItemIds],
    });
    expect(result.changed).toBe(false);
    expect(fixture.auditEvents).toHaveLength(audits);
  });

  it('承認済みの節は理由が必須。承認済みの版・スナップショットは変わらない', async () => {
    const block = blockOf(GOVERNANCE);
    expect(blockNeedsMappingReason(block)).toBe(true);
    const approvedVersionId = block.approvedVersionId;
    const snapshots = JSON.stringify(fixture.reportSnapshots);
    const extra = ssbjItem('気候-12', block.frameworkVersionId);
    await expect(
      updateBlockRequirements(db, author(), {
        blockId: GOVERNANCE,
        itemIds: [...block.requirementItemIds, extra.id],
        reason: '  ',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const result = await updateBlockRequirements(db, author(), {
      blockId: GOVERNANCE,
      itemIds: [...block.requirementItemIds, extra.id],
      reason: '（テスト）管理者の役割の説明が含まれているため対応付ける。',
    });
    expect(result.changed).toBe(true);
    const updated = blockOf(GOVERNANCE);
    expect(updated.status).toBe(block.status);
    expect(updated.approvedVersionId).toBe(approvedVersionId);
    expect(JSON.stringify(fixture.reportSnapshots)).toBe(snapshots);
    const audit = fixture.auditEvents.find(
      (e) => e.eventType === 'requirement_mapping_changed' && e.resourceId === GOVERNANCE,
    )!;
    expect(audit.metadata).toMatchObject({ added: ['気候-12'] });
  });

  it('他の組織の節は「見つかりません」、閲覧だけの役割は変えられない', async () => {
    await expect(
      updateBlockRequirements(db, otherTenant(), { blockId: RISK, itemIds: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateBlockRequirements(db, viewer(), { blockId: RISK, itemIds: [] }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('選べる要求事項はプロジェクトに付けた基準の版のものだけ', async () => {
    const options = await listRequirementOptions(db, author(), {
      projectId: IDS.projects.fy2026,
      frameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
    });
    expect(options).toHaveLength(8);
    expect(options.every((o) => o.title.startsWith('（サンプル）'))).toBe(true);
    await expect(
      listRequirementOptions(db, author(), {
        projectId: IDS.projects.fy2026,
        frameworkVersionId: IDS.esrs40aDraftVersion,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      listRequirementOptions(db, otherTenant(), {
        projectId: IDS.projects.fy2026,
        frameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      listRequirementOptions(db, viewer(), {
        projectId: IDS.projects.fy2026,
        frameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('AI の対応候補（NF-11 の節）', () => {
  async function suggest() {
    const block = blockOf(RISK);
    setAiProviderForTesting(new FirstCandidateProvider(new Set(block.requirementItemIds)));
    await suggestRequirementMappings(db, author(), {
      target: { kind: 'disclosure_block', id: RISK },
      frameworkVersionIds: [block.frameworkVersionId],
    });
    const suggestion = await loadBlockMappingSuggestion(db, author(), RISK);
    expect(suggestion).not.toBeNull();
    return suggestion!;
  }

  it('候補を出しただけでは対応付けは変わらず、選んで採用したものだけが入る', async () => {
    const before = [...blockOf(RISK).requirementItemIds];
    const suggestion = await suggest();
    expect(blockOf(RISK).requirementItemIds).toEqual(before);
    expect(suggestion.candidates.length).toBeGreaterThan(0);
    expect(suggestion.candidates.every((c) => !before.includes(c.id))).toBe(true);

    const chosen = suggestion.candidates[0]!;
    await adoptBlockMappingCandidates(db, author(), {
      blockId: RISK,
      runId: suggestion.run.id,
      itemIds: [chosen.id],
    });
    expect(blockOf(RISK).requirementItemIds).toEqual([...before, chosen.id]);
    expect(fixture.aiRuns.find((r) => r.id === suggestion.run.id)!.status).toBe('accepted');
    // 採否を記録した候補は、もう一度は採用できない（同じ候補を出し直す）
    await expect(
      adoptBlockMappingCandidates(db, author(), {
        blockId: RISK,
        runId: suggestion.run.id,
        itemIds: [chosen.id],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('候補に無い要求事項は採用できない', async () => {
    const suggestion = await suggest();
    const block = blockOf(RISK);
    const notOffered = fixture.disclosureItems.find(
      (i) =>
        i.frameworkVersionId === block.frameworkVersionId &&
        !block.requirementItemIds.includes(i.id) &&
        !suggestion.candidates.some((c) => c.id === i.id),
    )!;
    await expect(
      adoptBlockMappingCandidates(db, author(), {
        blockId: RISK,
        runId: suggestion.run.id,
        itemIds: [notOffered.id],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('採用しないと記録すると、候補は表示されなくなる（対応付けは変わらない）', async () => {
    const before = [...blockOf(RISK).requirementItemIds];
    const suggestion = await suggest();
    await rejectBlockMappingCandidates(db, author(), { blockId: RISK, runId: suggestion.run.id });
    expect(fixture.aiRuns.find((r) => r.id === suggestion.run.id)!.status).toBe('rejected');
    expect(await loadBlockMappingSuggestion(db, author(), RISK)).toBeNull();
    expect(blockOf(RISK).requirementItemIds).toEqual(before);
  });

  it('他の組織の候補は「見つかりません」', async () => {
    const suggestion = await suggest();
    await expect(
      adoptBlockMappingCandidates(db, otherTenant(), {
        blockId: RISK,
        runId: suggestion.run.id,
        itemIds: [suggestion.candidates[0]!.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
