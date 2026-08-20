import { describe, expect, it } from 'vitest';
import { selectSample, summarizePopulation, type SamplingCandidate } from '@/lib/services/sampling';

/**
 * サンプリングの再現性（指示書 16.6「Random Sampling は同じ Seed で再現可能にしてください」）。
 */

function candidates(count: number): SamplingCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    value: (i + 1) * 100,
    stratum: i % 3 === 0 ? '本社' : i % 3 === 1 ? '東日本工場' : '西日本工場',
    label: `item-${i}`,
  }));
}

describe('無作為抽出', () => {
  it('同じ Seed なら完全に同じサンプルを返す', () => {
    const input = {
      candidates: candidates(50),
      method: 'random' as const,
      seed: 'ENG-2026-001-S1',
      parameters: { targetSize: 10 },
    };
    const first = selectSample(input);
    const second = selectSample(input);
    expect(first.map((s) => s.populationItemId)).toEqual(second.map((s) => s.populationItemId));
  });

  it('Seed が違えば異なるサンプルになる', () => {
    const base = {
      candidates: candidates(50),
      method: 'random' as const,
      parameters: { targetSize: 10 },
    };
    const a = selectSample({ ...base, seed: 'seed-A' });
    const b = selectSample({ ...base, seed: 'seed-B' });
    expect(a.map((s) => s.populationItemId)).not.toEqual(b.map((s) => s.populationItemId));
  });

  it('指定件数だけ、重複なく抽出する', () => {
    const result = selectSample({
      candidates: candidates(20),
      method: 'random',
      seed: 's',
      parameters: { targetSize: 7 },
    });
    expect(result).toHaveLength(7);
    expect(new Set(result.map((r) => r.populationItemId)).size).toBe(7);
  });

  it('母集団より大きい件数を要求しても母集団サイズを超えない', () => {
    const result = selectSample({
      candidates: candidates(5),
      method: 'random',
      seed: 's',
      parameters: { targetSize: 99 },
    });
    expect(result).toHaveLength(5);
  });

  it('選定理由に Seed を含める（調書に残すため）', () => {
    const result = selectSample({
      candidates: candidates(5),
      method: 'random',
      seed: 'SEED-XYZ',
      parameters: { targetSize: 2 },
    });
    expect(result[0]?.selectionReason).toContain('SEED-XYZ');
  });
});

describe('層化抽出', () => {
  it('各層から指定件数ずつ抽出する', () => {
    const result = selectSample({
      candidates: candidates(30),
      method: 'stratified',
      seed: 's',
      parameters: { targetSize: 9, strataKey: 'unit', perStratum: 3 },
    });
    const byStratum = new Map<string, number>();
    for (const item of result) {
      const key = item.stratum ?? '';
      byStratum.set(key, (byStratum.get(key) ?? 0) + 1);
    }
    expect([...byStratum.values()].every((v) => v <= 3)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(9);
  });

  it('同じ Seed で再現可能', () => {
    const input = {
      candidates: candidates(30),
      method: 'stratified' as const,
      seed: 'stratified-seed',
      parameters: { targetSize: 9, perStratum: 3 },
    };
    expect(selectSample(input)).toEqual(selectSample(input));
  });
});

describe('重要項目抽出', () => {
  it('閾値以上の項目を優先し、不足分を無作為で補完する', () => {
    // 値は 100..2000。閾値 1700 以上は 1700/1800/1900/2000 の 4 件。
    const result = selectSample({
      candidates: candidates(20),
      method: 'key_item',
      seed: 's',
      parameters: { targetSize: 5, keyItemThreshold: 1700 },
    });
    const keyItems = result.filter((r) => r.selectionReason.includes('重要項目抽出（閾値'));
    const filler = result.filter((r) => r.selectionReason.includes('補完'));
    expect(keyItems).toHaveLength(4);
    expect(filler).toHaveLength(1);
    expect(result).toHaveLength(5);
  });
});

describe('判断による抽出', () => {
  it('指定された項目だけを返す', () => {
    const result = selectSample({
      candidates: candidates(10),
      method: 'judgmental',
      seed: 's',
      parameters: { targetSize: 10, selectedItemIds: ['item-2', 'item-5'] },
    });
    expect(result.map((r) => r.populationItemId).sort()).toEqual(['item-2', 'item-5']);
  });
});

describe('母集団サマリ', () => {
  it('除外項目を合計から外す', () => {
    const summary = summarizePopulation([
      { value: 100, excluded: false },
      { value: 200, excluded: false },
      { value: 999, excluded: true },
    ]);
    expect(summary.itemCount).toBe(3);
    expect(summary.totalValue).toBe(300);
    expect(summary.excludedCount).toBe(1);
  });
});
