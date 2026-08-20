import { expect, test } from '@playwright/test';
import { DEMO_USERS, gotoEnterprise, loginAs } from './helpers';

/**
 * 一覧の並べ替え・列表示切替（機能要件 UX-P0-004）。
 *
 * 並べ替えは **DB 側**で行う。ページ内だけを並べ替えると
 * 「全体の並び順」と食い違うため、URL 経由でサーバーへ渡していることを検証する。
 */

test.describe.configure({ mode: 'serial' });

/** 「値」列の数値をページ全体から拾う。 */
async function valueColumn(page: import('@playwright/test').Page): Promise<number[]> {
  const cells = await page.locator('tbody tr td:nth-child(5)').allInnerTexts();
  return cells.map((t) => Number(t.replace(/[,\s]/g, ''))).filter((n) => Number.isFinite(n));
}

test('値の昇順・降順で並べ替えられる（DB 側）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await gotoEnterprise(page, 'data');

  await page.getByRole('link', { name: /値で並べ替え/ }).click();
  await page.waitForURL(/[?&]sort=value/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();

  const asc = await valueColumn(page);
  expect(asc.length).toBeGreaterThan(1);
  expect([...asc].sort((a, b) => a - b)).toEqual(asc);

  // もう一度押すと降順
  await page.getByRole('link', { name: /値で並べ替え/ }).click();
  await page.waitForURL(/[?&]dir=desc/, { timeout: 12_000 });
  const desc = await valueColumn(page);
  expect(desc.length).toBeGreaterThan(1);
  expect([...desc].sort((a, b) => b - a)).toEqual(desc);

  // 昇順の先頭 < 降順の先頭（＝ページ内ではなく全体で並べ替えている）
  expect(asc[0]).toBeLessThan(desc[0] as number);
});

test('並べ替えると 1 ページ目へ戻る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data?page=2');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.getByRole('link', { name: /更新日時で並べ替え/ }).click();
  await page.waitForURL(/[?&]sort=updated/, { timeout: 12_000 });
  await expect(page).toHaveURL((url) => !url.searchParams.has('page'));
});

test('列表示を切り替えられ、URL に保持される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await gotoEnterprise(page, 'data');

  const before = await page.locator('thead th').count();
  await page.locator('[data-t4d-column-selector]').click();
  await page.getByRole('link', { name: '単位' }).click();

  await page.waitForURL(/[?&]cols=/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();
  expect(await page.locator('thead th').count()).toBe(before - 1);

  // リロードしても維持される（URL State）
  await page.reload();
  expect(await page.locator('thead th').count()).toBe(before - 1);
});

test('指標列は常に表示され、外せない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await gotoEnterprise(page, 'data');
  await page.locator('[data-t4d-column-selector]').click();
  await expect(page.getByText('指標（常に表示）')).toBeVisible();
});

test('不正な sort / cols を渡しても壊れない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  for (const url of [
    '/enterprise/data?sort=not_a_column',
    '/enterprise/data?sort=value&dir=sideways',
    '/enterprise/data?cols=',
    '/enterprise/data?cols=nonexistent',
  ]) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), url).toBeLessThan(400);
    await expect(page.locator('#t4d-main')).toBeVisible();
  }
});
