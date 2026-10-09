import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import {
  confirmInDialog,
  DEMO_USERS,
  loginAs,
  openCollapsible,
  openMoreMenu,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * 本文・インパクト・基準版（トライアル対応 T8: NF-06・NF-10・NF-11・NF-12・NF-19。e2e:trial-content-impact）。
 *
 *  - 定性情報の一覧に「基準別の状況」の列と絞り込み。編集画面の「基準別の対応状況」に基準ごとの区分
 *    （SSBJ と CSRD 域外を別に。サンプルは充足確認済みにならない旨を閉じずに出す）
 *  - 要求事項の直接の対応付け（原稿が無くても「原稿なし」の不足が出る）と、外した後の「元に戻す」
 *  - AI の対応付けの候補は候補として見せ（AI の候補・デモ生成（Mock））、採用しなければ対応付けにならない
 *  - インパクト・リスク・機会の台帳: 列で SSBJ（企業への影響）と CSRD・40a（人・環境へのインパクト）を分ける。
 *    定性情報で選んだ IRO が SSBJ の列に出る
 *  - CSRD の 6 画面の見出しの下に「EU 法人向け・通常 ESRS（2023 年版）の架空サンプル」の注記
 *  - SSBJ の対象年度×基準版。プロジェクト設定に公開草案（未収録）
 *  - SSBJ 開示ドラフトの確定本文を開示プロジェクトの原稿へ取り込む（その他 ▾・確認ダイアログ）
 * 後片付け: 開示デモを初期状態に戻し、開示優先モードを OFF にする（後続の spec が既定の状態を見る）
 */

test.describe.configure({ mode: 'serial' });

const main = (page: Page) => page.locator('#t4d-main');
const NARRATIVES = '/enterprise/narratives';
const GOVERNANCE = `${NARRATIVES}/${IDS.narratives.governance}`;
const TRANSITION = `${NARRATIVES}/${IDS.narratives.riskTransition}`;
const IMPACTS = '/enterprise/disclosures/impacts';
const CSRD_NOTE =
  'EU 法人向け・通常 ESRS（2023 年版）の架空サンプル。CSRD 域外（ESRS-40a）は開示プロジェクトで扱います';
const NEW_NARRATIVE = 'E2E 移行リスクの説明（台帳の確認用・架空）';

async function expectNoSeriousAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test.afterAll(async ({ browser }) => {
  const admin = await browser.newPage();
  try {
    await loginAs(admin, DEMO_USERS.enterpriseAdmin);
    await setDisclosureFirst(admin, true);
    try {
      await admin.goto('/enterprise/dashboard');
      await resetDisclosureDemo(admin);
    } finally {
      await setDisclosureFirst(admin, false);
    }
  } finally {
    await admin.close();
  }
});

test('定性情報の一覧: 基準別の状況の列と絞り込み（要求事項との対応なし）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(NARRATIVES);
  const table = main(page).getByRole('table', { name: '定性情報' });
  const governance = table.getByRole('row').filter({ hasText: '気候関連のガバナンス体制' });
  await expect(governance.locator('[data-coverage-summary]')).toHaveText(/^SSBJ .+／CSRD 域外 .+$/);

  await page.goto(`${NARRATIVES}?coverage=unmapped`);
  await expect(
    main(page)
      .getByRole('table', { name: '定性情報' })
      .getByRole('row', {
        name: /気候関連のガバナンス体制/,
      }),
  ).toHaveCount(0);
});

test('編集画面: 基準別の対応状況（SSBJ と CSRD 域外を別に。サンプルは充足確認済みにならない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(GOVERNANCE);
  const coverage = main(page).locator('[data-coverage-panel]');
  await expect(main(page).getByRole('heading', { name: '基準別の対応状況' })).toBeVisible();
  const ssbj = coverage.locator('[data-coverage-group="ssbj"]');
  const e40a = coverage.locator('[data-coverage-group="esrs_40a"]');
  await expect(ssbj).toContainText('SSBJ');
  await expect(e40a).toContainText('CSRD 域外');
  // 40a は試行用サンプル（架空）。誠実さの注記は閉じずに見える
  await expect(e40a.locator('[data-honesty="sample-master"]')).toBeVisible();
  await expect(e40a).toContainText('公開草案・サンプルの基準は「充足確認済み」になりません');
  // 要求事項の行は折りたたみ（L2）。開くと 40A-S01 の行と要求事項の詳細へのリンク
  const rows = await openCollapsible(e40a, /^要求事項の行/);
  await expect(rows.locator('[data-coverage-row="40A-S01"]')).toBeVisible();
  await expect(rows.getByRole('link', { name: '40A-S01' })).toHaveAttribute(
    'href',
    new RegExp(`/enterprise/disclosure-projects/${IDS.projects.fy2026}/requirements/`),
  );
  await expect(rows.locator('[data-coverage-row="40A-S01"]').getByText('充足確認済み')).toHaveCount(
    0,
  );
  await expectNoSeriousAxe(page);
});

test('要求事項を直接対応付ける → 原稿なしの不足が出る → 外す → 元に戻す → 外す', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(TRANSITION);
  const coverage = main(page).locator('[data-coverage-panel]');
  const form = await openCollapsible(coverage, /^要求事項を直接対応付ける/);
  await form.locator('select[name="itemId"]').selectOption(esrs40aSampleItemId('40A-S04'));
  await form.getByRole('button', { name: '対応付けを追加' }).click();
  await page.waitForURL(/flash=narrativeLinkAdded/);
  await expect(main(page).getByText(/要求事項を定性情報に対応付けました/)).toBeVisible();

  const e40a = main(page).locator('[data-coverage-group="esrs_40a"]');
  const rows = await openCollapsible(e40a, /^要求事項の行/);
  const row = rows.locator('[data-coverage-row="40A-S04"]');
  await expect(row).toContainText('未対応');
  await expect(row).toContainText('原稿なし');
  await expect(row).toContainText('直接の対応付け');

  await row.getByRole('button', { name: '40A-S04 との直接の対応付けを外す' }).click();
  await page.waitForURL(/flash=narrativeLinkRemoved/);
  await expect(main(page).getByText(/直接の対応付けを外しました/)).toBeVisible();
  // 元に戻す（同じ要求事項を対応付け直す）
  await main(page).getByRole('button', { name: '元に戻す' }).click();
  await page.waitForURL(/flash=narrativeLinkAdded/);
  const again = await openCollapsible(
    main(page).locator('[data-coverage-group="esrs_40a"]'),
    /^要求事項の行/,
  );
  await again
    .locator('[data-coverage-row="40A-S04"]')
    .getByRole('button', { name: '40A-S04 との直接の対応付けを外す' })
    .click();
  await page.waitForURL(/flash=narrativeLinkRemoved/);
});

test('AI の対応付けの候補: 候補として見せ、採用しなければ対応付けにならない（不採用の理由を残す）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(GOVERNANCE);
  const ai = main(page).getByRole('region', { name: 'AI の対応付けの候補' });
  await ai.getByRole('button', { name: 'AI に候補を出させる' }).click();
  await page.waitForURL(/mappingRun=/);
  const panel = main(page).getByRole('region', { name: 'AI の対応付けの候補' });
  await expect(panel.locator('[data-honesty="ai-candidate"]')).toBeVisible();
  await expect(panel.locator('[data-honesty="mock-ai"]')).toBeVisible();
  const reject = await openCollapsible(panel, /^採用しない/);
  await reject.getByLabel('採用しない理由').fill('E2E: 既に節で対応しているため（架空）');
  await reject.getByRole('button', { name: '採用しない', exact: true }).click();
  await page.waitForURL(/flash=narrativeLinksRejected/);
  await expect(
    main(page).getByText(/^AI の候補を採用しませんでした。理由を書いた場合/),
  ).toBeVisible();
  await expect(
    main(page).getByRole('region', { name: 'AI の対応付けの候補' }).locator('[data-decided]'),
  ).toContainText('AI の候補を採用しませんでした。');
});

test('インパクト・リスク・機会の台帳: 列で意味を分け、定性情報で選んだ IRO が SSBJ の列に出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // 原稿に引用されていない定性情報を作り、関連する IRO を選ぶ（既存の原稿の再確認を起こさない）
  await page.goto(`${NARRATIVES}/new`);
  await page.locator('#nv-theme').selectOption('risk_opportunity');
  await page.locator('#nv-title').fill(NEW_NARRATIVE);
  await page
    .locator('#nv-body')
    .fill('炭素価格の引上げにより操業コストが増える可能性がある（E2E・架空）。');
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL(/\/enterprise\/narratives\/[0-9a-f-]+\?flash=narrativeCreated/);
  const iros = main(page).locator('section[aria-labelledby="nv-iros"]');
  await expect(
    iros.getByRole('heading', { name: /関連するインパクト・リスク・機会/ }),
  ).toBeVisible();
  await iros.getByRole('checkbox').first().check();
  await page.locator('#nv-reason').fill('関連する IRO を選んだ（E2E）');
  await page.getByRole('button', { name: '版として保存' }).click();
  await page.waitForURL(/flash=narrativeSaved/);
  await expect(iros.getByRole('checkbox', { checked: true })).toHaveCount(1);

  await page.goto(IMPACTS);
  await expect(
    page.getByRole('heading', { level: 1, name: 'インパクト・リスク・機会の台帳' }),
  ).toBeVisible();
  // 列の意味と位置付け（誠実さの注記）は閉じずに見える
  await expect(main(page).getByText(/SSBJ は企業への影響（財務的影響を含む）/)).toBeVisible();
  await expect(main(page).locator('[data-honesty="sample-master"]').first()).toBeVisible();
  await expect(
    main(page).getByText(/公開草案に基づく参考（重要性の判断ではありません）/),
  ).toBeVisible();
  const table = main(page).getByRole('table', { name: 'インパクト・リスク・機会の台帳' });
  await expect(
    table.getByRole('columnheader', { name: 'SSBJ: 企業への影響（財務的影響を含む）' }),
  ).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: 'CSRD: 人・環境へのインパクト（DMA の結果）' }),
  ).toBeVisible();
  await expect(table.getByRole('link', { name: NEW_NARRATIVE })).toBeVisible();
  // 主操作は「IRO を追加」（事項の画面の作成パネルへ）
  await expect(
    main(page).locator('[data-page-actions]').getByRole('link', { name: 'IRO を追加' }),
  ).toHaveAttribute('href', /\/enterprise\/disclosures\/csrd\/settings\/matters\/E1\?new=1/);
  await expectNoSeriousAxe(page);

  // 絞り込み: インパクトだけ（リスク・機会の行は 40a の列が「対象外」）
  await page.goto(`${IMPACTS}?type=impact`);
  await expect(
    main(page)
      .getByRole('table', { name: 'インパクト・リスク・機会の台帳' })
      .getByText('—（リスク・機会は対象外）'),
  ).toHaveCount(0);
});

test('CSRD の 6 画面の見出しの下に「EU 法人向け・通常 ESRS の架空サンプル」の注記', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/disclosures/csrd',
    '/enterprise/disclosures/csrd/settings',
    '/enterprise/disclosures/csrd/requirements',
    '/enterprise/disclosures/csrd/plans',
    '/enterprise/disclosures/csrd/collection',
    '/enterprise/disclosures/csrd/draft',
  ]) {
    await page.goto(path);
    await expect(main(page).locator('[data-csrd-scope-note]'), path).toContainText(CSRD_NOTE);
  }
});

test('SSBJ の対象年度×基準版・プロジェクト設定の公開草案（未収録）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj');
  await expect(main(page).locator('[data-ssbj-version-stamp]')).toContainText('対象年度×基準版');
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(main(page).getByRole('heading', { name: '対象年度×基準版' })).toBeVisible();

  await page.goto(`/enterprise/disclosure-projects/${IDS.projects.fy2026}?tab=settings`);
  await expect(main(page).locator('[data-draft-not-loaded]').first()).toContainText(
    '公開草案（未収録）',
  );
});

test('SSBJ 開示ドラフトの確定本文を、開示プロジェクトの原稿へ取り込む（確認ダイアログ）', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await expect(main(page).locator('[data-draft-import-note]')).toBeVisible();
  const card = main(page).locator('#draft-governance');
  const generate = card.getByRole('button', { name: '人工知能に草案を作らせる' });
  if (await generate.isVisible()) {
    await generate.click();
    await page.waitForURL(/generated=/, { timeout: 60_000 });
  }
  const body = main(page).locator('#draft-governance textarea[name="body"]');
  await body.fill('当社は、気候関連のリスク及び機会を取締役会が監督しています（E2E・架空）。');
  await main(page).locator('#draft-governance').getByRole('button', { name: '本文を保存' }).click();
  await page.waitForLoadState('networkidle');
  await main(page)
    .locator('#draft-governance')
    .getByRole('button', { name: 'この内容で確定' })
    .click();
  await page.waitForLoadState('networkidle');

  const menu = await openMoreMenu(main(page));
  await menu
    .getByRole('menuitem', { name: /^開示プロジェクトの原稿へ取り込む（ガバナンス/ })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-confirm-scope]')).toContainText('版 1（下書き）');
  await confirmInDialog(page);
  await page.waitForURL(/\/blocks\/[0-9a-f-]+\?flash=draftImported/);
  await expect(
    main(page).getByText(/ドラフトの確定本文を原稿の節の新しい版（下書き）として取り込みました/),
  ).toBeVisible();
});

test('AI の対応付けの候補: 選んだ候補だけを採用して直接の対応付けにする（人の操作）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(GOVERNANCE);
  const ai = main(page).getByRole('region', { name: 'AI の対応付けの候補' });
  await ai.getByRole('button', { name: 'AI に候補を出させる' }).click();
  await page.waitForURL(/mappingRun=/);
  const panel = main(page).getByRole('region', { name: 'AI の対応付けの候補' });
  await expect(panel.locator('[data-honesty="ai-candidate"]')).toBeVisible();
  await panel.getByRole('button', { name: '選んだ候補を採用して対応付ける' }).click();
  await page.waitForURL(/flash=narrativeLinksAdopted/);
  await expect(
    main(page).getByRole('region', { name: 'AI の対応付けの候補' }).locator('[data-decided]'),
  ).toBeVisible();
});
