import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';

/**
 * フォームの部品（plan §1.13・§3.5 field）。必須と任意を文字で分け、required 属性と表示を一致させる。
 * 説明・エラーは aria-describedby で入力欄に結び付ける。
 */

describe('Field', () => {
  it('必須の項目: ラベルに「必須」の文字、入力欄に required', () => {
    render(
      <Field label="指標名" name="name" required>
        {(p) => <Input name="name" {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText(/指標名/);
    expect(input).toBeRequired();
    expect(screen.getByText('必須')).toHaveAttribute('data-requirement', 'required');
  });

  it('任意の項目: ラベルに「任意」の文字、required は付かない', () => {
    render(
      <Field label="説明" name="description">
        {(p) => <Input name="description" {...p} />}
      </Field>,
    );
    expect(screen.getByLabelText(/説明/)).not.toBeRequired();
    expect(screen.getByText('任意')).toHaveAttribute('data-requirement', 'optional');
  });

  it('説明とエラーを aria-describedby で結び、エラーのときは aria-invalid', () => {
    render(
      <Field
        label="基準値"
        name="baseValue"
        required
        hint="基準年の実績値"
        error="数値を入力してください"
      >
        {(p) => <Input name="baseValue" {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText(/基準値/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const ids = input.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      '基準年の実績値',
      '数値を入力してください',
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('数値を入力してください');
  });

  it('選択（NativeSelect）でも同じ規則が通る', () => {
    render(
      <Field label="単位" name="unit" required>
        {(p) => (
          <NativeSelect name="unit" {...p}>
            <option value="kWh">kWh</option>
          </NativeSelect>
        )}
      </Field>,
    );
    expect(screen.getByLabelText(/単位/).tagName).toBe('SELECT');
    expect(screen.getByLabelText(/単位/)).toBeRequired();
  });

  it('NativeCheckbox は文字まで押せる（label で包む）', () => {
    render(<NativeCheckbox name="includeDataPoints" label="数値データも戻す" />);
    expect(screen.getByLabelText('数値データも戻す')).toHaveAttribute('type', 'checkbox');
  });
});

describe('FormSection', () => {
  it('必須の節は常に開いた fieldset、任意の節は既定で閉じた details', () => {
    const { container } = render(
      <form>
        <FormSection title="基本情報" kind="required">
          <Input name="a" aria-label="a" />
        </FormSection>
        <FormSection title="詳細設定" kind="optional">
          <Input name="b" aria-label="b" />
        </FormSection>
      </form>,
    );
    expect(screen.getByRole('group', { name: /基本情報/ })).toBeInTheDocument();
    const details = container.querySelector(
      'details[data-form-section="optional"]',
    ) as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('任意');
  });

  it('値やエラーがあるときは任意の節を開いて描ける', () => {
    const { container } = render(
      <FormSection title="計算式" kind="optional" open>
        <Input name="formula" aria-label="計算式" />
      </FormSection>,
    );
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('CreatePanel（?new=1 で開く作成フォーム）', () => {
  it('new=1 のときだけ描き、閉じるリンクは引数を外す', () => {
    const params = { status: ['draft', 'returned'], new: '1', flash: 'x' };
    expect(isCreatePanelOpen(params)).toBe(true);
    expect(isCreatePanelOpen({ status: 'draft' })).toBe(false);
    expect(createPanelHref('/enterprise/evidence', params, { open: false })).toBe(
      '/enterprise/evidence?status=draft&status=returned',
    );
    expect(createPanelHref('/enterprise/evidence', { q: '電力' }, { open: true })).toBe(
      '/enterprise/evidence?q=%E9%9B%BB%E5%8A%9B&new=1',
    );

    const { rerender } = render(
      <CreatePanel id="evidence-new" title="資料を登録" searchParams={{}} closeHref="/x">
        <p>フォーム</p>
      </CreatePanel>,
    );
    expect(screen.queryByText('フォーム')).toBeNull();
    rerender(
      <CreatePanel id="evidence-new" title="資料を登録" searchParams={{ new: '1' }} closeHref="/x">
        <p>フォーム</p>
      </CreatePanel>,
    );
    expect(screen.getByRole('region', { name: '資料を登録' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '閉じる' })).toHaveAttribute('href', '/x');
  });
});
