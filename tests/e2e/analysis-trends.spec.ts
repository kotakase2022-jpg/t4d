import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  accessibleExpanded,
  DEMO_USERS,
  focusRingOfActiveElement,
  loginAs,
  openCollapsible,
} from './helpers';

/**
 * 自社経年比較（docs/disclosure-first.md §10.2）。閲覧専用。
 *  - 左メニューの「分析」から開け、年度の列見出しはヘッダーの年度（既定 FY2026）を終点に 3 つ
 *  - 確定値だけを数値で出す。未入力のセルに「0」と書かない（データの無い指標は既定で隠し「0 ではありません」と示す）
 *  - 行の内訳（既定で閉じる）を開くと、全社値を算定できない理由と拠点の値が見える
 *  - 群（GHG／環境／社会／ガバナンス）で絞り込める（URL に持つ）
 *  - 「準拠率」が無く、重大なアクセシビリティ違反が無い
 *
 * 他の spec が FY2026 のデータを操作しても崩れないよう、値は closed の FY2024・FY2025 と、
 * 指標の定義で決まる状態（全社値は算定不可・未入力）だけで確かめる。
 */

const PATH = '/enterprise/analysis/trends';

const nav = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const analysisList = (page: Page) => nav(page).getByRole('list', { name: '分析', exact: true });
const main = (page: Page) => page.locator('#t4d-main');
const table = (page: Page) => main(page).getByRole('table', { name: /^指標ごとの確定値/ });

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 指標の行（行見出しが指標名で始まる行） */
const rowOf = (page: Page, name: string) =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${escapeRegExp(name)}`) }) });

/** 指標の行のすぐ下の「内訳」の行（行見出しの外に分けている） */
const detailOf = (page: Page, name: string) =>
  rowOf(page, name).locator('xpath=following-sibling::tr[1][@data-trend-detail]');

test('メニューの「分析」から開け、年度の列見出しは FY2024〜FY2026 の 3 つ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/analysis/diagnosis');
  await analysisList(page).getByRole('link', { name: '自社経年比較', exact: true }).click();
  await page.waitForURL(`**${PATH}`);
  await expect(page.getByRole('heading', { level: 1, name: '自社経年比較' })).toBeVisible();

  await expect(table(page)).toBeVisible();
  await expect(table(page).getByRole('columnheader', { name: /^FY20\d\d$/ })).toHaveText([
    'FY2024',
    'FY2025',
    'FY2026',
  ]);
  await expect(
    table(page).getByRole('columnheader', { name: /^前年比 FY20\d\d→FY20\d\d$/ }),
  ).toHaveText(['前年比 FY2024→FY2025', '前年比 FY2025→FY2026']);

  // closed の 2 年度は確定値、前年比は矢印＋符号＋数値（Scope1: 9,735.4 → 8,931.6）
  const scope1 = rowOf(page, 'Scope1 排出量');
  await expect(scope1.getByRole('cell').nth(0)).toContainText('9,735.4');
  await expect(scope1.getByRole('cell').nth(1)).toContainText('8,931.6');
  // セルの並び: FY2024・FY2025・FY2026・推移・前年比 ×2
  await expect(scope1.getByRole('cell').nth(4)).toHaveText('−8.3%（−803.8 t-CO2e）');

  // 要約は分母付き（総合点なし）
  await expect(
    main(page)
      .getByRole('list', { name: '経年比較の要約' })
      .getByText(/^\d+ \/ \d+ 指標$/)
      .first(),
  ).toBeVisible();
});

test('未入力のセルに「0」と書かない（データの無い指標は既定で隠し、表示すると「未入力」）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  const note = main(page).getByText(/^データが 1 年もない指標 \d+ 件（0 ではありません）/);
  await expect(note).toBeVisible();
  await expect(rowOf(page, 'Scope2 排出量（ロケーション基準）')).toHaveCount(0);

  await note.getByRole('link', { name: '表示' }).click();
  await page.waitForURL(/[?&]empty=1/);
  const row = rowOf(page, 'Scope2 排出量（ロケーション基準）');
  await expect(row).toHaveCount(1);
  for (const index of [0, 1, 2]) {
    await expect(row.getByRole('cell').nth(index)).toHaveText('未入力');
  }
  await expect(row.getByRole('cell').filter({ hasText: /^0$/ })).toHaveCount(0);
  await expect(row.getByRole('cell').filter({ hasText: /(^|[^\d.,])0 t-CO2e/ })).toHaveCount(0);
});

test('内訳は既定で閉じ、開くと算定できない理由と拠点の値・関連画面へのリンクが見える', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);

  const turnover = rowOf(page, '離職率');
  for (const index of [0, 1, 2]) {
    await expect(turnover.getByRole('cell').nth(index)).toHaveText('全社値は算定不可');
  }
  // 理由は行の下の内訳の中（前年比のセルには読み上げ用にだけある）。行見出しは指標名と単位だけ
  const reasonText = /分子・分母が登録されていないため算定できません/;
  await expect(turnover.getByRole('rowheader')).toHaveText('離職率（%）');
  await expect(detailOf(page, '離職率').getByText(reasonText).first()).toBeHidden();
  const details = await openCollapsible(detailOf(page, '離職率'), /^離職率の内訳$/);
  await expect(details.getByText(reasonText).first()).toBeVisible();
  await expect(details.getByRole('list', { name: 'FY2025 の拠点の値' })).toContainText('本社');

  const scope1 = await openCollapsible(detailOf(page, 'Scope1 排出量'), /^Scope1 排出量の内訳$/);
  await scope1.getByRole('link', { name: /^ESG経営の KPI/ }).click();
  await page.waitForURL('**/enterprise/esg/scope1');
});

test('既定で閉じた「比較の決まり」はクリック・キーボードで開閉でき、開閉の状態が読み上げに届く', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  const details = main(page).locator('details#trend-rules');
  const summary = details.locator('> summary');
  const selector = '#trend-rules > summary';
  const rule = details.getByText(
    'Scope2 のマーケット基準とロケーション基準は別の指標で、合算しません。',
    {
      exact: true,
    },
  );

  // 既定で閉じる。要点の 1 行は見え、中身は見えない。閉じていることが支援技術に渡る
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('比較の決まり: 確定値だけ');
  await expect(details).toHaveJSProperty('open', false);
  expect(await accessibleExpanded(page, selector)).toBe(false);
  await expect(rule).toBeHidden();
  await expect(summary.getByText('開く', { exact: true })).toBeVisible();
  await expect(summary.getByText('閉じる', { exact: true })).toBeHidden();

  // キーボード: summary にフォーカスして Enter で開く。フォーカスは summary に残り、フォーカスリングが見える
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveJSProperty('open', true);
  expect(await accessibleExpanded(page, selector)).toBe(true);
  await expect(rule).toBeVisible();
  await expect(summary.getByText('閉じる', { exact: true })).toBeVisible();
  await expect(summary).toBeFocused();
  expect(await focusRingOfActiveElement(page)).toEqual({
    tag: 'summary',
    focusVisible: true,
    outlined: true,
  });

  // Space で閉じる
  await page.keyboard.press('Space');
  await expect(details).toHaveJSProperty('open', false);
  expect(await accessibleExpanded(page, selector)).toBe(false);
  await expect(rule).toBeHidden();

  // クリックでも開く
  await summary.click();
  await expect(details).toHaveJSProperty('open', true);
  expect(await accessibleExpanded(page, selector)).toBe(true);
  await expect(rule).toBeVisible();

  // 開閉は保存しない（読み込み直すと既定の閉じた状態）
  await page.reload();
  await expect(main(page).locator('details#trend-rules')).toHaveJSProperty('open', false);
});

test('群（GHG）で絞り込め、絞込は URL に残る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  await main(page).getByRole('button', { name: 'GHG', exact: true }).click();
  await page.waitForURL(/[?&]group=ghg/);
  await expect(table(page).getByRole('rowheader', { name: /^GHG（\d+ 指標）$/ })).toBeVisible();
  await expect(table(page).getByRole('rowheader', { name: /^環境（\d+ 指標）$/ })).toHaveCount(0);
  await expect(rowOf(page, 'Scope1 排出量')).toHaveCount(1);
  await expect(rowOf(page, '離職率')).toHaveCount(0);

  await page.reload();
  await expect(rowOf(page, '離職率')).toHaveCount(0);
  await expect(rowOf(page, 'Scope1 排出量')).toHaveCount(1);
});

test('「準拠率」が無く、重大なアクセシビリティ違反が無い', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  await expect(main(page)).toBeVisible();
  await expect(main(page)).not.toContainText('準拠率');
  // 内訳を 1 つ開いた状態でも確かめる
  await openCollapsible(detailOf(page, 'Scope1 排出量'), /^Scope1 排出量の内訳$/);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
});
