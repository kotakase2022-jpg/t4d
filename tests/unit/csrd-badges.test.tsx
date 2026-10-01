import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ApplicabilityBadge,
  CsrdDataStateBadge,
  DmaOutcomeBadge,
  PerspectiveBadges,
  ProvisionalBadge,
  SampleMasterBadge,
} from '@/app/enterprise/disclosures/csrd/_components/csrd-badges';
import type { CsrdDataState } from '@/lib/domain/csrd';
import { DMA_OUTCOMES } from '@/types/domain';

/**
 * CSRD のバッジ（docs/disclosure-first.md §9.4）。色だけで状態を表さない（CLAUDE.md §2）:
 * どのバッジもラベル（文字）とアイコン（svg）の両方を持ち、アイコンは読み上げない。
 */

function expectLabelAndIcon(container: HTMLElement, label: string): void {
  expect(container.textContent).toContain(label);
  const icons = container.querySelectorAll('svg');
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
}

describe('CSRD のバッジ', () => {
  it('事項の結果はすべてラベルとアイコンを持つ', () => {
    const labels: Record<string, string> = {
      both: '両面で重要',
      impact_only: 'インパクトのみ',
      financial_only: '財務のみ',
      not_material: '重要でない',
      not_assessed: '未評価',
    };
    for (const outcome of DMA_OUTCOMES) {
      const { container } = render(<DmaOutcomeBadge outcome={outcome} />);
      expectLabelAndIcon(container, labels[outcome]!);
    }
  });

  it('適用のバッジは観点を表示し、暫定のときは「暫定（DMA 確定前）」を併記する', () => {
    const material = render(
      <ApplicabilityBadge
        applicability={{ kind: 'material', perspectives: ['financial'], provisional: true }}
      />,
    );
    expectLabelAndIcon(material.container, '適用（財務）');
    expect(material.container.textContent).toContain('暫定（DMA 確定前）');

    const always = render(
      <ApplicabilityBadge
        applicability={{ kind: 'always', perspectives: [], provisional: false }}
      />,
    );
    expectLabelAndIcon(always.container, 'ESRS 2（常に適用）');
    expect(always.container.textContent).not.toContain('暫定');

    for (const [kind, label] of [
      ['not_material', '対象外（重要でない）'],
      ['undetermined', '未判定'],
    ] as const) {
      const { container } = render(
        <ApplicabilityBadge applicability={{ kind, perspectives: [], provisional: false }} />,
      );
      expectLabelAndIcon(container, label);
    }
  });

  it('観点・暫定・サンプルのバッジ', () => {
    const perspectives = render(<PerspectiveBadges perspectives={['impact', 'financial']} />);
    expectLabelAndIcon(perspectives.container, 'インパクト');
    expect(perspectives.container.textContent).toContain('財務');
    expect(render(<PerspectiveBadges perspectives={[]} />).container.textContent).toBe('');
    expectLabelAndIcon(render(<ProvisionalBadge />).container, '暫定（DMA 確定前）');
    expectLabelAndIcon(render(<SampleMasterBadge />).container, 'サンプル（架空）');
  });
});

describe('CSRD のデータ収集の状況バッジ（要求事項の詳細と収集画面で共通）', () => {
  it('4 つの状況すべてがラベルとアイコンを持ち、状況ごとにアイコンが異なる', () => {
    const labels: Record<CsrdDataState, string> = {
      approved: '承認済み',
      in_review: 'レビュー中',
      awaiting_submission: '提出待ち',
      not_entered: '未入力',
    };
    const iconClasses = new Set<string>();
    for (const state of Object.keys(labels) as CsrdDataState[]) {
      const { container } = render(<CsrdDataStateBadge state={state} />);
      expectLabelAndIcon(container, labels[state]);
      iconClasses.add(container.querySelector('svg')!.getAttribute('class') ?? '');
    }
    // 色だけで区別しない: アイコン（lucide のクラス名）も 4 種類ある
    expect(iconClasses.size).toBe(4);
  });
});
