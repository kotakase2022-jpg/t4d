import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  EvidenceBadge,
  ImpactNotices,
  ImpactValue,
  ParamNotices,
} from '@/app/enterprise/analysis/financial-impact/_components/impact-badges';
import { ReadyView } from '@/app/enterprise/analysis/financial-impact/_components/ready-view';
import {
  DEMO_BASELINE_NOTICE,
  EVIDENCE_KINDS,
  EVIDENCE_KIND_LABEL,
  FINANCIAL_IMPACT_NOTICE,
  NO_ASSUMPTIONS_NOTICE,
  dataDepthNotice,
} from '@/lib/domain/financial-impact';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  loadFinancialImpact,
  type FinancialImpactReady,
} from '@/lib/services/analysis/financial-impact';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 財務影響分析の画面部品（docs/disclosure-first.md §10.3・§10.4）。
 * サービスの出力（デモの Fixture）をそのまま描き、次を確かめる:
 *  - 誠実さの注記 3 種（試算・架空の前提／前提なし・データの厚み）は折りたたまずに出る
 *  - 図は role="img" と名前を持ち、数値の表がある
 *  - 未定量の経路は理由つきで見え、0 と書かない。根拠の種類はラベル＋アイコン
 *  - シナリオ切替の現在のリンクに aria-current。仮定のフォームは GET で、既定では閉じている
 *  - 権限が無い利用者には定性情報・IRO を出さず、その旨の 1 行を見せる
 *  - 「準拠率」を出さない
 * happy-dom は閉じた details の中身も DOM に持つため、可視性ではなく DOM と open 属性で確かめる。
 */

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

async function loadView(
  options: {
    roleKeys?: RoleKey[];
    source?: 'demo' | 'none';
    params?: Record<string, string>;
    /** ヘッダーの報告期間（既定 FY2026） */
    periodId?: string;
  } = {},
): Promise<FinancialImpactReady> {
  const fixture = createFixtureDb();
  const period = fixture.periods.find((p) => p.id === (options.periodId ?? PERIOD_IDS.fy2026))!;
  const view = await loadFinancialImpact(
    new DemoDbClient(fixture),
    ctxFor('sustainability@demo.local', options.roleKeys ?? ['sustainability_manager']),
    { period, source: options.source ?? 'demo', params: options.params ?? {} },
  );
  if (view.status !== 'ready') throw new Error('ready ではない');
  return view;
}

describe('常に見える注記', () => {
  it('Demo Mode: 試算・架空の財務ベースライン・データの厚みの 3 つ（文言固定）', () => {
    render(<ImpactNotices source="demo" dataDepthYears={2} />);
    const note = screen.getByRole('note', { name: '試算についての注記' });
    expect(note.textContent).toContain(
      '試算（仮定に基づく）。予測・保証ではありません。経路と係数は画面に示した仮定で、相関から因果を推定していません',
    );
    expect(note.textContent).toContain(
      '架空の財務ベースライン・単価（デモ用）。実在企業の数値ではありません',
    );
    expect(note.textContent).toContain('確定データは最長 2 年分のため、統計的な推定は行いません');
    expect(note.closest('details')).toBeNull();
    expect(FINANCIAL_IMPACT_NOTICE).toContain('予測・保証ではありません');
    expect(dataDepthNotice(2)).toBe('確定データは最長 2 年分のため、統計的な推定は行いません');
  });

  it('Supabase モード: 前提が登録されていない旨（架空のベースラインの文言は出さない）', () => {
    render(<ImpactNotices source="none" dataDepthYears={null} />);
    const note = screen.getByRole('note', { name: '試算についての注記' });
    expect(note.textContent).toContain(
      '財務データ・単価の前提が登録されていません。仮定を入力すると試算します',
    );
    expect(note.textContent).toContain(FINANCIAL_IMPACT_NOTICE);
    expect(note.textContent).not.toContain(DEMO_BASELINE_NOTICE);
    expect(NO_ASSUMPTIONS_NOTICE).toContain('前提が登録されていません');
  });

  it('URL の値を既定に戻した通知は status で見せる', () => {
    render(
      <ParamNotices notices={['「炭素価格」の値 -5 は範囲の外のため、既定値に戻しました。']} />,
    );
    expect(screen.getByRole('status').textContent).toContain('範囲の外');
  });
});

describe('影響額と根拠の種類', () => {
  it('影響額は矢印＋符号＋文字（減益・増益）。未定量は 0 と書かない', () => {
    const { container: loss } = render(<ImpactValue value={-17_863_200} />);
    expect(loss.textContent).toContain('−17.9');
    expect(loss.textContent).toContain('減益');
    expect(loss.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const { container: gain } = render(<ImpactValue value={23_251_080} />);
    expect(gain.textContent).toContain('+23.3');
    expect(gain.textContent).toContain('増益');
    const { container: none } = render(<ImpactValue value={null} />);
    expect(none.textContent).toContain('未定量');
    expect(none.textContent).not.toMatch(/\b0\.0\b/);
  });

  it('根拠の種類 4 つはラベルとアイコンを持つ', () => {
    expect(EVIDENCE_KINDS.map((k) => EVIDENCE_KIND_LABEL[k])).toEqual([
      'データに基づく',
      '仮定に依存',
      '未定量',
      '算定対象外',
    ]);
    for (const kind of EVIDENCE_KINDS) {
      const { container } = render(<EvidenceBadge kind={kind} />);
      expect(container.textContent).toContain(EVIDENCE_KIND_LABEL[kind]);
      expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('画面の本体（デモ・現状維持）', () => {
  it('シナリオ切替は 3 リンクで、現在のシナリオに aria-current。他のリンクは仮定を保ったまま sc を変える', async () => {
    const view = await loadView({ params: { a_carbonPriceStart: '2000' } });
    render(<ReadyView view={view} />);
    const nav = screen.getByRole('navigation', { name: 'シナリオ' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['現状維持', '目標達成', 'カスタム']);
    expect(links[0]!.getAttribute('aria-current')).toBe('true');
    expect(links[1]!.getAttribute('aria-current')).toBeNull();
    expect(links[1]!.getAttribute('href')).toBe(
      '/enterprise/analysis/financial-impact?sc=target&a_carbonPriceStart=2000',
    );
  });

  it('要約タイル 3 つに「定量化できた経路のみ（6 / 9 経路）」と FY2030 の値（−40.6 百万円・減益）', async () => {
    const view = await loadView();
    render(<ReadyView view={view} />);
    const annual = screen.getByRole('group', { name: 'FY2030 の年間影響' });
    // P1 −17,863,200 ＋ P6 −22,742,196（採用単価 3%/年の 4 年分）＝ −40,605,396 円
    expect(annual.textContent).toContain('−40.6');
    expect(annual.textContent).toContain('減益');
    expect(annual.textContent).toContain('定量化できた経路のみ（6 / 9 経路）');
    // 架空の営業利益 50 億円に対する比（参考）
    expect(annual.textContent).toContain('−0.8%');
    const cumulative = screen.getByRole('group', { name: '10 年累計（FY2026〜FY2035）' });
    expect(cumulative.textContent).toContain('定量化できた経路のみ（6 / 9 経路）');
    expect(cumulative.textContent).toContain('割引率 5%');
    const avoided = screen.getByRole('group', {
      name: '回避コスト対削減費用（目標達成 − 現状維持）',
    });
    expect(avoided.textContent).toContain('+23.3');
    expect(avoided.textContent).toContain('削減費用（別枠・営業利益に足さない）436.6 百万円');
  });

  it('未定量・無効の経路は理由つきで見える（P7〜P9 は入力待ち、P10 は無効）', async () => {
    const view = await loadView();
    render(<ReadyView view={view} />);
    const list = screen.getByRole('list', { name: '未定量・無効の経路' });
    expect(list.closest('details')).toBeNull();
    const items = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^P7 休業・補償: 未定量（入力待ち: /);
    expect(items[0]).toContain('LTIFR');
    expect(items[1]).toMatch(/^P8 復旧・操業停止: 未定量（入力待ち: /);
    expect(items[2]).toMatch(/^P9 売上増: 未定量（入力待ち: /);
    expect(items[3]).toBe('P10 調達先の炭素コスト転嫁: 無効（算定に含めない）');
  });

  it('図（経路図・年次・累計・感度）は role="img" と名前を持ち、数値の表がある', async () => {
    const view = await loadView();
    const { container } = render(<ReadyView view={view} />);
    const images = screen.getAllByRole('img');
    const names = images.map((img) => img.getAttribute('aria-label') ?? '');
    expect(names.some((n) => n.startsWith('経路図（起点 → 仕組み → 財務項目 → 時間帯'))).toBe(true);
    expect(names.some((n) => n.startsWith('年次の影響（FY2026〜FY2035）'))).toBe(true);
    expect(names.some((n) => n.startsWith('累計の推移（シナリオ別）'))).toBe(true);
    expect(names.some((n) => n.startsWith('感度（数値の仮定を 1 つずつ ±20%'))).toBe(true);
    for (const name of names) expect(name.length).toBeGreaterThan(10);
    // 経路図の名前に P1 の FY2030 の値（帯の太さの元）と未定量が書かれている
    const flow = names.find((n) => n.startsWith('経路図'))!;
    expect(flow).toContain('P1 Scope1 → 化石燃料賦課金の転嫁 → 売上原価 → 中期（〜5 年）');
    expect(flow).toContain('−17.9 百万円');
    expect(flow).toContain('未定量（入力待ち）');
    // 経路図の未定量の帯は破線、資本コストは未定量の節点
    expect(container.querySelectorAll('path[stroke-dasharray="4 3"]').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('資本コスト');
    expect(container.textContent).toContain('資本コスト未定量根拠データなし');
    expect(flow).toContain('資本コストは未定量（根拠データなし）');
    // 図と同じ内容の数値表（既定で閉じる）
    expect(screen.getAllByText('数値を表で見る').length).toBeGreaterThanOrEqual(4);
  });

  it('仮定のフォームは GET で、既定（URL に仮定なし）では閉じている。入力欄にはラベルと単位', async () => {
    const view = await loadView();
    const { container } = render(<ReadyView view={view} />);
    const details = container.querySelector('details#fi-assumptions') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const form = within(details).getByRole('form', { name: '仮定を変えて再計算' });
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/enterprise/analysis/financial-impact');
    const price = within(form).getByLabelText(/^炭素価格（開始年 FY2028）（円\/t）/);
    expect((price as HTMLInputElement).name).toBe('a_carbonPriceStart');
    expect((price as HTMLInputElement).value).toBe('1000');
    expect(within(form).getByRole('button', { name: '再計算' })).toBeTruthy();
    expect(within(form).getByRole('link', { name: '既定に戻す' }).getAttribute('href')).toBe(
      '/enterprise/analysis/financial-impact',
    );
    // 既定で閉じる節（試算表・感度・定性・制度・方法）
    for (const id of [
      'fi-estimates',
      'fi-sensitivity',
      'fi-qualitative',
      'fi-institutions',
      'fi-method',
    ]) {
      const section = container.querySelector(`details#${id}`) as HTMLDetailsElement | null;
      expect(section, id).not.toBeNull();
      expect(section!.open, id).toBe(false);
    }
  });

  it('URL に仮定があれば「仮定を変える」を開いて描き、値を入力欄に戻す', async () => {
    const view = await loadView({ params: { sc: 'custom', r_energy: '5' } });
    const { container } = render(<ReadyView view={view} />);
    const details = container.querySelector('details#fi-assumptions') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect((container.querySelector('input[name="r_energy"]') as HTMLInputElement).value).toBe('5');
    // カスタムの年率で P3 が効き、累計の線にカスタムが加わる
    expect(screen.getByRole('navigation', { name: 'シナリオ' }).textContent).toContain('カスタム');
    expect(container.textContent).toContain('エネルギー使用量 5%/年');
  });

  it('定性情報・IRO は円にしない（IRO の格子・財務的影響の理由）。準拠率は出さない', async () => {
    const view = await loadView();
    const { container } = render(<ReadyView view={view} />);
    const text = container.textContent ?? '';
    expect(text).toContain(
      'IRO（リスク・機会）の位置: 発生可能性 × 財務影響の大きさ（1〜5。円にしない）',
    );
    expect(text).toContain('影響額を定量化していない理由: 財務的影響額は評価中のため未確定');
    expect(text).toContain('渇水時の操業制限は円にしていません（未定量）。');
    expect(text).not.toContain('準拠率');
  });

  it('拠点担当（disclosure.read なし）: 定性情報・IRO を出さず「閲覧権限が無い領域は表示していません」', async () => {
    const view = await loadView({ roleKeys: ['site_contributor'] });
    const { container } = render(<ReadyView view={view} />);
    expect(container.querySelector('details#fi-qualitative')).toBeNull();
    const note = screen.getByText(/閲覧権限が無い領域は表示していません/);
    expect(note.closest('details')).toBeNull();
    expect(container.textContent).not.toContain('IRO（リスク・機会）の位置');
  });

  it('Supabase 相当（source none）: 既定値なしで入力欄は空、仮定を変えるを開き、合計は未定量', async () => {
    const view = await loadView({ source: 'none' });
    const { container } = render(<ReadyView view={view} />);
    const details = container.querySelector('details#fi-assumptions') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(
      (container.querySelector('input[name="a_carbonPriceStart"]') as HTMLInputElement).value,
    ).toBe('');
    const annual = screen.getByRole('group', { name: 'FY2030 の年間影響' });
    expect(annual.textContent).toContain('未定量');
    expect(annual.textContent).toContain('定量化できた経路のみ（0 / 9 経路）');
    expect(annual.textContent).not.toContain('営業利益');
    expect(container.textContent).toContain('定量化できた経路がありません（0 ではありません）');
  });
});

describe('制度の前提の表（GX-ETS）と目標の扱い', () => {
  /** 制度の前提の表で、事実の行見出しが text で始まる行の「この試算での扱い」 */
  function handlingOf(container: HTMLElement, fact: RegExp): string {
    const table = container.querySelector('details#fi-institutions table') as HTMLTableElement;
    const row = within(table)
      .getAllByRole('row')
      .find((r) => fact.test(r.querySelector('th[scope="row"]')?.textContent ?? ''));
    if (!row) throw new Error(`${String(fact)} の行が無い`);
    return row.querySelector('td')?.textContent ?? '';
  }

  it('デモ（Scope1 約 0.9 万 t・ヘッダー FY2026 は収集中）: 直接の義務対象外の規模と書く', async () => {
    const view = await loadView();
    const { container } = render(<ReadyView view={view} />);
    expect(handlingOf(container, /^GX-ETS/)).toBe(
      '参考: 直接の義務対象外の規模（FY2025 の Scope1 は約 0.9 万 t-CO2e。CO2e であり、FY2026 は収集中のため 3 年平均も出しません）',
    );
  });

  it('Scope1 が 10 万 t 以上なら「義務対象外」と書かない', async () => {
    const view = await loadView();
    const { container } = render(<ReadyView view={{ ...view, scope1Reference: 250_000 }} />);
    const text = handlingOf(container, /^GX-ETS/);
    expect(text).not.toContain('義務対象外');
    expect(text).toContain('約 25.0 万 t-CO2e');
    expect(text).toContain('参加義務の対象になりえます');
  });

  it('ヘッダーが締め済みの FY2025（基準年度と同じ）なら「収集中」と書かない', async () => {
    const view = await loadView({ periodId: PERIOD_IDS.fy2025 });
    const { container } = render(<ReadyView view={view} />);
    const text = handlingOf(container, /^GX-ETS/);
    expect(text).not.toContain('収集中');
    expect(text).toContain('CO2e であり直接 CO2 の値ではないため、3 年平均も出しません');
  });

  it('達成済みの目標は「使わない（既に達成）」と理由つきで示す', async () => {
    const view = await loadView();
    const achieved = {
      ...view,
      targets: view.targets.map((t) =>
        t.driver === 'scope1'
          ? { ...t, status: 'achieved' as const, reasons: ['既に目標を達成しています。'] }
          : t,
      ),
    };
    const { container } = render(<ReadyView view={achieved} />);
    const list = within(container).getByRole('list', { name: '起点ごとの目標' });
    const item = within(list)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('Scope1:'));
    expect(item?.textContent).toContain('使わない（基準年度の実績が既に目標を達成。一定）');
    expect(item?.textContent).toContain('既に目標を達成しています。');
  });
});
