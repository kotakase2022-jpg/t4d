import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClientCommentRow } from '@/lib/services/assurance';

/**
 * 開示プロジェクト「レビュー・承認」タブの「保証側のコメント」節（トライアル対応 NF-21・T3）。
 * クライアントへ共有された保証側のコメントの状態（ラベル＋アイコン）・対象（段落と追跡番号）と、
 * 回答の画面へのリンク（回答の権限があるときだけ・クリアしたものには出さない）を出す。
 */

const row = (id: string, state: ClientCommentRow['state']): ClientCommentRow => ({
  note: {
    id,
    engagementId: 'e1',
    assuranceFirmId: 'f1',
    targetType: 'report_paragraph',
    targetId: 'c1',
    body: `保証側のコメント ${id}`,
    raisedBy: 'u1',
    assignedTo: null,
    status: state === 'cleared' ? 'cleared' : 'open',
    sharedWithClient: true,
    resolutionComment: null,
    resolvedAt: null,
    targetCopyId: 'c1',
    targetBlockId: 'b1',
    targetParagraphId: 'p1',
    targetDataPointVersionId: null,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    createdBy: 'u1',
    updatedBy: 'u1',
  },
  engagement: { id: 'e1', code: 'ENG-2026-001', name: '保証業務' },
  responses: [],
  state,
  target: {
    kind: 'report_paragraph',
    copyId: 'c1',
    reportLabel: 'No.1 社内承認済み版',
    place: 'ガバナンス 段落 1',
    traceId: 'T-G-1',
    excerpt: '当社は…',
  },
  projectId: 'p1',
  projectName: 'FY2025',
});

let assurance: { rows: ClientCommentRow[]; canRespond: boolean } = { rows: [], canRespond: false };

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
  listProjectReviews: async () => [],
}));
vi.mock('@/lib/services/assurance', () => ({
  loadProjectAssuranceComments: async () => assurance,
}));

async function renderTab() {
  const { ReviewsTab } =
    await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/reviews');
  render(await ReviewsTab({ projectId: 'p1', searchParams: {} }));
  return screen.getByRole('region', { name: /保証側のコメント/ });
}

describe('レビュー・承認タブの「保証側のコメント」', () => {
  it('コメントが無ければ、共有の行き先（出力タブ）を示す', async () => {
    assurance = { rows: [], canRespond: true };
    const section = await renderTab();
    expect(within(section).getByText('保証側からのコメントはありません')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: '出力タブを開く' })).toHaveAttribute(
      'href',
      '/enterprise/disclosure-projects/p1?tab=outputs',
    );
  });

  it('状態はラベルとアイコンで出し、回答の画面へのリンクは回答できるコメントだけ', async () => {
    assurance = { rows: [row('n1', 'unanswered'), row('n2', 'cleared')], canRespond: true };
    const section = await renderTab();
    expect(within(section).getByRole('heading', { name: /保証側のコメント（2）/ })).toBeVisible();
    expect(within(section).getByText('未回答 1 件')).toBeInTheDocument();
    const badges = section.querySelectorAll('[data-status-domain="clientNote"]');
    expect([...badges].map((b) => b.getAttribute('data-status-value'))).toEqual([
      'unanswered',
      'cleared',
    ]);
    expect(within(section).getAllByText(/段落「ガバナンス 段落 1」（T-G-1）/)).toHaveLength(2);
    const respond = within(section).getAllByRole('link', { name: '回答する' });
    expect(respond).toHaveLength(1);
    expect(respond[0]).toHaveAttribute(
      'href',
      '/enterprise/assurance-comments?new=1&note=n1#respond-note',
    );
    expect(within(section).getByRole('link', { name: 'すべて見る' })).toHaveAttribute(
      'href',
      '/enterprise/assurance-comments?project=p1',
    );
  });

  it('回答の権限が無ければ回答のリンクを出さない（閲覧はできる）', async () => {
    assurance = { rows: [row('n1', 'unanswered')], canRespond: false };
    const section = await renderTab();
    expect(within(section).getByText('保証側のコメント n1')).toBeInTheDocument();
    expect(within(section).queryByRole('link', { name: '回答する' })).toBeNull();
  });
});
