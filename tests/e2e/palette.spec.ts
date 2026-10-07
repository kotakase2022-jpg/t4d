import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * Command Palette・全体検索・熟練者の操作（docs/ui-redesign/plan.md §1.10・§1.11・§5.4 Expert Efficiency）。
 *
 * - ヘッダーの「検索」と Ctrl+K で開く。最近使った画面・おすすめ・操作・画面・データを引ける
 * - 選ぶとその画面へ移るだけ（承認・確定は移った先で人が押す）
 * - ? でヘルプ（ショートカットと用語集）、g → d で非財務データへ
 */

const input = (page: import('@playwright/test').Page) =>
  page.getByRole('combobox', { name: 'コマンドパレット検索' });

test('ヘッダーの「検索」から開け、最近使った画面とおすすめが空の入力で出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // 最近使った画面を 1 つ作る
  await page.goto('/enterprise/ghg');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/enterprise/dashboard');

  await page.locator('[data-t4d-palette-trigger]').click();
  await expect(input(page)).toBeFocused();
  const recent = page.getByRole('group', { name: '最近使った画面' });
  await expect(recent.getByRole('option').first()).toBeVisible();
  await expect(recent.locator('[data-palette-href="/enterprise/ghg"]')).toBeVisible();
  // 作成担当のおすすめ（原稿・取込・SSBJ 要求事項・開示プロジェクト）
  const recommended = page.getByRole('group', { name: 'おすすめ' });
  await expect(recommended.getByRole('option')).toHaveText([
    /原稿を書く/,
    /取込を始める/,
    /SSBJ 要求事項/,
    /開示プロジェクト/,
  ]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('データ（指標）を名前で引いて、その一覧の絞り込みへ移る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.keyboard.press('Control+k');
  await input(page).fill('水使用量');
  const data = page.getByRole('group', { name: 'データ' });
  const option = data.getByRole('option', { name: /水使用量/ }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.waitForURL(/\/enterprise\/data\?metric=/);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('操作（タスク動詞）を選ぶと絞り込んだ画面へ移るだけで、実行はしない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.keyboard.press('Control+k');
  await input(page).fill('差戻しを直す');
  const option = page
    .getByRole('group', { name: '操作' })
    .getByRole('option', { name: /差戻しを直す（データ）/ });
  await option.click();
  await page.waitForURL(/\/enterprise\/data\?status=returned/);
  // 拠点担当は担当拠点で絞った一覧（unit=）
  expect(new URL(page.url()).searchParams.getAll('unit').length).toBeGreaterThan(0);
});

test('メニュー外の画面（SSBJ の設定）もパレットから開ける', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.keyboard.press('Control+k');
  await input(page).fill('マテリアリティ・分析条件');
  await page
    .getByRole('group', { name: '画面' })
    .locator('[data-palette-href="/enterprise/disclosures/ssbj/settings"]')
    .click();
  await page.waitForURL('**/enterprise/disclosures/ssbj/settings');
});

test('? でヘルプ（用語集つき）、g → d で非財務データへ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.locator('#t4d-main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'ヘルプ' });
  await expect(help).toBeVisible();
  await help.getByRole('tab', { name: '用語集' }).click();
  await expect(help.getByText('Data Room', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await page.waitForURL('**/enterprise/data');
});
