'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

const PERIOD_COOKIE = 't4d_period';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 30,
} as const;

/**
 * 選択中の報告期間。Layout からも読めるよう URL ではなく Cookie に保持する
 * （Next.js の Layout は searchParams を受け取れないため）。
 */
export async function getSelectedPeriodId(): Promise<string | null> {
  const store = await cookies();
  return store.get(PERIOD_COOKIE)?.value ?? null;
}

export async function selectPeriodAction(formData: FormData): Promise<void> {
  const periodId = String(formData.get('periodId') ?? '');
  if (!periodId) return;
  const store = await cookies();
  store.set(PERIOD_COOKIE, periodId, COOKIE_OPTS);
  revalidatePath('/enterprise', 'layout');
}
