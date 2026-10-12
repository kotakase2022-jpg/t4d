import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_TODAY } from '@/lib/config';
import { AuthorizationError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { openIssueSummary } from '@/lib/domain/trial-metrics';
import { createReportNote } from '@/lib/services/assurance-notes';
import { shareReportSnapshot } from '@/lib/services/report-share';
import { listPendingExclusions } from '@/lib/services/requirement-exclusion';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadMyWork } from '@/lib/services/my-work';
import { MY_WORK_ORDER } from '@/lib/ui/my-work';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * 役割別ホームの「自分の作業」（plan §1.3・§1.14・§4 B1）。
 * デモの 5 役割、担当範囲、他の組織の行を数えないこと、監査法人の文脈を拒むことを確かめる。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: string[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

function period(): ReportingPeriod {
  const found = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026);
  if (!found) throw new Error('FY2026 が無い');
  return found;
}

const input = () => ({ period: period(), today: FIXTURE_TODAY });

/** 種類の並びが役割の並び（MY_WORK_ORDER）に従っているか */
function expectOrdered(profile: keyof typeof MY_WORK_ORDER, kinds: string[]) {
  const order = MY_WORK_ORDER[profile] as readonly string[];
  const ranks = kinds.map((k) => (order.includes(k) ? order.indexOf(k) : order.length + 1));
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
}

describe('トライアル対応の Attention（plan §4.3-3。保存せず導出）', () => {
  const keysOf = (work: Awaited<ReturnType<typeof loadMyWork>>) =>
    new Map(work.attention.map((a) => [a.key, a]));

  it('従来ホーム（開示優先 OFF の組織）でも、同じ Attention を出す（regression.md §6.3 に記録した変更）', async () => {
    // 既定の Demo の組織は開示優先が OFF（従来ホーム）。ホームの従来の分岐も loadMyWork を使う
    expect(
      fixture.organizationFeatureSettings.find((s) => s.organizationId === ORG_IDS.aomi)
        ?.disclosureFirst,
    ).toBe(false);
    const approver = ctxFor('approver@demo.local', ['approver', 'reviewer']);
    expect(keysOf(await loadMyWork(db, approver, input())).has('exclusion-pending')).toBe(true);
    const admin = ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
    const open = openIssueSummary(
      fixture.trialFeedbackItems.filter((f) => f.organizationId === ORG_IDS.aomi),
    ).mandatoryCriticalOpen;
    expect(keysOf(await loadMyWork(db, admin, input())).has('trial-mandatory-critical')).toBe(
      open > 0,
    );
  });

  it('最終承認者: 自分が承認できる対象外の申請（自分の申請は除く）を、承認する画面への行き先付きで出す', async () => {
    const approver = ctxFor('approver@demo.local', ['approver', 'reviewer']);
    const pending = (await listPendingExclusions(db, approver)).filter(
      (p) => p.requestedBy !== approver.userId,
    );
    expect(pending.length).toBeGreaterThan(0);
    const item = keysOf(await loadMyWork(db, approver, input())).get('exclusion-pending');
    expect(item).toMatchObject({ count: pending.length, href: pending[0]!.href });
    // 承認の権限が無い役割（作成担当）には出さない
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    expect(keysOf(await loadMyWork(db, author, input())).has('exclusion-pending')).toBe(false);
  });

  it('作成担当: 未回答の保証側のコメント（クライアントへ共有されたもの）を回答の画面へ出す', async () => {
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    expect(keysOf(await loadMyWork(db, author, input())).has('assurance-comments-unanswered')).toBe(
      false,
    );
    const copy = await shareReportSnapshot(
      db,
      ctxFor('enterprise-admin@demo.local', ['enterprise_admin']),
      { snapshotId: FY2025_APPROVED_SNAPSHOT_ID, engagementId: ENGAGEMENT_IDS.main },
    );
    const content = parseSharedReportCopy(copy.copy)!;
    const block = content.blocks.find((b) =>
      b.body.paragraphs.some((p) => p.kind === 'paragraph'),
    )!;
    const paragraph = block.body.paragraphs.find((p) => p.kind === 'paragraph')!;
    await createReportNote(
      db,
      {
        ...ctxFor('assurance-manager@demo.local', ['assurance_manager']),
        workspace: {
          organizationId: ORG_IDS.aoba,
          organizationType: 'assurance_firm',
          organizationName: 'テスト',
          roleKeys: ['assurance_manager'],
          unitScopeIds: [],
        },
        engagementIds: [ENGAGEMENT_IDS.main],
      },
      {
        engagementId: ENGAGEMENT_IDS.main,
        copyId: copy.id,
        target: { kind: 'report_paragraph', blockId: block.blockId, paragraphId: paragraph.id },
        body: '（テスト）根拠の版を確認させてください。',
        sharedWithClient: true,
      },
    );
    const item = keysOf(await loadMyWork(db, author, input())).get('assurance-comments-unanswered');
    expect(item).toMatchObject({
      count: 1,
      href: '/enterprise/assurance-comments?state=unanswered',
    });
  });

  it('管理者: トライアルの「必須要件 × 重大 × 未解決」を改善管理表へ。0 件なら出さない', async () => {
    const admin = ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
    const before = keysOf(await loadMyWork(db, admin, input())).get('trial-mandatory-critical');
    // 改善管理表の見出しと同じ規則（trial-metrics.ts の openIssueSummary）で数える
    const open = openIssueSummary(
      fixture.trialFeedbackItems.filter((f) => f.organizationId === ORG_IDS.aomi),
    ).mandatoryCriticalOpen;
    if (open === 0) expect(before).toBeUndefined();
    else expect(before).toMatchObject({ count: open, href: '/enterprise/trial?tab=feedback' });
    // 作成担当（トライアルの管理をしない）には出さない
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    expect(keysOf(await loadMyWork(db, author, input())).has('trial-mandatory-critical')).toBe(
      false,
    );
  });
});

describe('loadMyWork', () => {
  it('拠点担当: 担当拠点のデータだけを数え、直す → 入力する の順', async () => {
    const site = ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
    // 担当外の拠点の差戻しを 1 件作る（数えてはいけない）
    const west = fixture.dataPoints.find(
      (dp) => dp.unitId === UNIT_IDS.west && dp.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    west.status = 'returned';
    const work = await loadMyWork(db, site, input());
    expect(work.profile).toBe('contributor');
    const expectedEnter = fixture.dataPoints.filter(
      (dp) =>
        dp.unitId === UNIT_IDS.east &&
        dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
        dp.deletedAt === null &&
        (dp.status === 'not_started' || dp.status === 'draft'),
    ).length;
    const enter = work.items.find((i) => i.kind === 'data-enter');
    if (expectedEnter > 0) {
      expect(enter?.target).toBe(`未着手・入力中のデータ ${expectedEnter} 件`);
      expect(enter?.cta.href).toBe(
        `/enterprise/data?status=not_started&status=draft&unit=${UNIT_IDS.east}`,
      );
    }
    // 差戻しの件数は担当拠点の分だけ（担当外の西日本工場の差戻しは数えない）
    const eastReturned = fixture.dataPoints.filter(
      (dp) =>
        dp.unitId === UNIT_IDS.east &&
        dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
        dp.deletedAt === null &&
        dp.status === 'returned',
    ).length;
    expect(work.attention.find((a) => a.key === 'data-returned')?.count ?? 0).toBe(eastReturned);
    // 開示の閲覧権限が無いので原稿の作業は出ない
    expect(work.items.some((i) => i.kind.startsWith('manuscript'))).toBe(false);
    expectOrdered(
      'contributor',
      work.items.map((i) => i.kind),
    );
  });

  it('拠点担当: 担当拠点の差戻しは Attention と先頭の作業に出る', async () => {
    const site = ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
    const east = fixture.dataPoints.find(
      (dp) => dp.unitId === UNIT_IDS.east && dp.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    east.status = 'returned';
    const work = await loadMyWork(db, site, input());
    expect(work.attention.find((a) => a.key === 'data-returned')?.count).toBeGreaterThanOrEqual(1);
    expect(work.items[0]?.kind).toBe('data-returned');
    expect(work.items[0]?.cta.href).toContain(`unit=${UNIT_IDS.east}`);
  });

  it('作成担当: 原稿の作業は開示ホームの CTA（文言・リンク先）をそのまま使う', async () => {
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    const work = await loadMyWork(db, author, input());
    expect(work.profile).toBe('preparer');
    const manuscripts = work.items.filter((i) => i.kind.startsWith('manuscript'));
    for (const item of manuscripts) {
      expect(item.cta.href).toMatch(/^\/enterprise\/disclosure-projects\//);
      expect(item.cta.label).not.toBe('');
    }
    expectOrdered(
      'preparer',
      work.items.map((i) => i.kind),
    );
  });

  it('レビュー担当・最終承認者・管理者・閲覧者の並び', async () => {
    const reviewer = await loadMyWork(db, ctxFor('reviewer@demo.local', ['reviewer']), input());
    expect(reviewer.profile).toBe('reviewer');
    expectOrdered(
      'reviewer',
      reviewer.items.map((i) => i.kind),
    );

    const approver = await loadMyWork(
      db,
      ctxFor('approver@demo.local', ['approver', 'reviewer']),
      input(),
    );
    expect(approver.profile).toBe('approver');
    expectOrdered(
      'approver',
      approver.items.map((i) => i.kind),
    );

    const admin = await loadMyWork(
      db,
      ctxFor('enterprise-admin@demo.local', ['enterprise_admin']),
      input(),
    );
    expect(admin.profile).toBe('admin');
    expectOrdered(
      'admin',
      admin.items.map((i) => i.kind),
    );

    // 閲覧者は自分が行う作業を持たない
    const viewer = await loadMyWork(db, ctxFor('reviewer@demo.local', ['viewer']), input());
    expect(viewer.profile).toBe('viewer');
    expect(viewer.items).toEqual([]);
  });

  it('レビュー中のデータの承認は承認の権限があるときだけ（承認は開いた画面で人が押す）', async () => {
    const dp = fixture.dataPoints.find((d) => d.reportingPeriodId === PERIOD_IDS.fy2026)!;
    dp.status = 'in_review';
    const approver = await loadMyWork(
      db,
      ctxFor('approver@demo.local', ['approver', 'reviewer']),
      input(),
    );
    const item = approver.items.find((i) => i.kind === 'data-approve');
    expect(item?.cta.href).toBe('/enterprise/data?status=in_review');
    const reviewer = await loadMyWork(db, ctxFor('reviewer@demo.local', ['reviewer']), input());
    expect(reviewer.items.some((i) => i.kind === 'data-approve')).toBe(false);
  });

  it('他の組織の行は数えない', async () => {
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    const before = await loadMyWork(db, author, input());
    // 別テナントのデータを差戻しにしても、自分の組織の件数は変わらない
    for (const dp of fixture.dataPoints.filter((d) => d.organizationId === ORG_IDS.soten)) {
      dp.status = 'returned';
    }
    const after = await loadMyWork(db, author, input());
    expect(after.attention).toEqual(before.attention);
    expect(after.items.map((i) => i.target)).toEqual(before.items.map((i) => i.target));
  });

  it('監査法人の文脈では使えない', async () => {
    const assurance: AuthorizationContext = {
      ...ctxFor('assurance-manager@demo.local', ['assurance_manager']),
      workspace: {
        organizationId: ORG_IDS.aoba,
        organizationType: 'assurance_firm',
        organizationName: 'あおば保証監査法人',
        roleKeys: ['assurance_manager'],
        unitScopeIds: [],
      },
    };
    await expect(loadMyWork(db, assurance, input())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('読み取りだけ（作業の一覧を作っても行を書き換えない）', async () => {
    const before = JSON.stringify(fixture);
    await loadMyWork(db, ctxFor('enterprise-admin@demo.local', ['enterprise_admin']), input());
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
