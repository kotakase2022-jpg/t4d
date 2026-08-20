import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * マスターデータ管理 UI（MASTER-P0-001 / ORG-P0-001）。
 * 実ブラウザでダイアログを開いて追加し、一覧へ反映されることを確認する。
 */

test.describe.configure({ mode: 'serial' });

test('企業管理者は指標マスターを追加できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const before = await page.locator('table').last().locator('tbody tr').count();

  await page.getByRole('button', { name: '指標を追加' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const code = `QA_${Date.now().toString().slice(-6)}`;
  await page.getByRole('dialog').locator('input[name="code"]').fill(code);
  await page.getByRole('dialog').locator('input[name="name"]').fill('QA テスト指標');
  await page.getByRole('dialog').locator('input[name="unit"]').fill('件');
  await page.getByRole('button', { name: '追加する' }).click();

  await page.waitForLoadState('networkidle');
  await expect(page.getByText(code).first()).toBeVisible();
  const after = await page.locator('table').last().locator('tbody tr').count();
  expect(after).toBe(before + 1);
});

test('企業管理者は組織の連結方法と持分を編集できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 組織を 1 件追加してから編集する（Fixture を汚さない）
  const code = `U${Date.now().toString().slice(-6)}`;
  await page.getByRole('button', { name: '組織を追加' }).click();
  await page.getByRole('dialog').locator('input[name="code"]').fill(code);
  await page.getByRole('dialog').locator('input[name="name"]').fill('QA テスト拠点');
  await page.getByRole('button', { name: '追加する' }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('tbody tr', { hasText: code });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /編集/ }).click();

  const dialog = page.getByRole('dialog');
  await dialog.locator('select[name="consolidationMethod"]').selectOption('equity');
  await dialog.locator('input[name="ownershipPercent"]').fill('35');
  await page.getByRole('button', { name: '更新する' }).click();
  await page.waitForLoadState('networkidle');

  const updatedRow = page.locator('tbody tr', { hasText: code });
  await expect(updatedRow).toContainText('持分法');
  await expect(updatedRow).toContainText('35%');
});

test('権限のないロールには追加ボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: '指標を追加' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '組織を追加' })).toHaveCount(0);
});

test('企業管理者は収集キャンペーンを作成できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.getByRole('button', { name: 'キャンペーンを作成' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const name = `QA キャンペーン ${Date.now().toString().slice(-5)}`;
  await dialog.locator('input[name="name"]').fill(name);
  await dialog.locator('input[name="dueDate"]').fill('2026-09-30');
  // 対象組織を 2 件、対象指標を 2 件選ぶ
  const unitBoxes = dialog.locator('input[name="unitIds"]');
  await unitBoxes.nth(0).check();
  await unitBoxes.nth(1).check();
  const metricBoxes = dialog.locator('input[name="metricIds"]');
  await metricBoxes.nth(0).check();
  await metricBoxes.nth(1).check();

  await page.getByRole('button', { name: '作成する' }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  // 2 組織 × 2 指標 = 4 スコープ
  await expect(row).toContainText('4 件');
});
