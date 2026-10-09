import { describe, expect, it } from 'vitest';
import {
  classifyRequirement,
  countByCategory,
  DRAFT_STANDARD_CAP_NOTE,
  exclusionReasonExcerpt,
  exclusionStateOf,
  resolveOwnerDue,
  slowestHumanCoverage,
  type ExclusionEventLike,
  type RequirementCoverageInput,
} from '@/lib/domain/requirement-coverage';
import { exclusionReasonDigest } from '@/lib/domain/exclusion-digest';

/**
 * 要求事項の 5 区分（トライアル対応 NF-03。unit:requirement-coverage）。
 * 区分は保存せず、同じ関数で毎回導く。理由の無い除外・承認待ちは対象外にしない（分母から外さない）。
 */

const approvedBlock = {
  status: 'approved',
  hasVersion: true,
  recheck: false,
  translation: false,
} as const;

function input(overrides: Partial<RequirementCoverageInput> = {}): RequirementCoverageInput {
  return {
    frameworkPublished: true,
    frameworkExcluded: false,
    decision: { kind: 'applicable', reason: null, exclusionApproved: false },
    blocks: [approvedBlock],
    narrativeMissingFields: false,
    evidence: 'current',
    metrics: 'ok',
    human: { disclosure: 'covered', data: 'covered', process: 'mostly_covered' },
    aiOnly: false,
    ...overrides,
  };
}

describe('classifyRequirement', () => {
  it('すべて揃えば充足確認済み', () => {
    expect(classifyRequirement(input()).category).toBe('confirmed');
  });

  it('公開草案・サンプルの基準は人の確認が済んでも「追加確認が必要」が上限（K6）', () => {
    const result = classifyRequirement(input({ frameworkPublished: false }));
    expect(result.category).toBe('needs_check');
    expect(result.reasons).toEqual([DRAFT_STANDARD_CAP_NOTE]);
  });

  it('理由の無い除外・承認待ちは未判定。理由と承認があれば対象外', () => {
    expect(
      classifyRequirement(
        input({ decision: { kind: 'not_applicable', reason: '', exclusionApproved: true } }),
      ).category,
    ).toBe('undetermined');
    expect(
      classifyRequirement(
        input({ decision: { kind: 'not_material', reason: '理由', exclusionApproved: false } }),
      ).category,
    ).toBe('undetermined');
    expect(
      classifyRequirement(
        input({ decision: { kind: 'not_applicable', reason: '理由', exclusionApproved: true } }),
      ).category,
    ).toBe('excluded');
    expect(classifyRequirement(input({ frameworkExcluded: true })).category).toBe('excluded');
    expect(
      classifyRequirement(
        input({ decision: { kind: 'not_assessed', reason: null, exclusionApproved: false } }),
      ).category,
    ).toBe('undetermined');
  });

  it('節が無い・版が無い・評価「未対応」は未対応（不足の種類を返す）', () => {
    const none = classifyRequirement(input({ blocks: [] }));
    expect(none.category).toBe('not_addressed');
    expect(none.gaps).toContain('manuscript');
    expect(
      classifyRequirement(input({ blocks: [{ ...approvedBlock, hasVersion: false }] })).category,
    ).toBe('not_addressed');
    const human = classifyRequirement(
      input({ human: { disclosure: 'covered', data: 'not_covered', process: 'covered' } }),
    );
    expect(human.category).toBe('not_addressed');
    expect(human.gaps).toContain('data');
  });

  it('下書きの節で定性情報の未記入・根拠なし・値なしは未対応', () => {
    const draft = { ...approvedBlock, status: 'draft' } as const;
    const result = classifyRequirement(
      input({ blocks: [draft], narrativeMissingFields: true, evidence: 'none' }),
    );
    expect(result.category).toBe('not_addressed');
    expect(result.gaps).toEqual(expect.arrayContaining(['narrative', 'evidence']));
  });

  it('レビュー中・要再確認・未承認の数値・過年度根拠のみ・AI のみ・評価「一部」は追加確認が必要', () => {
    const cases: Partial<RequirementCoverageInput>[] = [
      { blocks: [{ ...approvedBlock, status: 'review_requested' }] },
      { blocks: [{ ...approvedBlock, recheck: true }] },
      { metrics: 'unapproved' },
      { metrics: 'stale' },
      { evidence: 'prior_only' },
      { aiOnly: true },
      { human: { disclosure: 'partial', data: 'covered', process: 'covered' } },
      { human: null },
    ];
    for (const c of cases) {
      expect(classifyRequirement(input(c)).category, JSON.stringify(c)).toBe('needs_check');
    }
  });

  it('翻訳版の節は判定に使わない', () => {
    const result = classifyRequirement(
      input({ blocks: [{ ...approvedBlock, translation: true }] }),
    );
    expect(result.category).toBe('not_addressed');
  });

  it('slowestHumanCoverage は 3 観点の最も遅いもの（未評価があれば null）', () => {
    expect(
      slowestHumanCoverage({ disclosure: 'covered', data: 'partial', process: 'mostly_covered' }),
    ).toBe('partial');
    expect(slowestHumanCoverage({ disclosure: 'covered', data: null, process: 'covered' })).toBe(
      null,
    );
  });

  it('countByCategory は 0 件の区分も持つ', () => {
    expect(countByCategory(['confirmed', 'confirmed', 'excluded'])).toEqual({
      confirmed: 2,
      needs_check: 0,
      not_addressed: 0,
      undetermined: 0,
      excluded: 1,
    });
  });
});

describe('対象外の申請と承認の状態', () => {
  const reason = '当社は該当する事業を営んでいない（架空）';
  const digest = exclusionReasonDigest('not_applicable', reason);
  const ev = (
    id: string,
    event: ExclusionEventLike['event'],
    createdAt: string,
    actor = 'u1',
    d = digest,
  ): ExclusionEventLike => ({
    id,
    event,
    decision: 'not_applicable',
    reasonDigest: d,
    actorUserId: actor,
    createdAt,
  });

  it('ダイジェストは区分＋改行＋理由の sha256（DB と同じ規則）', () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(exclusionReasonDigest('not_material', reason)).not.toBe(digest);
  });

  it('申請 → 承認。理由を変えると再承認が必要', () => {
    const events = [
      ev('1', 'requested', '2026-10-01T00:00:00Z'),
      ev('2', 'approved', '2026-10-02T00:00:00Z', 'u2'),
    ];
    const approved = exclusionStateOf(events, { decision: 'not_applicable', reasonDigest: digest });
    expect(approved.state).toBe('approved');
    expect(approved.decidedBy).toBe('u2');
    const changed = exclusionStateOf(events, {
      decision: 'not_applicable',
      reasonDigest: exclusionReasonDigest('not_applicable', `${reason}。追記`),
    });
    expect(changed.state).toBe('reapproval_required');
  });

  it('差戻し・取り下げ・申請中', () => {
    expect(
      exclusionStateOf([ev('1', 'requested', '2026-10-01T00:00:00Z')], {
        decision: 'not_applicable',
        reasonDigest: digest,
      }).state,
    ).toBe('requested');
    expect(
      exclusionStateOf(
        [ev('1', 'requested', '2026-10-01T00:00:00Z'), ev('2', 'returned', '2026-10-02T00:00:00Z')],
        { decision: 'not_applicable', reasonDigest: digest },
      ).state,
    ).toBe('returned');
    expect(
      exclusionStateOf(
        [
          ev('1', 'requested', '2026-10-01T00:00:00Z'),
          ev('2', 'withdrawn', '2026-10-02T00:00:00Z'),
        ],
        { decision: 'not_applicable', reasonDigest: digest },
      ).state,
    ).toBe('not_requested');
    expect(exclusionStateOf([], null).state).toBe('not_requested');
  });

  it('理由の抜粋は 200 字まで', () => {
    expect(exclusionReasonExcerpt('あ'.repeat(250))).toHaveLength(200);
    expect(exclusionReasonExcerpt(' 短い ')).toBe('短い');
  });
});

describe('担当・期限の出所', () => {
  it('未完了の対応計画（期限の早いもの）→ 節 → 評価 → プロジェクト', () => {
    expect(
      resolveOwnerDue({
        plans: [
          { assigneeUserId: null, department: '環境部', dueDate: '2026-12-01', done: false },
          { assigneeUserId: 'u1', department: '', dueDate: '2026-11-01', done: false },
          { assigneeUserId: 'u9', department: '', dueDate: '2026-01-01', done: true },
        ],
        blocks: [{ ownerUserId: 'u2', dueDate: null }],
        assessment: null,
        projectDueDate: '2027-03-31',
      }),
    ).toEqual({
      ownerUserId: 'u1',
      ownerLabel: null,
      dueDate: '2026-11-01',
      source: 'action_plan',
    });
    expect(
      resolveOwnerDue({
        plans: [],
        blocks: [{ ownerUserId: 'u2', dueDate: '2026-12-15' }],
        assessment: null,
        projectDueDate: null,
      }).source,
    ).toBe('block');
    expect(
      resolveOwnerDue({
        plans: [],
        blocks: [],
        assessment: { ownerUserId: null, ownerDepartment: '経理部', dueDate: null },
        projectDueDate: null,
      }),
    ).toEqual({ ownerUserId: null, ownerLabel: '経理部', dueDate: null, source: 'assessment' });
    expect(
      resolveOwnerDue({ plans: [], blocks: [], assessment: null, projectDueDate: '2027-03-31' }),
    ).toEqual({ ownerUserId: null, ownerLabel: null, dueDate: '2027-03-31', source: 'project' });
  });
});
