import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BUTTON_VARIANTS, Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SubmitButton } from '@/components/ui/submit-button';

/**
 * ボタンの契約（plan §1.6・§3.5 button-contract）。
 * E2E の primary 監査は DOM の data-variant を数えるため、どの描き方でも variant が DOM に出ること、
 * 既定が secondary であること（primary は画面ごとに明示する）を固定する。
 */

describe('Button', () => {
  it('既定は secondary・sm で、DOM に data-variant と data-size を出す', () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toHaveAttribute('data-variant', 'secondary');
    expect(button).toHaveAttribute('data-size', 'sm');
    expect(button).toHaveAttribute('type', 'button');
  });

  it.each(BUTTON_VARIANTS)('variant=%s が data-variant に出る', (variant) => {
    render(<Button variant={variant}>操作</Button>);
    expect(screen.getByRole('button', { name: '操作' })).toHaveAttribute('data-variant', variant);
  });

  it('asChild（リンク）でも data-variant が子の要素に付く', () => {
    render(
      <Button variant="primary" asChild>
        <a href="/x">開く</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: '開く' });
    expect(link).toHaveAttribute('data-variant', 'primary');
    expect(link).not.toHaveAttribute('type');
  });

  it('旧 outline の見た目は secondary、旧 secondary の見た目は quiet（改名で見た目を変えない）', () => {
    render(
      <>
        <Button variant="secondary">枠</Button>
        <Button variant="quiet">選択中</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: '枠' }).className).toContain('border-line');
    expect(screen.getByRole('button', { name: '選択中' }).className).toContain('bg-brand-100');
  });
});

describe('SubmitButton', () => {
  it('variant を Button に渡し、送信ボタンになる', () => {
    render(
      <form>
        <SubmitButton variant="primary">提出</SubmitButton>
      </form>,
    );
    const button = screen.getByRole('button', { name: '提出' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('data-variant', 'primary');
  });

  it('variant を書かなければ secondary（primary は明示したものだけ）', () => {
    render(
      <form>
        <SubmitButton>保存</SubmitButton>
      </form>,
    );
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
  });
});

describe('IconButton', () => {
  it('label が読み上げ名になる（アイコンだけで意味を伝えない）', () => {
    render(<IconButton label="閉じる" icon={<svg aria-hidden="true" />} />);
    const button = screen.getByRole('button', { name: '閉じる' });
    expect(button).toHaveAttribute('aria-label', '閉じる');
    expect(button).toHaveAttribute('data-variant', 'ghost');
  });

  it('label は必須（型で強制）', () => {
    // @ts-expect-error label が無い IconButton は型エラーになる
    const element = <IconButton icon={<svg aria-hidden="true" />} />;
    expect(element).toBeTruthy();
  });
});
