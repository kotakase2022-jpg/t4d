import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 保証契約の起票。
 * 案件を作れないと、監査法人は契約を受注してもシステム上で仕事を始められない。
 */
test.describe.configure({ mode: 'serial' });

test('監査法人が新しい案件を起票でき、起票者がチームに入る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');

  const form = page.locator('form', { hasText: '起票' });
  await expect(form, '案件を起票するフォームが無い').toBeVisible();

  const code = `ENG-TEST-${Date.now().toString(36).slice(-5)}`;
  await form.locator('input[name="code"]').fill(code);
  await form.locator('input[name="name"]').fill('回帰テスト用の保証契約');
  await form.getByRole('button', { name: '起票' }).click();

  // 起票直後に自分がメンバーなので、案件の概要が開ける
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  await expect(page.locator('#t4d-main')).toContainText('回帰テスト用の保証契約');

  await page.goto('/assurance/engagements');
  await expect(page.locator('tr', { hasText: code })).toBeVisible();
});

test('案件コードが重複すると理由付きで拒否される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');

  const existing = await page.locator('tbody tr td').first().innerText();
  const form = page.locator('form', { hasText: '起票' });
  await form.locator('input[name="code"]').fill(existing.trim());
  await form.locator('input[name="name"]').fill('重複コードの案件');
  await form.getByRole('button', { name: '起票' }).click();

  await expect(page.locator('#t4d-main')).toContainText(/既にあります|できませんでした/);
});

test('案件管理の権限が無いロールには起票フォームが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceStaff);
  await page.goto('/assurance/engagements');
  await expect(page.locator('form', { hasText: '起票' })).toHaveCount(0);
});
