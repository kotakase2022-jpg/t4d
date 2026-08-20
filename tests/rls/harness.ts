import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createFixtureDb } from '@/lib/fixtures/store';
import { fixtureToSqlStatements } from '@/lib/fixtures/to-sql';

/**
 * RLS テストハーネス。
 *
 * Docker も実 Supabase も無しに、**本物の Postgres（PGlite / WASM）へ
 * supabase/migrations/*.sql をそのまま適用**して RLS を検証する。
 *
 * Supabase 固有の前提（auth スキーマ / authenticated ロール）はここでシムを作る。
 * `auth.uid()` は Supabase 本体と同じく `request.jwt.claims` から sub を読む実装にしてある。
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');

/** Supabase 互換シム。migrations 適用前に実行する。 */
const SUPABASE_SHIM = `
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  created_at timestamptz not null default now()
);

-- クレーム未設定（空文字 / NULL）でも例外にならないようにする。
-- Supabase 本体の auth.uid() も未認証時は NULL を返す。
create or replace function auth.claims()
returns json
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.claims() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(auth.claims() ->> 'role', 'anon');
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select auth.claims()::jsonb;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- Supabase 本体と同じ GRANT。auth.uid() を RLS / トリガから直接呼べるようにする。
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

export interface RlsHarness {
  db: PGlite;
  /** 指定ユーザーとして SQL を実行する（RLS が適用される authenticated ロール）。 */
  asUser<T = Record<string, unknown>>(
    userId: string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** 権限エラー / RLS 違反が起きることを期待して実行する。成功したら null を返す。 */
  expectDenied(userId: string, sql: string, params?: unknown[]): Promise<string | null>;
  /** 管理者（RLS バイパス）として実行する。セットアップ検証用。 */
  asSuperuser<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export async function createRlsHarness(): Promise<RlsHarness> {
  const db = new PGlite();
  await db.waitReady;

  await db.exec(SUPABASE_SHIM);

  for (const file of await listMigrations()) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${file} の適用に失敗しました: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  // Fixture を投入（RLS はテーブル所有者には既定で適用されないため superuser で実行）
  const fixture = createFixtureDb();
  const statements = fixtureToSqlStatements(fixture, { authUsers: 'minimal' });
  await db.exec('begin;');
  for (const statement of statements) {
    try {
      await db.exec(statement);
    } catch (error) {
      await db.exec('rollback;');
      throw new Error(
        `Seed の投入に失敗しました: ${(error as Error).message}\n--- SQL ---\n${statement.slice(0, 1200)}`,
        { cause: error },
      );
    }
  }
  await db.exec('commit;');

  async function runAs<T>(userId: string, sql: string, params?: unknown[]): Promise<T[]> {
    // 1 トランザクション内で role と JWT クレームを設定してから実行する。
    await db.exec('begin;');
    try {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await db.exec('set local role authenticated;');
      const result = await db.query<T>(sql, params);
      await db.exec('commit;');
      return result.rows;
    } catch (error) {
      await db.exec('rollback;');
      throw error;
    }
  }

  return {
    db,
    asUser: runAs,
    async expectDenied(userId, sql, params) {
      try {
        await runAs(userId, sql, params);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    },
    async asSuperuser<T>(sql: string, params?: unknown[]) {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },
    async close() {
      await db.close();
    },
  };
}
