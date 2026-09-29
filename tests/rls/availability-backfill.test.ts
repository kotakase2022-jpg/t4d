import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, createMigratedDb } from './harness';

/**
 * 0039 の backfill（既存行の値の有無）の検証。
 *
 * RLS テストのハーネスは空の DB に全 migration を当ててから Fixture を入れるため、
 * backfill は 0 行に対して走るだけで検証にならない。ここでは 0038 までを当てた DB に
 * 既存行を作ってから 0039 を当て、本番の DB と同じ順序で確かめる。
 *
 * 仕様（docs/disclosure-first.md §3 0039）:
 *   value と text_value がともに NULL の行は not_entered。**not_applicable にはしない。**
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const UNIT = '00000000-0000-4000-8000-0000000000a2';
const PERIOD = '00000000-0000-4000-8000-0000000000a3';
const METRIC = '00000000-0000-4000-8000-0000000000a4';

/** 既存行: [ID, value, text_value] */
const EXISTING: Array<[id: string, value: number | null, text: string | null, boundary: string]> = [
  ['00000000-0000-4000-8000-0000000000d1', 0, null, '連結'], // 実際のゼロ
  ['00000000-0000-4000-8000-0000000000d2', null, '定性回答あり', '単体'],
  ['00000000-0000-4000-8000-0000000000d3', null, null, '内部取引'], // 値も文字も無い
  ['00000000-0000-4000-8000-0000000000d4', 12.5, null, '持分法'],
];
const versionIdOf = (dpId: string) => dpId.replace(/d(\d)$/, 'e$1');
const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb({ before: '0039_data_point_availability.sql' });
  await db.query(
    `insert into organizations (id, type, name, code) values ($1, 'enterprise', '検証用企業', 'BACKFILL')`,
    [ORG],
  );
  await db.query(
    `insert into organization_units (id, organization_id, code, name, unit_type)
     values ($1, $2, 'HQ', '本社', 'headquarters')`,
    [UNIT, ORG],
  );
  await db.query(
    `insert into reporting_periods (id, organization_id, code, label, start_date, end_date)
     values ($1, $2, 'FY2026', 'FY2026', '2026-04-01', '2027-03-31')`,
    [PERIOD, ORG],
  );
  await db.query(
    `insert into metric_definitions
       (id, organization_id, code, name, category, unit, base_unit, data_type, aggregation_method)
     values ($1, $2, 'scope1', 'Scope1 排出量', 'ghg', 't-CO2e', 't-CO2e', 'number', 'sum')`,
    [METRIC, ORG],
  );
  for (const [id, value, text, boundary] of EXISTING) {
    await db.query(
      `insert into data_points
         (id, organization_id, metric_id, unit_id, reporting_period_id, boundary, status,
          value, text_value, unit_of_measure, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, 't-CO2e', $9, $9)`,
      [id, ORG, METRIC, UNIT, PERIOD, boundary, value, text, OLD_UPDATED_AT],
    );
    await db.query(
      `insert into data_point_versions
         (id, data_point_id, organization_id, version_no, value, text_value, unit_of_measure,
          status, source_type, content_hash)
       values ($1, $2, $3, 1, $4, $5, 't-CO2e', 'draft', 'manual', $6)`,
      [versionIdOf(id), id, ORG, value, text, `hash-${id}`],
    );
  }

  await applyMigration(db, '0039_data_point_availability.sql');
  // 後続の migration も既存行がある状態で当たること（CHECK の付け替えが既存行で失敗しない）
  await applyMigration(db, '0040_audit_event_types_disclosure.sql');
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('0039: 既存行の値の有無の backfill', () => {
  it('value と text_value がともに NULL の行だけ not_entered、それ以外は value_present', async () => {
    for (const table of ['data_points', 'data_point_versions'] as const) {
      const rows = await db.query<{
        value: string | null;
        text_value: string | null;
        availability_status: string;
      }>(`select value::text, text_value, availability_status from ${table} order by id`);
      expect(rows.rows.map((r) => [r.value, r.text_value, r.availability_status])).toEqual([
        ['0', null, 'value_present'], // 0 は「値あり」（未入力と混同しない）
        [null, '定性回答あり', 'value_present'],
        [null, null, 'not_entered'],
        ['12.5', null, 'value_present'],
      ]);
    }
  });

  it('値が無いことから「対象外」を推測しない（not_applicable は 1 行も作らない）', async () => {
    const rows = await db.query<{ n: number }>(
      `select (select count(*) from data_points where availability_status <> 'value_present'
                 and availability_status <> 'not_entered')
            + (select count(*) from data_point_versions where availability_status <> 'value_present'
                 and availability_status <> 'not_entered') as n`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('区分は実績、理由は空。既存の値・ハッシュ・更新日時は変わらない', async () => {
    const dps = await db.query<{
      value_kind: string;
      absence_reason: string | null;
      updated_at: Date;
    }>('select value_kind, absence_reason, updated_at from data_points order by id');
    for (const row of dps.rows) {
      expect(row.value_kind).toBe('actual');
      expect(row.absence_reason).toBeNull();
      // 列の追加だけで「最近変更されたデータ」に並ばないこと
      expect(new Date(row.updated_at).toISOString()).toBe(OLD_UPDATED_AT);
    }
    const versions = await db.query<{ id: string; content_hash: string; value_kind: string }>(
      'select id, content_hash, value_kind from data_point_versions order by id',
    );
    expect(versions.rows.map((r) => r.content_hash)).toEqual(EXISTING.map(([id]) => `hash-${id}`));
    expect(versions.rows.every((r) => r.value_kind === 'actual')).toBe(true);
  });

  it('backfill の後も版の追記専用トリガは有効なまま', async () => {
    await expect(
      db.query(`update data_point_versions set availability_status = 'not_applicable'`),
    ).rejects.toThrow(/T4D_IMMUTABLE/);
  });

  it('新しい区分・状態の値は CHECK 制約で守られる', async () => {
    await expect(
      db.query(`update data_points set availability_status = 'zero' where id = $1`, [
        EXISTING[0]![0],
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(`update data_points set value_kind = 'forecast' where id = $1`, [EXISTING[0]![0]]),
    ).rejects.toThrow(/check constraint/);
  });
});
