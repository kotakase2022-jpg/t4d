import { render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Collapsible, CollapsibleSection } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { PageHeader } from '@/components/shared/page-header';

/**
 * 既定で閉じる折りたたみ（docs/disclosure-first.md §10.4）。
 *
 * - ネイティブの details／summary。JavaScript なし（Server Component の HTML だけ）で開閉できる
 * - 既定は閉じる。open（URL の絞込・フラッシュ・エラーが中身を指すとき）・defaultOpen で開いて描く
 * - 開閉の印は自分の summary の直上の details だけを見る（入れ子で外側が開いても内側は「開く」のまま）
 * - CollapsibleSection の見出し（h2）と主操作は details の外（閉じていても見え、押せる）
 *
 * 単体テスト（happy-dom）での閉じた details の中身の扱いもここで固定する:
 * 中身は DOM にあり getByText・within で見つかる（可視性に頼らずに中身を確かめられる）。
 * 一方 jest-dom の toBeVisible は閉じた details の中身を「見えない」と判定する（ブラウザと同じ）。
 */

describe('Collapsible', () => {
  it('既定は閉じた details。summary に要点の 1 行と「開く／閉じる」の印、中身は DOM にある', () => {
    const { container } = render(
      <Collapsible summary="比較の決まり（6 項目）" meta="確定値のみ">
        <p>推計・目標・途中合計は比べません</p>
      </Collapsible>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.hasAttribute('open')).toBe(false);
    const summary = container.querySelector('summary');
    expect(summary?.querySelector('[data-collapsible-summary]')?.textContent).toBe(
      '比較の決まり（6 項目）',
    );
    expect(summary?.textContent).toContain('確定値のみ');
    expect(summary?.textContent).toContain('開く');
    // 閉じていても中身は DOM にある（getByText・within で確かめられる）
    expect(screen.getByText('推計・目標・途中合計は比べません')).toBeInTheDocument();
    expect(within(details!).getByText('推計・目標・途中合計は比べません')).toBeInTheDocument();
  });

  it('happy-dom でも、閉じた details の中身は toBeVisible で「見えない」、開くと「見える」', () => {
    const { container, rerender } = render(
      <Collapsible summary="内訳">
        <p>中身の文</p>
      </Collapsible>,
    );
    expect(screen.getByText('中身の文')).not.toBeVisible();
    // summary は閉じていても見える
    expect(container.querySelector('summary')).toBeVisible();
    rerender(
      <Collapsible summary="内訳" open>
        <p>中身の文</p>
      </Collapsible>,
    );
    expect(screen.getByText('中身の文')).toBeVisible();
  });

  it('happy-dom の getByRole は閉じた details の中身も見つける（ブラウザの E2E とは違う。開閉の確認には使わない）', () => {
    const { container } = render(
      <Collapsible summary="内訳">
        <a href="#all-metrics">全指標</a>
        <h3>年度ごとの承認状況</h3>
      </Collapsible>,
    );
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.getByRole('link', { name: '全指標' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '年度ごとの承認状況' })).toBeInTheDocument();
  });

  it('defaultOpen・open で開いて描く（open は defaultOpen より優先）', () => {
    const html = (node: React.ReactElement) => renderToStaticMarkup(node);
    expect(html(<Collapsible summary="a">x</Collapsible>)).not.toMatch(/<details[^>]* open/);
    expect(
      html(
        <Collapsible summary="a" defaultOpen>
          x
        </Collapsible>,
      ),
    ).toMatch(/<details[^>]* open=""/);
    expect(
      html(
        <Collapsible summary="a" open>
          x
        </Collapsible>,
      ),
    ).toMatch(/<details[^>]* open=""/);
    expect(
      html(
        <Collapsible summary="a" defaultOpen open={false}>
          x
        </Collapsible>,
      ),
    ).not.toMatch(/<details[^>]* open/);
  });

  it('サーバーの HTML だけで開閉できる（details／summary。ボタンやスクリプトに頼らない）', () => {
    const markup = renderToStaticMarkup(
      <Collapsible summary="比較の決まり" id="rules">
        <p>本文</p>
      </Collapsible>,
    );
    expect(markup).toMatch(/^<details id="rules"/);
    expect(markup).toContain('<summary');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<script');
  });

  it('開閉の印は自分の summary の直上の details だけを見る（group-open を使わない）', () => {
    const { container } = render(
      <Collapsible summary="外側" open>
        <Collapsible summary="内側">内側の本文</Collapsible>
      </Collapsible>,
    );
    const markers = [...container.querySelectorAll('summary')].map((summary) =>
      [...summary.querySelectorAll('[class]')].map((el) => el.getAttribute('class') ?? ''),
    );
    for (const classes of markers) {
      expect(classes.some((c) => c.includes('[details[open]>summary_&]:rotate-90'))).toBe(true);
      expect(classes.some((c) => c.includes('[details[open]>summary_&]:hidden'))).toBe(true);
      expect(classes.some((c) => c.includes('[details[open]>summary_&]:inline'))).toBe(true);
      expect(classes.some((c) => /\bgroup-open:/.test(c))).toBe(false);
    }
    const [outer, inner] = [...container.querySelectorAll('details')];
    expect(outer?.open).toBe(true);
    expect(inner?.open).toBe(false);
    // シェブロンは装飾（summary の文字が名前）
    expect(container.querySelector('summary svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('summary の既定の三角を消し、フォーカスリングを消さない（outline-none を付けない）', () => {
    const { container } = render(<Collapsible summary="a">x</Collapsible>);
    const summaryClass = container.querySelector('summary')?.getAttribute('class') ?? '';
    expect(summaryClass).toContain('list-none');
    expect(summaryClass).toContain('[&::-webkit-details-marker]:hidden');
    expect(summaryClass).not.toMatch(/outline-none|outline-0/);
  });

  it('variant: card は枠付き、plain は枠なし', () => {
    const card = render(<Collapsible summary="a">x</Collapsible>).container.querySelector(
      'details',
    );
    expect(card?.getAttribute('class')).toContain('border');
    const plain = render(
      <Collapsible summary="b" variant="plain">
        y
      </Collapsible>,
    ).container.querySelector('details');
    expect(plain?.getAttribute('class') ?? '').not.toContain('border');
  });
});

describe('CollapsibleSection', () => {
  it('見出し（h2）と主操作は details の外にあり、節は見出しの名前の region になる', () => {
    const { container } = render(
      <CollapsibleSection
        id="peer-table"
        title="ピアの一覧"
        summary="5 社（すべて架空）"
        actions={<a href="/x">CSV</a>}
      >
        <p>表の本文</p>
      </CollapsibleSection>,
    );
    const region = screen.getByRole('region', { name: 'ピアの一覧' });
    expect(region).toHaveAttribute('id', 'peer-table');
    const heading = screen.getByRole('heading', { level: 2, name: 'ピアの一覧' });
    expect(heading.closest('details')).toBeNull();
    expect(screen.getByRole('link', { name: 'CSV' }).closest('details')).toBeNull();
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.getByText('表の本文').closest('details')).not.toBeNull();
    expect(container.querySelector('summary')?.textContent).toContain('5 社（すべて架空）');
  });

  it('open で開いて描く', () => {
    const { container } = render(
      <CollapsibleSection id="s" title="題" summary="要点" open>
        本文
      </CollapsibleSection>,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });
});

describe('MoreInfo・PageHeader.help', () => {
  it('MoreInfo は Info アイコン＋label の小さな details（既定で閉じる）', () => {
    const { container } = render(
      <MoreInfo label="件数の数え方">
        <p>評価対象だけを数えます</p>
      </MoreInfo>,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    const summary = container.querySelector('summary');
    expect(summary?.textContent).toBe('件数の数え方');
    expect(summary?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('評価対象だけを数えます').closest('details')).toBe(details);
  });

  it('PageHeader の help は description の下の「この画面について」（閉じる）。h1 と description は外', () => {
    const { container } = render(
      <PageHeader
        title="自社経年比較"
        description="直近 3 年度の確定値を指標ごとに並べます"
        help={<p>年度はヘッダーで切り替えます</p>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: '自社経年比較' })).toBeInTheDocument();
    expect(
      screen.getByText('直近 3 年度の確定値を指標ごとに並べます').closest('details'),
    ).toBeNull();
    const details = container.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('この画面について');
    expect(details?.open).toBe(false);
    expect(screen.getByText('年度はヘッダーで切り替えます').closest('details')).toBe(details);
  });

  it('help が無ければ「この画面について」を出さない（既存の画面は変わらない）', () => {
    const { container } = render(<PageHeader title="現状診断" description="説明" />);
    expect(container.querySelector('details')).toBeNull();
  });
});
