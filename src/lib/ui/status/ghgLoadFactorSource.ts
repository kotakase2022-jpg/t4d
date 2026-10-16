import type { StatusEntry } from './types';

/** 改良トンキロ法の積載率の出所（実測・見なし積載率の原単位表・下限を適用） */
export const GHG_LOAD_FACTOR_SOURCES = ['measured', 'default', 'floored'] as const;
export type GhgLoadFactorSource = (typeof GHG_LOAD_FACTOR_SOURCES)[number];

export const ghgLoadFactorSource: Record<GhgLoadFactorSource, StatusEntry> = {
  measured: { label: '実測', semantic: 'done' },
  default: {
    label: '見なし（原単位表）',
    semantic: 'blocked',
    description: '積載率が無いため、係数のセットの見なし積載率の原単位表で算定しました。',
  },
  floored: {
    label: '下限を適用',
    semantic: 'blocked',
    description: '積載率が下限より低いため、下限の値で算定しました。',
  },
};
