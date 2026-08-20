import { createRng } from '@/lib/fixtures/ids';
import type { SamplingMethod, SamplingParameters, Uuid } from '@/types/domain';

/**
 * サンプリング（指示書 16.6）。
 *
 * 最重要要件: **同一 Seed で完全に再現可能**であること。
 * `Math.random()` を使わず、Seed から生成した xorshift128 のみを使う。
 */

export interface SamplingCandidate {
  id: Uuid;
  value: number;
  stratum: string | null;
  label: string;
}

export interface SamplingSelection {
  populationItemId: Uuid;
  selectionReason: string;
  stratum: string | null;
  sortOrder: number;
}

export interface SamplingInput {
  candidates: SamplingCandidate[];
  method: SamplingMethod;
  seed: string;
  parameters: SamplingParameters;
}

/** Fisher–Yates（Seed 決定論的） */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function selectSample(input: SamplingInput): SamplingSelection[] {
  const { candidates, method, seed, parameters } = input;
  const eligible = candidates.filter((c) => Number.isFinite(c.value));
  const target = Math.max(0, Math.min(parameters.targetSize, eligible.length));
  const rng = createRng(`${method}:${seed}`);

  const build = (picked: SamplingCandidate[], reason: (c: SamplingCandidate) => string) =>
    picked.map((c, index) => ({
      populationItemId: c.id,
      selectionReason: reason(c),
      stratum: c.stratum,
      sortOrder: index,
    }));

  switch (method) {
    case 'random': {
      const picked = shuffle(eligible, rng).slice(0, target);
      return build(picked, () => `無作為抽出（Seed: ${seed}）`);
    }

    case 'stratified': {
      const key = parameters.strataKey ?? 'unit';
      const groups = new Map<string, SamplingCandidate[]>();
      for (const c of eligible) {
        const k = c.stratum ?? `(${key}未設定)`;
        const list = groups.get(k);
        if (list) list.push(c);
        else groups.set(k, [c]);
      }
      const strataNames = [...groups.keys()].sort();
      const perStratum =
        parameters.perStratum ?? Math.max(1, Math.ceil(target / Math.max(1, strataNames.length)));
      const picked: SamplingCandidate[] = [];
      for (const name of strataNames) {
        const group = groups.get(name) ?? [];
        picked.push(...shuffle(group, rng).slice(0, perStratum));
      }
      return build(
        picked.slice(0, target),
        (c) => `層化抽出（層: ${c.stratum ?? '—'} / Seed: ${seed}）`,
      );
    }

    case 'key_item': {
      const threshold = parameters.keyItemThreshold ?? 0;
      const keyItems = eligible
        .filter((c) => Math.abs(c.value) >= threshold)
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      const rest = eligible.filter((c) => Math.abs(c.value) < threshold);
      const filler = shuffle(rest, rng).slice(0, Math.max(0, target - keyItems.length));
      const picked = [...keyItems.slice(0, target), ...filler];
      return build(picked, (c) =>
        Math.abs(c.value) >= threshold
          ? `重要項目抽出（閾値 ${threshold} 以上）`
          : `重要項目抽出の補完（無作為 / Seed: ${seed}）`,
      );
    }

    case 'judgmental': {
      const selected = new Set(parameters.selectedItemIds ?? []);
      const picked = eligible.filter((c) => selected.has(c.id));
      return build(picked, () => '判断による抽出（選定理由は調書に記載）');
    }

    default: {
      const exhaustive: never = method;
      throw new Error(`Unsupported sampling method: ${String(exhaustive)}`);
    }
  }
}

/** 母集団の要約統計（Population 画面 / 完全性確認）。 */
export function summarizePopulation(items: Array<{ value: number; excluded: boolean }>): {
  itemCount: number;
  totalValue: number;
  excludedCount: number;
} {
  let total = 0;
  let excluded = 0;
  for (const item of items) {
    if (item.excluded) {
      excluded += 1;
      continue;
    }
    total += item.value;
  }
  return {
    itemCount: items.length,
    totalValue: Math.round(total * 1000) / 1000,
    excludedCount: excluded,
  };
}
