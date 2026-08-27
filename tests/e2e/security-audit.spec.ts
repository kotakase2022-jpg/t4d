import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * セキュリティの実挙動監査（自己検証ミッション用）。
 *
 * 「入力した文字列がスクリプトとして実行されない」「外部サイトへ飛ばされない」
 * を実ブラウザで確認する。
 */

test.describe.configure({ mode: 'serial' });

test('XSS: コメントに script を入れても実行されない（文字として表示される）', async ({ page }) => {
  const alerts: string[] = [];
  page.on('dialog', async (d) => {
    alerts.push(d.message());
    await d.dismiss();
  });

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await page.locator('tbody a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const box = page.locator('textarea[name="body"]').first();
  test.skip((await box.count()) === 0, 'コメント欄が出ていない');

  const marker = Date.now().toString(36);
  const payload = `<script>alert('xss-${marker}')</script><img src=x onerror="alert('xss2')">`;
  await box.fill(payload);
  await page.getByRole('button', { name: 'コメントする' }).first().click();
  await page.waitForLoadState('networkidle');

  await page.goto(url);
  // ダイアログが出ていない
  expect(alerts, 'XSS が実行された').toEqual([]);
  // 文字としてそのまま表示される
  await expect(page.getByText(payload)).toBeVisible();
  // 注入された img 要素が DOM に生えていない
  const injected = await page.locator('img[src="x"]').count();
  expect(injected, 'HTML として解釈されている').toBe(0);
});

test('XSS: 検索クエリに script を入れても実行されない', async ({ page }) => {
  const alerts: string[] = [];
  page.on('dialog', async (d) => {
    alerts.push(d.message());
    await d.dismiss();
  });

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(
    `/enterprise/data?q=${encodeURIComponent('<script>alert(1)</script><img src=x onerror=alert(2)>')}`,
  );
  await expect(page.locator('#t4d-main')).toBeVisible();
  expect(alerts, 'XSS が実行された').toEqual([]);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
});

test('Open redirect: 外部 URL へのリダイレクトが起きない', async ({ page, baseURL }) => {
  await loginAs(page, DEMO_USERS.sustainability);

  for (const q of [
    '/workspace?next=https://example.com',
    '/login?redirect=https://example.com',
    '/enterprise/data?returnTo=//example.com',
  ]) {
    await page.goto(q);
    // 同一オリジンに留まっていること（クエリに外部 URL が残るのは無害。
    // アプリはこれらのパラメータを遷移先として使っていない）
    const host = new URL(page.url()).host;
    // ポート直書きだと E2E_PORT に依存して落ちるため、baseURL から導出する
    expect(host, `${q} で外部へ飛ばされた`).toBe(new URL(baseURL ?? '').host);
  }
});

test('CSP: script-src に unsafe-inline が無く、nonce ベースである', async ({ page }) => {
  const res = await page.goto('/login');
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp, 'CSP ヘッダーが無い').toContain('script-src');
  expect(csp).toContain("'nonce-");
  expect(csp, 'script-src に unsafe-inline が含まれる').not.toMatch(
    /script-src[^;]*'unsafe-inline'/,
  );
  expect(csp).toContain("frame-ancestors 'none'");
});

test('アップロード: 許可されない拡張子は受け付けない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  await page.locator('input[type=file][name=files]').setInputFiles({
    name: 'malicious.exe',
    mimeType: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForLoadState('networkidle');

  // 拒否の理由を画面の中で伝える。
  // 以前は「Internal Server Error」の文字列だけを見ていたため、
  // 日本語のエラー画面（データを取得できませんでした）に落ちても検知できなかった。
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('malicious.exe');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveText(/Internal Server Error/);
});
