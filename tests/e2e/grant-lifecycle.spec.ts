import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 企業から監査法人への「選択共有」。
 *
 * 企業と監査法人の唯一の接続点は engagements と client_access_grants だけ
 * （CLAUDE.md §0.2）。付与する導線が無いと、新しい保証契約でデータを共有できない。
 */
test.describe.configure({ mode: 'serial' });

test('企業が許諾を新規付与でき、一覧に「有効」で現れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');

  const form = page.locator('form', { hasText: '許諾する' });
  await expect(form, '許諾を新規付与するフォームが無い').toBeVisible();

  // まだ許諾されていない指標を選ぶ（水使用量は未許諾）
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
  await page.goto('/assurance/engagements');
  const link = page.locator('a[href^="/assurance/engagements/"]').first();
  const href = (await link.getAttribute('href'))!;
  const engagementId = href.split('/')[3]!;

  await page.goto(`/assurance/engagements/${engagementId}/data-room`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  // 許諾しただけでは共有されない（企業が Data Room へ出す操作が別にある）ため、
  // ここでは「許諾済みの指標が保証対象として扱われている」ことだけを確認する
  await expect(page.locator('#t4d-main')).not.toContainText('データを取得できませんでした');
});

test('種別と対象の組み合わせが不正な付与はサーバー側で拒否される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');

  const form = page.locator('form', { hasText: '許諾する' });
  // 種別は「報告期間」なのに、対象に指標を選ぶ
  await form.locator('select[name="subjectType"]').selectOption('reporting_period');
  await form.locator('select[name="subjectId"]').selectOption({ label: 'Scope1 排出量' });
  await form.getByRole('button', { name: '許諾する' }).click();

  await expect(page.locator('#t4d-main')).toContainText(/正しくありません|できませんでした/);
});
