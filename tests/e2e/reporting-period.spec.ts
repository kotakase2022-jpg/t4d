import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 報告年度の作成。
 * 作れないと、収集キャンペーンも非財務データも Fixture 由来の年度しか扱えない。
 */
test.describe.configure({ mode: 'serial' });

test('報告年度を追加でき、収集キャンペーンの対象期間に現れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await expect(page.getByRole('heading', { name: /報告年度（/ })).toBeVisible();
  await page.getByRole('button', { name: '報告年度を追加' }).click();

  const code = `FY20${30 + (Date.now() % 9)}`;
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="label"]').fill(`${code} 年度`);
  await dialog.locator('input[name="startDate"]').fill('2030-04-01');
  await dialog.locator('input[name="endDate"]').fill('2031-03-31');
  await dialog.getByRole('button', { name: '作成' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.locator('tr', { hasText: code }).first()).toBeVisible();

  // 収集キャンペーンの対象期間にも出る
  await page.getByRole('button', { name: 'キャンペーンを作成' }).click();
  const campaign = page.getByRole('dialog');
  await expect(campaign.locator('select[name="reportingPeriodId"]')).toContainText(code);
});

test('終了日が開始日より前の年度は理由付きで拒否される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await page.getByRole('button', { name: '報告年度を追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill('FY9999');
  await dialog.locator('input[name="label"]').fill('逆転した年度');
  await dialog.locator('input[name="startDate"]').fill('2031-03-31');
  await dialog.locator('input[name="endDate"]').fill('2030-04-01');
  await dialog.getByRole('button', { name: '作成' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('開始日より後');
});
