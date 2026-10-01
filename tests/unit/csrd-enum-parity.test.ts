import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSRD_SECTIONS,
  DMA_AXIS_ASSESSMENTS,
  DMA_SCORING_METHODS,
  ESRS_TOPICS,
  IMPACT_DIRECTIONS,
  IMPACT_OCCURRENCES,
  IRO_TYPES,
  SSBJ_ACTION_STATUSES,
  SSBJ_ACTION_TYPES,
  SSBJ_CONSOLIDATION_SCOPES,
  SSBJ_COVERAGE_STATUSES,
  SSBJ_GAP_KINDS,
  SSBJ_PRIORITIES,
  SSBJ_REVIEW_DECISIONS,
  SSBJ_VALUE_CHAIN_SCOPES,
  TIME_HORIZONS,
  VALUE_CHAIN_STAGES,
} from '../../src/types/domain';

/**
 * TS の enum 配列と、CSRD の migration（0044〜0046）の CHECK 制約の値の一致。
 *
 * 片方だけに値を足すと、Demo Mode では通るのに Supabase Mode で INSERT が CHECK 違反になる
 * （Demo はインメモリで CHECK を持たないため、テストでも気付けない）。
 * ESRS のテーマ（'E1' など）・採点方法（'dma-demo-v1'）は大文字・ハイフンを含むため、
 * disclosure-enum-parity.test.ts とは別の読み取りにしている。
 */

const MIGRATIONS_DIR = 'supabase/migrations';

const SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

function tableBody(table: string): string {
  const m = new RegExp(`^create table ${table} \\(([\\s\\S]*?)\\n\\);`, 'im').exec(SQL);
  if (!m) throw new Error(`create table ${table} が見つかりません`);
  return m[1]!;
}

/** 列定義の `check (<column> in (...))` の値（改行をはさんでもよい） */
function checkValues(table: string, column: string): string[] {
  const m = new RegExp(`check \\(${column} in\\s*\\(([^)]*)\\)`, 'i').exec(tableBody(table));
  if (!m) throw new Error(`${table}.${column} の CHECK が見つかりません`);
  return [...m[1]!.matchAll(/'([A-Za-z0-9_-]+)'/g)].map((v) => v[1]!).sort();
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('TS の enum と migration の CHECK 制約の一致（CSRD・0044〜0046）', () => {
  it('分析条件（0044）', () => {
    expect(checkValues('csrd_analysis_settings', 'consolidation_scope')).toEqual(
      sorted(SSBJ_CONSOLIDATION_SCOPES),
    );
    expect(checkValues('csrd_analysis_settings', 'value_chain_scope')).toEqual(
      sorted(SSBJ_VALUE_CHAIN_SCOPES),
    );
    expect(checkValues('csrd_analysis_settings', 'scoring_method')).toEqual(
      sorted(DMA_SCORING_METHODS),
    );
  });

  it('事項・IRO（0044）', () => {
    expect(checkValues('csrd_dma_matters', 'esrs_topic')).toEqual(sorted(ESRS_TOPICS));
    expect(checkValues('csrd_dma_matters', 'impact_assessment')).toEqual(
      sorted(DMA_AXIS_ASSESSMENTS),
    );
    expect(checkValues('csrd_dma_matters', 'financial_assessment')).toEqual(
      sorted(DMA_AXIS_ASSESSMENTS),
    );
    expect(checkValues('csrd_dma_iros', 'iro_type')).toEqual(sorted(IRO_TYPES));
    expect(checkValues('csrd_dma_iros', 'value_chain_stage')).toEqual(sorted(VALUE_CHAIN_STAGES));
    expect(checkValues('csrd_dma_iros', 'time_horizon')).toEqual(sorted(TIME_HORIZONS));
    expect(checkValues('csrd_dma_iros', 'impact_occurrence')).toEqual(sorted(IMPACT_OCCURRENCES));
    expect(checkValues('csrd_dma_iros', 'impact_direction')).toEqual(sorted(IMPACT_DIRECTIONS));
  });

  it('評価・対応計画（0045）', () => {
    for (const column of [
      'disclosure_status',
      'data_status',
      'process_status',
      'ai_disclosure_status',
      'ai_data_status',
      'ai_process_status',
      'ai_status',
      'final_status',
    ]) {
      expect(checkValues('csrd_assessments', column), column).toEqual(
        sorted(SSBJ_COVERAGE_STATUSES),
      );
    }
    expect(checkValues('csrd_assessments', 'review_decision')).toEqual(
      sorted(SSBJ_REVIEW_DECISIONS),
    );
    expect(checkValues('csrd_action_plans', 'gap_kind')).toEqual(sorted(SSBJ_GAP_KINDS));
    expect(checkValues('csrd_action_plans', 'action_type')).toEqual(sorted(SSBJ_ACTION_TYPES));
    expect(checkValues('csrd_action_plans', 'priority')).toEqual(sorted(SSBJ_PRIORITIES));
    expect(checkValues('csrd_action_plans', 'status')).toEqual(sorted(SSBJ_ACTION_STATUSES));
  });

  it('開示ドラフトの節（0046）', () => {
    expect(checkValues('csrd_disclosure_drafts', 'section')).toEqual(sorted(CSRD_SECTIONS));
  });
});
