import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  filterCrosswalkRows,
  isOneSided,
  loadCrosswalk,
  loadCrosswalkSuggestion,
  type CrosswalkSide,
} from '@/lib/services/crosswalk';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * SSBJ ↔ ESRS-40a の横断対応表（NF-09。int:crosswalk）。
 *  - 書き込まない（AI の候補も横断のマスターに書かない）
 *  - サンプル（架空）の対応はサンプルと示す。40a のサンプルは充足確認済みにならない（K6）
 *  - 片側だけ充足の判定・共通本文（同じ定性情報の版を両側の節が引用）
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

function side(category: CrosswalkSide['category']): CrosswalkSide {
  return {
    itemId: 'x',
    code: 'X',
    title: 'X',
    frameworkVersionId: 'v',
    frameworkLabel: 'V',
    inProject: category !== null,
    category,
    blocks: [],
  };
}

describe('横断対応表', () => {
  it('FY2026 の SSBJ ↔ 40a サンプルの対応 6 件を、書き込まずに出す', async () => {
    const guarded = new WriteDetectingDbClient(db);
    const view = await loadCrosswalk(guarded, viewer(), { projectId: IDS.projects.fy2026 });
    expect(guarded.writes).toEqual([]);
    expect(view.ssbjFramework).not.toBeNull();
    expect(view.rows).toHaveLength(6);
    expect(view.rows.every((r) => r.sample)).toBe(true);
    expect(view.relationCounts).toEqual({
      equivalent: 1,
      partial: 2,
      related: 2,
      no_counterpart: 1,
    });
    const none = view.rows.find((r) => r.relation === 'no_counterpart')!;
    expect(none.counterpart.code).toBeNull();
    expect(none.counterpart.frameworkVersionId).toBe(ESRS_40A_SAMPLE_VERSION_ID);
  });

  it('40a のサンプルは充足確認済みにならず、片側だけ充足は一方だけが充足確認済みの行', async () => {
    const view = await loadCrosswalk(db, author(), { projectId: IDS.projects.fy2026 });
    for (const row of view.rows) {
      expect(row.counterpart.category).not.toBe('confirmed');
      if (row.oneSided) {
        expect(row.ssbj.category).toBe('confirmed');
      }
    }
    expect(view.oneSidedCount).toBe(view.rows.filter((r) => r.oneSided).length);
  });

  it('片側だけ充足の判定（対象外・プロジェクト外・対応先なしは比べない）', () => {
    expect(isOneSided(side('confirmed'), side('needs_check'))).toBe(true);
    expect(isOneSided(side('not_addressed'), side('confirmed'))).toBe(true);
    expect(isOneSided(side('confirmed'), side('confirmed'))).toBe(false);
    expect(isOneSided(side('needs_check'), side('undetermined'))).toBe(false);
    expect(isOneSided(side('confirmed'), side('excluded'))).toBe(false);
    expect(isOneSided(side('confirmed'), side(null))).toBe(false);
  });

  it('同じ定性情報の版を両側の節が引用していれば、共通本文として示す', async () => {
    const view = await loadCrosswalk(db, author(), { projectId: IDS.projects.fy2026 });
    const governance = view.rows.find(
      (r) => r.ssbj.code === '気候-10' && r.counterpart.itemId === esrs40aSampleItemId('40A-S01'),
    )!;
    expect(governance.relation).toBe('partial');
    expect(governance.sharedNarratives.length).toBeGreaterThan(0);
    expect(governance.counterpart.blocks.map((b) => b.blockId)).toContain(
      IDS.blocks.fy2026Esrs40aGovernance.block,
    );
  });

  it('関係・片側だけ充足で絞り込める', async () => {
    const view = await loadCrosswalk(db, author(), { projectId: IDS.projects.fy2026 });
    expect(filterCrosswalkRows(view.rows, { relation: 'partial' })).toHaveLength(2);
    expect(filterCrosswalkRows(view.rows, { side: 'one_sided' })).toHaveLength(view.oneSidedCount);
    expect(filterCrosswalkRows(view.rows, {})).toHaveLength(6);
  });

  it('他の組織のプロジェクトは「見つかりません」', async () => {
    await expect(
      loadCrosswalk(db, otherTenant(), { projectId: IDS.projects.fy2026 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('AI の対応候補は表示するだけで、横断のマスターは変わらない', async () => {
    setAiProviderForTesting(new MockAIProvider());
    const master = JSON.stringify(fixture.requirementCrosswalks);
    const source = fixture.disclosureItems.find(
      (i) =>
        i.code === '気候-47(1)' &&
        fixture.projectFrameworks.some(
          (f) =>
            f.id === IDS.projectFrameworks.fy2026Ssbj &&
            f.frameworkVersionId === i.frameworkVersionId,
        ),
    )!;
    const result = await suggestRequirementMappings(db, author(), {
      target: { kind: 'requirement_item', id: source.id },
      frameworkVersionIds: [ESRS_40A_SAMPLE_VERSION_ID],
    });
    const suggestion = await loadCrosswalkSuggestion(db, viewer(), {
      projectId: IDS.projects.fy2026,
      runId: result.run.id,
    });
    expect(suggestion!.source.code).toBe('気候-47(1)');
    expect(suggestion!.candidates.every((c) => c.title.startsWith('（サンプル）'))).toBe(true);
    expect(suggestion!.decided).toBe(false);
    expect(JSON.stringify(fixture.requirementCrosswalks)).toBe(master);

    await expect(
      loadCrosswalkSuggestion(db, otherTenant(), {
        projectId: IDS.projects.fy2026,
        runId: result.run.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('閲覧の権限が無い役割は開けない', async () => {
    await expect(
      loadCrosswalk(db, ctxFor('site-user@demo.local', ['site_contributor']), {
        projectId: IDS.projects.fy2026,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
