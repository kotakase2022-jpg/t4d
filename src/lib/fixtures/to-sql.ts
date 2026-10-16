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

/**
 * jsonb として扱う列（それ以外の JS 配列は Postgres 配列に変換する）。
 *
 * 列名だけで判定するため、ここには**どの表でも jsonb である列名**だけを置く。
 * 同じ列名が表によって text / text[] / uuid[] になるもの（例: `body` は
 * comments では text、disclosure_block_versions では jsonb）は下の表別の一覧に書く。
 * 一覧と migration の一致は tests/unit/seed-sql.test.ts が検査する。
 */
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

/** 表ごとに jsonb である列（列名が他の表の text / 配列列と重なりうるもの）。 */
const JSONB_COLUMNS_BY_TABLE: Partial<Record<TableName, ReadonlySet<string>>> = {
  // JS 配列を持つ jsonb。ここに無いと Postgres 配列リテラルとして書かれて投入に失敗する
  ssbjDisclosureDrafts: new Set(['gaps']),
  csrdDisclosureDrafts: new Set(['gaps']),
  projectFrameworks: new Set(['conditions']),
  projectFrameworkDecisions: new Set(['conditions_snapshot']),
  narrativeVersions: new Set(['fields']),
  disclosureBlocks: new Set(['working_body']),
  disclosureBlockVersions: new Set(['body']),
  reviewRequests: new Set(['policy', 'referenced_versions']),
  reportSnapshots: new Set(['framework_versions', 'blocks', 'metric_values', 'anchors']),
  quantitativeImportBatches: new Set(['rows']),
  // トライアル対応（0049〜0056）
  exportArtifacts: new Set(['validation_summary']),
  projectRequirementAssessmentEvents: new Set(['before', 'after']),
  sharedReportCopies: new Set(['copy']),
  exportReconciliations: new Set(['mismatches']),
  xbrlConcepts: new Set(['concept_references']),
  xbrlTagMappings: new Set(['dimensions']),
  xbrlTagMappingEvents: new Set(['before', 'after']),
  trialPrograms: new Set(['options', 'agreements']),
  trialScenarioRuns: new Set(['evidence']),
  organizationDataTerms: new Set(['subprocessors']),
  // Scope1・2 の算定と既存結果との照合（0061〜0065）
  emissionFactors: new Set(['params']),
  ghgCalculationPolicies: new Set(['rounding', 'conversions', 'tonkm']),
  ghgClassificationRules: new Set(['match']),
  ghgActivityLines: new Set(['attributes']),
  ghgCalculationRuns: new Set(['summary']),
  ghgCalculationLines: new Set(['conversion_steps', 'method_detail', 'rounding_applied']),
  ghgBaselineResults: new Set(['rows', 'unit_mapping']),
  ghgReconciliations: new Set(['tolerance', 'result']),
};

/** Seed 生成で jsonb として書く列か（tests/unit/seed-sql.test.ts から migration と突合する）。 */
export function isJsonbColumn(table: TableName, column: string): boolean {
  return JSONB_COLUMNS.has(column) || (JSONB_COLUMNS_BY_TABLE[table]?.has(column) ?? false);
}

/**
 * 外部キー制約を満たす投入順序。
 * `current_version_id` 系の循環参照は DEFERRABLE INITIALLY DEFERRED のため
 * 同一トランザクション内であればこの順序で問題ない。
 */
export const SEED_ORDER: TableName[] = [
  'profiles',
  'organizations',
  // 契約で開くオプション・提出者の識別子・データ取扱条件（組織だけを参照する）
  'organizationOptions',
  'organizationFilingIdentifiers',
  'organizationDataTerms',
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
  // 係数のセット → 係数 → 割当（係数は (セット, 組織) を、割当は (係数, 組織) を参照する）
  'emissionFactorSets',
  'emissionFactors',
  'emissionFactorAssignments',
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
  // テナント横断のマスター（要求事項の横断対応・XBRL のタクソノミ）。要求事項の行が先に要る
  'requirementCrosswalks',
  'xbrlTaxonomyPackages',
  'xbrlConcepts',
  'xbrlConceptRequirements',
  'applicabilityResults',
  'materialityTopics',
  'disclosureResponses',
  'disclosureResponseVersions',
  'disclosureMappings',
  'responseEvidenceLinks',
  'ssbjAssessments',
  'ssbjActionPlans',
  'ssbjAnalysisSettings',
  'ssbjDisclosureDrafts',
  'ingestionJobs',
  'ingestionJobFiles',
  'aiRuns',
  'aiFeedback',
  'ingestionRows',
  // 開示優先モード。版・判断は ai_runs・file_versions・extracted_fragments を参照するため
  // それらより後に置く（current_* のポインタは遅延可能な外部キー）。
  'organizationFeatureSettings',
  'disclosureProjects',
  'projectFrameworks',
  'projectFrameworkDecisions',
  // 要求事項の判断（0049）。基準の行と要求事項が先に要る。対象外の申請は SSBJ の評価・判断の行の後
  'projectRequirementAssessments',
  'projectRequirementAssessmentEvents',
  'requirementExclusionEvents',
  'narrativeRecords',
  'narrativeRequirementLinks',
  'sourceAnchors',
  // CSRD（docs/disclosure-first.md §9.3）。評価・節は ai_runs を (id, organization_id) で参照するため
  // それより後に置く。IRO は事項を、計画は評価を参照する。IRO の根拠（0052）は引用位置の後、
  // 定性情報の版の IRO の参照（0052）は IRO の後
  'csrdAnalysisSettings',
  'csrdDmaMatters',
  'csrdDmaIros',
  'csrdAssessments',
  'csrdActionPlans',
  'csrdDisclosureDrafts',
  'narrativeVersions',
  'disclosureBlocks',
  'disclosureBlockVersions',
  'reviewRequests',
  'reviewEvents',
  'reviewComments',
  'recheckDecisions',
  'reportSnapshots',
  'exportArtifacts',
  'exportReconciliations',
  'kpiTargets',
  'quantitativeImportBatches',
  // XBRL の対応付け（0054）。プロジェクト・指標・拠点・マスター・AI の実行の後
  'xbrlTagMappings',
  'xbrlTagMappingEvents',
  // トライアルの評価（0055）。プロジェクトの後
  'trialPrograms',
  'trialScenarios',
  'trialScenarioRuns',
  'trialScenarioJudgements',
  'trialFeedbackItems',
  'trialTaskTimings',
  // CDP 等の回答と T4D の情報の対応付け（0057）。定性情報・節の後
  'responseContentLinks',
  // Scope1・2 の算定と照合（0062〜0065）。方針・規則 → 活動量 → 算定の記録 → 算定行 → 既存結果 → 照合 → 確認
  'ghgCalculationPolicies',
  'ghgClassificationRules',
  'ghgActivityBatches',
  'ghgActivityLines',
  'ghgCalculationRuns',
  'ghgCalculationLines',
  'ghgBaselineResults',
  'ghgReconciliations',
  'ghgReconciliationNotes',
  'engagements',
  'engagementMembers',
  'grants',
  'engagementScopes',
  'dataRoomItems',
  // 保証側へ共有した写し（0050）。案件・許諾・スナップショットの後
  'sharedReportCopies',
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
  'reviewNoteResponses',
  'signoffs',
  'tasks',
  'approvals',
  'approvalRoutes',
  'approvalRouteStages',
  'dataPointApprovalSteps',
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

function toSqlValue(table: TableName, column: string, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (isJsonbColumn(table, column)) return `${quote(JSON.stringify(value))}::jsonb`;
  if (Array.isArray(value)) return toArrayLiteral(value);
  if (typeof value === 'object') return `${quote(JSON.stringify(value))}::jsonb`;
  return quote(String(value));
}

function buildInsert(table: TableName, rows: Record<string, unknown>[]): string {
  const sqlTable = SQL_TABLE_NAMES[table];
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
      const values = keys.map((key) => toSqlValue(table, toSnake(key), row[key]));
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
    const sql = buildInsert(table, rows);
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
