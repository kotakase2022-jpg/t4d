import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs, openMoreMenu } from './helpers';

/**
 * CDP 整合チェックの画面実行導線（CDP-P0-006）。
 * 実ブラウザでボタンを押し、指摘が表示されることを確認する。
 */

test.describe.configure({ mode: 'serial' });

/**
 * 見出しの「その他」にある項目の名前（plan §2 S18: AI の実行・取込・出力は「その他」へ移した）。
 * 「その他」が無い役割（使える操作が 1 つも無い）は空。開いたメニューは閉じて返す
 */
async function moreMenuItems(page: Page): Promise<string[]> {
  const trigger = page.locator('#t4d-main [data-more-menu]').filter({ hasText: 'その他' });
  if ((await trigger.count()) === 0) return [];
  const menu = await openMoreMenu(page.locator('#t4d-main'));
  const items = await menu.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  return items;
}

test('CDP 画面から整合チェックを実行して指摘を表示できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 整合チェック（AI）は見出しの「その他」にある（開いてから押す）
  const menu = await openMoreMenu(page.locator('#t4d-main'));
  await menu.getByRole('menuitem', { name: '整合チェックを実行' }).click();

  // 結果は ?check=<aiRunId> へ遷移して表示される（再読込しても読み直せる）
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\?check=/);
  const heading = page.getByRole('heading', { name: /整合チェックの結果/ });
  await expect(heading).toBeVisible();

  // 指摘が 1 件以上あり、種別ラベルが日本語で出ている
  await expect(heading).toContainText(/（[1-9]\d* 件の指摘）/);
  // 結果の表は結果の節の中のものを見る（一覧の上に、閉じた「前の版との比較」の表が並ぶようになった。T7 の版の比較）
  const resultTable = page.getByRole('region', { name: /整合チェックの結果/ }).locator('table');
  await expect(resultTable.locator('tbody tr').first()).toBeVisible();
  await expect(resultTable).toContainText(
    /不足情報|古い記述|年度不一致|回答間の矛盾|Evidence 不足/,
  );

  // AI が確定しないことの明示
  await expect(page.getByText('AI は指摘のみを行います')).toBeVisible();

  // 再読込しても同じ結果が残る
  await page.reload();
  await expect(page.getByRole('heading', { name: /整合チェックの結果/ })).toBeVisible();
});

test('AI 実行権限が無いロールにはボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: '整合チェックを実行' })).toHaveCount(0);
  // 「その他」の中にも出ない（置き場所を移しても、権限の無い役割には出さない）
  expect((await moreMenuItems(page)).filter((t) => t.includes('整合チェックを実行'))).toEqual([]);
});

test('他組織の check ID を指定しても結果は表示されない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // 実在しない／権限の無い runId
  await page.goto('/enterprise/disclosures/cdp?check=00000000-0000-4000-8000-000000000000');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('heading', { name: /整合チェックの結果/ })).toHaveCount(0);
});

test('CDP 画面から適用判定を実行し、判定と根拠が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 実行前は「未判定」
  await expect(page.getByText('未判定').first()).toBeVisible();

  await page.getByRole('button', { name: '適用判定を実行' }).click();
  await page.waitForURL(/applicability=1/);

  // 集計行に 3 区分が出る
  const summary = page.getByText('適用判定:').locator('..');
  await expect(summary).toContainText('適用');
  await expect(summary).toContainText('非適用');
  await expect(summary).toContainText('要確認');

  // 行のバッジに判定根拠が title として付く
  const conditional = page.locator('tbody tr', { hasText: 'C1.1b' }).first();
  await expect(conditional).toBeVisible();
  const badge = conditional.locator('[title]').first();
  await expect(badge).toHaveAttribute('title', /C1\.1/);

  // 条件の無い質問は「適用」
  const unconditional = page.locator('tbody tr', { hasText: 'C0.1' }).first();
  await expect(unconditional.locator('[title]').first()).toHaveAttribute(
    'title',
    /適用条件が設定されていない/,
  );
});

test('開示の書き込み権限が無いロールには適用判定ボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: '適用判定を実行' })).toHaveCount(0);
  expect((await moreMenuItems(page)).filter((t) => t.includes('適用判定を実行'))).toEqual([]);
});
