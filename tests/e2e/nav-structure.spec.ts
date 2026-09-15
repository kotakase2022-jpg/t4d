import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 左メニューの構成（発注者会議での再設計 + 2026-09 の 3 階層化）。
 *
 * 2 つの入口——「開示対応」（目的ドリブン）と「ESG データ（GHG以外）」（データ先行）——を
 * 並べ、GHG は独立モジュール、業務管理・管理はグルーピングする。
 * 開示対応の配下は基準ごとにまとめ、SSBJ → 対応状況/要求事項/… の 3 階層にする。
 * 「開示ドラフト」への導線が左メニュー・SSBJ データ収集・データ取込の
 * 3 か所に揃うこともここで確かめる。
 */

const nav = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });

test('2 つの入口とグルーピングで並ぶ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  const sidebar = nav(page);

  // トップレベル: ホーム → 開示対応 → ESG データ（GHG以外） → GHG → 業務管理 → AI Copilot → 管理
  for (const label of [
    'ホーム',
    '開示対応',
    'ESG データ（GHG以外）',
    'GHG',
    '業務管理',
    'AI Copilot',
    '管理',
  ]) {
    await expect(
      sidebar.getByRole('link', { name: label, exact: true }),
      `トップレベルに ${label} が無い`,
    ).toBeVisible();
  }

  // 開示対応配下: 基準ごとにまとめる（SSBJ はさらに 1 階層持つ）
  for (const child of ['SSBJ', 'CDP', 'CSRD', 'MSCI', 'FTSE']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
  }
  // SSBJ 配下（3 階層目）
  for (const child of ['対応状況', '要求事項', '対応計画', 'データ収集', '開示ドラフト']) {
    await expect(sidebar.getByRole('link', { name: child, exact: true })).toBeVisible();
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
  // 管理配下
  await expect(sidebar.getByRole('link', { name: '組織・拠点', exact: true })).toBeVisible();

  // SSBJ 配下の「データ収集」は SSBJ の画面へ、ESG データ配下の「データ取込」は取込画面へ。
  // 同名で別画面へ飛ぶ事故が無いよう、href まで確かめる
  await expect(sidebar.getByRole('link', { name: 'データ収集', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/disclosures/ssbj/collection',
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

  // ① 左メニュー: SSBJ 配下が工程順（対応状況 → 要求事項 → 対応計画 → データ収集 → 開示ドラフト）
  const labels = await nav(page).getByRole('link').allTextContents();
  const ssbjIndex = labels.findIndex((t) => t === 'SSBJ');
  expect(ssbjIndex).toBeGreaterThan(-1);
  expect(labels.slice(ssbjIndex + 1, ssbjIndex + 6)).toEqual([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
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

test('設定は権限のある管理者だけに左メニューへ出る', async ({ page }) => {
  // 拠点担当（enterprise.org.manage 無し）には出ない
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/dashboard');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '設定', exact: true })).toHaveCount(0);

  // 企業管理者には「管理」配下に出る
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  await expect(nav(page).getByRole('link', { name: '設定', exact: true })).toBeVisible();
});
