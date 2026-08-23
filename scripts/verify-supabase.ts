/**
 * 実 Supabase（Auth + Postgres + RLS + Storage）に対する通し検証。
 *
 *   supabase start && supabase db reset
 *   pnpm verify:supabase
 *
 * PGlite のテスト（pnpm test:rls）は SQL レベルの検証。
 * こちらは **本物の Supabase Auth でログインし、発行された JWT で PostgREST を叩いて**
 * RLS が期待どおり効くことを確認する（アプリと同じ経路）。
 *
 * 安全装置: リモート（*.supabase.co）に対しては実行しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  ENGAGEMENT_IDS,
  ORG_IDS,
  dataPointId,
  metricId,
  userId,
} from '../src/lib/fixtures/dataset';
import { LOCAL_DEMO_PASSWORD } from '../src/lib/fixtures/to-sql';
import { localSupabaseEnv } from './local-supabase-env';

// 接続情報は環境変数があればそれを、無ければ `supabase status` から読む。
// キーの形をした文字列をリポジトリへ置かないための共通処理（scripts/local-supabase-env.ts）。
let url = '';
let publishableKey = '';
try {
  const env = localSupabaseEnv();
  url = env.url;
  publishableKey = env.publishableKey;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (/\.supabase\.(co|in)/.test(url) && !process.env.ALLOW_REMOTE_VERIFY) {
  console.error(
    'リモート Supabase への検証はブロックされました。ローカル（supabase start）で実行してください。',
  );
  process.exit(1);
}

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: LOCAL_DEMO_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`${email} でログインできませんでした: ${error?.message ?? 'session なし'}`);
  }
  if (data.user.id !== userId(email)) {
    throw new Error(`${email} の user id が Fixture と一致しません（${data.user.id}）`);
  }
  return client;
}

async function main() {
  console.log(`検証対象: ${url}\n`);

  // ------------------------------------------------------------------
  console.log('1. Supabase Auth でのログイン');
  const entAdmin = await signIn('enterprise-admin@demo.local');
  const siteUser = await signIn('site-user@demo.local');
  const approver = await signIn('approver@demo.local');
  const firmManager = await signIn('assurance-manager@demo.local');
  const firmAdmin = await signIn('assurance-admin@demo.local'); // 未アサイン
  const otherEnt = await signIn('other-enterprise-admin@demo.local');
  const otherFirm = await signIn('other-assurance-manager@demo.local');
  check('7 アカウントすべてでログインできる', true);

  // この検証は Sign-off と許諾を **実際に書き込む**。追記専用のため後から消せず、
  // 同じ DB で 2 回目を走らせると重複キーで落ちる。そのとき「RLS が壊れた」と
  // 誤読されるのが最も危険なので、先に汚れを検知し、理由を説明して止める。
  const dirtyGrant = await entAdmin
    .from('client_access_grants')
    .select('id')
    .eq('engagement_id', ENGAGEMENT_IDS.main)
    .eq('subject_type', 'metric')
    .eq('subject_id', metricId('AOMI', 'managers_total'));
  const dirtySignoff = await firmManager
    .from('signoffs')
    .select('id')
    .eq('engagement_id', ENGAGEMENT_IDS.main)
    .eq('signoff_stage', 'prepared')
    .eq('user_id', userId('assurance-manager@demo.local'));
  if ((dirtyGrant.data?.length ?? 0) > 0 || (dirtySignoff.data?.length ?? 0) > 0) {
    console.error('');
    console.error('この DB では既に本スクリプトを実行済みです（Sign-off / 許諾が残っています）。');
    console.error(
      'Sign-off と許諾は追記専用で削除できないため、クリーンな DB からやり直してください。',
    );
    console.error('  pnpm exec supabase db reset && pnpm verify:supabase');
    console.error('※ RLS の異常ではありません。');
    process.exit(2);
  }

  // ------------------------------------------------------------------
  console.log('\n2. テナント分離（企業 A ⇔ 企業 B）');
  {
    const own = await entAdmin.from('data_points').select('id').eq('organization_id', ORG_IDS.aomi);
    check(
      '企業 A は自社の Data Point を取得できる',
      (own.data?.length ?? 0) > 50,
      own.error?.message,
    );

    const other = await entAdmin
      .from('data_points')
      .select('id')
      .eq('organization_id', ORG_IDS.soten);
    check('企業 A から企業 B の Data Point は 0 件', (other.data?.length ?? 0) === 0);

    const reverse = await otherEnt
      .from('metric_definitions')
      .select('id')
      .eq('organization_id', ORG_IDS.aomi);
    check('企業 B から企業 A の指標定義は 0 件', (reverse.data?.length ?? 0) === 0);
  }

  // ------------------------------------------------------------------
  console.log('\n3. 監査法人のアクセス（Engagement Member + Grant）');
  {
    const engagement = await firmManager
      .from('engagements')
      .select('id')
      .eq('id', ENGAGEMENT_IDS.main);
    check('アサイン済みマネージャーは案件を取得できる', (engagement.data?.length ?? 0) === 1);

    const unassigned = await firmAdmin
      .from('engagements')
      .select('id')
      .eq('id', ENGAGEMENT_IDS.main);
    check('未アサインの法人管理者は案件を取得できない', (unassigned.data?.length ?? 0) === 0);

    const crossFirm = await otherFirm
      .from('engagements')
      .select('id')
      .eq('id', ENGAGEMENT_IDS.main);
    check('別法人は案件を取得できない', (crossFirm.data?.length ?? 0) === 0);

    const granted = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('HQ', 'scope1', 'FY2026'));
    check('許諾済みの Data Point は取得できる', (granted.data?.length ?? 0) === 1);

    const ungrantedUnit = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('EU', 'scope1', 'FY2026'));
    check('組織が許諾外の Data Point は取得できない', (ungrantedUnit.data?.length ?? 0) === 0);

    const ungrantedMetric = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('HQ', 'managers_total', 'FY2026'));
    check('指標が許諾外の Data Point は取得できない', (ungrantedMetric.data?.length ?? 0) === 0);

    const unapproved = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('EAST', 'waste', 'FY2026'));
    check('未承認の Data Point は許諾内でも取得できない', (unapproved.data?.length ?? 0) === 0);

    const firmAdminData = await firmAdmin.from('data_points').select('id');
    check(
      '未アサインの法人管理者はクライアントデータを 1 件も取得できない',
      (firmAdminData.data?.length ?? 0) === 0,
    );
  }

  // ------------------------------------------------------------------
  console.log('\n4. Read-only by Default（監査法人は企業原本を更新できない）');
  {
    const target = dataPointId('HQ', 'scope1', 'FY2026');
    const update = await firmManager
      .from('data_points')
      .update({ value: 99999 })
      .eq('id', target)
      .select('id');
    check('監査法人からの UPDATE は 1 行も更新しない', (update.data?.length ?? 0) === 0);

    const after = await entAdmin.from('data_points').select('value').eq('id', target).single();
    check('値が書き換わっていない', Number(after.data?.value) !== 99999);
  }

  // ------------------------------------------------------------------
  console.log('\n5. Unit スコープ（拠点担当は担当外を更新できない）');
  {
    const east = dataPointId('EAST', 'water', 'FY2026');
    const west = dataPointId('WEST', 'water', 'FY2026');

    const ownUnit = await siteUser
      .from('data_points')
      .update({ methodology: '実測値の集計（検証）' })
      .eq('id', east)
      .select('id');
    check('担当拠点は更新できる', (ownUnit.data?.length ?? 0) === 1, ownUnit.error?.message);

    const otherUnit = await siteUser
      .from('data_points')
      .update({ methodology: 'tampered' })
      .eq('id', west)
      .select('id');
    check('担当外拠点は更新できない', (otherUnit.data?.length ?? 0) === 0);
  }

  // ------------------------------------------------------------------
  console.log('\n6. 承認権限と状態遷移トリガ');
  {
    const target = dataPointId('WEST', 'waste', 'FY2026'); // submitted
    const bySiteUser = await siteUser
      .from('data_points')
      .update({ status: 'approved', approved_by: userId('site-user@demo.local') })
      .eq('id', target)
      .select('id');
    check(
      '拠点担当は承認できない',
      (bySiteUser.data?.length ?? 0) === 0 || Boolean(bySiteUser.error),
    );

    const byApprover = await approver
      .from('data_points')
      .update({
        status: 'approved',
        approved_by: userId('approver@demo.local'),
        approved_at: new Date().toISOString(),
      })
      .eq('id', target)
      .select('id');
    check('承認者は承認できる', (byApprover.data?.length ?? 0) === 1, byApprover.error?.message);
  }

  // ------------------------------------------------------------------
  console.log('\n7. Immutability（Snapshot / Audit Event / Sign-off）');
  {
    const snapshot = await firmManager
      .from('assurance_snapshots')
      .update({ label: 'tampered' })
      .eq('engagement_id', ENGAGEMENT_IDS.main)
      .select('id');
    check('Snapshot は更新されない', (snapshot.data?.length ?? 0) === 0);

    const audit = await entAdmin
      .from('audit_events')
      .update({ event_type: 'logout' })
      .eq('actor_organization_id', ORG_IDS.aomi)
      .select('id');
    check('Audit Event は更新されない', (audit.data?.length ?? 0) === 0);

    const del = await entAdmin
      .from('audit_events')
      .delete()
      .eq('actor_organization_id', ORG_IDS.aomi);
    check('Audit Event は削除できない（権限なし）', Boolean(del.error));
  }

  // ------------------------------------------------------------------
  console.log('\n8. 代理 Sign-off の禁止');
  {
    const proxy = await firmManager.from('signoffs').insert({
      engagement_id: ENGAGEMENT_IDS.main,
      assurance_firm_id: ORG_IDS.aoba,
      signoff_stage: 'prepared',
      user_id: userId('assurance-staff@demo.local'),
      role_key: 'assurance_staff',
    });
    check('他人名義の Sign-off は拒否される', Boolean(proxy.error));

    const own = await firmManager.from('signoffs').insert({
      engagement_id: ENGAGEMENT_IDS.main,
      assurance_firm_id: ORG_IDS.aoba,
      signoff_stage: 'prepared',
      user_id: userId('assurance-manager@demo.local'),
      role_key: 'assurance_manager',
    });
    check('本人名義の Sign-off は登録できる', !own.error, own.error?.message);
  }

  // ------------------------------------------------------------------
  console.log('\n9. 内部情報の非対称性');
  {
    const notes = await entAdmin
      .from('review_notes')
      .select('shared_with_client')
      .eq('engagement_id', ENGAGEMENT_IDS.main);
    check(
      '企業側は共有フラグの立った Review Note のみ閲覧できる',
      (notes.data?.length ?? 0) === 1 && notes.data?.[0]?.shared_with_client === true,
    );

    const pbc = await entAdmin.from('pbc_requests').select('code');
    const codes = (pbc.data ?? []).map((r) => r.code);
    check('企業側から draft の PBC は見えない', !codes.includes('PBC-005'));
    check('企業側から送付済みの PBC は見える', codes.includes('PBC-001'));
  }

  // ------------------------------------------------------------------
  console.log('\n10. 許諾の付与主体と即時反映');
  {
    const byFirm = await firmManager.from('client_access_grants').insert({
      engagement_id: ENGAGEMENT_IDS.main,
      client_organization_id: ORG_IDS.aomi,
      assurance_firm_id: ORG_IDS.aoba,
      subject_type: 'metric',
      subject_id: metricId('AOMI', 'managers_total'),
      granted_by: userId('assurance-manager@demo.local'),
    });
    check('監査法人は自分に許諾を追加できない', Boolean(byFirm.error));

    const before = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('HQ', 'managers_total', 'FY2026'));
    check('付与前は不可視', (before.data?.length ?? 0) === 0);

    const byClient = await entAdmin.from('client_access_grants').insert({
      engagement_id: ENGAGEMENT_IDS.main,
      client_organization_id: ORG_IDS.aomi,
      assurance_firm_id: ORG_IDS.aoba,
      subject_type: 'metric',
      subject_id: metricId('AOMI', 'managers_total'),
      granted_by: userId('enterprise-admin@demo.local'),
    });
    check('企業管理者は許諾を追加できる', !byClient.error, byClient.error?.message);

    const after = await firmManager
      .from('data_points')
      .select('id')
      .eq('id', dataPointId('HQ', 'managers_total', 'FY2026'));
    check('付与直後から可視になる', (after.data?.length ?? 0) === 1);
  }

  // ------------------------------------------------------------------
  console.log('\n11. Storage（Evidence Bucket が Private）');
  {
    const buckets = await entAdmin.storage.listBuckets();
    const evidence = buckets.data?.find((b) => b.id === 'evidence-private');
    const brand = buckets.data?.find((b) => b.id === 'brand-public');
    check('evidence-private バケットが存在する', Boolean(evidence));
    check('evidence-private は public ではない', evidence?.public === false);
    check('brand-public は public', brand?.public === true);
  }

  console.log(`\n${checks - failures} / ${checks} の検証に成功しました。`);
  if (failures > 0) {
    console.error(`✗ ${failures} 件の検証に失敗しました。`);
    process.exit(1);
  }
  console.log('✓ 実 Supabase に対する通し検証に合格しました。');
}

main().catch((error) => {
  console.error('検証に失敗しました:', error);
  process.exit(1);
});
