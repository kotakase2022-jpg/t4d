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
