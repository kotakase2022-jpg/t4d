import 'server-only';

import { cookies } from 'next/headers';

/** 選択中の報告期間を持つ Cookie の名前（preferences.ts の selectPeriodAction が書く） */
export const PERIOD_COOKIE = 't4d_period';

/**
 * 選択中の報告期間。Layout からも読めるよう URL ではなく Cookie に保持する
 * （Next.js の Layout は searchParams を受け取れないため）。
 *
 * 'use server' のファイル（preferences.ts）から分けた: 'use server' の export はすべて
 * クライアントから呼べる Server Action として公開されるため、読み取りの関数を置かない（IF §6.1）
 */
export async function getSelectedPeriodId(): Promise<string | null> {
  const store = await cookies();
  return store.get(PERIOD_COOKIE)?.value ?? null;
}
