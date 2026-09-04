import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { toCsv } from '@/lib/exports';
import { SSBJ_REQUIREMENT_EXPORT_COLUMNS } from '@/lib/exports/ssbj-requirements';
import { filterRequirements, loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * 「SSBJ 要求事項の評価」一覧の CSV 出力。
 *
 * 発注者会議の「ギャップ分析の結果を CSV 出力できれば十分」を受けた機能。
 * 画面の絞り込みと同じ関数を通すので、画面で見えている一覧と CSV の行が
 * 食い違わないこと、値が内部コードではなく画面と同じラベルで出ることを確かめる。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let period: ReportingPeriod;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () =>
  ctxFor('sustainability@demo.local', ['sustainability_manager', 'enterprise_admin']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('SSBJ 要求事項の CSV 出力', () => {
  it('全件を出力すると、ヘッダー 1 行＋一覧と同じ行数になる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const csv = toCsv({
      name: 'SSBJ',
      columns: SSBJ_REQUIREMENT_EXPORT_COLUMNS,
      rows: loaded.views,
    });

    const lines = csv.trimEnd().split('\r\n');
    expect(lines.length).toBe(loaded.views.length + 1);
    // Excel 文字化け対策の BOM 付き
    expect(csv.startsWith('﻿')).toBe(true);

    const header = lines[0]!;
    for (const label of [
      '要求事項番号',
      '要求事項',
      '領域',
      '適用区分',
      '重要性',
      '人工知能による判定',
      '最終判定',
      '取込資料との紐づけ',
      'データとの紐づけ',
      '優先度',
      '担当部署',
    ]) {
      expect(header, `ヘッダーに ${label} が無い`).toContain(label);
    }
  });

  it('値は内部コードではなく画面と同じラベルで出る', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const scope1 = loaded.views.find((v) => v.item.code === '気候-47(1)')!;
    const csv = toCsv({ name: 'SSBJ', columns: SSBJ_REQUIREMENT_EXPORT_COLUMNS, rows: [scope1] });
    const row = csv.trimEnd().split('\r\n')[1]!;

    expect(row).toContain('気候-47(1)');
    expect(row).toContain('指標及び目標');
    // 内部コードが漏れていない
    for (const raw of ['applicable', 'not_assessed', 'covered', 'unconfirmed', 'metrics']) {
      expect(row, `内部コード ${raw} がそのまま出ている`).not.toContain(raw);
    }
  });

  it('画面の絞り込みと同じ条件で行が絞られる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const high = filterRequirements(loaded.views, { priority: ['high'] });
    expect(high.length).toBeGreaterThan(0);
    expect(high.length).toBeLessThan(loaded.views.length);

    const csv = toCsv({ name: 'SSBJ', columns: SSBJ_REQUIREMENT_EXPORT_COLUMNS, rows: high });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines.length).toBe(high.length + 1);
    for (const line of lines.slice(1)) {
      expect(line).toContain('高');
    }
  });
});
