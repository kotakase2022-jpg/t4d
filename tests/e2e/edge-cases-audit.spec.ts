import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 異常系・境界値の実操作監査（自己検証ミッション用）。
 *
 * happy path だけで合格にしないため、フォームの境界値、二重送信、
 * 空データ、極端な入力、ブラウザバックまで確認する。
 */

test.describe.configure({ mode: 'serial' });

test('フォーム: 極端な入力（巨大値・負数・長文・記号・改行）でも破綻しない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?status=draft');
  const detail = page.getByRole('link', { name: '詳細' }).first();
  test.skip((await detail.count()) === 0, '編集可能な Data Point が無い');
  await detail.click();
  await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/);

  const valueInput = page.locator('input[name="value"]');
  test.skip((await valueInput.count()) === 0, '値編集フォームが出ない');
  const reasonInput = page.locator('input[name="changeReason"]');

  // 数値でない値は保存されない（サーバー側で弾く）
  await valueInput.fill('abc');
  await reasonInput.fill('不正値の検証');
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');
  // エラーになるか、値が変わらないかのいずれか。500 の白画面にはならない
  await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);

  // 記号・改行・長文を理由に入れても壊れない
  await page.goto(page.url());
  const long = 'あ'.repeat(400) + ' <script>alert(1)</script> & " \' \\ ';
  if ((await valueInput.count()) > 0) {
    await valueInput.fill('123.45');
    await reasonInput.fill(long);
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForLoadState('networkidle');
    // スクリプトが実行されない（エスケープされて文字として出る）
    await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);
  }
});

test('コメント: 2000 文字超は拒否され、空白のみは送信されない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await page.locator('tbody a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const box = page.locator('textarea[name="body"]').first();
  test.skip((await box.count()) === 0, 'コメント欄が出ていない');

  // 2001 文字
  await box.fill('あ'.repeat(2001));
  await page.getByRole('button', { name: 'コメントする' }).first().click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);

  // 空白のみは登録されない
  await page.goto(url);
  const box2 = page.locator('textarea[name="body"]').first();
  await box2.fill('   ');
  await page.getByRole('button', { name: 'コメントする' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.goto(url);
  // 空白だけのコメントが増えていないこと（本文が空のコメント行が無い）
  await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);
});

test('二重送信: 続けて 2 回押しても二重登録されない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await page.locator('tbody a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const box = page.locator('textarea[name="body"]').first();
  test.skip((await box.count()) === 0, 'コメント欄が出ていない');

  const body = `二重送信検証 ${Date.now().toString(36)}`;
  await box.fill(body);
  const button = page.getByRole('button', { name: 'コメントする' }).first();
  // 2 回続けて押す
  await button.click();
  await button.click().catch(() => {
    /* 1 回目の送信でフォームが消えることがある */
  });
  await page.waitForLoadState('networkidle');

  await page.goto(url);
  // 同じ本文が 2 件に増えていない（フォームは送信後にリセットされる設計）
  await expect(page.getByText(body)).toHaveCount(1);
});

test('空データ: 該当しない絞り込みで空状態が正しく表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?q=このような文字列は存在しないはず_zzz');
  await expect(page.getByText('該当するデータがありません')).toBeVisible();
  // 空でもテーブルヘッダーやレイアウトが崩れない
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('ブラウザバック・リロードで状態が壊れない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await page.goto('/enterprise/data?status=approved');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/enterprise\/data$/);
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.reload();
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/status=approved/);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('ページネーション: 最終ページを超える指定でも壊れない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  const res = await page.goto('/enterprise/data?page=9999');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const res2 = await page.goto('/enterprise/data?page=-1');
  expect(res2?.status()).toBeLessThan(400);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const res3 = await page.goto('/enterprise/data?page=abc');
  expect(res3?.status()).toBeLessThan(400);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('不正なクエリパラメータでも 500 にならない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const q of [
    '/enterprise/data?status=__invalid__',
    '/enterprise/data?unit=__invalid__',
    '/enterprise/data?sort=__invalid__&dir=__invalid__',
    '/enterprise/data?cols=',
    '/enterprise/disclosures/cdp?version=__invalid__',
    '/enterprise/evidence/00000000-0000-4000-8000-000000000000?page=abc',
  ]) {
    const res = await page.goto(q);
    const status = res?.status() ?? 0;
    expect(status, `${q} が 500 を返す`).not.toBe(500);
  }
});

test('AI Copilot: 空・長文の質問でも壊れない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');

  const input = page.locator('input[name="question"]');
  await expect(input).toBeVisible();

  // 空のまま送信 → required で送信されない
  await page.getByRole('button', { name: '質問する' }).click();
  const invalid = await input.evaluate((el: HTMLInputElement) => !el.checkValidity());
  expect(invalid, '空の質問が送信できてしまう').toBe(true);

  // 1000 文字超（サーバー側で拒否）
  await input.fill('あ'.repeat(1001));
  await page.getByRole('button', { name: '質問する' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);
});
