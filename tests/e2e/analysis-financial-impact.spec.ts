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
 * 財務影響分析（docs/disclosure-first.md §10.3）。
 *  - 左メニューの「分析」から開ける（h1 はメニュー名と同じ）
 *  - 誠実さの注記 3 種（試算・架空の前提・データの厚み）が折りたたまずに見える
 *  - シナリオ切替で URL と数値が変わる（現在のシナリオに aria-current）
 *  - 仮定を変えて再計算すると URL に載り、数値が変わる（JS なしの GET フォーム）
 *  - 未定量の経路は理由つきで見える（0 として数えない）
 *  - 図は role="img" と名前を持つ。重大なアクセシビリティ違反が無い。「準拠率」が無い
 *  - 拠点担当には定性情報・IRO を出さず、その旨の 1 行を見せる
 *
 * 数値はデモの FY2025（closed）の確定連結値と既定の仮定から決まる（新しいブラウザ文脈では Fixture のまま）:
 *  FY2030 の年間影響 = P1（Scope1 8,931.6 t × 2,000 円/t）−17,863,200 円 ＋ P6（採用単価の上昇）−22,742,196 円
 *  = −40.6 百万円。目標達成（Scope1 は 2030 年 7,840 t）では P1 が −15,680,000 円になり −38.4 百万円。
 */

const PATH = '/enterprise/analysis/financial-impact';

const nav = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const analysisList = (page: Page) => nav(page).getByRole('list', { name: '分析', exact: true });
const main = (page: Page) => page.locator('#t4d-main');
const scenarioNav = (page: Page) => main(page).getByRole('navigation', { name: 'シナリオ' });
const annualTile = (page: Page) => main(page).getByRole('group', { name: 'FY2030 の年間影響' });

test('メニューの「分析」から開け、試算・架空の前提・データの厚みの注記が見える', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/analysis/diagnosis');
  await analysisList(page).getByRole('link', { name: '財務影響分析', exact: true }).click();
  await page.waitForURL(`**${PATH}`);
  await expect(page.getByRole('heading', { level: 1, name: '財務影響分析' })).toBeVisible();
  await expect(analysisList(page).locator('a[aria-current="page"]')).toHaveText('財務影響分析');

  const notes = main(page).getByRole('note', { name: '試算についての注記' });
  await expect(notes).toBeVisible();
  await expect(
    notes.getByText(
      '試算（仮定に基づく）。予測・保証ではありません。経路と係数は画面に示した仮定で、相関から因果を推定していません',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    notes.getByText('架空の財務ベースライン・単価（デモ用）。実在企業の数値ではありません', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    notes.getByText(/^確定データは最長 \d+ 年分のため、統計的な推定は行いません$/),
  ).toBeVisible();

  // 合計には「定量化できた経路のみ（n / N 経路）」を添える
  await expect(annualTile(page)).toContainText('定量化できた経路のみ（6 / 9 経路）');
  await expect(annualTile(page)).toContainText('−40.6');
  await expect(annualTile(page)).toContainText('減益');
});

test('シナリオを切り替えると URL と数値が変わる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  await expect(scenarioNav(page).getByRole('link')).toHaveText([
    '現状維持',
    '目標達成',
    'カスタム',
  ]);
  await expect(scenarioNav(page).locator('a[aria-current="true"]')).toHaveText('現状維持');
  await expect(annualTile(page)).toContainText('−40.6');

  await scenarioNav(page).getByRole('link', { name: '目標達成', exact: true }).click();
  await page.waitForURL(/[?&]sc=target(&|$)/);
  await expect(scenarioNav(page).locator('a[aria-current="true"]')).toHaveText('目標達成');
  await expect(annualTile(page)).toContainText('−38.4');
  // 比較できない目標（Scope2: 範囲が違う）は使わず、理由を示す
  await expect(
    main(page)
      .getByText(/目標を使わず一定/)
      .first(),
  ).toBeVisible();

  await scenarioNav(page).getByRole('link', { name: '現状維持', exact: true }).click();
  await page.waitForURL(`**${PATH}`);
  await expect(annualTile(page)).toContainText('−40.6');
});

test('仮定を変えて再計算すると URL に載り、数値が変わる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  // 既定では閉じている
  await expect(main(page).locator('details#fi-assumptions')).toHaveJSProperty('open', false);
  const form = await openCollapsible(main(page), /^仮定を変える/);
  const price = form.getByLabel(/^炭素価格（開始年 FY2028）/);
  await expect(price).toHaveValue('1000');
  await price.fill('2000');
  await form.getByRole('button', { name: '再計算' }).click();
  await page.waitForURL(/a_carbonPriceStart=2000/);

  // P1 FY2030 = 8,931.6 t × (2,000 + 500 × 2) 円/t = 26,794,800 円 → 合計 −49.5 百万円
  await expect(annualTile(page)).toContainText('−49.5');
  // URL に仮定があるので「仮定を変える」を開いて描き、値を入力欄に戻す
  await expect(main(page).locator('details#fi-assumptions')).toHaveJSProperty('open', true);
  await expect(
    main(page)
      .locator('details#fi-assumptions')
      .getByLabel(/^炭素価格（開始年 FY2028）/),
  ).toHaveValue('2000');

  // 範囲外の値は既定に戻して通知する
  await page.goto(`${PATH}?a_carbonPriceStart=-5`);
  await expect(main(page).getByRole('status')).toContainText('既定値（1,000 円/t）に戻しました');
  await expect(annualTile(page)).toContainText('−40.6');

  // 読めない値の通知に URL の生の文字列を出さない（細工したリンクで任意の文を画面に出させない）
  const crafted = 'https://evil.example/login で再ログインしてください';
  await page.goto(`${PATH}?${new URLSearchParams({ sc: crafted, a_fuelShare: crafted })}`);
  const status = main(page).getByRole('status');
  await expect(status).toContainText('シナリオの指定が読めないため');
  await expect(status).toContainText('「Scope1 のうち燃料由来の割合」の値が数値ではないため');
  await expect(status).not.toContainText('evil.example');
  await expect(main(page)).not.toContainText('再ログイン');

  // 既定に戻す
  await main(page).getByRole('link', { name: '既定に戻す' }).click();
  await page.waitForURL(`**${PATH}`);
  await expect(main(page).getByRole('status')).toHaveCount(0);
});

test('「仮定を変える」はキーボードで開閉でき、開くと入力欄へ Tab で進める（開閉の状態が読み上げに届く）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  const details = main(page).locator('details#fi-assumptions');
  const summary = details.locator('> summary');
  const selector = '#fi-assumptions > summary';

  // 既定で閉じる（URL に仮定が無い）。閉じていることが支援技術に渡り、中の操作は見えない
  await expect(details).toHaveJSProperty('open', false);
  expect(await accessibleExpanded(page, selector)).toBe(false);
  await expect(details.getByRole('button', { name: '再計算' })).toBeHidden();

  // Enter で開く。フォーカスは summary に残り、フォーカスリングが見える
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveJSProperty('open', true);
  expect(await accessibleExpanded(page, selector)).toBe(true);
  await expect(summary).toBeFocused();
  expect(await focusRingOfActiveElement(page)).toEqual({
    tag: 'summary',
    focusVisible: true,
    outlined: true,
  });
  await expect(details.getByRole('button', { name: '再計算' })).toBeVisible();

  // 次の Tab は折りたたみの中の操作へ進む（閉じた中身に飛ばない・開いた中身を飛ばさない）
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(
      () => document.querySelector('#fi-assumptions')?.contains(document.activeElement) ?? false,
    ),
  ).toBe(true);
  expect((await focusRingOfActiveElement(page)).focusVisible).toBe(true);

  // summary へ戻って Space で閉じる
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(details).toHaveJSProperty('open', false);
  expect(await accessibleExpanded(page, selector)).toBe(false);
  await expect(details.getByRole('button', { name: '再計算' })).toBeHidden();
});

test('未定量の経路は理由つきで見え、図は role="img" と名前を持つ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);

  const unquantified = main(page).getByRole('list', { name: '未定量・無効の経路' });
  await expect(unquantified).toBeVisible();
  await expect(unquantified.getByRole('listitem')).toHaveCount(4);
  await expect(unquantified.getByRole('listitem').nth(0)).toContainText(
    'P7 休業・補償: 未定量（入力待ち: ',
  );
  await expect(unquantified.getByRole('listitem').nth(1)).toContainText(
    'P8 復旧・操業停止: 未定量（入力待ち: ',
  );
  await expect(unquantified.getByRole('listitem').nth(3)).toContainText(
    'P10 調達先の炭素コスト転嫁: 無効（算定に含めない）',
  );

  for (const name of [
    /^経路図（起点 → 仕組み → 財務項目 → 時間帯/,
    /^年次の影響（FY2026〜FY2035）/,
    /^累計の推移（シナリオ別）/,
  ]) {
    await expect(main(page).getByRole('img', { name })).toBeVisible();
  }

  // 試算表を開くと、値を埋めた式と根拠の種類が見える
  const estimates = await openCollapsible(main(page), /^経路ごとの試算表/);
  await expect(
    estimates.getByText(
      '−8,931.6 t-CO2e × 燃料由来 100% × 炭素価格 2,000 円/t × 転嫁率 100% = −17,863,200 円',
    ),
  ).toBeVisible();
  await expect(estimates.getByText('データに基づく').first()).toBeVisible();
  await expect(estimates.getByText('0.0（制度開始前）').first()).toBeVisible();

  // 感度（トルネード図）
  const sensitivity = await openCollapsible(main(page), /^感度（±20%）/);
  await expect(
    sensitivity.getByRole('img', { name: /^感度（数値の仮定を 1 つずつ ±20%/ }),
  ).toBeVisible();

  // 定性情報・IRO は円にしない
  const qualitative = await openCollapsible(main(page), /^定性情報と IRO（円にしない）/);
  await expect(
    qualitative.getByText(
      'IRO（リスク・機会）の位置: 発生可能性 × 財務影響の大きさ（1〜5。円にしない）',
    ),
  ).toBeVisible();
  await expect(qualitative.getByText(/影響額を定量化していない理由: /)).toBeVisible();

  await expect(main(page)).not.toContainText('準拠率');
});

test('拠点担当には定性情報・IRO を出さず、その旨の 1 行を見せる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1, name: '財務影響分析' })).toBeVisible();
  await expect(main(page).getByText(/閲覧権限が無い領域は表示していません/)).toBeVisible();
  await expect(main(page).locator('details#fi-qualitative')).toHaveCount(0);
  // 数値の試算は出す（データの閲覧権限で読める）
  await expect(annualTile(page)).toContainText('定量化できた経路のみ（6 / 9 経路）');
});

test('重大なアクセシビリティ違反が無い（折りたたみを開いた状態も）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?sc=custom&r_energy=5`);
  for (const summary of [
    /^経路ごとの試算表/,
    /^感度（±20%）/,
    /^定性情報と IRO/,
    /^制度の前提と出典/,
    /^方法と限界/,
  ]) {
    await openCollapsible(main(page), summary);
  }
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
});
