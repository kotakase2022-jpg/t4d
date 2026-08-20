import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { loadInsightResult, runInsightDiscovery } from '@/lib/services/insights';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * AI Copilot インサイト（機能追加要望 ④）の Integration テスト。
 * Demo Mode なので Provider は決定論的 Mock。
 * 「洞察の提示のみを行い、データを一切書き換えない」ことを固定する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let periods: ReportingPeriod[];
let current: ReportingPeriod;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  current = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('インサイト発見（insightDiscovery）', () => {
  it('組織データを横断して洞察を生成し、AI Run として記録される', async () => {
    const { run, insights } = await runInsightDiscovery(db, manager(), current, periods);

    expect(run.featureType).toBe('insightDiscovery');
    expect(run.status).toBe('succeeded');
    expect(run.provider).toBe('mock');
    // Fixture には未承認データ・未回答の必須項目・PBC があるため必ず洞察が出る
    expect(insights.length).toBeGreaterThan(0);

    for (const insight of insights) {
      // 洞察は「根拠・含意・推奨アクション」の 3 点セットを必ず持つ
      expect(insight.title).not.toBe('');
      expect(insight.finding).not.toBe('');
      expect(insight.implication).not.toBe('');
      expect(insight.recommendedAction).not.toBe('');
      expect(['high', 'medium', 'low']).toContain(insight.impact);
      // リンクがある場合はアプリ内の相対パス（外部 URL を出さない）
      if (insight.link) expect(insight.link.startsWith('/enterprise/')).toBe(true);
    }
  });

  it('単一画面では見えない種類の洞察（横断カテゴリ）が複数含まれる', async () => {
    const { insights } = await runInsightDiscovery(db, manager(), current, periods);
    const categories = new Set(insights.map((i) => i.category));
    // 収集・開示・品質など、異なる画面の情報を突き合わせた洞察が 2 カテゴリ以上
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it('AI はデータを一切書き換えない（提示のみ）', async () => {
    const ctx = manager();
    const before = {
      dataPoints: await db.select('dataPoints', {
        where: { organizationId: ORG_IDS.aomi },
        orderBy: { column: 'id' },
      }),
      responses: await db.select('disclosureResponses', {
        where: { organizationId: ORG_IDS.aomi },
        orderBy: { column: 'id' },
      }),
    };

    await runInsightDiscovery(db, ctx, current, periods);

    const after = {
      dataPoints: await db.select('dataPoints', {
        where: { organizationId: ORG_IDS.aomi },
        orderBy: { column: 'id' },
      }),
      responses: await db.select('disclosureResponses', {
        where: { organizationId: ORG_IDS.aomi },
        orderBy: { column: 'id' },
      }),
    };

    expect(after.dataPoints.map((d) => `${d.id}:${d.status}:${d.value}`)).toEqual(
      before.dataPoints.map((d) => `${d.id}:${d.status}:${d.value}`),
    );
    expect(after.responses.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`)).toEqual(
      before.responses.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`),
    );
  });

  it('同じデータ状態からは同じ洞察が出る（Mock の決定論性）', async () => {
    const first = await runInsightDiscovery(db, manager(), current, periods);
    const second = await runInsightDiscovery(db, manager(), current, periods);
    expect(second.insights.map((i) => i.title)).toEqual(first.insights.map((i) => i.title));
  });

  it('結果を runId で読み直せる', async () => {
    const { run, insights } = await runInsightDiscovery(db, manager(), current, periods);
    const reloaded = await loadInsightResult(db, manager(), run.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.insights).toHaveLength(insights.length);
  });

  it('他組織の実行結果は読めない（テナント分離）', async () => {
    const { run } = await runInsightDiscovery(db, manager(), current, periods);
    expect(await loadInsightResult(db, otherOrg(), run.id)).toBeNull();
  });

  it('AI 実行権限が無いロールは実行できない', async () => {
    const viewer = ctxFor('site-user@demo.local', ORG_IDS.aomi, ['viewer']);
    await expect(runInsightDiscovery(db, viewer, current, periods)).rejects.toThrow();
  });
});

describe('レビュー指摘の再発防止（AI 採否・リンク）', () => {
  it('他組織の AI Run の採否（Reject 等）は記録できない', async () => {
    const { recordAiDecision } = await import('@/lib/ai');
    const { run } = await runInsightDiscovery(db, manager(), current, periods);

    await expect(recordAiDecision(db, otherOrg(), run.id, 'rejected', null)).rejects.toThrow(
      /見つかりません/,
    );

    // 自組織なら記録できる（false negative でないこと）
    await recordAiDecision(db, manager(), run.id, 'rejected', null);
    const updated = await db.findById('aiRuns', run.id);
    expect(updated?.status).toBe('rejected');
  });

  it('AI 出力の link はアプリ内パス以外を描画させない（外部誘導の防止）', async () => {
    const ctx = manager();
    const { run } = await runInsightDiscovery(db, ctx, current, periods);

    // 実 Provider が外部 URL を返した状況を、保存済み出力の改変で再現する
    const tampered = (run.outputJson.insights as Array<Record<string, unknown>>).map((i, n) => ({
      ...i,
      link: n === 0 ? 'https://evil.example.com/phish' : n === 1 ? "javascript:alert('x')" : i.link,
    }));
    await db.update('aiRuns', run.id, { outputJson: { ...run.outputJson, insights: tampered } });

    const reloaded = await loadInsightResult(db, ctx, run.id);
    expect(reloaded).not.toBeNull();
    for (const insight of reloaded!.insights) {
      if (insight.link !== null) {
        expect(insight.link.startsWith('/enterprise/')).toBe(true);
      }
    }
    expect(reloaded!.insights[0]?.link).toBeNull();
    expect(reloaded!.insights[1]?.link).toBeNull();
  });
});
