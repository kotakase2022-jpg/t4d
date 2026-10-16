import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_STORAGES,
  AI_TRAINING_USES,
  APPROVAL_ROUTE_PURPOSES,
  COST_CLASSES,
  CROSSWALK_RELATIONS,
  CROSSWALK_SOURCES,
  EXCLUSION_DECISIONS,
  EXCLUSION_EVENT_TYPES,
  EXCLUSION_SOURCES,
  EXPORT_AUDIENCES,
  EXPORT_RECONCILIATION_SOURCES,
  FEEDBACK_CHANNELS,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FILING_IDENTIFIER_SCHEMES,
  NDA_STATUSES,
  ORGANIZATION_OPTION_KEYS,
  RECONCILED_FORMATS,
  REQUIREMENT_APPLICABILITIES,
  RESPONSE_CONTENT_LINK_SOURCES,
  RESPONSE_CONTENT_TARGET_KINDS,
  SSBJ_COVERAGE_STATUSES,
  TRIAL_COMPLETIONS,
  TRIAL_DECISIONS,
  TRIAL_END_DISPOSITIONS,
  TRIAL_JUDGEMENTS,
  TRIAL_PHASES,
  TRIAL_SCOPE_KINDS,
  TRIAL_TASK_KEYS,
  TRIAL_THEMES,
  TRIAL_TIMING_METHODS,
  TRIAL_TIMING_MODES,
  XBRL_CONCEPT_KINDS,
  XBRL_LICENSE_STATUSES,
  XBRL_MAPPING_EVENT_TYPES,
  XBRL_MAPPING_ORIGINS,
  XBRL_MAPPING_STATUSES,
  XBRL_PACKAGE_LEGAL_STATUSES,
  XBRL_PERIOD_ROLES,
  XBRL_PROFILES,
  XBRL_REQUIREMENT_BASES,
  XBRL_TARGET_KINDS,
} from '../../src/types/domain';

/**
 * トライアル対応（0049〜0057）の TS の enum 配列と、migration の CHECK 制約の値の一致。
 * 片方だけに値を足すと、Demo Mode では通るのに Supabase Mode で INSERT が CHECK 違反になる。
 */

const MIGRATIONS_DIR = 'supabase/migrations';

const SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!).sort();
}

function tableBody(table: string): string {
  const m = new RegExp(`^create table ${table} \\(([\\s\\S]*?)\\n\\);`, 'im').exec(SQL);
  if (!m) throw new Error(`create table ${table} が見つかりません`);
  return m[1]!;
}

function checkValues(table: string, column: string): string[] {
  const m = new RegExp(`check \\(${column} in \\(([^)]*)\\)`, 'i').exec(tableBody(table));
  if (!m) throw new Error(`${table}.${column} の CHECK が見つかりません`);
  return quotedValues(m[1]!);
}

function addedColumnCheckValues(table: string, column: string): string[] {
  const m = new RegExp(
    `alter table ${table}\\s+[^;]*?add column ${column} [^;]*?check \\(${column} in\\s*\\(([^)]*)\\)`,
    'i',
  ).exec(SQL);
  if (!m) throw new Error(`${table}.${column} の追加列の CHECK が見つかりません`);
  return quotedValues(m[1]!);
}

/**
 * 後の移行で作り直した CHECK（drop constraint → add constraint）の値。いちばん新しい定義を読む
 * （0060 の trial_scenarios_theme_check のように、作り直した後の値が効いている）
 */
function replacedCheckValues(table: string, constraint: string, column: string): string[] {
  const re = new RegExp(
    `alter table ${table}\\s+add constraint ${constraint} check \\(${column} in \\(([^)]*)\\)`,
    'gi',
  );
  const matches = [...SQL.matchAll(re)];
  const last = matches.at(-1);
  if (!last) throw new Error(`${table}.${constraint} の作り直しが見つかりません`);
  return quotedValues(last[1]!);
}

const sorted = (values: readonly string[]) => [...values].sort();

const CASES: Array<[table: string, column: string, values: readonly string[]]> = [
  ['project_requirement_assessments', 'applicability', REQUIREMENT_APPLICABILITIES],
  ['project_requirement_assessments', 'disclosure_coverage', SSBJ_COVERAGE_STATUSES],
  ['project_requirement_assessments', 'data_coverage', SSBJ_COVERAGE_STATUSES],
  ['project_requirement_assessments', 'process_coverage', SSBJ_COVERAGE_STATUSES],
  ['requirement_exclusion_events', 'source', EXCLUSION_SOURCES],
  ['requirement_exclusion_events', 'event', EXCLUSION_EVENT_TYPES],
  ['requirement_exclusion_events', 'decision', EXCLUSION_DECISIONS],
  ['requirement_crosswalks', 'relation', CROSSWALK_RELATIONS],
  ['requirement_crosswalks', 'source', CROSSWALK_SOURCES],
  ['export_reconciliations', 'source', EXPORT_RECONCILIATION_SOURCES],
  ['export_reconciliations', 'format', RECONCILED_FORMATS],
  ['export_reconciliations', 'audience', EXPORT_AUDIENCES],
  ['xbrl_taxonomy_packages', 'profile', XBRL_PROFILES],
  ['xbrl_taxonomy_packages', 'legal_status', XBRL_PACKAGE_LEGAL_STATUSES],
  ['xbrl_taxonomy_packages', 'license_status', XBRL_LICENSE_STATUSES],
  ['xbrl_concepts', 'kind', XBRL_CONCEPT_KINDS],
  ['xbrl_concept_requirements', 'basis', XBRL_REQUIREMENT_BASES],
  ['organization_filing_identifiers', 'scheme', FILING_IDENTIFIER_SCHEMES],
  ['xbrl_tag_mappings', 'target_kind', XBRL_TARGET_KINDS],
  ['xbrl_tag_mappings', 'period_role', XBRL_PERIOD_ROLES],
  ['xbrl_tag_mappings', 'status', XBRL_MAPPING_STATUSES],
  ['xbrl_tag_mappings', 'origin', XBRL_MAPPING_ORIGINS],
  ['xbrl_tag_mapping_events', 'event', XBRL_MAPPING_EVENT_TYPES],
  ['trial_programs', 'phase', TRIAL_PHASES],
  ['trial_programs', 'end_disposition', TRIAL_END_DISPOSITIONS],
  ['trial_programs', 'decision', TRIAL_DECISIONS],
  ['trial_scenario_runs', 'completion', TRIAL_COMPLETIONS],
  ['trial_scenario_judgements', 'judgement', TRIAL_JUDGEMENTS],
  ['trial_feedback_items', 'kind', FEEDBACK_KINDS],
  ['trial_feedback_items', 'channel', FEEDBACK_CHANNELS],
  ['trial_feedback_items', 'severity', FEEDBACK_SEVERITIES],
  ['trial_feedback_items', 'status', FEEDBACK_STATUSES],
  ['trial_feedback_items', 'cost_class', COST_CLASSES],
  ['trial_task_timings', 'task_key', TRIAL_TASK_KEYS],
  ['trial_task_timings', 'mode', TRIAL_TIMING_MODES],
  ['trial_task_timings', 'method', TRIAL_TIMING_METHODS],
  ['organization_data_terms', 'nda_status', NDA_STATUSES],
  ['organization_data_terms', 'ai_training_use', AI_TRAINING_USES],
  ['organization_data_terms', 'ai_provider_storage', AI_PROVIDER_STORAGES],
  ['organization_options', 'option_key', ORGANIZATION_OPTION_KEYS],
  ['response_content_links', 'target_kind', RESPONSE_CONTENT_TARGET_KINDS],
  ['response_content_links', 'link_source', RESPONSE_CONTENT_LINK_SOURCES],
];

describe('トライアル対応の enum と CHECK 制約の一致', () => {
  it.each(CASES)('%s.%s', (table, column, values) => {
    expect(checkValues(table, column)).toEqual(sorted(values));
  });

  it('trial_scenarios.theme（0060 で作り直した CHECK。算定の再現と整合性の確認を含む）', () => {
    expect(replacedCheckValues('trial_scenarios', 'trial_scenarios_theme_check', 'theme')).toEqual(
      sorted(TRIAL_THEMES),
    );
    expect(TRIAL_THEMES).toContain('calculation_reconciliation');
  });

  it('trial_feedback_items.scope_kind（0060 の追加列）', () => {
    expect(addedColumnCheckValues('trial_feedback_items', 'scope_kind')).toEqual(
      sorted(TRIAL_SCOPE_KINDS),
    );
  });

  it('approval_routes.purpose（追加列）', () => {
    expect(addedColumnCheckValues('approval_routes', 'purpose')).toEqual(
      sorted(APPROVAL_ROUTE_PURPOSES),
    );
  });
});
