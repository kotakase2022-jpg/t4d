import { getDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import { appendDemoEdit, isPersistedTable } from './demo-persistence';
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
/**
 * Cookie へ残す内容を軽くする。
 *
 * **列は落とさない**（落とすと、別インスタンスで復元したときに欠けた列を読む箇所が壊れる。
 * 実際に取込のジョブ画面が内部エラーになった）。
 * 代わりに、読み直しに使わない大きな値だけを空にする。
 *
 * 取込マッピングの出力は行数ぶんの対応表で最も大きいが、
 * プレビューが読むのは ingestionRows のほうで、この出力は使わない。
 * 残しておくと同じ Cookie に載っている取込結果を押し出してしまう。
 */
function persistedColumns(table: TableName, row: unknown): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  if (table !== 'aiRuns' || record.featureType !== 'importMapping') return record;
  return { ...record, outputJson: {} };
}

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

    // Demo Mode は状態がプロセスのメモリにしか無いため、人の操作だけ Cookie にも残す
    // （インスタンスが変わっても直前の操作が消えないようにする）。
    if (isPersistedTable(table)) {
      for (const row of cloned) {
        const record = row as unknown as { id?: string };
        if (record.id) {
          await appendDemoEdit(table, record.id, persistedColumns(table, row));
        }
      }
    }
    return cloned.map((r) => structuredClone(r));
  }

  async update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    const target = this.table(table) as unknown as Array<Record<string, unknown> & { id?: string }>;
    const index = target.findIndex((r) => r.id === id);
    const existing = target[index];
    if (index === -1 || !existing) throw new Error(`${String(table)} ${id} が見つかりません。`);
    const next = { ...existing, ...(patch as Record<string, unknown>) };
    target[index] = next;

    // 変更のあった列だけを Cookie へ（Cookie の容量を圧迫しないため）
    if (isPersistedTable(table)) {
      await appendDemoEdit(table, id, patch as unknown as Record<string, unknown>);
    }
    return structuredClone(next) as unknown as Row<K>;
  }

  async softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    await this.update(table, id, { deletedAt: at } as unknown as Partial<Row<K>>);
  }
}
