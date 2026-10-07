import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ASSURANCE_FOCUS,
  ASSURANCE_FOCUS_LABEL,
  assuranceAttention,
  assuranceWorkItems,
  matchesAssuranceFocus,
  parseAssuranceFocus,
  type EngagementWorkCounts,
} from '@/lib/ui/assurance-work';
import {
  AUDIT_EVENT_LABEL,
  CHANGE_KIND_LABEL,
  TEST_RESULT_OPTIONS,
  auditEventLabel,
  testResultEntry,
} from '@/app/assurance/_components/labels';
import { AssuranceNextWork } from '@/components/shared/assurance-next-work';
import { AUDIT_EVENT_TYPES, CHANGE_KINDS, TEST_RESULTS } from '@/types/domain';

/**
 * 監査法人の「自分が次に行う作業」と「要対応」（plan §1.3 監査法人・S13・S22）。
 * 案件ホームと案件の概要が同じ定義を使う。役割で並びが変わり、0 件の項目は出さない。
 */

function row(overrides: Partial<EngagementWorkCounts> = {}): EngagementWorkCounts {
  return {
    engagementId: 'eng-1',
    code: 'ENG-1',
    clientName: '青海',
    deadlineDate: '2026-12-31',
    daysUntilDeadline: 30,
    pbcOpen: 0,
    pbcOutstanding: 0,
    pbcAnswered: 0,
    testsPending: 0,
    reviewPending: 0,
    openHighIssues: 0,
    changesSinceSnapshot: 0,
    openReviewNotes: 0,
    signoffStages: [],
    signoffBlockers: 0,
    ...overrides,
  };
}

describe('自分が次に行う作業（役割で並びを変える）', () => {
  const busy = row({
    pbcOutstanding: 2,
    pbcAnswered: 1,
    testsPending: 3,
    reviewPending: 4,
    changesSinceSnapshot: 1,
    openReviewNotes: 2,
    signoffBlockers: 3,
  });

  it('マネージャー: 未受領の資料依頼 → レビュー待ちの調書 → Snapshot 後の変更 → 回答済みの資料依頼', () => {
    expect(assuranceWorkItems('manager', [busy]).map((i) => i.verb)).toEqual([
      '未受領の資料依頼を確認する',
      '調書をレビューする',
      'Snapshot 後の変更を評価する',
      '回答済みの資料依頼を処理する',
    ]);
  });

  it('担当者: 手続を進める → 回答済みの資料依頼（Sign-off・レビューNote は出さない）', () => {
    expect(assuranceWorkItems('staff', [busy]).map((i) => i.verb)).toEqual([
      '手続を進める',
      '回答済みの資料依頼を処理する',
    ]);
  });

  it('契約責任者: Sign-off（抑止条件の数を理由に）→ レビューNote', () => {
    const items = assuranceWorkItems('partner', [busy]);
    expect(items[0]?.verb).toBe('Sign-off を確認する');
    expect(items[0]?.reason).toBe('抑止条件 3 件');
    expect(items[1]?.verb).toBe('レビューNote を確認する');
    // 最終 Sign-off が済んだ案件には Sign-off の作業を出さない
    expect(
      assuranceWorkItems('partner', [row({ signoffStages: ['partner_approved'] })]).map(
        (i) => i.verb,
      ),
    ).not.toContain('Sign-off を確認する');
  });

  it('法人管理者・閲覧は作業なし。0 件の作業は出さない', () => {
    expect(assuranceWorkItems('firm_admin', [busy])).toEqual([]);
    expect(assuranceWorkItems('viewer', [busy])).toEqual([]);
    expect(assuranceWorkItems('manager', [row()])).toEqual([]);
  });

  it('同じ種類の作業は期限が近い案件から', () => {
    const later = row({ engagementId: 'b', code: 'B', testsPending: 1, daysUntilDeadline: 50 });
    const sooner = row({ engagementId: 'a', code: 'A', testsPending: 1, daysUntilDeadline: 5 });
    expect(assuranceWorkItems('staff', [later, sooner]).map((i) => i.target)).toEqual(['A', 'B']);
  });

  it('行き先は各画面の絞り込み付き（確定はここから実行しない）', () => {
    const items = assuranceWorkItems('manager', [busy]);
    expect(items.map((i) => i.href)).toEqual([
      '/assurance/engagements/eng-1/requests?filter=sent',
      '/assurance/engagements/eng-1/testing',
      '/assurance/engagements/eng-1/data-room',
      '/assurance/engagements/eng-1/requests?filter=submitted',
    ]);
  });
});

describe('要対応（0 件は出さない・1 案件なら直行）', () => {
  it('1 案件だけが該当するときはその案件の画面へ、複数なら案件ホームの絞り込みへ', () => {
    const one = assuranceAttention(
      [row({ openHighIssues: 2 }), row({ engagementId: 'x' })],
      (f) => `/many/${f}`,
    );
    expect(one).toEqual([
      expect.objectContaining({
        key: 'high_issues',
        count: 2,
        href: '/assurance/engagements/eng-1/issues?filter=high',
      }),
    ]);
    const many = assuranceAttention(
      [row({ openHighIssues: 1 }), row({ engagementId: 'x', openHighIssues: 1 })],
      (f) => `/many/${f}`,
    );
    expect(many[0]).toEqual(expect.objectContaining({ count: 2, href: '/many/high_issues' }));
  });

  it('期限が 14 日以内の案件を数える（最終 Sign-off 済みは除く）', () => {
    const items = assuranceAttention(
      [
        row({ daysUntilDeadline: 3 }),
        row({ engagementId: 'b', daysUntilDeadline: 3, signoffStages: ['partner_approved'] }),
        row({ engagementId: 'c', daysUntilDeadline: 40 }),
      ],
      (f) => `/many/${f}`,
    );
    expect(items.find((i) => i.key === 'deadline')?.count).toBe(1);
  });
});

describe('案件ホームの絞り込み（KPI と同じ条件）', () => {
  it('未知の値は無視し、各条件は KPI と同じ数え方', () => {
    expect(parseAssuranceFocus('nope')).toBeNull();
    expect(parseAssuranceFocus('pbc')).toBe('pbc');
    const r = { ...row({ pbcOpen: 1, daysUntilDeadline: 61 }), completed: false };
    expect(matchesAssuranceFocus('pbc', r)).toBe(true);
    expect(matchesAssuranceFocus('deadline', r)).toBe(false);
    expect(matchesAssuranceFocus('active', { ...r, completed: true })).toBe(false);
    for (const focus of ASSURANCE_FOCUS) expect(ASSURANCE_FOCUS_LABEL[focus]).not.toBe('');
  });
});

describe('監査法人の語（生の enum を出さない）', () => {
  const japanese = /[぀-ヿ一-鿿]/;

  it('監査イベント・変更の種類・手続の結果のすべての値に日本語の名前がある', () => {
    for (const type of AUDIT_EVENT_TYPES) expect(AUDIT_EVENT_LABEL[type]).toMatch(japanese);
    for (const kind of CHANGE_KINDS) expect(CHANGE_KIND_LABEL[kind]).toMatch(japanese);
    expect(TEST_RESULT_OPTIONS.map((o) => o.value).sort()).toEqual([...TEST_RESULTS].sort());
    expect(testResultEntry('pass').label).toBe('相違なし');
  });

  it('知らない値でも生の値を出さない', () => {
    expect(auditEventLabel('unknown_event')).toBe('その他の記録');
    expect(testResultEntry('weird').label).toBe('結果不明');
  });
});

describe('AssuranceNextWork（primary は 1 つ）', () => {
  it('作業があれば「最初の作業を開く」1 つだけが primary。行は文字のリンク', () => {
    const items = assuranceWorkItems('manager', [row({ pbcOutstanding: 1, reviewPending: 2 })]);
    const { container } = render(<AssuranceNextWork attention={[]} items={items} showWork />);
    const primaries = container.querySelectorAll('[data-variant="primary"]');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent('最初の作業を開く');
    expect(primaries[0]).toHaveAttribute('href', items[0]!.href);
    expect(screen.getByRole('heading', { name: /自分が次に行う作業（2 件）/ })).toBeInTheDocument();
  });

  it('作業が無いときは前向きな空状態。作業の無い役割には表を出さない', () => {
    const { rerender, container } = render(
      <AssuranceNextWork attention={[]} items={[]} showWork />,
    );
    expect(screen.getByText('いま、あなたが次に行う作業はありません')).toBeInTheDocument();
    expect(container.querySelector('[data-variant="primary"]')).toBeNull();
    rerender(<AssuranceNextWork attention={[]} items={[]} showWork={false} />);
    expect(container.querySelector('[data-assurance-work]')).toBeNull();
  });
});
