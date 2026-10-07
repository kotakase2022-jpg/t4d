'use server';

import { requireSession } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { searchPalette, type PaletteSearchResult } from '@/lib/services/palette-search';

/** 検索語の上限（長い入力で全件を走査し続けない） */
const MAX_QUERY_LENGTH = 100;

/**
 * Command Palette のデータの検索（plan §4 B2）。読み取りだけ。
 * 権限（can）と組織の絞り込みはサービスが行い、Supabase では RLS も通る
 */
export async function searchPaletteAction(query: string): Promise<PaletteSearchResult> {
  const session = await requireSession();
  const db = await getDb();
  return searchPalette(db, session.context, String(query ?? '').slice(0, MAX_QUERY_LENGTH));
}
