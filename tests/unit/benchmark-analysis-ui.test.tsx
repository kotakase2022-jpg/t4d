import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AssuranceNote,
  ComparabilityBadge,
  DemoBenchmarkBanner,
  DiagnosisStateBadge,
  PositioningBadge,
  UndisclosedBadge,
} from '@/app/enterprise/analysis/_components/analysis-badges';
import { DiagnosisAreaSection } from '@/app/enterprise/analysis/_components/diagnosis-area';
import { DEMO_BENCHMARK_NOTICE } from '@/lib/domain/benchmark';
import {
  DIAGNOSIS_STATES,
  DIAGNOSIS_STATE_LABEL,
  type DiagnosisArea,
} from '@/lib/services/analysis/diagnosis';

/**
 * 分析の画面部品（docs/disclosure-first.md §9.5・§9.6）。
 *  - 状態は色だけで表さない: どのバッジもラベル（文字）とアイコン（svg、読み上げない）を持つ
 *  - 現状診断の領域は「n / 分母 単位」で示し、割合・点数を出さない。直す画面へのリンクを置く
 *  - 他社比較の先頭には「架空の比較データ（デモ用）」の文言
 */

function expectLabelAndIcon(container: HTMLElement, label: string): void {
  expect(container.textContent).toContain(label);
  const icons = container.querySelectorAll('svg');
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
}

describe('分析のバッジ', () => {
  it('現状診断の 4 つの状態はラベルとアイコンを持つ', () => {
    for (const state of DIAGNOSIS_STATES) {
      const { container } = render(
        <DiagnosisStateBadge state={state} label={DIAGNOSIS_STATE_LABEL[state]} />,
      );
      expectLabelAndIcon(container, DIAGNOSIS_STATE_LABEL[state]);
    }
    expect(Object.values(DIAGNOSIS_STATE_LABEL)).toEqual([
      '不足あり',
      '確認待ちあり',
      '不足なし',
      '算定対象外',
    ]);
  });

  it('基準の位置付けはラベルとアイコンを持つ', () => {
    for (const [kind, label] of [
      ['published', '公表済み'],
      ['draft_prep', '公開草案に基づく準備'],
      ['sample', 'サンプル（架空）'],
      ['planned', '今後対応予定'],
      ['other', '採択済み（未発効）'],
    ] as const) {
      const { container } = render(<PositioningBadge kind={kind} label={label} />);
      expectLabelAndIcon(container, label);
    }
  });

  it('比較の可否・未開示・保証の有無はラベルとアイコンを持つ（良し悪しの文言は使わない）', () => {
    expectLabelAndIcon(render(<ComparabilityBadge comparable />).container, '比較可');
    expectLabelAndIcon(render(<ComparabilityBadge comparable={false} />).container, '比較対象外');
    expectLabelAndIcon(render(<UndisclosedBadge />).container, '未開示');
    expectLabelAndIcon(render(<AssuranceNote assured />).container, '保証あり');
    expectLabelAndIcon(render(<AssuranceNote assured={false} />).container, '保証なし');
  });

  it('架空の比較データであることを先頭に示す', () => {
    render(<DemoBenchmarkBanner />);
    const note = screen.getByRole('note', { name: '比較データについて' });
    expect(note.textContent).toContain(DEMO_BENCHMARK_NOTICE);
    expect(note.textContent).toContain('架空の会社');
  });
});

describe('現状診断の領域', () => {
  const area: DiagnosisArea = {
    key: 'collection',
    title: 'データ収集・承認',
    source: 'ホーム（ダッシュボード）と同じ集計',
    state: 'gap',
    stateLabel: '不足あり',
    stateReason: '未提出 3 件があります（10 件中）。',
    facts: [
      {
        key: 'approved',
        label: '承認済み',
        count: 5,
        denominator: 10,
        denominatorLabel: 'FY2026 の Data Point 総数',
        unitLabel: '件',
        text: null,
        href: '/enterprise/data?status=approved',
        attention: null,
      },
      {
        key: 'not_submitted',
        label: '未提出（未着手・入力中）',
        count: 3,
        denominator: 10,
        denominatorLabel: 'FY2026 の Data Point 総数',
        unitLabel: '件',
        text: null,
        href: '/enterprise/data?status=not_started&status=draft',
        attention: 'gap',
      },
      {
        key: 'scope3_total',
        label: 'Scope3 合計',
        count: null,
        denominator: null,
        denominatorLabel: null,
        unitLabel: '件',
        text: '未算定',
        href: '/enterprise/ghg',
        attention: null,
      },
    ],
    links: [{ label: '非財務データの一覧', href: '/enterprise/data' }],
    units: [
      {
        unitId: 'u1',
        unitName: '本社',
        approved: 2,
        total: 4,
        notSubmitted: 1,
        reviewPending: 1,
        validationErrors: 0,
        href: '/enterprise/data?unit=u1',
      },
    ],
  };

  it('見出しで名前の付いた領域に、状態・理由・出所・n / 分母・直す画面を示す', () => {
    render(<DiagnosisAreaSection area={area} />);
    const region = screen.getByRole('region', { name: 'データ収集・承認' });
    const r = within(region);
    expect(r.getByText('不足あり')).toBeTruthy();
    expect(r.getByText('未提出 3 件があります（10 件中）。')).toBeTruthy();
    expect(r.getByText(/^出所: /)).toBeTruthy();
    expect(r.getByText('5 / 10 件')).toBeTruthy();
    expect(r.getByText('3 / 10 件')).toBeTruthy();
    expect(r.getAllByText('分母: FY2026 の Data Point 総数')).toHaveLength(2);
    // 値の無い事実は 0 ではなく表示文言（未算定）
    expect(r.getByText('未算定')).toBeTruthy();
    // 不足の根拠になっている事実には「要対応」（ラベル＋アイコン）
    expect(r.getAllByText('要対応')).toHaveLength(1);
    // 事実ごとの一覧と、領域の直す画面へのリンク
    expect(r.getByRole('link', { name: '承認済み' }).getAttribute('href')).toBe(
      '/enterprise/data?status=approved',
    );
    const fixNav = r.getByRole('navigation', { name: 'データ収集・承認を直す画面' });
    expect(within(fixNav).getByRole('link', { name: '非財務データの一覧' })).toBeTruthy();
    // 拠点別の表
    expect(r.getByRole('table', { name: /拠点別の承認状況/ })).toBeTruthy();
    expect(r.getByText('2 / 4 件')).toBeTruthy();
    // 割合・点数・準拠率を出さない
    expect(region.textContent).not.toMatch(/\d\s*%/);
    expect(region.textContent).not.toContain('準拠率');
  });
});
