import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewListItem } from '@/lib/services/disclosure-review';

/**
 * UX-R3-15（自己監査 第 3 回）: 状態で絞り込んで 0 件になっただけのときに、
 * 「レビュー依頼はありません」と言わず、絞り込みを外す操作を示す。
 */

const items: ReviewListItem[] = [
  {
    id: 'r1',
    projectId: 'p1',
    projectName: 'FY2026',
    blockId: 'b1',
    blockTitle: 'リスク及び機会',
    targetVersionNo: 2,
    status: 'open',
    statusLabel: 'レビュー待ち',
    requestedByName: '海野',
    reviewerName: '検見川',
    approverName: '承',
    policyVersion: 'sod-3role-v1',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    events: [],
    myStage: null,
  },
];

// 一覧は DataTable（列の切替・表示件数は URL を書き換える Client Component で、App Router が要る）
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/enterprise/disclosure-projects/p1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=reviews'),
}));
vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => ({ db: {}, ctx: {} }),
}));
vi.mock('@/lib/services/disclosure-review', () => ({
  listProjectReviews: async () => items,
}));

describe('UX-R3-15 レビュー・承認タブの絞り込みの 0 件', () => {
  it('依頼はあるのに絞り込みで 0 件なら、条件に合わないことと、絞り込みを外すリンクを示す', async () => {
    const { ReviewsTab } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/reviews');
    render(await ReviewsTab({ projectId: 'p1', searchParams: { rstatus: 'approved' } }));
    expect(screen.getByText('条件に合うレビュー依頼はありません')).toBeInTheDocument();
    expect(screen.queryByText('レビュー依頼はありません')).toBeNull();
    expect(screen.getByRole('link', { name: '絞り込みを外す（すべて表示）' })).toHaveAttribute(
      'href',
      '/enterprise/disclosure-projects/p1?tab=reviews',
    );
  });

  it('絞り込みが無く依頼も無ければ、従来の案内のまま', async () => {
    items.length = 0;
    const { ReviewsTab } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/reviews');
    render(await ReviewsTab({ projectId: 'p1', searchParams: {} }));
    expect(screen.getByText('レビュー依頼はありません')).toBeInTheDocument();
  });
});
