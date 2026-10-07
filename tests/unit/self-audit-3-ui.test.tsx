import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  NETWORK_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  failureMessageOf,
  withNetworkFallback,
} from '@/lib/errors/safe-form-action';
import { paragraphLabelOf } from '@/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/editor-model';
import { ScanStatusBadge } from '@/components/shared/scan-status-badge';
import { DemoRoleSwitcher } from '@/components/shared/header-demo-role-switcher';

/**
 * 自己監査 第 3 回（2026-09-30）の画面の指摘の回帰テスト（REG-4・REG-5・UX-R3-02/05/07/09/11/12/13/14/15）。
 */

const returnReviewFormAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/enterprise/disclosure-projects/[projectId]/blocks/actions', () => ({
  returnReviewFormAction,
  withdrawReviewFormAction: vi.fn(),
}));

const ROOT = process.cwd();
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx?|mdx?)$/.test(name)) out.push(path);
  }
  return out;
}

describe('REG-4 SSBJ の 133 項目を「全要求事項」と言わない', () => {
  it('画面の文言に「全 133」が無い（収録件数として示す）', () => {
    const offending = sourceFiles('src').filter((path) => /全\s?133/.test(read(path)));
    expect(offending).toEqual([]);
    expect(read('src/components/shared/demo-tour.tsx')).toContain(
      'ユニバーサル基準（適用）は未収録',
    );
  });
});

describe('REG-5 サーバーのエラーを「通信を確認して」と言わない', () => {
  it('fetch の失敗（TypeError）だけを通信の失敗とし、それ以外は処理の失敗として示す', async () => {
    expect(failureMessageOf(new TypeError('Failed to fetch'))).toBe(NETWORK_ERROR_MESSAGE);
    expect(
      failureMessageOf(new Error('An unexpected response was received from the server.')),
    ).toBe(SERVER_ERROR_MESSAGE);
    const action = withNetworkFallback<{ message: string | null }>(
      async () => {
        throw new Error('duplicate key value violates unique constraint');
      },
      (_previous, _formData, message) => ({ message }),
    );
    await expect(action({ message: null }, new FormData())).resolves.toEqual({
      message: SERVER_ERROR_MESSAGE,
    });
    expect(SERVER_ERROR_MESSAGE).not.toContain('通信');
  });
});

describe('UX-R3-05 段落は内部の ID ではなく、本文の中の位置で呼ぶ', () => {
  it('段落 N・見出し（段落 N）・本文に無い段落', () => {
    const paragraphs = [
      { id: 'p-mg3k1x2a', kind: 'heading' as const },
      { id: 'p-mg3k1x2b', kind: 'paragraph' as const },
    ];
    expect(paragraphLabelOf(paragraphs, 'p-mg3k1x2a')).toBe('見出し（段落 1）');
    expect(paragraphLabelOf(paragraphs, 'p-mg3k1x2b')).toBe('段落 2');
    expect(paragraphLabelOf(paragraphs, 'p-gone')).not.toContain('p-gone');
  });

  it('原稿の画面・レビュー・根拠パネル・AI 候補のファイルに、段落 ID をそのまま出す表示が無い', () => {
    const dir = 'src/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]';
    for (const file of [
      'block-editor.tsx',
      'page.tsx',
      'review-panel.tsx',
      'editor-right-pane.tsx',
      'editor-ai-panel.tsx',
    ]) {
      const text = read(`${dir}/${file}`);
      expect(text, file).not.toMatch(
        /段落 \$\{(p\.id|id|targetId|paragraphId|c\.paragraphId|i\.paragraphId|e\.paragraphId)\}/,
      );
      expect(text, file).not.toMatch(/段落 \{(id|p\.id|d\.paragraphId|c\.paragraphId)\}/);
      expect(text, file).not.toMatch(/\{d\.paragraphId\}\s*<\/span>/);
    }
  });
});

describe('UX-R3-07 ウイルススキャンの状態をラベルとアイコンで示す', () => {
  it('skipped を「対象外」と示し、アイコンを付ける', () => {
    const { container } = render(<ScanStatusBadge status="skipped" />);
    expect(screen.getByText('対象外')).toBeInTheDocument();
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('skipped');
  });

  it('資料の一覧・資料の画面は状態の値をそのまま出さない', () => {
    for (const file of [
      'src/app/enterprise/evidence/page.tsx',
      'src/app/enterprise/evidence/[fileId]/page.tsx',
    ]) {
      // 属性（status={file.scanStatus}）ではなく、本文として値を出していないこと
      expect(read(file), file).not.toMatch(/[^=]\{file\.scanStatus\}/);
    }
  });
});

describe('UX-R3-09 長い一覧の列見出しを固定する', () => {
  it('資料・プロジェクト一覧・KPI の内訳・出力の表は縦にスクロールする枠の中で見出しを固定する', () => {
    // 共通の一覧（DataTable）へ移した画面は、見出しの固定を表の既定（stickyHeader）で持つ
    // （plan §1.12-1: 見出しの固定は Table の既定にした。2 方式を 1 つに。下のテストで部品の側を確かめる）
    const stickyInScroll = (text: string) =>
      text.includes('max-h-[70vh] overflow-auto') &&
      // 重なりの順は役割のトークン（z-(--z-sticky) = 10。plan §3.3 の codemod で z-10 から置換。値は同じ）
      text.includes('<THead className="sticky top-0 z-(--z-sticky) bg-surface">');
    for (const file of [
      'src/app/enterprise/evidence/page.tsx',
      'src/app/enterprise/esg/[kpiKey]/page.tsx',
    ]) {
      const text = read(file);
      expect(stickyInScroll(text) || text.includes('<DataTable'), file).toBe(true);
    }
    // 出力タブ: スナップショットの表は縦にスクロールする枠の中で見出しを固定し、出力の記録は DataTable
    const outputs = read('src/app/enterprise/disclosure-projects/[projectId]/_tabs/outputs.tsx');
    expect(stickyInScroll(outputs)).toBe(true);
    expect(outputs).toContain('<DataTable');
  });

  it('プロジェクト一覧は共通の一覧（DataTable）で描き、見出しの固定は表の既定（stickyHeader）で持つ', () => {
    expect(read('src/app/enterprise/disclosure-projects/page.tsx')).toContain('<DataTable');
    const dataTable = read('src/components/shared/data-table/data-table.tsx');
    expect(dataTable).toContain('<Table>');
    expect(dataTable).not.toContain('stickyHeader={false}');
    expect(read('src/components/ui/table.tsx')).toContain('stickyHeader = true');
  });
});

describe('UX-R3-13 / UX-R3-14 標準 CSV の画面', () => {
  it('検証の後は「登録を確定」だけを主要な操作にし、値の有無の記号に意味を添える', () => {
    // Button の variant の改名（plan §3.4: 旧 outline → secondary、既定の primary は明示）。意味は同じ
    expect(read('src/app/enterprise/imports/standard/standard-import.tsx')).toContain(
      "variant={preview && !committed ? 'secondary' : 'primary'}",
    );
    const page = read('src/app/enterprise/imports/standard/page.tsx');
    expect(page).toContain('AVAILABILITY_STATUS_LABELS');
    expect(page).not.toContain(
      "note: 'value_present／not_entered／not_obtained／not_applicable／not_calculated'",
    );
  });
});

describe('UX-R3-02 差戻しが断られても、書いた理由と選んだ段落を残す', () => {
  it('サーバーが断ったら理由を示し、理由の入力と段落の選択はそのまま', async () => {
    returnReviewFormAction.mockResolvedValue({
      status: 'error',
      message: 'レビュー中ではない依頼は差し戻せません。',
      values: { reason: '集計範囲を本文に明記してください（長い理由）。', paragraphId: 'p-2' },
    });
    const { ReturnReviewForm } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/review-decision-forms');
    render(
      <ReturnReviewForm
        projectId="00000000-0000-4000-8000-000000000001"
        blockId="00000000-0000-4000-8000-000000000002"
        requestId="00000000-0000-4000-8000-000000000003"
        paragraphs={[
          { id: 'p-1', label: '段落 1: はじめに' },
          { id: 'p-2', label: '段落 2: 集計範囲' },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-2' } });
    fireEvent.change(screen.getByLabelText('差戻しの理由（必須）'), {
      target: { value: '集計範囲を本文に明記してください（長い理由）。' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '差し戻す' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('差し戻せません');
    expect(screen.getByLabelText('差戻しの理由（必須）')).toHaveValue(
      '集計範囲を本文に明記してください（長い理由）。',
    );
    expect(screen.getByRole('combobox')).toHaveValue('p-2');
  });
});

describe('UX-R3-12 役割切替は、切替中と失敗を示す', () => {
  it('呼び出しが失敗したら理由と再試行を示す', async () => {
    const onSwitchAction = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(
      <DemoRoleSwitcher
        onSwitchAction={onSwitchAction}
        choices={[
          {
            email: 'sustainability@demo.local',
            displayName: '海野 さくら',
            jobTitle: null,
            demoRole: '作成担当',
            roleLabels: 'サステナビリティ推進',
            current: true,
          },
          {
            email: 'reviewer@demo.local',
            displayName: '検見川 誠',
            jobTitle: null,
            demoRole: 'レビュアー',
            roleLabels: 'レビュー',
            current: false,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: /役割切替（デモ）/ }));
    await user.click(await screen.findByRole('menuitem', { name: /検見川 誠/ }));
    await waitFor(() => expect(onSwitchAction).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('役割を切り替えられませんでした');
    expect(alert).toHaveTextContent('通信を確認');
    await user.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(onSwitchAction).toHaveBeenCalledTimes(2));
  });
});

describe('UX-R3-11 作成の段階を移ったら、移った先の見出しへフォーカスを移す', () => {
  it('「次へ」「戻る」で段階の見出しにフォーカスが移る（body に落ちない）', async () => {
    const { ProjectForm } = await import('@/app/enterprise/disclosure-projects/new/project-form');
    render(
      <ProjectForm
        mode="create"
        action={async (state) => state}
        initial={{ name: '', purposes: [], languages: ['ja'], includedUnitIds: [] }}
        periods={[]}
        members={[]}
        units={[]}
        purposes={[]}
        versionOptions={{}}
        languages={[{ value: 'ja', label: '日本語' }]}
        fieldLabels={{}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('2. 対応する制度と基準'),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('3. 報告範囲と承認'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /戻る/ }));
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('2. 対応する制度と基準'),
    );
  });
});

describe('UX-R3-04 関連数値の候補は指標名を切り詰めない', () => {
  it('指標名と組織・範囲は 1 行を占めて折り返す（truncate しない）', () => {
    const text = read(
      'src/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/editor-right-pane.tsx',
    );
    expect(text).toContain('<div className="break-words text-ink">{c.metricName}</div>');
    expect(text).not.toContain('<div className="truncate text-ink">{c.metricName}</div>');
  });
});

describe('UX-R3-06 / UX-R3-10 KPI の目標', () => {
  it('基準値に単位を付ける（カードの目標の説明）', async () => {
    const { targetText } = await import('@/app/enterprise/esg/kpi-card');
    const text = targetText(
      {
        target: {
          baseYear: 2019,
          baseValue: 1500,
          targetYear: 2030,
          targetValue: 800,
          direction: 'reduce',
          targetType: 'absolute',
          boundary: '連結',
        },
      } as never,
      't-CO2e',
    );
    expect(text).toContain('基準 2019 年 1,500 t-CO2e');
  });

  it('登録の知らせは内部のキーでなく表示名で、表の数値は右寄せ・単位つき', () => {
    const page = read('src/app/enterprise/esg/targets/page.tsx');
    expect(page).not.toContain('目標 {saved} の版');
    expect(page).toContain('{savedLabel}の版');
    expect(page).toContain('<TH align="right">基準値</TH>');
  });
});
