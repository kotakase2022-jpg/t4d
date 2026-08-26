import { describe, expect, it } from 'vitest';
import { classifyRowRole, classifyRowRoles } from '@/lib/imports/row-role';

/**
 * 人事システムの帳票は、明細行と同じ列構成で「小計」「合計」行を吐く
 * （奉行の「計行出力」は既定で ON）。明細と合計を両方確定すると二重計上になる。
 *
 * ここでは「行の種別」を規則ベースで判定する。誤って明細を合計だと判定すると
 * 本物のデータが確定されなくなるため、ガードの検証を厚くしている。
 */

const row = (cells: Record<string, string>) => cells;

describe('classifyRowRole', () => {
  it('日本語の集計行を拾う', () => {
    expect(classifyRowRole(row({ 部門: '小計', 在籍者数: '58' }))).toBe('total');
    expect(classifyRowRole(row({ 部門: '合計', 在籍者数: '506' }))).toBe('total');
    expect(classifyRowRole(row({ 部門: '総計', 在籍者数: '1240' }))).toBe('total');
    expect(classifyRowRole(row({ 部門: '＜総合計＞', 在籍者数: '1240' }))).toBe('total');
    expect(classifyRowRole(row({ 部門: '第一営業部 計', 在籍者数: '58' }))).toBe('total');
  });

  it('多言語の集計行を拾う', () => {
    expect(classifyRowRole(row({ Department: 'Total', Headcount: '214' }))).toBe('total');
    expect(classifyRowRole(row({ Department: 'Subtotal', Headcount: '58' }))).toBe('total');
    expect(classifyRowRole(row({ Department: 'Grand Total', Headcount: '214' }))).toBe('total');
    expect(classifyRowRole(row({ Category: 'Report Totals', Headcount: '214' }))).toBe('total');
    expect(classifyRowRole(row({ Abteilung: 'Gesamtsumme', Anzahl: '142' }))).toBe('total');
    expect(classifyRowRole(row({ Abteilung: 'Zwischensumme', Anzahl: '48' }))).toBe('total');
    expect(classifyRowRole(row({ Service: 'Total général', Effectif: '118' }))).toBe('total');
    expect(classifyRowRole(row({ Service: 'Sous-total', Effectif: '40' }))).toBe('total');
    expect(classifyRowRole(row({ 部门名称: '合计', 在册人数: '310' }))).toBe('total');
    expect(classifyRowRole(row({ 部门名称: '小计', 在册人数: '96' }))).toBe('total');
  });

  it('注記・フッター行を拾う', () => {
    expect(classifyRowRole(row({ 列1: '※ 派遣社員は含みません。' }))).toBe('note');
    expect(classifyRowRole(row({ 列1: '注) 基準日は 2027-03-31 です。' }))).toBe('note');
    expect(classifyRowRole(row({ 列1: '以上' }))).toBe('note');
    expect(
      classifyRowRole(row({ 列1: 'Note: Officials and Managers includes first-level.' })),
    ).toBe('note');
    expect(classifyRowRole(row({ 列1: 'End of report' }))).toBe('note');
    expect(classifyRowRole(row({ 列1: 'レコード件数: 312' }))).toBe('note');
    expect(classifyRowRole(row({ 列1: 'Total records: 96' }))).toBe('note');
  });

  it('明細行は detail のまま', () => {
    expect(classifyRowRole(row({ 部門: '第一営業部', 在籍者数: '34' }))).toBe('detail');
    expect(classifyRowRole(row({ Department: 'Sales', Headcount: '34' }))).toBe('detail');
    expect(classifyRowRole(row({ 部門: '東日本工場', 在籍者数: '494' }))).toBe('detail');
  });

  // --- 誤検知のガード（本物のデータを合計と誤認しないこと） ---

  it('列名に「合計」があっても明細行を合計にしない', () => {
    // 給与明細の「支給合計」列。値が入っているだけで、行の種別は明細
    expect(classifyRowRole(row({ 社員番号: '0001', 氏名: '山田 太郎', 支給合計: '282450' }))).toBe(
      'detail',
    );
    expect(classifyRowRole(row({ 'Employee ID': 'E-001', 'Total Comp (USD)': '128000' }))).toBe(
      'detail',
    );
  });

  it('氏名や部署名に「計」が含まれても合計にしない', () => {
    expect(classifyRowRole(row({ 部門: '設計部', 在籍者数: '42' }))).toBe('detail');
    expect(classifyRowRole(row({ 部門: '生産技術部 設計課', 在籍者数: '18' }))).toBe('detail');
    expect(classifyRowRole(row({ 社員番号: '0007', 氏名: '計良 健一', 等級: 'M2' }))).toBe(
      'detail',
    );
  });

  it('数値をまったく持たない行は集計行にしない（見出しの再掲など）', () => {
    expect(classifyRowRole(row({ 部門: '合計', 在籍者数: '' }))).not.toBe('total');
  });

  it('セル内の長文に「合計」が出てきても合計にしない', () => {
    expect(
      classifyRowRole(
        row({
          備考: '本表の合計は速報値であり、確定値は月次締め後に更新されます。',
          人数: '12',
        }),
      ),
    ).toBe('detail');
  });
});

describe('classifyRowRoles（表全体での判定）', () => {
  it('先頭のデータ行は合計にしない（合計だけの表を誤って全滅させない）', () => {
    const roles = classifyRowRoles([
      row({ 区分: '合計', 人数: '100' }),
      row({ 区分: '合計', 人数: '200' }),
    ]);
    // 全部が「合計」に見える表は、集計行の判定を諦めて明細として扱う
    expect(roles).toEqual(['detail', 'detail']);
  });

  it('集計行の比率が高すぎる表では判定を諦める', () => {
    const rows = [
      row({ 区分: '小計', 人数: '10' }),
      row({ 区分: '小計', 人数: '20' }),
      row({ 区分: '営業部', 人数: '30' }),
      row({ 区分: '合計', 人数: '60' }),
    ];
    // 4 行中 3 行が集計 → 判定が壊れている可能性が高いので明細へ戻す
    expect(classifyRowRoles(rows).every((r) => r === 'detail')).toBe(true);
  });

  it('通常の表では明細と集計を正しく分ける', () => {
    const rows = [
      row({ 部門: '第一営業部', 人数: '34' }),
      row({ 部門: '第二営業部', 人数: '28' }),
      row({ 部門: '小計', 人数: '62' }),
      row({ 部門: '生産技術部', 人数: '44' }),
      row({ 部門: '合計', 人数: '106' }),
      row({ 部門: '※ 派遣社員を除く', 人数: '' }),
    ];
    expect(classifyRowRoles(rows)).toEqual([
      'detail',
      'detail',
      'total',
      'detail',
      'total',
      'note',
    ]);
  });
});
