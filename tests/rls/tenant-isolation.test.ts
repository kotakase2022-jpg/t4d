import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsHarness, type RlsHarness } from './harness';
import {
  ENGAGEMENT_IDS,
  ORG_IDS,
  PERIOD_IDS,
  UNIT_IDS,
  dataPointId,
  metricId,
  userId,
} from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';

/**
 * RLS 越権テスト（指示書 11 章「RLS Test に必ず含める」10 項目）。
 *
 * supabase/migrations/*.sql を実 Postgres（PGlite）へ適用し、
 * 実際に `set local role authenticated` + JWT クレームを切り替えて検証する。
 * アプリ層の認可をすり抜けても DB 層で止まることを保証する。
 */

let h: RlsHarness;

// 企業 A（青海テクノロジー）
const ENT_A_ADMIN = userId('enterprise-admin@demo.local');
const ENT_A_SITE = userId('site-user@demo.local'); // 東日本工場のみ担当
const ENT_A_REVIEWER = userId('reviewer@demo.local');
const ENT_A_APPROVER = userId('approver@demo.local');
// 企業 B（蒼天マテリアル）
const ENT_B_ADMIN = userId('other-enterprise-admin@demo.local');
// 監査法人 A（あおば）
const FIRM_A_MANAGER = userId('assurance-manager@demo.local');
const FIRM_A_PARTNER = userId('assurance-partner@demo.local');
const FIRM_A_STAFF = userId('assurance-staff@demo.local');
const FIRM_A_ADMIN_UNASSIGNED = userId('assurance-admin@demo.local');
// 監査法人 B（くろべ）
const FIRM_B_MANAGER = userId('other-assurance-manager@demo.local');

// 許諾されている Data Point（本社 Scope1・承認済み）
const GRANTED_DP = dataPointId('HQ', 'scope1', 'FY2026');
// 許諾範囲外の Data Point（欧州販売子会社 = Unit 未許諾）
const UNGRANTED_UNIT_DP = dataPointId('EU', 'scope1', 'FY2026');
// 許諾範囲外の指標（管理職数 = Metric 未許諾。承認済みなので「未承認だから見えない」と混同しない）
const UNGRANTED_METRIC_DP = dataPointId('HQ', 'managers_total', 'FY2026');
// 東日本工場（site-user の担当・未承認）と西日本工場（担当外）
const EAST_EDITABLE_DP = dataPointId('EAST', 'water', 'FY2026'); // returned
const WEST_DP = dataPointId('WEST', 'water', 'FY2026'); // in_review

beforeAll(async () => {
  h = await createRlsHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('セットアップ', () => {
  it('全 migration が適用され Fixture が投入されている', async () => {
    const orgs = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from organizations',
    );
    expect(Number(orgs[0]?.count)).toBe(5);

    const dps = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from data_points',
    );
    expect(Number(dps[0]?.count)).toBeGreaterThan(50);
  });

  it('業務テーブルに RLS 無効のものが存在しない', async () => {
    const rows = await h.asSuperuser<{ tablename: string }>(`
      select c.relname as tablename
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relrowsecurity = false
    `);
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
});

describe('1. Enterprise A から Enterprise B を見られない', () => {
  it('企業 A の管理者は企業 B の組織を取得できない', async () => {
    const rows = await h.asUser(ENT_A_ADMIN, 'select id from organizations where id = $1', [
      ORG_IDS.soten,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('企業 A の管理者は企業 B の Data Point を 1 件も取得できない', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from data_points where organization_id = $1',
      [ORG_IDS.soten],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の指標定義を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from metric_definitions where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 A の管理者が自社データを取得できることは確認済み（false negative でないこと）', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from data_points where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(50);
  });
});

describe('2. Assurance Firm A から Assurance Firm B を見られない', () => {
  it('あおばのマネージャーはくろべの案件を取得できない', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from engagements where id = $1', [
      ENGAGEMENT_IDS.other,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('くろべのマネージャーはあおばの案件を取得できない', async () => {
    const rows = await h.asUser(FIRM_B_MANAGER, 'select id from engagements where id = $1', [
      ENGAGEMENT_IDS.main,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('くろべのマネージャーはあおばの調書を取得できない', async () => {
    const rows = await h.asUser(
      FIRM_B_MANAGER,
      'select id from assurance_tests where engagement_id = $1',
      [ENGAGEMENT_IDS.main],
    );
    expect(rows).toHaveLength(0);
  });

  // 案件メンバー行は「どの法人の案件か」を自分で名乗る列を持つ。
  // ポリシーがその列だけを見ていると、他法人の案件を指しながら自分の法人を名乗って
  // メンバー登録でき、以後 is_engagement_member() が真になって全部見えてしまう。
  it('くろべのマネージャーはあおばの案件へ自分を登録できない（自分の法人を名乗っても）', async () => {
    const denied = await h.expectDenied(
      FIRM_B_MANAGER,
      `insert into engagement_members (id, engagement_id, assurance_firm_id, user_id, role_key)
       values (gen_random_uuid(), $1, $2, $3, 'assurance_manager')`,
      [ENGAGEMENT_IDS.main, ORG_IDS.kurobe, FIRM_B_MANAGER],
    );
    expect(denied, '他法人の案件へ自己アサインできてしまう').not.toBeNull();

    const seen = await h.asUser(FIRM_B_MANAGER, 'select id from engagements where id = $1', [
      ENGAGEMENT_IDS.main,
    ]);
    expect(seen, '登録が通ると案件そのものが見えるようになる').toHaveLength(0);
  });

  it('くろべのマネージャーはあおばの案件へ他法人名義でもメンバーを追加できない', async () => {
    const denied = await h.expectDenied(
      FIRM_B_MANAGER,
      `insert into engagement_members (id, engagement_id, assurance_firm_id, user_id, role_key)
       values (gen_random_uuid(), $1, $2, $3, 'assurance_manager')`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aoba, FIRM_B_MANAGER],
    );
    expect(denied).not.toBeNull();
  });
});

describe('3. 未アサインの監査法人ユーザーが案件を見られない', () => {
  it('あおばの法人管理者（未アサイン）は案件そのものを取得できない', async () => {
    const rows = await h.asUser(
      FIRM_A_ADMIN_UNASSIGNED,
      'select id from engagements where id = $1',
      [ENGAGEMENT_IDS.main],
    );
    expect(rows).toHaveLength(0);
  });

  it('あおばの法人管理者（未アサイン）はクライアントの Data Point を取得できない', async () => {
    const rows = await h.asUser(
      FIRM_A_ADMIN_UNASSIGNED,
      'select id from data_points where id = $1',
      [GRANTED_DP],
    );
    expect(rows).toHaveLength(0);
  });

  it('あおばの法人管理者（未アサイン）は Snapshot を取得できない', async () => {
    const rows = await h.asUser(
      FIRM_A_ADMIN_UNASSIGNED,
      'select id from assurance_snapshots where engagement_id = $1',
      [ENGAGEMENT_IDS.main],
    );
    expect(rows).toHaveLength(0);
  });

  it('アサイン済みマネージャーは同じ案件を取得できる（false negative でないこと）', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from engagements where id = $1', [
      ENGAGEMENT_IDS.main,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('4. アサイン済みでも Grant 外の指標・組織・Evidence は見られない', () => {
  it('許諾済みの Data Point は取得できる', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id, value from data_points where id = $1', [
      GRANTED_DP,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('組織（欧州販売子会社）が許諾外の Data Point は取得できない', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      UNGRANTED_UNIT_DP,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('指標（管理職数）が許諾外の Data Point は、承認済みでも取得できない', async () => {
    // 組織（本社）と期間（FY2026）は許諾済み、値も approved。指標だけが許諾外。
    const approved = await h.asSuperuser<{ status: string }>(
      'select status from data_points where id = $1',
      [UNGRANTED_METRIC_DP],
    );
    expect(approved[0]?.status).toBe('approved');

    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      UNGRANTED_METRIC_DP,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('許諾外の指標定義そのものも取得できない', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from metric_definitions where id = $1', [
      metricId('AOMI', 'managers_total'),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('許諾外の組織単位も取得できない', async () => {
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from organization_units where id = $1', [
      UNIT_IDS.eu,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('未承認（レビュー中）の Data Point は許諾内でも取得できない', async () => {
    // 東日本工場の廃棄物は in_review。指標・組織・期間は許諾済みだが承認前。
    const rows = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      dataPointId('EAST', 'waste', 'FY2026'),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('許諾を取り消すと即座に不可視になる', async () => {
    const before = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      GRANTED_DP,
    ]);
    expect(before).toHaveLength(1);

    await h.asSuperuser(
      `update client_access_grants set revoked_at = now()
       where engagement_id = $1 and subject_type = 'metric' and subject_id = $2`,
      [ENGAGEMENT_IDS.main, metricId('AOMI', 'scope1')],
    );

    const after = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      GRANTED_DP,
    ]);
    expect(after).toHaveLength(0);

    // 後続テストのため復元
    await h.asSuperuser(
      `update client_access_grants set revoked_at = null
       where engagement_id = $1 and subject_type = 'metric' and subject_id = $2`,
      [ENGAGEMENT_IDS.main, metricId('AOMI', 'scope1')],
    );
  });
});

describe('5. 監査法人ユーザーは Client Source Data を更新できない', () => {
  it('許諾された Data Point でも UPDATE は 0 行（ポリシー不在）', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      'update data_points set value = 99999 where id = $1 returning id',
      [GRANTED_DP],
    );
    expect(rows).toHaveLength(0);

    const check = await h.asSuperuser<{ value: string }>(
      'select value::text as value from data_points where id = $1',
      [GRANTED_DP],
    );
    expect(Number(check[0]?.value)).not.toBe(99999);
  });

  it('Evidence Link も更新できない', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      `update evidence_links set note = 'tampered' where target_id = $1 returning id`,
      [GRANTED_DP],
    );
    expect(rows).toHaveLength(0);
  });

  it('Data Point Version を追加することもできない', async () => {
    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      `insert into data_point_versions
         (data_point_id, organization_id, version_no, value, unit_of_measure, status, source_type, content_hash)
       values ($1, $2, 99, 1, 't-CO2e', 'approved', 'manual', 'x')`,
      [GRANTED_DP, ORG_IDS.aomi],
    );
    expect(denied).toMatch(/row-level security|policy/i);
  });
});

describe('6. Site Contributor は担当外拠点の Data Point を更新できない', () => {
  it('担当拠点（東日本工場・差戻し中）は更新できる', async () => {
    const rows = await h.asUser(
      ENT_A_SITE,
      `update data_points set methodology = '実測値の集計（更新）' where id = $1 returning id`,
      [EAST_EDITABLE_DP],
    );
    expect(rows).toHaveLength(1);
  });

  it('担当外拠点（西日本工場）は更新できない', async () => {
    const rows = await h.asUser(
      ENT_A_SITE,
      `update data_points set methodology = 'tampered' where id = $1 returning id`,
      [WEST_DP],
    );
    expect(rows).toHaveLength(0);
  });

  it('担当外拠点でも SELECT は可能（自社データのため）', async () => {
    const rows = await h.asUser(ENT_A_SITE, 'select id from data_points where id = $1', [WEST_DP]);
    expect(rows).toHaveLength(1);
  });

  it('担当拠点でも承認済みデータの値は書き換えられない', async () => {
    const denied = await h.expectDenied(
      ENT_A_SITE,
      `update data_points set value = 1 where id = $1`,
      [dataPointId('EAST', 'scope1', 'FY2026')],
    );
    expect(denied).toMatch(/T4D_APPROVED_EDIT_FORBIDDEN|row-level security/i);
  });
});

describe('5b. 承認は Approver だけが実行できる', () => {
  const TARGET = dataPointId('WEST', 'waste', 'FY2026'); // submitted 状態

  it('Reviewer は approved へ遷移できない', async () => {
    const denied = await h.expectDenied(
      ENT_A_REVIEWER,
      `update data_points set status = 'approved', approved_by = $2, approved_at = now() where id = $1`,
      [TARGET, ENT_A_REVIEWER],
    );
    expect(denied).toMatch(/row-level security|policy|T4D_TRANSITION_FORBIDDEN/i);
  });

  it('Site Contributor はレビュー中への遷移もできない', async () => {
    const denied = await h.expectDenied(
      ENT_A_SITE,
      `update data_points set status = 'in_review' where id = $1`,
      [EAST_EDITABLE_DP],
    );
    expect(denied).toMatch(/T4D_TRANSITION_FORBIDDEN/);
  });

  it('Approver は approved へ遷移できる', async () => {
    const rows = await h.asUser(
      ENT_A_APPROVER,
      `update data_points set status = 'approved', approved_by = $2, approved_at = now()
       where id = $1 returning id`,
      [TARGET, ENT_A_APPROVER],
    );
    expect(rows).toHaveLength(1);
    // 後続テストへの影響を避けて戻す
    await h.asSuperuser(
      `update data_points set status = 'submitted', approved_by = null, approved_at = null where id = $1`,
      [TARGET],
    );
  });
});

describe('7. Snapshot は更新・削除できない', () => {
  // UPDATE ポリシーが存在しないため、RLS は「対象行なし」として 0 行に落とす。
  // エラーではなく「1 行も変更されない」ことが正しい遮断結果。
  it('Snapshot の UPDATE は 1 行も変更しない', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      `update assurance_snapshots set label = 'tampered' where engagement_id = $1 returning id`,
      [ENGAGEMENT_IDS.main],
    );
    expect(rows).toHaveLength(0);

    const check = await h.asSuperuser<{ label: string }>(
      'select label from assurance_snapshots where engagement_id = $1',
      [ENGAGEMENT_IDS.main],
    );
    expect(check[0]?.label).not.toBe('tampered');
  });

  it('Snapshot Item の UPDATE は 1 行も変更しない', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      `update assurance_snapshot_items set hash = 'tampered' where engagement_id = $1 returning id`,
      [ENGAGEMENT_IDS.main],
    );
    expect(rows).toHaveLength(0);
  });

  it('Snapshot Item の DELETE は権限自体が無い', async () => {
    const before = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from assurance_snapshot_items',
    );
    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      'delete from assurance_snapshot_items where engagement_id = $1',
      [ENGAGEMENT_IDS.main],
    );
    expect(denied).toMatch(/permission denied/i);
    const after = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from assurance_snapshot_items',
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('Service Role 相当（RLS バイパス）でもトリガで UPDATE が止まる', async () => {
    await expect(
      h.asSuperuser(`update assurance_snapshots set label = 'tampered' where engagement_id = $1`, [
        ENGAGEMENT_IDS.main,
      ]),
    ).rejects.toThrow(/T4D_IMMUTABLE/);
  });

  it('Service Role 相当でも DELETE が止まる', async () => {
    await expect(
      h.asSuperuser(`delete from assurance_snapshot_items where engagement_id = $1`, [
        ENGAGEMENT_IDS.main,
      ]),
    ).rejects.toThrow(/T4D_IMMUTABLE/);
  });
});

describe('8. Audit Event は更新・削除できない', () => {
  it('通常ユーザーの UPDATE は 1 行も変更しない', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      `update audit_events set event_type = 'logout' where actor_organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('通常ユーザーの DELETE は権限自体が無い（GRANT レベルで遮断）', async () => {
    const before = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from audit_events',
    );
    const denied = await h.expectDenied(
      ENT_A_ADMIN,
      'delete from audit_events where actor_organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(denied).toMatch(/permission denied/i);
    const after = await h.asSuperuser<{ count: string }>(
      'select count(*)::text as count from audit_events',
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('Service Role 相当でもトリガで止まる', async () => {
    await expect(
      h.asSuperuser(`delete from audit_events where actor_organization_id = $1`, [ORG_IDS.aomi]),
    ).rejects.toThrow(/T4D_IMMUTABLE/);
  });

  it('追記（INSERT）は可能', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      `insert into audit_events (actor_user_id, actor_organization_id, event_type)
       values ($1, $2, 'record_viewed') returning id`,
      [ENT_A_ADMIN, ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('9. Evidence（Signed URL の前提となる file_versions）は権限外では取得できない', () => {
  it('許諾済み Evidence の file_version は監査法人から取得できる', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      `select fv.id from file_versions fv
       join evidence_links el on el.file_version_id = fv.id
       where el.target_id = $1`,
      [GRANTED_DP],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('未アサインの法人管理者は同じ file_version を取得できない', async () => {
    const rows = await h.asUser(
      FIRM_A_ADMIN_UNASSIGNED,
      `select id from file_versions where organization_id = $1`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('別法人（くろべ）も取得できない', async () => {
    const rows = await h.asUser(
      FIRM_B_MANAGER,
      `select id from file_versions where organization_id = $1`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B も企業 A の file_version を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      `select id from file_versions where organization_id = $1`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('10. URL 直打ち相当（ID 指定の単発取得）でも遮断される', () => {
  const cases: Array<[string, string, string, string]> = [
    ['企業 B → 企業 A の Data Point', ENT_B_ADMIN, 'data_points', GRANTED_DP],
    ['未アサイン法人管理者 → 案件', FIRM_A_ADMIN_UNASSIGNED, 'engagements', ENGAGEMENT_IDS.main],
    ['別法人 → 母集団', FIRM_B_MANAGER, 'populations', ''],
  ];

  it.each(cases)('%s は 0 行になる', async (_label, actor, table, id) => {
    const sql = id
      ? `select id from ${table} where id = $1`
      : `select id from ${table} where engagement_id = '${ENGAGEMENT_IDS.main}'`;
    const rows = await h.asUser(actor, sql, id ? [id] : []);
    expect(rows).toHaveLength(0);
  });

  it('企業ユーザーは監査法人の内部 Review Note を取得できない', async () => {
    const rows = await h.asUser<{ shared_with_client: boolean }>(
      ENT_A_ADMIN,
      'select shared_with_client from review_notes where engagement_id = $1',
      [ENGAGEMENT_IDS.main],
    );
    // 共有フラグが立っている 1 件のみ見える
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shared_with_client).toBe(true);
  });

  it('AI 実行権限の無いロールは AI 出力の採否を確定できない', async () => {
    // 採否は「誰がいつ AI 下書きを採用しなかったか」という監査証跡になる。
    const runId = await seedAiRun();

    // RLS の UPDATE は条件に合わないと「0 行更新」になり、例外にはならない。
    // 例外の有無ではなく、値が変わっていないことで判定する。
    await h.asUser(ENT_A_SITE, 'update ai_runs set status = $1 where id = $2', ['rejected', runId]);

    const [row] = await h.asSuperuser<{ status: string }>(
      'select status from ai_runs where id = $1',
      [runId],
    );
    expect(row!.status, '権限の無いロールが AI の採否を確定できてしまう').toBe('succeeded');
  });

  it('AI 実行権限のあるロールは採否を確定できる', async () => {
    const runId = await seedAiRun();
    await h.asUser(ENT_A_ADMIN, 'update ai_runs set status = $1 where id = $2', [
      'accepted',
      runId,
    ]);
    const [after] = await h.asSuperuser<{ status: string }>(
      'select status from ai_runs where id = $1',
      [runId],
    );
    expect(after!.status).toBe('accepted');
  });

  it('同じ項目を何度直しても、Snapshot 変更は 1 行に畳まれる', async () => {
    // 版が増えるたびに行が積み上がると、監査人の「影響なし」評価が埋もれ、
    // 変更の件数も実態より多く見える。
    const [item] = await h.asSuperuser<{ id: string; source_id: string }>(
      'select id, source_id from assurance_snapshot_items limit 1',
    );
    expect(item, 'Snapshot 項目が seed に必要').toBeTruthy();

    const before = await h.asSuperuser<{ id: string }>(
      "select id from snapshot_changes where snapshot_item_id = $1 and change_kind = 'version_added'",
      [item!.id],
    );

    for (const value of [111, 222, 333]) {
      await h.asSuperuser(
        `insert into data_point_versions
           (id, data_point_id, organization_id, version_no, value, unit_of_measure, status,
            source_type, content_hash, created_at, created_by)
         values (gen_random_uuid(), $1,
                 (select organization_id from data_points where id = $1),
                 (select coalesce(max(version_no), 0) + 1 from data_point_versions where data_point_id = $1),
                 $2, 't', 'draft', 'manual', md5(random()::text), now(), null)`,
        [item!.source_id, value],
      );
    }

    const after = await h.asSuperuser<{ id: string; after_summary: string }>(
      "select id, after_summary from snapshot_changes where snapshot_item_id = $1 and change_kind = 'version_added'",
      [item!.id],
    );
    expect(after, '同じ項目の同種の変更は 1 行にまとまる').toHaveLength(1);
    expect(after[0]!.after_summary, '最新の値で上書きされる').toContain('333');
    expect(before.length).toBeLessThanOrEqual(1);
  });

  it('無関係な企業は他社案件の許諾を作れない', async () => {
    // 許諾は企業と監査法人の唯一の接続点。共有範囲を第三者が広げられてはいけない。
    const denied = await h.expectDenied(
      ENT_B_ADMIN,
      `insert into client_access_grants
         (id, engagement_id, client_organization_id, assurance_firm_id, subject_type, subject_id, includes_evidence, granted_by, granted_at)
       values (gen_random_uuid(), $1, $2, $3, 'metric', gen_random_uuid(), true, $4, now())`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aomi, ORG_IDS.aoba, ENT_B_ADMIN],
    );
    expect(denied).not.toBeNull();
  });

  it('他テナント名義の監査ログは書けない', async () => {
    // 追記専用なので、混ぜられた偽の行は後から消せない。
    const denied = await h.expectDenied(
      ENT_A_ADMIN,
      `insert into audit_events (id, actor_user_id, actor_organization_id, event_type, resource_type, created_at)
       values (gen_random_uuid(), $1, $2, 'data_updated', 'data_point', now())`,
      [ENT_A_ADMIN, ORG_IDS.soten],
    );
    expect(denied, '他組織名義の監査ログを書けてしまう').not.toBeNull();
  });

  it('参加していない案件の監査ログは書けない', async () => {
    const denied = await h.expectDenied(
      ENT_A_ADMIN,
      `insert into audit_events (id, actor_user_id, actor_organization_id, engagement_id, event_type, resource_type, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'data_updated', 'data_point', now())`,
      [ENT_A_ADMIN, ORG_IDS.aomi, ENGAGEMENT_IDS.other],
    );
    expect(denied).not.toBeNull();
  });

  it('自分の組織名義の監査ログは書ける（正常系を壊していない）', async () => {
    await h.asUser(
      ENT_A_ADMIN,
      `insert into audit_events (id, actor_user_id, actor_organization_id, event_type, resource_type, created_at)
       values (gen_random_uuid(), $1, $2, 'data_updated', 'data_point', now())`,
      [ENT_A_ADMIN, ORG_IDS.aomi],
    );
  });

  it('許諾行のクライアントは案件のクライアントと一致していなければ作れない', async () => {
    const denied = await h.expectDenied(
      ENT_A_ADMIN,
      `insert into client_access_grants
         (id, engagement_id, client_organization_id, assurance_firm_id, subject_type, subject_id, includes_evidence, granted_by, granted_at)
       values (gen_random_uuid(), $1, $2, $3, 'metric', gen_random_uuid(), false, $4, now())`,
      [ENGAGEMENT_IDS.main, ORG_IDS.soten, ORG_IDS.aoba, ENT_A_ADMIN],
    );
    expect(denied).not.toBeNull();
  });

  it('監査法人はクライアントの PBC 回答本文を書き換えられない', async () => {
    // CLAUDE.md §0.3「監査法人はクライアント原本を更新しない」。
    // 受領判定（decision）だけが監査法人側の操作。
    const [response] = await h.asSuperuser<{ id: string; body: string }>(
      'select id, body from pbc_request_responses limit 1',
    );
    expect(response, 'PBC 回答が seed に必要').toBeTruthy();

    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      'update pbc_request_responses set body = $1 where id = $2',
      ['監査人による改ざん', response!.id],
    );
    expect(denied, 'クライアントの提出内容を書き換えられてしまう').not.toBeNull();

    const [after] = await h.asSuperuser<{ body: string }>(
      'select body from pbc_request_responses where id = $1',
      [response!.id],
    );
    expect(after!.body).toBe(response!.body);
  });

  it('監査法人は受領判定（decision）は更新できる', async () => {
    const [response] = await h.asSuperuser<{ id: string }>(
      'select id from pbc_request_responses limit 1',
    );
    await h.asUser(FIRM_A_MANAGER, 'update pbc_request_responses set decision = $1 where id = $2', [
      'accepted',
      response!.id,
    ]);
    const [after] = await h.asSuperuser<{ decision: string }>(
      'select decision from pbc_request_responses where id = $1',
      [response!.id],
    );
    expect(after!.decision).toBe('accepted');
  });

  it('企業ユーザーは PBC の内部メモ列を含む draft を取得できない', async () => {
    const rows = await h.asUser<{ code: string }>(
      ENT_A_ADMIN,
      'select code from pbc_requests order by code',
      [],
    );
    // PBC-005 は draft のため企業側からは不可視
    expect(rows.map((r) => r.code)).not.toContain('PBC-005');
    expect(rows.map((r) => r.code)).toContain('PBC-001');
  });
});

describe('11. Sign-off の代理禁止', () => {
  it('他人名義の Sign-off は挿入できない', async () => {
    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      `insert into signoffs (engagement_id, assurance_firm_id, signoff_stage, user_id, role_key)
       values ($1, $2, 'prepared', $3, 'assurance_staff')`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aoba, FIRM_A_STAFF],
    );
    expect(denied).toBeTruthy();
  });

  it('本人名義であれば挿入できる', async () => {
    const rows = await h.asUser(
      FIRM_A_MANAGER,
      `insert into signoffs (engagement_id, assurance_firm_id, signoff_stage, user_id, role_key)
       values ($1, $2, 'prepared', $3, 'assurance_manager') returning id`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aoba, FIRM_A_MANAGER],
    );
    expect(rows).toHaveLength(1);
  });

  it('Partner Sign-off はマネージャー権限では挿入できない', async () => {
    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      `insert into signoffs (engagement_id, assurance_firm_id, signoff_stage, user_id, role_key)
       values ($1, $2, 'partner_approved', $3, 'assurance_manager')`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aoba, FIRM_A_MANAGER],
    );
    expect(denied).toBeTruthy();
  });

  it('Partner は Partner Sign-off を挿入できる', async () => {
    const rows = await h.asUser(
      FIRM_A_PARTNER,
      `insert into signoffs (engagement_id, assurance_firm_id, signoff_stage, user_id, role_key)
       values ($1, $2, 'partner_approved', $3, 'engagement_partner') returning id`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aoba, FIRM_A_PARTNER],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('12. AI が開示回答を自動確定できない', () => {
  it('AI 由来のまま approved バージョンを作れない', async () => {
    const aiRun = await h.asSuperuser<{ id: string }>(
      `insert into ai_runs (organization_id, feature_type, provider, model, prompt_version, status)
       values ($1, 'cdpDraftGeneration', 'mock', 'mock-v1', 'v1', 'succeeded') returning id`,
      [ORG_IDS.aomi],
    );
    const runId = aiRun[0]?.id;
    const response = await h.asSuperuser<{ id: string }>(
      `select id from disclosure_responses where organization_id = $1 and reporting_period_id = $2 limit 1`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );

    await expect(
      h.asSuperuser(
        `insert into disclosure_response_versions
           (response_id, organization_id, version_no, status, originated_from_ai_run_id, content_hash)
         values ($1, $2, 99, 'approved', $3, 'h')`,
        [response[0]?.id, ORG_IDS.aomi, runId],
      ),
    ).rejects.toThrow(/T4D_AI_AUTO_APPROVAL_FORBIDDEN/);
  });

  it('人が確定した（AI 由来でない）バージョンは approved にできる', async () => {
    const response = await h.asSuperuser<{ id: string }>(
      `select id from disclosure_responses where organization_id = $1 and reporting_period_id = $2 limit 1`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );
    const rows = await h.asSuperuser<{ id: string }>(
      `insert into disclosure_response_versions
         (response_id, organization_id, version_no, status, originated_from_ai_run_id, content_hash)
       values ($1, $2, 98, 'approved', null, 'h') returning id`,
      [response[0]?.id, ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('13. 許諾の付与・取消は企業側のみ', () => {
  it('監査法人は自分に許諾を追加できない', async () => {
    const denied = await h.expectDenied(
      FIRM_A_MANAGER,
      `insert into client_access_grants
         (engagement_id, client_organization_id, assurance_firm_id, subject_type, subject_id, granted_by)
       values ($1, $2, $3, 'metric', $4, $5)`,
      [ENGAGEMENT_IDS.main, ORG_IDS.aomi, ORG_IDS.aoba, metricId('AOMI', 'water'), FIRM_A_MANAGER],
    );
    expect(denied).toBeTruthy();
  });

  it('企業管理者は許諾を追加でき、追加した瞬間から監査法人に見える', async () => {
    // 事前確認: まだ見えない
    const before = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      UNGRANTED_METRIC_DP,
    ]);
    expect(before).toHaveLength(0);

    const rows = await h.asUser(
      ENT_A_ADMIN,
      `insert into client_access_grants
         (engagement_id, client_organization_id, assurance_firm_id, subject_type, subject_id, granted_by)
       values ($1, $2, $3, 'metric', $4, $5) returning id`,
      [
        ENGAGEMENT_IDS.main,
        ORG_IDS.aomi,
        ORG_IDS.aoba,
        metricId('AOMI', 'managers_total'),
        ENT_A_ADMIN,
      ],
    );
    expect(rows).toHaveLength(1);

    const after = await h.asUser(FIRM_A_MANAGER, 'select id from data_points where id = $1', [
      UNGRANTED_METRIC_DP,
    ]);
    expect(after).toHaveLength(1);
  });
});

describe('11. 本 QA で新たにアプリへ露出したテーブルの越権', () => {
  // 収集キャンペーン（ORG-P0-002）・適用判定（CDP-P0-002）はアプリ層でも
  // 所有組織を照合しているが、DB 層でも止まることをここで担保する。
  //
  // Fixture にはこれらの行が無く、そのままでは「0 件だから通る」空振りテストになる。
  // RLS をバイパスして企業 A の行を先に作り、企業 B から見えないことを検証する。

  beforeAll(async () => {
    const [campaign] = await h.asSuperuser<{ id: string }>(
      `insert into collection_campaigns
         (organization_id, reporting_period_id, name, status, due_date)
       values ($1, $2, 'RLS テスト用キャンペーン', 'open', '2026-06-30')
       returning id`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );
    const [item] = await h.asSuperuser<{ id: string }>('select id from disclosure_items limit 1');
    const [unit] = await h.asSuperuser<{ id: string }>(
      'select id from organization_units where organization_id = $1 limit 1',
      [ORG_IDS.aomi],
    );
    const [metric] = await h.asSuperuser<{ id: string }>(
      'select id from metric_definitions where organization_id = $1 limit 1',
      [ORG_IDS.aomi],
    );

    await h.asSuperuser(
      `insert into campaign_scopes (campaign_id, unit_id, metric_id, due_date)
       values ($1, $2, $3, '2026-06-30')`,
      [campaign!.id, unit!.id, metric!.id],
    );
    await h.asSuperuser(
      `insert into applicability_results
         (organization_id, item_id, reporting_period_id, applicability, reason)
       values ($1, $2, $3, 'applicable', 'RLS テスト用')`,
      [ORG_IDS.aomi, item!.id, PERIOD_IDS.fy2026],
    );
  });

  it('企業 A 自身は作成した行を取得できる（空振りテストでないことの確認）', async () => {
    const campaigns = await h.asUser(
      ENT_A_ADMIN,
      'select id from collection_campaigns where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(campaigns.length).toBeGreaterThan(0);

    const scopes = await h.asUser(
      ENT_A_ADMIN,
      `select s.id from campaign_scopes s
         join collection_campaigns c on c.id = s.campaign_id
        where c.organization_id = $1`,
      [ORG_IDS.aomi],
    );
    expect(scopes.length).toBeGreaterThan(0);

    const applicability = await h.asUser(
      ENT_A_ADMIN,
      'select id from applicability_results where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(applicability.length).toBeGreaterThan(0);
  });

  it('企業 B の管理者は企業 A の収集キャンペーンを取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from collection_campaigns where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の収集キャンペーンを作成できない', async () => {
    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into collection_campaigns
           (organization_id, reporting_period_id, name, status, due_date)
         values ($1, $2, '越権キャンペーン', 'open', '2026-06-30')`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 B の管理者は企業 A の収集スコープを取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      `select s.id from campaign_scopes s
         join collection_campaigns c on c.id = s.campaign_id
        where c.organization_id = $1`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の適用判定を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from applicability_results where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の適用判定を作成できない', async () => {
    const items = await h.asUser(ENT_B_ADMIN, 'select id from disclosure_items limit 1', []);
    const itemId = (items[0] as { id: string } | undefined)?.id;
    expect(itemId, '開示項目は全テナント共通で参照できる想定').toBeDefined();

    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into applicability_results
           (organization_id, item_id, reporting_period_id, applicability, reason)
         values ($1, $2, $3, 'not_applicable', '越権')`,
        [ORG_IDS.aomi, itemId, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 B の管理者は企業 A のマテリアリティ評価を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from materiality_topics where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A のマテリアリティ評価を作成できない', async () => {
    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into materiality_topics
           (organization_id, reporting_period_id, topic_key, title, category, materiality, rationale)
         values ($1, $2, 'climate_ghg', '越権', 'environment', 'high', '越権')`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 B の管理者は企業 A のマテリアリティ評価を更新できない', async () => {
    // 更新は 0 行になる（RLS の USING に外れるため対象が見えない）
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update materiality_topics set materiality = 'not_material'
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  it('企業 A の管理者は自社のマテリアリティ評価を参照できる（false negative でないこと）', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from materiality_topics where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // --- SSBJ ギャップ評価・対応計画 ---

  it('企業 B の管理者は企業 A の SSBJ 評価を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from ssbj_assessments where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の SSBJ 評価を作成できない', async () => {
    const item = await h.asUser(
      ENT_A_ADMIN,
      `select i.id from disclosure_items i
         join disclosure_framework_versions v on v.id = i.framework_version_id
         join disclosure_frameworks f on f.id = v.framework_id
        where f.key = 'ssbj' limit 1`,
      [],
    );
    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into ssbj_assessments (organization_id, reporting_period_id, item_id)
         values ($1, $2, $3)`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026, (item[0] as { id: string }).id],
      ),
    ).rejects.toThrow();
  });

  it('企業 B の管理者は企業 A の SSBJ 評価を更新できない', async () => {
    // RLS の USING に外れるため 0 行更新になる（例外にはならない）
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update ssbj_assessments set final_status = 'covered'
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  it('企業 A の管理者は自社の SSBJ 評価を参照できる（false negative でないこと）', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from ssbj_assessments where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('企業 B の管理者は企業 A の対応計画を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from ssbj_action_plans where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の対応計画を更新できない', async () => {
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update ssbj_action_plans set status = 'done'
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  it('企業 A の管理者は自社の対応計画を参照できる（false negative でないこと）', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from ssbj_action_plans where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // --- 承認の道筋（最大 5 階層） ---

  it('企業 B の管理者は企業 A の承認の道筋を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from approval_routes where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 A の管理者は自社の承認の道筋と段階を参照できる（false negative でないこと）', async () => {
    const routes = await h.asUser(
      ENT_A_ADMIN,
      'select id from approval_routes where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(routes.length).toBeGreaterThan(0);
    const stages = await h.asUser(
      ENT_A_ADMIN,
      'select id from approval_route_stages where organization_id = $1',
      [ORG_IDS.aomi],
    );
    // 5 階層の既定ルートが入っている
    expect(stages.length).toBeGreaterThanOrEqual(5);
  });

  it('企業 B の管理者は企業 A の承認段階を書き換えられない', async () => {
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update approval_route_stages set name = '乗っ取り'
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A のデータの承認段階を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from data_point_approval_steps where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A のデータを承認できない', async () => {
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update data_point_approval_steps set status = 'approved', decided_at = now()
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  it('企業 A の管理者は自社のデータの承認段階を参照できる（false negative でないこと）', async () => {
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from data_point_approval_steps where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('承認段階は 6 階層以上を作れない', async () => {
    const route = await h.asUser(
      ENT_A_ADMIN,
      'select id from approval_routes where organization_id = $1 limit 1',
      [ORG_IDS.aomi],
    );
    await expect(
      h.asUser(
        ENT_A_ADMIN,
        `insert into approval_route_stages (organization_id, route_id, stage_no, name)
         values ($1, $2, 6, '6 段目')`,
        [ORG_IDS.aomi, (route[0] as { id: string }).id],
      ),
    ).rejects.toThrow();
  });

  // --- SSBJ 分析条件（①マテリアリティ・分析条件の設定） ---

  it('企業 B の管理者は企業 A の SSBJ 分析条件を作成できない', async () => {
    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into ssbj_analysis_settings (organization_id, reporting_period_id)
         values ($1, $2)`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 A の管理者は自社の SSBJ 分析条件を作成・参照できる', async () => {
    await h.asUser(
      ENT_A_ADMIN,
      `insert into ssbj_analysis_settings
         (organization_id, reporting_period_id, value_chain_scope)
       values ($1, $2, 'both')`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from ssbj_analysis_settings where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('企業 B の管理者は企業 A の SSBJ 分析条件を取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from ssbj_analysis_settings where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('企業 B の管理者は企業 A の SSBJ 分析条件を確定できない', async () => {
    const updated = await h.asUser(
      ENT_B_ADMIN,
      `update ssbj_analysis_settings set confirmed_at = now()
         where organization_id = $1 returning id`,
      [ORG_IDS.aomi],
    );
    expect(updated).toHaveLength(0);
  });

  // --- SSBJ 開示ドラフトの草案 ---

  it('企業 B の管理者は企業 A の開示ドラフトを作成できない', async () => {
    await expect(
      h.asUser(
        ENT_B_ADMIN,
        `insert into ssbj_disclosure_drafts (organization_id, reporting_period_id, area, body)
         values ($1, $2, 'governance', '乗っ取り')`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 A の管理者は自社の開示ドラフトを作成・参照できる', async () => {
    await h.asUser(
      ENT_A_ADMIN,
      `insert into ssbj_disclosure_drafts (organization_id, reporting_period_id, area, body)
       values ($1, $2, 'governance', '当社は…')`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );
    const rows = await h.asUser(
      ENT_A_ADMIN,
      'select id from ssbj_disclosure_drafts where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('企業 B の管理者は企業 A の開示ドラフトを取得できない', async () => {
    const rows = await h.asUser(
      ENT_B_ADMIN,
      'select id from ssbj_disclosure_drafts where organization_id = $1',
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(0);
  });

  it('開示ドラフトの節は既知のものに限る', async () => {
    await expect(
      h.asUser(
        ENT_A_ADMIN,
        `insert into ssbj_disclosure_drafts (organization_id, reporting_period_id, area)
         values ($1, $2, 'unknown_area')`,
        [ORG_IDS.aomi, PERIOD_IDS.fy2026],
      ),
    ).rejects.toThrow();
  });

  it('企業 A の管理者は自社の収集キャンペーンを作成できる（false negative でないこと）', async () => {
    await h.asUser(
      ENT_A_ADMIN,
      `insert into collection_campaigns
         (organization_id, reporting_period_id, name, status, due_date)
       values ($1, $2, '自社キャンペーン', 'open', '2026-06-30')`,
      [ORG_IDS.aomi, PERIOD_IDS.fy2026],
    );
    const rows = await h.asUser(
      ENT_A_ADMIN,
      `select id from collection_campaigns where organization_id = $1 and name = '自社キャンペーン'`,
      [ORG_IDS.aomi],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('12. 開示優先モードのテーブル（0033〜0040）', () => {
  // Fixture のデモ行（disclosure-first.ts）に頼らず、RLS をバイパスして企業 A の検証用の行を作る
  // （デモの筋書きを直しても越権テストの前提が変わらないように）。機能設定だけは組織ごとに 1 行の
  // 一意制約があるため、Fixture の行（disclosure_first = false）をそのまま使う。
  // 越権の INSERT は RLS 以外では通る内容にし、エラーが RLS によるものであることまで確かめる。
  const ORG_A = ORG_IDS.aomi;
  const AUTHOR = userId('sustainability@demo.local'); // disclosure.write
  const REVIEWER = ENT_A_REVIEWER; // disclosure.write（approve なし）
  const APPROVER = ENT_A_APPROVER; // approver + reviewer（write と approve）
  const ADMIN = ENT_A_ADMIN; // org.manage / disclosure.write / export.run / metric.manage / import.run
  // 承認権限だけを持つ利用者（approver ロールのみ）。デモ利用者には居ないためここで作る
  const APPROVE_ONLY = fid('user', 'rls-approve-only@demo.local');
  const RLS_ERROR = /row-level security/;
  const BODY = JSON.stringify({
    paragraphs: [
      { id: 'p1', kind: 'paragraph', children: [{ t: 'text', text: '取締役会が監督する。' }] },
    ],
  });

  const ids: Record<string, string> = {};
  const id = (key: string): string => {
    const value = ids[key];
    if (!value) throw new Error(`テスト用の行 ${key} が作られていない`);
    return value;
  };

  async function one(sql: string, params: unknown[] = []): Promise<string> {
    const rows = await h.asSuperuser<{ id: string }>(sql, params);
    const value = rows[0]?.id;
    if (!value) throw new Error(`行を作れませんでした: ${sql.slice(0, 80)}`);
    return value;
  }

  const EVENT_SQL = `insert into review_events
      (organization_id, review_request_id, event_type, stage, actor_user_id, target_version_id,
       reason, paragraph_id, idempotency_key)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`;
  function eventParams(
    request: string,
    eventType: string,
    stage: string,
    actor: string,
    version: string,
    extra: { reason?: string; paragraphId?: string; key?: string } = {},
  ): unknown[] {
    return [
      ORG_A,
      id(request),
      eventType,
      stage,
      actor,
      id(version),
      extra.reason ?? null,
      extra.paragraphId ?? null,
      extra.key ?? null,
    ];
  }

  beforeAll(async () => {
    ids.framework = await one(
      `select v.id from disclosure_framework_versions v
         join disclosure_frameworks f on f.id = v.framework_id
        where f.key = 'ssbj' limit 1`,
    );
    ids.fileVersion = await one(
      'select id from file_versions where organization_id = $1 order by id limit 1',
      [ORG_A],
    );
    ids.metric = await one(
      'select id from metric_definitions where organization_id = $1 order by code limit 1',
      [ORG_A],
    );
    ids.dataPointVersion = await one(
      'select id from data_point_versions where organization_id = $1 order by id limit 1',
      [ORG_A],
    );

    await h.asSuperuser('insert into auth.users (id, email) values ($1, $2)', [
      APPROVE_ONLY,
      'rls-approve-only@demo.local',
    ]);
    await h.asSuperuser(
      `insert into profiles (id, email, display_name) values ($1, $2, 'RLS 承認専任')`,
      [APPROVE_ONLY, 'rls-approve-only@demo.local'],
    );
    const membership = await one(
      `insert into organization_memberships (organization_id, user_id, status)
       values ($1, $2, 'active') returning id`,
      [ORG_A, APPROVE_ONLY],
    );
    await h.asSuperuser(
      `insert into membership_roles (membership_id, role_key) values ($1, 'approver')`,
      [membership],
    );

    ids.settings = await one(
      `select id from organization_feature_settings
        where organization_id = $1 and disclosure_first = false`,
      [ORG_A],
    );
    ids.project = await one(
      `insert into disclosure_projects
         (organization_id, reporting_period_id, name, period_start, period_end, purposes)
       values ($1, $2, 'RLS テスト用プロジェクト', '2026-04-01', '2027-03-31', '{ssbj_statutory}')
       returning id`,
      [ORG_A, PERIOD_IDS.fy2026],
    );
    ids.projectFramework = await one(
      `insert into project_frameworks (organization_id, project_id, framework_version_id, purpose)
       values ($1, $2, $3, 'ssbj_statutory') returning id`,
      [ORG_A, id('project'), id('framework')],
    );
    ids.decision = await one(
      `insert into project_framework_decisions
         (organization_id, project_framework_id, decision_no, applicability_status,
          reason, rule_ref, confirmed_on, decided_by)
       values ($1, $2, 1, 'applicable', 'プライム上場のため', 'SSBJ 適用基準（2026-03-13 改正）',
               '2026-08-01', $3)
       returning id`,
      [ORG_A, id('projectFramework'), AUTHOR],
    );
    await h.asSuperuser(
      `update project_frameworks set current_decision_id = $1, applicability_status = 'applicable'
        where id = $2`,
      [id('decision'), id('projectFramework')],
    );
    ids.narrative = await one(
      `insert into narrative_records (organization_id, theme, title)
       values ($1, 'governance', '取締役会の監督体制') returning id`,
      [ORG_A],
    );
    ids.narrativeVersion = await one(
      `insert into narrative_versions
         (organization_id, narrative_record_id, version_no, reporting_period_id, body,
          content_hash, created_by)
       values ($1, $2, 1, $3, '取締役会が気候関連課題を監督する。', 'hash-n1', $4) returning id`,
      [ORG_A, id('narrative'), PERIOD_IDS.fy2026, AUTHOR],
    );
    ids.anchor = await one(
      `insert into source_anchors
         (organization_id, file_version_id, anchor_kind, quote_text, acquired_by, created_by)
       values ($1, $2, 'manual_excerpt', '取締役会は年 4 回報告を受ける', 'manual', $3)
       returning id`,
      [ORG_A, id('fileVersion'), AUTHOR],
    );

    // 節は 3 つ。職務分離の筋書きごとに依頼を分ける（同じ節に進行中の依頼は 1 件まで）
    //   main       … 版の作成者＝依頼者＝海野。検見川がレビュー、承が承認する（正常系）
    //   byApprover … 版の作成者が承（最終承認者）。依頼者は海野
    //   sameActor  … 承がレビューを完了し、同じ依頼を承認しようとする
    const blocks: Array<[key: string, author: string]> = [
      ['main', AUTHOR],
      ['byApprover', APPROVER],
      ['sameActor', AUTHOR],
    ];
    for (const [key, author] of blocks) {
      ids[`block.${key}`] = await one(
        `insert into disclosure_blocks
           (organization_id, project_id, framework_version_id, section_key, title)
         values ($1, $2, $3, $4, $5) returning id`,
        [ORG_A, id('project'), id('framework'), `governance-${key}`, `ガバナンス（${key}）`],
      );
      ids[`version.${key}`] = await one(
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, plain_text, content_hash, created_by)
         values ($1, $2, 1, $3::jsonb, '取締役会が監督する。', $4, $5) returning id`,
        [ORG_A, id(`block.${key}`), BODY, `hash-${key}-v1`, author],
      );
      await h.asSuperuser(
        `update disclosure_blocks
            set current_version_id = $1, submitted_version_id = $1, status = 'review_requested'
          where id = $2`,
        [id(`version.${key}`), id(`block.${key}`)],
      );
      ids[`request.${key}`] = await one(
        `insert into review_requests
           (organization_id, project_id, target_id, target_version_id, requested_by,
            policy_version, policy)
         values ($1, $2, $3, $4, $5, 'sod-3role-v1', '{"version": "sod-3role-v1"}'::jsonb)
         returning id`,
        [ORG_A, id('project'), id(`block.${key}`), id(`version.${key}`), AUTHOR],
      );
    }
    ids.event = await one(
      EVENT_SQL,
      eventParams('request.main', 'requested', 'request', AUTHOR, 'version.main'),
    );
    ids.comment = await one(
      `insert into review_comments
         (organization_id, block_id, block_version_id, paragraph_id, body, severity, created_by)
       values ($1, $2, $3, 'p1', '根拠資料の版を確認してください', 'major', $4) returning id`,
      [ORG_A, id('block.main'), id('version.main'), REVIEWER],
    );
    ids.recheck = await one(
      `insert into recheck_decisions
         (organization_id, block_id, block_version_id, ref_kind, old_ref_id, new_ref_id,
          decision, reason, decided_by)
       values ($1, $2, $3, 'metric', $4, $4, 'keep_old', '差分は端数処理のみ', $5) returning id`,
      [ORG_A, id('block.main'), id('version.main'), id('dataPointVersion'), AUTHOR],
    );
    ids.snapshot = await one(
      `insert into report_snapshots
         (organization_id, project_id, snapshot_kind, snapshot_no, content_hash, created_by)
       values ($1, $2, 'review_draft', 1, 'hash-s1', $3) returning id`,
      [ORG_A, id('project'), AUTHOR],
    );
    ids.artifact = await one(
      `insert into export_artifacts
         (organization_id, snapshot_id, format, template_version, file_name, byte_size,
          file_sha256, content_hash, generated_by)
       values ($1, $2, 'docx', 'tpl-v1', 'report.docx', 1024, 'sha-1', 'hash-s1', $3)
       returning id`,
      [ORG_A, id('snapshot'), AUTHOR],
    );
    ids.kpi = await one(
      `insert into kpi_targets
         (organization_id, target_key, version_no, metric_id, target_year, target_value,
          target_type, direction, created_by)
       values ($1, 'ghg_2030', 1, $2, 2030, 100, 'absolute', 'reduce', $3) returning id`,
      [ORG_A, id('metric'), AUTHOR],
    );
    ids.batch = await one(
      `insert into quantitative_import_batches
         (organization_id, reporting_period_id, file_name, file_sha256, preview_hash)
       values ($1, $2, 'standard.csv', 'sha-csv', 'preview-1') returning id`,
      [ORG_A, PERIOD_IDS.fy2026],
    );
  });

  it('デモ Fixture の行が制約と職務分離トリガを通って投入され、他テナントからは見えない', async () => {
    // 承認済みの節の記録（依頼・レビュー完了・最終承認）は投入時に t4d.enforce_review_event を通る。
    // 件数まで見るのは、SEED_ORDER の漏れで行が黙って投入されない事故を拾うため
    const [counts] = await h.asSuperuser<{ events: string; blocks: string; anchors: string }>(
      `select (select count(*) from review_events where review_request_id = $1)::text as events,
              (select count(*) from disclosure_blocks where project_id = $2)::text as blocks,
              (select count(*) from source_anchors
                where organization_id = $3 and acquired_by = 'extracted')::text as anchors`,
      [
        DISCLOSURE_FIRST_IDS.blocks.fy2026Governance.request,
        DISCLOSURE_FIRST_IDS.projects.fy2026,
        ORG_A,
      ],
    );
    expect(counts).toEqual({ events: '3', blocks: '4', anchors: '9' });

    const project = DISCLOSURE_FIRST_IDS.projects.fy2026;
    const own = await h.asUser(AUTHOR, 'select id from disclosure_projects where id = $1', [
      project,
    ]);
    expect(own).toHaveLength(1);
    const other = await h.asUser(ENT_B_ADMIN, 'select id from disclosure_projects where id = $1', [
      project,
    ]);
    expect(other).toHaveLength(0);
  });

  interface TenantSpec {
    table: string;
    /** 企業 B の管理者が企業 A の名義で試みる INSERT（RLS 以外の制約では通る内容） */
    insert: () => [sql: string, params: unknown[]];
    /** 企業 B の管理者が企業 A の行へ試みる UPDATE（$1 = 企業 A） */
    update: string;
  }

  const TENANT_SPECS: TenantSpec[] = [
    {
      table: 'organization_feature_settings',
      insert: () => [
        'insert into organization_feature_settings (organization_id, disclosure_first) values ($1, false)',
        [ORG_A],
      ],
      update: 'update organization_feature_settings set disclosure_first = false',
    },
    {
      table: 'disclosure_projects',
      insert: () => [
        `insert into disclosure_projects (organization_id, reporting_period_id, name, period_start, period_end)
         values ($1, $2, '越権プロジェクト', '2026-04-01', '2027-03-31')`,
        [ORG_A, PERIOD_IDS.fy2026],
      ],
      update: `update disclosure_projects set name = '乗っ取り'`,
    },
    {
      table: 'project_frameworks',
      insert: () => [
        `insert into project_frameworks (organization_id, project_id, framework_version_id, purpose)
         values ($1, $2, $3, 'internal_esg')`,
        [ORG_A, id('project'), id('framework')],
      ],
      update: `update project_frameworks set applicability_status = 'not_applicable'`,
    },
    {
      table: 'project_framework_decisions',
      insert: () => [
        `insert into project_framework_decisions
           (organization_id, project_framework_id, decision_no, applicability_status, reason,
            rule_ref, confirmed_on, decided_by)
         values ($1, $2, 2, 'not_applicable', '越権', '越権', '2026-08-01', $3)`,
        [ORG_A, id('projectFramework'), ENT_B_ADMIN],
      ],
      update: `update project_framework_decisions set reason = '改ざん'`,
    },
    {
      table: 'narrative_records',
      insert: () => [
        `insert into narrative_records (organization_id, theme, title) values ($1, 'strategy', '越権')`,
        [ORG_A],
      ],
      update: `update narrative_records set title = '乗っ取り'`,
    },
    {
      table: 'narrative_versions',
      insert: () => [
        `insert into narrative_versions
           (organization_id, narrative_record_id, version_no, reporting_period_id, body, content_hash, created_by)
         values ($1, $2, 2, $3, '越権', 'hash-x', $4)`,
        [ORG_A, id('narrative'), PERIOD_IDS.fy2026, ENT_B_ADMIN],
      ],
      update: `update narrative_versions set body = '改ざん'`,
    },
    {
      table: 'source_anchors',
      insert: () => [
        `insert into source_anchors
           (organization_id, file_version_id, anchor_kind, quote_text, acquired_by, created_by)
         values ($1, $2, 'manual_excerpt', '越権', 'manual', $3)`,
        [ORG_A, id('fileVersion'), ENT_B_ADMIN],
      ],
      update: `update source_anchors set quote_text = '改ざん'`,
    },
    {
      table: 'disclosure_blocks',
      insert: () => [
        `insert into disclosure_blocks (organization_id, project_id, framework_version_id, section_key, title)
         values ($1, $2, $3, 'strategy', '越権')`,
        [ORG_A, id('project'), id('framework')],
      ],
      update: `update disclosure_blocks set title = '乗っ取り'`,
    },
    {
      table: 'disclosure_block_versions',
      insert: () => [
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, content_hash, created_by)
         values ($1, $2, 9, $3::jsonb, 'hash-x', $4)`,
        [ORG_A, id('block.main'), BODY, ENT_B_ADMIN],
      ],
      update: `update disclosure_block_versions set plain_text = '改ざん'`,
    },
    {
      table: 'review_requests',
      insert: () => [
        `insert into review_requests
           (organization_id, project_id, target_id, target_version_id, requested_by, policy_version, policy)
         values ($1, $2, $3, $4, $5, 'sod-3role-v1', '{}'::jsonb)`,
        [ORG_A, id('project'), id('block.main'), id('version.main'), ENT_B_ADMIN],
      ],
      update: `update review_requests set reviewer_user_id = null`,
    },
    {
      // BEFORE トリガ（職務分離）は RLS より先に走る。トリガを通る「依頼」の記録で RLS を確かめる
      table: 'review_events',
      insert: () => [
        EVENT_SQL,
        eventParams('request.main', 'requested', 'request', ENT_B_ADMIN, 'version.main'),
      ],
      update: `update review_events set reason = '改ざん'`,
    },
    {
      table: 'review_comments',
      insert: () => [
        `insert into review_comments (organization_id, block_id, block_version_id, body, severity, created_by)
         values ($1, $2, $3, '越権', 'info', $4)`,
        [ORG_A, id('block.main'), id('version.main'), ENT_B_ADMIN],
      ],
      update: `update review_comments set resolution_note = '改ざん'`,
    },
    {
      table: 'recheck_decisions',
      insert: () => [
        `insert into recheck_decisions
           (organization_id, block_id, block_version_id, ref_kind, old_ref_id, new_ref_id, decision, reason, decided_by)
         values ($1, $2, $3, 'metric', $4, $4, 'adopt_new', '越権', $5)`,
        [ORG_A, id('block.main'), id('version.main'), id('dataPointVersion'), ENT_B_ADMIN],
      ],
      update: `update recheck_decisions set reason = '改ざん'`,
    },
    {
      table: 'report_snapshots',
      insert: () => [
        `insert into report_snapshots (organization_id, project_id, snapshot_kind, snapshot_no, content_hash, created_by)
         values ($1, $2, 'review_draft', 9, 'hash-x', $3)`,
        [ORG_A, id('project'), ENT_B_ADMIN],
      ],
      update: `update report_snapshots set label = '改ざん'`,
    },
    {
      table: 'export_artifacts',
      insert: () => [
        `insert into export_artifacts
           (organization_id, snapshot_id, format, template_version, file_name, byte_size, file_sha256, content_hash, generated_by)
         values ($1, $2, 'csv', 'tpl-v1', 'x.csv', 1, 'sha-x', 'hash-x', $3)`,
        [ORG_A, id('snapshot'), ENT_B_ADMIN],
      ],
      update: `update export_artifacts set file_name = '改ざん.docx'`,
    },
    {
      table: 'kpi_targets',
      insert: () => [
        `insert into kpi_targets
           (organization_id, target_key, version_no, metric_id, target_year, target_value, target_type, direction, created_by)
         values ($1, 'x', 1, $2, 2030, 1, 'absolute', 'reduce', $3)`,
        [ORG_A, id('metric'), ENT_B_ADMIN],
      ],
      update: `update kpi_targets set scope_note = '改ざん'`,
    },
    {
      table: 'quantitative_import_batches',
      insert: () => [
        `insert into quantitative_import_batches
           (organization_id, reporting_period_id, file_name, file_sha256, preview_hash)
         values ($1, $2, 'x.csv', 'sha-x', 'preview-x')`,
        [ORG_A, PERIOD_IDS.fy2026],
      ],
      update: `update quantitative_import_batches set excluded_count = 99`,
    },
  ];

  for (const spec of TENANT_SPECS) {
    describe(spec.table, () => {
      it('企業 A 自身は作成した行を取得できる（空振りテストでないことの確認）', async () => {
        const rows = await h.asUser(
          ENT_A_ADMIN,
          `select id from ${spec.table} where organization_id = $1`,
          [ORG_A],
        );
        expect(rows.length).toBeGreaterThan(0);
      });

      it('企業 B の管理者は企業 A の行を取得できない', async () => {
        const rows = await h.asUser(
          ENT_B_ADMIN,
          `select id from ${spec.table} where organization_id = $1`,
          [ORG_A],
        );
        expect(rows).toHaveLength(0);
      });

      it('企業 B の管理者は企業 A の名義で行を作れない（RLS で拒否）', async () => {
        const [sql, params] = spec.insert();
        await expect(h.asUser(ENT_B_ADMIN, sql, params)).rejects.toThrow(RLS_ERROR);
      });

      it('企業 B の管理者は企業 A の行を更新できない（0 行）', async () => {
        const rows = await h.asUser(
          ENT_B_ADMIN,
          `${spec.update} where organization_id = $1 returning id`,
          [ORG_A],
        );
        expect(rows).toHaveLength(0);
      });
    });
  }

  // ------------------------------------------------------------------
  // 追記専用（UPDATE / DELETE ポリシーなし ＋ t4d.forbid_mutation トリガ）
  // ------------------------------------------------------------------

  const APPEND_ONLY: Array<[table: string, key: string, column: string]> = [
    ['project_framework_decisions', 'decision', 'reason'],
    ['narrative_versions', 'narrativeVersion', 'body'],
    ['source_anchors', 'anchor', 'quote_text'],
    ['disclosure_block_versions', 'version.main', 'plain_text'],
    ['review_events', 'event', 'reason'],
    ['recheck_decisions', 'recheck', 'reason'],
    ['report_snapshots', 'snapshot', 'label'],
    ['export_artifacts', 'artifact', 'file_name'],
    ['kpi_targets', 'kpi', 'scope_note'],
  ];

  for (const [table, key, column] of APPEND_ONLY) {
    describe(`${table} は追記専用`, () => {
      it('自組織の書込権限者でも UPDATE は 1 行も変更しない', async () => {
        const rows = await h.asUser(
          ENT_A_ADMIN,
          `update ${table} set ${column} = '改ざん' where id = $1 returning id`,
          [id(key)],
        );
        expect(rows).toHaveLength(0);
      });

      it('DELETE は権限自体が無い', async () => {
        const denied = await h.expectDenied(ENT_A_ADMIN, `delete from ${table} where id = $1`, [
          id(key),
        ]);
        expect(denied).toMatch(/permission denied/i);
      });

      it('Service Role 相当（RLS バイパス）でもトリガで UPDATE / DELETE が止まる', async () => {
        await expect(
          h.asSuperuser(`update ${table} set ${column} = ${column} where id = $1`, [id(key)]),
        ).rejects.toThrow(/T4D_IMMUTABLE/);
        await expect(
          h.asSuperuser(`delete from ${table} where id = $1`, [id(key)]),
        ).rejects.toThrow(/T4D_IMMUTABLE/);
      });
    });
  }

  // ------------------------------------------------------------------
  // 職務分離（review_events のトリガ t4d.enforce_review_event）
  // ------------------------------------------------------------------

  describe('職務分離（レビュー・最終承認）', () => {
    it('依頼者本人はレビューを完了できない', async () => {
      await expect(
        h.asUser(
          AUTHOR,
          EVENT_SQL,
          eventParams('request.main', 'review_completed', 'review', AUTHOR, 'version.main'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
    });

    it('依頼で固定した版以外を名乗った判断は記録できない', async () => {
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.main', 'review_completed', 'review', REVIEWER, 'version.sameActor'),
        ),
      ).rejects.toThrow(/T4D_REVIEW_TARGET_MISMATCH/);
    });

    it('他人の名義では記録できない（代理禁止・RLS）', async () => {
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.main', 'review_completed', 'review', APPROVER, 'version.main'),
        ),
      ).rejects.toThrow(RLS_ERROR);
    });

    it('差戻しは理由と対象段落が無いと記録できない', async () => {
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.main', 'returned', 'review', REVIEWER, 'version.main'),
        ),
      ).rejects.toThrow(/T4D_RETURN_REASON_REQUIRED/);
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.main', 'returned', 'review', REVIEWER, 'version.main', {
            reason: '根拠が不足しています',
          }),
        ),
      ).rejects.toThrow(/T4D_RETURN_REASON_REQUIRED/);
    });

    it('版の作成者は最終承認できない（承認権限を持っていても）', async () => {
      await expect(
        h.asUser(
          APPROVER,
          EVENT_SQL,
          eventParams('request.byApprover', 'approved', 'final', APPROVER, 'version.byApprover'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
    });

    it('承認権限の無い人は最終承認を記録できない（RLS）', async () => {
      // 最終承認は第 1 段のレビュー完了の記録が要る（0041）。依頼者・作成者ではない管理者が
      // レビューを完了した状態にしてから、トリガを通る条件で RLS だけが拒否することを確かめる
      await h.asSuperuser(
        EVENT_SQL,
        eventParams(
          'request.byApprover',
          'review_completed',
          'review',
          ADMIN,
          'version.byApprover',
          {
            key: `${id('request.byApprover')}:review:${id('version.byApprover')}`,
          },
        ),
      );
      // 検見川は依頼者でも版の作成者でもないのでトリガは通るが、approve 権限が無い
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.byApprover', 'approved', 'final', REVIEWER, 'version.byApprover'),
        ),
      ).rejects.toThrow(RLS_ERROR);
    });

    it('レビューを完了した人は、同じ依頼を最終承認できない', async () => {
      const completed = await h.asUser(
        APPROVER,
        EVENT_SQL,
        eventParams(
          'request.sameActor',
          'review_completed',
          'review',
          APPROVER,
          'version.sameActor',
        ),
      );
      expect(completed).toHaveLength(1);
      await expect(
        h.asUser(
          APPROVER,
          EVENT_SQL,
          eventParams('request.sameActor', 'approved', 'final', APPROVER, 'version.sameActor'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
    });

    it('差戻しは理由と対象段落があれば記録できる', async () => {
      const rows = await h.asUser(
        APPROVER,
        EVENT_SQL,
        eventParams('request.sameActor', 'returned', 'final', APPROVER, 'version.sameActor', {
          reason: '財務影響の記載が不足しています',
          paragraphId: 'p1',
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('依頼者・作成者・レビュー完了者のいずれでもない承認者は最終承認できる', async () => {
      const reviewed = await h.asUser(
        REVIEWER,
        EVENT_SQL,
        eventParams('request.main', 'review_completed', 'review', REVIEWER, 'version.main', {
          key: `${id('request.main')}:review:${id('version.main')}`,
        }),
      );
      expect(reviewed).toHaveLength(1);
      const approved = await h.asUser(
        APPROVER,
        EVENT_SQL,
        eventParams('request.main', 'approved', 'final', APPROVER, 'version.main', {
          key: `${id('request.main')}:final:${id('version.main')}`,
        }),
      );
      expect(approved).toHaveLength(1);
    });

    it('同じ判断を 2 回記録できない（冪等キー）', async () => {
      await expect(
        h.asUser(
          REVIEWER,
          EVENT_SQL,
          eventParams('request.main', 'review_completed', 'review', REVIEWER, 'version.main', {
            key: `${id('request.main')}:review:${id('version.main')}`,
          }),
        ),
      ).rejects.toThrow(/duplicate key/);
    });

    it('記録の種類と段階の組み合わせは固定（第 1 段で最終承認は記録できない）', async () => {
      await expect(
        h.asSuperuser(
          EVENT_SQL,
          eventParams('request.byApprover', 'approved', 'review', REVIEWER, 'version.byApprover'),
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('Service Role 相当（RLS バイパス）でも職務分離は外れない', async () => {
      await expect(
        h.asSuperuser(
          EVENT_SQL,
          eventParams('request.byApprover', 'approved', 'final', AUTHOR, 'version.byApprover'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
    });
  });

  // ------------------------------------------------------------------
  // 依頼・節・コメント・取込バッチの更新ガード
  // ------------------------------------------------------------------

  describe('更新ガード', () => {
    it('レビュー依頼の依頼者・対象版はすり替えられない（職務分離の前提を守る）', async () => {
      await expect(
        h.asUser(REVIEWER, 'update review_requests set requested_by = $2 where id = $1', [
          id('request.byApprover'),
          REVIEWER,
        ]),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
      await expect(
        h.asSuperuser('update review_requests set target_version_id = $2 where id = $1', [
          id('request.byApprover'),
          id('version.main'),
        ]),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
    });

    it('承認権限の無い人は依頼を「承認済み」にできない', async () => {
      await expect(
        h.asUser(REVIEWER, `update review_requests set status = 'approved' where id = $1`, [
          id('request.main'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('承認権限だけを持つ人は依頼を「承認済み」にでき、終わった依頼は再開できない', async () => {
      // レビュー完了の段階を飛ばして「承認済み」にはできない（0041）
      await expect(
        h.asUser(APPROVE_ONLY, `update review_requests set status = 'approved' where id = $1`, [
          id('request.main'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      // 第 1 段の完了記録（検見川）と最終承認の記録（承）があるので、記録どおりに状態を進められる
      const reviewed = await h.asUser(
        REVIEWER,
        `update review_requests set status = 'reviewed' where id = $1 returning id`,
        [id('request.main')],
      );
      expect(reviewed).toHaveLength(1);
      const rows = await h.asUser(
        APPROVE_ONLY,
        `update review_requests set status = 'approved' where id = $1 returning id`,
        [id('request.main')],
      );
      expect(rows).toHaveLength(1);
      await expect(
        h.asSuperuser(`update review_requests set status = 'open' where id = $1`, [
          id('request.main'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('承認権限の無い人は節を承認済みにできない', async () => {
      await expect(
        h.asUser(
          REVIEWER,
          `update disclosure_blocks set status = 'approved', approved_version_id = $2 where id = $1`,
          [id('block.main'), id('version.main')],
        ),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('承認権限だけを持つ人は節の状態は変えられるが、本文・題名は変えられない', async () => {
      await expect(
        h.asUser(APPROVE_ONLY, `update disclosure_blocks set title = '書き換え' where id = $1`, [
          id('block.main'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      const rows = await h.asUser(
        APPROVE_ONLY,
        `update disclosure_blocks set status = 'approved', approved_version_id = $2
          where id = $1 returning id`,
        [id('block.main'), id('version.main')],
      );
      expect(rows).toHaveLength(1);
    });

    it('節のポインタは同じ節の版しか指せない', async () => {
      await expect(
        h.asSuperuser('update disclosure_blocks set current_version_id = $2 where id = $1', [
          id('block.main'),
          id('version.sameActor'),
        ]),
      ).rejects.toThrow(/foreign key/);
    });

    it('コメントは解決の記録だけを更新できる（指摘の本文は変えられない）', async () => {
      await expect(
        h.asUser(REVIEWER, `update review_comments set body = '書き換え' where id = $1`, [
          id('comment'),
        ]),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
      const rows = await h.asUser(
        REVIEWER,
        `update review_comments set resolved_at = now(), resolved_by = $2, resolution_note = '確認済み'
          where id = $1 returning id`,
        [id('comment'), REVIEWER],
      );
      expect(rows).toHaveLength(1);
    });

    it('確定した取込バッチは変更できない', async () => {
      const committed = await h.asUser(
        ENT_A_ADMIN,
        `update quantitative_import_batches
            set status = 'committed', committed_at = now(), committed_by = $2,
                commit_idempotency_key = 'commit-1'
          where id = $1 returning id`,
        [id('batch'), ENT_A_ADMIN],
      );
      expect(committed).toHaveLength(1);
      await expect(
        h.asUser(
          ENT_A_ADMIN,
          'update quantitative_import_batches set excluded_count = 1 where id = $1',
          [id('batch')],
        ),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
    });

    it('機能設定は org.manage を持つ人だけが変えられる', async () => {
      const denied = await h.asUser(
        REVIEWER,
        'update organization_feature_settings set disclosure_first = false where id = $1 returning id',
        [id('settings')],
      );
      expect(denied).toHaveLength(0);
      const allowed = await h.asUser(
        ADMIN,
        'update organization_feature_settings set disclosure_first = true where id = $1 returning id',
        [id('settings')],
      );
      expect(allowed).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // 0041: 職務分離の抜け道（状態の直接更新・作業本文を書いた人・スナップショットの内容）
  // ------------------------------------------------------------------

  describe('0041: レビュー・承認・スナップショットの整合', () => {
    const OTHER_BODY = JSON.stringify({
      paragraphs: [
        { id: 'p1', kind: 'paragraph', children: [{ t: 'text', text: '承認者が書いた段落。' }] },
      ],
    });

    beforeAll(async () => {
      // skip   … 依頼中（第 1 段の完了記録なし）。状態の直接更新で段階を飛ばせないことを確かめる
      // contrib … 承が作業本文を自動保存し、海野が版を作って依頼する（承は本文を書いた人）
      for (const key of ['skip', 'contrib']) {
        ids[`block.${key}`] = await one(
          `insert into disclosure_blocks
             (organization_id, project_id, framework_version_id, section_key, title)
           values ($1, $2, $3, $4, $5) returning id`,
          [ORG_A, id('project'), id('framework'), `governance-${key}`, `ガバナンス（${key}）`],
        );
      }
      ids['version.skip'] = await one(
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, plain_text, content_hash, created_by)
         values ($1, $2, 1, $3::jsonb, '取締役会が監督する。', 'hash-skip-v1', $4) returning id`,
        [ORG_A, id('block.skip'), BODY, AUTHOR],
      );
      await h.asSuperuser(
        `update disclosure_blocks
            set current_version_id = $1, submitted_version_id = $1, status = 'review_requested'
          where id = $2`,
        [id('version.skip'), id('block.skip')],
      );
      ids['request.skip'] = await one(
        `insert into review_requests
           (organization_id, project_id, target_id, target_version_id, requested_by,
            reviewer_user_id, approver_user_id, policy_version, policy)
         values ($1, $2, $3, $4, $5, $6, $7, 'sod-3role-v1', '{"version": "sod-3role-v1"}'::jsonb)
         returning id`,
        [ORG_A, id('project'), id('block.skip'), id('version.skip'), AUTHOR, REVIEWER, APPROVER],
      );
    });

    it('記録なしに依頼を「レビュー完了」「承認済み」へ進められない（第 1 段を飛ばさない）', async () => {
      await expect(
        h.asUser(AUTHOR, `update review_requests set status = 'reviewed' where id = $1`, [
          id('request.skip'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      await expect(
        h.asUser(APPROVER, `update review_requests set status = 'approved' where id = $1`, [
          id('request.skip'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      // Service Role でも同じ（状態は記録に合わせてしか進まない）
      await expect(
        h.asSuperuser(`update review_requests set status = 'reviewed' where id = $1`, [
          id('request.skip'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('レビュー担当・最終承認者の指名は後から差し替えられない', async () => {
      await expect(
        h.asUser(AUTHOR, `update review_requests set approver_user_id = null where id = $1`, [
          id('request.skip'),
        ]),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
      await expect(
        h.asUser(AUTHOR, `update review_requests set reviewer_user_id = $2 where id = $1`, [
          id('request.skip'),
          ADMIN,
        ]),
      ).rejects.toThrow(/T4D_IMMUTABLE/);
    });

    it('第 1 段の完了記録が無い依頼は最終承認を記録できない（Service Role でも）', async () => {
      await expect(
        h.asUser(
          APPROVER,
          EVENT_SQL,
          eventParams('request.skip', 'approved', 'final', APPROVER, 'version.skip'),
        ),
      ).rejects.toThrow(/T4D_REVIEW_STAGE_SKIPPED/);
      await expect(
        h.asSuperuser(
          EVENT_SQL,
          eventParams('request.skip', 'approved', 'final', APPROVER, 'version.skip'),
        ),
      ).rejects.toThrow(/T4D_REVIEW_STAGE_SKIPPED/);
    });

    it('節は最終承認の記録が無い版を「承認済み」「承認待ち」にできない', async () => {
      // 承認権限だけの人が、記録の無い版を承認済みにする
      await expect(
        h.asUser(
          APPROVE_ONLY,
          `update disclosure_blocks set status = 'approved', approved_version_id = $2 where id = $1`,
          [id('block.skip'), id('version.skip')],
        ),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      // 書込と承認の両方を持つ人が、自分で版を追記して自分の版を承認済みにする
      const own = await one(
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, content_hash, created_by)
         values ($1, $2, 2, $3::jsonb, 'hash-skip-v2', $4) returning id`,
        [ORG_A, id('block.skip'), OTHER_BODY, APPROVER],
      );
      await expect(
        h.asUser(
          APPROVER,
          `update disclosure_blocks
              set current_version_id = $2, approved_version_id = $2, status = 'approved'
            where id = $1`,
          [id('block.skip'), own],
        ),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
      // 書込権限者が、レビュー完了の記録なしに「承認待ち」へ進める
      await expect(
        h.asUser(AUTHOR, `update disclosure_blocks set status = 'approval_pending' where id = $1`, [
          id('block.skip'),
        ]),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('節は下書き・版なしでしか作成できない（承認済みの節をいきなり作らない）', async () => {
      await expect(
        h.asUser(
          APPROVER,
          `insert into disclosure_blocks
             (organization_id, project_id, framework_version_id, section_key, title, status)
           values ($1, $2, $3, 'forged', '偽の承認済み', 'approved')`,
          [ORG_A, id('project'), id('framework')],
        ),
      ).rejects.toThrow(/T4D_TRANSITION_FORBIDDEN/);
    });

    it('作業本文を自動保存した人は、別の人が版にして依頼しても、その版をレビュー・承認できない', async () => {
      // 承が作業本文を自動保存する（書いた人として記録される）
      await h.asUser(
        APPROVER,
        `update disclosure_blocks set working_body = $2::jsonb where id = $1`,
        [id('block.contrib'), OTHER_BODY],
      );
      const [after] = await h.asSuperuser<{
        working_updated_by: string;
        working_contributor_ids: string[];
      }>(
        'select working_updated_by, working_contributor_ids from disclosure_blocks where id = $1',
        [id('block.contrib')],
      );
      expect(after?.working_updated_by).toBe(APPROVER);
      expect(after?.working_contributor_ids).toEqual([APPROVER]);
      // 海野が作業本文を残したまま、書いた人の記録だけを消そうとしても消えない
      await h.asUser(
        AUTHOR,
        `update disclosure_blocks set working_contributor_ids = '{}', working_body = $2::jsonb where id = $1`,
        [id('block.contrib'), BODY],
      );
      const [kept] = await h.asSuperuser<{ working_contributor_ids: string[] }>(
        'select working_contributor_ids from disclosure_blocks where id = $1',
        [id('block.contrib')],
      );
      expect([...(kept?.working_contributor_ids ?? [])].sort()).toEqual([APPROVER, AUTHOR].sort());

      // 海野が版を作る。版には作業本文を書いた承が残る（アプリが渡さなくても DB が補う）
      const version = await one(
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, content_hash, created_by)
         values ($1, $2, 1, $3::jsonb, 'hash-contrib-v1', $4) returning id`,
        [ORG_A, id('block.contrib'), OTHER_BODY, AUTHOR],
      );
      const [v] = await h.asSuperuser<{ contributor_user_ids: string[] }>(
        'select contributor_user_ids from disclosure_block_versions where id = $1',
        [version],
      );
      expect(v?.contributor_user_ids).toEqual([APPROVER]);
      ids['version.contrib'] = version;
      await h.asSuperuser(
        `update disclosure_blocks
            set current_version_id = $1, submitted_version_id = $1, status = 'review_requested',
                working_body = null, working_contributor_ids = '{}'
          where id = $2`,
        [version, id('block.contrib')],
      );
      ids['request.contrib'] = await one(
        `insert into review_requests
           (organization_id, project_id, target_id, target_version_id, requested_by,
            policy_version, policy)
         values ($1, $2, $3, $4, $5, 'sod-3role-v1', '{"version": "sod-3role-v1"}'::jsonb)
         returning id`,
        [ORG_A, id('project'), id('block.contrib'), version, AUTHOR],
      );
      // 承はこの版のレビュー完了も最終承認もできない
      await expect(
        h.asUser(
          APPROVER,
          EVENT_SQL,
          eventParams('request.contrib', 'review_completed', 'review', APPROVER, 'version.contrib'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
      const reviewed = await h.asUser(
        REVIEWER,
        EVENT_SQL,
        eventParams('request.contrib', 'review_completed', 'review', REVIEWER, 'version.contrib', {
          key: `${id('request.contrib')}:review:${id('version.contrib')}`,
        }),
      );
      expect(reviewed).toHaveLength(1);
      await expect(
        h.asUser(
          APPROVER,
          EVENT_SQL,
          eventParams('request.contrib', 'approved', 'final', APPROVER, 'version.contrib'),
        ),
      ).rejects.toThrow(/T4D_SOD/);
    });

    it('スナップショットは DB の版・数値・資料と一致しない内容を保存できない', async () => {
      // 版の本文をすり替えた草稿
      const forgedBody = JSON.stringify([
        {
          blockId: id('block.skip'),
          versionId: id('version.skip'),
          body: JSON.parse(OTHER_BODY) as unknown,
          contentHash: 'hash-skip-v1',
          versionCreatedBy: AUTHOR,
        },
      ]);
      await expect(
        h.asUser(
          AUTHOR,
          `insert into report_snapshots
             (organization_id, project_id, snapshot_kind, snapshot_no, blocks, content_hash, created_by)
           values ($1, $2, 'review_draft', 90, $3::jsonb, 'x', $4)`,
          [ORG_A, id('project'), forgedBody, AUTHOR],
        ),
      ).rejects.toThrow(/T4D_SNAPSHOT_MISMATCH/);
      // 値を書き換えた数値
      const [dpv] = await h.asSuperuser<{ id: string; data_point_id: string; unit: string }>(
        `select id, data_point_id, unit_of_measure as unit from data_point_versions
          where organization_id = $1 and value is not null order by id limit 1`,
        [ORG_A],
      );
      await expect(
        h.asUser(
          AUTHOR,
          `insert into report_snapshots
             (organization_id, project_id, snapshot_kind, snapshot_no, metric_values, content_hash, created_by)
           values ($1, $2, 'review_draft', 91, $3::jsonb, 'x', $4)`,
          [
            ORG_A,
            id('project'),
            JSON.stringify([
              {
                dataPointId: dpv!.data_point_id,
                dataPointVersionId: dpv!.id,
                value: 0.000123,
                textValue: null,
                unitOfMeasure: dpv!.unit,
                versionApproved: false,
              },
            ]),
            AUTHOR,
          ],
        ),
      ).rejects.toThrow(/T4D_SNAPSHOT_MISMATCH/);
      // 機密の資料を「公開」と偽る（対外出力でファイル名を出させる）
      const [anchor] = await h.asSuperuser<{
        id: string;
        file_version_id: string;
        quote_text: string;
        original_name: string;
      }>(
        `select a.id, a.file_version_id, a.quote_text, f.original_name
           from source_anchors a join file_versions fv on fv.id = a.file_version_id
           join files f on f.id = fv.file_id
          where a.organization_id = $1 and f.confidentiality <> 'public' order by a.id limit 1`,
        [ORG_A],
      );
      await expect(
        h.asUser(
          AUTHOR,
          `insert into report_snapshots
             (organization_id, project_id, snapshot_kind, snapshot_no, anchors, content_hash, created_by)
           values ($1, $2, 'review_draft', 92, $3::jsonb, 'x', $4)`,
          [
            ORG_A,
            id('project'),
            JSON.stringify([
              {
                sourceAnchorId: anchor!.id,
                fileVersionId: anchor!.file_version_id,
                quoteText: anchor!.quote_text,
                fileName: anchor!.original_name,
                confidentiality: 'public',
              },
            ]),
            AUTHOR,
          ],
        ),
      ).rejects.toThrow(/T4D_SNAPSHOT_MISMATCH/);
      // 最終承認の記録が無い節を「社内承認済み版」に含める
      const forgedApproved = JSON.stringify([
        {
          blockId: id('block.skip'),
          versionId: id('version.skip'),
          body: JSON.parse(BODY) as unknown,
          contentHash: 'hash-skip-v1',
          versionCreatedBy: AUTHOR,
          isApprovedVersion: true,
        },
      ]);
      await expect(
        h.asUser(
          APPROVER,
          `insert into report_snapshots
             (organization_id, project_id, snapshot_kind, snapshot_no, blocks, content_hash, created_by)
           values ($1, $2, 'approved', 90, $3::jsonb, 'x', $4)`,
          [ORG_A, id('project'), forgedApproved, APPROVER],
        ),
      ).rejects.toThrow(/T4D_SNAPSHOT_MISMATCH/);
    });

    it('確定版は全節が最終承認の記録のある版で、指定の最終承認者だけが作れる（空振りでない確認つき）', async () => {
      const project = DISCLOSURE_FIRST_IDS.projects.fy2025;
      const insertApproved = (actor: string, no: number, extraWhere = '') =>
        h.asUser(
          actor,
          `insert into report_snapshots
             (organization_id, project_id, snapshot_kind, snapshot_no, blocks, content_hash, created_by)
           select $1, $2, 'approved', $4, jsonb_agg(jsonb_build_object(
                    'blockId', b.id, 'versionId', v.id, 'body', v.body,
                    'contentHash', v.content_hash, 'versionCreatedBy', v.created_by,
                    'isApprovedVersion', true)), 'x', $3
             from disclosure_blocks b
             join disclosure_block_versions v on v.id = b.approved_version_id
            where b.project_id = $2 ${extraWhere}
           returning id`,
          [ORG_A, project, actor, no],
        );
      // 一部の節だけの確定版は作れない
      await expect(
        insertApproved(APPROVER, 90, `and b.section_key = 'governance'`),
      ).rejects.toThrow(/T4D_SNAPSHOT_INCOMPLETE/);
      // 指定の最終承認者（承）以外の承認権限者は作れない
      await expect(insertApproved(APPROVE_ONLY, 91)).rejects.toThrow(/T4D_SOD/);
      // 指定の最終承認者は、DB と一致する内容で作れる
      const rows = await insertApproved(APPROVER, 92);
      expect(rows).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // 本人名義・テナント整合（親と子の organization_id）
  // ------------------------------------------------------------------

  describe('本人名義とテナント整合', () => {
    it('自組織の書込権限者は本人名義で版を追記できるが、他人の名義では追記できない', async () => {
      const own = await h.asUser(
        AUTHOR,
        `insert into disclosure_block_versions
           (organization_id, block_id, version_no, body, content_hash, created_by)
         values ($1, $2, 2, $3::jsonb, 'hash-main-v2', $4) returning id`,
        [ORG_A, id('block.main'), BODY, AUTHOR],
      );
      expect(own).toHaveLength(1);
      await expect(
        h.asUser(
          AUTHOR,
          `insert into disclosure_block_versions
             (organization_id, block_id, version_no, body, content_hash, created_by)
           values ($1, $2, 3, $3::jsonb, 'hash-main-v3', $4)`,
          [ORG_A, id('block.main'), BODY, REVIEWER],
        ),
      ).rejects.toThrow(RLS_ERROR);
    });

    it('子の organization_id は親と一致しなければならない（Service Role でも）', async () => {
      await expect(
        h.asSuperuser(
          `insert into disclosure_blocks (organization_id, project_id, framework_version_id, section_key, title)
           values ($1, $2, $3, 'metrics', '他社の名義')`,
          [ORG_IDS.soten, id('project'), id('framework')],
        ),
      ).rejects.toThrow(/foreign key/);
      await expect(
        h.asSuperuser(
          `insert into narrative_versions
             (organization_id, narrative_record_id, version_no, reporting_period_id, body, content_hash)
           values ($1, $2, 9, $3, '他社の名義', 'hash-x')`,
          [ORG_IDS.soten, id('narrative'), PERIOD_IDS.fy2026],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('節の基準はプロジェクトが扱うと決めた版に限る', async () => {
      const [other] = await h.asSuperuser<{ id: string }>(
        `select v.id from disclosure_framework_versions v
           join disclosure_frameworks f on f.id = v.framework_id
          where f.key = 'cdp' limit 1`,
      );
      await expect(
        h.asSuperuser(
          `insert into disclosure_blocks (organization_id, project_id, framework_version_id, section_key, title)
           values ($1, $2, $3, 'cdp', '未登録の基準')`,
          [ORG_A, id('project'), other!.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('「未判定」を適用判断として確定することはできない', async () => {
      await expect(
        h.asUser(
          AUTHOR,
          `insert into project_framework_decisions
             (organization_id, project_framework_id, decision_no, applicability_status, reason,
              rule_ref, confirmed_on, decided_by)
           values ($1, $2, 2, 'not_assessed', '未判定', '規則', '2026-08-01', $3)`,
          [ORG_A, id('projectFramework'), AUTHOR],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('監査ログに開示業務の種類を記録できる（0040）', async () => {
      // 海野は common.audit.read を持たず自分の記録を読み返せないため、RETURNING は付けない
      await h.asUser(
        AUTHOR,
        `insert into audit_events (actor_user_id, actor_organization_id, event_type, resource_type, resource_id)
         values ($1, $2, 'review_approved', 'review_request', $3)`,
        [AUTHOR, ORG_A, id('request.main')],
      );
      const rows = await h.asSuperuser<{ count: string }>(
        `select count(*)::text as count from audit_events
          where event_type = 'review_approved' and resource_id = $1`,
        [id('request.main')],
      );
      expect(rows[0]?.count).toBe('1');
      await expect(
        h.asUser(
          AUTHOR,
          `insert into audit_events (actor_user_id, actor_organization_id, event_type)
           values ($1, $2, 'unknown_event')`,
          [AUTHOR, ORG_A],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });
});

/** 検証用の AI 実行を 1 件作る（seed には無いため） */
async function seedAiRun(): Promise<string> {
  const [row] = await h.asSuperuser<{ id: string }>(
    `insert into ai_runs
       (id, organization_id, feature_type, provider, model, prompt_version,
        input_reference_ids, output_json, source_references, confidence, warnings,
        latency_ms, token_usage, estimated_cost_usd, status, created_at)
     values (gen_random_uuid(), '${ORG_IDS.aomi}', 'cdpDraftGeneration', 'mock', 'mock-1', 'v1',
             '{}', '{}'::jsonb, '[]'::jsonb, 0.8, '{}', 10,
             '{"input":0,"output":0,"total":0}'::jsonb, 0, 'succeeded', now())
     returning id`,
  );
  return row!.id;
}
