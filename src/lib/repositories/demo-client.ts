import { getDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  applyQuery,
  matchesQueryFilters,
  type DbClient,
  type Query,
  type Row,
  type TableName,
} from './types';
import type { Uuid } from '@/types/domain';

/**
 * Demo / Fixture Mode の DbClient。
 * インメモリ配列に対して同じ Query 契約を実装する。
 */
export class DemoDbClient implements DbClient {
  readonly mode = 'demo' as const;

  constructor(private readonly db: FixtureDb = getDemoDb()) {}

  private table<K extends TableName>(name: K): Row<K>[] {
    return this.db[name] as unknown as Row<K>[];
  }

  async select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]> {
    return applyQuery(this.table(table) as object[], query as Query<object> | undefined).map((r) =>
      structuredClone(r),
    ) as Row<K>[];
  }

  async count<K extends TableName>(
    table: K,
    query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>,
  ): Promise<number> {
    return (this.table(table) as object[]).filter((r) =>
      matchesQueryFilters(r, query as Query<object> | undefined),
    ).length;
  }

  async findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null> {
    const found = (this.table(table) as unknown as Array<{ id?: string }>).find((r) => r.id === id);
    return found ? (structuredClone(found) as unknown as Row<K>) : null;
  }

  async insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]> {
    const target = this.table(table);
    const cloned = rows.map((r) => structuredClone(r));
    target.push(...cloned);
    return cloned.map((r) => structuredClone(r));
  }

  async update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    const target = this.table(table) as unknown as Array<Record<string, unknown> & { id?: string }>;
    const index = target.findIndex((r) => r.id === id);
    const existing = target[index];
    if (index === -1 || !existing) throw new Error(`${String(table)} ${id} が見つかりません。`);
    const next = { ...existing, ...(patch as Record<string, unknown>) };
    target[index] = next;
    return structuredClone(next) as unknown as Row<K>;
  }

  async softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    await this.update(table, id, { deletedAt: at } as unknown as Partial<Row<K>>);
  }
}
