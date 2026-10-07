import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs, resetCarriedDemoState } from './helpers';

/**
 * 報告年度・収集キャンペーンの作成は、結果の画面が別のサーバーに届いても一覧に行が出る
 * （状態がリクエストごとに消えるサーバーでだけ流す。playwright.stateless.config.ts）。
 *
 * どちらも保存のあと結果の通知付きの画面へ移る（Server Action の redirect）。移った先の描画は別の
 * リクエストで、本番（Vercel）では別のインスタンスに届くことがある。年度・キャンペーン・収集スコープを
 * Cookie で持ち回していなかったため、「追加しました」と出るのに一覧に行が無かった（UI 再設計の検証 F1）。
 *
 * ファイル名を *.spec.ts にしないのは、通常の E2E（1 つのサーバーがメモリを持ち続ける）では
 * この経路を通らないため（同じ内容は reporting-period.spec.ts・master-data.spec.ts が確かめている）。
 */

test.beforeAll(() => {
  // 前の spec の Cookie を持ち込まない（初期状態の Fixture から始める）
  resetCarriedDemoState();
});

test('報告年度を追加すると、結果の画面（別のサーバー）の一覧にも、キャンペーンの対象期間にも出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=periods');
  await page.getByRole('button', { name: '報告年度を追加' }).click();

  const code = 'FY2033';
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="label"]').fill(`${code} 年度（E2E）`);
  await dialog.locator('input[name="startDate"]').fill('2033-04-01');
  await dialog.locator('input[name="endDate"]').fill('2034-03-31');
  await dialog.getByRole('button', { name: '作成' }).click();
  await page.waitForURL(/flash=masterPeriodCreated/);

  await expect(page.getByRole('status').filter({ hasText: code })).toBeVisible();
  await expect(page.locator('tr', { hasText: code }).first()).toBeVisible();

  // 次の画面（さらに別のサーバー）でも残っている
  await page.goto('/enterprise/organizations/campaigns/new');
  await expect(page.locator('select[name="reportingPeriodId"]')).toContainText(code);
});

test('収集キャンペーンを作成すると、結果の画面（別のサーバー）の一覧に収集スコープの件数ごと出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations/campaigns/new');
  const form = page.getByRole('form', { name: '収集キャンペーンを作成' });
  await expect(form).toBeVisible();

  await form.getByRole('button', { name: '対象組織をすべて外す' }).click();
  await form.getByRole('button', { name: '対象指標をすべて外す' }).click();
  const unitBoxes = form.locator('input[name="unitIds"]');
  await unitBoxes.nth(0).check();
  await unitBoxes.nth(1).check();
  const metricBoxes = form.locator('input[name="metricIds"]');
  await metricBoxes.nth(0).check();
  await metricBoxes.nth(1).check();
  await form.getByRole('button', { name: '次へ（期限・説明）' }).click();

  const name = 'E2E 別サーバーのキャンペーン';
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="dueDate"]').fill('2026-09-30');
  await form.getByRole('button', { name: '作成する' }).click();
  await page.waitForURL(/tab=campaigns.*flash=masterCampaignCreated/);

  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  // 2 組織 × 2 指標 = 4 スコープ（スコープも持ち回す）
  await expect(row).toContainText('4 件');

  await page.reload();
  await expect(page.locator('tbody tr', { hasText: name })).toContainText('4 件');
});
