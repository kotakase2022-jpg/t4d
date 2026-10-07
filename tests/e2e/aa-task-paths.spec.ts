import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 主要タスクのクリック数（docs/ui-redesign/plan.md §0.2・§5.2 task-paths。基準は inventory-navigation.md §7.1）。
 *
 * ホーム（ログイン直後の画面）から、その作業の最後の操作（提出・承認・作成・許諾 など）を押せる画面
 * または対象の行が見える画面に着くまでの操作を数え、§0.2 の目標以下であることを確かめる。
 * 数え方は §7.1 と同じ: クリック・ショートカット（Ctrl+K）を 1 と数え、値や検索語の入力は数えない。
 * 最後の操作そのもの（提出・承認など。人が押す）は数えない（変更前の数え方の「行まで」と同じ）。
 *
 * 画面を開くだけで状態を変えない。デモの状態に左右されないよう、全件の最初に流す（ファイル名の aa-）。
 */

test.describe.configure({ mode: 'serial' });

/** 操作の回数を数える（クリック・ショートカット） */
class Steps {
  count = 0;
  constructor(private readonly page: Page) {}
  async click(target: ReturnType<Page['locator']>): Promise<void> {
    this.count += 1;
    await target.click();
  }
  async palette(): Promise<ReturnType<Page['getByRole']>> {
    this.count += 1;
    await this.page.keyboard.press('Control+k');
    const input = this.page.getByRole('combobox', { name: 'コマンドパレット検索' });
    await expect(input).toBeVisible();
    return input;
  }
}

async function paletteOption(page: Page, href: string) {
  const option = page.locator(`[role="option"][data-palette-href="${href}"]`).first();
  await expect(option).toBeVisible();
  return option;
}

test('C1: 拠点担当が自拠点の未入力データを開く（目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  // ホームの「自分が次に行う作業」の「入力する」→ 担当拠点で絞った一覧 → 行
  await steps.click(page.locator('tr[data-work-kind="data-enter"] a').first());
  await page.waitForURL(/\/enterprise\/data\?/);
  expect(page.url()).toContain('unit=');
  await steps.click(page.locator('tbody tr[data-t4d-record] a[href^="/enterprise/data/"]').first());
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  await expect(page.locator('#t4d-main [data-page-actions]')).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C2: 拠点担当が差し戻されたデータを開く（目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  await steps.click(page.locator('tr[data-work-kind="data-returned"] a').first());
  await page.waitForURL(/status=returned/);
  await steps.click(page.locator('tbody tr[data-t4d-record] a[href^="/enterprise/data/"]').first());
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  // 差し戻されたデータの主操作は「提出」（値が保存済みのとき）
  await expect(page.locator('#t4d-main [data-page-actions]')).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C4: 最終承認者が承認待ちのデータを開く（目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  await steps.click(page.locator('tr[data-work-kind="data-approve"] a').first());
  await page.waitForURL(/status=in_review/);
  await steps.click(page.locator('tbody tr[data-t4d-record] a[href^="/enterprise/data/"]').first());
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C5: 作成担当が開示プロジェクトの作成を始める（従来メニュー。目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  const input = await steps.palette();
  await input.fill('プロジェクトを作');
  await steps.click(await paletteOption(page, '/enterprise/disclosure-projects/new'));
  await page.waitForURL(/\/enterprise\/disclosure-projects\/new/);
  await expect(page.locator('#pf-name')).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C6: 管理者が ESG の目標の登録を始める（目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  const input = await steps.palette();
  await input.fill('目標を登録');
  await steps.click(await paletteOption(page, '/enterprise/esg/targets?new=1'));
  await page.waitForURL(/\/enterprise\/esg\/targets\?new=1/);
  await expect(page.locator('select[name="metricId"]')).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C8: 企業管理者が監査法人へのアクセス許諾を開く（目標 2）。作成担当には行き先を出さない', async ({
  page,
}) => {
  // 設定の入口は企業管理者のまま（権限の挙動は変えない。R1・plan Q6 は見送り）。
  // 作成担当には、開けない画面への候補をパレットに出さない
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'コマンドパレット検索' });
  await search.fill('アクセス許諾');
  // 作成担当が開ける画面・操作には「アクセス許諾」に当たるものが無い（設定の行き先を出さない）
  await expect(page.getByText('一致する画面がありません')).toBeVisible();
  await expect(
    page.locator('[role="option"][data-palette-href^="/enterprise/settings"]'),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  const input = await steps.palette();
  await input.fill('アクセス許諾');
  await steps.click(await paletteOption(page, '/enterprise/settings?tab=grants'));
  await page.waitForURL(/\/enterprise\/settings\?tab=grants/);
  await expect(page.getByText('アクセス権限がありません')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'アクセス許諾を追加' })).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C9: 監査法人の担当者が未完了の資料依頼を開く（目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceStaff);
  await page.goto('/assurance/dashboard');
  const steps = new Steps(page);
  // KPI は案件と状態で絞った行き先（担当の案件が 1 つならその案件の PBC へ直行）
  await steps.click(page.locator('a[data-metric-tile]', { hasText: '未完了の資料依頼' }));
  await page.waitForURL(/\/assurance\/(engagements\/[^/]+\/requests|dashboard\?focus=pbc)/);
  if (new URL(page.url()).pathname === '/assurance/dashboard') {
    // 複数の案件があるときは、絞った案件の表から案件の PBC へ
    await steps.click(page.locator('#engagements tbody a').first());
  }
  await expect(page.locator('#t4d-main')).toBeVisible();
  expect(steps.count).toBeLessThanOrEqual(2);
});

test('C10: 指標を名前で引いて開く（データ検索。目標 2）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  const steps = new Steps(page);
  const input = await steps.palette();
  await input.fill('水使用量');
  const option = page
    .locator('[role="option"][data-palette-href]', { hasText: '水使用量' })
    .first();
  await expect(option).toBeVisible();
  const href = (await option.getAttribute('data-palette-href')) ?? '';
  await steps.click(option);
  await page.waitForURL((url) => url.pathname === href.split(/[?#]/)[0]);
  expect(steps.count).toBeLessThanOrEqual(2);
});
