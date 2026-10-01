import type { DbClient, Query, Row, TableName } from '@/lib/repositories/types';
import type { Uuid } from '@/types/domain';

/**
 * 書込検知ラッパー（docs/disclosure-first.md §9.7）。
 *
 * 読込関数が「表示しただけで行を作る・書き換える」ことを防ぐ。読み取り（select / count / findById）は
 * 包んだ DbClient へそのまま渡し、insert / update / softDelete は例外にする（呼ばれた表を記録する）。
 * CSRD・分析の読込関数をこれで包んで呼び、例外が出ないことを確かめる。
 */
export class WriteDetectedError extends Error {
  constructor(operation: string, table: string) {
    super(`読込関数が ${operation} を呼んだ: ${table}`);
    this.name = 'WriteDetectedError';
  }
}

export class WriteDetectingDbClient implements DbClient {
  readonly mode: DbClient['mode'];
  /** 呼ばれた書込（操作:表） */
  readonly writes: string[] = [];

  constructor(private readonly inner: DbClient) {
    this.mode = inner.mode;
  }

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

  async insert<K extends TableName>(table: K): Promise<Row<K>[]> {
    this.writes.push(`insert:${table}`);
    throw new WriteDetectedError('insert', table);
  }

  async update<K extends TableName>(table: K): Promise<Row<K>> {
    this.writes.push(`update:${table}`);
    throw new WriteDetectedError('update', table);
  }

  async softDelete<K extends TableName>(table: K): Promise<void> {
    this.writes.push(`softDelete:${table}`);
    throw new WriteDetectedError('softDelete', table);
  }
}
