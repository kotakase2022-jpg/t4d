import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { applySecuritiesReportScope } from '@/lib/services/securities-report';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 有価証券報告書からの報告対象の自動選択。
 *
 * 「関係会社の状況」「設備の状況」に載っている拠点へ自動チェックを入れる。
 * 確かめたいこと:
 *  - 本文に載っている連結対象の拠点だけがチェックされる
 *  - 持分法適用会社は**見つけても自動チェックしない**（含めるかどうかは人が決める）
 *  - 内容が変わるので、設定の確定は外れる
 */

let db: DemoDbClient;
let fixture: FixtureDb;

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
const viewerCtx = () => ctxFor('site-user@demo.local', ['site_contributor']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('有価証券報告書からの報告対象の自動選択', () => {
  it('本文に載っている連結対象の拠点をチェックし、設定へ保存する', async () => {
    const result = await applySecuritiesReportScope(db, manager(), PERIOD_IDS.fy2026);

    expect(result.fileName).toContain('有価証券報告書');
    // 「設備の状況」の自社拠点と「関係会社の状況」の連結子会社
    expect(result.checked).toEqual(
      expect.arrayContaining(['本社', '東日本工場', '西日本工場', '欧州販売子会社']),
    );
    // 持分法適用会社は本文に載っていても自動チェックしない
    expect(result.equityMentioned).toContain('青海マテリアル合弁会社');
    expect(result.checked).not.toContain('青海マテリアル合弁会社');
    // サプライヤーは判定の対象外（notFound にも入れない）
    expect(result.notFound).not.toContain('常盤精密工業');

    const settings = fixture.ssbjAnalysisSettings.find(
      (s) => s.organizationId === ORG_IDS.aomi && s.reportingPeriodId === PERIOD_IDS.fy2026,
    );
    expect(settings?.includedUnitIds).toEqual(
      expect.arrayContaining([UNIT_IDS.hq, UNIT_IDS.east, UNIT_IDS.west, UNIT_IDS.eu]),
    );
    expect(settings?.includedUnitIds).not.toContain(UNIT_IDS.jv);
  });

  it('既存の設定がある場合は範囲だけ差し替え、確定を外す', async () => {
    const ctx = manager();
    const now = new Date().toISOString();
    fixture.ssbjAnalysisSettings.push({
      id: 'settings-existing',
      organizationId: ORG_IDS.aomi,
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: true,
      applyClimate: true,
      applyPractical: true,
      firstTimeAdoption: true,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [UNIT_IDS.jv],
      valueChainScope: 'upstream',
      valueChainNote: '',
      confirmedAt: now,
      confirmedBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });

    await applySecuritiesReportScope(db, ctx, PERIOD_IDS.fy2026);

    const after = fixture.ssbjAnalysisSettings.find((s) => s.id === 'settings-existing')!;
    expect(after.includedUnitIds).toContain(UNIT_IDS.hq);
    expect(after.includedUnitIds).not.toContain(UNIT_IDS.jv);
    // 範囲が変わったので確定はやり直し
    expect(after.confirmedAt).toBeNull();
    expect(after.confirmedBy).toBeNull();
    // 範囲以外の設定（適用基準など）は書き換えない
    expect(after.applyPractical).toBe(true);
    expect(after.firstTimeAdoption).toBe(true);
  });

  it('どの拠点を選んだかが監査ログに残る', async () => {
    await applySecuritiesReportScope(db, manager(), PERIOD_IDS.fy2026);
    const event = fixture.auditEvents.find(
      (e) =>
        e.resourceType === 'ssbj_analysis_settings' &&
        (e.afterSummary ?? '').includes('有価証券報告書'),
    );
    expect(event?.afterSummary).toContain('東日本工場');
    expect(event?.afterSummary).toContain('持分法のため対象外: 青海マテリアル合弁会社');
  });

  it('有価証券報告書が取り込まれていなければ、取り込み方を案内して拒否する', async () => {
    for (const file of fixture.files) {
      if (file.originalName.includes('有価証券報告書') || file.documentType === '有価証券報告書') {
        file.deletedAt = new Date().toISOString();
      }
    }
    await expect(applySecuritiesReportScope(db, manager(), PERIOD_IDS.fy2026)).rejects.toThrow(
      '有価証券報告書が見つかりません',
    );
  });

  it('閲覧者は実行できない', async () => {
    await expect(applySecuritiesReportScope(db, viewerCtx(), PERIOD_IDS.fy2026)).rejects.toThrow();
  });
});
