import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  usePathname: () => '/enterprise/data',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { PageActions } = await import('@/components/shared/page-actions');
const { RowActions } = await import('@/components/shared/row-actions');
const { MAX_SECONDARY_ACTIONS, orderMenuItems, splitPageActions } =
  await import('@/lib/ui/actions');

/**
 * 見出しの操作（plan §1.6・§3.5 page-actions）。primary 1・secondary ≤2・残りは「その他」。
 * hidden は描かない、押せない理由は読み上げにも届く。
 */

const noop = vi.fn();

function link(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { kind: 'link' as const, id, label, href: `/x/${id}`, ...extra };
}

describe('splitPageActions（振り分けの規則）', () => {
  it('secondary は 2 つまで。3 つ目以降は「その他」の先頭（日常の群）へ送る', () => {
    const split = splitPageActions({
      primary: link('p', '提出'),
      secondary: [link('a', 'A'), link('b', 'B'), link('c', 'C'), link('d', 'D')],
      more: [{ ...link('csv', 'CSV 出力'), group: 'export' }],
    });
    expect(MAX_SECONDARY_ACTIONS).toBe(2);
    expect(split.primary?.id).toBe('p');
    expect(split.secondary.map((a) => a.id)).toEqual(['a', 'b']);
    expect(split.more.map((a) => a.id)).toEqual(['c', 'd', 'csv']);
  });

  it('hidden の項目は primary・secondary・その他のどこにも出さない', () => {
    const split = splitPageActions({
      primary: link('p', '承認', { hidden: true }),
      secondary: [link('a', 'A', { hidden: true }), link('b', 'B')],
      more: [{ ...link('x', 'X'), hidden: true }],
    });
    expect(split.primary).toBeNull();
    expect(split.secondary.map((a) => a.id)).toEqual(['b']);
    expect(split.more).toEqual([]);
  });

  it('メニューは 日常 → 出力 → 高度 の順で、破壊的な操作は最後', () => {
    const ordered = orderMenuItems([
      { ...link('reset', 'リセット'), destructive: true },
      { ...link('ai', 'AI'), group: 'advanced' },
      { ...link('csv', 'CSV'), group: 'export' },
      link('copy', '複製'),
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['copy', 'csv', 'ai', 'reset']);
  });
});

describe('PageActions の描画', () => {
  it('見えている primary は 1 つだけで、secondary は 2 つまで、残りは「その他」', () => {
    const { container } = render(
      <PageActions
        primary={{ kind: 'submit', id: 'submit', label: '提出', action: noop }}
        secondary={[link('a', '取込'), link('b', '前年度から複製'), link('c', 'CSV 出力')]}
        more={[{ ...link('ai', 'AI に原因を説明させる'), group: 'advanced' }]}
      />,
    );
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '提出' })).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByRole('link', { name: '取込' })).toHaveAttribute('data-variant', 'secondary');
    expect(screen.getByRole('link', { name: '前年度から複製' })).toBeInTheDocument();
    // 3 つ目の secondary は見出しに出さず、その他へ
    expect(screen.queryByRole('link', { name: 'CSV 出力' })).toBeNull();
    expect(screen.getByRole('button', { name: 'その他' })).toBeInTheDocument();
  });

  it('その他を開くと、あふれた secondary と低頻度の操作が並ぶ', async () => {
    const user = userEvent.setup();
    render(
      <PageActions
        secondary={[link('a', 'A'), link('b', 'B'), link('c', 'CSV 出力')]}
        more={[
          { ...link('ai', 'AI に原因を説明させる'), group: 'advanced' },
          { ...link('reset', 'デモを初期状態に戻す'), destructive: true },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'その他' }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['CSV 出力', 'AI に原因を説明させる', 'デモを初期状態に戻す']);
  });

  it('確認ダイアログが開く項目は「…」を付ける（ラベルが既に「…」で終わっていれば重ねない）', async () => {
    const user = userEvent.setup();
    const confirm = {
      tier: 'bulk' as const,
      title: '差し戻しますか',
      scope: '対象: 1 件',
      confirmLabel: '差し戻す',
    };
    render(
      <PageActions
        more={[
          { kind: 'confirm', id: 'archive', label: 'アーカイブ', action: noop, confirm },
          { kind: 'confirm', id: 'return', label: '差戻し…', action: noop, confirm },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'その他' }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['アーカイブ…', '差戻し…']);
  });

  it('押せない操作は押せないボタンとして残し、理由を読み上げにも届ける', () => {
    render(
      <PageActions
        primary={{
          kind: 'submit',
          id: 'submit',
          label: '提出',
          action: noop,
          disabledReason: '値を入力してから提出できます',
        }}
      />,
    );
    const button = screen.getByRole('button', { name: '提出' });
    // 押せない（aria-disabled。フォーカスは受けて理由を読み上げる）。送信のフォームも描かない
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('type', 'submit');
    expect(button.closest('form')).toBeNull();
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('値を入力してから提出できます');
  });

  it('操作が 1 つも無ければ何も描かない', () => {
    const { container } = render(<PageActions primary={link('p', 'P', { hidden: true })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RowActions', () => {
  it('行の主な操作は secondary（行ごとに primary を繰り返さない）、メニューは行の名前付き', () => {
    const { container } = render(
      <RowActions
        rowLabel="東日本工場 電力使用量"
        primary={link('fix', '直す')}
        items={[link('history', '履歴')]}
      />,
    );
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: '直す' })).toHaveAttribute('data-size', 'xs');
    const trigger = screen.getByRole('button', { name: '東日本工場 電力使用量 の操作' });
    expect(within(trigger).getByText('操作')).toBeInTheDocument();
  });
});
