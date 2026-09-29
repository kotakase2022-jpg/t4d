import { describe, expect, it } from 'vitest';
import * as status from '../../src/lib/domain/disclosure-status';
import type { BlockBlockerInput } from '../../src/lib/domain/disclosure-status';
import {
  ANCHOR_ACQUIRED_BY,
  ANCHOR_KINDS,
  APPLICABILITY_STATUSES,
  AVAILABILITY_STATUSES,
  BLOCK_STATUSES,
  BLOCK_VERSION_ORIGINS,
  DISCLOSURE_LANGUAGES,
  DISCLOSURE_PROJECT_STATUSES,
  DISCLOSURE_PURPOSES,
  EVIDENCE_USAGE_PURPOSES,
  EXPORT_ARTIFACT_FORMATS,
  EXPORT_AUDIENCES,
  FRAMEWORK_COVERAGE_STATUSES,
  FRAMEWORK_LEGAL_STATUSES,
  KPI_DIRECTIONS,
  KPI_TARGET_TYPES,
  MATERIALITY_BASES,
  NARRATIVE_STATUSES,
  NARRATIVE_THEMES,
  QUANTITATIVE_IMPORT_DIFF_KINDS,
  QUANTITATIVE_IMPORT_STATUSES,
  RECHECK_DECISIONS,
  RECHECK_REF_KINDS,
  REPORT_SNAPSHOT_KINDS,
  REVIEW_COMMENT_SEVERITIES,
  REVIEW_EVENT_TYPES,
  REVIEW_REQUEST_STATUSES,
  REVIEW_STAGES,
  VALUE_KINDS,
  type BlockBody,
} from '../../src/types/domain';

const AUTHOR = 'user-author';
const REQUESTER = 'user-requester';
const REVIEWER = 'user-reviewer';
const APPROVER = 'user-approver';

describe('表示ラベル', () => {
  it('新しい enum のすべての値に空でない日本語ラベルがある', () => {
    const pairs: Array<[readonly string[], Record<string, string>]> = [
      [DISCLOSURE_PURPOSES, status.DISCLOSURE_PURPOSE_LABELS],
      [APPLICABILITY_STATUSES, status.APPLICABILITY_STATUS_LABELS],
      [DISCLOSURE_PROJECT_STATUSES, status.DISCLOSURE_PROJECT_STATUS_LABELS],
      [DISCLOSURE_LANGUAGES, status.DISCLOSURE_LANGUAGE_LABELS],
      [NARRATIVE_THEMES, status.NARRATIVE_THEME_LABELS],
      [NARRATIVE_STATUSES, status.NARRATIVE_STATUS_LABELS],
      [ANCHOR_KINDS, status.ANCHOR_KIND_LABELS],
      [ANCHOR_ACQUIRED_BY, status.ANCHOR_ACQUIRED_BY_LABELS],
      [BLOCK_STATUSES, status.BLOCK_STATUS_LABELS],
      [BLOCK_VERSION_ORIGINS, status.BLOCK_VERSION_ORIGIN_LABELS],
      [REVIEW_REQUEST_STATUSES, status.REVIEW_REQUEST_STATUS_LABELS],
      [REVIEW_EVENT_TYPES, status.REVIEW_EVENT_TYPE_LABELS],
      [REVIEW_STAGES, status.REVIEW_STAGE_LABELS],
      [REVIEW_COMMENT_SEVERITIES, status.REVIEW_COMMENT_SEVERITY_LABELS],
      [RECHECK_REF_KINDS, status.RECHECK_REF_KIND_LABELS],
      [RECHECK_DECISIONS, status.RECHECK_DECISION_LABELS],
      [REPORT_SNAPSHOT_KINDS, status.REPORT_SNAPSHOT_KIND_LABELS],
      [EXPORT_ARTIFACT_FORMATS, status.EXPORT_ARTIFACT_FORMAT_LABELS],
      [EXPORT_AUDIENCES, status.EXPORT_AUDIENCE_LABELS],
      [KPI_TARGET_TYPES, status.KPI_TARGET_TYPE_LABELS],
      [KPI_DIRECTIONS, status.KPI_DIRECTION_LABELS],
      [VALUE_KINDS, status.VALUE_KIND_LABELS],
      [AVAILABILITY_STATUSES, status.AVAILABILITY_STATUS_LABELS],
      [EVIDENCE_USAGE_PURPOSES, status.EVIDENCE_USAGE_PURPOSE_LABELS],
      [FRAMEWORK_LEGAL_STATUSES, status.FRAMEWORK_LEGAL_STATUS_LABELS],
      [FRAMEWORK_COVERAGE_STATUSES, status.FRAMEWORK_COVERAGE_STATUS_LABELS],
      [MATERIALITY_BASES, status.MATERIALITY_BASIS_LABELS],
      [QUANTITATIVE_IMPORT_STATUSES, status.QUANTITATIVE_IMPORT_STATUS_LABELS],
      [QUANTITATIVE_IMPORT_DIFF_KINDS, status.QUANTITATIVE_IMPORT_DIFF_KIND_LABELS],
    ];
    for (const [values, map] of pairs) {
      expect(Object.keys(map).sort()).toEqual([...values].sort());
      for (const value of values) expect(map[value]?.trim()).toBeTruthy();
    }
  });

  it('設計書（docs/disclosure-first.md）の表記どおり', () => {
    expect(Object.values(status.DISCLOSURE_PURPOSE_LABELS)).toEqual([
      'SSBJ（法定）',
      'SSBJ（任意）',
      'CSRD 域外（40a）準備',
      'CSRD（EU 法人）',
      '社内 ESG 管理',
    ]);
    expect(Object.values(status.APPLICABILITY_STATUS_LABELS)).toEqual([
      '未判定',
      '適用候補',
      '適用と判断',
      '対象外と判断',
      '任意適用',
      '確認待ち',
    ]);
    expect(Object.values(status.NARRATIVE_THEME_LABELS)).toEqual([
      'リスク・機会',
      '財務的影響',
      'ガバナンス',
      '戦略・対応策',
      '方針・その他',
    ]);
    expect(Object.values(status.NARRATIVE_STATUS_LABELS)).toEqual([
      '下書き',
      '確認済み',
      '要再確認',
    ]);
    expect(Object.values(status.BLOCK_STATUS_LABELS)).toEqual([
      '下書き',
      'レビュー依頼中',
      '差戻し',
      '承認待ち',
      '承認済み',
    ]);
    expect(Object.values(status.AVAILABILITY_STATUS_LABELS)).toEqual([
      '値あり',
      '未入力',
      '未取得',
      '対象外',
      '未算定',
    ]);
    expect(Object.values(status.VALUE_KIND_LABELS)).toEqual(['実績', '推計', '目標']);
  });

  it('スナップショット種別は社内承認であり、保証・提出・確定と読める語を使わない（§6.10）', () => {
    expect(status.REPORT_SNAPSHOT_KIND_LABELS).toEqual({
      review_draft: 'レビュー用草稿',
      approved: '社内承認済み版',
    });
    for (const label of Object.values(status.REPORT_SNAPSHOT_KIND_LABELS)) {
      expect(label).not.toMatch(/保証|提出|確定/);
    }
  });
});

describe('値の有無（0039 の backfill と同じ規則）', () => {
  it('値か文字値があれば値あり、どちらも無ければ未入力（対象外にはしない）', () => {
    expect(status.availabilityFromValue(0, null)).toBe('value_present');
    expect(status.availabilityFromValue(12.3, null)).toBe('value_present');
    expect(status.availabilityFromValue(null, 'あり')).toBe('value_present');
    expect(status.availabilityFromValue(null, null)).toBe('not_entered');
    expect(status.availabilityFromValue(undefined, undefined)).toBe('not_entered');
    expect(status.availabilityFromValue(Number.NaN, null)).toBe('not_entered');
  });

  it('値の更新後: 入れたら値あり、消したら未入力、無いままなら人の判断（対象外と理由）を保つ', () => {
    const notApplicable = {
      availabilityStatus: 'not_applicable' as const,
      absenceReason: '該当設備なし',
    };
    const present = { availabilityStatus: 'value_present' as const, absenceReason: null };
    expect(status.availabilityAfterValueChange(notApplicable, 5, null)).toEqual({
      availabilityStatus: 'value_present',
      absenceReason: null,
    });
    expect(status.availabilityAfterValueChange(present, null, null)).toEqual({
      availabilityStatus: 'not_entered',
      absenceReason: null,
    });
    expect(status.availabilityAfterValueChange(notApplicable, null, null)).toEqual(notApplicable);
  });
});

describe('節の状態遷移（§5）', () => {
  it('遷移表がすべての操作を持つ', () => {
    expect(Object.keys(status.BLOCK_TRANSITIONS).sort()).toEqual([...status.BLOCK_ACTIONS].sort());
  });

  it('§5 の流れ: 依頼 → レビュー完了 → 承認 → 承認後に修正', () => {
    expect(status.transitionBlock('request_review', 'draft')).toEqual({
      ok: true,
      to: 'review_requested',
    });
    expect(status.transitionBlock('complete_review', 'review_requested')).toEqual({
      ok: true,
      to: 'approval_pending',
    });
    expect(status.transitionBlock('approve', 'approval_pending')).toEqual({
      ok: true,
      to: 'approved',
    });
    expect(status.transitionBlock('revise_after_approval', 'approved')).toEqual({
      ok: true,
      to: 'draft',
    });
  });

  it('差戻しは第 1 段・最終承認のどちらからもでき、差戻し後は再依頼できる', () => {
    expect(status.transitionBlock('return', 'review_requested')).toEqual({
      ok: true,
      to: 'returned',
    });
    expect(status.transitionBlock('return', 'approval_pending')).toEqual({
      ok: true,
      to: 'returned',
    });
    expect(status.transitionBlock('request_review', 'returned')).toEqual({
      ok: true,
      to: 'review_requested',
    });
  });

  it('自動保存・版の保存は状態を変えず、下書き・差戻しの節でだけできる', () => {
    expect(status.transitionBlock('autosave', 'returned')).toEqual({ ok: true, to: 'returned' });
    expect(status.transitionBlock('save_version', 'draft')).toEqual({ ok: true, to: 'draft' });
    const locked = status.transitionBlock('save_version', 'review_requested');
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toContain('レビュー依頼中');
  });

  it('レビューを飛ばした承認・承認済みの節への再依頼はできない', () => {
    expect(status.transitionBlock('approve', 'review_requested').ok).toBe(false);
    expect(status.transitionBlock('approve', 'draft').ok).toBe(false);
    expect(status.transitionBlock('request_review', 'approved').ok).toBe(false);
    expect(status.transitionBlock('complete_review', 'approval_pending').ok).toBe(false);
  });
});

describe('職務分離（§2。DB トリガ t4d.enforce_review_event と同じ規則）', () => {
  const openRequest = { requestedBy: REQUESTER, status: 'open' as const };
  const reviewedRequest = { requestedBy: REQUESTER, status: 'reviewed' as const };

  it('レビュー完了: 依頼者・版の作成者は不可、それ以外は可', () => {
    expect(
      status.canCompleteReview({
        actorId: REVIEWER,
        request: openRequest,
        targetVersionCreatedBy: AUTHOR,
      }),
    ).toEqual({ ok: true });

    const byRequester = status.canCompleteReview({
      actorId: REQUESTER,
      request: openRequest,
      targetVersionCreatedBy: AUTHOR,
    });
    expect(byRequester).toMatchObject({ ok: false, code: 'requester' });

    const byAuthor = status.canCompleteReview({
      actorId: AUTHOR,
      request: openRequest,
      targetVersionCreatedBy: AUTHOR,
    });
    expect(byAuthor).toMatchObject({ ok: false, code: 'author' });
    if (!byAuthor.ok) expect(byAuthor.reason).toContain('職務分離');
  });

  it('レビュー完了はレビュー待ちの依頼にだけできる', () => {
    expect(
      status.canCompleteReview({
        actorId: REVIEWER,
        request: reviewedRequest,
        targetVersionCreatedBy: AUTHOR,
      }),
    ).toMatchObject({ ok: false, code: 'request_not_open' });
  });

  it('最終承認: 依頼者・版の作成者・同じ依頼のレビュー完了者は不可', () => {
    const base = {
      request: reviewedRequest,
      targetVersionCreatedBy: AUTHOR,
      reviewCompletedBy: REVIEWER,
    };
    expect(status.canFinalApprove({ ...base, actorId: APPROVER })).toEqual({ ok: true });
    expect(status.canFinalApprove({ ...base, actorId: REQUESTER })).toMatchObject({
      ok: false,
      code: 'requester',
    });
    expect(status.canFinalApprove({ ...base, actorId: AUTHOR })).toMatchObject({
      ok: false,
      code: 'author',
    });
    expect(status.canFinalApprove({ ...base, actorId: REVIEWER })).toMatchObject({
      ok: false,
      code: 'reviewer',
    });
    // レビュー完了者は配列でも渡せる
    expect(
      status.canFinalApprove({
        ...base,
        reviewCompletedBy: [REVIEWER, APPROVER],
        actorId: APPROVER,
      }),
    ).toMatchObject({ ok: false, code: 'reviewer' });
  });

  it('最終承認はレビュー完了後の依頼にだけできる（レビューを飛ばさない）', () => {
    expect(
      status.canFinalApprove({
        actorId: APPROVER,
        request: openRequest,
        targetVersionCreatedBy: AUTHOR,
        reviewCompletedBy: null,
      }),
    ).toMatchObject({ ok: false, code: 'request_not_reviewed' });
  });

  it('既定の規則は 3 役割（sod-3role-v1）', () => {
    expect(status.DEFAULT_REVIEW_POLICY).toMatchObject({
      version: 'sod-3role-v1',
      stages: ['review', 'final'],
      forbidRequesterOrAuthorReview: true,
      forbidRequesterAuthorOrReviewerApproval: true,
      requireReturnReasonAndParagraph: true,
    });
  });

  it('差戻しは理由と実在する段落が必須', () => {
    const body: BlockBody = {
      paragraphs: [{ id: 'p1', kind: 'paragraph', children: [{ t: 'text', text: '本文' }] }],
    };
    expect(status.validateReturn({ reason: '根拠が不足', paragraphId: 'p1', body })).toEqual({
      ok: true,
    });
    expect(status.validateReturn({ reason: '  ', paragraphId: 'p1' }).ok).toBe(false);
    expect(status.validateReturn({ reason: '根拠が不足', paragraphId: null }).ok).toBe(false);
    expect(status.validateReturn({ reason: '根拠が不足', paragraphId: 'p9', body }).ok).toBe(false);
  });

  it('冪等キーは依頼・段階・対象版から決まる', () => {
    expect(status.reviewEventIdempotencyKey('req-1', 'final', 'ver-1')).toBe('req-1:final:ver-1');
    expect(status.reviewEventIdempotencyKey('req-1', 'review', 'ver-1')).not.toBe(
      status.reviewEventIdempotencyKey('req-1', 'final', 'ver-1'),
    );
  });
});

describe('阻害条件', () => {
  const body: BlockBody = {
    paragraphs: [{ id: 'p1', kind: 'paragraph', children: [{ t: 'text', text: '本文あり' }] }],
  };
  const clean: BlockBlockerInput = {
    body,
    pendingAiCandidateCount: 0,
    comments: [
      { severity: 'major', resolvedAt: '2026-08-10T00:00:00.000Z' },
      { severity: 'info', resolvedAt: null },
    ],
    metricRefs: [{ dataPointId: 'dp1', dataPointVersionId: 'v2', currentVersionId: 'v2' }],
    frameworks: [
      { frameworkVersionId: 'fw1', label: 'SSBJ 2026', applicabilityStatus: 'applicable' },
    ],
  };

  it('条件を満たしていれば阻害なし（解決済みの major・未解決の info は阻害しない）', () => {
    expect(status.evaluateBlockBlockers(clean)).toEqual([]);
  });

  it('5 つの阻害条件をそれぞれ検出する', () => {
    const blockers = status.evaluateBlockBlockers({
      body: { paragraphs: [] },
      pendingAiCandidateCount: 2,
      comments: [{ severity: 'major', resolvedAt: null }],
      metricRefs: [
        {
          dataPointId: 'dp1',
          dataPointVersionId: 'v1',
          currentVersionId: 'v2',
          label: 'Scope1 排出量',
        },
        { dataPointId: 'dp2', dataPointVersionId: 'w1', currentVersionId: 'w1' },
      ],
      frameworks: [
        { frameworkVersionId: 'fw1', label: 'SSBJ 2026', applicabilityStatus: 'applicable' },
        { frameworkVersionId: 'fw2', label: 'ESRS-40a 草案', applicabilityStatus: 'not_assessed' },
      ],
    });
    expect(blockers.map((b) => b.code)).toEqual([
      'no_body',
      'unadopted_ai_candidate',
      'unresolved_major_comments',
      'stale_metric_refs',
      'applicability_not_assessed',
    ]);
    expect(blockers.find((b) => b.code === 'stale_metric_refs')?.message).toContain(
      'Scope1 排出量',
    );
    expect(blockers.find((b) => b.code === 'applicability_not_assessed')?.message).toContain(
      'ESRS-40a 草案',
    );
    expect(blockers.find((b) => b.code === 'unadopted_ai_candidate')?.message).toContain('2 件');
  });

  it('版の無い本文（null）は本文なし', () => {
    expect(status.evaluateBlockBlockers({ ...clean, body: null }).map((b) => b.code)).toEqual([
      'no_body',
    ]);
  });

  it('現在の版が分からない数値（currentVersionId が null）は古いと断定しない', () => {
    expect(
      status.evaluateBlockBlockers({
        ...clean,
        metricRefs: [{ dataPointId: 'dp1', dataPointVersionId: 'v1', currentVersionId: null }],
      }),
    ).toEqual([]);
  });
});
