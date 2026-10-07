'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { PERIOD_COOKIE } from './selected-period';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 30,
} as const;

export async function selectPeriodAction(formData: FormData): Promise<void> {
  const periodId = String(formData.get('periodId') ?? '');
  if (!periodId) return;
  const store = await cookies();
  store.set(PERIOD_COOKIE, periodId, COOKIE_OPTS);
  revalidatePath('/enterprise', 'layout');
}
