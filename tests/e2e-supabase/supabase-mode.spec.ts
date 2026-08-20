import { expect, test, type Page } from '@playwright/test';
import { LOCAL_DEMO_PASSWORD } from '@/lib/fixtures/to-sql';
import { crawl, watchConsole } from '@tests/support/crawl';

/**
 * Supabase Mode の通し確認。
 *
 * Demo Mode の Fixture ではなく、**実 Supabase Auth でログインし、
 * RLS が効いた Postgres から読んだデータ**で画面が動くことを確認する。
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

test('デモバッジが出ず、Supabase Auth のログインフォームが表示される', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
  await expect(page.getByLabel('メールアドレス')).toBeVisible();
  // Demo Mode 専用のボタンは出ない
  await expect(page.getByRole('heading', { name: 'デモログイン' })).toHaveCount(0);
});

test('誤ったパスワードではログインできない', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill('enterprise-admin@demo.local');
  await page.getByLabel('パスワード').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();
  // ログインページに留まる（/workspace へ遷移しない）
  await expect(page).toHaveURL(/\/login/);
});

test('企業ユーザーがログインし、実 DB のデータでダッシュボードが表示される', async ({ page }) => {
  await login(page, 'enterprise-admin@demo.local');

  await expect(page).toHaveURL(/\/enterprise\/dashboard/);
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
  // Demo Mode のバッジは出ない
  await expect(page.getByText('デモデータ')).toHaveCount(0);

  await expect(page.getByText('青海テクノロジー株式会社').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '拠点別進捗' })).toBeVisible();
  await expect(page.getByText('東日本工場').first()).toBeVisible();
});

test('一覧が DB 側ページングで表示され、フィルターが効く', async ({ page }) => {
  await login(page, 'enterprise-admin@demo.local');

  await page.goto('/enterprise/data');
  await expect(page.getByRole('heading', { name: '非財務データ' })).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  // 1 ページあたり 25 件（DEFAULT_PAGE_SIZE）を超えない
  expect(await rows.count()).toBeLessThanOrEqual(25);

  // 検証エラーの絞り込み（永続化された validation を DB 側で引く）
  await page.goto('/enterprise/data?flag=validation_error');
  await expect(page.getByText('エラー', { exact: false }).first()).toBeVisible();

  // 検索（指標名 OR 組織名を DB 側の OR 条件で解決）
  await page.goto('/enterprise/data?q=Scope1');
  await expect(page.getByText('Scope1 排出量').first()).toBeVisible();
});

test('監査法人ユーザーは許諾範囲のみ閲覧でき、Read-only 表示になる', async ({ page }) => {
  await login(page, 'assurance-manager@demo.local');

  await expect(page).toHaveURL(/\/assurance\/dashboard/);
  await expect(page.getByRole('heading', { name: '案件ホーム' })).toBeVisible();
  await expect(page.getByText('青海テクノロジー株式会社').first()).toBeVisible();

  await page.goto('/assurance/engagements');
  await page.getByRole('link', { name: 'ENG-2026-001' }).first().click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  const engagementId = page.url().match(/engagements\/([^/]+)\//)?.[1] ?? '';

  await page.goto(`/assurance/engagements/${engagementId}/data-room`);
  await expect(page.getByText('Read-only（企業原本）')).toBeVisible();
  // 許諾外の組織は表示されない（RLS が効いている）
  await expect(page.getByText('欧州販売子会社')).toHaveCount(0);
});

test('未アサインの法人管理者は URL 直打ちでも 404 になる', async ({ page }) => {
  await login(page, 'assurance-manager@demo.local');
  await page.goto('/assurance/engagements');
  await page.getByRole('link', { name: 'ENG-2026-001' }).first().click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  const engagementId = page.url().match(/engagements\/([^/]+)\//)?.[1] ?? '';

  await login(page, 'assurance-admin@demo.local');
  await expect(page.getByText('アサインされている案件がありません')).toBeVisible();

  await page.goto(`/assurance/engagements/${engagementId}/data-room`);
  await expect(page.getByText('ページが見つかりません')).toBeVisible();
});

test('CSP が nonce ベースで、script-src に unsafe-inline を含まない', async ({ page }) => {
  const response = await page.goto('/login');
  const csp = response?.headers()['content-security-policy'] ?? '';

  expect(csp).toContain('nonce-');
  expect(csp).toContain("'strict-dynamic'");
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  expect(scriptSrc).not.toContain('unsafe-inline');
  expect(scriptSrc).not.toContain('unsafe-eval');
});

/**
 * 実 Supabase 接続での画面クロール。
 *
 * Demo Mode（tests/e2e/screen-audit.spec.ts）と同じ検査を、RLS が効いた状態で行う。
 * 「許諾外のテーブルを読もうとして画面が落ちる」類の欠陥は
 * Fixture の Demo Mode では**原理的に出ない**（実際に migration 0017 の穴がこれで見つかった）。
 */
test('企業ユーザー: 実 RLS 下で到達可能な全画面が描画される', async ({ page }) => {
  const problems: string[] = [];
  watchConsole(page, problems);
  await login(page, 'enterprise-admin@demo.local');

  const visited = await crawl(
    page,
    ['/enterprise/dashboard', '/notifications', '/profile'],
    ['/enterprise/', '/notifications', '/profile'],
    problems,
  );

  console.log(`[AUDIT/supabase] 企業: ${visited.length} ページ`);
  expect(visited.length).toBeGreaterThan(15);
  expect(problems.join('\n')).toBe('');
});

test('監査法人ユーザー: 実 RLS 下で到達可能な全画面が描画される', async ({ page }) => {
  const problems: string[] = [];
  watchConsole(page, problems);
  await login(page, 'assurance-manager@demo.local');

  await page.goto('/assurance/engagements');
  await page.getByRole('link', { name: 'ENG-2026-001' }).first().click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  const engagementHome = new URL(page.url()).pathname;

  const visited = await crawl(
    page,
    ['/assurance/dashboard', engagementHome, '/notifications', '/profile'],
    ['/assurance/', '/notifications', '/profile'],
    problems,
  );

  console.log(`[AUDIT/supabase] 監査法人: ${visited.length} ページ`);
  expect(visited.length).toBeGreaterThan(10);
  expect(problems.join('\n')).toBe('');
});
