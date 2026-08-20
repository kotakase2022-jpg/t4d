import { expect, test, type Page } from '@playwright/test';
import { LOCAL_DEMO_PASSWORD } from '@/lib/fixtures/to-sql';

/**
 * AUTH-P0-001: パスワード再設定（リンク発行方式・メール送信なし）と MFA（TOTP）。
 * 実 Supabase Auth（GoTrue）に対する通し検証。
 * クロール系（supabase-mode.spec.ts）と分離し、認証状態の変更が他テストへ波及しないようにする。
 */

test.describe.configure({ mode: 'serial' });

async function login(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByText('Supabase Auth')).toBeVisible();
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(LOCAL_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL('**/workspace');
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/(enterprise|assurance)\//);
}

// ---------------------------------------------------------------------------
// AUTH-P0-001: パスワード再設定（リンク発行方式・メール送信なし）と MFA（TOTP）
// 実 Supabase Auth（GoTrue）に対する通し検証。
// ---------------------------------------------------------------------------

// ローカルスタックの既定値（Supabase CLI が `supabase start` で必ず生成する固定値）。
// 本番のキーではない。本番キーをここへ書かないこと。
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

/** テスト後始末用: Admin API でパスワードを既定値へ戻す（実メール送信は行わない） */
async function adminResetPassword(email: string, password: string): Promise<void> {
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=100`, {
    headers,
  });
  const listBody = (await listRes.json()) as { users?: Array<{ id: string; email: string }> };
  const user = listBody.users?.find((u) => u.email === email);
  if (!user) throw new Error(`テストユーザーが見つかりません: ${email}`);
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ password }),
  });
}

test('パスワード再設定: 管理者がリンクを発行し、本人が新パスワードを設定して再ログインできる', async ({
  page,
  context,
}) => {
  const TARGET = 'sustainability@demo.local';
  const NEW_PASSWORD = 'T4D-new-pass-e2e!1';
  try {
    // 1) 管理者が設定画面から再設定リンクを発行
    await login(page, 'enterprise-admin@demo.local');
    await page.goto('/enterprise/settings');
    await expect(page.getByText('リンク発行方式（メール送信なし）')).toBeVisible();
    await page
      .locator('form', { has: page.getByRole('button', { name: '再設定リンクを発行' }) })
      .locator('input[name="email"]')
      .fill(TARGET);
    await page.getByRole('button', { name: '再設定リンクを発行' }).click();
    await expect(page.getByText('再設定リンクを発行しました')).toBeVisible();

    // 2) リンクは URL でなく一時 Cookie（t4d.reset-link）で受け渡される
    const cookies = await context.cookies();
    const linkCookie = cookies.find((c) => c.name === 't4d.reset-link');
    expect(linkCookie).toBeDefined();
    const actionLink = decodeURIComponent(linkCookie!.value);
    expect(actionLink).toContain('/auth/v1/verify');

    // 3) 本人（別セッション）がリンクを開き、新しいパスワードを設定
    await context.clearCookies();
    await page.goto(actionLink);
    await page.waitForURL(/\/reset/);
    await expect(page.getByRole('heading', { name: 'パスワードの再設定' })).toBeVisible();
    await page.locator('input[name="password"]').fill(NEW_PASSWORD);
    await page.locator('input[name="confirm"]').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'パスワードを更新する' }).click();
    await page.waitForURL(/\/login\?reset=done/);

    // 4) 旧パスワードでは入れない
    await page.getByLabel('メールアドレス').fill(TARGET);
    await page.getByLabel('パスワード').fill(LOCAL_DEMO_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page).toHaveURL(/\/login/);

    // 5) 新パスワードでログインできる
    await page.getByLabel('メールアドレス').fill(TARGET);
    await page.getByLabel('パスワード').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL('**/workspace');
  } finally {
    await adminResetPassword(TARGET, LOCAL_DEMO_PASSWORD);
  }
});

test('MFA: 登録 → 再ログインでコード必須 → AAL1 のままでは入れない → 検証後に入れる', async ({
  page,
  context,
}) => {
  const { freshTotpCode, totpCode } = await import('@tests/support/totp');
  const EMAIL = 'enterprise-admin@demo.local';

  // 1) 設定画面で TOTP を登録（シークレット表示 → コード検証）
  await login(page, EMAIL);
  await page.goto('/enterprise/settings');
  await page.getByRole('button', { name: 'MFA（Authenticator）を登録する' }).click();
  const secretEl = page.locator('code.font-mono').first();
  await expect(secretEl).toBeVisible();
  const secret = (await secretEl.textContent())!.trim();
  expect(secret.length).toBeGreaterThanOrEqual(16);

  await page.locator('input[name="code"]').fill(await freshTotpCode(secret));
  await page.getByRole('button', { name: '有効化する' }).click();
  await expect(page.getByText('MFA 有効')).toBeVisible();

  // 2) ログアウトしてパスワードだけでログイン → MFA チャレンジへ誘導される
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(LOCAL_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/mfa/);
  await expect(page.getByText('2 段階認証（MFA）')).toBeVisible();

  // 3) AAL1 のまま URL 直打ちしてもワークスペースへは入れない（session.ts が弾く）
  await page.goto('/enterprise/dashboard');
  await expect(page).not.toHaveURL(/\/enterprise\/dashboard/);

  // 4) 誤ったコードは拒否される（別シークレットから生成 = 必ず不一致）
  await page.goto('/mfa');
  const wrongCode = totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await page.locator('input[name="code"]').fill(wrongCode);
  await page.getByRole('button', { name: '確認してログイン' }).click();
  await expect(page.getByText('コードが正しくありません')).toBeVisible();

  // 5) 正しいコードで AAL2 へ昇格し、ワークスペースへ入れる
  await page.locator('input[name="code"]').fill(await freshTotpCode(secret));
  await page.getByRole('button', { name: '確認してログイン' }).click();
  await page.waitForURL('**/workspace');
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/enterprise\//);
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();

  // 6) 後始末: MFA を解除し、解除後は通常ログインに戻る
  await page.goto('/enterprise/settings');
  await page.getByRole('button', { name: '解除する' }).click();
  await expect(page.getByText('MFA を解除しました')).toBeVisible();
});

test('招待: 管理者がリンクを発行し、本人が実 Supabase Auth のアカウントを作って参加できる', async ({
  page,
  context,
}) => {
  // 実行ごとに一意にする（同じスタックへ繰り返し流しても重複で落ちないように）
  // 実行ごとに一意にする（同じスタックへ繰り返し流しても重複・表示名衝突で落ちないように）
  const SUFFIX = Date.now().toString(36);
  const EMAIL = `invitee-${SUFFIX}@demo.local`;
  const DISPLAY_NAME = `招待 ${SUFFIX}`;
  const PASSWORD = 'T4D-invitee-e2e!1';

  // 1) 管理者が招待を発行
  await login(page, 'enterprise-admin@demo.local');
  await page.goto('/enterprise/settings');
  await page
    .locator('form', { has: page.getByRole('button', { name: '招待リンクを発行' }) })
    .locator('input[name="email"]')
    .fill(EMAIL);
  await page.getByRole('checkbox', { name: '拠点・グループ会社担当' }).check();
  await page.getByRole('button', { name: '招待リンクを発行' }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('tr', { hasText: EMAIL });
  const invitePath = (await row.locator('code').textContent())!.trim();
  // 招待 ID は決定論的ハッシュではなくランダム UUID（推測できない）
  expect(invitePath).toMatch(/^\/invite\/[0-9a-f-]{36}$/);

  // 2) 本人（未認証）がリンクを開いて氏名とパスワードを設定
  await context.clearCookies();
  await page.goto(invitePath);
  await expect(page.getByText('への招待')).toBeVisible();
  await page.locator('input[name="displayName"]').fill(DISPLAY_NAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: '参加する' }).click();
  await page.waitForURL(/\/login/);

  // 3) 作成されたアカウントで実際にログインできる
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL('**/workspace');
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/enterprise\//);
  await expect(page.getByText(DISPLAY_NAME).first()).toBeVisible();

  // 4) 管理者から見てメンバーに加わり、招待は受諾済みになる
  await login(page, 'enterprise-admin@demo.local');
  await page.goto('/enterprise/settings');
  await expect(page.locator('tr', { hasText: DISPLAY_NAME })).toBeVisible();
  await expect(page.locator('tr', { hasText: EMAIL }).last()).toContainText('受諾済み');
});

test('再設定リンクは自組織メンバーにしか発行できない', async ({ page }) => {
  await login(page, 'enterprise-admin@demo.local');
  await page.goto('/enterprise/settings');

  // 監査法人のユーザー（別テナント）を指定しても発行されない
  await page
    .locator('form', { has: page.getByRole('button', { name: '再設定リンクを発行' }) })
    .locator('input[name="email"]')
    .fill('assurance-partner@demo.local');
  await page.getByRole('button', { name: '再設定リンクを発行' }).click();

  await expect(page.getByText('再設定リンクを発行しました')).toHaveCount(0);
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 't4d.reset-link')).toBeUndefined();
});
