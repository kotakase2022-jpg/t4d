import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 通知の既読。
 * 既読にする手段が無いと未読バッジが永久に消えず、新しい通知に気づけない。
 *
 * Demo Mode の状態はプロセスで共有されるため、既読にすると後続に影響する。
 * ユーザーごとに未読は 1 件ずつなので、テストは**別々のユーザー**で行う。
 */
test('通知を 1 件ずつ既読にできる（海野 みどり）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/notifications');

  const unreadBefore = await page.getByText('未読', { exact: true }).count();
  expect(unreadBefore, '未読の通知が seed に必要').toBeGreaterThan(0);

  await page.getByRole('button', { name: '既読にする' }).first().click();
  await page.waitForLoadState('networkidle');

  expect(await page.getByText('未読', { exact: true }).count()).toBe(unreadBefore - 1);
});

test('まとめて既読にできる（検見川 涼）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto('/notifications');

  const bulk = page.getByRole('button', { name: /すべて既読にする/ });
  await expect(bulk, '未読の通知が seed に必要').toBeVisible();

  await bulk.click();
  await page.waitForLoadState('networkidle');

  await expect(page.getByText('未読', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /すべて既読にする/ })).toHaveCount(0);
});

test('他人宛の通知は既読にできない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto('/notifications');
  // 承認者宛の通知は seed に無いので、既読ボタン自体が出ない
  await expect(page.getByRole('button', { name: '既読にする' })).toHaveCount(0);
});
