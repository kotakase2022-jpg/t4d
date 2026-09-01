import { describe, expect, it } from 'vitest';
import { suggestMaterialityCategory } from '@/lib/domain/materiality-suggest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ORG_IDS } from '@/lib/fixtures/dataset';

/**
 * 自由記述のマテリアリティ名 → 区分の提示。
 *
 * 提示するだけで決めない（選ぶのは利用者）ことと、
 * 提示の根拠（一致した語）が返ることを検査する。
 */

describe('区分の提示', () => {
  it('気候の語からは環境を最有力にする', () => {
    const s = suggestMaterialityCategory('気候変動に伴う炭素価格の上昇');
    expect(s.top).toBe('environment');
    expect(s.candidates[0]?.category).toBe('environment');
    // 根拠となる一致語が返る
    expect(s.candidates[0]?.matched.length).toBeGreaterThan(0);
    // 気候の課題は気候関連開示基準のヒントが付く
    expect(s.candidates[0]?.ssbjHint).toContain('気候関連開示基準');
  });

  it('人材の語からは社会を最有力にする', () => {
    const s = suggestMaterialityCategory('熟練技術者の確保と定着');
    expect(s.top).toBe('social');
    expect(s.candidates[0]?.metricCodes).toContain('turnover_rate');
  });

  it('ガバナンスの語からはガバナンスを最有力にする', () => {
    const s = suggestMaterialityCategory('腐敗防止とコンプライアンス体制');
    expect(s.top).toBe('governance');
    expect(s.candidates[0]?.metricCodes).toContain('corruption_cases');
  });

  it('判断できない入力では最有力を出さない（決めるのは利用者）', () => {
    const s = suggestMaterialityCategory('新しい取り組み');
    expect(s.top).toBeNull();
    // それでも 3 区分すべてが候補として返り、利用者が選べる
    expect(s.candidates).toHaveLength(3);
  });

  it('空文字・空白のみでも壊れない', () => {
    for (const input of ['', '   ', '\n']) {
      const s = suggestMaterialityCategory(input);
      expect(s.top).toBeNull();
      expect(s.candidates).toHaveLength(3);
    }
  });

  it('全角英数・大文字小文字の揺れを吸収する', () => {
    expect(suggestMaterialityCategory('ＧＨＧ排出の削減').top).toBe('environment');
    expect(suggestMaterialityCategory('CO2 ネットゼロ').top).toBe('environment');
  });

  it('提示する指標コードはすべて指標マスターに実在する', () => {
    const metrics = createFixtureDb().metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
    const known = new Set(metrics.map((m) => m.code));
    const inputs = [
      '気候変動（GHG 排出）',
      '水資源の利用',
      '資源循環・廃棄物',
      '人的資本（人材の育成・多様性）',
      '労働安全衛生',
      'サプライチェーン管理',
      'コーポレートガバナンス',
      '再生可能エネルギーへの転換',
      '女性活躍とジェンダー平等',
      '人権デューデリジェンス',
      '育児と仕事の両立支援',
      '情報セキュリティとデータ保護',
    ];
    for (const input of inputs) {
      for (const candidate of suggestMaterialityCategory(input).candidates) {
        for (const code of candidate.metricCodes) {
          expect(known.has(code), `${input} → ${code} がマスターに無い`).toBe(true);
        }
      }
    }
  });

  it('複数の区分に一致する入力では、一致の多い区分を上にする', () => {
    // 「サプライチェーンにおける人権と調達」は社会の語が複数一致する
    const s = suggestMaterialityCategory('サプライチェーンにおける人権と調達方針');
    expect(s.candidates[0]?.category).toBe('social');
    expect(s.candidates[0]?.matched.length).toBeGreaterThanOrEqual(2);
  });
});

describe('名前と内容を合わせた判断', () => {
  it('名前だけでは判断できなくても、内容の説明から区分を提示できる', () => {
    // 名前は一般語のみ
    expect(suggestMaterialityCategory('サプライヤーとの協働').top).toBe('social');
    const withDescription = suggestMaterialityCategory(
      '新しい取り組み',
      '調達先の労働環境が悪化すると部品供給が止まる',
    );
    expect(withDescription.top).toBe('social');
    expect(withDescription.candidates[0]?.matched.length).toBeGreaterThan(0);
  });

  it('リスク・機会の記述も判断材料にできる（可変長引数）', () => {
    const s = suggestMaterialityCategory(
      '事業構造の転換',
      '',
      '炭素価格の上昇で製造原価が増える',
      '低炭素製品の需要が拡大する',
    );
    expect(s.top).toBe('environment');
  });

  it('内容が空でも名前だけで従来どおり動く', () => {
    expect(suggestMaterialityCategory('労働安全衛生', '').top).toBe('social');
  });
});
