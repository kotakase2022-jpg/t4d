import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * CSRD ワークスペース（機能追加要望 ②）。
 * ナビゲーション → ギャップ分析 → 質問詳細（共有ビュー）→ AI ドラフト生成まで実ブラウザで確認する。
 */

test.describe.configure({ mode: 'serial' });

test('サイドバーから CSRD を開き、ギャップ分析が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // nav の開示対応配下に CSRD が出る
  await page.getByRole('link', { name: 'CSRD' }).first().click();
  await page.waitForURL(/\/enterprise\/disclosures\/csrd/);

  await expect(page.getByRole('heading', { name: /CSRD 開示対応/ })).toBeVisible();
  await expect(page.getByText('初年度対応')).toBeVisible();

  // ギャップ分析: データありとデータなしの両方の状態が見える
  await expect(page.getByText('データあり').first()).toBeVisible();
  await expect(page.getByText('承認済みデータなし').first()).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(12);
});

test('ESRS 項目の詳細を開き、AI ドラフトを生成できる（共有ビュー）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd');
  await page.getByRole('link', { name: 'ESRS-E1-5' }).click();

  await page.waitForURL(/\/enterprise\/disclosures\/csrd\/.+/);
  await expect(page.getByRole('heading', { name: /ESRS-E1-5/ })).toBeVisible();
  // パンくずが CSRD になっている（CDP ではない）
  await expect(page.getByRole('link', { name: 'CSRD', exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'ドラフトを生成' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/Mock|AI 生成/).first()).toBeVisible();

  // 質問一覧（左ペイン）のリンクは CSRD 配下を指す
  const firstNavLink = page.locator('a[href^="/enterprise/disclosures/csrd/"]').first();
  await expect(firstNavLink).toBeVisible();
});

test('CSRD でも整合チェックが実行でき、ESRS 項目への指摘が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd');
  await page.getByRole('button', { name: '整合チェックを実行' }).click();

  await page.waitForURL(/\/enterprise\/disclosures\/csrd\?check=/);
  await expect(page.getByRole('heading', { name: /整合チェックの結果/ })).toBeVisible();
  await expect(page.getByText(/ESRS/).first()).toBeVisible();
});
