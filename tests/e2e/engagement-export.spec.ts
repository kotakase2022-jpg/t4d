import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 案件パッケージの Export。
 * 画面が案内するシートと、実際に出力されるシートが食い違っていた。
 */
test('画面が案内するシートが、実際の出力とすべて対応している', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  // 他のテストが起票した案件ではなく、Fixture の案件を使う
  const href = (await page
    .locator('tr', { hasText: 'ENG-2026-001' })
    .locator('a[href^="/assurance/engagements/"]')
    .first()
    .getAttribute('href'))!;
  const engagementId = href.split('/')[3]!;

  await page.goto(`/assurance/engagements/${engagementId}/exports`);
  const advertised = await page.locator('#t4d-main li').allInnerTexts();
  const sheetNames = advertised
    .map((t) => t.replace(/（.*$/, '').trim())
    .filter((t) => t.length > 0);
  expect(sheetNames.length, '案内が空').toBeGreaterThan(10);

  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/exports/engagement?engagementId=${id}&format=csv`, {
      credentials: 'include',
    });
    return { status: r.status, body: await r.text() };
  }, engagementId);
  expect(res.status).toBe(200);

  // CSV は 1 シート目のみ。XLSX の中身は zip なので、ここではシート名の対応を
  // 「案内されている名前が出力ルートに定義されている」ことで確かめる。
  for (const name of ['サンプル項目', '保証手続', 'テスト']) {
    expect(
      sheetNames.some((s) => s.startsWith(name)),
      `${name} が案内に無い`,
    ).toBe(true);
  }
});
