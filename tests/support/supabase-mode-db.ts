import type { DbClient, Query, Row, TableName } from '@/lib/repositories/types';
import type { Uuid } from '@/types/domain';

/**
 * Supabase Mode の分岐を通すためのラッパー（テスト専用）。読み書きは包んだ DbClient（Demo の Fixture）へそのまま
 * 渡し、mode だけを 'supabase' と名乗る。Supabase Mode の行は利用者の JWT で書かれる（RLS の上では要約・結果に
 * 任意の JSON を書ける）ため、サービスが保存された要約・結果を信じずに作り直すことを確かめるのに使う。
 * Fixture の配列へ直接足した行は「PostgREST で直接書かれた行」の代わり。
 */
export class SupabaseModeDbClient implements DbClient {
  readonly mode = 'supabase' as const;

  constructor(private readonly inner: DbClient) {}

  select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]> {
    return this.inner.select(table, query);
  }

  count<K extends TableName>(
    table: K,
    query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>,
  ): Promise<number> {
    return this.inner.count(table, query);
  }

  findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null> {
    return this.inner.findById(table, id);
  }

  insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]> {
    return this.inner.insert(table, rows);
  }

  update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    return this.inner.update(table, id, patch);
  }

  softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    return this.inner.softDelete(table, id, at);
  }
}
