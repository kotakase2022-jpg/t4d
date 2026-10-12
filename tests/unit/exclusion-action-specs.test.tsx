import { describe, expect, it, vi } from 'vitest';

/**
 * 対象外・非重要の承認の操作（レビュー指摘 F9）。押せない操作の確認ダイアログを開かせない:
 * 理由を記録した人には「対象外を承認」を押せない理由付きで出し（サーバーの decideExclusion と同じ規則）、
 * 差し戻しは出す。申請した人には承認・差戻しのどちらも押させない。
 */

vi.mock('@/app/enterprise/disclosure-projects/[projectId]/requirements/actions', () => ({
  approveExclusionAction: vi.fn(),
  requestExclusionAction: vi.fn(),
  returnExclusionAction: vi.fn(),
  withdrawExclusionAction: vi.fn(),
}));

const { exclusionActions } =
  await import('@/app/enterprise/disclosure-projects/[projectId]/requirements/_components/exclusion-action-specs');

const base = {
  fields: { source: 'project_assessment', itemId: 'item-1', projectFrameworkId: 'pf-1' },
  state: 'requested' as const,
  requestedBy: 'requester',
  decision: 'not_applicable' as const,
  reason: '水資源の利用は重要なインパクトではないと判断（テスト）',
  frameworkLabel: 'ESRS-40a',
  code: '40A-S06',
  canWrite: true,
  canApprove: true,
  noteLimit: 400,
};

describe('対象外の承認の操作', () => {
  it('理由を記録した人: 承認は理由付きで押せない。差し戻しはできる', () => {
    const ops = exclusionActions({ ...base, recordedBy: 'recorder', viewerId: 'recorder' });
    expect(ops.approve?.disabledReason).toContain('理由を記録した人は承認できません');
    expect(ops.returnBack).toBeDefined();
  });

  it('申請した人: 承認も差し戻しもできない', () => {
    const ops = exclusionActions({ ...base, recordedBy: 'recorder', viewerId: 'requester' });
    expect(ops.approve?.disabledReason).toContain('申請した人は承認・差戻しできません');
    expect(ops.returnBack).toBeUndefined();
  });

  it('申請者・理由を記録した人と別の承認者: 承認を押せる', () => {
    const ops = exclusionActions({ ...base, recordedBy: 'recorder', viewerId: 'approver' });
    expect(ops.approve?.disabledReason).toBeUndefined();
    expect(ops.returnBack).toBeDefined();
  });
});
