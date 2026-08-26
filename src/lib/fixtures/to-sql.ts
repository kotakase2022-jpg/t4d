/**
 * Fixture（インメモリ）→ SQL INSERT 文への変換。
 *
 * 用途:
 *  1. `supabase/seed.sql` の生成（scripts/generate-seed.ts）
 *  2. RLS テストのシード（tests/rls/harness.ts）
 *
 * Demo Mode と Supabase Mode で「まったく同じ架空データ」を使えるようにすることで、
 * 両モードの挙動差をテストで検出できるようにする。
 */

import { SQL_TABLE_NAMES, toSnake } from '@/lib/repositories/table-names';
import type { TableName } from '@/lib/repositories/types';
import type { FixtureDb } from './store';

/** jsonb として扱う列（それ以外の JS 配列は Postgres 配列に変換する）。 */
const JSONB_COLUMNS = new Set([
  'inputs',
  'details',
  'metadata',
  'raw',
  'output_json',
  'source_references',
  'token_usage',
  'value_snapshot',
  'filter',
  'parameters',
  'recalculation_input',
  'saved_views',
]);

/**
 * 外部キー制約を満たす投入順序。
 * `current_version_id` 系の循環参照は DEFERRABLE INITIALLY DEFERRED のため
 * 同一トランザクション内であればこの順序で問題ない。
 */
export const SEED_ORDER: TableName[] = [
  'profiles',
  'organizations',
  'memberships',
  'membershipRoles',
  'invitations',
  'relationships',
  'units',
  'periods',
  'campaigns',
  'campaignScopes',
  'metrics',
  'aggregationRules',
  'metricAssignments',
  'emissionFactors',
  'dataPoints',
  'dataPointVersions',
  'calculations',
  'validations',
  'files',
  'fileVersions',
  'fragments',
  'evidenceLinks',
  'storageAccessEvents',
  'frameworks',
  'frameworkVersions',
  'disclosureItems',
  'itemConditions',
  'applicabilityResults',
  'materialityTopics',
  'disclosureResponses',
  'disclosureResponseVersions',
  'disclosureMappings',
  'responseEvidenceLinks',
  'ssbjAssessments',
  'ssbjActionPlans',
  'ingestionJobs',
  'ingestionJobFiles',
  'aiRuns',
  'ingestionRows',
  'engagements',
  'engagementMembers',
  'grants',
  'engagementScopes',
  'dataRoomItems',
  'snapshots',
  'snapshotItems',
  'snapshotChanges',
  'populations',
  'populationItems',
  'samples',
  'sampleItems',
  'procedures',
  'tests',
  'testResults',
  'pbcRequests',
  'pbcResponses',
  'issues',
  'managementResponses',
  'reviewNotes',
  'signoffs',
  'tasks',
  'approvals',
  'comments',
  'notifications',
  'alerts',
  'auditEvents',
];

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toArrayLiteral(values: unknown[]): string {
  if (values.length === 0) return `'{}'`;
  const inner = values
    .map((v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
    .map((v) => `"${v}"`)
    .join(',');
  return quote(`{${inner}}`);
}

function toSqlValue(column: string, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (JSONB_COLUMNS.has(column)) return `${quote(JSON.stringify(value))}::jsonb`;
  if (Array.isArray(value)) return toArrayLiteral(value);
  if (typeof value === 'object') return `${quote(JSON.stringify(value))}::jsonb`;
  return quote(String(value));
}

function buildInsert(sqlTable: string, rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return '';
  // 列は先頭行のキーで決め、各行の値も**同じキー順**で引く。
  // 行ごとの Object.entries に頼るとプロパティ記述順の違いで列ズレする。
  const keys = Object.keys(first);
  const columns = keys.map(toSnake);
  const tuples = rows
    .map((row) => {
      const extra = Object.keys(row).filter((k) => !keys.includes(k));
      if (extra.length > 0) {
        throw new Error(`${sqlTable}: 先頭行に無いキーがあります: ${extra.join(', ')}`);
      }
      const values = keys.map((key) => toSqlValue(toSnake(key), row[key]));
      return `  (${values.join(', ')})`;
    })
    .join(',\n');
  return `insert into ${sqlTable} (${columns.join(', ')}) values\n${tuples};\n`;
}

/** ローカル検証専用のパスワード。リモートへは `seed-demo-users.ts` が実行をブロックする。 */
export const LOCAL_DEMO_PASSWORD = 'T4D-demo-local-only!';

export interface SeedSqlOptions {
  /**
   * auth.users の出力形式。
   *  - `none`     : 出力しない
   *  - `minimal`  : id / email のみ（PGlite の auth シム用）
   *  - `supabase` : GoTrue がメールログインを受け付ける完全な行 ＋ auth.identities
   */
  authUsers: 'none' | 'minimal' | 'supabase';
}

const GOTRUE_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

function authUsersSql(db: FixtureDb, mode: SeedSqlOptions['authUsers']): string[] {
  if (mode === 'none' || db.profiles.length === 0) return [];

  if (mode === 'minimal') {
    const values = db.profiles.map((p) => `  (${quote(p.id)}, ${quote(p.email)})`).join(',\n');
    return [`insert into auth.users (id, email) values\n${values}\non conflict (id) do nothing;\n`];
  }

  // GoTrue はメールログインに aud / role / encrypted_password / email_confirmed_at と
  // auth.identities の行を要求する。パスワードは pgcrypto の crypt() で生成する。
  //
  // confirmation_token / recovery_token / email_change_token_new / email_change は
  // DEFAULT を持たず NULL 可だが、GoTrue（Go）は NULL を文字列へスキャンできず
  // "Database error querying schema" になる。空文字を明示的に入れる。
  const users = db.profiles
    .map(
      (p) =>
        `  (${quote(GOTRUE_INSTANCE_ID)}, ${quote(p.id)}, 'authenticated', 'authenticated', ${quote(p.email)},\n` +
        `   crypt(${quote(LOCAL_DEMO_PASSWORD)}, gen_salt('bf')), now(),\n` +
        `   '', '', '', '',\n` +
        `   '{"provider":"email","providers":["email"]}'::jsonb,\n` +
        `   ${quote(JSON.stringify({ display_name: p.displayName, demo: true }))}::jsonb,\n` +
        `   now(), now())`,
    )
    .join(',\n');

  const identities = db.profiles
    .map(
      (p) =>
        `  (gen_random_uuid(), ${quote(p.id)}, ${quote(p.id)},\n` +
        `   jsonb_build_object('sub', ${quote(p.id)}, 'email', ${quote(p.email)}),\n` +
        `   'email', now(), now(), now())`,
    )
    .join(',\n');

  return [
    `insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values\n${users}\non conflict (id) do nothing;\n`,
    `insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values\n${identities}\non conflict do nothing;\n`,
  ];
}

/** FixtureDb 全体を SQL 文の配列へ変換する（トランザクション境界は呼び出し側で付ける）。 */
export function fixtureToSqlStatements(db: FixtureDb, options: SeedSqlOptions): string[] {
  const statements: string[] = [...authUsersSql(db, options.authUsers)];

  for (const table of SEED_ORDER) {
    const rows = db[table] as unknown as Record<string, unknown>[];
    if (!rows || rows.length === 0) continue;
    const sql = buildInsert(SQL_TABLE_NAMES[table], rows);
    if (sql) statements.push(sql);
  }

  return statements;
}

export function fixtureToSeedSql(db: FixtureDb, options: SeedSqlOptions): string {
  const header = `-- ======================================================================
-- T4D Seed（架空データ）
--
-- 自動生成ファイル。直接編集せず \`pnpm seed:generate\` で再生成すること。
-- 生成元: src/lib/fixtures/store.ts（createFixtureDb）
--
-- 実在企業・実在監査法人・実在個人は含まれていません。
-- 実顧客データを本ファイルへ追加しないでください。
-- ======================================================================

begin;

`;
  const footer = `
commit;
`;
  return header + fixtureToSqlStatements(db, options).join('\n') + footer;
}
