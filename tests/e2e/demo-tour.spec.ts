import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * デモモード（機能追加要望 ③）。
 * サイドバー最下部のボタンから開始し、実画面を巡回するツアーを実ブラウザで確認する。
 */

test.describe.configure({ mode: 'serial' });

test('デモモードを開始すると、画面を巡回しながら案内が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // サイドバー最下部のボタンから開始（最初のステップ = ダッシュボードへ移動）
  await page.getByRole('button', { name: 'デモモード' }).click();
  await page.waitForURL(/\/enterprise\/dashboard/);

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 / 9');
  await expect(dialog).toContainText('今日やるべきこと');
  await expect(dialog).toContainText('見どころ');

  // 次へ → 組織・指標マスターへ遷移し、案内が切り替わる
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/organizations/);
  await expect(dialog).toContainText('2 / 9');
  await expect(dialog).toContainText('集計範囲のズレ');

  // 戻る → ダッシュボードへ戻る
  await dialog.getByRole('button', { name: '戻る' }).click();
  await page.waitForURL(/\/enterprise\/dashboard/);
  await expect(dialog).toContainText('1 / 9');
});

test('最後のステップまで進むと「ツアーを終了」で閉じられる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();

  // 最後（9 番目）まで進む
  for (let i = 0; i < 8; i += 1) {
    await dialog.getByRole('button', { name: '次へ' }).click();
  }
  await page.waitForURL(/\/enterprise\/workflows/);
  await expect(dialog).toContainText('9 / 9');

  await dialog.getByRole('button', { name: 'ツアーを終了' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);
});

test('Escape とツアー中の × でいつでも終了できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);

  // × ボタンでも終了できる
  await page.getByRole('button', { name: 'デモモード' }).click();
  await page.getByRole('button', { name: 'デモモードを終了' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);
});

test('監査法人ワークスペースにはデモモードボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'デモモード' })).toHaveCount(0);
});
