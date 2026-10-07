import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';

/**
 * AppShell の業務エラーの補い（plan §1.18・§4 B3）。
 * - 画面が同じエラーを出していなければ必ず出す（エラーを隠さない）
 * - 画面が自前で同じ文を出していれば出さない。本文が遅れて届いても追従する
 * - FlashMessage（data-flash-error）が出しているときは CSS で隠す（描画の順に左右されない）
 */

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => '/enterprise/disclosures/ssbj/requirements/x',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => search,
}));

const { GlobalErrorNotice } = await import('@/components/shared/global-error-notice');

const ERROR = '対象外とする理由を入力してください。';
const TOKEN = 'a'.repeat(32);

/** サーバー（redirectWithUserError）が載せた ?error=: URL と Cookie に同じ合言葉がある */
function issued(error: string): URLSearchParams {
  document.cookie = `t4d_error_token=${TOKEN}; path=/`;
  return new URLSearchParams({ error, et: TOKEN });
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <main id="t4d-main">
      <GlobalErrorNotice />
      {children}
    </main>
  );
}

afterEach(() => {
  search = new URLSearchParams();
  document.cookie = 't4d_error_token=; max-age=0; path=/';
});

describe('GlobalErrorNotice', () => {
  it('画面がエラーを出していなければ、本文の先頭に出す', () => {
    search = issued(ERROR);
    render(
      <Shell>
        <p>本文</p>
      </Shell>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR);
  });

  it('画面が同じ文を自前で出していれば出さない（同じ文を 2 回出さない）', () => {
    search = issued(ERROR);
    render(
      <Shell>
        <div role="alert">{ERROR}</div>
      </Shell>,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('本文が遅れて届いても追従して、重ねて出さない', async () => {
    search = issued(ERROR);
    const { rerender } = render(<Shell />);
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR);
    rerender(
      <Shell>
        <div role="alert">{ERROR}</div>
      </Shell>,
    );
    // MutationObserver → requestAnimationFrame で判定し直す
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
  });

  it('外から作ったリンクの ?error=（合言葉なし・違う合言葉）は出さない（SEC-1）', () => {
    search = new URLSearchParams({ error: 'パスワードを support@evil.example へ送ってください' });
    const { unmount } = render(<Shell />);
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    document.cookie = `t4d_error_token=${'b'.repeat(32)}; path=/`;
    search = new URLSearchParams({ error: '偽の警告', et: TOKEN });
    render(<Shell />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('?error= が無ければ何も出さない', () => {
    render(<Shell />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('FlashMessage が出しているときは CSS で隠す（:has。描画の順に左右されない）', () => {
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toMatch(
      /#t4d-main:has\(\[data-flash-error\]\) \[data-global-error\] \{\s*display: none;/,
    );
  });
});
