import { describe, expect, it } from 'vitest';
import {
  returnedCount,
  unitStatusItems,
  type UnitProgressCounts,
} from '@/app/enterprise/dashboard/home-breakdown';
import {
  collectionStatusItems,
  mappingFunnelSteps,
  planStatusItems,
  ssbjRequirementItems,
} from '@/app/enterprise/disclosures/ssbj/_components/breakdown-items';

/**
 * ホーム・SSBJ 画面の件数を図（状態の内訳・件数の流れ）にする組み立て（docs/disclosure-first.md §10.4）。
 *
 * - 帯は重ならない区分だけで作り、区分の合計が分母（全要求事項・対象・計画の件数・収集対象）と一致する
 *   （一致しないと帯の幅が嘘になる。重なる件数〔確認待ち・検証エラー・期限超過〕は帯に入れない）
 * - ラベルは既存の画面の文言そのまま（E2E が厳密一致で確かめている）
 * - 一覧へのリンクは、表示した件数と同じ母集団になる絞り込みだけに付ける
 */

const sum = (items: readonly { count: number }[]) => items.reduce((s, i) => s + i.count, 0);

describe('SSBJ 対応状況: 全要求事項の内訳', () => {
  const counts = {
    total: 133,
    covered: 12,
    mostlyCovered: 8,
    partial: 20,
    notCovered: 55,
    notMaterial: 30,
    notApplicable: 8,
  };

  it('6 区分の合計が全要求事項と一致し、ラベルは画面の文言そのまま（確認待ちは重なるので入れない）', () => {
    const items = ssbjRequirementItems(counts);
    expect(items.map((i) => i.label)).toEqual([
      '対応済み',
      'おおむね対応',
      '一部対応',
      '未対応',
      '重要性なし',
      '対象外',
    ]);
    expect(sum(items)).toBe(counts.total);
    expect(items.map((i) => i.label)).not.toContain('確認待ち');
    for (const item of items) expect(item.icon, item.label).toBeDefined();
  });

  it('対応済み〜未対応は評価対象に絞った一覧へ。重要性なし・対象外は同じ母集団を作れないのでリンクなし', () => {
    const byLabel = Object.fromEntries(ssbjRequirementItems(counts).map((i) => [i.label, i.href]));
    const query = (href: string | undefined) => new URL(href!, 'http://x').searchParams;
    expect(query(byLabel['対応済み']).getAll('coverage')).toEqual(['covered']);
    expect(query(byLabel['おおむね対応']).getAll('coverage')).toEqual(['mostly_covered']);
    expect(query(byLabel['一部対応']).getAll('coverage')).toEqual(['partial']);
    // 未対応は「未対応＋未確認」を数えている（ホームの SSBJ 未対応カードと同じ母集団）
    expect(query(byLabel['未対応']).getAll('coverage')).toEqual(['not_covered', 'unconfirmed']);
    for (const label of ['対応済み', 'おおむね対応', '一部対応', '未対応']) {
      expect(byLabel[label]).toMatch(/^\/enterprise\/disclosures\/ssbj\/requirements\?/);
      expect(query(byLabel[label]).get('scope')).toBe('in_scope');
    }
    expect(byLabel['重要性なし']).toBeUndefined();
    expect(byLabel['対象外']).toBeUndefined();
  });
});

describe('SSBJ 要求事項: 件数の流れ', () => {
  it('マスター → 適用基準 → 対象外を除く → 評価対象 を件数の文字で並べる', () => {
    const steps = mappingFunnelSteps({
      masterTotal: 133,
      afterStandards: 120,
      notApplicable: 7,
      notMaterial: 25,
      inScope: 88,
    });
    expect(steps.map((s) => [s.label, s.count, s.unit])).toEqual([
      ['正式基準マスター', 133, '項目'],
      ['適用基準で', 120, '項目'],
      ['対象外を除く', 113, '項目'],
      ['評価対象（重要性なしも除く）', 88, '項目'],
    ]);
  });
});

describe('SSBJ 対応計画: 対応状況の内訳', () => {
  it('4 区分（0 件も凡例に出す）の合計が計画の件数', () => {
    const plans = (['not_started', 'in_progress', 'in_progress', 'done'] as const).map(
      (status) => ({ plan: { status } }),
    );
    const items = planStatusItems(plans);
    expect(items.map((i) => [i.label, i.count])).toEqual([
      ['未着手', 1],
      ['対応中', 2],
      ['確認中', 0],
      ['完了', 1],
    ]);
    expect(sum(items)).toBe(plans.length);
  });
});

describe('SSBJ データ収集: 収集状況の内訳', () => {
  it('行の無いものは「未入力」（0 にしない）。0 件の区分は出さないが承認済みは常に出す。合計 = 収集対象', () => {
    const rows = [
      { collectedStatus: 'submitted' },
      { collectedStatus: null },
      { collectedStatus: null },
      { collectedStatus: 'returned' },
    ];
    const items = collectionStatusItems(rows);
    expect(items.map((i) => [i.label, i.count])).toEqual([
      ['承認済み', 0],
      ['提出済み', 1],
      ['差戻し', 1],
      ['未入力', 2],
    ]);
    expect(sum(items)).toBe(rows.length);
    expect(collectionStatusItems([])).toEqual([expect.objectContaining({ label: '承認済み' })]);
  });
});

describe('従来のホーム: 拠点別の状態の内訳', () => {
  const row: UnitProgressCounts = {
    unitId: '11111111-1111-4111-8111-111111111111',
    total: 20,
    approved: 9,
    submitted: 4,
    notStarted: 5,
  };

  it('承認済み・レビュー中・未提出に、対象との差（差戻し）を足して合計を対象に合わせる', () => {
    const items = unitStatusItems(row);
    expect(items.map((i) => [i.label, i.count])).toEqual([
      ['承認済み', 9],
      ['レビュー中', 4],
      ['未提出', 5],
      ['差戻し', 2],
    ]);
    expect(sum(items)).toBe(row.total);
    expect(returnedCount(row)).toBe(2);
  });

  it('差が 0 なら差戻しを出さない。集計の食い違いで負になっても負の件数は作らない', () => {
    expect(unitStatusItems({ ...row, notStarted: 7 }).map((i) => i.label)).toEqual([
      '承認済み',
      'レビュー中',
      '未提出',
    ]);
    expect(returnedCount({ ...row, notStarted: 9 })).toBe(0);
  });

  it('各区分はその拠点・状態で絞った台帳へ（ホームの KPI カードと同じ状態の組）', () => {
    const query = (label: string) =>
      new URL(unitStatusItems(row).find((i) => i.label === label)!.href!, 'http://x');
    for (const label of ['承認済み', 'レビュー中', '未提出', '差戻し']) {
      expect(query(label).pathname).toBe('/enterprise/data');
      expect(query(label).searchParams.get('unit')).toBe(row.unitId);
    }
    expect(query('承認済み').searchParams.getAll('status')).toEqual(['approved']);
    expect(query('レビュー中').searchParams.getAll('status')).toEqual(['submitted', 'in_review']);
    expect(query('未提出').searchParams.getAll('status')).toEqual(['not_started', 'draft']);
    expect(query('差戻し').searchParams.getAll('status')).toEqual(['returned']);
  });
});
