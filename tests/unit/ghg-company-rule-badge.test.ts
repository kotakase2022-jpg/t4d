import { describe, expect, it } from 'vitest';
import { showsCompanyRuleBadge } from '@/app/enterprise/ghg/_components/calc-data';
import type { GhgClassificationRule } from '@/types/domain';

/**
 * 「組織の算定ルール（GHG プロトコルの標準区分と異なる区分を含みます）」のバッジ（自己監査 UX-01）。
 * 承認待ちの規則だけのとき（数値は既定区分のまま。N2 が示す）に出すと、バッジの文が事実と違う。
 * P90・GHG サマリー・算定明細が同じ規則（表示している記録が規則で報告区分を変えたときだけ）を使う。
 */

const rule = { id: 'r', name: 'LOGI-01' } as GhgClassificationRule;

describe('showsCompanyRuleBadge', () => {
  it('承認待ちの規則だけ（再分類なし）なら出さない', () => {
    expect(showsCompanyRuleBadge({ appliedRules: [] })).toBe(false);
  });

  it('記録が規則で報告区分を変えたら出す', () => {
    expect(showsCompanyRuleBadge({ appliedRules: [{ rule, approverName: '承認者' }] })).toBe(true);
  });
});
