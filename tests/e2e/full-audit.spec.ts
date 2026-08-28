import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 全画面の一括監査（自己検証ミッション用）。
 *
 * 「コードを読んだ限り動く」ではなく、実際に全画面を開いて
 *  - HTTP ステータス
 *  - コンソールエラー（uncaught / React / hydration）
 *  - 失敗したネットワークリクエスト
 *  - 主要要素の描画
 * を機械的に確認する。ロールごとに到達できる画面が違うため、権限別に回す。
 */

interface Problem {
  path: string;
  kind: 'http' | 'console' | 'network' | 'render';
  detail: string;
}

/** 監査対象の画面（企業ワークスペース） */
const ENTERPRISE_PATHS = [
  '/enterprise/dashboard',
  '/enterprise/imports',
  '/enterprise/data',
  '/enterprise/data?status=draft',
  '/enterprise/data?unit=consolidated',
  '/enterprise/data?flag=validation_error',
  '/enterprise/data?q=電力',
  '/enterprise/organizations',
  '/enterprise/evidence',
  '/enterprise/workflows',
  '/enterprise/ghg',
  '/enterprise/disclosures/cdp',
  '/enterprise/disclosures/cdp/import',
  '/enterprise/disclosures/ssbj',
  '/enterprise/disclosures/ssbj/settings',
  '/enterprise/disclosures/ssbj/requirements',
  '/enterprise/disclosures/ssbj/requirements?coverage=unconfirmed',
  '/enterprise/disclosures/ssbj/requirements?priority=high',
  '/enterprise/disclosures/ssbj/plans',
  '/enterprise/disclosures/ssbj/collection',
  '/enterprise/disclosures/ssbj/draft',
  '/enterprise/disclosures/csrd',
  '/enterprise/disclosures/msci',
  '/enterprise/disclosures/ftse',
  '/enterprise/alerts',
  '/enterprise/ai',
  '/enterprise/reports',
  '/enterprise/settings',
  '/enterprise/roadmap',
  '/notifications',
  '/profile',
];

const ASSURANCE_PATHS = ['/assurance/dashboard', '/assurance/engagements', '/assurance/settings'];

/** 無視してよいコンソール出力（アプリの欠陥ではないもの） */
function isIgnorableConsole(text: string): boolean {
  return (
    // Next.js の開発ヒントや、ブラウザ拡張由来のノイズ
    text.includes('Download the React DevTools') ||
    text.includes('[Fast Refresh]') ||
    // 画像最適化を使わない方針による警告（known-limitations に記録済み）
    text.includes('was preloaded using link preload')
  );
}

async function auditPaths(
  page: import('@playwright/test').Page,
  paths: string[],
): Promise<Problem[]> {
  const problems: Problem[] = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (isIgnorableConsole(text)) return;
    problems.push({ path: page.url(), kind: 'console', detail: text.slice(0, 200) });
  });
  page.on('pageerror', (err) => {
    problems.push({ path: page.url(), kind: 'console', detail: `pageerror: ${err.message}` });
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400 && url.startsWith('http://127.0.0.1')) {
      problems.push({ path: url, kind: 'network', detail: `HTTP ${res.status()}` });
    }
  });

  for (const path of paths) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      problems.push({ path, kind: 'http', detail: `HTTP ${status}` });
      continue;
    }
    // ログインへ飛ばされていないこと
    if (new URL(page.url()).pathname === '/login') {
      problems.push({ path, kind: 'render', detail: 'ログインへ戻された' });
      continue;
    }
    try {
      await expect(page.locator('#t4d-main')).toBeVisible({ timeout: 15_000 });
    } catch {
      problems.push({ path, kind: 'render', detail: '本文（#t4d-main）が描画されない' });
    }
  }
  return problems;
}

test('企業ワークスペース: 全画面が描画され、コンソール・ネットワークに異常が無い', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  const problems = await auditPaths(page, ENTERPRISE_PATHS);
  expect(problems.map((p) => `${p.kind} ${p.path} — ${p.detail}`).join('\n')).toBe('');
});

test('監査法人ワークスペース: 全画面が描画され、コンソール・ネットワークに異常が無い', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  const problems = await auditPaths(page, ASSURANCE_PATHS);
  expect(problems.map((p) => `${p.kind} ${p.path} — ${p.detail}`).join('\n')).toBe('');
});

test('拠点担当: 権限外の画面へ入れず、権限内の画面は描画される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);

  // 権限内
  const allowed = await auditPaths(page, [
    '/enterprise/dashboard',
    '/enterprise/data',
    '/enterprise/imports',
    '/enterprise/evidence',
  ]);
  expect(allowed.map((p) => `${p.kind} ${p.path} — ${p.detail}`).join('\n')).toBe('');

  // 権限外（設定画面は org.manage が要る）: 403 相当の表示になり、操作 UI は出ない
  await page.goto('/enterprise/settings');
  await expect(page.getByText(/権限がありません|閲覧できません/)).toBeVisible();
  await expect(page.getByRole('button', { name: '招待リンクを発行' })).toHaveCount(0);
});

test('未ログインでは保護画面へ入れず、ログインへ誘導される', async ({ page }) => {
  await page.context().clearCookies();
  for (const path of ['/enterprise/dashboard', '/enterprise/data', '/assurance/dashboard']) {
    await page.goto(path);
    await expect(page, `${path} が保護されていない`).toHaveURL(/\/login/);
  }
});
