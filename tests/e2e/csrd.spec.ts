import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { DEMO_USERS, loginAs, openCollapsible, openMoreMenu } from './helpers';

/**
 * CSRD ワークスペース（機能追加要望 ②・2026-10-01 の再構成 docs/disclosure-first.md §9）。
 * ナビゲーション → 対応状況（ギャップ分析表）→ 要求事項の詳細 → 回答画面（共有ビュー）→ AI ドラフト生成までを
 * 実ブラウザで確認する。CSRD はダブル・マテリアリティで、設定（DMA）と要求事項の適用が画面に出る。
 *
 * 2026-10-01: 対応状況に工程・DMA 要約などを足したため、行数はギャップ分析表（名前付き）に絞る。
 * 要求事項コードのリンク先は要求事項の詳細になり、回答画面へは「回答を編集（版・承認）」から進む。
 * 2026-10-07（UI 再設計 plan T8・E24）: ギャップ分析表は同じ母集団の要求事項の一覧へ寄せた（データの揃い具合・
 * 当年値・回答状況は一覧の列）。対応状況からは件数付きのリンクで一覧を開く。設定は段階の UI（?step=）。
 */

test.describe.configure({ mode: 'serial' });

/** 回答画面（既存の共有ビュー）の URL。要求事項の詳細（/csrd/requirements/{id}）と区別する */
const ANSWER_URL = /\/enterprise\/disclosures\/csrd\/[0-9a-f-]{36}$/;

test('サイドバーから CSRD を開き、ギャップ分析（要求事項の一覧のデータ・回答の列）が表示される', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // nav の開示対応配下に CSRD が出る
  await page.getByRole('link', { name: 'CSRD' }).first().click();
  await page.waitForURL(/\/enterprise\/disclosures\/csrd/);

  await expect(page.getByRole('heading', { name: /CSRD 開示対応/ })).toBeVisible();
  await expect(page.getByText('初年度対応')).toBeVisible();
  // 対応状況には表を置かない（同じ母集団の表を 2 つ置かない。ギャップ分析表は要求事項の一覧へ寄せた。plan T8）
  await expect(page.locator('#t4d-main table')).toHaveCount(0);

  // 文字量を減らす（§10.4）: SSBJ との違いは短い 1 行で見せ、全文は閉じる（開いてから確かめる）
  const main = page.locator('#t4d-main');
  await expect(
    main.getByText(
      'SSBJ は財務的重要性のみ（シングル）。CSRD はインパクトか財務のどちらかで重要なら適用（ダブル）',
    ),
  ).toBeVisible();
  const full = main.getByText(/投資家の意思決定に影響する情報/);
  await expect(full).toBeHidden();
  await openCollapsible(main, 'SSBJ との違い');
  await expect(full).toBeVisible();
  // DMA の結果・適用の内訳は帯＋凡例（分母付き）。適用の各区分は要求事項の絞込へ
  await expect(main.getByRole('list', { name: '事項の結果（人の判断）' })).toContainText(
    '/ 10 事項',
  );
  await expect(
    main
      .getByRole('list', { name: '適用の内訳' })
      .getByRole('link', { name: '対象外（重要でない）' }),
  ).toHaveAttribute('href', '/enterprise/disclosures/csrd/requirements?applicability=not_material');

  // ギャップ分析: 対応状況のリンクから、データ・回答の列を出した要求事項の一覧を開く。
  // データありとデータなしの両方の状態が見える（12 行）
  await main.getByRole('link', { name: '要求事項の評価の一覧' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/csrd\/requirements\?cols=/);
  const gapTable = page.getByRole('table', { name: 'CSRD 要求事項の評価' });
  await expect(gapTable.getByText('データあり').first()).toBeVisible();
  await expect(gapTable.getByText('承認済みデータなし').first()).toBeVisible();
  await expect(gapTable.locator('tbody tr')).toHaveCount(12);
});

test('ESRS 項目の要求事項の詳細から回答画面を開き、AI ドラフトを生成できる（共有ビュー）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // 要求事項のコードは要求事項の一覧（ギャップ分析を寄せた表）から詳細へ
  await page.goto('/enterprise/disclosures/csrd/requirements');
  await page
    .getByRole('table', { name: 'CSRD 要求事項の評価' })
    .getByRole('link', { name: /^ESRS-E1-5\s/ })
    .click();

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

  // AI ドラフトの生成は回答の見出しの「その他」（plan S6）
  await (await openMoreMenu(page)).getByRole('menuitem', { name: 'ドラフトを生成' }).click();
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
  // 考え方の詳細は既定で閉じる。改正 ESRS が未発効であることは summary で閉じていても見える（§10.4）
  await expect(
    main.getByText(/改正 ESRS（2026-07-03 採択）は未発効・本サンプルに未反映/),
  ).toBeVisible();
  const law = main.getByText(/官報掲載の報道あり（一次資料で確認中）・未発効/);
  await expect(law).toBeHidden();
  await openCollapsible(main, /^考え方の詳細/);
  await expect(law).toBeVisible();
  // 段階の UI（?step=）: 既定は未完了の最初の手順（③ 10 事項の判断と DMA の確定）
  await expect(main.getByRole('img', { name: /ダブル・マテリアリティ・マトリクス/ })).toBeVisible();
  // 10 事項。G1 は人の判断が未評価のため、DMA はまだ確定できない
  const dma = main.getByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' });
  await expect(dma.locator('tbody tr')).toHaveCount(10);
  await expect(main.getByRole('button', { name: 'DMA を確定する' })).toBeDisabled();

  // 閾値と算定式は手順②。手順の帯から開いて確かめる
  await main
    .getByRole('navigation', { name: 'CSRD 設定の手順' })
    .getByRole('link', { name: /② 評価方法・閾値/ })
    .click();
  await page.waitForURL(/[?&]step=method/);
  // 算定式は閉じる。ESRS が数値の閾値を定めていないことは summary に見せる
  await expect(
    main.locator('summary').filter({ hasText: /ESRS は数値の閾値を定めていません/ }),
  ).toBeVisible();
  const formula = main.getByText(/√\(発生可能性 × 財務影響の大きさ\)/);
  await expect(formula).toBeHidden();
  await openCollapsible(main, /^算定式と閾値の決め方/);
  await expect(formula).toBeVisible();
  await expect(main.getByLabel('インパクトの閾値（インパクト重要性）')).toHaveValue('3.0');
  await expect(main.getByLabel('財務の閾値（財務的重要性）')).toHaveValue('3.0');

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

  // 文字量を減らす（§10.4）: SSBJ との違いは 1 行（未発効の注記を含む）で見せ、根拠の全文は閉じる
  const main = page.locator('#t4d-main');
  const note = main.getByRole('note').filter({ hasText: 'SSBJ は財務的重要性のみ（シングル）' });
  await expect(note).toBeVisible();
  await expect(note.getByText(/改正 ESRS（2026-07-03 採択）は未発効/)).toBeVisible();
  const law = note.getByText(/官報掲載の報道あり（一次資料で確認中）・未発効/);
  await expect(law).toBeHidden();
  await openCollapsible(note, '考え方の根拠と注記');
  await expect(law).toBeVisible();
  // 件数の流れは図（件数は文字）。評価対象の段は絞込へ。段ごとの内訳は閉じる
  const funnel = main.getByRole('list', { name: '評価対象の件数の流れ' });
  await expect(funnel.getByRole('listitem')).toHaveCount(3);
  await expect(funnel.getByRole('listitem').first()).toContainText('12 項目');
  await expect(funnel.getByRole('link', { name: '対象外を除く（評価対象）' })).toHaveAttribute(
    'href',
    '/enterprise/disclosures/csrd/requirements?applicability=always&applicability=material',
  );
  const breakdown = main.getByText(/ESRS 2（常に適用）\s*2\s*件＋重要と判断 7 件/);
  await expect(breakdown).toBeHidden();
  await openCollapsible(main, '件数の内訳');
  await expect(breakdown).toBeVisible();
  // 架空の縮小サンプルであることは閉じずに見せる
  await expect(main.getByText(/収録は ESRS の架空の縮小サンプル 12 項目/)).toBeVisible();

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
