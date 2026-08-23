import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 統合アラートセンター。
 * 画面の説明文が挙げる種類のうち 3 種が無く、期限超過の行はクリックしても遷移しなかった。
 */
test('未提出・資料依頼・開示質問の更新が集約される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/alerts');

  await expect(page.getByText('未提出データ')).toBeVisible();
  await expect(page.getByText('未回答の資料依頼')).toBeVisible();
  await expect(page.getByText('新規・変更の開示質問')).toBeVisible();

  await expect(page.getByRole('heading', { name: /未提出のデータ（/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /監査法人からの資料依頼（/ })).toBeVisible();
});

test('未提出の一覧リンクが絞り込み済みの画面へ遷移する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/alerts');

  await page
    .getByRole('heading', { name: /未提出のデータ（/ })
    .locator('..')
    .getByRole('link', { name: '一覧で開く' })
    .click();

  await page.waitForURL(/status=not_started/);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('期限超過の行から対象へ遷移できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/alerts');

  const section = page.locator('section, div').filter({ hasText: /期限超過（/ });
  const link = section.getByRole('link').filter({ hasNotText: '一覧で開く' }).first();
  await expect(link, '期限超過の行がリンクになっていない').toBeVisible();

  await link.click();
  await expect(page.locator('#t4d-main')).toBeVisible();
  expect(page.url()).toMatch(/\/enterprise\//);
});
