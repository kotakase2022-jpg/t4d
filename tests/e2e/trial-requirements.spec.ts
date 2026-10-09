import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import {
  DEMO_USERS,
  apiStatusAsViewer,
  carryDemoState,
  confirmInDialog,
  loginAs,
  openCollapsible,
  openMoreMenu,
  resetCarriedDemoState,
  resetDisclosureDemo,
  setDisclosureFirst,
  switchDemoRole,
} from './helpers';

/**
 * トライアル対応 T1（要求事項・判断・対応表）の画面の流れ（e2e:trial-requirements）。
 *
 *   開示デモを初期状態に戻す → 要求事項タブ（ESRS-40a サンプル）の区分・出所・サンプル表示 →
 *   40A-S02 の判断を記録（区分が「未判定」から変わる）→ 40A-S07 を対象外と記録して申請 →
 *   最終承認者が承認（申請者は承認できない）→ 要求事項タブの行から 40A-S06 の申請を承認 →
 *   節の追加で要求事項を選ぶ → 要求事項タブの行に節が出る → 要求事項・情報対応表（XLSX）→
 *   横断対応表（サンプル 6 件・絞り込み）→ 概要の「転記・再利用の点検」→ 開示デモを初期状態に戻す
 *
 * 前の手順が作った状態を次の手順が使う（serial）。架空のサンプル（条文ではない）の要求事項だけを使う。
 * 試行の流れは開示デモのリセットの後に始める（plan K8）。途中で失敗しても afterAll で初期状態へ戻す。
 */

test.describe.configure({ mode: 'serial' });

const PROJECT_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2026}`;
const PF_40A = IDS.projectFrameworks.fy2026Esrs40a;
const TAB_40A = `${PROJECT_PATH}?tab=requirements&fw=${PF_40A}`;
const detailPath = (code: string) => `${PROJECT_PATH}/requirements/${esrs40aSampleItemId(code)}`;

const S02_REASON = 'E2E: 手順は全社共通のため適用と判断（架空）。';
const S07_REASON = 'E2E: 自社の従業員の労働条件は別の開示で扱うため対象外と判断（架空）。';
const BLOCK_TITLE = 'E2E 気候変動の緩和（サンプル）';
const S03_REASON = 'E2E: 該当する取引が少額のため非重要と判断（架空）。';
const RETURN_NOTE = 'E2E: 少額の根拠（金額）を理由に書いてください（架空）。';
const BLOCK_40A = `${PROJECT_PATH}/blocks/${IDS.blocks.fy2026Esrs40aGovernance.block}`;

let restored = false;

const main = (page: Page) => page.locator('#t4d-main');
const flash = (page: Page) => page.getByRole('status');
const requirementsTable = (page: Page) => main(page).getByRole('table', { name: /^要求事項（/ });
const requirementRow = (page: Page, code: string) =>
  requirementsTable(page).locator('tbody tr', { hasText: code }).first();

/** 開示優先モードを一時的に有効にして開示デモをリセットし、無効へ戻す（管理者） */
async function restoreDemo(page: Page): Promise<void> {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  try {
    await page.goto('/enterprise/dashboard');
    await resetDisclosureDemo(page);
  } finally {
    await setDisclosureFirst(page, false);
  }
}

test.beforeAll(() => {
  // 前の spec の Cookie を引き継がず、初期状態の Fixture から始める
  resetCarriedDemoState();
});

// 状態がリクエストごとに消えるサーバーの E2E では、前の手順の結果を Cookie だけで次の手順へ渡す
test.afterEach(async ({ context }, testInfo) => {
  await carryDemoState(context, testInfo.title);
});

test.afterAll(async ({ browser }) => {
  if (restored) return;
  const page = await browser.newPage();
  try {
    await restoreDemo(page);
  } finally {
    await page.close();
  }
});

test('開始: 開示デモを初期状態に戻す（試行の流れは初期状態から始める）', async ({ page }) => {
  await restoreDemo(page);
});

test('要求事項タブ: 40a サンプルの行に区分・判断の出所・サンプル表示があり、区分で絞り込める', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(TAB_40A);
  const table = requirementsTable(page);
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '区分' })).toBeVisible();

  const s01 = requirementRow(page, '40A-S01');
  await expect(s01).toContainText('サンプル（架空）');
  await expect(s01).toContainText('出所: 判断の記録');
  // サンプルの基準は充足確認済みにしない（上限は追加確認が必要。K6）
  await expect(s01).not.toContainText('充足確認済み');

  // 40A-S06 は対象外の承認待ち: 分母から外さず「未判定」
  const s06 = requirementRow(page, '40A-S06');
  await expect(s06).toContainText('申請中');
  await expect(s06).toContainText('未判定');

  const coverage = main(page).getByRole('navigation', { name: '区分の絞り込み' });
  await coverage.getByRole('link', { name: /^未判定/ }).click();
  await page.waitForURL(/coverage=undetermined/);
  await expect(requirementRow(page, '40A-S06')).toBeVisible();
  await expect(requirementsTable(page).locator('tbody tr', { hasText: '40A-S01' })).toHaveCount(0);
});

test('判断を記録: 40A-S02 を適用と判断し 3 観点を評価すると、判断の記録として行に出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(TAB_40A);
  await expect(requirementRow(page, '40A-S02')).toContainText('未判定');
  await requirementRow(page, '40A-S02').getByRole('link', { name: '判断を記録' }).click();
  await page.waitForURL(/\/requirements\/[^/?]+\?new=1/);

  const form = main(page).getByRole('form', { name: '判断を記録' });
  await form.getByLabel('適用区分').selectOption('applicable');
  await form.getByLabel(/^理由（対象外・非重要を選んだときは必須）/).fill(S02_REASON);
  await openCollapsible(form, '3 観点の評価');
  await form.getByLabel('開示').selectOption('partial');
  await form.getByLabel('データ').selectOption('mostly_covered');
  await form.getByLabel('業務プロセス').selectOption('partial');
  await form.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=requirementAssessed/);
  await expect(flash(page)).toContainText('要求事項の判断を記録しました');

  const status = main(page).locator('[aria-label="要求事項の状況"]');
  await expect(status).toContainText('適用');
  // 原稿の節が無いので「未対応」（不足: 原稿なし）
  await expect(status).toContainText('未対応');
  await openCollapsible(main(page), /判断の履歴/);
  await expect(main(page).getByText(S02_REASON).first()).toBeVisible();

  await page.goto(TAB_40A);
  await expect(requirementRow(page, '40A-S02')).toContainText('適用');
  await expect(requirementRow(page, '40A-S02')).not.toContainText('未判定');
});

test('対象外の申請と承認: 作成担当が申請し、最終承認者が承認すると「対象外」になる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${detailPath('40A-S07')}?new=1`);
  const form = main(page).getByRole('form', { name: '判断を記録' });
  await form.getByLabel('適用区分').selectOption('not_applicable');
  await form.getByLabel(/^理由（対象外・非重要を選んだときは必須）/).fill(S07_REASON);
  await form.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=requirementAssessedExclusion/);

  // 申請（作成担当）。申請者には承認の操作を出さない
  await main(page).getByRole('button', { name: '対象外として申請' }).click();
  await page.waitForURL(/flash=exclusionRequested/);
  await expect(flash(page)).toContainText('別の人（承認者）が承認するまでは「未判定」');
  await expect(main(page).getByRole('button', { name: '対象外を承認' })).toHaveCount(0);

  // 最終承認者が承認する（取り消せない操作は確認ダイアログを通る）
  await switchDemoRole(page, DEMO_USERS.approver);
  await page.goto(detailPath('40A-S07'));
  await main(page).getByRole('button', { name: '対象外を承認' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-confirm-scope]')).toContainText('40A-S07');
  await expect(dialog).toContainText('取り消せません');
  await confirmInDialog(page);
  await page.waitForURL(/flash=exclusionApproved/);
  const status = main(page).locator('[aria-label="要求事項の状況"]');
  await expect(status).toContainText('対象外');
  await expect(status).toContainText('承認済み');
});

test('要求事項タブの行から、承認待ちの対象外（40A-S06）を承認できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(TAB_40A);
  const row = requirementRow(page, '40A-S06');
  await row.getByRole('button', { name: '対象外を承認' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=exclusionApproved/);
  await expect(requirementRow(page, '40A-S06')).toContainText('対象外');
  await expect(requirementRow(page, '40A-S06')).toContainText('承認済み');
});

test('節の追加で要求事項を選ぶと、要求事項タブの行に節が出る（NF-05）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PROJECT_PATH}?tab=manuscripts&new=1`);
  const panel = main(page);
  await panel.getByLabel('基準の版').selectOption(IDS.esrs40aVersion);
  await panel.getByLabel('題名').fill(BLOCK_TITLE);
  await panel.getByLabel(/^節のキー/).fill('e2e_esrs40a_climate');
  await panel.getByRole('button', { name: '要求事項を選ぶ' }).click();
  const picker = panel.locator('[data-requirement-picker]');
  await expect(picker).toBeVisible();
  await picker.getByLabel('要求事項を検索').fill('40A-S04');
  await picker.getByRole('checkbox', { name: /40A-S04/ }).check();
  await panel.getByRole('button', { name: '節を追加' }).click();
  await page.waitForURL(/\/blocks\/[^/?]+\?flash=blockCreated/);

  await page.goto(TAB_40A);
  await expect(requirementRow(page, '40A-S04')).toContainText(BLOCK_TITLE);
});

test('差戻しと取り下げ: 承認者が理由付きで差し戻し、作成担当が申請し直してから取り下げる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${detailPath('40A-S03')}?new=1`);
  const form = main(page).getByRole('form', { name: '判断を記録' });
  await form.getByLabel('適用区分').selectOption('not_material');
  await form.getByLabel(/^理由（対象外・非重要を選んだときは必須）/).fill(S03_REASON);
  await form.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=requirementAssessedExclusion/);
  await main(page).getByRole('button', { name: '対象外として申請' }).click();
  await page.waitForURL(/flash=exclusionRequested/);

  // 差戻し（理由必須。確認ダイアログ）
  await switchDemoRole(page, DEMO_USERS.approver);
  await page.goto(detailPath('40A-S03'));
  await main(page).getByRole('button', { name: '差し戻す…' }).click();
  await confirmInDialog(page, { reason: RETURN_NOTE });
  await page.waitForURL(/flash=exclusionReturned/);
  const status = main(page).locator('[aria-label="要求事項の状況"]');
  await expect(status).toContainText('差戻し');
  await expect(status).toContainText('未判定');

  // 作成担当が申請し直し、取り下げる（取り下げは「その他」）
  await switchDemoRole(page, DEMO_USERS.sustainability);
  await page.goto(detailPath('40A-S03'));
  await main(page).getByRole('button', { name: '対象外として申請' }).click();
  await page.waitForURL(/flash=exclusionRequested/);
  const menu = await openMoreMenu(main(page));
  await menu.getByRole('menuitem', { name: '対象外の申請を取り下げる' }).click();
  await page.waitForURL(/flash=exclusionWithdrawn/);
  await expect(main(page).getByRole('button', { name: '対象外として申請' })).toBeVisible();
});

test('原稿エディタ: 要求事項を追加・外す（理由）と、AI の対応の候補を採用・採用しない', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BLOCK_40A}?pane=requirements`);
  const mapping = page.locator('[data-requirement-mapping]');
  await expect(mapping).toBeVisible();
  const form = await openCollapsible(mapping, '要求事項を追加・外す…');
  await form.getByLabel('要求事項を検索').fill('40A-S05');
  await form.getByRole('checkbox', { name: /40A-S05/ }).check();
  await form.getByRole('button', { name: '対応付けを保存' }).click();
  await page.waitForURL(/flash=blockRequirementsSaved/);
  await expect(page.locator('[data-requirement-mapping]')).toContainText('40A-S05 の詳細');

  // AI の候補（Mock）: 候補として見せ、選んだものだけを対応付ける
  await page
    .locator('[data-requirement-mapping]')
    .getByRole('button', { name: 'AI に対応の候補を出させる' })
    .click();
  await page.waitForURL(/flash=mappingCandidatesReady/);
  const adopt = page.locator('[data-requirement-mapping]');
  await expect(adopt.locator('[data-honesty="ai-candidate"]').first()).toBeVisible();
  await adopt.getByRole('button', { name: '選んだ候補を対応付ける' }).click();
  await page.waitForURL(/flash=mappingCandidatesAdopted/);

  // もう一度候補を出し、今度は採用しない（理由は任意。AI に関する意見として残る）
  await page
    .locator('[data-requirement-mapping]')
    .getByRole('button', { name: 'AI に対応の候補を出させる' })
    .click();
  await page.waitForURL(/flash=mappingCandidatesReady/);
  const reject = await openCollapsible(
    page.locator('[data-requirement-mapping]'),
    '候補を採用しない…',
  );
  await reject.getByLabel(/採用しない理由/).fill('E2E: 既に対応付けているため（架空）');
  await reject.getByRole('button', { name: '候補を採用しない', exact: true }).click();
  await page.waitForURL(/flash=mappingCandidatesRejected/);
});

test('横断対応表: AI に対応候補を出させる（表示だけ）と、採用しない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PROJECT_PATH}?tab=crosswalk&ai=1`);
  const panel = page.locator('#crosswalk-ai');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '候補を出させる' }).click();
  await page.waitForURL(/flash=crosswalkCandidatesReady/);
  const suggestion = main(page).getByRole('region', {
    name: /の対応候補（Suslab の確認待ちの候補・表示のみ）/,
  });
  await expect(suggestion).toBeVisible();
  // 候補は横断対応表に書かない（件数は変わらない）
  await expect(main(page).getByRole('table', { name: '横断対応表（6 件）' })).toBeVisible();
  const reject = await openCollapsible(suggestion, '候補を採用しない…');
  await reject.getByRole('button', { name: '候補を採用しない', exact: true }).click();
  await page.waitForURL(/flash=crosswalkCandidatesRejected/);
});

test('要求事項・情報対応表（XLSX）: 全基準・全件と、対象外の理由・承認者が出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(TAB_40A);
  const menu = await openMoreMenu(main(page), '対応表を出力');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: /XLSX・全基準/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/要求事項・情報対応表.*\.xlsx$/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await download.path());
  expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
    '対応表',
    '対象外一覧',
    '未対応一覧',
    '基準別件数',
    '基準横断',
    '注記',
  ]);
  const exclusions: string[] = [];
  workbook
    .getWorksheet('対象外一覧')!
    .eachRow((row) => exclusions.push(JSON.stringify(row.values)));
  expect(exclusions.some((line) => line.includes('40A-S07') && line.includes('承 花子'))).toBe(
    true,
  );

  // 画面の「すべての基準」も同じ全件の表（分母付き）
  await main(page)
    .getByRole('link', { name: /^すべての基準/ })
    .click();
  await page.waitForURL(/fw=all/);
  await expect(
    main(page).getByRole('table', { name: /^要求事項・情報対応表（全基準 \d+ 件/ }),
  ).toBeVisible();
  await expect(main(page).getByRole('list', { name: '基準別の件数' })).toContainText('分母 8 件');

  // 出力の権限が無い役割は API も 403
  await loginAs(page, DEMO_USERS.reviewer);
  expect(
    await apiStatusAsViewer(
      page,
      `/api/exports/requirement-matrix?project=${IDS.projects.fy2026}&format=csv`,
    ),
  ).toBe(403);
});

test('横断対応表: サンプル 6 件・サンプルの表示・関係で絞り込める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PROJECT_PATH}?tab=crosswalk`);
  await expect(main(page).getByRole('table', { name: '横断対応表（6 件）' })).toBeVisible();
  await expect(main(page).getByText(/対応はトライアル用の架空の整理です/)).toBeVisible();
  await main(page)
    .getByRole('navigation', { name: '関係の絞り込み' })
    .getByRole('link', { name: /^一部/ })
    .click();
  await page.waitForURL(/relation=partial/);
  await expect(main(page).getByRole('table', { name: '横断対応表（2 件）' })).toBeVisible();
});

test('概要: 転記・再利用の点検（既定で閉じる）に分母付きの件数が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PROJECT_PATH);
  const region = main(page).getByRole('region', { name: '転記・再利用の点検' });
  const section = await openCollapsible(region, /手書き数値/);
  await expect(section).toContainText('参照でない手書き数値（転記）');
  await expect(section).toContainText(/本文の数値 \d+ 件中/);
});

test('終了: 開示デモを初期状態に戻す', async ({ page }) => {
  await restoreDemo(page);
  restored = true;
});
