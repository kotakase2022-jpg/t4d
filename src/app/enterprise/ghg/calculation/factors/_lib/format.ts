import { formatNumber } from '@/lib/format/datetime';
import type { EmissionFactor } from '@/types/domain';

/**
 * 係数の値の 1 行（P91・P92・P93 で同じ書き方）。表示で丸め直さない（保存した桁のまま。plan §2.0）。
 * 2 段係数は「単位発熱量 × 炭素排出係数」、改良トンキロ法は式・表であることだけを書く（中身は P92 の表）。
 */
export function factorValueText(factor: EmissionFactor): string {
  if (factor.activityKind === 'transport_formula')
    return '改良トンキロ法の式（燃費区分ごとの係数）';
  if (factor.activityKind === 'transport_default') return '見なし積載率の原単位表';
  if (factor.calorificValue !== null && factor.carbonFactor !== null) {
    return `${formatNumber(factor.calorificValue, { fraction: 12 })} ${factor.calorificUnit ?? ''} × ${formatNumber(factor.carbonFactor, { fraction: 12 })} ${factor.carbonFactorUnit ?? ''}`;
  }
  return `${formatNumber(factor.factorValue, { fraction: 12 })} ${factor.factorUnit}`;
}

/** 割当の選択肢の文（係数コード・名称・値・年度・国） */
export function factorOptionLabel(factor: EmissionFactor): string {
  const scope = [`${factor.factorYear} 年度`, factor.countryCode].filter(Boolean).join('・');
  return `${factor.code} ${factor.name}：${factorValueText(factor)}（${scope}）`;
}
