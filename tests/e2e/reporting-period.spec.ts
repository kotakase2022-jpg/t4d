import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 報告年度の作成。
 * 作れないと、収集キャンペーンも非財務データも Fixture 由来の年度しか扱えない。
 *
 * 組織・拠点の「報告年度」タブ（?tab=periods）。追加は 6 項目の小さなダイアログのまま（plan §2 S10）で、
 * 既定値は最新の報告年度の 1 年後（D12）。理由が出たときはダイアログを開いたまま示し、入力を残す。
 */
test.describe.configure({ mode: 'serial' });

test('報告年度を追加でき、収集キャンペーンの対象期間に現れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=periods');

  await expect(page.getByRole('heading', { name: /報告年度（/ })).toBeVisible();
  await page.getByRole('button', { name: '報告年度を追加' }).click();

  const code = `FY20${30 + (Date.now() % 9)}`;
  const dialog = page.getByRole('dialog');
  // 既定値は最新の報告年度の 1 年後（4 月始まりの年度。値はデモの状態で変わるので形で確かめる）
  await expect(dialog.locator('input[name="code"]')).toHaveValue(/^FY\d{4}$/);
  await expect(dialog.locator('input[name="startDate"]')).toHaveValue(/^\d{4}-04-01$/);
  await expect(dialog.locator('input[name="endDate"]')).toHaveValue(/^\d{4}-03-31$/);
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="label"]').fill(`${code} 年度`);
  await dialog.locator('input[name="startDate"]').fill('2030-04-01');
  await dialog.locator('input[name="endDate"]').fill('2031-03-31');
  await dialog.getByRole('button', { name: '作成' }).click();
  await page.waitForURL(/flash=masterPeriodCreated/);

  await expect(page.locator('tr', { hasText: code }).first()).toBeVisible();

  // 収集キャンペーンの対象期間にも出る（作成は専用ページ）
  await page.goto('/enterprise/organizations?tab=campaigns');
  await page.getByRole('link', { name: 'キャンペーンを作成', exact: true }).click();
  await page.waitForURL('**/enterprise/organizations/campaigns/new');
  await expect(page.locator('select[name="reportingPeriodId"]')).toContainText(code);
});

test('終了日が開始日より前の年度は理由付きで拒否される（入力は残る）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=periods');

  await page.getByRole('button', { name: '報告年度を追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill('FY9999');
  await dialog.locator('input[name="label"]').fill('逆転した年度');
  await dialog.locator('input[name="startDate"]').fill('2031-03-31');
  await dialog.locator('input[name="endDate"]').fill('2030-04-01');
  await dialog.getByRole('button', { name: '作成' }).click();

  // ダイアログを開いたまま理由を示し、入力は消えない
  await expect(dialog.getByRole('alert')).toContainText('開始日より後');
  await expect(dialog.locator('input[name="code"]')).toHaveValue('FY9999');
  await expect(dialog.locator('input[name="startDate"]')).toHaveValue('2031-03-31');
});

test('期間の管理だけの役割には「報告年度を追加」を出さない（作成は組織の管理が要る）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/organizations?tab=periods');
  await expect(page.getByRole('heading', { name: /報告年度（/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '報告年度を追加' })).toHaveCount(0);
  await expect(page.getByText(/報告年度の追加は、組織を管理する権限/)).toBeVisible();
});
