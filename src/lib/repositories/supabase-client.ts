import type { SupabaseClient } from '@supabase/supabase-js';
import { rowFromSql, rowToSql, SQL_TABLE_NAMES, toSnake } from './table-names';
import {
  toOrderByList,
  type Condition,
  type DbClient,
  type Query,
  type Row,
  type TableName,
  type Where,
} from './types';
import type { Uuid } from '@/types/domain';

/**
 * 動的テーブル名では PostgrestFilterBuilder のジェネリクスを解決できないため、
 * 本ファイル内に限り構造的な最小インターフェースで扱う。
 */
interface AnyFilter extends PromiseLike<{
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}> {
  eq(column: string, value: unknown): AnyFilter;
  neq(column: string, value: unknown): AnyFilter;
  gt(column: string, value: unknown): AnyFilter;
  gte(column: string, value: unknown): AnyFilter;
  lt(column: string, value: unknown): AnyFilter;
  lte(column: string, value: unknown): AnyFilter;
  is(column: string, value: null): AnyFilter;
  in(column: string, values: readonly unknown[]): AnyFilter;
  not(column: string, operator: string, value: unknown): AnyFilter;
  contains(column: string, value: readonly unknown[]): AnyFilter;
  or(filters: string): AnyFilter;
  order(column: string, options: { ascending: boolean }): AnyFilter;
  range(from: number, to: number): AnyFilter;
}

/**
 * Supabase Mode の DbClient。
 *
 * ユーザー JWT のクライアントを受け取るため、**すべてのクエリに RLS が適用される**。
 * RLS で弾かれた行は 0 件として返る（存在を秘匿する）。
 */
export class SupabaseDbClient implements DbClient {
  readonly mode = 'supabase' as const;

  constructor(private readonly client: SupabaseClient) {}

  private applyCondition(builder: AnyFilter, column: string, condition: Condition): AnyFilter {
    const col = toSnake(column);
    if (condition === null) return builder.is(col, null);
    if (typeof condition !== 'object') return builder.eq(col, condition);
    if ('in' in condition) return builder.in(col, condition.in as never[]);
    if ('notIn' in condition) return builder.not(col, 'in', `(${condition.notIn.join(',')})`);
    if ('neq' in condition) return builder.neq(col, condition.neq);
    if ('isNull' in condition)
      return condition.isNull ? builder.is(col, null) : builder.not(col, 'is', null);
    if ('contains' in condition) return builder.contains(col, [condition.contains] as never);
    if ('gte' in condition) return builder.gte(col, condition.gte);
    if ('lte' in condition) return builder.lte(col, condition.lte);
    if ('gt' in condition) return builder.gt(col, condition.gt);
    if ('lt' in condition) return builder.lt(col, condition.lt);
    return builder;
  }

  private applyWhere<T>(builder: AnyFilter, where: Where<T> | undefined): AnyFilter {
    if (!where) return builder;
    let out = builder;
    for (const [column, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      out = this.applyCondition(out, column, condition as Condition);
    }
    return out;
  }

  /**
   * `orWhere` を PostgREST の `or=` 文字列へ変換する。
   * 1 節の中に複数条件がある場合は `and(...)` で包む。
   *
   * 値にカンマ・括弧を含められないため、呼び出し側は UUID / enum のみを渡すこと
   * （`Query.orWhere` の doc comment に明記）。
   */
  private toOrClause<T>(clause: Where<T>): string {
    const parts: string[] = [];
    for (const [column, condition] of Object.entries(clause)) {
      if (condition === undefined) continue;
      const col = toSnake(column);
      const cond = condition as Condition;
      if (cond === null) {
        parts.push(`${col}.is.null`);
      } else if (typeof cond !== 'object') {
        parts.push(`${col}.eq.${String(cond)}`);
      } else if ('in' in cond) {
        parts.push(`${col}.in.(${cond.in.map(String).join(',')})`);
      } else if ('neq' in cond) {
        parts.push(`${col}.neq.${String(cond.neq)}`);
      } else if ('isNull' in cond) {
        parts.push(cond.isNull ? `${col}.is.null` : `${col}.not.is.null`);
      } else {
        throw new Error(`orWhere でサポートしていない条件です: ${col}`);
      }
    }
    if (parts.length === 0) return '';
    return parts.length === 1 ? (parts[0] as string) : `and(${parts.join(',')})`;
  }

  private applyOrWhere<T>(builder: AnyFilter, orWhere: Array<Where<T>> | undefined): AnyFilter {
    if (!orWhere || orWhere.length === 0) return builder;
    const clauses = orWhere.map((clause) => this.toOrClause(clause)).filter(Boolean);
    if (clauses.length === 0) return builder;
    return builder.or(clauses.join(','));
  }

  async select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]> {
    let builder = this.client.from(SQL_TABLE_NAMES[table]).select('*') as unknown as AnyFilter;
    builder = this.applyWhere(builder, query?.where);
    builder = this.applyOrWhere(builder, query?.orWhere);
    for (const orderBy of toOrderByList(query?.orderBy)) {
      builder = builder.order(toSnake(orderBy.column), {
        ascending: orderBy.dir !== 'desc',
      }) as AnyFilter;
    }
    if (query?.limit !== undefined) {
      const from = query.offset ?? 0;
      builder = builder.range(from, from + query.limit - 1) as AnyFilter;
    } else if (query?.offset) {
      builder = builder.range(query.offset, query.offset + 999) as AnyFilter;
    }
    const { data, error } = await builder;
    if (error) throw new Error(`select ${SQL_TABLE_NAMES[table]}: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => rowFromSql<Row<K>>(r));
  }

  async count<K extends TableName>(
    table: K,
    query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>,
  ): Promise<number> {
    let builder = this.client
      .from(SQL_TABLE_NAMES[table])
      .select('id', { count: 'exact', head: true }) as unknown as AnyFilter;
    builder = this.applyWhere(builder, query?.where);
    builder = this.applyOrWhere(builder, query?.orWhere);
    const { count, error } = await builder;
    if (error) throw new Error(`count ${SQL_TABLE_NAMES[table]}: ${error.message}`);
    return count ?? 0;
  }

  async findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null> {
    const { data, error } = await this.client
      .from(SQL_TABLE_NAMES[table])
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`findById ${SQL_TABLE_NAMES[table]}: ${error.message}`);
    return data ? rowFromSql<Row<K>>(data as Record<string, unknown>) : null;
  }

  /**
   * 行を追加する。
   *
   * **書いた行を読み返さない**（PostgREST の RETURNING を要求しない）。
   * RLS では INSERT が通っても、返す行は SELECT ポリシーで評価される。
   * 次の 2 つは「書けるが自分では読めない」行で、読み返すと必ず失敗する。
   *
   *  - notifications … SELECT は user_id = auth.uid()。他人宛のメンション通知
   *  - audit_events  … SELECT は common.audit.read が必要。この権限を持たないロール
   *                    （15 中 10。拠点担当・レビュー担当・承認者など）の操作記録
   *
   * ID も日時もアプリ側で決めているため、DB から受け取り直す必要はない。
   * 呼び出し側も戻り値を使っていない（全 46 箇所）。
   */
  async insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]> {
    const payload = rows.map((r) => rowToSql(r as unknown as Record<string, unknown>));
    const { error } = await this.client.from(SQL_TABLE_NAMES[table]).insert(payload);
    if (error) throw new Error(`insert ${SQL_TABLE_NAMES[table]}: ${error.message}`);
    return rows;
  }

  async update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    const { data, error } = await this.client
      .from(SQL_TABLE_NAMES[table])
      .update(rowToSql(patch as unknown as Record<string, unknown>))
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`update ${SQL_TABLE_NAMES[table]}: ${error.message}`);
    return rowFromSql<Row<K>>(data as Record<string, unknown>);
  }

  async softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    const { error } = await this.client
      .from(SQL_TABLE_NAMES[table])
      .update({ deleted_at: at })
      .eq('id', id);
    if (error) throw new Error(`softDelete ${SQL_TABLE_NAMES[table]}: ${error.message}`);
  }
}
