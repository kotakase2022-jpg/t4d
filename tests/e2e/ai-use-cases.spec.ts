import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 「利用できる AI 機能」に並んでいるのに、アプリ内から実行できない機能があった。
 * 画面から実行できることを確かめる。AI は指摘するだけで、値は変えない。
 */
test('検証で指摘のある Data Point で、AI に原因を説明させられる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  // 検証エラーのある行を探す
  await page.goto('/enterprise/data?flag=validation_error');
  const link = page.locator('a[href^="/enterprise/data/"]').first();
  await expect(link, '検証エラーのある Data Point が seed に必要').toBeVisible();
  const href = (await link.getAttribute('href'))!;

  await page.goto(href);
  const button = page.getByRole('button', { name: 'AI に原因を説明させる' });
  await expect(button, 'AI 実行の導線が無い').toBeVisible();

  const valueBefore = await page.locator('input[name="value"]').inputValue();

  await button.click();
  await page.waitForURL(/explain=/);

  await expect(page.getByText('考えられる原因:').first()).toBeVisible();
  await expect(page.getByText('次の一手:').first()).toBeVisible();
  // AI は値を変えない
  expect(await page.locator('input[name="value"]').inputValue()).toBe(valueBefore);
});

test('他人の実行結果 ID を指定しても表示されない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data?flag=validation_error');
  const href = (await page.locator('a[href^="/enterprise/data/"]').first().getAttribute('href'))!;

  await page.goto(`${href}?explain=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText('考えられる原因:')).toHaveCount(0);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('CDP で質問マッピングを実行すると候補が表示される（確定はしない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/disclosures/cdp');

  const button = page.getByRole('button', { name: '質問マッピングを実行' });
  await expect(button, 'AI 実行の導線が無い').toBeVisible();

  await button.click();
  await page.waitForURL(/mapping=/);

  await expect(page.getByText(/質問マッピングの候補/)).toBeVisible();
  await expect(page.getByText('候補です。実際の紐付けは質問ごとに確定してください')).toBeVisible();
});

test('Data Point で AI に Evidence 候補を探させられる（紐付けは確定しない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  const href = (await page.locator('a[href^="/enterprise/data/"]').first().getAttribute('href'))!;
  await page.goto(href);

  const button = page.getByRole('button', { name: 'AI に Evidence 候補を探させる' });
  await expect(button, 'AI 実行の導線が無い').toBeVisible();

  const linkedBefore = await page.getByRole('heading', { name: /^Evidence（/ }).innerText();
  await button.click();
  await page.waitForURL(/evidence=/);

  await expect(page.getByText(/AI の候補（確信度/)).toBeVisible();
  // 候補を出しただけで、紐付け件数は変わらない
  await expect(page.getByRole('heading', { name: /^Evidence（/ })).toHaveText(linkedBefore);
});

test('監査法人が Evidence を AI に要約させられる（結論は出さない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  // 他のテストが起票した案件ではなく、Fixture の案件を使う
  const href = (await page
    .locator('tr', { hasText: 'ENG-2026-001' })
    .locator('a[href^="/assurance/engagements/"]')
    .first()
    .getAttribute('href'))!;
  const engagementId = href.split('/')[3]!;

  // Evidence が紐付いているサンプルを探す（紐付いていない項目もある）
  await page.goto(`/assurance/engagements/${engagementId}/testing`);
  const items = await page
    .locator('a[href*="/testing?item="]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href')!).filter(Boolean));
  let found = false;
  for (const item of items) {
    await page.goto(item);
    if ((await page.getByRole('button', { name: 'AI に要約させる' }).count()) > 0) {
      found = true;
      break;
    }
  }
  expect(found, 'Evidence が紐付いたサンプルが seed に必要').toBe(true);

  await page.getByRole('button', { name: 'AI に要約させる' }).first().click();
  await page.waitForURL(/evidenceSummary=/);

  await expect(page.getByText('Evidence の AI 要約')).toBeVisible();
  await expect(page.getByText('要約であり保証結論ではありません')).toBeVisible();
  await expect(page.getByText('確かめること')).toBeVisible();
});
