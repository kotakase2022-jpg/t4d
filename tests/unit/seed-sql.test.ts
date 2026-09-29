import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '../../src/lib/fixtures/store';
import { SEED_ORDER, fixtureToSeedSql, isJsonbColumn } from '../../src/lib/fixtures/to-sql';
import { SQL_TABLE_NAMES } from '../../src/lib/repositories/table-names';
import type { TableName } from '../../src/lib/repositories/types';

/**
 * Fixture → seed.sql の生成経路の検査。
 *
 * これまで次の 3 つはどのテストにも捕まらなかった（W0 棚卸し tests-infra）。
 *  - seed.sql の再生成忘れ（Demo と Supabase で架空データが食い違う）
 *  - SEED_ORDER への追加漏れ（その表の行が黙って投入されない）
 *  - jsonb 列の登録漏れ（JS 配列が Postgres 配列リテラルで書かれ、行が入った時点で投入が壊れる）
 */

const MIGRATIONS_DIR = 'supabase/migrations';

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

/** 列定義の行に見えるが列ではないもの（制約・外部キーの続き行） */
const NOT_A_COLUMN = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'references',
  'exclude',
  'like',
]);

/**
 * migration から「表 → 列 → 型（先頭の語）」を集める。
 * CREATE TABLE の列定義と ALTER TABLE ... ADD COLUMN の両方を見る。
 */
function columnTypes(sql: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  const columnsOf = (table: string) => {
    const existing = tables.get(table);
    if (existing) return existing;
    const created = new Map<string, string>();
    tables.set(table, created);
    return created;
  };

  for (const m of sql.matchAll(
    /^create table (?:if not exists )?([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gim,
  )) {
    const columns = columnsOf(m[1]!);
    for (const line of m[2]!.split('\n')) {
      const col = /^\s+([a-z_][a-z0-9_]*)\s+([a-z]+(?:\[\])?)/.exec(line);
      if (!col || NOT_A_COLUMN.has(col[1]!)) continue;
      columns.set(col[1]!, col[2]!);
    }
  }
  for (const m of sql.matchAll(/^alter table ([a-z0-9_]+)\s+([^;]*?);/gim)) {
    const columns = columnsOf(m[1]!);
    for (const add of m[2]!.matchAll(/add column ([a-z_][a-z0-9_]*) ([a-z]+(?:\[\])?)/g)) {
      columns.set(add[1]!, add[2]!);
    }
  }
  return tables;
}

const TS_KEY_BY_SQL = new Map(
  Object.entries(SQL_TABLE_NAMES).map(([key, sqlName]) => [sqlName, key as TableName]),
);

describe('seed.sql の生成', () => {
  it('supabase/seed.sql は Fixture から再生成した内容と一致する（pnpm seed:generate 忘れの検出）', () => {
    const expected = fixtureToSeedSql(createFixtureDb(), { authUsers: 'supabase' });
    // Git の改行変換（CRLF）に左右されないよう改行を揃えて比べる
    const actual = readFileSync('supabase/seed.sql', 'utf8').replace(/\r\n/g, '\n');
    expect(actual === expected, 'seed.sql が古い。pnpm seed:generate を実行する').toBe(true);
  });

  it('SEED_ORDER は対応表のすべての表を 1 回ずつ含む', () => {
    const keys = Object.keys(SQL_TABLE_NAMES).sort();
    expect([...SEED_ORDER].sort()).toEqual(keys);
    expect(new Set(SEED_ORDER).size).toBe(SEED_ORDER.length);
  });

  it('FixtureDb は対応表のすべての表を配列で持つ', () => {
    const db = createFixtureDb() as unknown as Record<string, unknown>;
    expect(Object.keys(db).sort()).toEqual(Object.keys(SQL_TABLE_NAMES).sort());
    for (const key of Object.keys(SQL_TABLE_NAMES)) expect(Array.isArray(db[key]), key).toBe(true);
  });
});

describe('jsonb 列の判定と migration の一致', () => {
  const types = columnTypes(migrationSql());

  it('列の型を migration から読めている（空振りテストでないことの確認）', () => {
    expect(types.get('disclosure_block_versions')?.get('body')).toBe('jsonb');
    expect(types.get('comments')?.get('body')).toBe('text');
    expect(types.get('disclosure_projects')?.get('purposes')).toBe('text[]');
    expect(types.get('data_points')?.get('availability_status')).toBe('text');
    expect(types.get('disclosure_framework_versions')?.get('legal_status')).toBe('text');
  });

  it('seed 生成が jsonb と見なす列は、migration で jsonb の列と完全に一致する', () => {
    const mismatches: string[] = [];
    for (const [sqlTable, columns] of types) {
      const tsKey = TS_KEY_BY_SQL.get(sqlTable);
      if (!tsKey) continue; // アプリから触らない表（schema-parity.test.ts の UNMAPPED）
      for (const [column, type] of columns) {
        const expected = type === 'jsonb';
        if (isJsonbColumn(tsKey, column) !== expected) {
          mismatches.push(`${sqlTable}.${column}（migration: ${type}）`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('同名で型の違う列（body など）を表ごとに区別できる', () => {
    expect(isJsonbColumn('disclosureBlockVersions', 'body')).toBe(true);
    expect(isJsonbColumn('narrativeVersions', 'body')).toBe(false);
    expect(isJsonbColumn('reviewComments', 'body')).toBe(false);
    expect(isJsonbColumn('comments', 'body')).toBe(false);
  });
});
