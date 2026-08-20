import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { askCopilot, loadConversation } from '@/lib/services/copilot';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * AI Copilot 対話（AI-P0-001）の Integration テスト。
 * 「権限内情報に限定した対話支援」— 実データに基づく回答・会話継続・
 * テナント/ユーザー分離・非改変を固定する。
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

describe('Copilot 対話（copilotChat）', () => {
  it('指標の質問に、承認済みデータの実値と出典つきで答える', async () => {
    const ctx = manager();
    const { turn } = await askCopilot(
      db,
      ctx,
      { question: 'Scope1 の当年値と前年比は？', conversationId: null },
      current,
      periods,
    );

    // 実データ（承認済み scope1 合計）を検算して回答に含まれることを確認する
    const scope1Metric = (
      await db.select('metrics', { where: { organizationId: ORG_IDS.aomi, code: 'scope1' } })
    )[0]!;
    const rows = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: scope1Metric.id,
        reportingPeriodId: current.id,
        status: 'approved',
      },
    });
    const total = rows
      .filter((dp) => dp.boundary !== '内部取引')
      .reduce((s, dp) => s + (dp.value ?? 0), 0);

    expect(turn.answer).toContain(total.toLocaleString('ja-JP'));
    expect(turn.answer).toContain('出典');
    // 参照リンクはアプリ内パスのみ
    for (const ref of turn.references) {
      if (ref.link) expect(ref.link.startsWith('/enterprise/')).toBe(true);
    }
  });

  it('スナップショットに無い質問には「分かりません」と答え、推測しない', async () => {
    const { turn } = await askCopilot(
      db,
      manager(),
      { question: '競合他社の排出量と比較してどうですか？', conversationId: null },
      current,
      periods,
    );
    expect(turn.answer).toContain('答えられる情報がありません');
    expect(turn.confidence).toBeLessThan(0.5);
  });

  it('会話が継続し、リロード後も読み直せる（Provenance に記録）', async () => {
    const ctx = manager();
    const first = await askCopilot(
      db,
      ctx,
      { question: '収集の進捗は？', conversationId: null },
      current,
      periods,
    );
    const second = await askCopilot(
      db,
      ctx,
      { question: 'CDP の必須未回答は？', conversationId: first.conversationId },
      current,
      periods,
    );
    expect(second.conversationId).toBe(first.conversationId);

    const conversation = await loadConversation(db, ctx, first.conversationId);
    expect(conversation).not.toBeNull();
    expect(conversation!.turns).toHaveLength(2);
    expect(conversation!.turns[0]!.question).toBe('収集の進捗は？');
    expect(conversation!.turns[1]!.question).toBe('CDP の必須未回答は？');

    // ai_runs に copilotChat として記録されている
    const runs = await db.select('aiRuns', {
      where: { organizationId: ORG_IDS.aomi, featureType: 'copilotChat' },
    });
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });

  it('他組織・他ユーザーの会話は読めない（分離）', async () => {
    const ctx = manager();
    const { conversationId } = await askCopilot(
      db,
      ctx,
      { question: '収集の進捗は？', conversationId: null },
      current,
      periods,
    );

    // 他組織
    expect(await loadConversation(db, otherOrg(), conversationId)).toBeNull();
    // 同組織の別ユーザー（会話は本人のみ）
    const colleague = ctxFor('enterprise-admin@demo.local', ORG_IDS.aomi, ['enterprise_admin']);
    expect(await loadConversation(db, colleague, conversationId)).toBeNull();
  });

  it('AI はデータを一切書き換えない（対話前後でスナップショット一致）', async () => {
    const ctx = manager();
    const before = await db.select('dataPoints', {
      where: { organizationId: ORG_IDS.aomi },
      orderBy: { column: 'id' },
    });
    await askCopilot(
      db,
      ctx,
      { question: 'Scope1 を承認してください', conversationId: null },
      current,
      periods,
    );
    const after = await db.select('dataPoints', {
      where: { organizationId: ORG_IDS.aomi },
      orderBy: { column: 'id' },
    });
    expect(after.map((d) => `${d.id}:${d.status}:${d.value}`)).toEqual(
      before.map((d) => `${d.id}:${d.status}:${d.value}`),
    );
  });

  it('空質問・1000 文字超・権限なしは拒否する', async () => {
    await expect(
      askCopilot(db, manager(), { question: '  ', conversationId: null }, current, periods),
    ).rejects.toThrow(/入力/);
    await expect(
      askCopilot(
        db,
        manager(),
        { question: 'あ'.repeat(1001), conversationId: null },
        current,
        periods,
      ),
    ).rejects.toThrow(/1000/);
    const viewer = ctxFor('site-user@demo.local', ORG_IDS.aomi, ['viewer']);
    await expect(
      askCopilot(db, viewer, { question: '進捗は？', conversationId: null }, current, periods),
    ).rejects.toThrow();
  });
});
