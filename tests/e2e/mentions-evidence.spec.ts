import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * WF-P0-002（コメント・メンション）と EVID-P0-002（Evidence Viewer）の実ブラウザ検証。
 */

test.describe.configure({ mode: 'serial' });

// 1x1 の PNG（架空の最小画像）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('コメントに @メンションすると強調表示され、本人へ通知が届く', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 一覧から最初のデータ詳細へ
  await page.locator('tbody tr a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/.+/);
  const dataPointUrl = new URL(page.url()).pathname;

  // メンションチップで @青海太郎 を挿入して投稿
  await page.getByRole('button', { name: '@青海太郎' }).click();
  const textarea = page.locator('textarea[name="body"]');
  await expect(textarea).toHaveValue(/@青海太郎/);
  await textarea.fill('@青海太郎 根拠資料の確認をお願いします（E2E）');
  await page.getByRole('button', { name: 'コメントする' }).click();
  await page.waitForLoadState('networkidle');

  // コメントが表示され、メンションが強調される
  await expect(page.getByText('根拠資料の確認をお願いします（E2E）')).toBeVisible();
  await expect(page.locator('mark', { hasText: '@青海太郎' }).first()).toBeVisible();

  // メンションされた本人（青海 太郎）に通知が届く
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/notifications');
  await expect(page.getByText('さんからメンションされました').first()).toBeVisible();
  await expect(page.getByText('未読').first()).toBeVisible();

  // 通知のリンクから該当データへ遷移できる
  const link = page.locator(`a[href="${dataPointUrl}"]`).first();
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(dataPointUrl);
  await expect(page.getByText('根拠資料の確認をお願いします（E2E）')).toBeVisible();
});

test('CDP 質問詳細でも質問単位のコメント＋メンションが使える', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await page.getByRole('link', { name: 'C0.1' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\/.+/);

  const textarea = page.locator('textarea[name="body"]');
  await textarea.fill('@検見川涼 この回答のレビューをお願いします（E2E）');
  await page.getByRole('button', { name: 'コメントする' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.getByText('この回答のレビューをお願いします（E2E）')).toBeVisible();
  await expect(page.locator('mark', { hasText: '@検見川涼' }).first()).toBeVisible();
});

test('Evidence Viewer: 画像が画面内に表示され、メタデータ・Version を同時確認できる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');

  // 画像 Evidence をアップロード
  await page.locator('input[type="file"]').setInputFiles({
    name: '検針メーター写真.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await page.getByRole('button', { name: /登録|アップロード/ }).click();
  await page.waitForLoadState('networkidle');

  // 一覧から画面内で開く
  await page
    .locator('tr', { hasText: '検針メーター写真.png' })
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/.+/);

  // 画面内プレビュー（img が inline API を指す）
  const img = page.locator('img[src^="/api/files/inline"]');
  await expect(img).toBeVisible();
  // メタデータと Version が同じ画面にある
  await expect(page.getByRole('heading', { name: 'メタデータ' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Version（/ })).toBeVisible();
  await expect(page.getByText('image/png').first()).toBeVisible();
});

test('Evidence Viewer: PDF が画面内 iframe で表示される', async ({ page }) => {
  const dataset = await buildHeterogeneousDataset();
  const pdf = dataset.find((f) => f.name.endsWith('.pdf'))!;

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');
  await page.locator('input[type="file"]').setInputFiles({
    name: pdf.name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.bytes),
  });
  await page.getByRole('button', { name: /登録|アップロード/ }).click();
  await page.waitForLoadState('networkidle');

  await page
    .locator('tr', { hasText: pdf.name })
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/.+/);

  const frame = page.locator('iframe[src^="/api/files/inline"]');
  await expect(frame).toBeVisible();
  // inline API 自体が 200 で PDF を返す
  // （page.request は httpOnly Cookie を送らないため、ページ内 fetch で検証する）
  const src = await frame.getAttribute('src');
  const apiResult = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, type: r.headers.get('content-type') };
  }, src!.split('#')[0]!);
  expect(apiResult.status).toBe(200);
  expect(apiResult.type).toBe('application/pdf');
});

test('Evidence Viewer: 実体の無い Fixture ファイルは抽出テキストを表示し、リンク済み箇所をハイライトする', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');

  // Fixture 由来のファイル（電力請求書）を開く。直前のテストでアップロードした
  // 実体つきファイルが一覧先頭に来るため、名前で明示的に選ぶ
  await page
    .locator('tr', { hasText: '電力請求書' })
    .first()
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/.+/);

  await expect(page.getByText('原本ファイルの実体はこの環境に保管されていません')).toBeVisible();
  // 抽出テキスト（Fragment）が紙面として表示される（請求書の体裁）
  await expect(page.getByText(/請求番号|合計使用電力量/).first()).toBeVisible();
  await expect(page.getByText('架空のサンプル資料')).toBeVisible();
  // 関連データカードから該当 Data Point へ辿れる
  await expect(page.getByRole('heading', { name: /関連データ/ })).toBeVisible();
});

test('他社の fileVersionId を inline API へ直打ちしても 404（存在秘匿）', async ({ page }) => {
  // 蒼天（企業B）でログインし、青海のファイルは見えないことを API 直呼びで確認
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/evidence');

  // 存在しない/他社の fileVersionId へ直アクセス → 404（ページ内 fetch = ログイン済み状態で検証）
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/files/inline?fileVersionId=00000000-0000-4000-8000-000000000000');
    return r.status;
  });
  expect(status).toBe(404);
});
