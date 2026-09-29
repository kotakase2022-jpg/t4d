import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * ヘッダーの文脈表示（指示書 §4.2）と、開示優先モードの Command Palette（A01）。
 *
 * - プロジェクトの画面にいるときだけ、プロジェクト名・対象範囲・期間を出す
 * - プロジェクトの年度がヘッダーの報告期間と違えば、黙って混ぜずに明示する
 * - Command Palette は画面に出ているメニューと同じツリーから候補を作る
 */

let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const { HeaderProjectContext, projectIdFromPath } =
  await import('@/components/shared/header-context');
const { DemoRoleSwitcher } = await import('@/components/shared/header-demo-role-switcher');
const { CommandPalette } = await import('@/components/shared/command-palette');

const PROJECT = {
  id: 'p-2026',
  name: 'FY2026 統合開示（SSBJ・CSRD域外準備）',
  reportingEntity: '青海テクノロジー株式会社及び連結子会社',
  scopeDetail: '連結の範囲。GHG は財務支配力基準。',
  periodText: '2026-04-01〜2027-03-31',
  reportingPeriodId: 'fy2026',
  reportingPeriodCode: 'FY2026',
};

function renderContext(currentPeriodId: string, currentPeriodCode: string) {
  return render(
    <TooltipProvider>
      <HeaderProjectContext
        projects={[PROJECT]}
        currentPeriodId={currentPeriodId}
        currentPeriodCode={currentPeriodCode}
      />
    </TooltipProvider>,
  );
}

describe('projectIdFromPath', () => {
  it.each([
    ['/enterprise/disclosure-projects/p-2026', 'p-2026'],
    ['/enterprise/disclosure-projects/p-2026/blocks/b-1', 'p-2026'],
    ['/enterprise/disclosure-projects/new', null],
    ['/enterprise/disclosure-projects', null],
    ['/enterprise/dashboard', null],
  ])('%s → %s', (path, expected) => {
    expect(projectIdFromPath(path)).toBe(expected);
  });
});

describe('ヘッダーのプロジェクト表示', () => {
  it('プロジェクト以外の画面では何も出さない', () => {
    pathname = '/enterprise/dashboard';
    renderContext('fy2026', 'FY2026');
    expect(screen.queryByTestId('header-project-context')).toBeNull();
  });

  it('プロジェクトの画面では名前と対象範囲を出し、同じ年度なら期間を重ねて出さない', () => {
    pathname = '/enterprise/disclosure-projects/p-2026/blocks/b-1';
    renderContext('fy2026', 'FY2026');
    const link = screen.getByRole('link', { name: /FY2026 統合開示/ });
    expect(link).toHaveAttribute('href', '/enterprise/disclosure-projects/p-2026');
    expect(link).toHaveTextContent('範囲 青海テクノロジー株式会社及び連結子会社');
    // 期間はヘッダー左の報告期間表示と同じなので、プロジェクト側では繰り返さない
    expect(link).not.toHaveTextContent('2026-04-01〜2027-03-31');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('ヘッダーの報告期間と年度が違えば期間ごと明示する', () => {
    pathname = '/enterprise/disclosure-projects/p-2026';
    renderContext('fy2025', 'FY2025');
    expect(screen.getByRole('note')).toHaveTextContent(
      'FY2026 を表示中（選択中の報告期間は FY2025）',
    );
    expect(screen.getByRole('link', { name: /FY2026 統合開示/ })).toHaveTextContent(
      '2026-04-01〜2027-03-31',
    );
  });
});

describe('デモの役割切替メニュー', () => {
  it('候補が 1 人以下なら出さない', () => {
    const { container } = render(
      <DemoRoleSwitcher
        choices={[
          {
            email: 'sustainability@demo.local',
            displayName: '海野 みどり',
            jobTitle: null,
            demoRole: '作成担当',
            roleLabels: '本社サステナビリティ担当',
            current: true,
          },
        ]}
        onSwitchAction={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ボタンの名前に現在の利用者と役割を含める（読み上げで分かる）', () => {
    render(
      <DemoRoleSwitcher
        choices={[
          {
            email: 'sustainability@demo.local',
            displayName: '海野 みどり',
            jobTitle: null,
            demoRole: '作成担当',
            roleLabels: '本社サステナビリティ担当',
            current: true,
          },
          {
            email: 'reviewer@demo.local',
            displayName: '検見川 涼',
            jobTitle: null,
            demoRole: 'レビュアー',
            roleLabels: 'レビュー担当',
            current: false,
          },
        ]}
        onSwitchAction={vi.fn()}
      />,
    );
    // 見えている文言（役割切替（デモ））で始まり、現在の利用者と役割を含む
    expect(
      screen.getByRole('button', { name: '役割切替（デモ） 現在: 海野 みどり・作成担当' }),
    ).toBeInTheDocument();
  });
});

describe('Command Palette は画面のメニューと同じツリーを使う', () => {
  it('開示優先モードでは新しい導線が候補に出る', () => {
    pathname = '/enterprise/dashboard';
    render(<CommandPalette variant="enterprise-disclosure" hiddenHrefs={[]} />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'コマンドパレット検索' }), {
      target: { value: '定性' },
    });
    expect(screen.getByRole('option', { name: /情報・根拠 \/ 定性情報/ })).toBeInTheDocument();
  });

  it('従来メニューでは新しい導線を候補に出さない', () => {
    pathname = '/enterprise/dashboard';
    render(<CommandPalette variant="enterprise" hiddenHrefs={[]} />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'コマンドパレット検索' }), {
      target: { value: '開示プロジェクト' },
    });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('一致する画面がありません')).toBeInTheDocument();
  });
});
