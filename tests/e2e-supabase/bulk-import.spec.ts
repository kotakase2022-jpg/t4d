import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';
import { LOCAL_DEMO_PASSWORD } from '../../src/lib/fixtures/to-sql';

/**
 * Supabase Mode（実 Auth + 実 RLS）での 50 ファイル一括取込。
 * Demo Mode と違い DB が共有されるので、プレビューは DB から読み直される。
 */
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

test('50 ファイルを一括投入し、実 DB でプレビューまで到達する', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHeterogeneousDataset();
  const files = dataset.slice(0, 50).map((f) => ({
    name: f.name,
    mimeType: f.mimeType,
    buffer: Buffer.from(f.bytes),
  }));

  await login(page, 'sustainability@demo.local');
  await page.goto('/enterprise/imports');
  await page.locator('input[name="files"]').setInputFiles(files);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  expect(await rows.count(), '取込行が出ていない').toBeGreaterThan(50);

  // リロードしても DB から読み直せる（Demo Mode と違い共有されている）
  await page.reload();
  await expect(page.locator('input[name^="value:"]').first()).toBeVisible({ timeout: 60_000 });
});
