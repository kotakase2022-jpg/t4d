import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * AI Copilot インサイト（機能追加要望 ④）。
 * 実ブラウザで実行し、根拠・含意・推奨アクションの 3 点セットと導線を確認する。
 */

test.describe.configure({ mode: 'serial' });

test('インサイトを実行し、洞察カードが表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.getByRole('button', { name: 'インサイトを発見' }).click();
  await page.waitForURL(/\/enterprise\/ai\?insight=/);

  // 洞察カード: 根拠・含意・推奨アクションの 3 点セット
  await expect(page.getByText('根拠').first()).toBeVisible();
  await expect(page.getByText('含意').first()).toBeVisible();
  await expect(page.getByText('推奨アクション').first()).toBeVisible();

  // 各洞察には確認先への導線がある
  const goLink = page.getByRole('link', { name: '確認しに行く' }).first();
  await expect(goLink).toBeVisible();

  // Mock バッジ（Demo Mode）と警告の明示
  await expect(page.getByText(/Mock/).first()).toBeVisible();
  await expect(page.getByText('洞察は候補です').first()).toBeVisible();

  // 再読込しても同じ結果が残る（?insight= で読み直せる）
  await page.reload();
  await expect(page.getByText('推奨アクション').first()).toBeVisible();
});

test('洞察の「確認しに行く」から対象画面へ遷移できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');
  await page.getByRole('button', { name: 'インサイトを発見' }).click();
  await page.waitForURL(/insight=/);

  const link = page.getByRole('link', { name: '確認しに行く' }).first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/enterprise\//);
  await link.click();
  await page.waitForURL((url) => url.pathname.startsWith('/enterprise/'));
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('AI 実行権限が無いロールには実行ボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/ai');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'インサイトを発見' })).toHaveCount(0);
});

test('実行履歴にインサイト実行が Provenance として残る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');
  await page.getByRole('button', { name: 'インサイトを発見' }).click();
  await page.waitForURL(/insight=/);

  await expect(page.locator('table tbody tr', { hasText: 'インサイト発見' }).first()).toBeVisible();
});
