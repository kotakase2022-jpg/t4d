import { describe, expect, it } from 'vitest';
import { detectBoundaries, findBoundaryConflicts } from '@/lib/imports/boundary';

/**
 * バウンダリ（集計範囲）の検知。
 * 同じ指標に「正社員のみ」と「派遣を含む」のような範囲違いが混在したら、
 * 数字だけで丸めずに要確認へ倒すための規則。
 */
describe('detectBoundaries', () => {
  it('日本語の雇用範囲・管理職定義を拾う', () => {
    const found = detectBoundaries('本社 従業員数 480 人 FY2026 正社員のみ 課長相当職以上');
    expect(found).toContainEqual({ category: 'employment', label: '正社員のみ' });
    expect(found).toContainEqual({ category: 'manager', label: '課長相当職以上' });
    expect(found).toContainEqual({ category: 'period', label: '年度（4月起点）' });
  });

  it('多言語の宣言を同じ日本語ラベルへ正規化する', () => {
    expect(detectBoundaries('Officials and Managers (First/Mid-Level) CY2026')).toContainEqual({
      category: 'manager',
      label: 'EEO-1（Officials and Managers）',
    });
    expect(detectBoundaries('alle Führungsebenen einschließlich Teamleiter GJ2026')).toContainEqual(
      { category: 'manager', label: 'チームリーダーを含む' },
    );
    expect(detectBoundaries('在职员工含劳务派遣 主管以上')).toEqual(
      expect.arrayContaining([
        { category: 'employment', label: '派遣・臨時を含む' },
        { category: 'manager', label: '主管以上' },
      ]),
    );
    expect(detectBoundaries('Women in management Band 4 and above CY2026')).toContainEqual({
      category: 'manager',
      label: '社内等級基準（Band / Grade）',
    });
  });

  it('「平均」は賃金の文脈でだけ算定方法として扱う（平均勤続年数を誤検知しない）', () => {
    expect(
      detectBoundaries('平均勤続年数 12.8 年').filter((b) => b.category === 'method'),
    ).toHaveLength(0);
    expect(detectBoundaries('男女賃金格差 74.1 % 正社員のみ・平均値ベース')).toContainEqual({
      category: 'method',
      label: '平均値ベース',
    });
    expect(detectBoundaries('Gender pay gap (median hourly pay) 8.2 %')).toContainEqual({
      category: 'method',
      label: '中央値ベース',
    });
  });

  it('離職の範囲は離職の文脈でだけ拾う', () => {
    expect(
      detectBoundaries('離職率 6.2 % 自己都合のみ').filter((b) => b.category === 'turnover'),
    ).toEqual([{ category: 'turnover', label: '自己都合のみ' }]);
    expect(
      detectBoundaries('Turnover rate: voluntary + involuntary terminations').filter(
        (b) => b.category === 'turnover',
      ),
    ).toEqual([{ category: 'turnover', label: '会社都合・全事由を含む' }]);
  });
});

describe('findBoundaryConflicts', () => {
  const row = (id: string, metricId: string, fileName: string, text: string) => ({
    id,
    metricId,
    fileName,
    text,
  });

  it('同じ指標に雇用範囲の違う行が混在したら、双方に警告を付ける', () => {
    const conflicts = findBoundaryConflicts([
      row('r1', 'employees', 'HC01.csv', '従業員数 480 正社員のみ'),
      row('r2', 'employees', 'HC15.csv', '员工总数 380 含劳务派遣'),
    ]);
    expect(conflicts.get('r1')?.[0]).toContain('バウンダリ差異（雇用範囲）');
    expect(conflicts.get('r1')?.[0]).toContain('正社員のみ');
    expect(conflicts.get('r1')?.[0]).toContain('派遣・臨時を含む');
    expect(conflicts.get('r1')?.[0]).toContain('HC15.csv');
    expect(conflicts.get('r2')?.[0]).toContain('バウンダリ差異（雇用範囲）');
  });

  it('指標が違えば範囲が違っても衝突にしない', () => {
    const conflicts = findBoundaryConflicts([
      row('r1', 'employees', 'a.csv', '従業員数 480 正社員のみ'),
      row('r2', 'training_hours', 'b.csv', '人均培训时长 含劳务派遣'),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it('同じ範囲どうしなら衝突にしない', () => {
    const conflicts = findBoundaryConflicts([
      row('r1', 'employees', 'a.csv', '従業員数 480 正社員のみ'),
      row('r2', 'employees', 'b.csv', 'Total employees Regular full-time only'),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it('管理職定義の混在（課長以上 vs チームリーダー含む）を検知する', () => {
    const conflicts = findBoundaryConflicts([
      row('r1', 'female_manager_ratio', 'HC01.csv', '女性管理職比率 18.3 % 課長相当職以上'),
      row(
        'r2',
        'female_manager_ratio',
        'HC11.csv',
        'Frauenanteil in Führungspositionen alle Führungsebenen einschließlich Teamleiter',
      ),
    ]);
    expect(conflicts.get('r1')?.[0]).toContain('管理職の定義');
    expect(conflicts.get('r2')?.[0]).toContain('課長相当職以上');
  });

  it('期間の基準（年度 vs 暦年）の混在を検知する', () => {
    const conflicts = findBoundaryConflicts([
      row('r1', 'employees', 'a.csv', '従業員数 480 FY2026'),
      row('r2', 'employees', 'b.csv', 'Total workforce 2418 CY2026 calendar year'),
    ]);
    expect(conflicts.get('r1')?.[0]).toContain('期間の基準');
  });
});
