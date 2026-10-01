import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FlashMessage } from '@/components/shared/flash';
import { DemoResetCard } from '@/app/enterprise/dashboard/disclosure-home-view';
import {
  PreservingForm,
  restoreFormValues,
  syncConditionalRequired,
} from '@/components/shared/preserving-form';
import {
  CoverageStatusBadge,
  PlanPriorityBadge,
} from '@/app/enterprise/disclosures/csrd/_components/csrd-badges';
import { formFailure, type FormActionState } from '@/lib/errors/form-action-state';

vi.mock('@/app/enterprise/dashboard/actions', () => ({ resetDisclosureDemoAction: vi.fn() }));

/**
 * CSRD の自己監査（2026-10-01）で直した画面の小さな規則の回帰テスト。
 */

const flashText = (params: Record<string, string>) => {
  render(<FlashMessage searchParams={params} />);
  return screen.getByRole('status').textContent ?? '';
};

describe('F1 開示デモのリセットは、戻す範囲（CSRD を含む）をすべて示す', () => {
  it('リセットのカードは CSRD の設定・DMA・評価・計画・ドラフト・収集項目・AI 実行記録も戻すと書く', () => {
    render(<DemoResetCard />);
    const text = document.body.textContent ?? '';
    for (const word of [
      'CSRD の設定（報告範囲・評価方法）',
      'ダブル・マテリアリティ評価（DMA）',
      '要求事項の評価',
      '対応計画',
      '開示ドラフト',
      '計画から作った収集項目',
      'AI',
    ]) {
      expect(text, word).toContain(word);
    }
    expect(screen.getByLabelText('上記の範囲だけを初期状態へ戻すことを確認しました')).toBeTruthy();
  });

  it('リセットのフラッシュも CSRD を戻したことを伝える', () => {
    const text = flashText({ flash: 'disclosureDemoReset', removed: '3', restored: '2' });
    expect(text).toContain('CSRD の設定・DMA・要求事項の評価・対応計画・開示ドラフト');
    expect(text).toContain('CSRD の AI 実行記録');
  });
});

describe('F10・F7 実際に起きたことだけを伝える', () => {
  it('両軸を未評価に戻したときは「判断者と日時を記録しました」と言わない', () => {
    const text = flashText({ flash: 'csrdMatterCleared' });
    expect(text).toContain('未評価に戻しました');
    expect(text).not.toContain('記録しました');
  });

  it('既存の割当を使ったときは「作成しました」と言わない。計画の状況が変わらなければ「対応中になりました」と言わない', () => {
    const linked = flashText({
      flash: 'csrdCollectionLinked',
      code: 'female_manager_ratio',
      plan: 'unchanged',
    });
    expect(linked).toContain('既にあったため、新しくは作らず');
    expect(linked).not.toContain('作成しました');
    expect(linked).not.toContain('対応中');
  });

  it('新しく作り、計画が未着手から対応中へ進んだときだけ、その旨を伝える', () => {
    const { unmount } = render(
      <FlashMessage
        searchParams={{
          flash: 'csrdCollectionCreated',
          code: 'scope2_location',
          plan: 'in_progress',
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('対応計画は「対応中」になりました');
    unmount();
    const unchanged = flashText({
      flash: 'csrdCollectionCreated',
      code: 'scope2_location',
      plan: 'unchanged',
    });
    expect(unchanged).not.toContain('「対応中」になりました');
  });
});

describe('F4・F11 AI の出所は実行した提供元で示す', () => {
  it.each([
    ['csrdGapAnalyzed', 'AI ギャップ分析を実行しました'],
    ['csrdDraftGenerated', 'AI 草案を作成しました'],
  ])('%s: OpenAI の実行は「AI 生成」、Mock の実行だけを「デモ生成」と書く', (flash, head) => {
    const { unmount } = render(<FlashMessage searchParams={{ flash, ai: 'openai' }} />);
    const openai = screen.getByRole('status').textContent ?? '';
    expect(openai).toContain(`${head}（AI 生成）`);
    expect(openai).not.toContain('デモ生成');
    unmount();
    expect(flashText({ flash, ai: 'mock' })).toContain(`${head}（デモ生成）`);
  });
});

describe('F6 状態のバッジはラベルとアイコンを併記する', () => {
  it('対応状況・優先度のバッジはアイコン（読み上げない）とラベルを持つ', () => {
    render(
      <>
        <CoverageStatusBadge status="partial" prefix="データ" />
        <PlanPriorityBadge priority="high" />
      </>,
    );
    for (const label of ['データ: 一部対応', '優先度: 高']) {
      const badge = screen.getByText(
        (_, element) => element?.textContent === label && element.tagName !== 'BODY',
      );
      const icon = badge.querySelector('svg');
      expect(icon, label).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('F2・F8 入力を残すフォーム', () => {
  function sampleForm(): HTMLFormElement {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="hidden" name="topic" value="G1" />
      <label><input type="radio" name="impactAssessment" value="material" /></label>
      <label><input type="radio" name="impactAssessment" value="not_material" checked /></label>
      <label><input type="radio" name="impactAssessment" value="not_assessed" /></label>
      <textarea name="impactRationale" data-required-if="impactAssessment=material|not_material"></textarea>
      <select name="unitId"><option value="a">A</option><option value="b">B</option></select>
      <input type="checkbox" name="requiresEvidence" checked />
    `;
    document.body.appendChild(form);
    return form;
  }

  it('送った値を戻す（ラジオ・テキスト・選択・チェック）。隠し項目は表示時の値のまま', () => {
    const form = sampleForm();
    restoreFormValues(form, [
      ['topic', 'E1'],
      ['impactAssessment', 'material'],
      ['impactRationale', '書いた根拠'],
      ['unitId', 'b'],
    ]);
    const field = (name: string) => form.elements.namedItem(name);
    expect((field('topic') as HTMLInputElement).value).toBe('G1');
    expect((form.querySelector('input[value="material"]') as HTMLInputElement).checked).toBe(true);
    expect((field('impactRationale') as HTMLTextAreaElement).value).toBe('書いた根拠');
    expect((field('unitId') as HTMLSelectElement).value).toBe('b');
    // 送らなかったチェックボックスは外す（外して送った値を戻す）
    expect((field('requiresEvidence') as HTMLInputElement).checked).toBe(false);
    form.remove();
  });

  it('「重要」「重要でない」を選んだときだけ根拠を必須にする', () => {
    const form = sampleForm();
    syncConditionalRequired(form);
    const rationale = form.elements.namedItem('impactRationale') as HTMLTextAreaElement;
    expect(rationale.required).toBe(true);
    (form.querySelector('input[value="not_assessed"]') as HTMLInputElement).checked = true;
    syncConditionalRequired(form);
    expect(rationale.required).toBe(false);
    form.remove();
  });

  it('サーバーが断ったら、理由を示して入力を残す（リダイレクトで消さない）', async () => {
    const action = vi.fn(
      async (_previous: FormActionState, formData: FormData): Promise<FormActionState> =>
        formFailure('財務の判断の根拠を入力してください。', formData),
    );
    render(
      <PreservingForm action={action} aria-label="判断">
        <textarea name="impactRationale" aria-label="インパクトの根拠" defaultValue="" />
        <button type="submit">判断を保存</button>
      </PreservingForm>,
    );
    const textarea = screen.getByRole('textbox', { name: 'インパクトの根拠' });
    fireEvent.change(textarea, { target: { value: '書いた根拠（テスト）' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: '判断' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '財務の判断の根拠を入力してください。（入力は残っています）',
    );
    const form = screen.getByRole('form', { name: '判断' });
    expect(form.getAttribute('aria-describedby')).toBe(alert.id);
    expect(
      (within(form).getByRole('textbox', { name: 'インパクトの根拠' }) as HTMLTextAreaElement)
        .value,
    ).toBe('書いた根拠（テスト）');
    expect(action).toHaveBeenCalledTimes(1);
  });
});
