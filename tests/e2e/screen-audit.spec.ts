import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import { crawl, watchConsole } from '@tests/support/crawl';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 全画面の網羅監査。
 *
 * 個別の業務シナリオは vertical-slices.spec.ts が見る。こちらは
 * 「**どこかの画面が黙って壊れていないか**」を機械的に潰すための検査。
 *
 *  1. 到達可能な全ページをクロールして描画されること（Error 境界・404 が出ないこと）
 *  2. Console にエラーが出ていないこと
 *  3. リンクの **Client 側クリック**で遷移が確定すること
 *     （Next.js #86151 のように「RSC は 200 で返っているのに無言で固まる」不具合を検出する）
 *
 * Demo Mode の Fixture DB はサーバープロセス共有のため直列実行。
 */

test.describe.configure({ mode: 'serial' });

const ENGAGEMENT = ENGAGEMENT_IDS.main;
const ENGAGEMENT_HOME = `/assurance/engagements/${ENGAGEMENT}/overview`;

test('企業ワークスペース: 到達可能な全画面が描画される', async ({ page }) => {
  const problems: string[] = [];
  watchConsole(page, problems);
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  const visited = await crawl(
    page,
    ['/enterprise/dashboard', '/notifications', '/profile'],
    ['/enterprise/', '/notifications', '/profile'],
    problems,
  );

  console.log(`[AUDIT] 企業: ${visited.length} ページを検査`);
  expect(visited.length).toBeGreaterThan(20);
  expect(problems.join('\n')).toBe('');
});

test('監査法人ワークスペース: 到達可能な全画面が描画される', async ({ page }) => {
  const problems: string[] = [];
  watchConsole(page, problems);
  await loginAs(page, DEMO_USERS.assuranceManager);

  const visited = await crawl(
    page,
    ['/assurance/dashboard', ENGAGEMENT_HOME, '/notifications', '/profile'],
    ['/assurance/', '/notifications', '/profile'],
    problems,
  );

  console.log(`[AUDIT] 監査法人: ${visited.length} ページを検査`);
  expect(visited.length).toBeGreaterThan(15);
  expect(problems.join('\n')).toBe('');
});

/**
 * 権限の異なるロールでも主要画面が壊れないこと。
 *
 * 権限分岐でボタンや列を出し分けているため、ロールごとに描画経路が変わる。
 */
const ROLE_MATRIX: Array<{ user: string; seeds: string[]; prefixes: string[] }> = [
  {
    user: DEMO_USERS.siteUser,
    seeds: ['/enterprise/dashboard', '/enterprise/data'],
    prefixes: ['/enterprise/', '/notifications', '/profile'],
  },
  {
    user: DEMO_USERS.sustainability,
    seeds: ['/enterprise/dashboard', '/enterprise/disclosures/cdp'],
    prefixes: ['/enterprise/', '/notifications', '/profile'],
  },
  {
    user: DEMO_USERS.reviewer,
    seeds: ['/enterprise/dashboard', '/enterprise/data'],
    prefixes: ['/enterprise/', '/notifications', '/profile'],
  },
  {
    user: DEMO_USERS.approver,
    seeds: ['/enterprise/dashboard', '/enterprise/data'],
    prefixes: ['/enterprise/', '/notifications', '/profile'],
  },
  {
    user: DEMO_USERS.assurancePartner,
    seeds: ['/assurance/dashboard', ENGAGEMENT_HOME],
    prefixes: ['/assurance/', '/notifications', '/profile'],
  },
  {
    user: DEMO_USERS.assuranceStaff,
    seeds: ['/assurance/dashboard', ENGAGEMENT_HOME],
    prefixes: ['/assurance/', '/notifications', '/profile'],
  },
];

for (const role of ROLE_MATRIX) {
  test(`${role.user} でも到達可能な全画面が描画される`, async ({ page }) => {
    const problems: string[] = [];
    watchConsole(page, problems);
    await loginAs(page, role.user);

    const visited = await crawl(page, role.seeds, role.prefixes, problems);
    console.log(`[AUDIT] ${role.user}: ${visited.length} ページを検査`);
    expect(visited.length).toBeGreaterThan(5);
    expect(problems.join('\n')).toBe('');
  });
}

/**
 * Client 側遷移（リンククリック）で URL が確定すること。
 *
 * `page.goto` は Server 側しか見ない。実際の利用はクリックなので、
 * **クリックしてから URL が変わること**を全リンクで確認する。
 *
 * 案件配下のサイドバーは「案件が選択されている」ときだけ出るため、
 * クリックのたびに起点へ戻してから次のリンクを押す。
 */
async function auditClickNavigation(
  page: Page,
  home: string,
  linkSelector: string,
  problems: string[],
): Promise<number> {
  await page.goto(home, { waitUntil: 'domcontentloaded' });
  const hrefs: string[] = await page.evaluate((selector) => {
    const found = [...document.querySelectorAll(selector)]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('/') && !h.includes('#'));
    return [...new Set(found)];
  }, linkSelector);

  let clicked = 0;
  for (const href of hrefs) {
    if (new URL(page.url()).pathname + new URL(page.url()).search === href) {
      await page.goto(home, { waitUntil: 'domcontentloaded' });
    }
    const link = page.locator(`${linkSelector}[href="${href}"]`).first();
    if ((await link.count()) === 0) {
      problems.push(`${home} からリンクが見つからない: ${href}`);
      continue;
    }
    const expected = new URL(href, 'http://x');
    await link.click();
    try {
      await page.waitForURL(
        (url) => url.pathname === expected.pathname && url.search === expected.search,
        { timeout: 12_000 },
      );
      clicked += 1;
    } catch {
      problems.push(
        `Client 遷移が確定しない: ${href}（起点 ${home} / 現在 ${new URL(page.url()).pathname}）`,
      );
    }
    // 案件配下リンクは案件コンテキストでのみ出るため、毎回起点へ戻す
    await page.goto(home, { waitUntil: 'domcontentloaded' });
  }
  return clicked;
}

test('企業ワークスペース: サイドバー全項目が Client 遷移で開く', async ({ page }) => {
  const problems: string[] = [];
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  const clicked = await auditClickNavigation(page, '/enterprise/dashboard', 'nav a', problems);
  console.log(`[AUDIT] 企業サイドバー: ${clicked} 本をクリック検証`);
  expect(clicked).toBeGreaterThan(12);
  expect(problems.join('\n')).toBe('');
});

test('監査法人ワークスペース: サイドバー全項目が Client 遷移で開く', async ({ page }) => {
  const problems: string[] = [];
  await loginAs(page, DEMO_USERS.assuranceManager);
  const clicked = await auditClickNavigation(page, ENGAGEMENT_HOME, 'nav a', problems);
  console.log(`[AUDIT] 監査法人サイドバー: ${clicked} 本をクリック検証`);
  expect(clicked).toBeGreaterThan(12);
  expect(problems.join('\n')).toBe('');
});

test('企業ダッシュボード: KPI カードが Client 遷移で開く', async ({ page }) => {
  const problems: string[] = [];
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  const clicked = await auditClickNavigation(
    page,
    '/enterprise/dashboard',
    '#t4d-main a',
    problems,
  );
  console.log(`[AUDIT] 企業ダッシュボード本文: ${clicked} 本をクリック検証`);
  expect(clicked).toBeGreaterThan(3);
  expect(problems.join('\n')).toBe('');
});

test('案件ホーム: 本文のリンクが Client 遷移で開く', async ({ page }) => {
  const problems: string[] = [];
  await loginAs(page, DEMO_USERS.assuranceManager);
  const clicked = await auditClickNavigation(page, ENGAGEMENT_HOME, '#t4d-main a', problems);
  console.log(`[AUDIT] 案件ホーム本文: ${clicked} 本をクリック検証`);
  expect(clicked).toBeGreaterThan(3);
  expect(problems.join('\n')).toBe('');
});
