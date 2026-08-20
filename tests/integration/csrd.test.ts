import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { CSRD_ITEM_SPECS, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { runDisclosureConsistencyCheck } from '@/lib/services/disclosure-check';
import { generateDisclosureDraft, saveDisclosureResponse } from '@/lib/services/disclosure-write';
import type {
  AuthorizationContext,
  MetricDefinition,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * CSRD（ESRS 架空縮小マスター）の Integration テスト（機能追加要望 ②）。
 * 初年度対応＝前年回答なし・全項目 new を前提に、ワークスペース読込から
 * AI ドラフト → 保存まで CDP と同じ経路で動くことを確認する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let periods: ReportingPeriod[];
let current: ReportingPeriod;
let metrics: MetricDefinition[];

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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  current = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
  metrics = await db.select('metrics', { where: { organizationId: ORG_IDS.aomi } });
});

describe('CSRD ワークスペース', () => {
  it('ESRS 項目が全件読み込まれ、初年度（全項目 new・前年なし）である', async () => {
    const ws = await loadDisclosureWorkspace(db, manager(), 'csrd', current, periods, metrics);
    expect(ws).not.toBeNull();
    expect(ws!.rows).toHaveLength(CSRD_ITEM_SPECS.length);
    for (const row of ws!.rows) {
      expect(row.item.changeType).toBe('new');
      expect(row.previousResponse).toBeNull();
      // 全項目に FY2026 の回答レコード（not_started）が用意されている
      expect(row.response).not.toBeNull();
    }
  });

  it('指標マッピング済みの項目は承認済みデータの当年値を持つ', async () => {
    const ws = await loadDisclosureWorkspace(db, manager(), 'csrd', current, periods, metrics);
    const e16 = ws!.rows.find((r) => r.item.code === 'ESRS-E1-6');
    expect(e16).toBeDefined();
    expect(e16!.mappedMetrics.length).toBeGreaterThan(0);
    // Scope1 は Fixture で承認済みデータがあるため当年値が入る
    expect(e16!.currentValue).not.toBeNull();

    // 記述式（マッピングなし）の項目も存在する
    const gov1 = ws!.rows.find((r) => r.item.code === 'ESRS2-GOV-1');
    expect(gov1!.mappedMetrics).toHaveLength(0);
  });

  it('AI ドラフト生成 → 人の編集保存が CDP と同じ経路で動く', async () => {
    const ctx = manager();
    const ws = await loadDisclosureWorkspace(db, ctx, 'csrd', current, periods, metrics);
    const row = ws!.rows.find((r) => r.item.code === 'ESRS-E1-5')!;

    const draft = await generateDisclosureDraft(db, ctx, row.response!.id);
    expect(draft.provider).toBe('mock');
    expect(draft.version.status).toBe('draft');

    await saveDisclosureResponse(db, ctx, {
      responseId: row.response!.id,
      answerText: '当年度の総エネルギー消費量は 46,864 MWh です。（人が確認して保存）',
      answerNumeric: 46864,
      answerChoice: [],
      aiRunId: draft.aiRunId,
      editedFromAi: true,
    });

    const saved = await db.findById('disclosureResponses', row.response!.id);
    expect(saved?.status).toBe('draft');
    expect(saved?.answerText).toContain('人が確認して保存');
  });

  it('整合チェックが csrd を対象に実行でき、未記入の必須項目を指摘する', async () => {
    const { run, issues } = await runDisclosureConsistencyCheck(
      db,
      manager(),
      'csrd',
      current,
      periods,
    );
    expect(run.featureType).toBe('inconsistencyCheck');
    // CSRD は初年度で未記入が多いため、不足情報の指摘が必ず出る
    const missing = issues.filter((i) => i.kind === 'missing_information');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((i) => i.subject.startsWith('ESRS'))).toBe(true);
  });

  it('他組織（蒼天）には CSRD の回答レコードが存在しない（テナント分離）', async () => {
    const rows = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.soten },
    });
    const csrdItems = await db.select('disclosureItems', {});
    const csrdItemIds = new Set(
      csrdItems.filter((i) => i.code.startsWith('ESRS')).map((i) => i.id),
    );
    expect(rows.some((r) => csrdItemIds.has(r.itemId))).toBe(false);
  });
});
