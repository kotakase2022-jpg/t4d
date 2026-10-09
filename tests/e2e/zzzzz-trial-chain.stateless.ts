import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import {
  DEMO_USERS,
  carriesDemoState,
  carryDemoState,
  confirmInDialog,
  gotoEngagementPage,
  loginAs,
  openCollapsible,
  openMoreMenu,
  openRowActions,
  peakCarriedCookieHeader,
  resetCarriedDemoState,
  resetDisclosureDemo,
  setDisclosureFirst,
  switchDemoRole,
} from './helpers';

/**
 * トライアル対応の「試行の流れ」（plan §4.3-6・K8）を、すべてのリクエストが別インスタンスに届く構成
 * （playwright.stateless.config.ts。リクエストごとに Fixture を作り直す）の画面で通す。状態は Cookie だけ。
 * Service の層の同じ流れは tests/integration/stateless-trial-chain.test.ts（Cookie の大きさ 9,000B 以下）。
 *
 *   開示デモのリセット → 40a の判断（S02）と対象外の申請・承認（S07）→ 節の対応付け → 対応表 XLSX →
 *   FY2025 の承認済みレポートを案件へ共有 → 保証側が段落にコメント → 企業が回答 → Data Room に開示レポート →
 *   DOCX 出力で突合 0 件 → 追跡率 → XBRL プレビュー（書き込みなし）→ ご意見・シナリオの実施・判定・作業時間 →
 *   3 段階の承認ルートの保存
 *
 * 押し出し（容量不足で古い操作を捨てること）は各テストの後に 0 であることを確かめる（carryDemoState）。
 * ファイル名を *.spec.ts にしないのは、通常の E2E（1 つのサーバーがメモリを持ち続ける）では同じ内容を
 * trial-*.spec.ts が確かめているため（この構成でだけ意味がある）。
 */

test.describe.configure({ mode: 'serial' });

const FY2026 = `/enterprise/disclosure-projects/${IDS.projects.fy2026}`;
const FY2025 = `/enterprise/disclosure-projects/${IDS.projects.fy2025}`;
const PF_40A = IDS.projectFrameworks.fy2026Esrs40a;
const detailPath = (code: string) => `${FY2026}/requirements/${esrs40aSampleItemId(code)}`;
const BLOCK_40A = `${FY2026}/blocks/${IDS.blocks.fy2026Esrs40aGovernance.block}`;

const S02_REASON = '試行の流れ: 全社共通の取組のため適用と判断（架空）。';
const S07_REASON = '試行の流れ: 該当する事業を持たないため対象外と判断（架空）。';
const NOTE_BODY = '試行の流れ（保証側）: この段落の根拠の版を確認させてください。';
const RESPONSE_BODY = '試行の流れ（企業）: 取締役会の議事録（版 2）が根拠です。';
const FEEDBACK_TITLE = '（試行の流れ）対応表の列を選びたい';
const ROUTE_NAME = '3 段階の承認（試行の流れ）';

const main = (page: Page) => page.locator('#t4d-main');

test.beforeAll(() => {
  // 前の spec（実演の流れ・CSRD の流れ・作成の確認）の Cookie を持ち込まない。初期状態の Fixture から始める
  resetCarriedDemoState();
});

test.afterEach(async ({ context }, testInfo) => {
  await carryDemoState(context, testInfo.title);
});

test.afterAll(() => {
  if (carriesDemoState()) {
    const peak = peakCarriedCookieHeader();
    console.log(
      `[stateless] 試行の流れの最大: Cookie ヘッダー ${peak.bytes}B（操作の記録 ${peak.editsBytes}B）— ${peak.label}`,
    );
    // plan K8: 試行の流れ単独で操作の記録は 9,000B 以下
    expect(peak.editsBytes).toBeLessThanOrEqual(9_000);
  }
});

test('開始: 開示デモを初期状態に戻す（試行の流れは初期状態から始める）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  await page.goto('/enterprise/dashboard');
  await resetDisclosureDemo(page);
  await setDisclosureFirst(page, false);
});

test('40a の判断: S02 を適用と判断し 3 観点を評価する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${detailPath('40A-S02')}?new=1`);
  const form = main(page).getByRole('form', { name: '判断を記録' });
  await form.getByLabel('適用区分').selectOption('applicable');
  await form.getByLabel(/^理由（対象外・非重要を選んだときは必須）/).fill(S02_REASON);
  await openCollapsible(form, '3 観点の評価');
  await form.getByLabel('開示').selectOption('partial');
  await form.getByLabel('データ').selectOption('mostly_covered');
  await form.getByLabel('業務プロセス').selectOption('partial');
  await form.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=requirementAssessed/);
  // 次の画面（別のサーバー）でも判断が残っている
  await page.goto(`${FY2026}?tab=requirements&fw=${PF_40A}`);
  const row = main(page)
    .getByRole('table', { name: /^要求事項（/ })
    .locator('tbody tr', { hasText: '40A-S02' })
    .first();
  await expect(row).toContainText('適用');
  await expect(row).not.toContainText('未判定');
});

test('対象外: 作成担当が S07 を申請し、最終承認者が承認すると「対象外」になる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${detailPath('40A-S07')}?new=1`);
  const form = main(page).getByRole('form', { name: '判断を記録' });
  await form.getByLabel('適用区分').selectOption('not_applicable');
  await form.getByLabel(/^理由（対象外・非重要を選んだときは必須）/).fill(S07_REASON);
  await form.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=requirementAssessedExclusion/);
  await main(page).getByRole('button', { name: '対象外として申請' }).click();
  await page.waitForURL(/flash=exclusionRequested/);

  await switchDemoRole(page, DEMO_USERS.approver);
  await page.goto(detailPath('40A-S07'));
  await main(page).getByRole('button', { name: '対象外を承認' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=exclusionApproved/);
  const status = main(page).locator('[aria-label="要求事項の状況"]');
  await expect(status).toContainText('対象外');
  await expect(status).toContainText('承認済み');
});

test('節の対応付け: 原稿エディタの右ペインで 40a の節に S02 を足す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BLOCK_40A}?pane=requirements`);
  const mapping = page.locator('[data-requirement-mapping]');
  await expect(mapping).toBeVisible();
  const form = await openCollapsible(mapping, '要求事項を追加・外す…');
  await form.getByLabel('要求事項を検索').fill('40A-S02');
  await form.getByRole('checkbox', { name: /40A-S02/ }).check();
  await form.getByRole('button', { name: '対応付けを保存' }).click();
  await page.waitForURL(/flash=/);
  await expect(page.locator('[data-requirement-mapping]')).toContainText('40A-S02 の詳細');
  // 要求事項タブ（別のサーバー）でも S02 の行に節が出る
  await page.goto(`${FY2026}?tab=requirements&fw=${PF_40A}`);
  await expect(
    main(page)
      .getByRole('table', { name: /^要求事項（/ })
      .locator('tbody tr', { hasText: '40A-S02' })
      .first(),
  ).not.toContainText('原稿なし');
});

test('対応表 XLSX: 全基準・全件で、S07 の対象外の理由と承認者が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${FY2026}?tab=requirements&fw=${PF_40A}`);
  const menu = await openMoreMenu(main(page), '対応表を出力');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: /XLSX・全基準/ }).click(),
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await download.path());
  const exclusions: string[] = [];
  workbook
    .getWorksheet('対象外一覧')!
    .eachRow((row) => exclusions.push(JSON.stringify(row.values)));
  expect(exclusions.some((line) => line.includes('40A-S07') && line.includes('承 花子'))).toBe(
    true,
  );
});

test('共有: FY2025 の社内承認済みレポートを案件へ共有する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${FY2025}?tab=outputs`);
  const row = page.locator('tr', { hasText: '社内承認済み版' }).first();
  await row.getByRole('button', { name: '社内承認済み版 No.1 の操作' }).click();
  await page.getByRole('menuitem', { name: '保証側へ共有（ENG-2026-001）…' }).click();
  await confirmInDialog(page);
  await expect(main(page)).toContainText('共有中');
});

test('保証側: 開示レポートの段落にコメントし、クライアントへ共有する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await gotoEngagementPage(page, 'reports');
  await page
    .getByRole('table', { name: '共有された開示レポート' })
    .getByRole('link', { name: /^No\.1 / })
    .first()
    .click();
  await page.waitForURL(/\/reports\/[^/?]+/);
  await page
    .locator('li a[data-trace-id]')
    .filter({ hasNotText: /-N\d+$/ })
    .first()
    .click();
  await expect(page.locator('#trace-detail [data-trace-detail]')).toBeVisible();
  await page.locator('[data-page-actions]').getByRole('link', { name: 'コメントを追加' }).click();
  const panel = page.locator('#create-report-note');
  await panel.getByRole('textbox', { name: /^コメント/ }).fill(NOTE_BODY);
  await panel.getByLabel(/クライアントへ共有する/).check();
  await panel.getByRole('button', { name: '追加' }).click();
  await expect(page.getByText('コメントを追加しました')).toBeVisible();
  await expect(page.locator('[data-report-note]', { hasText: NOTE_BODY })).toContainText('未回答');
});

test('企業: 保証側のコメントへ回答する（ホームの Attention から）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/assurance-comments?state=unanswered');
  const row = page.locator('tr', { hasText: NOTE_BODY.slice(0, 20) }).first();
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: '回答する' }).click();
  const panel = page.locator('#respond-note');
  await expect(panel).toContainText(NOTE_BODY);
  await panel.getByRole('textbox', { name: /^回答/ }).fill(RESPONSE_BODY);
  await panel.getByRole('button', { name: '回答を送る' }).click();
  await expect(page.getByText('回答を送りました')).toBeVisible();
  await expect(page.locator('tr', { hasText: NOTE_BODY.slice(0, 20) }).first()).toContainText(
    '回答済み',
  );
});

test('保証側: Data Room の取得元に「開示レポート」が並び、レビュー Note に企業の回答が見える', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await gotoEngagementPage(page, 'data-room');
  await expect(page.locator('tr', { hasText: /開示レポート No\.1 / }).first()).toBeVisible();
  await gotoEngagementPage(page, 'review-notes');
  const item = page.locator('li[data-t4d-record]', { hasText: NOTE_BODY }).first();
  await expect(item.getByRole('list', { name: 'クライアントの回答' })).toContainText(RESPONSE_BODY);
});

test('出力: DOCX を出力すると承認版と突合され、出力の記録に「不一致 0 件」が残る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${FY2025}?tab=outputs`);
  const href = await page
    .getByRole('row')
    .filter({ has: page.getByText('社内承認済み版', { exact: true }) })
    .first()
    .locator('a[href*="format=docx"][href*="audience=internal"]')
    .first()
    .getAttribute('href');
  const status = await page.evaluate(async (url) => (await fetch(url)).status, href!);
  expect(status).toBe(200);
  // 出力の記録（別のサーバー）にも突合の結果が残る
  await page.reload();
  await expect(
    page.getByRole('table', { name: '出力の記録' }).getByText('不一致 0 件').first(),
  ).toBeVisible();
});

test('追跡率と XBRL プレビュー（書き込みなし。提出用ではない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${FY2025}/snapshots/${FY2025_APPROVED_SNAPSHOT_ID}`);
  await expect(page.getByTestId('trace-rate')).toContainText(/追跡率 \d+ \/ \d+/);
  await page.goto(
    `/api/exports/xbrl/${FY2025_APPROVED_SNAPSHOT_ID}?format=ixbrl_html&audience=internal`,
  );
  await expect(page.locator('[data-t4d-not-filing-ready]')).toContainText('提出用ではありません');
});

test('トライアルの評価: ヘッダーのご意見・シナリオの実施・判定・作業時間', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.locator('header [data-feedback-trigger]').click();
  const dialog = page.getByRole('dialog', { name: 'ご意見・不具合を送る' });
  await dialog.locator('select[name="kind"]').selectOption('request');
  await dialog.locator('input[name="title"]').fill(FEEDBACK_TITLE);
  await dialog.getByRole('button', { name: '送る' }).click();
  await expect(dialog.getByRole('status')).toContainText('改善管理表に登録しました');
  await dialog.getByRole('button', { name: '完了' }).click();

  await page.goto('/enterprise/trial?tab=scenarios');
  const table = main(page).getByRole('table', { name: '検証シナリオ' });
  await table
    .getByRole('row')
    .filter({ hasText: 'TS-01' })
    .getByRole('link', { name: '実施を記録' })
    .click();
  const panel = page.locator('#trial-run-panel');
  await panel.locator('#trial-run-completion').selectOption({ label: '自力で完了' });
  await panel.locator('#trial-run-minutes').fill('15');
  await panel.getByRole('button', { name: '実施を記録' }).click();
  await page.waitForURL(/flash=trialRunRecorded/);

  await page.goto('/enterprise/trial?tab=timing&new=1');
  const timing = page.locator('#trial-timing-panel');
  await timing.locator('select[name="taskKey"]').selectOption('check_reconcile');
  await timing.locator('select[name="mode"]').selectOption('t4d');
  await timing.locator('input[name="minutes"]').fill('30');
  await timing.getByRole('button', { name: '作業時間を記録' }).click();
  await page.waitForURL(/flash=trialTimingRecorded/);

  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/trial?tab=scenarios');
  const menu = await openRowActions(
    main(page),
    'TS-01 出力した原稿の本文・数値から要求事項・根拠・承認版へ遡る',
  );
  await menu.getByRole('menuitem', { name: '判定を記録…' }).click();
  await page.getByRole('dialog').locator('select[name="judgement"]').selectOption('pass');
  await confirmInDialog(page, { reason: '（試行の流れ）選定ケースの追跡を確認した。' });
  await page.waitForURL(/flash=trialJudged/);

  // 改善管理表（別のサーバー）に、ヘッダーから送ったご意見が出る
  await page.goto('/enterprise/trial?tab=feedback');
  await expect(
    main(page).getByRole('table', { name: '改善管理表' }).getByRole('row').filter({
      hasText: FEEDBACK_TITLE,
    }),
  ).toBeVisible();
});

test('承認ルート: 3 段階のひな形を入れて保存する（既定は変えない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=approval');
  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: '3 段階のひな形を入れる' })
    .click();
  const editor = page.locator('#approval-route-editor');
  await editor.getByLabel('名称').fill(ROUTE_NAME);
  await editor.getByRole('checkbox', { name: /既定の経路にする/ }).uncheck();
  await editor.getByRole('button', { name: '保存…' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=approvalRouteSaved/);
  // 一覧（別のサーバー）に 3 段階で出る
  await page.reload();
  const row = page.locator('tr', { hasText: ROUTE_NAME });
  await expect(row).toContainText('1. 拠点・部署の確認');
  await expect(row).toContainText('3. 最終承認');
});
