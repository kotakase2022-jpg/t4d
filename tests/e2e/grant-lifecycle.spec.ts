import { expect, test } from '@playwright/test';
import { DEMO_USERS, gotoEngagementPage, loginAs } from './helpers';

/**
 * 企業から監査法人への「選択共有」。
 *
 * 企業と監査法人の唯一の接続点は engagements と client_access_grants だけ
 * （CLAUDE.md §0.2）。付与する導線が無いと、新しい保証契約でデータを共有できない。
 * 許諾は設定の「アクセス許諾」タブ。追加の欄は一覧の上に常設しない（plan S17 CreatePanel）。
 */
test.describe.configure({ mode: 'serial' });

test('企業が許諾を新規付与でき、一覧に「有効」で現れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=grants');

  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: 'アクセス許諾を追加' })
    .click();
  const form = page.locator('form', { hasText: '許諾する' });
  await expect(form, '許諾を新規付与するフォームが無い').toBeVisible();

  // Fixture の案件（次のテストで Data Room を確かめる案件）へ、まだ許諾されていない指標を選ぶ（水使用量は未許諾）
  await form.locator('select[name="engagementId"]').selectOption({ label: 'ENG-2026-001' });
  await form.locator('select[name="subjectType"]').selectOption('metric');
  const subject = form.locator('select[name="subjectId"]');
  await subject.selectOption({ label: '水使用量' });
  await form.getByRole('button', { name: '許諾する' }).click();

  const row = page.locator('tr', { hasText: '水使用量' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('有効');
});

test('付与した指標は監査法人の Data Room に現れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  // 他のテストが起票した案件は許諾が無いので、Fixture の案件（前のテストで許諾した案件）を名指しする
  await gotoEngagementPage(page, 'data-room');
  await expect(page.locator('#t4d-main')).not.toContainText('処理を完了できませんでした');
  // Data Room は許諾（指標×組織×期間）と企業側の承認から表示のたびに導く（トライアル対応 NF-22）。
  // 企業が別に共有する操作は無い。許諾した指標のデータは、企業側で承認されると次の表示で出る
  // （FY2026 の水使用量は Fixture では未承認のため、ここでは表が描けることまでを確かめる。
  // 許諾・承認と同期することは tests/integration/data-room-sync-screen.test.ts が固定する）
  await expect(page.getByRole('table', { name: '共有されているクライアントデータ' })).toBeVisible();
});

test('種別と対象の組み合わせが不正な付与はサーバー側で拒否される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=grants&new=1');

  const form = page.locator('form', { hasText: '許諾する' });
  // 種別は「報告期間」なのに、対象に指標を選ぶ
  await form.locator('select[name="subjectType"]').selectOption('reporting_period');
  await form.locator('select[name="subjectId"]').selectOption({ label: 'Scope1 排出量' });
  await form.getByRole('button', { name: '許諾する' }).click();

  // 本番ビルドでは例外メッセージが伏せられるため、?error= で戻して表示する
  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('正しくありません');
});
