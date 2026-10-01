import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * CSRD ワークスペース（機能追加要望 ②・2026-10-01 の再構成 docs/disclosure-first.md §9）。
 * ナビゲーション → 対応状況（ギャップ分析表）→ 要求事項の詳細 → 回答画面（共有ビュー）→ AI ドラフト生成までを
 * 実ブラウザで確認する。CSRD はダブル・マテリアリティで、設定（DMA）と要求事項の適用が画面に出る。
 *
 * 2026-10-01: 対応状況に工程・DMA 要約などを足したため、行数はギャップ分析表（名前付き）に絞る。
 * 要求事項コードのリンク先は要求事項の詳細になり、回答画面へは「回答を編集（版・承認）」から進む。
 */

test.describe.configure({ mode: 'serial' });

/** 回答画面（既存の共有ビュー）の URL。要求事項の詳細（/csrd/requirements/{id}）と区別する */
const ANSWER_URL = /\/enterprise\/disclosures\/csrd\/[0-9a-f-]{36}$/;

test('サイドバーから CSRD を開き、ギャップ分析が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // nav の開示対応配下に CSRD が出る
  await page.getByRole('link', { name: 'CSRD' }).first().click();
  await page.waitForURL(/\/enterprise\/disclosures\/csrd/);

  await expect(page.getByRole('heading', { name: /CSRD 開示対応/ })).toBeVisible();
  await expect(page.getByText('初年度対応')).toBeVisible();

  // ギャップ分析: データありとデータなしの両方の状態が見える
  const gapTable = page.getByRole('table', { name: 'ESRS 要求事項とデータの対応' });
  await expect(gapTable.getByText('データあり').first()).toBeVisible();
  await expect(gapTable.getByText('承認済みデータなし').first()).toBeVisible();
  await expect(gapTable.locator('tbody tr')).toHaveCount(12);
  // 対応状況の表はギャップ分析表 1 つだけ（§9.4）
  await expect(page.locator('#t4d-main table')).toHaveCount(1);
});

test('ESRS 項目の要求事項の詳細から回答画面を開き、AI ドラフトを生成できる（共有ビュー）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd');
  await page.getByRole('link', { name: 'ESRS-E1-5' }).click();

  // 要求事項の詳細: 適用の根拠（インパクト・財務の両面）が出る
  await page.waitForURL(/\/enterprise\/disclosures\/csrd\/requirements\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /ESRS-E1-5/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '適用の根拠' })).toBeVisible();
  await expect(page.getByText('適用（インパクト・財務）').first()).toBeVisible();

  await page.getByRole('link', { name: '回答を編集（版・承認）' }).click();
  await page.waitForURL(ANSWER_URL);
  await expect(page.getByRole('heading', { name: /ESRS-E1-5/ })).toBeVisible();
  // パンくずが CSRD になっている（CDP ではない）
  await expect(page.getByRole('link', { name: 'CSRD', exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'ドラフトを生成' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/Mock|AI 生成/).first()).toBeVisible();

  // 質問一覧（左ペイン）のリンクは CSRD 配下を指す
  const firstNavLink = page.locator('a[href^="/enterprise/disclosures/csrd/"]').first();
  await expect(firstNavLink).toBeVisible();

  // 回答画面から要求事項の評価へ戻れる
  await page.getByRole('link', { name: '要求事項の評価へ戻る' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/csrd\/requirements\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /ESRS-E1-5/ })).toBeVisible();
});

test('CSRD でも整合チェックが実行でき、ESRS 項目への指摘が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd');
  await page.getByRole('button', { name: '整合チェックを実行' }).click();

  await page.waitForURL(/\/enterprise\/disclosures\/csrd\?check=/);
  await expect(page.getByRole('heading', { name: /整合チェックの結果/ })).toBeVisible();
  await expect(page.getByText(/ESRS/).first()).toBeVisible();
});

test('CSRD 設定: インパクト重要性と財務的重要性の 2 観点・閾値・マトリクス・SSBJ との違いが出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd/settings');
  const main = page.locator('#t4d-main');
  await expect(main.getByRole('heading', { name: /CSRD 設定/ })).toBeVisible();
  await expect(main.getByText('SSBJ: シングル・マテリアリティ')).toBeVisible();
  await expect(main.getByText('CSRD: ダブル・マテリアリティ')).toBeVisible();
  await expect(main.getByRole('img', { name: /ダブル・マテリアリティ・マトリクス/ })).toBeVisible();
  await expect(main.getByLabel('インパクトの閾値（インパクト重要性）')).toHaveValue('3.0');
  await expect(main.getByLabel('財務の閾値（財務的重要性）')).toHaveValue('3.0');
  // 10 事項。G1 は人の判断が未評価のため、DMA はまだ確定できない
  const dma = main.getByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' });
  await expect(dma.locator('tbody tr')).toHaveCount(10);
  await expect(main.getByRole('button', { name: 'DMA を確定する' })).toBeDisabled();

  // 存在しないテーマは 404
  const res = await page.goto('/enterprise/disclosures/csrd/settings/matters/X9');
  expect(res?.status()).toBe(404);
});

test('CSRD 要求事項: 適用になった観点を行ごとに示し、URL で絞り込める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd/requirements');
  const table = page.getByRole('table', { name: 'CSRD 要求事項の評価' });
  await expect(table.locator('tbody tr')).toHaveCount(12);
  // E3-4 はインパクトのみで適用、E5-5 は対象外（Fixture・DMA 確定前の暫定）
  await expect(
    table.locator('tr', { hasText: 'ESRS-E3-4' }).getByText('適用（インパクト）'),
  ).toBeVisible();
  await expect(
    table.locator('tr', { hasText: 'ESRS-E5-5' }).getByText('対象外（重要でない）'),
  ).toBeVisible();

  await page.goto('/enterprise/disclosures/csrd/requirements?applicability=always');
  await expect(
    page.getByRole('table', { name: 'CSRD 要求事項の評価' }).locator('tbody tr'),
  ).toHaveCount(2);
});

test('CSRD の対応状況・設定・事項・要求事項・詳細に重大なアクセシビリティ違反が無い', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/disclosures/csrd',
    '/enterprise/disclosures/csrd/settings',
    '/enterprise/disclosures/csrd/settings/matters/S1',
    '/enterprise/disclosures/csrd/requirements',
    `/enterprise/disclosures/csrd/requirements/${CSRD_IDS.items['ESRS2-SBM-3']}`,
  ]) {
    await page.goto(path);
    await expect(page.locator('#t4d-main')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, `${path}\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`).toEqual([]);
  }
});
