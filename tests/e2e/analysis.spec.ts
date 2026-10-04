import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs, openCollapsible } from './helpers';

/**
 * 分析（docs/disclosure-first.md §9.5・§9.6・§9.7）。閲覧専用の 現状診断・規制対応度・他社比較。
 *  - 左メニューの「分析」から 5 画面（現状診断・規制対応度・自社経年比較・他社比較・財務影響分析。§10.1）を開ける
 *    （自社経年比較・財務影響分析の中身は analysis-trends.spec.ts・analysis-financial-impact.spec.ts）
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

test('メニューの「分析」から 5 画面を開ける（入口は現状診断）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await nav(page).getByRole('link', { name: '分析', exact: true }).click();
  await page.waitForURL('**/enterprise/analysis/diagnosis');
  await expect(page.getByRole('heading', { level: 1, name: '現状診断' })).toBeVisible();
  await expect(analysisList(page).getByRole('link')).toHaveText([
    '現状診断',
    '規制対応度',
    '自社経年比較',
    '他社比較',
    '財務影響分析',
  ]);

  // h1 はメニュー名と同じ（§10.1 ③）。現在地は開いた画面の 1 つだけ
  for (const [label, path] of [
    ['規制対応度', '/enterprise/analysis/regulations'],
    ['自社経年比較', '/enterprise/analysis/trends'],
    ['他社比較', '/enterprise/analysis/benchmark'],
    ['財務影響分析', '/enterprise/analysis/financial-impact'],
    ['現状診断', '/enterprise/analysis/diagnosis'],
  ] as const) {
    await analysisList(page).getByRole('link', { name: label, exact: true }).click();
    await page.waitForURL(`**${path}`);
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    await expect(analysisList(page).locator('a[aria-current="page"]')).toHaveText(label);
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

  // 件数は「n / 分母 件」で示す（帯は補助。名前にも n / 分母）
  const collection = page.getByRole('region', { name: 'データ収集・承認' });
  await expect(collection.getByText(/^\d+ \/ \d+ 件$/).first()).toBeVisible();
  await expect(collection.getByText(/^分母: /).first()).toBeVisible();
  await expect(collection.getByRole('img', { name: /^承認済み: \d+ \/ \d+ 件$/ })).toBeVisible();
  // 拠点別の表は既定で閉じる（docs/disclosure-first.md §10.4）。開くと拠点ごとの件数
  await expect(collection.getByRole('table', { name: /拠点別の承認状況/ })).toHaveCount(0);
  const units = await openCollapsible(collection, /^拠点別の承認状況（\d+ 拠点）$/);
  await expect(units.getByRole('table', { name: /拠点別の承認状況/ })).toBeVisible();

  // GHG: 連結対象の拠点が分母。Scope3 合計は未算定（0 と出さない）
  const ghg = page.getByRole('region', { name: 'GHG 算定の網羅性' });
  await expect(ghg.getByText(/^\d+ \/ 4 拠点$/).first()).toBeVisible();
  await expect(ghg.getByText(/^\d+ \/ 15 カテゴリ$/)).toBeVisible();
  await expect(ghg.getByText('未算定', { exact: true })).toBeVisible();
  // Scope3 は 15 カテゴリの格子（状態は文字）
  await expect(
    ghg.getByRole('list', { name: 'Scope3 のカテゴリ（1〜15）の登録状況' }).getByRole('listitem'),
  ).toHaveCount(15);

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
  // 状況の内訳は積み上げ帯＋凡例（5 状態を文字で。% は出さない）
  await expect(
    row(0)
      .getByRole('list', { name: /の状況の内訳$/ })
      .getByRole('listitem'),
  ).toHaveCount(5);

  await expect(row(1)).toContainText('サンプル（架空）');
  await expect(row(1)).toContainText('ダブル・マテリアリティ');
  await expect(row(1)).toContainText(/\d+ \/ 12 件/);
  // 未発効・AI の扱いの注記は閉じない（数え方の全文だけを閉じる）
  await expect(row(1).getByText('改正 ESRS（2026-07-03 採択・未発効）は未収録')).toBeVisible();
  await expect(row(1).getByText(/^内訳は人が確定した値だけで数えます/)).toBeVisible();
  const counting = await openCollapsible(row(1), '評価対象と内訳の数え方');
  await expect(counting.getByText(/^評価対象は「ESRS 2（常に適用）」/)).toBeVisible();

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
  // 指標の行は 12（定義・注記は行見出しの外の全幅の行に分けているので、行見出しのある行で数える）
  await expect(table.locator('tbody tr:has(th[scope="row"])')).toHaveCount(12);
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

  // 比較の決まりは既定で閉じ、要点の 1 行は見える（§10.4）。開くと規則の一覧
  await expect(
    page.getByText('比較の決まり: 同条件の会社だけ・換算しない・順位なし', { exact: true }),
  ).toBeVisible();
  const rules = await openCollapsible(page, /^比較の決まり/);
  await expect(
    rules.getByText('第三者保証の有無は注記です（比較の可否には使いません）。'),
  ).toBeVisible();
  // 範囲の図は比較できる社だけの中立色の帯。印の意味は文字の凡例
  await expect(page.getByRole('list', { name: '範囲の図の見方' })).toBeVisible();

  // Scope1: B は 12 月決算、C は単体で比較対象外。比較できる 3 社で中央値
  const scope1 = row('Scope1').first();
  await expect(scope1.locator('svg[data-benchmark-range]')).toHaveCount(1);
  await expect(scope1).toContainText('決算月が異なる');
  await expect(scope1).toContainText('範囲が異なる');
  await expect(scope1).toContainText('3 / 5 社');
  await expect(scope1).toContainText('12,400');
  // 数値の列は右寄せで、中央値・範囲にも単位を付ける。1 列目（指標）は横スクロールしても見えるよう固定する
  const median = scope1.locator('td').nth(-2);
  await expect(median).toContainText(/12,400\s*t-CO2e/);
  await expect(median).toHaveCSS('text-align', 'right');
  await expect(scope1.locator('td').last()).toContainText('t-CO2e');
  await expect(scope1.locator('th[scope="row"]')).toHaveCSS('position', 'sticky');

  // Scope2（マーケット）: D は未開示、比較できるのは 2 社なので中央値は出さない
  const scope2 = row('Scope2（マーケット基準）');
  await expect(scope2).toContainText('未開示');
  await expect(scope2).toContainText('出しません（3 社未満）');

  // 定義・注記は行見出しの名前に含めない（読み上げで値より先に読まれないよう、次の全幅の行に閉じて置く）
  await expect(scope2.locator('th[scope="row"]')).toHaveText('Scope2（マーケット基準）（t-CO2e）');
  const scope2Notes = await openCollapsible(
    table.locator('tr[data-benchmark-notes="scope2_market"]'),
    /^Scope2（マーケット基準） の定義・注記$/,
  );
  await expect(
    scope2Notes.getByText('ロケーション基準とは別の指標です。読み替え・合算はしません。'),
  ).toBeVisible();

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
