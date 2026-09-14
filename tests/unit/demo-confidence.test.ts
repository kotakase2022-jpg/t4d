import { describe, expect, it } from 'vitest';
import {
  DEMO_CONFIDENCE_MAX,
  DEMO_CONFIDENCE_MIN,
  demoDisplayConfidence,
  resolveDisplayConfidence,
} from '@/lib/domain/demo-confidence';

/**
 * デモ表示用の信頼度変換（村田デモ要件: 表示 80〜97%）。
 *
 * 確かめたいこと:
 *  - 決定論: 同じ raw × 同じキーなら何度呼んでも同じ表示値（乱数を引かない）
 *  - 範囲: 正常 raw は必ず 80〜97% に収まる（100% 固定・全件同値にならない）
 *  - 分布: raw の広がりに応じて 80% 台と 97% の両端が実際に現れる
 *  - 欠損・NaN・範囲外の raw は変換せず null（数値化で正常扱いしない）
 *  - demo モード以外では変換せず raw をそのまま返す（実測の維持）
 */

describe('demoDisplayConfidence', () => {
  it('同じ入力なら常に同じ値（決定論）', () => {
    const a = demoDisplayConfidence(0.66, 'file.xlsx|Sheet1!行 12|label');
    const b = demoDisplayConfidence(0.66, 'file.xlsx|Sheet1!行 12|label');
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('キーが違えば（同じ raw でも）値が揺れるが、範囲内に収まる', () => {
    const values = Array.from({ length: 50 }, (_, i) => demoDisplayConfidence(0.7, `key-${i}`));
    const unique = new Set(values.map((v) => Math.round((v ?? 0) * 100)));
    expect(unique.size).toBeGreaterThan(3);
    for (const v of values) {
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(DEMO_CONFIDENCE_MIN);
      expect(v!).toBeLessThanOrEqual(DEMO_CONFIDENCE_MAX);
    }
  });

  it('raw が広く分布しても両端は 80〜97 に収まる', () => {
    const raws = Array.from({ length: 200 }, (_, i) => 0.3 + (i / 199) * 0.68);
    const shown = raws.map((raw, i) => Math.round(demoDisplayConfidence(raw, `row-${i}`)! * 100));
    expect(Math.min(...shown)).toBeGreaterThanOrEqual(80);
    expect(Math.max(...shown)).toBe(97);
  });

  it('現実的な raw 分布では 90〜96% が中心になり、80% 台と 97% も一部現れる', () => {
    // 取込ルーブリック相当: 中位〜高位が厚く、低位と最上位が少数
    const raws = [
      ...Array.from({ length: 120 }, (_, i) => 0.62 + (i / 119) * 0.28), // 0.62〜0.90
      ...Array.from({ length: 40 }, (_, i) => 0.45 + (i / 39) * 0.15), // 0.45〜0.60
      ...Array.from({ length: 40 }, (_, i) => 0.9 + (i / 39) * 0.08), // 0.90〜0.98
    ];
    const shown = raws.map((raw, i) => Math.round(demoDisplayConfidence(raw, `mix-${i}`)! * 100));
    const inCenter = shown.filter((v) => v >= 90 && v <= 96).length;
    expect(inCenter).toBeGreaterThan(shown.length / 2);
    expect(shown.some((v) => v >= 80 && v <= 89)).toBe(true);
    expect(shown.some((v) => v === 97)).toBe(true);
    expect(new Set(shown).size).toBeGreaterThan(5);
  });

  it('高い raw ほど高い表示（同キーでの単調性）', () => {
    const low = demoDisplayConfidence(0.4, 'k')!;
    const high = demoDisplayConfidence(0.95, 'k')!;
    expect(high).toBeGreaterThan(low);
  });

  it('欠損・NaN・範囲外は変換しない（null）', () => {
    expect(demoDisplayConfidence(null, 'k')).toBeNull();
    expect(demoDisplayConfidence(undefined, 'k')).toBeNull();
    expect(demoDisplayConfidence(Number.NaN, 'k')).toBeNull();
    expect(demoDisplayConfidence(-0.1, 'k')).toBeNull();
    expect(demoDisplayConfidence(1.2, 'k')).toBeNull();
  });
});

describe('resolveDisplayConfidence（モードで出し分け）', () => {
  it('demo モードでは表示値がシミュレーションになり、raw を保持する', () => {
    const r = resolveDisplayConfidence('demo', 0.66, 'key');
    expect(r.source).toBe('demo_simulated');
    expect(r.raw).toBe(0.66);
    expect(r.display).toBeGreaterThanOrEqual(DEMO_CONFIDENCE_MIN);
    expect(r.display).toBeLessThanOrEqual(DEMO_CONFIDENCE_MAX);
  });

  it('demo モード以外では実測値をそのまま表示に使う', () => {
    const r = resolveDisplayConfidence('supabase', 0.66, 'key');
    expect(r).toEqual({ display: 0.66, raw: 0.66, source: 'measured' });
  });

  it('raw が無い行はどちらのモードでも捏造しない', () => {
    expect(resolveDisplayConfidence('demo', null, 'key')).toEqual({
      display: null,
      raw: null,
      source: 'measured',
    });
  });
});
