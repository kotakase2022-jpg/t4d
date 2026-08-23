import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 保存ビュー「自分の担当」。
 * 全社スコープの利用者では空クエリになり、常に 0 件になっていた。
 */
test('担当拠点のある人は「自分の担当」で自分の拠点だけが出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/data');

  const view = page.getByRole('link', { name: '自分の担当' });
  await expect(view, '担当拠点のある人には出るべき').toBeVisible();

  await view.click();
  await page.waitForURL(/unit=/);

  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const units = await rows.evaluateAll((trs) =>
    trs.map((tr) => (tr.querySelectorAll('td')[2]?.textContent ?? '').trim()),
  );
  expect(units.length).toBeGreaterThan(0);
  expect(units.every((u) => u.includes('東日本工場'))).toBe(true);
});

test('全社スコープの人には「自分の担当」を出さない（常に 0 件になるため）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');

  await expect(page.getByRole('link', { name: '自分の担当' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '連結対象のみ' })).toBeVisible();
});

test('空の unit= が付いていても全件が消えない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data?unit=');
  await expect(page.locator('tbody tr').first()).toBeVisible();
});
