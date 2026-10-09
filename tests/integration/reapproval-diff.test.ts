import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { saveBlockVersion } from '@/lib/services/disclosure-block';
import { requestReview } from '@/lib/services/disclosure-review';
import {
  loadReviewDiff,
  parseReviewDiffMode,
} from '@/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/review-diff';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, BlockBody, RoleKey } from '@/types/domain';

/**
 * 再承認の差分を前回承認した版と比べる（トライアル対応 NF-17。int:reapproval-diff）。
 * 承認後に 2 回直してから再承認を依頼したとき、既定は「前回承認した版」からの差分（2 回分の変更）、
 * 「直前の版と比べる」で最後の 1 回分だけになる。書き込まない。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
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
const GOVERNANCE = IDS.blocks.fy2026Governance.block;

function blockRow() {
  return fixture.disclosureBlocks.find((b) => b.id === GOVERNANCE)!;
}

function versionRow(id: string | null) {
  return fixture.disclosureBlockVersions.find((v) => v.id === id)!;
}

function withParagraph(body: BlockBody, id: string, text: string): BlockBody {
  return {
    paragraphs: [...body.paragraphs, { id, kind: 'paragraph', children: [{ t: 'text', text }] }],
  };
}

async function reapprovalTarget() {
  const approvedVersionId = blockRow().approvedVersionId!;
  const first = await saveBlockVersion(db, author(), {
    blockId: GOVERNANCE,
    baseVersionId: blockRow().currentVersionId,
    body: withParagraph(versionRow(approvedVersionId).body, 'gov-a', '承認後の追記その 1。'),
    changeReason: '委員会の追加開催を反映（テスト）',
  });
  const second = await saveBlockVersion(db, author(), {
    blockId: GOVERNANCE,
    baseVersionId: first.version.id,
    body: withParagraph(first.version.body, 'gov-b', '承認後の追記その 2。'),
    changeReason: '表現の修正（テスト）',
  });
  await requestReview(db, author(), { blockId: GOVERNANCE });
  return { approvedVersionId, first: first.version, second: second.version };
}

const changedIds = (diff: Awaited<ReturnType<typeof loadReviewDiff>>['diff']) =>
  diff.filter((d) => d.kind !== 'unchanged').map((d) => d.paragraphId);

describe('再承認の差分の比較元', () => {
  it('既定は前回承認した版。承認後の変更をまとめて示す', async () => {
    const { approvedVersionId, first, second } = await reapprovalTarget();
    expect(blockRow().approvedVersionId).toBe(approvedVersionId);
    const guarded = new WriteDetectingDbClient(db);
    const result = await loadReviewDiff(guarded, author(), {
      target: second,
      approvedVersionId,
      requested: null,
    });
    expect(guarded.writes).toEqual([]);
    expect(result.mode).toBe('approved');
    expect(result.baseVersionNo).toBe(versionRow(approvedVersionId).versionNo);
    expect(result.baseLabel).toContain('前回承認した版');
    expect(result.canSwitch).toBe(true);
    expect(changedIds(result.diff)).toEqual(['gov-a', 'gov-b']);
    expect(first.versionNo).toBeLessThan(second.versionNo);
  });

  it('「直前の版と比べる」に切り替えると、最後の変更だけになる', async () => {
    const { approvedVersionId, first, second } = await reapprovalTarget();
    const result = await loadReviewDiff(db, author(), {
      target: second,
      approvedVersionId,
      requested: parseReviewDiffMode('previous'),
    });
    expect(result.mode).toBe('previous');
    expect(result.baseVersionNo).toBe(first.versionNo);
    expect(result.baseLabel).toContain('直前の版');
    expect(changedIds(result.diff)).toEqual(['gov-b']);
  });

  it('承認済みの版が無い節は直前の版と比べ、切り替えは出さない', async () => {
    const target = versionRow(blockRow().currentVersionId);
    const result = await loadReviewDiff(db, author(), {
      target,
      approvedVersionId: null,
      requested: parseReviewDiffMode('approved'),
    });
    expect(result.mode).toBe('previous');
    expect(result.canSwitch).toBe(false);
  });

  it('別の組織の版は比較元にしない', async () => {
    const { approvedVersionId, second } = await reapprovalTarget();
    const other = ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
    const result = await loadReviewDiff(db, other, {
      target: second,
      approvedVersionId,
      requested: null,
    });
    expect(result.mode).toBe('previous');
    expect(result.baseVersionNo).toBeNull();
  });

  it('URL の値は approved / previous だけを受け付ける', () => {
    expect(parseReviewDiffMode('previous')).toBe('previous');
    expect(parseReviewDiffMode('approved')).toBe('approved');
    expect(parseReviewDiffMode('other')).toBeNull();
    expect(parseReviewDiffMode(undefined)).toBeNull();
  });
});
