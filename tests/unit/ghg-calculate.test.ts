import { describe, expect, it } from 'vitest';
import {
  GHG_ENGINE_VERSION,
  calculateRun,
  computeInputHash,
  recalculate,
} from '@/lib/domain/ghg/calculate';
import { CO2_PER_C } from '@/lib/domain/ghg/fuel-co2';
import { assign, baseInputs, batch, factor, line, rule, set } from './ghg-test-builders';

/**
 * 算定の実行（plan §2.2 calculate.ts・CR-08）。決定論・各段の値・係数のスナップショット・二重表示・段の丸め・
 * エラー（代わりを使わない）・仮説の再計算（保存しない）。値は架空の係数による計算値。
 */

const OPTS = { runId: 'run-1', createdAt: '2026-10-16T00:00:00.000Z' };

const close = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-12);

describe('calculateRun: 行ごとの算定', () => {
  const out = calculateRun(baseInputs(), OPTS);
  const byActivity = (id: string) => out.lines.filter((l) => l.activityLineId === id);

  it('エラーが無く、電力は 2 基準で 2 行（活動量 8 行 → 算定行 10 行）', () => {
    expect(out.errors).toEqual([]);
    expect(out.lines).toHaveLength(10);
    expect(out.engineVersion).toBe(GHG_ENGINE_VERSION);
  });

  it('燃料（L→kL・2 段係数）: 1.2 kL × 38.5 GJ/kL × 0.0186 tC/GJ × 44/12', () => {
    const [diesel] = byActivity('L1');
    expect(diesel).toMatchObject({
      method: 'fuel_combustion',
      convertedAmount: 1.2,
      convertedUnit: 'kL',
      factorId: 'F-DIESEL-25',
      factorSetCode: 'S25',
      factorSetVersion: '2025 年版',
      resolutionPath: '全社既定の割当（軽油・2025 年版）',
      protocolScope: 'scope1',
      reportedScope: 'scope1',
    });
    close(diesel!.emissionsUnrounded, 1.2 * 38.5 * 0.0186 * CO2_PER_C);
    expect(diesel!.conversionSteps).toEqual([
      { from: 'L', to: 'kL', factor: 0.001, source: 'builtin' },
    ]);
  });

  it('都市ガス（m3→Nm3 は組織の換算・Nm3→千Nm3 は内蔵）を段に残す', () => {
    const [gas] = byActivity('L2');
    expect(gas!.conversionSteps.map((s) => s.source)).toEqual([
      'policy:（架空）温度・圧力補正',
      'builtin',
    ]);
    close(gas!.convertedAmount, 0.93);
    close(gas!.emissionsUnrounded, 0.93 * 2.1);
  });

  it('電力: ロケーション基準は国の係数、マーケット基準は拠点の契約の係数（足さない）', () => {
    const lines = byActivity('L3');
    expect(lines.map((l) => [l.method, l.protocolScope, l.factorId])).toEqual([
      ['electricity_location', 'scope2_location', 'F-EL-JP-25'],
      ['electricity_market', 'scope2', 'F-CONTRACT-A'],
    ]);
    close(lines[0]!.emissionsUnrounded, 4.5);
    close(lines[1]!.emissionsUnrounded, 3);
    expect(lines[1]!.resolutionPath).toBe(
      '拠点の割当（国内工場・電力（マーケット基準）・2025 年版）',
    );
  });

  it('米国ガロンは内蔵の換算で L→kL', () => {
    const [gal] = byActivity('L5');
    close(gal!.convertedAmount, 0.3785411784);
    expect(gal!.conversionSteps).toHaveLength(1);
  });

  it('委託物流（改良トンキロ法）: 各段（t·km・原単位・燃料 L）を残し、既定区分は Scope3 カテゴリ4', () => {
    const [shipment] = byActivity('L6');
    expect(shipment).toMatchObject({
      method: 'tonkm_improved',
      activityUnit: 'tkm',
      protocolScope: 'scope3_cat4',
      reportedScope: 'scope3_cat4',
      classificationRuleId: null,
    });
    const intensity = 14.5 / 0.55 ** 0.8 / 4000 ** 0.65;
    close(shipment!.methodDetail.intensity as number, intensity);
    expect(shipment!.methodDetail.loadFactorSource).toBe('measured');
    close(shipment!.methodDetail.fuelLiters as number, 2.2 * 180 * intensity);
    expect(typeof shipment!.methodDetail.logRatio).toBe('number');
  });

  it('積載率が無い行は見なし積載率の原単位表（警告）、自社便の燃料は燃料法で Scope1', () => {
    const [defaulted] = byActivity('L7');
    expect(defaulted!.methodDetail.intensitySource).toBe('default_table');
    expect(defaulted!.warnings).toEqual(['default_load_factor']);
    close(defaulted!.methodDetail.fuelLiters as number, 250);
    const [own] = byActivity('L8');
    expect(own).toMatchObject({
      method: 'fuel_method',
      protocolScope: 'scope1',
      reportedScope: 'scope1',
    });
  });

  it('同じ入力から同じ結果（行の ID・入力ハッシュ）', () => {
    const again = calculateRun(baseInputs(), OPTS);
    expect(again.lines.map((l) => l.id)).toEqual(out.lines.map((l) => l.id));
    expect(again.inputHash).toBe(out.inputHash);
    expect(again.summary).toEqual(out.summary);
  });
});

describe('calculateRun: 区分規則と二重表示', () => {
  it('承認済みの規則で委託物流の報告区分は Scope1、既定区分は Scope3 カテゴリ4 のまま', () => {
    const out = calculateRun(baseInputs({ rules: [rule()] }), OPTS);
    const contracted = out.lines.filter(
      (l) => l.activityKind === 'transport' && l.protocolScope === 'scope3_cat4',
    );
    expect(contracted).toHaveLength(2);
    expect(
      contracted.every((l) => l.reportedScope === 'scope1' && l.classificationRuleId === 'rule-1'),
    ).toBe(true);
    expect(out.ruleIds).toEqual(['rule-1']);
    const reported = out.summary.reported.totals;
    const protocol = out.summary.protocol.totals;
    const sum = (list: typeof reported, scopes: string[]) =>
      list.filter((t) => scopes.includes(t.scope)).reduce((a, t) => a + t.unrounded, 0);
    close(sum(reported, ['scope1', 'scope3_cat4']), sum(protocol, ['scope1', 'scope3_cat4']));
    expect(out.summary.reclassified).toHaveLength(1);
    expect(out.summary.reclassified[0]).toMatchObject({
      unitId: 'u-jp',
      ruleId: 'rule-1',
      from: 'scope3_cat4',
      to: 'scope1',
    });
  });

  it('提案中の規則は効かない（入力ハッシュも承認の前後で変わる）', () => {
    const proposed = calculateRun(
      baseInputs({ rules: [rule({ status: 'proposed', approvedBy: null, approvedAt: null })] }),
      OPTS,
    );
    expect(proposed.lines.some((l) => l.classificationRuleId)).toBe(false);
    expect(proposed.ruleIds).toEqual([]);
    const approved = calculateRun(baseInputs({ rules: [rule()] }), OPTS);
    expect(approved.inputHash).not.toBe(proposed.inputHash);
  });

  it('Scope2 の 2 基準は合計の区分を分けて持つ', () => {
    const out = calculateRun(baseInputs(), OPTS);
    expect(out.summary.reported.totals.map((t) => t.scope).sort()).toEqual([
      'scope1',
      'scope2',
      'scope2_location',
      'scope3_cat4',
    ]);
  });
});

describe('calculateRun: 丸めの段', () => {
  it('拠点×活動 t 小数 3 桁・拠点×区分 t 小数 1 桁（段の丸め後を次の段で足す）', () => {
    const inputs = baseInputs();
    inputs.policy = {
      ...inputs.policy,
      rounding: [
        { stage: 'site_activity', digits: 3, unit: 't', method: 'half_up' },
        { stage: 'site_scope', digits: 1, unit: 't', method: 'half_up' },
      ],
    };
    const out = calculateRun(inputs, OPTS);
    const th = out.summary.reported.sites.find(
      (s) => s.unitId === 'u-th' && s.scope === 'scope2_location',
    );
    expect(th).toMatchObject({ unrounded: 2.5, rounded: 2.5 });
    for (const site of out.summary.reported.sites) {
      expect(Number.isInteger((Math.round(site.rounded * 10) / 10) * 10)).toBe(true);
      expect(site.rounded).toBe(Math.round(site.rounded * 10) / 10);
    }
  });

  it('行の段の規則は算定行の丸め後に入り、規則を記録する', () => {
    const inputs = baseInputs();
    inputs.policy = {
      ...inputs.policy,
      rounding: [{ stage: 'line', digits: 0, unit: 'kg', method: 'truncate' }],
    };
    const out = calculateRun(inputs, OPTS);
    const [diesel] = out.lines;
    expect(diesel!.emissionsRounded).toBe(Math.trunc(diesel!.emissionsUnrounded * 1000) / 1000);
    expect(diesel!.roundingApplied).toEqual({
      stage: 'line',
      digits: 0,
      unit: 'kg',
      method: 'truncate',
    });
  });
});

describe('calculateRun: エラー（代わりを使わない）', () => {
  it('割当が無い行はエラーにして行を作らない', () => {
    const inputs = baseInputs();
    inputs.assignments = inputs.assignments.filter((a) => a.id !== 'A-EL-TH');
    const out = calculateRun(inputs, OPTS);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.message).toContain(
      '電力（ロケーション基準）: 係数が割り当てられていません',
    );
    expect(out.lines.some((l) => l.activityLineId === 'L4')).toBe(false);
  });

  it('組織の換算が無ければ m3 を Nm3 と同一視しない', () => {
    const inputs = baseInputs();
    inputs.policy = { ...inputs.policy, conversions: [] };
    const out = calculateRun(inputs, OPTS);
    expect(out.errors.map((e) => e.activityLineId)).toEqual(['L2']);
    expect(out.errors[0]!.message).toContain('組織の換算がありません');
  });

  it('当てはまる区分規則が 2 つ以上あればエラー', () => {
    const out = calculateRun(
      baseInputs({ rules: [rule(), rule({ id: 'rule-2', code: 'LOGI-02' })] }),
      OPTS,
    );
    expect(out.errors.map((e) => e.code)).toEqual([
      'classification_conflict',
      'classification_conflict',
    ]);
  });

  it('海外拠点の輸送は方針どおり（block は止める）', () => {
    const inputs = baseInputs();
    inputs.policy = { ...inputs.policy, tonkm: { ...inputs.policy.tonkm, overseas: 'block' } };
    inputs.organizationCountryCode = 'TH';
    const out = calculateRun(inputs, OPTS);
    expect(out.errors.some((e) => e.message.includes('海外拠点の輸送'))).toBe(true);
  });
});

describe('入力ハッシュ', () => {
  it('割当を変えると変わり、関係の無い拠点の割当では変わらない', () => {
    const base = computeInputHash(baseInputs());
    const changed = baseInputs();
    changed.assignments = changed.assignments.map((a) =>
      a.id === 'A-EL-TH' ? { ...a, factorId: 'F-EL-TH-24' } : a,
    );
    expect(computeInputHash(changed)).not.toBe(base);
    const unrelated = baseInputs();
    unrelated.assignments = [
      ...unrelated.assignments,
      assign('A-OTHER', 'F-DIESEL-24', { unitId: 'u-other' }),
    ];
    expect(computeInputHash(unrelated)).toBe(base);
  });
});

describe('recalculate（仮説の再計算。保存しない）', () => {
  it('別の係数セットに置き換えると、同じ種類・コード・基準・国の係数で算定し直す', () => {
    const base = calculateRun(baseInputs(), OPTS);
    const alt = recalculate(baseInputs(), { factorSetId: 'S24' }, OPTS);
    expect(alt.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('置き換える係数セットに同じ係数がありません'),
      expect.stringContaining('置き換える係数セットに同じ係数がありません'),
      expect.stringContaining('置き換える係数セットに同じ係数がありません'),
    ]);
    const th = (o: typeof base) =>
      o.lines.find((l) => l.activityLineId === 'L4' && l.method === 'electricity_location');
    close(th(base)!.emissionsUnrounded, 2.5);
    close(th(alt)!.emissionsUnrounded, 2.6);
    expect(th(alt)!.resolutionPath).toBe('仮説の再計算（2024 年版）');
  });

  it('組織の換算なし（m3 を Nm3 として）・式の形（対数式）・区分規則なし', () => {
    const noConv = recalculate(baseInputs(), { noConversions: true }, OPTS);
    close(noConv.lines.find((l) => l.activityLineId === 'L2')!.emissionsUnrounded, 2.1);
    const log = recalculate(baseInputs(), { shape: 'log' }, OPTS);
    const kokuji = calculateRun(baseInputs(), OPTS);
    const shipment = (o: typeof log) => o.lines.find((l) => l.activityLineId === 'L6')!;
    expect(shipment(log).emissionsUnrounded).toBeGreaterThan(shipment(kokuji).emissionsUnrounded);
    const noRules = recalculate(
      baseInputs({ rules: [rule()] }),
      { noClassificationRules: true },
      OPTS,
    );
    expect(noRules.lines.every((l) => l.reportedScope === l.protocolScope)).toBe(true);
  });
});

describe('入力ハッシュ: 結果を変えうる入力だけ（自己監査 inv F1・F6・pers F3）', () => {
  it('使った係数のセットを取り下げると変わる（取り下げたセットの値で反映しない）', () => {
    const base = computeInputHash(baseInputs());
    const retired = baseInputs();
    retired.factorSets = retired.factorSets.map((s) =>
      s.id === 'S25' ? { ...s, status: 'retired' as const } : s,
    );
    expect(computeInputHash(retired)).not.toBe(base);
  });

  it('使っていないセットの状態・算定する拠点の国に関係しない国の割当では変わらない', () => {
    const base = computeInputHash(baseInputs());
    const unused = baseInputs();
    unused.factorSets = unused.factorSets.map((s) =>
      s.id === 'S24' ? { ...s, status: 'retired' as const } : s,
    );
    expect(computeInputHash(unused)).toBe(base);
    const otherCountry = baseInputs();
    otherCountry.assignments = [
      ...otherCountry.assignments,
      assign('A-DE', 'F-DIESEL-24', { countryCode: 'DE' }),
    ];
    expect(computeInputHash(otherCountry)).toBe(base);
  });

  it('国の割当を足すと、その国の拠点が使う段が変わるので変わる', () => {
    const base = computeInputHash(baseInputs());
    const thDiesel = baseInputs();
    thDiesel.assignments = [
      ...thDiesel.assignments,
      assign('A-TH-DIESEL', 'F-DIESEL-24', { countryCode: 'TH' }),
    ];
    expect(computeInputHash(thDiesel)).not.toBe(base);
  });

  it('拠点の国を変えると変わる（国の割当・国の不一致・海外拠点の輸送を決める）', () => {
    const base = computeInputHash(baseInputs());
    const moved = baseInputs();
    moved.units = moved.units.map((u) => (u.id === 'u-th' ? { ...u, countryCode: 'JP' } : u));
    expect(computeInputHash(moved)).not.toBe(base);
  });
});

describe('購入した熱は 2 基準で算定する（自己監査 inv F7）', () => {
  const heatInputs = () => {
    const inputs = baseInputs();
    inputs.factorSets = [...inputs.factorSets, set('SH', '熱 2025 年版')];
    inputs.factors = [
      ...inputs.factors,
      factor('F-HEAT-LOC', 'SH', {
        activityKind: 'heat',
        activityCode: 'steam',
        basis: 'location',
        factorValue: 0.06,
        factorUnit: 't-CO2/GJ',
        activityUnit: 'GJ',
      }),
      factor('F-HEAT-MKT', 'SH', {
        activityKind: 'heat',
        activityCode: 'steam',
        basis: 'market',
        factorValue: 0.05,
        factorUnit: 't-CO2/GJ',
        activityUnit: 'GJ',
      }),
    ];
    inputs.assignments = [
      ...inputs.assignments,
      assign('A-HEAT-LOC', 'F-HEAT-LOC', {
        activityKind: 'heat',
        activityCode: 'steam',
        basis: 'location',
      }),
      assign('A-HEAT-MKT', 'F-HEAT-MKT', {
        activityKind: 'heat',
        activityCode: 'steam',
        basis: 'market',
      }),
    ];
    inputs.batches = [...inputs.batches, batch('B-JP-H', 'u-jp')];
    inputs.lines = [
      ...inputs.lines,
      line('L-HEAT', 'B-JP-H', 1, {
        activityKind: 'heat',
        activityCode: 'steam',
        amount: 100,
        unit: 'GJ',
      }),
    ];
    return inputs;
  };

  it('ロケーション基準（scope2_location）とマーケット基準（scope2）の 2 行。燃料の燃焼と書かない', () => {
    const out = calculateRun(heatInputs(), OPTS);
    expect(out.errors).toEqual([]);
    const heat = out.lines.filter((l) => l.activityLineId === 'L-HEAT');
    expect(heat.map((l) => [l.method, l.protocolScope, l.factorId])).toEqual([
      ['heat_location', 'scope2_location', 'F-HEAT-LOC'],
      ['heat_market', 'scope2', 'F-HEAT-MKT'],
    ]);
    close(heat[0]!.emissionsUnrounded, 6);
    close(heat[1]!.emissionsUnrounded, 5);
    const loc = out.summary.reported.siteActivities.find(
      (s) => s.unitId === 'u-jp' && s.scope === 'scope2_location' && s.activityKind === 'heat',
    );
    expect(loc?.unrounded).toBeCloseTo(6, 12);
  });

  it('片方の基準の割当が無ければエラー（片方の基準にだけ入れない）', () => {
    const inputs = heatInputs();
    inputs.assignments = inputs.assignments.filter((a) => a.id !== 'A-HEAT-MKT');
    const out = calculateRun(inputs, OPTS);
    expect(out.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('購入した熱（マーケット基準）: 係数が割り当てられていません'),
    ]);
    expect(out.lines.some((l) => l.activityLineId === 'L-HEAT')).toBe(false);
  });
});
