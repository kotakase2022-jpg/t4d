import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';

/**
 * 本番スモークテスト（自己検証ミッション用）。
 *
 *   PROD_BASE_URL=https://terrast-t4d.vercel.app pnpm exec playwright test production-smoke
 *
 * 本番は Demo Mode（架空データ・環境変数なし）なので、
 * 本番データを壊す操作は行わない。読み取りと、Demo データ上での
 * 一時的な操作（コメント・マテリアリティ評価）に留める。
 */

const BASE = process.env.PROD_BASE_URL ?? 'https://terrast-t4d.vercel.app';

test.describe.configure({ mode: 'serial' });

/** 本番のデモログイン（パスワード不要） */
async function prodLogin(page: import('@playwright/test').Page, displayName: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole('heading', { name: 'デモログイン' })).toBeVisible();
  // 別テナントのアカウントは折りたたみの中にあるので、必要なら開く
  const details = page.locator('details', { hasText: '越権テスト用' });
  if ((await details.count()) > 0) {
    const open = await details.first().evaluate((el: HTMLDetailsElement) => el.open);
    if (!open) await details.first().locator('summary').click();
  }
  await page.locator('form', { hasText: displayName }).getByRole('button').first().click();
  await page.waitForURL(/\/workspace|\/enterprise|\/assurance/);
  if (new URL(page.url()).pathname === '/workspace') {
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL(/\/(enterprise|assurance)\//);
  }
}

test('本番: 主要画面が描画され、コンソール・ネットワークに異常が無い', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('Download the React DevTools')) return;
    problems.push(`console: ${t.slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) {
      problems.push(`network: ${r.status()} ${r.url().replace(BASE, '')}`);
    }
  });

  await prodLogin(page, '青海 太郎');

  for (const path of [
    '/enterprise/dashboard',
    '/enterprise/data',
    '/enterprise/imports',
    '/enterprise/organizations',
    '/enterprise/evidence',
    '/enterprise/workflows',
    '/enterprise/ghg',
    '/enterprise/disclosures/cdp',
    '/enterprise/disclosures/ssbj',
    '/enterprise/disclosures/csrd',
    '/enterprise/alerts',
    '/enterprise/ai',
    '/enterprise/reports',
    '/enterprise/settings',
    '/notifications',
  ]) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${path} が ${res?.status()}`).toBeLessThan(400);
    await expect(page.locator('#t4d-main'), `${path} が描画されない`).toBeVisible();
  }

  expect(problems.join('\n')).toBe('');
});

test('本番: 一覧の絞り込み・並べ替え・ページングが動く', async ({ page }) => {
  await prodLogin(page, '海野 みどり');

  await page.goto(`${BASE}/enterprise/data`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 組織タグ「連結対象のみ」
  await page.getByRole('button', { name: '連結対象のみ', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('tbody').getByText('青海マテリアル合弁会社')).toHaveCount(0);

  // 状態フィルタ
  await page.goto(`${BASE}/enterprise/data?status=approved`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 並べ替え
  await page.goto(`${BASE}/enterprise/data?sort=value&dir=desc`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // ページング（範囲外でも壊れない）
  await page.goto(`${BASE}/enterprise/data?page=9999`);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('本番: Evidence が紙面として表示される', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/evidence`);
  await page
    .locator('tr', { hasText: '電力請求書' })
    .first()
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/[0-9a-f-]+/);

  await expect(page.getByText(/請求番号/).first()).toBeVisible();
  await expect(page.getByText(/合計使用電力量|ご請求金額/).first()).toBeVisible();
  await expect(page.getByText('架空のサンプル資料')).toBeVisible();
});

test('本番: AI Copilot が実データに基づいて答える', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/ai`);

  await page.locator('input[name="question"]').fill('Scope1 の当年値と前年比は？');
  await page.getByRole('button', { name: '質問する' }).click();

  // 回答はサーバーアクションの戻り値で描画される（リダイレクトしない）
  await expect(page.getByText(/t-CO2e です/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('出典').first()).toBeVisible();
});

test('本番: 取込フロー（ファイル投入 → AI 仕分け → プレビュー）が動く', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 1000 + (Date.now() % 8000);
  const csv = ['拠点,項目,値,単位,期間', `本社,電力使用量,${marker},MWh,FY2026`].join('\r\n');
  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `prod-smoke-${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);

  await expect(page.getByText('解析が完了しました')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();
  // AI が指標を推定している
  const metricSelect = page.locator('select[name^="metricId:"]').first();
  await expect(metricSelect).toBeVisible();
  expect(await metricSelect.inputValue()).not.toBe('');
});

test('本番: SSBJ のマテリアリティ登録が永続化される', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/disclosures/ssbj`);
  await expect(page.getByText('マテリアリティ充足度')).toBeVisible();

  const reason = `本番スモーク ${Date.now().toString(36)}`;
  const row = page.locator('tr', { hasText: '労働安全衛生' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill(reason);
  await row.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  await page.reload();
  await expect(page.getByText(reason)).toBeVisible();
});

test('本番: 権限制御（未ログイン・他テナント）が効いている', async ({ page }) => {
  // 未ログインでは保護画面へ入れない
  await page.context().clearCookies();
  await page.goto(`${BASE}/enterprise/data`);
  await expect(page).toHaveURL(/\/login/);

  // 別テナントは他社の Evidence を開けない
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/evidence`);
  const href = (await page
    .locator('a[href^="/enterprise/evidence/"]')
    .first()
    .getAttribute('href'))!;

  await prodLogin(page, '蒼天 次郎');
  const res = await page.goto(`${BASE}${href}`);
  expect(res?.status(), '他テナントのファイルが見えている').toBe(404);
});

test('本番: 監査法人ワークスペースが Read-only で動く', async ({ page }) => {
  await prodLogin(page, '青葉 健');
  await page.goto(`${BASE}/assurance/engagements`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const base = (await page
    .locator('a[href^="/assurance/engagements/"]')
    .first()
    .getAttribute('href'))!.replace(/\/[^/]*$/, '');
  for (const p of ['overview', 'data-room', 'population', 'sampling', 'testing', 'signoffs']) {
    const res = await page.goto(`${BASE}${base}/${p}`);
    expect(res?.status(), `${p} が開けない`).toBeLessThan(400);
    await expect(page.locator('#t4d-main')).toBeVisible();
  }
});

test('本番: 多言語・多形式のファイルを一括取込して AI が仕分けする', async ({ page }) => {
  // 本番（Demo Mode）は取込結果を Cookie に控えて持ち回す。複数ファイルでも
  // 直後のプレビューが読めることを、実際のファイルで確認する。
  const dataset = await buildHeterogeneousDataset();
  const pick = (prefix: string) => {
    const f = dataset.find((d) => d.name.startsWith(prefix))!;
    return { name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) };
  };

  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.locator('input[name="files"]').setInputFiles([pick('06_'), pick('17_')]);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);

  // ドイツ語の 1.234,5 が 1234.5 として解釈され、指標が自動選択されている
  const germanRow = page
    .locator('tr', { hasText: 'Stromverbrauch' })
    .filter({ has: page.locator('input[name^="value:"]') })
    .first();
  await expect(germanRow).toBeVisible({ timeout: 60_000 });
  await expect(germanRow.locator('input[name^="value:"]')).toHaveValue('1234.5');
  await expect(germanRow.locator('select').first()).not.toHaveValue('');

  // Shift_JIS のファイルが文字化けせずに読めている
  await expect(page.locator('#t4d-main')).toContainText('使用量');
});

test('本番: 企業が監査法人へアクセス許諾を新規付与できる', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/settings`);

  const form = page.locator('form', { hasText: '許諾する' });
  await expect(form, '許諾を新規付与するフォームが無い').toBeVisible();

  await form.locator('select[name="subjectType"]').selectOption('metric');
  await form.locator('select[name="subjectId"]').selectOption({ label: '水使用量' });
  await form.getByRole('button', { name: '許諾する' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.locator('tr', { hasText: '水使用量' }).first()).toContainText('有効');
});

test('本番: 通知を既読にできる', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/notifications`);

  const unreadBefore = await page.getByText('未読', { exact: true }).count();
  expect(unreadBefore, '未読の通知が必要').toBeGreaterThan(0);

  await page.getByRole('button', { name: '既読にする' }).first().click();
  await page.waitForLoadState('networkidle');

  expect(await page.getByText('未読', { exact: true }).count()).toBe(unreadBefore - 1);
});

test('本番: 入力の誤りが理由付きで画面に出る（digest だけにならない）', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/settings`);

  const form = page.locator('form', { hasText: '許諾する' });
  await form.locator('select[name="subjectType"]').selectOption('reporting_period');
  await form.locator('select[name="subjectId"]').selectOption({ label: 'Scope1 排出量' });
  await form.getByRole('button', { name: '許諾する' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('正しくありません');
});
