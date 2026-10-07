import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CandidateDecision } from '@/components/shared/candidate-decision';
import { IDLE_FORM_STATE } from '@/lib/errors/form-action-state';

/**
 * AI の候補と人の確定（plan §3.1 CandidateDecision）。
 * - 状態から primary を 1 つだけ選ぶ（AI は確定しない。候補は外に表示）
 * - 採用のフォームに入力（確認コメントなど）を添えられる（adoptFields。B3・B2 の依頼）
 * - 修正・手入力のフォームは、入力を残すフォーム（PreservingForm・useActionState 型の Server Action）も受ける
 */

const action = vi.fn();
const preserving = vi.fn(async () => IDLE_FORM_STATE);

const candidate = {
  summary: <p>開示の観点は一部対応</p>,
  source: 'mock' as const,
  createdAt: '2026-10-01T00:00:00Z',
  confidence: 0.8,
};

function primaryLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-variant="primary"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

describe('CandidateDecision', () => {
  it('候補があり未確定: primary は「候補を採用」だけ。候補であることを外に表示する', () => {
    const { container } = render(
      <CandidateDecision
        candidate={candidate}
        adopt={{ action, fields: { itemId: 'i1' } }}
        editAndConfirm={{ action }}
        canWrite
        canRunAi
      />,
    );
    expect(primaryLabels(container)).toEqual(['候補を採用']);
    expect(screen.getByText('AI の候補')).toBeTruthy();
  });

  it('採用のフォームに入力を添えられる（adoptFields）。入力は採用のフォームに属する', () => {
    render(
      <CandidateDecision
        candidate={candidate}
        adopt={{ action, fields: { itemId: 'i1' } }}
        adoptFields={<textarea name="comment" aria-label="確認コメント（任意）" />}
        canWrite
        canRunAi={false}
      />,
    );
    const comment = screen.getByRole('textbox', { name: '確認コメント（任意）' });
    const adopt = screen.getByRole('button', { name: '候補を採用' });
    expect((comment as HTMLTextAreaElement).form).not.toBeNull();
    expect((comment as HTMLTextAreaElement).form).toBe((adopt as HTMLButtonElement).form);
  });

  it('候補が無く未確定: 手入力の確定が primary。入力を残すフォーム（PreservingForm）でも描ける', () => {
    const { container } = render(
      <CandidateDecision
        manualConfirm={{ preservingAction: preserving, fields: { itemId: 'i1' } }}
        run={{ action }}
        canWrite
        canRunAi
      >
        <input name="note" aria-label="メモ" defaultValue="" />
      </CandidateDecision>,
    );
    expect(primaryLabels(container)).toEqual(['担当者の入力として確定']);
    const note = screen.getByRole('textbox', { name: 'メモ' }) as HTMLInputElement;
    // 隠し項目と同じフォームに入る
    expect(note.form?.querySelector('input[type="hidden"][name="itemId"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'AI ギャップ分析を実行' }).dataset.variant).toBe(
      'secondary',
    );
  });

  it('確定済み: 確定の記録と、呼び出し側の次の操作だけを出す（確定のボタンは出さない）', () => {
    const { container } = render(
      <CandidateDecision
        candidate={candidate}
        decided={{ by: '海野 みどり', at: '2026-10-02T03:00:00Z', summary: <p>対応済み</p> }}
        adopt={{ action }}
        afterDecision={<button type="button">対応計画に追加</button>}
        canWrite
        canRunAi
      />,
    );
    expect(primaryLabels(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: '候補を採用' })).toBeNull();
    expect(screen.getByText(/確定済み（海野 みどり/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '対応計画に追加' })).toBeTruthy();
  });

  it('書き込みの権限が無ければ確定の操作を出さない（候補の表示は残す）', () => {
    const { container } = render(
      <CandidateDecision candidate={candidate} adopt={{ action }} canWrite={false} canRunAi />,
    );
    expect(primaryLabels(container)).toEqual([]);
    expect(container.querySelector('[data-candidate-decision="candidate"]')).not.toBeNull();
  });
});
