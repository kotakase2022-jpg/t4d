import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { redirect } from 'next/navigation';
import { TaskStatusBadge } from '@/components/shared/badges';
import { taskTargetTypeLabel } from '@/lib/domain/disclosure-status';
import { fileTypeLabel } from '@/lib/domain/evidence-limits';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';

/**
 * 自己監査 第 2 回（2026-09-29）で直した画面の規則の回帰テスト（UX / 回帰の正直さ）。
 */

const actionMocks = vi.hoisted(() => ({
  addReviewCommentAction: vi.fn(),
  resolveReviewCommentAction: vi.fn(),
  createBlockFormAction: vi.fn(),
  listBlockRequirementOptionsAction: vi.fn(),
  uploadEvidenceDocumentFormAction: vi.fn(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/app/enterprise/disclosure-projects/[projectId]/blocks/actions', () => actionMocks);
vi.mock('@/app/enterprise/evidence/actions', () => actionMocks);

// ----------------------------------------------------------------------
// UX-02: タスク・承認の画面に DB の値を出さない
// ----------------------------------------------------------------------

describe('UX-02 タスクの状態・対象は日本語のラベルとアイコンで示す', () => {
  it('状態はラベル＋アイコン（open / in_progress をそのまま出さない）', () => {
    const { container } = render(
      <>
        <TaskStatusBadge status="open" />
        <TaskStatusBadge status="in_progress" />
      </>,
    );
    expect(screen.getByText('未着手')).toBeTruthy();
    expect(screen.getByText('対応中')).toBeTruthy();
    expect(container.textContent).not.toMatch(/open|in_progress/);
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  });

  it('対象の種類は業務の言葉で、知らない値も内部名を出さない', () => {
    expect(taskTargetTypeLabel('data_point')).toBe('データ');
    expect(taskTargetTypeLabel('evidence')).toBe('資料・証跡');
    expect(taskTargetTypeLabel('ingestion_job')).toBe('データ取込');
    expect(taskTargetTypeLabel('some_future_type')).toBe('その他');
    expect(taskTargetTypeLabel(null)).toBe('その他');
  });
});

// ----------------------------------------------------------------------
// UX-11: 資料の形式を MIME 型のまま出さない
// ----------------------------------------------------------------------

describe('UX-11 資料の形式は名前で示す', () => {
  it('Word・Excel・PDF・画像・テキストを名前にし、知らない形式は拡張子で示す', () => {
    expect(
      fileTypeLabel(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '議事録.docx',
      ),
    ).toBe('Word 文書');
    expect(fileTypeLabel('application/pdf')).toBe('PDF');
    expect(fileTypeLabel('image/png', 'x.png')).toBe('画像（PNG）');
    expect(fileTypeLabel('text/plain', 'memo.txt')).toBe('テキスト');
    expect(fileTypeLabel('application/octet-stream', 'data.xyz')).toBe('XYZ ファイル');
    expect(fileTypeLabel('', '')).toBe('その他の形式');
  });
});

// ----------------------------------------------------------------------
// UX-13: useActionState の通信失敗で入力を失わない
// ----------------------------------------------------------------------

describe('UX-13 通信の失敗はエラーの状態として返し、リダイレクトは投げ直す', () => {
  it('reject を捕まえて、入力値を持った失敗の状態を返す', async () => {
    const action = withNetworkFallback<{ message: string | null; text: string }>(
      async () => {
        throw new TypeError('Failed to fetch');
      },
      (_previous, formData) => ({
        message: NETWORK_ERROR_MESSAGE,
        text: String(formData.get('text') ?? ''),
      }),
    );
    const formData = new FormData();
    formData.set('text', '手で写した長い抜粋');
    await expect(action({ message: null, text: '' }, formData)).resolves.toEqual({
      message: NETWORK_ERROR_MESSAGE,
      text: '手で写した長い抜粋',
    });
  });

  it('成功時のリダイレクト（Next の内部エラー）は捕まえない', async () => {
    let redirectError: unknown;
    try {
      redirect('/enterprise/evidence');
    } catch (error) {
      redirectError = error;
    }
    const action = withNetworkFallback(
      async () => {
        throw redirectError;
      },
      () => 'fallback',
    );
    await expect(action('idle', new FormData())).rejects.toBe(redirectError);
  });
});

// ----------------------------------------------------------------------
// UX-01: コメントの送信が通信で失敗しても、ボタンが押せないまま止まらない
// ----------------------------------------------------------------------

describe('UX-01 コメントの送信が通信で失敗しても、再試行でき理由を示す', () => {
  it('送信ボタンが押せる状態に戻り、入力したコメントが残り、理由を読み上げる', async () => {
    const { RightPane, COMMENT_NETWORK_ERROR_MESSAGE } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/editor-right-pane');
    actionMocks.addReviewCommentAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const onAnnounce = vi.fn();
    const data = {
      block: { id: 'block-1', currentVersionId: 'v1', submittedVersionId: null },
      permissions: { canWrite: true, canApprove: false },
      statusBar: { unresolvedComments: { count: 0 } },
      comments: [],
    } as unknown as Parameters<typeof RightPane>[0]['data'];
    render(
      <RightPane
        data={data}
        projectId="project-1"
        canEdit
        selected={new Set()}
        onToggleSelect={() => {}}
        canSelectForAi={false}
        onInsert={() => {}}
        onJump={() => {}}
        paragraphLabel={(id) => id}
        paragraphOptions={[]}
        tab="comments"
        onTabChange={() => {}}
        onAnnounce={onAnnounce}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: /コメント/ });
    fireEvent.change(textarea, { target: { value: '集計範囲を明記してください。' } });
    const submit = screen.getByRole('button', { name: /コメントする/ });
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(COMMENT_NETWORK_ERROR_MESSAGE),
    );
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect((textarea as HTMLTextAreaElement).value).toBe('集計範囲を明記してください。');
    expect(onAnnounce).toHaveBeenCalledWith(COMMENT_NETWORK_ERROR_MESSAGE);
  });
});

// ----------------------------------------------------------------------
// UX-04: 節のキーの形式をブラウザでも確かめる
// ----------------------------------------------------------------------

describe('UX-04 節を追加するフォームは、キーの形式を送る前に示す', () => {
  it('節のキーの入力欄に形式（pattern）と例を持つ', async () => {
    const { AddBlockForm, SECTION_KEY_PATTERN } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/add-block-form');
    render(
      <AddBlockForm
        projectId="project-1"
        frameworks={[{ versionId: 'fv-1', label: 'SSBJ 2026' }]}
        rows={[]}
      />,
    );
    const key = screen.getByLabelText(/節のキー/) as HTMLInputElement;
    expect(key.getAttribute('pattern')).toBe(SECTION_KEY_PATTERN);
    expect(new RegExp(`^(?:${SECTION_KEY_PATTERN})$`).test('risk_opportunity')).toBe(true);
    expect(new RegExp(`^(?:${SECTION_KEY_PATTERN})$`).test('Governance')).toBe(false);
    expect(screen.getByRole('button', { name: '節を追加' })).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// トライアル対応 NF-05: 節を追加するときに対応する要求事項を選べる（T1）
// ----------------------------------------------------------------------

describe('NF-05 節を追加するフォームで、対応する要求事項を選べる', () => {
  it('「要求事項を選ぶ」で選んでいる基準の版の一覧を読み、絞り込んでも選んだ要求事項を送る', async () => {
    actionMocks.listBlockRequirementOptionsAction.mockResolvedValue({
      status: 'ok',
      options: [
        { id: 'item-1', code: '40A-S01', section: '（サンプル）', title: '（サンプル）体制' },
        { id: 'item-2', code: '40A-S02', section: '（サンプル）', title: '（サンプル）手順' },
      ],
    });
    const { AddBlockForm } =
      await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/add-block-form');
    render(
      <AddBlockForm
        projectId="project-1"
        frameworks={[
          { versionId: 'fv-ssbj', label: 'SSBJ 2026' },
          { versionId: 'fv-40a', label: 'ESRS-40a サンプル' },
        ]}
        rows={[]}
      />,
    );
    // 一覧は開くまで読まない（開かない人の表示を重くしない）
    expect(actionMocks.listBlockRequirementOptionsAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/基準の版/), { target: { value: 'fv-40a' } });
    fireEvent.click(screen.getByRole('button', { name: '要求事項を選ぶ' }));
    await waitFor(() =>
      expect(actionMocks.listBlockRequirementOptionsAction).toHaveBeenCalledWith({
        projectId: 'project-1',
        frameworkVersionId: 'fv-40a',
      }),
    );
    const second = (await screen.findByRole('checkbox', { name: /40A-S02/ })) as HTMLInputElement;
    fireEvent.click(second);
    expect(screen.getByText(/1 件を選択中/)).toBeTruthy();

    // 絞り込みは表示を減らすだけ（隠れた選択も送る）
    fireEvent.change(screen.getByLabelText('要求事項を検索'), { target: { value: 'S01' } });
    expect(second.closest('li')?.hidden).toBe(true);
    const form = second.closest('form')!;
    expect(new FormData(form).getAll('requirementItemIds')).toEqual(['item-2']);
  });
});

// ----------------------------------------------------------------------
// F6（回帰）/ UX-05: 従来の Evidence 画面に開示優先の入力を出さない・送信中を示す
// ----------------------------------------------------------------------

describe('F6 開示優先モードが OFF の組織の Evidence 登録は、従来の入力項目だけ', () => {
  const baseProps = {
    periods: [{ id: 'p-1', code: 'FY2026' }] as Array<{ id: string; code: string }>,
    currentPeriodId: 'p-1',
    extensions: ['.pdf', '.docx'] as string[],
    confidentialityLabels: {
      public: '公開',
      internal: '社内',
      confidential: '機密',
      restricted: '極秘',
    },
  } as const;

  it('OFF: 利用目的・版・発行日・機密区分・資料名を出さない', async () => {
    const { EvidenceUploadForm } = await import('@/app/enterprise/evidence/evidence-upload-form');
    const { container } = render(
      <EvidenceUploadForm {...baseProps} qualitative={false} disclosureFirst={false} />,
    );
    for (const name of ['usagePurpose', 'editionLabel', 'issuedOn', 'confidentiality', 'title']) {
      expect(container.querySelector(`[name="${name}"]`), name).toBeNull();
    }
    expect(container.querySelector('[name="documentType"]')).not.toBeNull();
    expect(container.querySelector('[name="reportingPeriodId"]')).not.toBeNull();
    // 送信中は押せない（二度押しで同じ資料を 2 件登録しない）: 送信ボタンは SubmitButton
    expect(screen.getByRole('button', { name: '登録' }).getAttribute('type')).toBe('submit');
  });

  it('ON: 開示優先の入力項目を出す', async () => {
    const { EvidenceUploadForm } = await import('@/app/enterprise/evidence/evidence-upload-form');
    const { container } = render(
      <EvidenceUploadForm {...baseProps} qualitative={false} disclosureFirst />,
    );
    for (const name of ['usagePurpose', 'editionLabel', 'issuedOn', 'confidentiality', 'title']) {
      expect(container.querySelector(`[name="${name}"]`), name).not.toBeNull();
    }
  });
});

// ----------------------------------------------------------------------
// UX-09: 新しい画面の状態バッジはラベル＋アイコン
// ----------------------------------------------------------------------

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsxFiles(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

describe('UX-09 開示優先モードの画面のバッジは、ラベルとアイコンを併記する', () => {
  it('バッジの中に装飾アイコン（aria-hidden）がある', () => {
    const files = [
      ...tsxFiles('src/app/enterprise/disclosure-projects'),
      ...tsxFiles('src/app/enterprise/narratives'),
      'src/app/enterprise/evidence/[fileId]/page.tsx',
      'src/app/enterprise/workflows/page.tsx',
    ];
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<Badge\b[\s\S]*?<\/Badge>/g)) {
        // アイコンを変数で渡すバッジ（{icon}）も、変数側で aria-hidden を付けている
        if (/aria-hidden|\{icon\}/.test(match[0])) continue;
        const line = source.slice(0, match.index).split('\n').length;
        missing.push(`${file}:${line}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
