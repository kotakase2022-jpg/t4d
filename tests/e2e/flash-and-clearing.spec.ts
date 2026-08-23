import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 「操作したのに何も起きないように見える」問題の回帰テスト。
 * 完了メッセージはリダイレクト先の URL に載っているが、読み取る側が無いと
 * 成功したのか失敗したのか分からないまま一覧へ戻ることになる。
 */
test('前年度から複製すると、完了メッセージが表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');

  await page.getByRole('button', { name: '前年度から複製' }).click();
  await page.waitForURL(/flash=carried/);

  const status = page.getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('前年度から');
});

test('開示回答の数値欄に数値でない文字列を入れると、黙って消えずに理由が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  // 数値回答型（answerType='numeric'）の質問を探す。
  await page.goto('/enterprise/disclosures/cdp');
  const hrefs = await page
    .locator('a[href^="/enterprise/disclosures/cdp/"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href')).filter((h): h is string => !!h));

  let found = false;
  for (const href of hrefs) {
    if (href.endsWith('/import')) continue;
    await page.goto(href);
    if ((await page.locator('input[name="answerNumeric"]').count()) > 0) {
      found = true;
      break;
    }
  }
  expect(found, '数値回答型の質問が seed に必要').toBe(true);

  await page.locator('input[name="answerNumeric"]').fill('abc');
  await page.getByRole('button', { name: /保存/ }).first().click();
  await expect(page.locator('#t4d-main')).toContainText(/数値を入力|できませんでした/);
});
