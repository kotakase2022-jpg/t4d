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
import {
  BenchmarkRange,
  BenchmarkRangeLegend,
  benchmarkRangeLayout,
} from '@/app/enterprise/analysis/_components/benchmark-range';
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
    // 分母が同じ事実は「分母:」を事実ごとに繰り返さず、一覧の下に 1 回だけ書く（§10.4 文字を減らす）
    expect(r.getAllByText('分母: FY2026 の Data Point 総数')).toHaveLength(1);
    // 値の無い事実は 0 ではなく表示文言（未算定）
    expect(r.getByText('未算定')).toBeTruthy();
    // 不足の根拠になっている事実には「要対応」（ラベル＋アイコン）
    expect(r.getAllByText('要対応')).toHaveLength(1);
    // 事実ごとの一覧と、領域の直す画面へのリンク（リンクの名前は表示の「見る」と事実の名前）
    expect(r.getByRole('link', { name: '承認済みを見る' }).getAttribute('href')).toBe(
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

  it('件数の事実は帯（role=img・名前に n / 分母）を添え、値の無い事実は帯にしない', () => {
    render(<DiagnosisAreaSection area={area} />);
    const r = within(screen.getByRole('region', { name: 'データ収集・承認' }));
    const bars = r.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
    expect(bars).toEqual(['承認済み: 5 / 10 件', '未提出（未着手・入力中）: 3 / 10 件']);
    // 未算定（件数なし）の事実は 0 の帯を描かない
    expect(bars.some((label) => label?.startsWith('Scope3 合計'))).toBe(false);
  });

  it('出所と拠点別の表は既定で閉じ、状態・理由・件数・分母は閉じない', () => {
    render(<DiagnosisAreaSection area={area} />);
    const r = within(screen.getByRole('region', { name: 'データ収集・承認' }));
    expect(r.getByText(/^出所: /).closest('details')?.open).toBe(false);
    expect(r.getByRole('table', { name: /拠点別の承認状況/ }).closest('details')?.open).toBe(false);
    expect(r.getByText('拠点別の承認状況（1 拠点）')).toBeTruthy();
    for (const text of [
      '不足あり',
      '未提出 3 件があります（10 件中）。',
      '5 / 10 件',
      '3 / 10 件',
      '分母: FY2026 の Data Point 総数',
      '未算定',
    ]) {
      expect(r.getByText(text).closest('details'), text).toBeNull();
    }
  });

  it('分母が事実ごとに違うときは、事実ごとに「分母:」を書く', () => {
    const mixed: DiagnosisArea = {
      ...area,
      key: 'evidence',
      title: '証跡・承認の健全性',
      units: undefined,
      facts: [
        {
          ...area.facts[0]!,
          key: 'a',
          label: '証跡不足',
          denominatorLabel: '承認済みの Data Point',
        },
        {
          ...area.facts[1]!,
          key: 'b',
          label: '期限超過のタスク',
          denominatorLabel: '未完了のタスク（全期間）',
        },
      ],
    };
    render(<DiagnosisAreaSection area={mixed} />);
    const r = within(screen.getByRole('region', { name: '証跡・承認の健全性' }));
    expect(r.getAllByText('分母: 承認済みの Data Point')).toHaveLength(1);
    expect(r.getAllByText('分母: 未完了のタスク（全期間）')).toHaveLength(1);
  });

  it('GHG の領域: Scope1・2 は表の「n / N 拠点」で示し（帯を重ねない）、Scope3 は 15 カテゴリの格子', () => {
    const ghgArea: DiagnosisArea = {
      key: 'ghg',
      title: 'GHG 算定の網羅性',
      source: 'GHG 画面と同じ集計',
      state: 'gap',
      stateLabel: '不足あり',
      stateReason: 'Scope1 承認済み 3/4 拠点。',
      facts: [
        {
          key: 'scope1',
          label: 'Scope1 承認済みの拠点',
          count: 3,
          denominator: 4,
          denominatorLabel: '連結対象の拠点（持分法・連結対象外を除く）',
          unitLabel: '拠点',
          text: null,
          href: '/enterprise/data?metric=m1',
          attention: null,
        },
        {
          key: 'scope3_categories',
          label: 'Scope3 値か対象外判断のあるカテゴリ',
          count: 2,
          denominator: 15,
          denominatorLabel: 'Scope3 のカテゴリ（1〜15）',
          unitLabel: 'カテゴリ',
          text: null,
          href: '/enterprise/ghg',
          attention: null,
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
      links: [{ label: 'GHG', href: '/enterprise/ghg' }],
      ghg: [
        {
          code: 'scope1',
          label: 'Scope1',
          registered: true,
          approvedUnits: 3,
          expectedUnits: 4,
          reviewUnits: ['西日本工場'],
          unsubmittedUnits: [],
          missingUnits: [],
          noActualUnits: [],
          href: '/enterprise/data?metric=m1',
        },
      ],
      scope3: {
        categoryTotal: 15,
        presentCount: 1,
        notApplicableCount: 1,
        pendingCount: 13,
        pendingLabels: Array.from({ length: 13 }, (_, i) => `Cat.${i + 3}`),
        totalValue: null,
        unitOfMeasure: 't-CO2e',
      },
    };
    render(<DiagnosisAreaSection area={ghgArea} />);
    const r = within(screen.getByRole('region', { name: 'GHG 算定の網羅性' }));
    // Scope1 の拠点数は表の 1 か所だけ（同じ事実の帯を重ねない）
    expect(r.getAllByText('3 / 4 拠点')).toHaveLength(1);
    expect(r.getByText('3 / 4 拠点').closest('table')).not.toBeNull();
    expect(r.getByText('2 / 15 カテゴリ')).toBeTruthy();
    expect(r.getByText('未算定')).toBeTruthy();
    // 15 カテゴリの格子: 状態は文字（未登録・未算定は破線の枠）。値と対象外が混ざるときは言い切らない
    const grid = r.getByRole('list', { name: 'Scope3 のカテゴリ（1〜15）の登録状況' });
    const cells = within(grid).getAllByRole('listitem');
    expect(cells).toHaveLength(15);
    expect(cells[0]?.textContent).toContain('Cat.1');
    expect(cells[0]?.textContent).toContain('値か対象外判断あり');
    expect(cells[0]?.getAttribute('data-filled')).toBe('true');
    expect(cells[2]?.textContent).toContain('未登録・未算定');
    expect(cells[2]?.getAttribute('data-filled')).toBe('false');
    // 値の無いカテゴリに 0 を書かない
    expect(grid.textContent).not.toMatch(/(^|[^.\d])0([^.\d]|$)/);
  });
});

describe('他社比較の範囲帯', () => {
  it('比較できる社の最小〜最大を帯、自社と中央値を枠の内側に置く（並べ替えない）', () => {
    const layout = benchmarkRangeLayout({
      peerValues: [12_400, 9_760, 15_300],
      median: 12_400,
      own: 8_931.6,
    });
    expect(layout).not.toBeNull();
    const { bandStart, bandEnd, peers, median, own } = layout!;
    expect(bandStart).toBeLessThan(bandEnd);
    // 入力の順のまま（値で並べ替えない）
    expect(peers[0]).toBeGreaterThan(peers[1]!);
    expect(peers[2]).toBeCloseTo(bandEnd, 5);
    expect(peers[1]).toBeCloseTo(bandStart, 5);
    for (const x of [...peers, median!, own!]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(120);
    }
    // 自社は帯の外（最小より小さい）でも枠の内側
    expect(own!).toBeLessThan(bandStart);
  });

  it('比較できる社が無ければ描かない。自社・中央値が無ければ印を置かない', () => {
    expect(benchmarkRangeLayout({ peerValues: [], median: null, own: 100 })).toBeNull();
    const single = benchmarkRangeLayout({ peerValues: [50], median: null, own: null });
    expect(single?.median).toBeNull();
    expect(single?.own).toBeNull();
    // 値が 1 つでも帯の中央に描く（幅 0 で消えない）
    expect(single?.peers[0]).toBeCloseTo(60, 5);
  });

  it('図は装飾（数値は同じ行のセルに文字で書く）。凡例は印の意味を文字で書く', () => {
    const { container } = render(<BenchmarkRange peerValues={[1, 2, 3]} median={2} own={2.5} />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    render(<BenchmarkRangeLegend />);
    const legend = screen.getByRole('list', { name: '範囲の図の見方' });
    expect(legend.textContent).toContain('比較できる社の最小〜最大');
    expect(legend.textContent).toContain('中央値');
    expect(legend.textContent).toContain('自社の確定値');
    expect(legend.textContent).toContain('並べ替え・順位付けはしません');
  });
});
