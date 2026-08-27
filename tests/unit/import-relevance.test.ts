import { describe, expect, it } from 'vitest';
import {
  buildMetricVocabulary,
  hasMeasurementUnit,
  irrelevantRowsNote,
  isRelevantToMetrics,
  IRRELEVANT_FILE_RATIO,
} from '@/lib/imports/relevance';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ORG_IDS } from '@/lib/fixtures/dataset';

/**
 * 指標マスターと無関係な行の判定。
 *
 * 1 行ずつ「指標を特定できませんでした」と言うと、本当に確認が要る行
 * （指標に近いのに特定できなかった行）が警告の山に埋もれる。
 * 一方、無関係と誤判定すると本物のデータが黙って消える。
 * どちらへ倒すかが判定の要点なので、両方向を検査する。
 */

const metrics = createFixtureDb().metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
const vocabulary = buildMetricVocabulary(metrics);

describe('関係あり（外してはいけない行）', () => {
  it('指標名がそのまま載っている行', () => {
    expect(isRelevantToMetrics({ 拠点: '本社', 項目: '電力使用量', 値: '120' }, vocabulary)).toBe(
      true,
    );
  });

  it('指標コードが載っている行', () => {
    expect(isRelevantToMetrics({ code: 'scope1', value: '3100' }, vocabulary)).toBe(true);
  });

  it('指標マスターに無い項目でも、計量単位が付いていれば残す', () => {
    // 「圧縮空気」は指標マスターに無いが、GJ が付いている以上
    // 人が指標を選べば取り込める行。黙って外すとデータが消える
    expect(
      isRelevantToMetrics(
        { 拠点: '西日本工場', 項目: '圧縮空気（購入分）', 値: '18.4', 単位: 'GJ' },
        vocabulary,
      ),
    ).toBe(true);
    expect(isRelevantToMetrics({ 項目: '蒸気', 値: '540', 単位: 't' }, vocabulary)).toBe(true);
  });

  it('数値と単位が同じセルに入っていても残す', () => {
    expect(isRelevantToMetrics({ 摘要: '当月実績', 数量: '1,240 kWh' }, vocabulary)).toBe(true);
  });

  it('項目名に心当たりが無くても、単位セルがあれば残す', () => {
    expect(isRelevantToMetrics({ 名称: 'ABC', 単位: 'kg' }, vocabulary)).toBe(true);
  });

  it('「単位」列があっても、中身が単位でなければ計量済みとみなさない', () => {
    // 名簿が「単位」列を持つ表に紛れ込むと、その列に「主任」が入る。
    // 列名で判定すると除外がまったく効かなくなる
    expect(hasMeasurementUnit({ 社員番号: 'A10231', 氏名: '山田 太郎', 単位: '主任' })).toBe(false);
  });

  it('文章の中に指標の語が含まれていても拾う', () => {
    expect(isRelevantToMetrics({ 備考: '当年度の電力使用量については再集計中' }, vocabulary)).toBe(
      true,
    );
  });

  it('英語の指標語彙でも拾う', () => {
    expect(isRelevantToMetrics({ item: 'Scope 3 emissions', qty: '900' }, vocabulary)).toBe(true);
  });
});

describe('無関係（静かに外してよい行）', () => {
  it('社員名簿の行', () => {
    expect(
      isRelevantToMetrics(
        { 社員番号: 'A10231', 氏名: '山田 太郎', 所属: '第一営業部', 役職: '主任' },
        vocabulary,
      ),
    ).toBe(false);
  });

  it('住所録の行', () => {
    expect(
      isRelevantToMetrics(
        { 取引先: '株式会社サンプル', 住所: '東京都千代田区1-1-1', 電話: '03-0000-0000' },
        vocabulary,
      ),
    ).toBe(false);
  });

  it('改版履歴の行', () => {
    expect(
      isRelevantToMetrics({ 版: '1.2', 更新者: '経営企画部', 内容: '様式の見直し' }, vocabulary),
    ).toBe(false);
  });

  it('空の行', () => {
    expect(isRelevantToMetrics({ a: '', b: '   ' }, vocabulary)).toBe(false);
  });
});

describe('計量単位の検出', () => {
  it('単位セルを見つける', () => {
    expect(hasMeasurementUnit({ 単位: 'MWh' })).toBe(true);
    expect(hasMeasurementUnit({ uom: 't-CO2e' })).toBe(true);
    expect(hasMeasurementUnit({ x: '㎥' })).toBe(true);
  });

  it('全角・大文字小文字の違いを吸収する', () => {
    expect(hasMeasurementUnit({ x: 'ＭＷｈ' })).toBe(true);
    expect(hasMeasurementUnit({ x: '％' })).toBe(true);
  });

  it('単位でない語を単位と誤認しない', () => {
    expect(hasMeasurementUnit({ 氏名: '山田 太郎', 所属: '第一営業部' })).toBe(false);
    expect(hasMeasurementUnit({ 版: '1.2', 内容: '様式の見直し' })).toBe(false);
  });
});

describe('ファイルごと無関係の閾値', () => {
  it('黙って外すのは少数のときだけにする', () => {
    // 8 割を超えたら人へ伝える。判定が壊れていたときに気づけるようにするため
    expect(IRRELEVANT_FILE_RATIO).toBeLessThanOrEqual(0.8);
    expect(IRRELEVANT_FILE_RATIO).toBeGreaterThan(0.5);
  });

  it('外した件数は必ず件数として伝える', () => {
    expect(irrelevantRowsNote(3)).toContain('3 行');
    expect(irrelevantRowsNote(3)).toContain('対象外');
  });
});
