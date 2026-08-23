import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * PBC ボードと案件監査ログ。
 * ・差戻し中の依頼がどの列にも現れなかった
 * ・依頼に「対象」を指定する手段が無く、DB 列が常に null だった
 * ・監査ログが 200 件で無言に打ち切られ、総件数が分からなかった
 */
test.describe.configure({ mode: 'serial' });

async function openEngagement(page: import('@playwright/test').Page, path: string) {
  await page.goto('/assurance/engagements');
  // 他のテストが起票した案件は Data Room が空なので、Fixture の案件を名指しする
  const row = page.locator('tr', { hasText: 'ENG-2026-001' });
  await expect(row, 'Fixture の案件が一覧に無い').toBeVisible();
  const href = (await row
    .locator('a[href^="/assurance/engagements/"]')
    .first()
    .getAttribute('href'))!;
  const engagementId = href.split('/')[3]!;
  await page.goto(`/assurance/engagements/${engagementId}/${path}`);
  return engagementId;
}

test('PBC ボードの列の合計が依頼の総数と一致する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await openEngagement(page, 'requests');

  const total = Number(
    (await page.getByRole('heading', { name: /資料依頼（\d+）/ }).innerText()).replace(/\D/g, ''),
  );
  const labels = [
    '下書き',
    '送付済み・未提出',
    '提出済み・確認中',
    '差戻し・再提出待ち',
    '受理・クローズ',
  ];
  let sum = 0;
  for (const label of labels) {
    const block = page.getByText(label, { exact: true }).first().locator('..');
    const text = await block.innerText();
    sum += Number(text.replace(label, '').replace(/\D/g, '') || '0');
  }
  expect(sum, '盤面から消えている依頼がある').toBe(total);
});

test('資料依頼に対象を指定でき、一覧に表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await openEngagement(page, 'requests');

  const form = page.locator('form', { hasText: '送付' });
  const target = form.locator('select[name="targetId"]');
  await expect(target, '対象を選ぶ入力が無い').toBeVisible();

  const label = (await target.locator('option').nth(1).innerText()).trim();
  await target.selectOption({ index: 1 });
  await form.locator('input[name="title"]').fill('対象付きの資料依頼');
  await form.locator('input[name="dueDate"]').fill('2026-12-31');
  await form.getByRole('button', { name: '送付' }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('li', { hasText: '対象付きの資料依頼' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`対象: ${label}`);
});

test('案件監査ログが総件数を示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await openEngagement(page, 'audit-trail');

  await expect(
    page.getByRole('heading', { name: /案件の監査イベント（表示 \d+ \/ 全 \d+）/ }),
  ).toBeVisible();
});
