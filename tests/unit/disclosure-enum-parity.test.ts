import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_ACQUIRED_BY,
  ANCHOR_KINDS,
  APPLICABILITY_STATUSES,
  AUDIT_EVENT_TYPES,
  AVAILABILITY_STATUSES,
  BLOCK_STATUSES,
  BLOCK_VERSION_ORIGINS,
  DISCLOSURE_LANGUAGES,
  DISCLOSURE_PROJECT_STATUSES,
  DISCLOSURE_PURPOSES,
  EVIDENCE_USAGE_PURPOSES,
  EXPORT_ARTIFACT_FORMATS,
  EXPORT_AUDIENCES,
  FRAMEWORK_COVERAGE_STATUSES,
  FRAMEWORK_KEYS,
  FRAMEWORK_LEGAL_STATUSES,
  KPI_DIRECTIONS,
  KPI_TARGET_TYPES,
  MATERIALITY_BASES,
  NARRATIVE_STATUSES,
  NARRATIVE_THEMES,
  QUANTITATIVE_IMPORT_STATUSES,
  RECHECK_DECISIONS,
  RECHECK_REF_KINDS,
  REPORT_SNAPSHOT_KINDS,
  REVIEW_COMMENT_SEVERITIES,
  REVIEW_EVENT_TYPES,
  REVIEW_REQUEST_STATUSES,
  REVIEW_STAGES,
  REVIEW_TARGET_TYPES,
  VALUE_KINDS,
} from '../../src/types/domain';

/**
 * TS の enum 配列と、migration の CHECK 制約の値の一致（0033〜0040）。
 *
 * 片方だけに値を足すと、Demo Mode では通るのに Supabase Mode で INSERT が
 * CHECK 違反になる（Demo はインメモリで CHECK を持たないため、テストでも気付けない）。
 */

const MIGRATIONS_DIR = 'supabase/migrations';

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

const SQL = migrationSql();

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!).sort();
}

/** CREATE TABLE の本体（列定義） */
function tableBody(table: string): string {
  const m = new RegExp(`^create table ${table} \\(([\\s\\S]*?)\\n\\);`, 'im').exec(SQL);
  if (!m) throw new Error(`create table ${table} が見つかりません`);
  return m[1]!;
}

/** 列定義の `check (<column> in (...))` の値 */
function checkValues(table: string, column: string): string[] {
  const m = new RegExp(`check \\(${column} in \\(([^)]*)\\)`, 'i').exec(tableBody(table));
  if (!m) throw new Error(`${table}.${column} の CHECK が見つかりません`);
  return quotedValues(m[1]!);
}

/** ALTER TABLE ... ADD COLUMN の `check (<column> in (...))` の値 */
function addedColumnCheckValues(table: string, column: string): string[] {
  const m = new RegExp(
    `alter table ${table}\\s+[^;]*?add column ${column} [^;]*?check \\(${column} in\\s*\\(([^)]*)\\)`,
    'i',
  ).exec(SQL);
  if (!m) throw new Error(`${table}.${column} の追加列の CHECK が見つかりません`);
  return quotedValues(m[1]!);
}

/** 付け替えた CHECK 制約のうち最後のもの（0018 / 0034 / 0040 方式） */
function lastConstraintValues(constraint: string, column: string): string[] {
  const matches = [
    ...SQL.matchAll(
      new RegExp(
        `add constraint ${constraint}\\s+check \\(${column} in \\(([\\s\\S]*?)\\)\\);`,
        'gi',
      ),
    ),
  ];
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`${constraint} が見つかりません`);
  return quotedValues(last[1]!);
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('TS の enum と migration の CHECK 制約の一致（開示優先モード）', () => {
  it('監査ログの種類（0040 で付け替えた最新の制約）', () => {
    expect(lastConstraintValues('audit_events_event_type_check', 'event_type')).toEqual(
      sorted(AUDIT_EVENT_TYPES),
    );
  });

  it('開示フレームワークの key（0034 で esrs_40a を追加）', () => {
    expect(lastConstraintValues('disclosure_frameworks_key_check', 'key')).toEqual(
      sorted(FRAMEWORK_KEYS),
    );
    expect(FRAMEWORK_KEYS).toContain('esrs_40a');
  });

  it('基準の版メタデータ・根拠資料の利用目的（0034）', () => {
    expect(addedColumnCheckValues('disclosure_framework_versions', 'legal_status')).toEqual(
      sorted(FRAMEWORK_LEGAL_STATUSES),
    );
    expect(addedColumnCheckValues('disclosure_framework_versions', 'materiality_basis')).toEqual(
      sorted(MATERIALITY_BASES),
    );
    expect(addedColumnCheckValues('disclosure_framework_versions', 'coverage_status')).toEqual(
      sorted(FRAMEWORK_COVERAGE_STATUSES),
    );
    expect(addedColumnCheckValues('files', 'usage_purpose')).toEqual(
      sorted(EVIDENCE_USAGE_PURPOSES),
    );
  });

  it('値の区分・値の有無（0039）', () => {
    for (const table of ['data_points', 'data_point_versions']) {
      expect(addedColumnCheckValues(table, 'value_kind')).toEqual(sorted(VALUE_KINDS));
      expect(addedColumnCheckValues(table, 'availability_status')).toEqual(
        sorted(AVAILABILITY_STATUSES),
      );
    }
  });

  it('開示プロジェクト・適用判断（0035）', () => {
    const purposes = /check \(purposes <@ array\[([\s\S]*?)\]::text\[\]\)/.exec(
      tableBody('disclosure_projects'),
    );
    expect(quotedValues(purposes?.[1] ?? '')).toEqual(sorted(DISCLOSURE_PURPOSES));
    expect(checkValues('disclosure_projects', 'status')).toEqual(
      sorted(DISCLOSURE_PROJECT_STATUSES),
    );
    const languages = /languages <@ array\[([^\]]*)\]/.exec(tableBody('disclosure_projects'));
    expect(quotedValues(languages?.[1] ?? '')).toEqual(sorted(DISCLOSURE_LANGUAGES));
    expect(checkValues('project_frameworks', 'purpose')).toEqual(sorted(DISCLOSURE_PURPOSES));
    expect(checkValues('project_frameworks', 'applicability_status')).toEqual(
      sorted(APPLICABILITY_STATUSES),
    );
    // 確定する判断に「未判定」は無い
    expect(checkValues('project_framework_decisions', 'applicability_status')).toEqual(
      sorted(APPLICABILITY_STATUSES.filter((s) => s !== 'not_assessed')),
    );
  });

  it('定性情報・引用位置（0036）', () => {
    expect(checkValues('narrative_records', 'theme')).toEqual(sorted(NARRATIVE_THEMES));
    expect(checkValues('narrative_records', 'status')).toEqual(sorted(NARRATIVE_STATUSES));
    expect(checkValues('source_anchors', 'anchor_kind')).toEqual(sorted(ANCHOR_KINDS));
    expect(checkValues('source_anchors', 'acquired_by')).toEqual(sorted(ANCHOR_ACQUIRED_BY));
  });

  it('本文・レビュー（0037）', () => {
    expect(checkValues('disclosure_blocks', 'status')).toEqual(sorted(BLOCK_STATUSES));
    expect(checkValues('disclosure_blocks', 'language')).toEqual(sorted(DISCLOSURE_LANGUAGES));
    expect(checkValues('disclosure_block_versions', 'origin')).toEqual(
      sorted(BLOCK_VERSION_ORIGINS),
    );
    expect(checkValues('review_requests', 'target_type')).toEqual(sorted(REVIEW_TARGET_TYPES));
    expect(checkValues('review_requests', 'status')).toEqual(sorted(REVIEW_REQUEST_STATUSES));
    expect(checkValues('review_events', 'event_type')).toEqual(sorted(REVIEW_EVENT_TYPES));
    expect(checkValues('review_events', 'stage')).toEqual(sorted(REVIEW_STAGES));
    expect(checkValues('review_comments', 'severity')).toEqual(sorted(REVIEW_COMMENT_SEVERITIES));
    expect(checkValues('recheck_decisions', 'ref_kind')).toEqual(sorted(RECHECK_REF_KINDS));
    expect(checkValues('recheck_decisions', 'decision')).toEqual(sorted(RECHECK_DECISIONS));
  });

  it('スナップショット・出力・KPI・取込バッチ（0038・0039）', () => {
    expect(checkValues('report_snapshots', 'snapshot_kind')).toEqual(sorted(REPORT_SNAPSHOT_KINDS));
    expect(checkValues('export_artifacts', 'format')).toEqual(sorted(EXPORT_ARTIFACT_FORMATS));
    expect(checkValues('export_artifacts', 'audience')).toEqual(sorted(EXPORT_AUDIENCES));
    expect(checkValues('kpi_targets', 'target_type')).toEqual(sorted(KPI_TARGET_TYPES));
    expect(checkValues('kpi_targets', 'direction')).toEqual(sorted(KPI_DIRECTIONS));
    expect(checkValues('quantitative_import_batches', 'status')).toEqual(
      sorted(QUANTITATIVE_IMPORT_STATUSES),
    );
  });
});
