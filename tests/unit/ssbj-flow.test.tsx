import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SsbjFlow, currentStepIndex, type SsbjFlowStep } from '@/components/shared/ssbj-flow';

/**
 * 工程の帯（SSBJ・CSRD の対応状況）。「進行中」の工程は複数ありうるが、支援技術に伝える現在の工程
 * （aria-current="step"）は進行中の最初の 1 つだけにする（複数に付けると「現在のステップ」が何か所も
 * 読み上げられる。自己監査 F13）。題は省略せずに折り返す（1366px の 4 列で途中から見えなくならない）。
 */

const step = (title: string, state: SsbjFlowStep['state']): SsbjFlowStep => ({
  title,
  description: `${title}の説明`,
  state,
});

describe('工程の帯', () => {
  it('aria-current="step" は進行中の最初の工程 1 つだけ。進行中の表示（ラベル）はすべてに残す', () => {
    const steps = [
      step('設定（報告範囲・ダブル・マテリアリティ評価）', 'done'),
      step('要求事項の評価', 'current'),
      step('対応計画', 'current'),
      step('データ収集', 'todo'),
      step('開示ドラフト', 'current'),
    ];
    const { container } = render(<SsbjFlow steps={steps} />);
    const current = container.querySelectorAll('li[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('要求事項の評価');
    expect(screen.getAllByText('進行中')).toHaveLength(3);
    expect(currentStepIndex(steps)).toBe(1);
  });

  it('進行中が無ければ aria-current は付けない', () => {
    const { container } = render(
      <SsbjFlow steps={[step('設定', 'done'), step('要求事項の評価', 'todo')]} />,
    );
    expect(container.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('長い題は省略（truncate）せず折り返す', () => {
    render(<SsbjFlow steps={[step('設定（報告範囲・ダブル・マテリアリティ評価）', 'current')]} />);
    const title = screen.getByText('設定（報告範囲・ダブル・マテリアリティ評価）');
    expect(title.className).not.toContain('truncate');
    expect(title.className).toContain('break-words');
  });
});
