import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

/**
 * 危険な操作の確認（plan §1.16・§3.5 confirm-dialog）。
 * 範囲 1 行は常に見える、理由・必須チェックはブラウザの必須で止める、確定ボタンはダイアログの唯一の主操作。
 */

const action = vi.fn();

describe('ConfirmDialog', () => {
  it('取り消せない操作: 範囲 1 行を本文に出し、必須チェックがあり、確定は danger の 1 つだけ', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        tier="irreversible"
        title="開示デモを初期状態に戻しますか"
        scope="戻す範囲: 開示業務と CSRD の設定・評価・計画・草案"
        consequences={['デモ中に作った行は削除します']}
        acknowledge={{
          name: 'confirmScope',
          label: '上記の範囲だけを初期状態へ戻すことを確認しました',
        }}
        confirmLabel="開示デモを初期状態に戻す"
        action={action}
        trigger={{ label: '開示デモを初期状態に戻す…' }}
      />,
    );
    // 開くまではダイアログが無い
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: '開示デモを初期状態に戻す…' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('戻す範囲: 開示業務と CSRD の設定・評価・計画・草案'),
    ).toBeVisible();
    expect(within(dialog).getByText('デモ中に作った行は削除します')).toBeVisible();
    const ack = within(dialog).getByLabelText('上記の範囲だけを初期状態へ戻すことを確認しました');
    expect(ack).toBeRequired();
    expect(ack).toHaveAttribute('name', 'confirmScope');
    const submit = within(dialog).getByRole('button', { name: '開示デモを初期状態に戻す' });
    expect(submit).toHaveAttribute('type', 'submit');
    expect(submit).toHaveAttribute('data-variant', 'danger');
    expect(
      dialog.querySelectorAll('[data-variant="primary"], [data-variant="danger"]'),
    ).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toHaveAttribute(
      'data-variant',
      'ghost',
    );
  });

  it('差戻し: 理由は必須（ラベルに「必須」の文字）、隠し項目を送る', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        tier="bulk"
        title="このデータを差し戻しますか"
        scope="電力使用量 — 東日本工場"
        reason={{ name: 'comment', label: '差戻し理由', required: true }}
        confirmLabel="差し戻す"
        action={action}
        fields={{ dataPointId: 'dp-1', to: 'returned' }}
        trigger={{ label: '差戻し' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '差戻し' }));
    const dialog = screen.getByRole('dialog');
    const reason = within(dialog).getByLabelText(/差戻し理由/);
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('name', 'comment');
    expect(within(dialog).getByText('（必須）')).toBeInTheDocument();
    const hidden = [...dialog.querySelectorAll('input[type="hidden"]')].map((el) => [
      el.getAttribute('name'),
      el.getAttribute('value'),
    ]);
    expect(hidden).toEqual([
      ['dataPointId', 'dp-1'],
      ['to', 'returned'],
    ]);
    // bulk は破壊的ではないので確定は primary
    expect(within(dialog).getByRole('button', { name: '差し戻す' })).toHaveAttribute(
      'data-variant',
      'primary',
    );
  });

  it('既存のフォームを送るとき（一括操作）は、理由欄と確定ボタンがそのフォームに属する', () => {
    render(
      <ConfirmDialog
        tier="bulk"
        title="選択した 3 件を承認しますか"
        scope="選択した 3 件（レビュー中 3）"
        reason={{ name: 'comment', label: 'コメント', required: false }}
        confirmLabel="一括承認する"
        formId="bulk-form"
        submitter={{ name: 'to', value: 'approved' }}
        multiFields={{ ids: ['a', 'b'] }}
        open
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/コメント/)).toHaveAttribute('form', 'bulk-form');
    const submit = within(dialog).getByRole('button', { name: '一括承認する' });
    expect(submit).toHaveAttribute('form', 'bulk-form');
    expect(submit).toHaveAttribute('name', 'to');
    expect(submit).toHaveAttribute('value', 'approved');
    expect(
      [...dialog.querySelectorAll('input[name="ids"]')].map((el) => el.getAttribute('form')),
    ).toEqual(['bulk-form', 'bulk-form']);
    // 範囲は閉じた中に入れず、常に見える
    expect(within(dialog).getByText('選択した 3 件（レビュー中 3）')).toBeVisible();
  });
});
