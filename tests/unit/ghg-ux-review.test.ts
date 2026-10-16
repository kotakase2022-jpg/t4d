import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatUnrounded } from '@/app/enterprise/ghg/_components/calc-view';
import { activityImportStatusText } from '@/app/enterprise/ghg/calculation/activity/_components/activity-import-form';
import { missingMonthsTile } from '@/app/enterprise/ghg/calculation/activity/_lib/labels';
import { factorActivityName } from '@/lib/domain/ghg/labels';

/**
 * Scope1・2 の算定の画面の表示（自己監査 UX のレビュー指摘）:
 *  - UX-04: 検証拠点が無い組織で「未受領 0・すべて受領」と示さない
 *  - UX-05: 算定明細の係数・活動量を 3 桁に丸め直さない（0.000441 t-CO2/kWh を 0 と出さない）
 *  - UX-10: 取込の検証の結果を読み上げる
 *  - UX-12: 係数の表・取込の下見で活動を名前で出す（diesel ではなく軽油）
 */

describe('未受領の数（UX-04）', () => {
  it('検証拠点が無ければ「—」と「検証拠点が未設定」（すべて受領と言わない）', () => {
    expect(missingMonthsTile(0, 0)).toEqual({
      value: '—',
      status: { semantic: 'excluded', label: '検証拠点が未設定' },
    });
  });

  it('検証拠点があれば、未受領の月の数と状態', () => {
    expect(missingMonthsTile(5, 0)).toMatchObject({
      value: 0,
      unit: 'か月',
      status: { semantic: 'done', label: 'すべて受領' },
    });
    expect(missingMonthsTile(5, 3)).toMatchObject({ value: 3, status: { semantic: 'pending' } });
  });
});

describe('算定明細の係数・活動量の表示（UX-05）', () => {
  it('小さい係数を 0 にしない（未丸めの桁で出す）', () => {
    expect(formatUnrounded(0.000441)).toBe('0.000441');
    expect(formatUnrounded(2.631720666)).toBe('2.631720666');
  });

  it('算定明細の表は係数・活動量・換算後の量を既定の 3 桁の formatNumber で出さない', () => {
    const source = readFileSync('src/app/enterprise/ghg/calculation/runs/[runId]/page.tsx', 'utf8');
    for (const field of ['factorValue', 'activityAmount', 'convertedAmount']) {
      expect(source).not.toMatch(new RegExp(`formatNumber\\(line\\.${field}\\)`));
      expect(source).toMatch(new RegExp(`formatUnrounded\\(line\\.${field}\\)`));
    }
  });
});

describe('取込の読み上げ（UX-10）', () => {
  it('検証が通ったら取り込めることと行数を読み上げる。ファイルを選んだら名前を読み上げる', () => {
    expect(activityImportStatusText('輸送.csv', null, false)).toBe(
      'ファイル「輸送.csv」を選びました。',
    );
    expect(activityImportStatusText('輸送.csv', { canImport: true, rowCount: 24 }, true)).toContain(
      '取込可（24 行）',
    );
    expect(
      activityImportStatusText('輸送.csv', { canImport: false, rowCount: 24 }, true),
    ).toContain('取込不可');
    // 入力を変えた後（検証が古い）は結果を読み上げない
    expect(activityImportStatusText('輸送.csv', { canImport: true, rowCount: 24 }, false)).toBe(
      'ファイル「輸送.csv」を選びました。',
    );
    // 見えているバッジ・ファイルの欄と同じ文にしない（読み上げが重ならない）
    for (const text of [
      activityImportStatusText('輸送.csv', { canImport: true, rowCount: 24 }, true),
      activityImportStatusText('輸送.csv', { canImport: false, rowCount: 24 }, true),
      activityImportStatusText('輸送.csv', null, false),
    ]) {
      expect(text).not.toMatch(/取り込めます|取り込めません|選んだファイル:/);
    }
  });
});

describe('係数の活動の名前（UX-12）', () => {
  it('燃料・ガスはコードの名前、電力は系統か契約、知らないコードはコードのまま', () => {
    expect(factorActivityName('fuel', 'diesel')).toBe('軽油');
    expect(factorActivityName('gas', 'city_gas')).toBe('都市ガス');
    expect(factorActivityName('transport_formula', 'diesel')).toBe('軽油');
    expect(factorActivityName('electricity', 'grid')).toBe('電力（系統）');
    expect(factorActivityName('electricity', 'EAST-GREEN-01')).toBe('契約 EAST-GREEN-01');
    expect(factorActivityName('heat', 'heat')).toBe('熱');
    expect(factorActivityName('fuel', 'bio_x')).toBe('bio_x');
  });

  it('係数のセットの詳細・取込の下見は活動のコードをそのまま出さない', () => {
    for (const file of [
      'src/app/enterprise/ghg/calculation/factors/[setId]/page.tsx',
      'src/app/enterprise/ghg/calculation/factors/_components/factor-import-form.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('factorActivityName(');
      expect(source).not.toMatch(
        /<TD className="font-mono text-caption">\{f\.activityCode\}<\/TD>/,
      );
    }
  });
});
