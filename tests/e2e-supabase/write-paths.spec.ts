import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../../scripts/local-supabase-env';
import { LOCAL_DEMO_PASSWORD } from '../../src/lib/fixtures/to-sql';

/**
 * Supabase Mode の書き込み経路。
 *
 * RLS では **INSERT が通っても、RETURNING は SELECT ポリシーで弾かれる**。
 * リポジトリが `.insert(...).select('*')` を呼んでいると、
 * 「自分では読み返せない行」を書く操作がすべて 500 になる。
 * 該当するのは次の 2 つで、いずれも日常操作で踏む。
 *
 *  - notifications … SELECT は user_id = auth.uid()。他人宛のメンション通知が書けない
 *  - audit_events  … SELECT は common.audit.read が必要。この権限を持たない 10/15 ロールが
 *                    監査対象の操作（値の編集など）を一切できない
 */

const { url, serviceRoleKey } = localSupabaseEnv();

async function login(page: import('@playwright/test').Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(LOCAL_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/workspace|\/enterprise|\/assurance/);
  if (new URL(page.url()).pathname === '/workspace') {
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL(/\/(enterprise|assurance)\//);
  }
}

/** service role で DB を直接読む（検証専用。アプリはこの経路を使わない） */
function admin() {
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

test('common.audit.read を持たないロールでも値を編集できる（監査ログの書き込みで失敗しない）', async ({
  page,
}) => {
  const db = admin();
  // 拠点担当は担当拠点のデータしか編集できない（assertUnitInScope）。
  // 担当外を選ぶと権限エラーになり、確かめたい監査ログの経路まで届かない。
  const { data: profile } = await db
    .from('profiles')
    .select('id')
    .eq('email', 'site-user@demo.local')
    .single();
  const { data: membership } = await db
    .from('organization_memberships')
    .select('unit_scope_ids')
    .eq('user_id', profile!.id)
    .single();
  const scope = (membership!.unit_scope_ids ?? []) as string[];
  expect(scope.length, '拠点担当に担当拠点が設定されている').toBeGreaterThan(0);

  const { data: dp } = await db
    .from('data_points')
    .select('id, value, unit_id')
    .eq('status', 'draft')
    .in('unit_id', scope)
    .limit(1)
    .single();
  expect(dp, '担当拠点に draft の Data Point が seed に必要').toBeTruthy();

  // 拠点担当（site_contributor）は common.audit.read を持たない
  await login(page, 'site-user@demo.local');
  await page.goto(`/enterprise/data/${dp!.id}`);

  const form = page.locator('form').filter({ has: page.locator('input[name="value"]') });
  const visible = await form.count();
  if (visible === 0) {
    test.skip(true, 'この Data Point は拠点担当の担当範囲外');
  }

  const next = String(Number(dp!.value) + 1.5);
  const reason = form.locator('[name="changeReason"]');
  await reason.fill('回帰テスト: 監査ログ書き込みの確認');
  await form.locator('input[name="value"]').fill(next);
  // 変更理由は必須。入っていないとブラウザ側の検証で送信されず、
  // 「保存できていないのに画面はそのまま」になって原因を見誤る。
  await expect(reason).not.toHaveValue('');
  await form.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  // エラー境界（内部エラーの露出）に落ちていないこと
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  await expect(page.locator('#t4d-main')).not.toContainText('row-level security');

  const { data: after } = await db.from('data_points').select('value').eq('id', dp!.id).single();
  expect(Number(after!.value), 'DB へ反映されている').toBeCloseTo(Number(next), 5);

  const { data: events } = await db
    .from('audit_events')
    .select('id')
    .eq('resource_id', dp!.id)
    .eq('event_type', 'data_updated');
  expect((events ?? []).length, '監査ログが残っている').toBeGreaterThan(0);
});

test('メンション付きコメントで、相手に通知が届く', async ({ page }) => {
  const db = admin();
  const { data: dp } = await db
    .from('data_points')
    .select('id')
    .eq('status', 'draft')
    .limit(1)
    .single();

  await login(page, 'enterprise-admin@demo.local');
  await page.goto(`/enterprise/data/${dp!.id}`);

  const marker = `回帰テスト-メンション-${process.env.E2E_SUPABASE_PORT ?? '3200'}`;
  await page.locator('textarea[name="body"]').fill(`@東一郎 ${marker}`);
  await page.getByRole('button', { name: 'コメントする' }).click();

  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  await expect(page.locator('#t4d-main')).toContainText(marker);

  const { data: profile } = await db
    .from('profiles')
    .select('id')
    .eq('email', 'site-user@demo.local')
    .single();
  const { data: notes } = await db
    .from('notifications')
    .select('id, title')
    .eq('user_id', profile!.id);
  expect((notes ?? []).length, 'メンションされた本人へ通知が作られている').toBeGreaterThan(0);
});

test('監査法人は許諾された Evidence の Signed URL を取得できる', async ({ page }) => {
  // Storage の RLS は「パスに含まれる組織のメンバーか」しか見ない。
  // 監査法人はクライアント組織のメンバーではないため、自分の JWT では署名を発行できず、
  // 許諾があっても Evidence を開けなかった。
  //
  // Supabase Storage は「権限が無い」ときも「実体が無い」ときも Object not found を返す。
  // 区別するために、**実体を置いてから**発行を試す。実体があるのに開けなければ権限の問題。
  const db = admin();

  const { data: engagement } = await db.from('engagements').select('id').limit(1).single();
  const { data: items } = await db
    .from('data_room_items')
    .select('source_id')
    .eq('engagement_id', engagement!.id)
    .is('withdrawn_at', null);
  const sourceIds = (items ?? []).map((i) => i.source_id as string);
  expect(sourceIds.length, 'Data Room に共有された Data Point が seed に必要').toBeGreaterThan(0);

  const { data: links } = await db
    .from('evidence_links')
    .select('file_version_id')
    .eq('target_type', 'data_point')
    .in('target_id', sourceIds)
    .limit(1);
  expect((links ?? []).length, 'Evidence が紐づいた行が seed に必要').toBeGreaterThan(0);
  const fileVersionId = links![0]!.file_version_id as string;

  const { data: version } = await db
    .from('file_versions')
    .select('storage_key, file_id')
    .eq('id', fileVersionId)
    .single();
  const { data: file } = await db
    .from('files')
    .select('bucket')
    .eq('id', version!.file_id as string)
    .single();

  // Fixture のファイルは実体を持たないので、検証用に置く（service role）
  const upload = await db.storage
    .from(file!.bucket as string)
    .upload(version!.storage_key as string, new Blob([new Uint8Array([37, 80, 68, 70])]), {
      contentType: 'application/pdf',
      upsert: true,
    });
  expect(upload.error, `検証用ファイルを置けない: ${upload.error?.message}`).toBeNull();

  await login(page, 'assurance-manager@demo.local');
  const res = await page.request.get(
    `/api/files/signed-url?fileVersionId=${fileVersionId}&engagementId=${engagement!.id}`,
    { maxRedirects: 0 },
  );
  const body = res.status() >= 400 ? await res.text() : '';
  expect([302, 307], `Evidence を開けない (status=${res.status()} body=${body})`).toContain(
    res.status(),
  );
});
