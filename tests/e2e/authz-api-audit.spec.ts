import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 認可と API の実挙動監査（自己検証ミッション用）。
 *
 * UI でボタンを隠すだけでは不十分なので、**Server Action / API を直接叩いて**
 * サーバー側で権限とテナントが守られていることを確認する。
 * ブラウザ内 fetch を使うのは、httpOnly の認証 Cookie を送るため。
 */

test.describe.configure({ mode: 'serial' });

/** ページ内から fetch する（Cookie が付く） */
async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'include' });
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    return { status: res.status, body };
  }, path);
}

test('他テナントの Evidence は API 直叩きでも取得できない（存在も秘匿）', async ({ page }) => {
  // 企業 A でログインし、自社ファイルの ID を得る
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');
  const link = page.locator('a[href^="/enterprise/evidence/"]').first();
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;
  const fileId = href.split('/').pop()!;

  // 自社なら開ける
  const own = await apiGet(page, `/enterprise/evidence/${fileId}`);
  expect(own.status).toBe(200);

  // 別テナント（蒼天マテリアル）でログインし、同じ ID を叩く
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  const cross = await apiGet(page, `/enterprise/evidence/${fileId}`);
  expect(cross.status, '他テナントのファイルが見えている').toBe(404);
});

test('inline API は他テナントの fileVersion を返さない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  // 企業 A の fileVersionId は知り得ない前提だが、総当たりされても 404 であること
  const res = await apiGet(
    page,
    '/api/files/inline?fileVersionId=00000000-0000-4000-8000-000000000000',
  );
  expect([400, 404]).toContain(res.status);
});

test('権限の無いロールはエクスポート API を叩けない', async ({ page }) => {
  // レビュー担当は enterprise.import.run を持たない（拠点担当は持つので対象にしない）
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto('/enterprise/dashboard');
  const res = await apiGet(page, '/api/exports/template');
  expect(res.status, 'テンプレート出力が権限外でも通ってしまう').toBe(403);
});

test('未ログインでは API が 401 を返す', async ({ page }) => {
  await page.goto('/login');
  await page.context().clearCookies();
  const res = await apiGet(page, '/api/exports/template');
  expect(res.status).toBe(401);
});

test('存在しない ID の画面は 404 になる（500 にしない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/data/00000000-0000-4000-8000-000000000000',
    '/enterprise/evidence/00000000-0000-4000-8000-000000000000',
    '/enterprise/imports/00000000-0000-4000-8000-000000000000',
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} が 404 でない`).toBe(404);
  }
});

test('監査法人は許諾範囲外のクライアントデータへ到達できない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/dashboard');

  // 企業側の画面は監査法人には無い（URL 直打ちでも入れない）
  const res = await page.goto('/enterprise/data');
  const status = res?.status() ?? 0;
  const landed = new URL(page.url()).pathname;
  expect(
    status === 404 || landed.startsWith('/assurance') || landed === '/workspace',
    `監査法人が企業画面へ入れてしまう（status=${status}, landed=${landed}）`,
  ).toBe(true);
});

test('別テナントの監査法人は他社のエンゲージメントを開けない', async ({ page }) => {
  // 青海の担当監査法人でエンゲージメント ID を得る
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  const link = page.locator('a[href^="/assurance/engagements/"]').first();
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;

  // 別の監査法人でログインして同じ URL を叩く
  await loginAs(page, DEMO_USERS.otherAssuranceManager);
  await page.goto('/assurance/dashboard');
  const res = await page.goto(href);
  expect(res?.status(), '他法人のエンゲージメントが開けてしまう').toBe(404);
});
