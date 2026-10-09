import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs, openMoreMenu } from './helpers';

/**
 * 左メニューの構成（発注者会議での再設計 + 2026-09 の 3 階層化 + 2026-10-01 の追加要望）。
 *
 * 2 つの入口——「開示対応」（目的ドリブン）と「ESG データ（GHG以外）」（データ先行）——を
 * 並べ、GHG は独立モジュール、業務管理・管理はグルーピングする。
 * 開示対応の配下は基準ごとにまとめ、SSBJ → 対応状況/要求事項/… の 3 階層にする。
 * 2026-10-01（docs/disclosure-first.md §9.1）: SSBJ の データ収集 と 開示ドラフト の間に 定性情報、
 * CSRD は SSBJ と同じ 5 画面のグループ、AI Copilot と 管理 の間に 分析（現状診断/規制対応度/他社比較）。
 * 2026-10-02（§10.1）: CSRD にも データ収集 と 開示ドラフト の間に 定性情報（同じ画面が SSBJ と CSRD の
 * 2 か所に出る。現在地は押した側の 1 つだけ）、分析に 自社経年比較（規制対応度 と 他社比較 の間）と
 * 財務影響分析（他社比較 の次）。
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
  // CSRD 配下（3 階層目）: SSBJ と同じ 6 項目。定性情報は データ収集 と 開示ドラフト の間（§10.1 ①）
  const csrd = childList(page, 'CSRD');
  await expect(csrd.getByRole('link')).toHaveText([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
    '定性情報',
    '開示ドラフト',
  ]);
  for (const [label, href] of [
    ['対応状況', '/enterprise/disclosures/csrd'],
    ['要求事項', '/enterprise/disclosures/csrd/requirements'],
    ['対応計画', '/enterprise/disclosures/csrd/plans'],
    ['定性情報', '/enterprise/narratives'],
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
  // 分析配下（閲覧専用の横断画面）。自社経年比較は 規制対応度 と 他社比較 の間、財務影響分析は 他社比較 の次
  const analysis = childList(page, '分析');
  await expect(analysis.getByRole('link')).toHaveText([
    '現状診断',
    '規制対応度',
    '自社経年比較',
    '他社比較',
    '財務影響分析',
  ]);
  for (const [label, href] of [
    ['現状診断', '/enterprise/analysis/diagnosis'],
    ['規制対応度', '/enterprise/analysis/regulations'],
    ['自社経年比較', '/enterprise/analysis/trends'],
    ['他社比較', '/enterprise/analysis/benchmark'],
    ['財務影響分析', '/enterprise/analysis/financial-impact'],
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

  // ③ データ取込（取込ジョブの一覧画面）の右上の「その他」（関係の薄い入口は L2。plan §2.26 E11）
  await page.goto('/enterprise/imports');
  await expect(
    (await openMoreMenu(main)).getByRole('menuitem', { name: 'SSBJ 開示ドラフト' }),
  ).toBeVisible();
});

test('同じ名前のリンクが SSBJ と CSRD に並んでも、現在地は開いている画面の 1 つだけ', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  const current = nav(page).locator('a[aria-current="page"]');
  const narrativesIn = (list: 'SSBJ' | 'CSRD') =>
    childList(page, list).getByRole('link', { name: '定性情報', exact: true });
  /** 定性情報の現在地が list 側の 1 つだけ（もう一方には付かない） */
  const expectNarrativesCurrentIn = async (list: 'SSBJ' | 'CSRD') => {
    await expect(narrativesIn(list)).toHaveAttribute('aria-current', 'page');
    await expect(narrativesIn(list === 'SSBJ' ? 'CSRD' : 'SSBJ')).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(current).toHaveCount(1);
  };

  // 定性情報（従来メニューでは SSBJ と CSRD の 2 か所に出る）: URL を直接開くと SSBJ 側 1 つ
  await page.goto('/enterprise/narratives');
  await expect(page.getByRole('heading', { level: 1, name: '定性情報' })).toBeVisible();
  await expectNarrativesCurrentIn('SSBJ');

  // CSRD の定性情報を押す → CSRD 側だけ。再読込しても CSRD（タブ内で覚えている）
  await narrativesIn('CSRD').click();
  await expectNarrativesCurrentIn('CSRD');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '定性情報' })).toBeVisible();
  await expectNarrativesCurrentIn('CSRD');

  // SSBJ の定性情報を押す → SSBJ 側に戻る
  await narrativesIn('SSBJ').click();
  await expectNarrativesCurrentIn('SSBJ');

  // CSRD の開示ドラフトから画面右上のリンクで定性情報へ → CSRD 側（開いていた枝に従う）
  await page.goto('/enterprise/disclosures/csrd/draft');
  await page.locator('#t4d-main').getByRole('link', { name: '定性情報' }).click();
  await page.waitForURL('**/enterprise/narratives');
  await expectNarrativesCurrentIn('CSRD');

  // 最上位のリンク（ホーム）を押すと覚えた枝を忘れ、直接開いた定性情報は SSBJ 側に戻る
  await nav(page).getByRole('link', { name: 'ホーム', exact: true }).click();
  await page.waitForURL('**/enterprise/dashboard');
  await page.goto('/enterprise/narratives');
  await expectNarrativesCurrentIn('SSBJ');

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
  // 分析そのもの（現状診断・自社経年比較・他社比較・財務影響分析）は出る（数値を読むだけで開示の権限は要らない）
  await expect(childList(page, '分析').getByRole('link')).toHaveText([
    '現状診断',
    '自社経年比較',
    '他社比較',
    '財務影響分析',
  ]);

  // 企業管理者には「管理」配下に出る
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  await expect(nav(page).getByRole('link', { name: '設定', exact: true })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '規制対応度', exact: true })).toBeVisible();
});

test('グループは開閉でき、開示の閲覧権限が無い役割は「開示対応」が既定で閉じる（開閉は利用者ごとに覚える）', async ({
  page,
}) => {
  // 拠点担当（開示の閲覧権限なし）: 開示対応は既定で閉じる（docs/ui-redesign/plan.md §1.4）。開けて、覚える
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/dashboard');
  const expand = nav(page).getByRole('button', { name: '開示対応 を展開する', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(childList(page, '開示対応')).toHaveCount(0);
  await expand.click();
  const collapse = nav(page).getByRole('button', { name: '開示対応 を折りたたむ', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  // 開いた中身は権限で絞った同じツリー（定性情報・CSRD は出さない）
  await expect(childList(page, 'SSBJ').getByRole('link')).toHaveText([
    '対応状況',
    '要求事項',
    '対応計画',
    'データ収集',
    '開示ドラフト',
  ]);
  await expect(nav(page).getByRole('link', { name: 'CSRD', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    nav(page).getByRole('button', { name: '開示対応 を折りたたむ', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  // 分析は閉じない（数値を読むだけの画面で、開示の権限は要らない）
  await expect(childList(page, '分析').getByRole('link')).toHaveText([
    '現状診断',
    '自社経年比較',
    '他社比較',
    '財務影響分析',
  ]);

  // 作成担当: すべて開いた状態から始まる。閉じたグループの子は読み上げにも出さない。現在地の祖先は開いて描く
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await nav(page).getByRole('button', { name: 'GHG を折りたたむ', exact: true }).click();
  await expect(nav(page).getByRole('link', { name: 'Cat.1', exact: true })).toHaveCount(0);
  await expect(
    nav(page).getByRole('button', { name: 'GHG を展開する', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/enterprise/ghg/suppliers');
  await expect(nav(page).getByRole('link', { name: 'Cat.1', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav(page).getByRole('button', { name: 'GHG を折りたたむ', exact: true }).click();
  await page.goto('/enterprise/dashboard');
  await nav(page).getByRole('button', { name: 'GHG を展開する', exact: true }).click();
  await expect(nav(page).getByRole('link', { name: 'Cat.1', exact: true })).toBeVisible();
});

test('監査法人のメニュー: 案件を選ぶまで手続の画面を出さず、選ぶと 計画・実施・結論・記録 に並ぶ', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/dashboard');
  const top = nav(page).locator(':scope > ul > li > a');
  await expect(top).toHaveText(['案件ホーム', '保証契約']);
  await expect(nav(page).getByText('案件を選ぶと手続の画面が並びます')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Data Room', exact: true })).toHaveCount(0);

  await page.goto('/assurance/engagements');
  await page.getByRole('link', { name: 'ENG-2026-001' }).first().click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  await expect(top).toHaveText(['案件ホーム', '保証契約', '計画', '実施', '結論', '記録']);
  await expect(childList(page, '計画').getByRole('link')).toHaveText(['概要', 'スコープ']);
  await expect(childList(page, '実施').getByRole('link')).toHaveText([
    'Data Room',
    '開示レポート',
    '母集団',
    'サンプリング',
    '保証手続・調書',
    'PBC／資料依頼',
    '指摘・例外',
  ]);
  await expect(childList(page, '結論').getByRole('link')).toHaveText(['レビューNote', 'Sign-off']);
  await expect(childList(page, '記録').getByRole('link')).toHaveText(['監査ログ', '出力']);
  // 現在地はちょうど 1 つ（概要）
  await expect(nav(page).locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(childList(page, '計画').getByRole('link', { name: '概要' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('案件を選ぶと手続の画面が並びます')).toHaveCount(0);

  // 法人管理者（案件の閲覧なし）には 案件ホーム・保証契約・設定 だけ
  await loginAs(page, DEMO_USERS.assuranceAdmin);
  await page.goto('/assurance/dashboard');
  await expect(top).toHaveText(['案件ホーム', '保証契約', '設定']);
});
