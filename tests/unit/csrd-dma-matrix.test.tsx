import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DmaMatrix } from '@/app/enterprise/disclosures/csrd/settings/_components/dma-matrix';

/**
 * ダブル・マテリアリティのマトリクス（docs/disclosure-first.md §9.4）。
 * インパクト重要性（縦）× 財務的重要性（横）を、ラベル付き・表と同じ内容で示す。
 *  - 図は role="img" と名前・説明を持つ（説明に各事項のスコアと人の判断を書く）
 *  - 色だけに頼らない: 点には事項コードを書き、人の判断が未評価の事項は印の形を変えて凡例で説明する
 *  - 評価材料が無く配置できない事項は図の外に列挙する
 */

describe('DmaMatrix', () => {
  const props = {
    thresholds: { impactThreshold: 3.0, financialThreshold: 3.0 },
    inputs: [
      { topic: 'E1' as const, impactScore: 4.0, financialScore: 4.0, outcome: 'both' as const },
      {
        topic: 'G1' as const,
        impactScore: 2.2,
        financialScore: 3.2,
        outcome: 'not_assessed' as const,
      },
      {
        topic: 'S3' as const,
        impactScore: null,
        financialScore: 1.4,
        outcome: 'not_material' as const,
      },
    ],
  };

  it('図の名前と説明（各事項のスコア・人の判断）を持つ', () => {
    const { getByRole } = render(<DmaMatrix {...props} />);
    const figure = getByRole('img', { name: /ダブル・マテリアリティ・マトリクス/ });
    const description = figure.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    const desc = document.getElementById(description!)!;
    expect(desc.textContent).toContain(
      'E1 気候変動: インパクト 4.0・財務 4.0（人の判断: 両面で重要）',
    );
    expect(desc.textContent).toContain('G1 企業行動: インパクト 2.2・財務 3.2（人の判断: 未評価）');
  });

  it('軸の名前・閾値・点のラベルを描く', () => {
    const { container } = render(<DmaMatrix {...props} />);
    const svg = container.querySelector('svg')!;
    const text = svg.textContent ?? '';
    expect(text).toContain('インパクト重要性');
    expect(text).toContain('財務的重要性');
    expect(text).toContain('閾値 3.0');
    expect(text).toContain('E1');
    expect(text).toContain('G1');
    // 未評価の事項は破線の印
    expect(svg.querySelectorAll('[data-decided="false"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-decided="true"]')).toHaveLength(1);
  });

  it('凡例で印の形と象限の意味を説明し、配置できない事項を列挙する', () => {
    const { getByRole, getByText } = render(<DmaMatrix {...props} />);
    const legend = getByRole('list', { name: 'マトリクスの凡例' });
    expect(within(legend).getByText(/人の判断が未評価/)).toBeInTheDocument();
    expect(within(legend).getByText(/両面で重要（提案）/)).toBeInTheDocument();
    expect(getByText(/評価材料が無く配置できない事項/).textContent).toContain('S3');
  });
});
