import type { TableName } from './types';

/**
 * TS 側テーブルキー → Postgres テーブル名。
 * `supabase/migrations/*.sql` の CREATE TABLE と一致させること
 * （`tests/unit/schema-parity.test.ts` が検証する）。
 */
export const SQL_TABLE_NAMES: Record<TableName, string> = {
  profiles: 'profiles',
  organizations: 'organizations',
  memberships: 'organization_memberships',
  invitations: 'invitations',
  membershipRoles: 'membership_roles',
  relationships: 'organization_relationships',
  grants: 'client_access_grants',

  units: 'organization_units',
  periods: 'reporting_periods',
  campaigns: 'collection_campaigns',
  campaignScopes: 'campaign_scopes',
  metrics: 'metric_definitions',
  aggregationRules: 'aggregation_rules',
  metricAssignments: 'metric_assignments',
  emissionFactors: 'emission_factors',

  dataPoints: 'data_points',
  dataPointVersions: 'data_point_versions',
  calculations: 'data_point_calculations',
  validations: 'data_point_validation_results',

  files: 'files',
  fileVersions: 'file_versions',
  evidenceLinks: 'evidence_links',
  fragments: 'extracted_fragments',
  storageAccessEvents: 'storage_access_events',

  tasks: 'tasks',
  approvals: 'approvals',
  comments: 'comments',
  notifications: 'notifications',
  alerts: 'alerts',

  frameworks: 'disclosure_frameworks',
  frameworkVersions: 'disclosure_framework_versions',
  disclosureItems: 'disclosure_items',
  itemConditions: 'disclosure_item_conditions',
  applicabilityResults: 'applicability_results',
  materialityTopics: 'materiality_topics',
  disclosureResponses: 'disclosure_responses',
  disclosureResponseVersions: 'disclosure_response_versions',
  disclosureMappings: 'disclosure_mappings',
  responseEvidenceLinks: 'response_evidence_links',

  ingestionJobs: 'ingestion_jobs',
  ingestionJobFiles: 'ingestion_job_files',
  ingestionRows: 'ingestion_rows',
  aiRuns: 'ai_runs',

  engagements: 'engagements',
  engagementMembers: 'engagement_members',
  engagementScopes: 'engagement_scopes',
  dataRoomItems: 'data_room_items',
  snapshots: 'assurance_snapshots',
  snapshotItems: 'assurance_snapshot_items',
  snapshotChanges: 'snapshot_changes',
  populations: 'populations',
  populationItems: 'population_items',
  samples: 'samples',
  sampleItems: 'sample_items',
  procedures: 'assurance_procedures',
  tests: 'assurance_tests',
  testResults: 'assurance_test_results',
  pbcRequests: 'pbc_requests',
  pbcResponses: 'pbc_request_responses',
  issues: 'assurance_issues',
  managementResponses: 'management_responses',
  reviewNotes: 'review_notes',
  signoffs: 'signoffs',

  auditEvents: 'audit_events',
};

/**
 * camelCase → snake_case（列名変換）。
 *
 * 数字は区切らない（`sha256` → `sha256`。`sha_256` にしてしまわない）。
 * 大文字の連続は 1 つの区切りとして扱う（`estimatedCostUsd` → `estimated_cost_usd`）。
 */
export function toSnake(input: string): string {
  return input.replace(/[A-Z]+/g, (match, offset: number) =>
    offset === 0 ? match.toLowerCase() : `_${match.toLowerCase()}`,
  );
}

/** snake_case → camelCase。 */
export function toCamel(input: string): string {
  return input.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function rowToSql(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[toSnake(key)] = value;
  return out;
}

export function rowFromSql<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out as T;
}
