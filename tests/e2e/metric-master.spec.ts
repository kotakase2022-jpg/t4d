import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs, openCollapsible } from './helpers';

/**
 * 指標マスター。
 * ・下限／上限・分子／分母の入力が無く、画面から作った指標では範囲検証が効かなかった
 * ・「前年変動許容（±%）」に符号・範囲の検証が無く、小数は再表示で丸められていた
 *
 * 追加・編集はモーダルから専用ページへ移した（plan §2 S10）。必須の節（基本）が先頭で、
 * 検証・計算式は任意の節（既定で閉じる。値があれば開いて描く）。
 * 理由が出たときは、同じページに理由を示し、入力を残す（モーダルが閉じて入力が消えていた）。
 */
test.describe.configure({ mode: 'serial' });

test('下限・上限・分子分母を指定して指標を作れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=metrics');

  await page.getByRole('link', { name: '指標を追加', exact: true }).click();
  const form = page.getByRole('form', { name: '指標を追加' });

  const code = `test_metric_${Date.now().toString(36).slice(-5)}`;
  await form.locator('input[name="code"]').fill(code);
  await form.locator('input[name="name"]').fill('検証用の指標');
  await form.locator('input[name="unit"]').fill('件');
  await openCollapsible(form, '検証');
  await form.locator('input[name="minValue"]').fill('0');
  await form.locator('input[name="maxValue"]').fill('100');
  await form.locator('input[name="yoyWarningPercent"]').fill('12.5');
  await openCollapsible(form, '計算式');
  await form.locator('input[name="numeratorMetricCode"]').fill('managers_female');
  await form.locator('input[name="denominatorMetricCode"]').fill('managers_total');
  await form.getByRole('button', { name: /保存|作成|追加/ }).click();
  await page.waitForURL(/flash=masterMetricCreated/);

  const row = page.locator('tr', { hasText: code });
  await expect(row).toBeVisible();

  // 再表示で値が丸められない（編集ページ。値の入った節は開いて描く）
  await row.getByRole('link', { name: /編集/ }).click();
  const edit = page.getByRole('form', { name: '指標を編集' });
  await expect(edit.locator('input[name="minValue"]')).toHaveValue('0');
  await expect(edit.locator('input[name="maxValue"]')).toHaveValue('100');
  await expect(edit.locator('input[name="yoyWarningPercent"]')).toHaveValue('12.5');
  await expect(edit.locator('input[name="numeratorMetricCode"]')).toHaveValue('managers_female');
  await expect(edit.locator('input[name="minValue"]')).toBeVisible();
  await expect(edit.locator('input[name="numeratorMetricCode"]')).toBeVisible();
});

test('下限が上限より大きいと理由が出る（入力は残る）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=metrics');

  await page.getByRole('link', { name: '指標を追加', exact: true }).click();
  const form = page.getByRole('form', { name: '指標を追加' });
  await form.locator('input[name="code"]').fill('invalid_range_metric');
  await form.locator('input[name="name"]').fill('範囲が逆の指標');
  await form.locator('input[name="unit"]').fill('件');
  await openCollapsible(form, '検証');
  await form.locator('input[name="minValue"]').fill('100');
  await form.locator('input[name="maxValue"]').fill('10');
  await form.getByRole('button', { name: /保存|作成|追加/ }).click();

  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('下限は上限以下');
  // 同じページに残り、入力は消えない
  await expect(page).toHaveURL(/\/enterprise\/organizations\/metrics\/new/);
  await expect(page.locator('input[name="code"]')).toHaveValue('invalid_range_metric');
  await expect(page.locator('input[name="minValue"]')).toHaveValue('100');
});

test('前年変動許容に負値を入れると理由が出る（入力は残る）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=metrics');

  await page.getByRole('link', { name: '指標を追加', exact: true }).click();
  const form = page.getByRole('form', { name: '指標を追加' });
  await form.locator('input[name="code"]').fill('negative_tolerance_metric');
  await form.locator('input[name="name"]').fill('負の許容');
  await form.locator('input[name="unit"]').fill('件');
  await openCollapsible(form, '検証');
  await form.locator('input[name="yoyWarningPercent"]').fill('-5');
  await form.getByRole('button', { name: /保存|作成|追加/ }).click();

  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('0 より大きく');
  await expect(page).toHaveURL(/\/enterprise\/organizations\/metrics\/new/);
  await expect(page.locator('input[name="yoyWarningPercent"]')).toHaveValue('-5');
});
