import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * マスターデータ管理 UI（MASTER-P0-001 / ORG-P0-001）。
 * 実ブラウザで追加・編集し、一覧へ反映されることを確認する。
 *
 * 組織・拠点はタブ（?tab=）に分かれた（plan §2 S10）。指標・収集キャンペーンの追加は専用ページ、
 * 組織の追加・編集はタブの中の作成パネル・編集パネルで行う（モーダルをやめた）。
 */

test.describe.configure({ mode: 'serial' });

/** 見出し「指標マスター（N）」の N（一覧はページ送りなので、件数は見出しで数える） */
async function metricTotal(page: Page): Promise<number> {
  const text = await page.getByRole('heading', { name: /^指標マスター（\d+）$/ }).innerText();
  return Number(/（(\d+)）/.exec(text)?.[1]);
}

test('企業管理者は指標マスターを追加できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=metrics');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const before = await metricTotal(page);

  await page.getByRole('link', { name: '指標を追加', exact: true }).click();
  await page.waitForURL('**/enterprise/organizations/metrics/new');
  const form = page.getByRole('form', { name: '指標を追加' });
  await expect(form).toBeVisible();

  const code = `QA_${Date.now().toString().slice(-6)}`;
  await form.locator('input[name="code"]').fill(code);
  await form.locator('input[name="name"]').fill('QA テスト指標');
  await form.locator('input[name="unit"]').fill('件');
  await form.getByRole('button', { name: '追加する' }).click();

  // 追加したら指標マスターのタブへ戻り、追加した指標で絞って見せる
  await page.waitForURL(/tab=metrics.*flash=masterMetricCreated/);
  await expect(page.getByText(code).first()).toBeVisible();
  await expect(
    page.locator('#t4d-main').getByText('指標「QA テスト指標」を追加しました。'),
  ).toBeVisible();
  expect(await metricTotal(page)).toBe(before + 1);
});

test('企業管理者は組織の連結方法と持分を編集できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 組織を 1 件追加してから編集する（Fixture を汚さない）
  const code = `U${Date.now().toString().slice(-6)}`;
  await page.getByRole('link', { name: '組織を追加', exact: true }).click();
  const create = page.getByRole('form', { name: '組織を追加' });
  await create.locator('input[name="code"]').fill(code);
  await create.locator('input[name="name"]').fill('QA テスト拠点');
  await create.getByRole('button', { name: '追加する' }).click();
  await page.waitForURL(/flash=masterUnitCreated/);

  const row = page.locator('tbody tr', { hasText: code });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: '編集' }).click();

  const edit = page.getByRole('form', { name: 'QA テスト拠点 を編集' });
  await edit.locator('select[name="consolidationMethod"]').selectOption('equity');
  await edit.locator('input[name="ownershipPercent"]').fill('35');
  await edit.getByRole('button', { name: '更新する' }).click();
  await page.waitForURL(/flash=masterUnitUpdated/);

  const updatedRow = page.locator('tbody tr', { hasText: code });
  await expect(updatedRow).toContainText('持分法');
  await expect(updatedRow).toContainText('35%');
});

test('権限のないロールには追加の操作が出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  for (const [tab, label] of [
    ['metrics', '指標を追加'],
    ['units', '組織を追加'],
  ] as const) {
    await page.goto(`/enterprise/organizations?tab=${tab}`);
    await expect(page.locator('#t4d-main')).toBeVisible();
    // ボタンからリンク（専用ページ・作成パネルを開く）に変わった。どちらの形でも出ないこと
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    await expect(page.getByRole('link', { name: label })).toHaveCount(0);
  }
  // 専用ページを直接開いても入力欄は出さず、必要な権限と依頼先を示す
  await page.goto('/enterprise/organizations/metrics/new');
  await expect(page.getByText('アクセス権限がありません')).toBeVisible();
  await expect(page.locator('input[name="code"]')).toHaveCount(0);
});

test('企業管理者は収集キャンペーンを作成できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations?tab=campaigns');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.getByRole('link', { name: 'キャンペーンを作成', exact: true }).click();
  await page.waitForURL('**/enterprise/organizations/campaigns/new');
  const form = page.getByRole('form', { name: '収集キャンペーンを作成' });
  await expect(form).toBeVisible();

  // ① 範囲: 既定（連結対象の拠点・前回の指標）を外し、対象組織を 2 件、対象指標を 2 件選ぶ
  await form.getByRole('button', { name: '対象組織をすべて外す' }).click();
  await form.getByRole('button', { name: '対象指標をすべて外す' }).click();
  const unitBoxes = form.locator('input[name="unitIds"]');
  await unitBoxes.nth(0).check();
  await unitBoxes.nth(1).check();
  const metricBoxes = form.locator('input[name="metricIds"]');
  await metricBoxes.nth(0).check();
  await metricBoxes.nth(1).check();
  await expect(form.getByText('対象 2 組織 × 2 指標 ＝ 収集スコープ 4 件').first()).toBeVisible();
  await form.getByRole('button', { name: '次へ（期限・説明）' }).click();

  // ② 期限・説明
  const name = `QA キャンペーン ${Date.now().toString().slice(-5)}`;
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="dueDate"]').fill('2026-09-30');
  await form.getByRole('button', { name: '作成する' }).click();
  await page.waitForURL(/tab=campaigns.*flash=masterCampaignCreated/);

  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  // 2 組織 × 2 指標 = 4 スコープ
  await expect(row).toContainText('4 件');
});
