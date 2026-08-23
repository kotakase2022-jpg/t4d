import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * Evidence の紐付け。
 * ・主キーがセル参照を含まず、同じファイル・同じページの別セルを紐付けられなかった
 * ・ページ欄に数値検証が無く、数字以外は NaN のまま黙って消えていた
 */
test.describe.configure({ mode: 'serial' });

async function openDataPointWithFiles(page: import('@playwright/test').Page) {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  const href = (await page.locator('a[href^="/enterprise/data/"]').first().getAttribute('href'))!;
  await page.goto(href);
  return href;
}

test('同じファイル・同じページでも、別のセルなら紐付けられる', async ({ page }) => {
  await openDataPointWithFiles(page);

  const form = page.locator('form', { hasText: '紐付ける' });
  const countBefore = Number(
    (await page.getByRole('heading', { name: /^Evidence（\d+）/ }).innerText()).replace(/\D/g, ''),
  );

  for (const cell of ['Sheet1!C12', 'Sheet1!C13']) {
    await form.locator('select[name="fileVersionId"]').selectOption({ index: 1 });
    await form.locator('input[name="page"]').fill('2');
    await form.locator('input[name="cellRef"]').fill(cell);
    await form.getByRole('button', { name: '紐付ける' }).click();
    await page.waitForLoadState('networkidle');
  }

  // 反映は再検証のあとに来るので、件数の表示そのものを待つ
  await expect(
    page.getByRole('heading', { name: `Evidence（${countBefore + 2}）` }),
    'セル違いの 2 件が両方とも登録されるべき',
  ).toBeVisible();
});

test('まったく同じ箇所を二重に紐付けると理由が出る', async ({ page }) => {
  await openDataPointWithFiles(page);

  const form = page.locator('form', { hasText: '紐付ける' });
  await form.locator('select[name="fileVersionId"]').selectOption({ index: 1 });
  await form.locator('input[name="page"]').fill('2');
  await form.locator('input[name="cellRef"]').fill('Sheet1!C12');
  await form.getByRole('button', { name: '紐付ける' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('既に紐付いています');
});

test('ページ欄に数字以外を入れると理由が出る（黙って消えない）', async ({ page }) => {
  await openDataPointWithFiles(page);

  const form = page.locator('form', { hasText: '紐付ける' });
  await form.locator('select[name="fileVersionId"]').selectOption({ index: 1 });
  await form.locator('input[name="page"]').fill('abc');
  await form.locator('input[name="cellRef"]').fill('Sheet1!Z99');
  await form.getByRole('button', { name: '紐付ける' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('1 以上の整数');
});
