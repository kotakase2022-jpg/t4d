import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 分析（docs/disclosure-first.md §9.5・§9.6・§9.7）。閲覧専用の 3 画面。
 *  - 左メニューの「分析」から 現状診断・規制対応度・他社比較 を開ける
 *  - 件数には分母を添える。単一の総合点・準拠率は出さない
 *  - MSCI・FTSE は「今後対応予定」で、算定しない理由を示す（0% と出さない）
 *  - 他社比較は架空の比較データであることを先頭と表に示し、比較対象外の理由を示す
 *  - 重大なアクセシビリティ違反が無い
 *
 * 他のテストが CSRD・SSBJ を操作しても崩れないよう、件数は分母（収録件数）だけを固定して確かめる。
 */

const NOTICE = '架空の比較データ（デモ用）。実在企業の数値ではありません';
const PATHS = [
  '/enterprise/analysis/diagnosis',
  '/enterprise/analysis/regulations',
  '/enterprise/analysis/benchmark',
] as const;

const nav = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const analysisList = (page: Page) => nav(page).getByRole('list', { name: '分析', exact: true });
const main = (page: Page) => page.locator('#t4d-main');

test('メニューの「分析」から 3 画面を開ける（入口は現状診断）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await nav(page).getByRole('link', { name: '分析', exact: true }).click();
  await page.waitForURL('**/enterprise/analysis/diagnosis');
  await expect(page.getByRole('heading', { level: 1, name: '現状診断' })).toBeVisible();

  for (const [label, path] of [
    ['規制対応度', '/enterprise/analysis/regulations'],
    ['他社比較', '/enterprise/analysis/benchmark'],
    ['現状診断', '/enterprise/analysis/diagnosis'],
  ] as const) {
    await analysisList(page).getByRole('link', { name: label, exact: true }).click();
    await page.waitForURL(`**${path}`);
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
  }

  // /enterprise/analysis は現状診断へ
  await page.goto('/enterprise/analysis');
  await page.waitForURL('**/enterprise/analysis/diagnosis');
});

test('現状診断: 領域ごとの状態と分母を示し、直す画面へ進める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/analysis/diagnosis');

  for (const title of [
    'データ収集・承認',
    '証跡・承認の健全性',
    'GHG 算定の網羅性',
    '定性情報',
    '開示対応（基準別）',
  ]) {
    const region = page.getByRole('region', { name: title });
    await expect(region, `${title} の領域が無い`).toBeVisible();
    // 状態は 4 つのどれか（ラベルで示す）
    await expect(
      region.getByText(/^(不足あり|確認待ちあり|不足なし|算定対象外)$/).first(),
    ).toBeVisible();
  }

  // 件数は「n / 分母 件」で示す
  const collection = page.getByRole('region', { name: 'データ収集・承認' });
  await expect(collection.getByText(/^\d+ \/ \d+ 件$/).first()).toBeVisible();
  await expect(collection.getByText(/^分母: /).first()).toBeVisible();

  // GHG: 連結対象の拠点が分母。Scope3 合計は未算定（0 と出さない）
  const ghg = page.getByRole('region', { name: 'GHG 算定の網羅性' });
  await expect(ghg.getByText(/^\d+ \/ 4 拠点$/).first()).toBeVisible();
  await expect(ghg.getByText(/^\d+ \/ 15 カテゴリ$/)).toBeVisible();
  await expect(ghg.getByText('未算定', { exact: true })).toBeVisible();

  // 開示対応は基準ごとに 1 行。詳細は規制対応度へ
  const disclosure = page.getByRole('region', { name: '開示対応（基準別）' });
  await expect(disclosure.getByText(/評価対象 \d+ \/ 133 件/)).toBeVisible();
  await disclosure.getByRole('link', { name: '各規制への対応度' }).click();
  await page.waitForURL('**/enterprise/analysis/regulations');
});

test('現状診断: 開示の閲覧権限が無い役割には開示の領域を出さず、その旨を示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/analysis/diagnosis');
  await expect(page.getByText(/閲覧権限が無い領域は表示していません/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'データ収集・承認' })).toBeVisible();
  await expect(page.getByRole('region', { name: '定性情報' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '開示対応（基準別）' })).toHaveCount(0);

  // 規制対応度は URL を直接開いても権限なしと示す
  await page.goto('/enterprise/analysis/regulations');
  await expect(page.getByText('アクセス権限がありません')).toBeVisible();
});

test('規制対応度: 6 基準の位置付け・分母・算定しない理由（MSCI・FTSE は今後対応予定）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/analysis/regulations');
  const table = page.getByRole('table', { name: /^各規制への対応度/ });
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(6);

  const headers = table.locator('tbody th[scope="row"]');
  for (const [index, name] of [
    'SSBJ',
    'CSRD（ESRS）',
    'ESRS-40a',
    'CDP',
    'MSCI',
    'FTSE',
  ].entries()) {
    await expect(headers.nth(index)).toContainText(name);
  }

  const row = (index: number) => table.locator('tbody tr').nth(index);
  await expect(row(0)).toContainText('公表済み');
  await expect(row(0)).toContainText('財務的重要性');
  await expect(row(0)).toContainText(/\d+ \/ 133 件/);
  await expect(row(0)).toContainText('人が確認済み');
  await expect(row(0)).toContainText('AI 判定のみ');

  await expect(row(1)).toContainText('サンプル（架空）');
  await expect(row(1)).toContainText('ダブル・マテリアリティ');
  await expect(row(1)).toContainText(/\d+ \/ 12 件/);
  await expect(row(1)).toContainText('改正 ESRS（2026-07-03 採択・未発効）は未収録');

  await expect(row(2)).toContainText('公開草案に基づく準備');
  await expect(row(2)).toContainText('インパクト重要性');
  await expect(row(2)).toContainText('要求事項が未収録（公開草案）のため算定しない');

  await expect(row(3)).toContainText(/承認済み \d+ \/ 12 件/);

  for (const index of [4, 5]) {
    await expect(row(index)).toContainText('今後対応予定');
    await expect(row(index)).toContainText('評価項目マスター未収録のため算定しない');
    await expect(row(index)).not.toContainText('%');
  }
});

test('他社比較: 架空の比較データと明示し、比較対象外の理由と社数を示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/analysis/benchmark');

  // 先頭のバナーと表の caption の両方に「架空の比較データ」
  await expect(page.getByRole('note', { name: '比較データについて' })).toContainText(NOTICE);
  const table = page.getByRole('table', { name: new RegExp(`^${NOTICE}`) });
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(12);
  for (const name of [
    'ピアA社（架空）',
    'ピアB社（架空）',
    'ピアC社（架空）',
    'ピアD社（架空）',
    'ピアE社（架空）',
  ]) {
    await expect(table.getByRole('columnheader', { name })).toBeVisible();
  }

  const row = (label: string) =>
    table.locator('tbody tr').filter({ has: page.locator('th[scope="row"]', { hasText: label }) });

  // Scope1: B は 12 月決算、C は単体で比較対象外。比較できる 3 社で中央値
  const scope1 = row('Scope1').first();
  await expect(scope1).toContainText('決算月が異なる');
  await expect(scope1).toContainText('範囲が異なる');
  await expect(scope1).toContainText('3 / 5 社');
  await expect(scope1).toContainText('12,400');

  // Scope2（マーケット）: D は未開示、比較できるのは 2 社なので中央値は出さない
  const scope2 = row('Scope2（マーケット基準）');
  await expect(scope2).toContainText('未開示');
  await expect(scope2).toContainText('出しません（3 社未満）');

  // 換算しない: 男女の賃金の格差率・LTIFR の 20 万時間当たりは比較対象外
  await expect(row('男女の賃金')).toContainText('定義が異なる');
  await expect(row('LTIFR')).toContainText('単位が異なる');
  await expect(row('LTIFR')).toContainText('件/20万時間');
  // 自社で算定できない値は値を出さない
  await expect(row('LTIFR')).toContainText('全社値は算定不可');
});

test('どの分析画面にも「準拠率」が無く、重大なアクセシビリティ違反が無い', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of PATHS) {
    await page.goto(path);
    await expect(main(page)).toBeVisible();
    await expect(main(page)).not.toContainText('準拠率');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, `${path}\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`).toEqual([]);
  }
});
