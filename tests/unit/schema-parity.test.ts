import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQL_TABLE_NAMES } from '../../src/lib/repositories/table-names';

/**
 * TS 側のテーブル対応表と、実際のスキーマの一致を検査する。
 *
 * `src/lib/repositories/table-names.ts` と `src/types/domain.ts` の両方が
 * 「このテストが検証する」と書いていたが、テスト自体が存在しなかった。
 *
 * ここで見るのは**テーブル名の対応**まで。
 * 列レベルの一致は実 Postgres が要るので `pnpm test:rls`（PGlite にマイグレーションを
 * 適用する）と `pnpm verify:supabase` が担当する。
 */

const MIGRATIONS_DIR = 'supabase/migrations';

/** マイグレーションを番号順に連結する */
function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

/** CREATE TABLE で作られ、DROP されていないテーブル名 */
function tablesInSchema(sql: string): Set<string> {
  const created = new Set<string>();
  for (const m of sql.matchAll(/^create table (?:if not exists )?([a-z0-9_]+)\s*\(/gim)) {
    created.add(m[1]!);
  }
  for (const m of sql.matchAll(/^drop table (?:if exists )?([a-z0-9_]+)/gim)) {
    created.delete(m[1]!);
  }
  return created;
}

/**
 * アプリからは触らないテーブル。
 * 触らない理由を書いておかないと、単なる対応漏れと区別が付かない。
 */
const UNMAPPED: Record<string, string> = {
  ai_feedback: 'Phase 1 未使用（採否は ai_runs と audit_events に残す）',
  roles: 'ロールの定義。読み出しは role_permissions 経由',
  permissions: '権限の定義。同上',
  role_permissions:
    'DB 層の権限表。アプリ層は roles.ts を使い、一致は authorization.test.ts が検査',
  // 以下はスキーマだけ用意してあり、Phase 1 のアプリからは読み書きしない。
  // seed も投入しない（空のまま）。docs/known-limitations.md に記載。
  user_preferences: 'Phase 1 未使用。表示設定は URL とローカル状態で持つ',
  aggregation_runs: 'Phase 1 未使用。集計はリクエストごとに計算する',
  workflow_definitions: 'Phase 1 未使用。承認段階は data_points の status で表す',
  workflow_instances: 'Phase 1 未使用。同上',
  workflow_steps: 'Phase 1 未使用。同上',
  ai_jobs: 'Phase 1 未使用。AI は同期実行で ai_runs に残す',
  ai_sources: 'Phase 1 未使用。出典は ai_runs.source_references に持つ',
  workpaper_references: 'Phase 1 未使用。調書番号は assurance_tests.workpaper_ref に持つ',
};

describe('スキーマとテーブル対応表の一致', () => {
  const sql = migrationSql();
  const schemaTables = tablesInSchema(sql);
  const mapped = new Set(Object.values(SQL_TABLE_NAMES));

  it('対応表が指す先がすべて実在する', () => {
    const missing = [...mapped].filter((name) => !schemaTables.has(name));
    expect(missing, 'SQL_TABLE_NAMES にあるが CREATE TABLE が無い').toEqual([]);
  });

  it('スキーマにあるテーブルは、対応表にあるか「触らない理由」が書かれている', () => {
    const unexplained = [...schemaTables].filter(
      (name) => !mapped.has(name) && !(name in UNMAPPED),
    );
    expect(unexplained, '対応表にも UNMAPPED にも無いテーブル').toEqual([]);
  });

  it('UNMAPPED に、もう存在しないテーブルが残っていない', () => {
    const stale = Object.keys(UNMAPPED).filter((name) => !schemaTables.has(name));
    expect(stale, 'UNMAPPED の記載が実態と合っていない').toEqual([]);
  });

  it('対応表のキーと値が 1 対 1（同じテーブルを 2 つのキーが指していない）', () => {
    const seen = new Map<string, string[]>();
    for (const [key, value] of Object.entries(SQL_TABLE_NAMES)) {
      seen.set(value, [...(seen.get(value) ?? []), key]);
    }
    const duplicated = [...seen.entries()].filter(([, keys]) => keys.length > 1);
    expect(duplicated, '同じテーブルを複数のキーが指している').toEqual([]);
  });
});
