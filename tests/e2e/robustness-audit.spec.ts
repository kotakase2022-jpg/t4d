import { expect, test } from '@playwright/test';
import { ENGAGEMENT_IDS, dataPointId } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 壊れ方の監査（不正入力・API ルート・越権）。
 *
 * screen-audit は「正しい URL」を辿る。ここは**正しくない URL・不正な ID**を投げて、
 * 500 やスタックトレースではなく 404 / 403 / ログインへ、と行儀よく落ちることを確認する。
 * あわせて、画面クロールでは踏めない `/api/*` の Route Handler を直接叩く。
 */

test.describe.configure({ mode: 'serial' });

const ENGAGEMENT = ENGAGEMENT_IDS.main;

/**
 * API はページ内 fetch で叩く。
 * Playwright の `page.request` は BrowserContext の httpOnly Cookie を送らないため、
 * ログイン済みでも 401 になり実態を検証できない。アプリ自身と同じ経路（ページ内 fetch）で叩く。
 */
async function apiCall(
  page: import('@playwright/test').Page,
  url: string,
): Promise<{ status: number; finalPath: string; contentType: string }> {
  return page.evaluate(async (u) => {
    const response = await fetch(u);
    return {
      status: response.status,
      finalPath: new URL(response.url).pathname,
      contentType: response.headers.get('content-type') ?? '',
    };
  }, url);
}

/** 未ログイン・越権で「中身を返していない」こと。 */
function isDenied(result: { status: number; finalPath: string }): boolean {
  return result.status >= 400 || result.finalPath === '/login';
}
const BOGUS_UUID = '00000000-0000-4000-8000-0000deadbeef';

/** 存在しない ID の動的ルート。404 が正解（500 でもログインでもない）。 */
const BOGUS_ROUTES = [
  `/enterprise/data/${BOGUS_UUID}`,
  `/enterprise/disclosures/cdp/${BOGUS_UUID}`,
  `/enterprise/imports/${BOGUS_UUID}`,
  '/enterprise/disclosures/unknown-framework',
];

const BOGUS_ASSURANCE_ROUTES = [
  `/assurance/engagements/${BOGUS_UUID}/overview`,
  `/assurance/engagements/${BOGUS_UUID}/data-room`,
  `/assurance/engagements/${BOGUS_UUID}/testing`,
];

test('存在しない ID の企業ルートは 404 になる（500 にしない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  const problems: string[] = [];
  for (const route of BOGUS_ROUTES) {
    const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status !== 404) problems.push(`${route} — HTTP ${status}（404 を期待）`);
    // 描画完了を待つ（innerText を即読みすると描画途中で空になる）
    try {
      await expect(page.getByText('ページが見つかりません')).toBeVisible({ timeout: 10_000 });
    } catch {
      problems.push(`${route} — 404 画面が出ていない`);
    }
  }
  expect(problems.join('\n')).toBe('');
});

test('存在しない案件は 404 になる（存在を漏らさない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);

  const problems: string[] = [];
  for (const route of BOGUS_ASSURANCE_ROUTES) {
    const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status !== 404) problems.push(`${route} — HTTP ${status}（404 を期待）`);
  }
  expect(problems.join('\n')).toBe('');
});

test('未ログインでは API も保護される', async ({ page }) => {
  // origin 上に居ないと fetch できないのでログイン画面を開いてから Cookie を消す
  await page.goto('/login');
  await page.context().clearCookies();

  const endpoints = [
    '/api/exports/data-points',
    `/api/exports/engagement?engagementId=${ENGAGEMENT}`,
    `/api/files/signed-url?fileVersionId=${BOGUS_UUID}`,
    `/api/jobs/${BOGUS_UUID}`,
  ];

  const problems: string[] = [];
  for (const endpoint of endpoints) {
    const result = await apiCall(page, endpoint);
    if (!isDenied(result)) {
      problems.push(`${endpoint} — 未ログインなのに HTTP ${result.status} で応答した`);
    }
  }
  expect(problems.join('\n')).toBe('');
});

test('Export API が企業ユーザーに対して正しく応答する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');

  const csv = await apiCall(page, '/api/exports/data-points');
  expect(csv.status).toBe(200);
  expect(csv.contentType).toMatch(/csv|octet-stream/i);

  const cdp = await apiCall(page, '/api/exports/cdp');
  expect(cdp.status).toBe(200);

  // 不正な format は 400（500 にしない）
  const badFormat = await apiCall(page, '/api/exports/data-points?format=pdf');
  expect(badFormat.status).toBe(400);
});

test('他テナント・未アサインの案件 Export は拒否される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/dashboard');

  const own = await apiCall(page, `/api/exports/engagement?engagementId=${ENGAGEMENT}`);
  expect(own.status).toBe(200);

  const other = await apiCall(page, `/api/exports/engagement?engagementId=${ENGAGEMENT_IDS.other}`);
  expect(isDenied(other)).toBe(true);

  // 未アサインの法人管理者
  await loginAs(page, DEMO_USERS.assuranceAdmin);
  await page.goto('/assurance/dashboard');
  const unassigned = await apiCall(page, `/api/exports/engagement?engagementId=${ENGAGEMENT}`);
  expect(isDenied(unassigned)).toBe(true);
});

test('Signed URL API と Job API が不正入力で 500 にならない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');

  for (const url of [
    `/api/files/signed-url?fileVersionId=${BOGUS_UUID}`,
    '/api/files/signed-url',
    `/api/files/download?fileVersionId=${BOGUS_UUID}`,
    `/api/jobs/${BOGUS_UUID}`,
  ]) {
    const result = await apiCall(page, url);
    expect(result.status, url).toBeGreaterThanOrEqual(400);
    expect(result.status, url).toBeLessThan(500);
  }
});

test('別テナントの Data Point は URL 直打ちでも見えない', async ({ page }) => {
  // 蒼天マテリアルのユーザーで、青海テクノロジーの Data Point を開く
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  const ownId = dataPointId('EAST', 'scope1', 'FY2026');
  const own = await page.goto(`/enterprise/data/${ownId}`, { waitUntil: 'domcontentloaded' });
  expect(own?.status()).toBe(200);

  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  const response = await page.goto(`/enterprise/data/${ownId}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(404);
});

test('壊れたクエリ文字列でも一覧が落ちない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  const weird = [
    '/enterprise/data?page=-1',
    '/enterprise/data?page=abc',
    '/enterprise/data?page=99999',
    '/enterprise/data?status=not_a_status',
    `/enterprise/data?unit=${BOGUS_UUID}`,
    '/enterprise/data?q=' + encodeURIComponent('<script>alert(1)</script>'),
    '/enterprise/data?flag=nonsense',
  ];

  const problems: string[] = [];
  for (const url of weird) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 500) problems.push(`${url} — HTTP ${status}`);
    const body = await page.locator('body').innerText();
    if (body.includes('問題が発生しました')) problems.push(`${url} — Error 境界が出た`);
  }
  expect(problems.join('\n')).toBe('');
});
