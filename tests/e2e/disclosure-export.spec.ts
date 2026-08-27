import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 開示ドラフトの Export。
 * 以前は CDP 固定で、SSBJ / CSRD を出す手段がまったく無かった。
 */

/** ページ内から fetch する（Cookie が付く） */
async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'include' });
    return {
      status: res.status,
      disposition: res.headers.get('content-disposition') ?? '',
      body: (await res.text()).slice(0, 400),
    };
  }, path);
}

test('SSBJ の開示ドラフトを DOCX で出力できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  // 書き出しは開示ドラフトの画面にある（草案を作る場所と同じ）
  await page.goto('/enterprise/disclosures/ssbj/draft');

  const link = page.getByRole('link', { name: /Word で書き出す/ });
  await expect(link, 'SSBJ の Export 導線が無い').toBeVisible();

  const href = (await link.getAttribute('href'))!;
  const res = await apiGet(page, href);
  expect(res.status).toBe(200);
  // ファイル名に framework が入る（CDP のものが出ていない）
  expect(decodeURIComponent(res.disposition)).toContain('SSBJ');
});

test('レポート画面から SSBJ / CSRD を出力できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/reports');

  await expect(page.getByText('SSBJ 開示ドラフト')).toBeVisible();
  await expect(page.getByText('CSRD 開示ドラフト')).toBeVisible();

  for (const framework of ['ssbj', 'csrd']) {
    const res = await apiGet(page, `/api/exports/cdp?framework=${framework}&format=csv`);
    expect(res.status, `${framework} の CSV が出せない`).toBe(200);
    expect(res.body.length, `${framework} の中身が空`).toBeGreaterThan(0);
  }
});

test('知らない framework を指定すると 400 になる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/reports');
  const res = await apiGet(page, '/api/exports/cdp?framework=unknown&format=csv');
  expect(res.status).toBe(400);
});
