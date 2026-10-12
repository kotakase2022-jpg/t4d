import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FeedbackFormState } from '@/app/enterprise/trial/_lib/feedback-state';

/**
 * 「ご意見・不具合」のダイアログ（トライアル対応 NF-34。レビュー指摘 UX-07）。
 * 送信がサーバーに断られた後に閉じて開き直しても、「入力は残っています」の表示と欄の中身を食い違わせない。
 */

const actionMocks = vi.hoisted(() => ({
  submitFeedbackAction: vi.fn(
    async (previous: FeedbackFormState, formData: FormData): Promise<FeedbackFormState> => ({
      status: 'error',
      message: '件名が長すぎます（テスト）',
      values: [...formData.entries()].flatMap(([name, value]) =>
        typeof value === 'string' ? [[name, value] as [string, string]] : [],
      ),
      sentTitle: null,
      nonce: previous.nonce,
    }),
  ),
}));

// Next.js の useRouter は同じオブジェクトを返す（描画のたびに作り直すと、依存に持つ効果が回り続ける）
const router = vi.hoisted(() => ({ refresh: () => {}, push: () => {}, replace: () => {} }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/enterprise/dashboard',
  useRouter: () => router,
}));
vi.mock('@/app/enterprise/trial/actions', () => actionMocks);

const { FeedbackDialog } = await import('@/app/enterprise/trial/_components/feedback-dialog');

describe('ご意見・不具合のダイアログ', () => {
  it('断られた後に閉じて開き直すと、理由と一緒に送った値が欄に戻る（空の欄に「入力は残っています」と出さない）', async () => {
    render(<FeedbackDialog />);
    fireEvent.click(screen.getByRole('button', { name: /ご意見・不具合/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/件名/), {
      target: { value: '対応表の列を選びたい（テスト）' },
    });
    fireEvent.change(within(dialog).getByLabelText(/内容/), {
      target: { value: '出力の列を選べるようにしてほしい（テスト）' },
    });
    fireEvent.submit(within(dialog).getByLabelText(/件名/).closest('form')!);
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(
        '入力は残っています',
      ),
    );

    // 断られた直後も欄に値が残る
    await waitFor(() =>
      expect(
        (within(screen.getByRole('dialog')).getByLabelText(/件名/) as HTMLInputElement).value,
      ).toBe('対応表の列を選びたい（テスト）'),
    );

    // 閉じて開き直す
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /ご意見・不具合/ }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).getByRole('alert').textContent).toContain('入力は残っています');
    await waitFor(() =>
      expect((within(reopened).getByLabelText(/件名/) as HTMLInputElement).value).toBe(
        '対応表の列を選びたい（テスト）',
      ),
    );
    expect((within(reopened).getByLabelText(/内容/) as HTMLTextAreaElement).value).toBe(
      '出力の列を選べるようにしてほしい（テスト）',
    );
  });
});
