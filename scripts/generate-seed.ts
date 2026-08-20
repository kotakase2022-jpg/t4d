/**
 * supabase/seed.sql を Fixture から生成する。
 *
 *   pnpm seed:generate
 *
 * Demo Mode（インメモリ）と Supabase Mode（Postgres）で
 * 同一の架空データを使うための唯一の生成経路。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureDb } from '../src/lib/fixtures/store';
import { fixtureToSeedSql } from '../src/lib/fixtures/to-sql';

async function main() {
  const db = createFixtureDb();
  const sql = fixtureToSeedSql(db, { authUsers: 'supabase' });
  const target = path.resolve(process.cwd(), 'supabase', 'seed.sql');
  await writeFile(target, sql, 'utf8');

  const rowCount = Object.values(db).reduce(
    (sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  console.log(`✓ ${path.relative(process.cwd(), target)} を生成しました（${rowCount} 行）`);
}

main().catch((error) => {
  console.error('seed.sql の生成に失敗しました:', error);
  process.exit(1);
});
