import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 指標マスター。
 * ・下限／上限・分子／分母の入力が無く、画面から作った指標では範囲検証が効かなかった
 * ・「前年変動許容（±%）」に符号・範囲の検証が無く、小数は再表示で丸められていた
 */
test.describe.configure({ mode: 'serial' });

test('下限・上限・分子分母を指定して指標を作れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await page.getByRole('button', { name: '指標を追加' }).click();
  const dialog = page.getByRole('dialog');

  const code = `test_metric_${Date.now().toString(36).slice(-5)}`;
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="name"]').fill('検証用の指標');
  await dialog.locator('input[name="unit"]').fill('件');
  await dialog.locator('input[name="minValue"]').fill('0');
  await dialog.locator('input[name="maxValue"]').fill('100');
  await dialog.locator('input[name="numeratorMetricCode"]').fill('managers_female');
  await dialog.locator('input[name="denominatorMetricCode"]').fill('managers_total');
  await dialog.locator('input[name="yoyWarningPercent"]').fill('12.5');
  await dialog.getByRole('button', { name: /保存|作成|追加/ }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('tr', { hasText: code });
  await expect(row).toBeVisible();

  // 再表示で値が丸められない
  await row.getByRole('button', { name: /編集/ }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.locator('input[name="minValue"]')).toHaveValue('0');
  await expect(edit.locator('input[name="maxValue"]')).toHaveValue('100');
  await expect(edit.locator('input[name="yoyWarningPercent"]')).toHaveValue('12.5');
  await expect(edit.locator('input[name="numeratorMetricCode"]')).toHaveValue('managers_female');
});

test('下限が上限より大きいと理由が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await page.getByRole('button', { name: '指標を追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill('invalid_range_metric');
  await dialog.locator('input[name="name"]').fill('範囲が逆の指標');
  await dialog.locator('input[name="unit"]').fill('件');
  await dialog.locator('input[name="minValue"]').fill('100');
  await dialog.locator('input[name="maxValue"]').fill('10');
  await dialog.getByRole('button', { name: /保存|作成|追加/ }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('下限は上限以下');
});

test('前年変動許容に負値を入れると理由が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await page.getByRole('button', { name: '指標を追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill('negative_tolerance_metric');
  await dialog.locator('input[name="name"]').fill('負の許容');
  await dialog.locator('input[name="unit"]').fill('件');
  await dialog.locator('input[name="yoyWarningPercent"]').fill('-5');
  await dialog.getByRole('button', { name: /保存|作成|追加/ }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('0 より大きく');
});
