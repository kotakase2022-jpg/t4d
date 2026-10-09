import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import {
  setAiProviderForTesting,
  type AiInvocation,
  type AiProvider,
  type AiResult,
} from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import type { AiFeature } from '@/lib/ai/schemas';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 要求事項の対応付けの候補（トライアル対応 NF-11。int:requirement-mapping-ai）。
 * 採用しない限り業務の値が変わらない・権限外（他社のプロジェクトだけが使う版）の要求事項を Prompt に入れない。
 */

let fixture: FixtureDb;
let db: DemoDbClient;
const invocations: AiInvocation<AiFeature>[] = [];

/** Mock の出力をそのまま返しつつ、渡された入力を記録する */
class RecordingProvider implements AiProvider {
  readonly kind = 'mock' as const;
  readonly model = 'mock-recording';
  private readonly inner = new MockAIProvider();
  async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
    invocations.push(invocation as unknown as AiInvocation<AiFeature>);
    return this.inner.run(invocation);
  }
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  invocations.length = 0;
  setAiProviderForTesting(new RecordingProvider());
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

function snapshotOfBusinessTables() {
  return JSON.stringify({
    blocks: fixture.disclosureBlocks.map((b) => [b.id, b.requirementItemIds]),
    links: fixture.narrativeRequirementLinks,
    crosswalks: fixture.requirementCrosswalks,
    assessments: fixture.projectRequirementAssessments,
  });
}

describe('suggestRequirementMappings', () => {
  it('候補は ai_runs にだけ残し、節・定性情報・横断の対応表は変えない', async () => {
    const before = snapshotOfBusinessTables();
    const runsBefore = fixture.aiRuns.length;
    const result = await suggestRequirementMappings(db, author(), {
      target: { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
    });
    expect(result.run.featureType).toBe('requirementMappingSuggestion');
    expect(result.run.status).toBe('succeeded');
    expect(fixture.aiRuns.length).toBe(runsBefore + 1);
    expect(snapshotOfBusinessTables()).toBe(before);
    expect(result.warnings.join(' ')).toContain('デモ生成');
  });

  it('Prompt の候補は自社のプロジェクトに付けた基準の版の要求事項だけ', async () => {
    await suggestRequirementMappings(db, author(), {
      target: { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
    });
    const input = invocations.at(-1)!.input as { candidates: Array<{ itemId: string }> };
    const attached = new Set(
      fixture.projectFrameworks
        .filter(
          (f) =>
            f.organizationId === ORG_IDS.aomi &&
            fixture.disclosureProjects.some((p) => p.id === f.projectId && !p.deletedAt),
        )
        .map((f) => f.frameworkVersionId),
    );
    expect(input.candidates.length).toBeGreaterThan(0);
    for (const c of input.candidates) {
      const item = fixture.disclosureItems.find((i) => i.id === c.itemId)!;
      expect(attached.has(item.frameworkVersionId)).toBe(true);
    }
    // 資料の本文・Secret は入れない（対象の本文と要求事項のコード・題名だけ）
    expect(Object.keys(invocations.at(-1)!.input).sort()).toEqual([
      'candidates',
      'targetKind',
      'targetText',
    ]);
  });

  it('入力に無い要求事項を AI が返したら捨てる', async () => {
    class Inventing implements AiProvider {
      readonly kind = 'mock' as const;
      readonly model = 'inventing';
      async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
        const base = await new MockAIProvider().run(invocation);
        const output = base.output as unknown as { candidates: unknown[] };
        output.candidates.push({
          itemId: '00000000-0000-4000-8000-0000000000ff',
          itemCode: 'X-1',
          relation: null,
          rationale: '作られた候補',
          confidence: 0.9,
        });
        return base;
      }
    }
    setAiProviderForTesting(new Inventing());
    const result = await suggestRequirementMappings(db, author(), {
      target: { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
    });
    expect(result.candidates.some((c) => c.itemCode === 'X-1')).toBe(false);
    expect(result.discarded).toBe(1);
  });

  it('権限の無い役割・他社の対象は拒否する', async () => {
    await expect(
      suggestRequirementMappings(db, viewer(), {
        target: { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      suggestRequirementMappings(db, otherTenant(), {
        target: { kind: 'narrative_version', id: IDS.narrativeVersions.riskPhysical },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(invocations).toHaveLength(0);
  });
});
