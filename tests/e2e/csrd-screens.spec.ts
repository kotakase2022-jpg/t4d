import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * CSRD の 対応計画・データ収集・開示ドラフトと DMA の事項の画面（docs/disclosure-first.md §9.4）。
 * 閲覧だけを行い、Demo Mode の共有状態は変えない（変える流れは zzz-csrd-chain.spec.ts）。
 *  - CSRD の計画・収集項目だけを出す（SSBJ の計画は混ぜない）。値は承認済みだけ
 *  - 開示ドラフトは節ごとの領域。AI 草案は候補の枠に分け、作れない節は理由を示す
 *  - DMA の算定結果は「提案」。判断は人が軸ごとに行う
 *  - 左メニューの CSRD の子に現在地が 1 つだけ付く
 *  - 閲覧のみの役割には操作を出さない／開示の閲覧権限が無い役割には中身を出さない
 *  - 重大なアクセシビリティ違反が無い
 * 対応状況・設定・要求事項は csrd.spec.ts、操作の流れは zzz-csrd-chain.spec.ts が確かめる。
 */

const BASE = '/enterprise/disclosures/csrd';
const detailHref = (code: string) => `${BASE}/requirements/${CSRD_IDS.items[code]}`;
const main = (page: Page) => page.locator('#t4d-main');
const csrdList = (page: Page) =>
  page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('list', { name: 'CSRD', exact: true });

test('対応計画: CSRD の計画だけを並べ、要求事項の詳細へ進める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/plans`);
  await expect(page.getByRole('heading', { level: 1, name: 'CSRD 対応計画' })).toBeVisible();
  await expect(main(page).getByText('サンプル（架空）').first()).toBeVisible();

  const table = page.getByRole('table', { name: 'CSRD 対応計画の一覧' });
  // Fixture の CSRD の計画 2 件（E1-4・S1-9）。SSBJ の計画（要求事項コード「気候-」等）は並ばない
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table).not.toContainText('気候-');
  const s19 = table.locator('tbody tr', { hasText: 'ESRS-S1-9' });
  await expect(s19).toContainText('female_manager_ratio');
  await expect(s19).toContainText('未着手');
  await expect(table.locator('tbody tr', { hasText: 'ESRS-E1-4' })).toContainText('対応中');
  await expect(s19.getByRole('link', { name: /ESRS-S1-9/ })).toHaveAttribute(
    'href',
    detailHref('ESRS-S1-9'),
  );
  // 次の工程（データ収集）への主導線
  await expect(main(page).getByRole('link', { name: 'CSRD データ収集' })).toHaveAttribute(
    'href',
    `${BASE}/collection`,
  );
  // 左メニュー: CSRD の「対応計画」だけが現在地（SSBJ の同名の項目には付けない）
  await expect(csrdList(page).locator('a[aria-current="page"]')).toHaveText('対応計画');
  await expect(
    page.getByRole('navigation', { name: 'メインナビゲーション' }).locator('ul ul a[aria-current]'),
  ).toHaveCount(1);
});

test('データ収集: 評価対象の要求事項 × 指標 × 拠点の状況と、計画から作った収集項目を示す', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/collection`);
  await expect(page.getByRole('heading', { level: 1, name: 'CSRD データ収集' })).toBeVisible();

  const status = page.getByRole('table', {
    name: '評価対象の要求事項 × 指標 × 拠点の当期の状況',
  });
  await expect(status.locator('tbody tr').first()).toBeVisible();
  // 対象外（E5-5）の要求事項は並べない
  await expect(status).not.toContainText('ESRS-E5-5');
  // 当期のデータも割当も無い指標は「未入力」（0 として扱わない）
  await expect(status.locator('tbody tr', { hasText: 'scope2_location' })).toContainText('未入力');

  // S1-9 の計画から作った収集項目（EU 子会社・JV）
  const created = page.getByRole('table', { name: '計画から作成した収集項目' });
  const rows = created.locator('tbody tr', { hasText: 'female_manager_ratio' });
  await expect(rows).toHaveCount(2);
  await expect(created).toContainText('欧州販売子会社');
  await expect(created).toContainText('青海マテリアル合弁会社');

  // 収集項目の作成フォーム（計画・指標・拠点・担当・期限）と、次の工程（開示ドラフト）
  await expect(page.getByRole('combobox', { name: '対象の対応計画' })).toBeVisible();
  await expect(page.getByRole('button', { name: '収集項目を作成' })).toBeVisible();
  await expect(main(page).getByRole('link', { name: 'CSRD 開示ドラフト' })).toHaveAttribute(
    'href',
    `${BASE}/draft`,
  );
  await expect(csrdList(page).locator('a[aria-current="page"]')).toHaveText('データ収集');
});

test('開示ドラフト: 節ごとの領域に AI 草案（候補）と本文を分けて示し、作れない節は理由を示す', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/draft`);
  await expect(page.getByRole('heading', { level: 1, name: 'CSRD 開示ドラフト' })).toBeVisible();
  await expect(main(page).getByText(/DMA）が未確定です/)).toBeVisible();
  for (const name of [
    'ESRS 2 全般開示',
    'E1 気候変動',
    'E3 水・海洋資源',
    'E5 資源利用と循環経済',
    'S1 自社の労働力',
    'G1 企業行動',
  ]) {
    await expect(page.getByRole('region', { name })).toBeVisible();
  }
  // マスターに要求事項が無い節（E2 等）は出さない
  await expect(page.getByRole('region', { name: 'E2 汚染' })).toHaveCount(0);

  // ESRS 2: 人が確定済み。S1: AI 草案だけ（本文に未採用）。E5: 対象外。G1: 未評価
  const esrs2 = page.getByRole('region', { name: 'ESRS 2 全般開示' });
  await expect(esrs2).toContainText('（海野 みどり）');
  const s1 = page.getByRole('region', { name: 'S1 自社の労働力' });
  await expect(s1).toContainText('AI 草案（候補・デモ生成）');
  await expect(s1.getByRole('textbox', { name: 'S1 自社の労働力の本文' })).toHaveValue('');
  await expect(s1.getByRole('button', { name: '本文に採用' })).toBeVisible();
  await expect(s1.getByRole('button', { name: '保存済みの本文で確定' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'E5 資源利用と循環経済' })).toContainText('対象外');
  await expect(page.getByRole('region', { name: 'G1 企業行動' })).toContainText('未評価');

  // 書けなかった箇所・節の要求事項のコードは要求事項の詳細へ
  await expect(s1.getByRole('link', { name: 'ESRS-S1-9' }).first()).toHaveAttribute(
    'href',
    detailHref('ESRS-S1-9'),
  );
  // 定性情報（全基準共通の資産）へは右上から
  await expect(main(page).getByRole('link', { name: '定性情報' })).toHaveAttribute(
    'href',
    '/enterprise/narratives',
  );
  await expect(csrdList(page).locator('a[aria-current="page"]')).toHaveText('開示ドラフト');
});

test('DMA の事項（E1）: IRO と算定結果（提案）・軸ごとの人の判断を示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/settings/matters/E1`);
  await expect(
    page.getByRole('heading', { level: 1, name: /E1 気候変動（ダブル・マテリアリティ評価）/ }),
  ).toBeVisible();
  const iros = page.getByRole('table', { name: 'E1 気候変動 の IRO' });
  await expect(iros.locator('tbody tr')).toHaveCount(2);
  await expect(iros).toContainText('製造拠点の GHG 排出');
  await expect(iros).toContainText('炭素価格');
  // 算定結果は提案（自社の方法・閾値）。判断は人が根拠付きで行う
  await expect(page.getByRole('region', { name: /インパクト.*の算定結果/ })).toContainText('4.0');
  await expect(page.getByRole('region', { name: /財務.*の算定結果/ })).toContainText('4.0');
  const impact = page.getByRole('group', { name: /インパクト重要性/ });
  await expect(impact.getByLabel('重要', { exact: true })).toBeChecked();
  await expect(
    page.getByRole('group', { name: /財務的重要性/ }).getByLabel('重要', { exact: true }),
  ).toBeChecked();
  // 設定画面（メニュー外）にいる間は、CSRD の子に現在地を付けない（§9.1）
  await expect(csrdList(page).locator('a[aria-current="page"]')).toHaveCount(0);
});

test('AI の実行・指標の管理の権限が無い役割（レビュー担当）には生成・収集項目の作成を出さず、拠点担当には中身を出さない', async ({
  page,
}) => {
  // レビュー担当は開示を編集できるが、AI の実行（enterprise.ai.run）と指標の管理（metric.manage）は無い
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(`${BASE}/draft`);
  const e1 = page.getByRole('region', { name: 'E1 気候変動' });
  await expect(e1).toContainText('AI の実行権限が無いため、草案は作れません。');
  await expect(main(page).getByRole('button', { name: /AI 草案を/ })).toHaveCount(0);
  await page.goto(`${BASE}/requirements/${CSRD_IDS.items['ESRS-E1-6']}`);
  await expect(page.getByRole('heading', { level: 1, name: /ESRS-E1-6/ })).toBeVisible();
  await expect(main(page).getByRole('button', { name: /AI ギャップ分析/ })).toHaveCount(0);
  await page.goto(`${BASE}/collection`);
  await expect(
    main(page).getByText('収集項目の作成には、開示の編集権限と指標の管理権限の両方が必要です。'),
  ).toBeVisible();
  await expect(main(page).getByRole('button', { name: '収集項目を作成' })).toHaveCount(0);

  await loginAs(page, DEMO_USERS.siteUser);
  for (const path of [
    BASE,
    `${BASE}/settings`,
    `${BASE}/requirements`,
    `${BASE}/plans`,
    `${BASE}/collection`,
    `${BASE}/draft`,
  ]) {
    await page.goto(path);
    await expect(main(page).getByText('アクセス権限がありません'), path).toBeVisible();
    await expect(main(page).getByRole('table'), path).toHaveCount(0);
  }
});

test('CSRD の対応計画・データ収集・開示ドラフト・事項（G1）に重大なアクセシビリティ違反が無い', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    `${BASE}/plans`,
    `${BASE}/collection`,
    `${BASE}/draft`,
    `${BASE}/settings/matters/G1`,
  ]) {
    await page.goto(path);
    await expect(main(page)).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, `${path}\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`).toEqual([]);
  }
});
