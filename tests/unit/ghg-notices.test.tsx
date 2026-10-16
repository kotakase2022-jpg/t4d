import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HONESTY_KINDS, HONESTY_TEXT, HonestyBadge } from '@/components/shared/honesty-badge';
import {
  CompanyRuleNotice,
  GHG_FIXED_NOTICES,
  GhgNotice,
  LoadFactorNotice,
  PendingRuleNotice,
  companyRuleNoticeText,
  loadFactorNoticeText,
  pendingRuleNoticeText,
} from '@/components/shared/ghg-notices';
import { formatNumber } from '@/lib/format/datetime';

/**
 * Scope1・2 の算定と照合の誠実さの表示（plan §2.5）。固定文は画面・出力で同じ語を使うため、
 * 文の要点（一致を保証しない・標準区分は Cat.4・試算は保存しない・架空）が欠けていないことを確かめる
 */
describe('HonestyBadge（算定と照合の 2 種）', () => {
  it.each([
    ['company-rule', '組織の算定ルール', 'GHG プロトコルの標準区分と異なる区分を含みます'],
    ['consistency-check', '整合性の確認', '一致を保証するものではありません'],
  ] as const)('%s はラベル・アイコン・補足を出す', (kind, label, detail) => {
    expect(HONESTY_KINDS).toContain(kind);
    const { container } = render(<HonestyBadge kind={kind} />);
    const badge = container.querySelector(`[data-honesty="${kind}"]`)!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain(label);
    expect(badge.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(badge.querySelector('.sr-only')?.textContent).toContain(detail);
    expect(HONESTY_TEXT[kind].label).toBe(label);
  });

  it('company-rule は brand、consistency-check は neutral の色', () => {
    expect(HONESTY_TEXT['company-rule'].tone).toBe('brand');
    expect(HONESTY_TEXT['consistency-check'].tone).toBe('neutral');
  });
});

describe('ghg-notices の固定文', () => {
  it('N1 は規則名・承認日（JST）・承認者を差し込み、標準区分が Cat.4 であることを書く', () => {
    const text = companyRuleNoticeText({
      ruleName: '委託物流の区分',
      approvedAt: '2026-03-31T16:30:00Z',
      approverName: '架空 承認者',
    });
    expect(text).toContain('算定ルール「委託物流の区分」');
    // UTC 3/31 16:30 は JST の 4/1
    expect(text).toContain('（2026-04-01・承認者');
    expect(text).toContain('承認者 架空 承認者');
    expect(text).toContain('Scope 3 Standard 表 5.7');
    expect(text).toContain('Scope 3 カテゴリ 4 です');
    expect(text).toContain('既定区分の値を参考として並べています');
  });

  it('N2 は承認待ちのあいだ既定区分で算定することを書く', () => {
    expect(pendingRuleNoticeText({ ruleName: 'R' })).toBe(
      '区分規則「R」は承認待ちです。承認されるまで、委託物流は既定区分（Scope 3 カテゴリ 4）で算定します。',
    );
  });

  it('N3 は一致を保証しないこと・許容差は利用者の入力であることを書く', () => {
    expect(GHG_FIXED_NOTICES.N3).toContain('結果の一致を保証するものではありません');
    expect(GHG_FIXED_NOTICES.N3).toContain('許容差は利用者が入力した値です');
  });

  it('N4・N8 は順序依存と試算であることを書く', () => {
    expect(GHG_FIXED_NOTICES.N4).toContain('順序を変えると配分が変わることがあります');
    expect(GHG_FIXED_NOTICES.N4).toContain('原因不明（残差）');
    expect(GHG_FIXED_NOTICES.N8).toContain('保存しません（試算）');
    expect(GHG_FIXED_NOTICES.N8).toContain('原因の確定にはなりません');
  });

  it('N5・N6・N9・N10 の要点', () => {
    expect(GHG_FIXED_NOTICES.N5).toContain('国内のトラック輸送の算定方法です');
    expect(GHG_FIXED_NOTICES.N6).toContain('この画面の Scope 区分とは対応しません');
    expect(GHG_FIXED_NOTICES.N9).toContain('すべて架空です');
    expect(GHG_FIXED_NOTICES.N10).toContain('令和5年以降の改正の有無は一部未確認です');
  });

  it('N7 は行数と下限を差し込む', () => {
    expect(loadFactorNoticeText({ defaultRows: 2, minLoadPct: 10, flooredRows: 1 })).toBe(
      '積載率が無い行は係数セットの見なし積載率の原単位表で算定しました（2 行）。積載率が 10% 未満の行は 10% として算定しました（1 行）。',
    );
  });

  it('部品は見出し・アイコン付きの枠に文を出し、data-ghg-notice で場所を示す', () => {
    const { container } = render(
      <>
        <GhgNotice id="N3" />
        <CompanyRuleNotice ruleName="R" approvedAt="2026-01-05" approverName="A" />
        <PendingRuleNotice ruleName="R" />
        <LoadFactorNotice defaultRows={1} minLoadPct={10} flooredRows={0} />
      </>,
    );
    for (const id of ['N3', 'N1', 'N2', 'N7']) {
      const box = container.querySelector(`[data-ghg-notice="${id}"]`);
      expect(box, id).not.toBeNull();
      expect(box!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(box!.querySelector('p.font-semibold')?.textContent).toBeTruthy();
    }
    expect(container.querySelector('[data-ghg-notice="N3"]')!.textContent).toContain(
      GHG_FIXED_NOTICES.N3,
    );
  });

  it('N7 は見なし・下限のどちらも 0 行なら出さない', () => {
    const { container } = render(
      <LoadFactorNotice defaultRows={0} minLoadPct={10} flooredRows={0} />,
    );
    expect(container.querySelector('[data-ghg-notice="N7"]')).toBeNull();
  });
});

describe('formatNumber の桁指定（算定の丸め後の値を桁を落とさずに出す）', () => {
  it('既定は小数 3 桁まで', () => {
    expect(formatNumber(1.23456)).toBe('1.235');
  });
  it('桁を指定すると、その桁まで出す（最小桁も指定できる）', () => {
    expect(formatNumber(1.234567, { fraction: 6 })).toBe('1.234567');
    expect(formatNumber(1234.5, { fraction: 3, minimumFraction: 3 })).toBe('1,234.500');
    expect(formatNumber(null, { fraction: 2 })).toBe('—');
  });
  it('関数のまま渡されて添字が 2 番目に来ても既定の表示のまま（既存の呼び出しを壊さない）', () => {
    // 図の部品は (値, 添字) で呼ぶことがある（実行時の形をそのまま再現する）
    const asCallback = formatNumber as unknown as (value: number, index: number) => string;
    expect([1.23456, 2].map(asCallback)).toEqual(['1.235', '2']);
  });
});
