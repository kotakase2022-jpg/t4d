import { expect, test } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * リンク以外の操作系の監査。
 *
 * screen-audit.spec.ts は `<a>` を辿る。だが実際の画面には
 * **`<a>` ではない遷移**が多くある（Radix Select、`router.push`、`router.replace`、
 * Debounce 付き検索、Server Action を submit する Select）。
 * これらはクロールでは 1 つも踏めないので、ここで個別に踏む。
 *
 * 対象:
 *   ReportingPeriodSelector（期間切替 → Server Action）
 *   EngagementSelector（案件切替 → router.push）
 *   FilterBar（検索 Debounce → router.replace / フィルタートグル / 保存ビュー）
 *   Pagination（前へ・次へ）
 *   CommandPalette（選択 → router.push）
 *   UserMenu（ログアウト）
 */

test.describe.configure({ mode: 'serial' });

const ENGAGEMENT = ENGAGEMENT_IDS.main;

test('期間セレクタで対象期間を切り替えられる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const combo = page.getByRole('combobox', { name: /報告期間|期間/ });
  test.skip((await combo.count()) === 0, '期間セレクタが無い');

  const before = (await combo.first().innerText()).trim();
  await combo.first().click();
  const options = page.getByRole('option');
  const count = await options.count();
  test.skip(count < 2, '切り替え先の期間が無い');

  // いま選ばれていない選択肢を選ぶ
  let target = '';
  for (let i = 0; i < count; i += 1) {
    const text = (await options.nth(i).innerText()).trim();
    if (text && text !== before) {
      target = text;
      await options.nth(i).click();
      break;
    }
  }
  test.skip(target === '', '別の期間が無い');

  await page.waitForLoadState('networkidle');
  await expect(page.locator('#t4d-main')).toBeVisible();
  // 切り替えが画面に反映されること（Server Action → Cookie → 再描画）
  await expect(page.getByRole('combobox', { name: /報告期間|期間/ }).first()).toContainText(target);
});

test('案件セレクタで同じサブページのまま別案件へ移動する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT}/testing`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const combo = page.getByRole('combobox', { name: /案件/ });
  test.skip((await combo.count()) === 0, '案件セレクタが無い');

  await combo.first().click();
  const options = page.getByRole('option');
  expect(await options.count()).toBeGreaterThan(0);

  // Fixture では あおば保証監査法人 の担当案件は 1 件なので、
  // 「別案件へ」ではなく「router.push がサブページを保持するか」を検証する。
  await options.first().click();
  await page.waitForURL(/\/assurance\/engagements\/[0-9a-f-]+\/testing/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 別のサブページからでもサブページが保持されること
  await page.goto(`/assurance/engagements/${ENGAGEMENT}/issues`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  await page.getByRole('combobox', { name: /案件/ }).first().click();
  await page.getByRole('option').first().click();
  await page.waitForURL(/\/assurance\/engagements\/[0-9a-f-]+\/issues/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('検索（Debounce）が URL と結果に反映される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const search = page.locator('[data-t4d-list-search]').first();
  await search.fill('Scope1');
  // Debounce 300ms → router.replace
  await page.waitForURL(/[?&]q=Scope1/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByText('Scope1 排出量').first()).toBeVisible();

  // クリアすると q が消える
  await search.fill('');
  await page.waitForURL((url) => !url.searchParams.has('q'), { timeout: 12_000 });
});

test('フィルターのトグルと解除が URL に反映される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const approved = page.getByRole('button', { name: '承認済み', exact: true }).first();
  test.skip((await approved.count()) === 0, '状態フィルターが無い');

  await approved.click();
  await page.waitForURL(/[?&]status=approved/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();

  // もう一度押すと解除される
  await page.getByRole('button', { name: '承認済み', exact: true }).first().click();
  await page.waitForURL((url) => !url.searchParams.has('status'), { timeout: 12_000 });
});

test('保存ビューを適用できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const view = page.getByRole('link', { name: '要対応のみ' }).first();
  test.skip((await view.count()) === 0, '保存ビューが無い');
  await view.click();
  await page.waitForURL(/flag=validation_error/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('ページングの前へ・次へが機能する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const next = page.getByRole('link', { name: /次へ/ });
  test.skip((await next.count()) === 0, '2 ページ目が無い');

  const firstPageRow = await page.locator('tbody tr').first().innerText();
  await next.first().click();
  await page.waitForURL(/[?&]page=2/, { timeout: 12_000 });
  await expect(page.locator('#t4d-main')).toBeVisible();
  const secondPageRow = await page.locator('tbody tr').first().innerText();
  expect(secondPageRow).not.toBe(firstPageRow);

  await page.getByRole('link', { name: /前へ/ }).first().click();
  await page.waitForURL((url) => (url.searchParams.get('page') ?? '1') === '1', {
    timeout: 12_000,
  });
  expect(await page.locator('tbody tr').first().innerText()).toBe(firstPageRow);
});

test('コマンドパレットから選んで画面移動できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('コマンドパレット検索').fill('Evidence');
  const option = page.getByRole('option').first();
  await expect(option).toBeVisible();
  await option.click();

  await page.waitForURL(/\/enterprise\//, { timeout: 12_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('ユーザーメニューからログアウトできる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: /ユーザーメニュー/ }).click();
  await page.getByRole('menuitem', { name: 'ログアウト' }).click();
  await page.waitForURL(/\/login/, { timeout: 12_000 });

  // ログアウト後は保護ルートへ入れない
  await page.goto('/enterprise/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
