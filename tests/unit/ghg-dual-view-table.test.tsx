import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  digitsInTonnes,
  dualViewRows,
  effectiveRoundingRule,
  formatStageValue,
  reclassifiedByRule,
  roundingPolicyText,
  roundingRuleText,
  siteResultRows,
} from '@/app/enterprise/ghg/_components/calc-view';
import { DualViewTable } from '@/app/enterprise/ghg/_components/dual-view-table';
import { SiteResultsTable } from '@/app/enterprise/ghg/_components/site-results-table';
import { calculateRun } from '@/lib/domain/ghg/calculate';
import { cleanFloat } from '@/lib/domain/ghg/rounding';
import { selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { UNIT_IDS } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_VERIFICATION_UNIT_IDS,
  ghgSourceRowsFromFixture,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import type {
  GhgClassificationRule,
  GhgRunSummary,
  OrganizationUnit,
  RoundingRule,
} from '@/types/domain';

/**
 * 報告区分と既定区分の二重表示・拠点別の結果（plan K7・CR-09・unit:ghg-dual-view-table）。
 *  - 再分類は移動だけ: Scope1＋Scope3 カテゴリ4 の計はどちらの見方でも同じ（差 ±0）
 *  - Scope2 の 2 基準は別の行で、足した行を作らない
 *  - 値の無い区分は「—」（0 と書かない）。値は算定方針の段の値をその桁のまま（表示で丸め直さない）
 *  - Fixture の R-1（区分規則は承認前）と、規則を承認した後の算定（R-2 相当）で確かめる
 */

let r1: GhgRunSummary;
let r2: GhgRunSummary;
let rounding: RoundingRule[];
let units: OrganizationUnit[];
let rule: GhgClassificationRule;

beforeAll(() => {
  const db = createFixtureDb();
  const period = db.periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
  r1 = db.ghgCalculationRuns.find((r) => r.id === GHG_FIXTURE_IDS.run)!.summary!;
  rounding = db.ghgCalculationPolicies[0]!.rounding;
  units = GHG_VERIFICATION_UNIT_IDS.map((id) => db.units.find((u) => u.id === id)!);
  rule = db.ghgClassificationRules.find((r) => r.id === GHG_FIXTURE_IDS.rule)!;
  Object.assign(rule, {
    status: 'approved',
    approvedBy: 'approver',
    approvedAt: '2026-10-16T00:00:00.000Z',
  });
  const inputs = selectCalculationInputs(
    ghgSourceRowsFromFixture(db, period),
    GHG_VERIFICATION_UNIT_IDS,
  )!;
  r2 = calculateRun(inputs, { runId: 'r2', createdAt: '2026-10-16T00:00:00.000Z' }).summary;
});

describe('丸めの段の桁', () => {
  it('段に規則が無ければ前の段の規則（どの段にも無ければ未丸め）。kg の桁は t の桁 +3', () => {
    expect(effectiveRoundingRule(rounding, 'line')).toBeNull();
    expect(effectiveRoundingRule(rounding, 'month')).toBeNull();
    expect(effectiveRoundingRule(rounding, 'site_activity')?.digits).toBe(3);
    expect(effectiveRoundingRule(rounding, 'site_scope')?.digits).toBe(1);
    expect(effectiveRoundingRule(rounding, 'total')?.stage).toBe('site_scope');
    expect(digitsInTonnes({ digits: 0, unit: 'kg' })).toBe(3);
    expect(digitsInTonnes({ digits: 2, unit: 't' })).toBe(2);
  });

  it('段の値はその段の桁で末尾の 0 も出す（丸め直さない）。規則が無ければ未丸めの桁', () => {
    expect(formatStageValue(9701.4, rounding, 'site_scope')).toBe('9,701.4');
    expect(formatStageValue(3577, rounding, 'site_scope')).toBe('3,577.0');
    // 未丸めは桁を落とさない（2 進の誤差だけ落とす）
    expect(formatStageValue(0.112553429472, [], 'line')).toBe('0.112553429472');
    expect(formatStageValue(396.00000000000006, [], 'line')).toBe('396');
    expect(formatStageValue(1001.13575952133, [], 'line')).toBe('1,001.13575952133');
    expect(roundingRuleText({ digits: 0, unit: 'kg', method: 'truncate' })).toBe(
      'kg・整数・切り捨て（0 の側）',
    );
    expect(roundingPolicyText(rounding)).toBe(
      '拠点×活動: t・小数 3 桁・四捨五入 ／ 拠点×区分: t・小数 1 桁・四捨五入',
    );
    expect(roundingPolicyText([])).toBe('丸めの段なし（未丸めの値）');
  });
});

describe('dualViewRows', () => {
  it('並びは Scope1・Scope3 カテゴリ4・その計・Scope2（ロケーション）・Scope2（マーケット）。2 基準を足した行は無い', () => {
    const rows = dualViewRows(r1);
    expect(rows.map((r) => r.key)).toEqual([
      'scope1',
      'scope3_cat4',
      'scope1_scope3_total',
      'scope2_location',
      'scope2',
    ]);
    const scope2 = rows.filter((r) => r.label.includes('Scope2'));
    expect(scope2.map((r) => r.label)).toEqual([
      'Scope2（ロケーション基準）',
      'Scope2（マーケット基準）',
    ]);
  });

  it('規則の承認前（R-1）は報告区分＝既定区分で、差はすべて 0', () => {
    for (const row of dualViewRows(r1)) {
      expect(row.reported).toBe(row.protocol);
      expect(row.difference).toBe(0);
    }
    expect(reclassifiedByRule(r1)).toEqual([]);
  });

  it('規則の承認後は委託物流が Scope3 カテゴリ4 から Scope1 へ移る。計は変わらない（移動だけ・二重計上なし）', () => {
    const rows = dualViewRows(r2);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const moved = reclassifiedByRule(r2);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ ruleId: rule.id, from: 'scope3_cat4', to: 'scope1' });
    expect(moved[0]!.unitIds).toEqual([UNIT_IDS.east]);
    const scope1 = byKey.get('scope1')!;
    const scope3 = byKey.get('scope3_cat4')!;
    // 報告区分の Scope3 カテゴリ4 は空になる（0 ではなく値なし）
    expect(scope3.reported).toBeNull();
    expect(scope3.protocol).toBe(3.7);
    expect(scope1.unroundedDifference).toBeCloseTo(moved[0]!.unrounded, 9);
    expect(scope3.unroundedDifference).toBeCloseTo(-moved[0]!.unrounded, 9);
    const total = byKey.get('scope1_scope3_total')!;
    expect(total.unroundedDifference).toBe(0);
    expect(cleanFloat(total.reported! - total.protocol!)).toBe(total.difference);
    // Scope2 は再分類の対象外
    expect(byKey.get('scope2')!.difference).toBe(0);
    expect(byKey.get('scope2_location')!.difference).toBe(0);
  });
});

describe('DualViewTable', () => {
  it('表の名前・列・計の行の「±0（移動だけ・二重計上なし）」・値の無い区分は「—」', () => {
    render(<DualViewTable summary={r2} rounding={rounding} rules={[rule]} />);
    const table = screen.getByRole('table', { name: '報告区分と既定区分' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      '区分',
      '報告区分（組織の算定ルール）',
      '既定区分（GHG プロトコル・参考）',
      '差（再分類で移った分）',
    ]);
    const scope3Row = table.querySelector('[data-dual-row="scope3_cat4"]')!;
    const cells = [...scope3Row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[1]).toBe('—');
    expect(cells[2]).toBe('3.7');
    expect(cells[3]).toBe('−3.7');
    const totalRow = table.querySelector('[data-dual-row="scope1_scope3_total"]')!;
    expect(totalRow.textContent).toContain('±0（移動だけ・二重計上なし）');
    // 再分類の内訳に規則のコードと名前・移動の向き（矢印は読み上げない）
    const list = screen.getByRole('list', { name: '区分規則による再分類' });
    expect(list.textContent).toContain(`${rule.code} ${rule.name}`);
    expect(list.textContent).toContain('Scope3 カテゴリ4');
    for (const icon of list.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getByText(/足しません/)).toBeTruthy();
  });

  it('再分類が無ければ内訳の一覧を出さない', () => {
    render(<DualViewTable summary={r1} rounding={rounding} rules={[rule]} />);
    expect(screen.queryByRole('list', { name: '区分規則による再分類' })).toBeNull();
  });
});

describe('siteResultRows・SiteResultsTable', () => {
  it('拠点の並び・国内／海外・再分類分（報告 − 既定の Scope1）・値の無い区分は null', () => {
    const rows = siteResultRows(r2, units, { organizationCountryCode: 'JP' });
    expect(rows.map((r) => [r.unitCode, r.countryCode, r.domestic])).toEqual([
      ['EAST', 'JP', true],
      ['TH1', 'TH', false],
      ['VN1', 'VN', false],
      ['MX1', 'MX', false],
      ['US1', 'US', false],
    ]);
    const east = rows[0]!;
    const protocolEast1 = r2.protocol.sites.find(
      (s) => s.unitId === UNIT_IDS.east && s.scope === 'scope1',
    )!.rounded;
    expect(east.reclassifiedToScope1).toBe(cleanFloat(east.scope1! - protocolEast1));
    expect(east.scope3Cat4Protocol).toBe(3.7);
    expect(east.warningLines).toBeGreaterThan(0);
    // 再分類の無い拠点・委託物流の無い拠点
    expect(rows[1]!.reclassifiedToScope1).toBeNull();
    expect(rows[1]!.scope3Cat4Protocol).toBeNull();
    // 記録が無ければ値はすべて null（0 にしない）
    const empty = siteResultRows(null, units, { organizationCountryCode: 'JP' });
    expect(empty.every((r) => r.scope1 === null && r.scope2Market === null)).toBe(true);
  });

  it('表は拠点（国・国内／海外）と状態のバッジ（ラベル＋アイコン）。値の無い区分は「—」', () => {
    const rows = siteResultRows(r1, units, {
      organizationCountryCode: 'JP',
      statuses: new Map(units.map((u) => [u.id, 'reconciliation_review' as const])),
    });
    render(<SiteResultsTable rows={rows} rounding={rounding} caption="拠点別の結果" />);
    const table = screen.getByRole('table', { name: '拠点別の結果' });
    const th = table.querySelector('[data-site-row="TH1"]')!;
    expect(th.textContent).toContain('タイ工場');
    expect(th.textContent).toContain('（TH・海外）');
    const cells = [...th.querySelectorAll('td')].map((td) => td.textContent);
    // うち再分類分・Scope3 カテゴリ4 は「—」
    expect(cells[2]).toBe('—');
    expect(cells[5]).toBe('—');
    const badge = th.querySelector('[data-status-domain="ghgSiteStatus"]')!;
    expect(badge.textContent).toContain('照合（要確認）');
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(table.querySelector('[data-site-row="EAST"]')!.textContent).toContain('（JP・国内）');
  });
});
