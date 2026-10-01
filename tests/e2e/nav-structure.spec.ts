import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 左メニューの構成（発注者会議での再設計 + 2026-09 の 3 階層化 + 2026-10-01 の追加要望）。
 *
 * 2 つの入口——「開示対応」（目的ドリブン）と「ESG データ（GHG以外）」（データ先行）——を
 * 並べ、GHG は独立モジュール、業務管理・管理はグルーピングする。
 * 開示対応の配下は基準ごとにまとめ、SSBJ → 対応状況/要求事項/… の 3 階層にする。
 * 2026-10-01（docs/disclosure-first.md §9.1）: SSBJ の データ収集 と 開示ドラフト の間に 定性情報、
 * CSRD は SSBJ と同じ 5 画面のグループ、AI Copilot と 管理 の間に 分析（現状診断/規制対応度/他社比較）。
 * SSBJ と CSRD には同名のリンクが並ぶため、子のリンクは親の名前が付いたリスト
 * （getByRole('list', { name })）で範囲を絞って確かめる。
 * 「開示ドラフト」への導線が左メニュー・SSBJ データ収集・データ取込の
 * 3 か所に揃うこともここで確かめる。
 */

const nav = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const childList = (page: Page, parent: string) =>
  nav(page).getByRole('list', { name: parent, exact: true });

test('2 つの入口とグルーピングで並ぶ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  const sidebar = nav(page);

  // トップレベル: ホーム → 開示対応 → ESG データ（GHG以外） → GHG → 業務管理 → AI Copilot → 分析 → 管理
  const topLevel = [
    'ホーム',
    '開示対応',
    'ESG データ（GHG以外）',
    'GHG',
    '業務管理',
    'AI Copilot',
    '分析',
    '管理',
  ];
  for (const label of topLevel) {
    await expect(
      sidebar.getByRole('link', { name: label, exact: true }),
      `トップレベルに ${label} が無い`,
    ).toBeVisible();
  }
  // 並び順（最上位のリストの直下のリンクだけを読む）
  await expect(sidebar.locator(':scope > ul > li > a')).toHaveText(topLevel);
  // 分析の入口は現状診断
  await expect(sidebar.getByRole('link', { name: '分析', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/analysis/diagnosis',
  );

  // 開示対応配下: 基準ごとにまとめる（SSBJ・CSRD はさらに 1 階層持つ）
  for (const child of ['SSBJ', 'CDP', 'CSRD', 'MSCI', 'FTSE']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
  }
  // SSBJ 配下（3 階層目）: 定性情報は データ収集 と 開示ドラフト の間
  const ssbj = childList(page, 'SSBJ');
  await expect(ssbj.getByRole('link')).toHaveText([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
    '定性情報',
    '開示ドラフト',
  ]);
  await expect(ssbj.getByRole('link', { name: '定性情報', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/narratives',
  );
  // CSRD 配下（3 階層目）: SSBJ と同じ 5 画面。定性情報は入れない
  const csrd = childList(page, 'CSRD');
  await expect(csrd.getByRole('link')).toHaveText([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
    '開示ドラフト',
  ]);
  for (const [label, href] of [
    ['対応状況', '/enterprise/disclosures/csrd'],
    ['要求事項', '/enterprise/disclosures/csrd/requirements'],
    ['対応計画', '/enterprise/disclosures/csrd/plans'],
    ['開示ドラフト', '/enterprise/disclosures/csrd/draft'],
  ] as const) {
    await expect(csrd.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'href',
      href,
    );
  }
  // ESG データ（GHG以外）配下: データが流れる順（取込 → 台帳 → 根拠資料）
  for (const child of ['データ取込', '非財務データ', 'Evidence']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
  }
  // GHG 配下: 算定の要約と Scope3 取込（カテゴリー別の 3 階層。現状は Cat.1 のみ）
  for (const child of ['算定サマリー', 'Scope3データ取込', 'Cat.1']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
  }
  await expect(sidebar.getByRole('link', { name: 'Cat.1', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/ghg/suppliers',
  );
  // 業務管理配下
  for (const child of ['ワークフロー', 'アラート', 'レポート']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
  }
  // 分析配下（閲覧専用の横断画面）
  const analysis = childList(page, '分析');
  await expect(analysis.getByRole('link')).toHaveText(['現状診断', '規制対応度', '他社比較']);
  for (const [label, href] of [
    ['現状診断', '/enterprise/analysis/diagnosis'],
    ['規制対応度', '/enterprise/analysis/regulations'],
    ['他社比較', '/enterprise/analysis/benchmark'],
  ] as const) {
    await expect(analysis.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'href',
      href,
    );
  }
  // 管理配下
  await expect(sidebar.getByRole('link', { name: '組織・拠点', exact: true })).toBeVisible();

  // SSBJ・CSRD 配下の「データ収集」はそれぞれの画面へ、ESG データ配下の「データ取込」は取込画面へ。
  // 同名で別画面へ飛ぶ事故が無いよう、href まで確かめる
  await expect(ssbj.getByRole('link', { name: 'データ収集', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/disclosures/ssbj/collection',
  );
  await expect(csrd.getByRole('link', { name: 'データ収集', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/disclosures/csrd/collection',
  );
  await expect(sidebar.getByRole('link', { name: 'データ取込', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/imports',
  );

  // データ取込へ遷移でき、画面の名前も一致する
  await sidebar.getByRole('link', { name: 'データ取込', exact: true }).click();
  await expect(page).toHaveURL(/\/enterprise\/imports/);
  await expect(page.getByRole('heading', { name: 'データ取込' })).toBeVisible();
});

test('SSBJ 配下は 3 階層で並び、開示ドラフトへの導線が 3 か所に揃う', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');

  // ① 左メニュー: SSBJ 配下が工程順（対応状況 → 要求事項 → 対応計画 → データ収集 → 定性情報 → 開示ドラフト）
  const labels = await nav(page).getByRole('link').allTextContents();
  const ssbjIndex = labels.findIndex((t) => t === 'SSBJ');
  expect(ssbjIndex).toBeGreaterThan(-1);
  expect(labels.slice(ssbjIndex + 1, ssbjIndex + 7)).toEqual([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
    '定性情報',
    '開示ドラフト',
  ]);

  // ② SSBJ データ収集の右上
  await page.goto('/enterprise/disclosures/ssbj/collection');
  const main = page.locator('#t4d-main');
  await main.getByRole('link', { name: 'SSBJ 開示ドラフト' }).click();
  await expect(page).toHaveURL(/\/enterprise\/disclosures\/ssbj\/draft/);

  // ③ データ取込（取込ジョブの一覧画面）の右上
  await page.goto('/enterprise/imports');
  await expect(main.getByRole('link', { name: 'SSBJ 開示ドラフト' })).toBeVisible();
});

test('同じ名前のリンクが SSBJ と CSRD に並んでも、現在地は開いている画面の 1 つだけ', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  const current = nav(page).locator('a[aria-current="page"]');

  // 定性情報（従来メニューでは SSBJ 配下の通常の項目）
  await page.goto('/enterprise/narratives');
  await expect(current).toHaveCount(1);
  await expect(
    childList(page, 'SSBJ').getByRole('link', { name: '定性情報', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  // CSRD の対応計画: SSBJ の対応計画には付かない
  await page.goto('/enterprise/disclosures/csrd/plans');
  await expect(current).toHaveCount(1);
  await expect(
    childList(page, 'CSRD').getByRole('link', { name: '対応計画', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    childList(page, 'SSBJ').getByRole('link', { name: '対応計画', exact: true }),
  ).not.toHaveAttribute('aria-current', 'page');
});

test('設定と規制対応度は権限のある利用者だけに左メニューへ出る', async ({ page }) => {
  // 拠点担当（enterprise.org.manage・enterprise.disclosure.read 無し）には出ない
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/dashboard');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '設定', exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: '規制対応度', exact: true })).toHaveCount(0);
  // 定性情報・CSRD の画面も開示の閲覧権限が要る（開いても「アクセス権限がありません」になる）ため出さない
  await expect(nav(page).getByRole('link', { name: '定性情報', exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'CSRD', exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole('list', { name: 'CSRD', exact: true })).toHaveCount(0);
  // 分析そのもの（現状診断・他社比較）は出る
  await expect(childList(page, '分析').getByRole('link')).toHaveText(['現状診断', '他社比較']);

  // 企業管理者には「管理」配下に出る
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  await expect(nav(page).getByRole('link', { name: '設定', exact: true })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '規制対応度', exact: true })).toBeVisible();
});
