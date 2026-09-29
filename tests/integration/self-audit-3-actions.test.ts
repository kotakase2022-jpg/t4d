import { describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import { isRedirectError } from 'next/dist/client/components/redirect-error';

/**
 * REG-3（自己監査 第 3 回）: Server Action の try の中でログインを確かめると、ログイン切れの
 * redirect('/login') を失敗として握りつぶし、「時間をおいて再試行」と言い続けていた。
 * redirect は Next.js へ返す（ログイン画面へ移る）ことを確かめる。
 */

vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => redirect('/login'),
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => {
    throw new Error('ログイン切れでは DB を開かない');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

function formWith(entries: Record<string, string | Blob>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('REG-3 ログイン切れの redirect を「登録に失敗しました」にしない', () => {
  it('資料の登録・手動抜粋・適用判断・節の追加で redirect がそのまま返る', async () => {
    const evidence = await import('@/app/enterprise/evidence/actions');
    const projects = await import('@/app/enterprise/disclosure-projects/actions');
    const blocks = await import('@/app/enterprise/disclosure-projects/[projectId]/blocks/actions');

    const uploaded = await thrownBy(() =>
      evidence.uploadEvidenceDocumentFormAction(
        { status: 'idle', message: null, values: null },
        formWith({ file: new File(['x'], 'a.pdf', { type: 'application/pdf' }) }),
      ),
    );
    expect(isRedirectError(uploaded)).toBe(true);

    const excerpt = await thrownBy(() =>
      evidence.addManualExcerptFormAction(
        { status: 'idle', message: null, values: { page: '', locator: '', text: '' } },
        formWith({ fileId: 'f', text: '抜粋' }),
      ),
    );
    expect(isRedirectError(excerpt)).toBe(true);

    const confirmed = await thrownBy(() =>
      projects.confirmApplicabilityFormAction(
        { status: 'idle', message: null, fieldErrors: {}, values: null } as never,
        formWith({ projectFrameworkId: 'pf', applicabilityStatus: 'applicable' }),
      ),
    );
    expect(isRedirectError(confirmed)).toBe(true);

    const created = await thrownBy(() =>
      blocks.createBlockFormAction(
        { status: 'idle', message: null, values: null } as never,
        formWith({ projectId: 'p', sectionKey: 'governance', title: '題名' }),
      ),
    );
    expect(isRedirectError(created)).toBe(true);
  });
});
