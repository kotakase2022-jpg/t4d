import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { countVisibleEmphasis } from '@tests/support/route-samples';
import { DEMO_USERS, confirmInDialog, gotoEngagementPage, loginAs } from './helpers';

/**
 * 保証連携（トライアル対応 NF-20〜NF-23・NF-26 の画面。e2e:trial-assurance）。
 *
 * 企業が FY2025 の社内承認済みレポートを案件へ共有 → 保証側が「開示レポート」で本文・数値・承認版を見る →
 * 段落にコメント（クライアントへ共有）→ Data Room の取得元に「開示レポート」→ 企業が「保証側のコメント」で回答 →
 * 保証側のレビュー Note に回答が見える、を 1 つの流れで通す。
 *
 * 共有の操作は出力タブのスナップショット行の「操作 ▾ > 保証側へ共有（{案件コード}）…」（plan NF-20）。
 * 共有した写しは開示デモのリセットで戻る（disclosure-demo-reset）。
 */

test.describe.configure({ mode: 'serial' });

const FY2025_PROJECT_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2025}`;
/** FY2025 の承認済みスナップショット（架空）の本文の一部と数値 */
const PARAGRAPH_FRAGMENT = '当社は、気候変動をはじめとする';
const METRIC_DISPLAY = '1,240.5 t-CO2e';
const NOTE_BODY = 'E2E 保証側: この段落の根拠となる取締役会議事録の版を確認させてください。';
const RESPONSE_BODY = 'E2E 企業側: 2025年度第2回取締役会の議事録（版2）が根拠です。';

async function openSharedReport(page: Page): Promise<string> {
  const engagementId = await gotoEngagementPage(page, 'reports');
  await expect(page.getByRole('heading', { level: 1, name: '開示レポート' })).toBeVisible();
  await page
    .getByRole('table', { name: '共有された開示レポート' })
    .getByRole('link', { name: /^No\.1 / })
    .first()
    .click();
  await page.waitForURL(/\/reports\/[^/?]+/);
  await expect(page.getByRole('heading', { level: 1, name: '開示レポートの内容' })).toBeVisible();
  return engagementId;
}

test('企業が社内承認済みレポートを案件へ共有する（出力タブの行の操作）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${FY2025_PROJECT_PATH}?tab=outputs`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const row = page.locator('tr', { hasText: '社内承認済み版' }).first();
  await expect(row, 'FY2025 の承認済みスナップショットの行が無い').toBeVisible();
  // 行の「操作 ▾」（RowActions。読み上げ名「社内承認済み版 No.1 の操作」）から、許諾のある案件ごとの項目で共有する
  // （案件の選択欄は無い。案件は項目の名前で決まる）
  await row.getByRole('button', { name: '社内承認済み版 No.1 の操作' }).click();
  await page.getByRole('menuitem', { name: '保証側へ共有（ENG-2026-001）…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('select[name="engagementId"]')).toHaveCount(0);
  await confirmInDialog(page);
  await expect(page.locator('#t4d-main')).toContainText('共有中');
});

test('保証側は開示レポートの本文・数値・承認版を閲覧のみで見られる（誠実さの注記・axe）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await openSharedReport(page);

  // 社内承認であり第三者保証ではない・ファイル作成は提出ではない（常に見える）
  const honesty = page.locator('[data-shared-report-honesty]').first();
  await expect(honesty).toBeVisible();
  await expect(honesty).toContainText('社内承認版');
  await expect(page.locator('#t4d-main')).toContainText('第三者保証ではありません');
  await expect(page.locator('#t4d-main')).toContainText('ファイル作成は提出ではありません');

  // 出力と同じ本文と数値
  await expect(page.getByText(PARAGRAPH_FRAGMENT).first()).toBeVisible();
  await expect(page.getByText(METRIC_DISPLAY).first()).toBeVisible();

  // 数値を選ぶと、数値の版・承認・根拠資料の件数が右に出る
  await page.locator('a[data-trace-id$="-N1"]').first().click();
  const detail = page.locator('#trace-detail');
  await expect(detail.locator('[data-trace-detail]')).toBeVisible();
  await expect(detail).toContainText('承認済み');
  await expect(detail).toContainText('要求事項');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);

  // One Screen, One Primary（共有した後にだけある画面なので、primary 監査の標本の代わりにここで数える）。
  // 見出しの主操作は「コメントを追加」の 1 つ。作成パネルを開くとパネルの「追加」が唯一の primary
  const closed = await countVisibleEmphasis(page);
  expect(closed.primary, closed.primaryLabels.join('・')).toBeLessThanOrEqual(1);
  expect(closed.danger).toBe(0);
  await page.locator('[data-page-actions]').getByRole('link', { name: 'コメントを追加' }).click();
  await expect(page.locator('#create-report-note')).toBeVisible();
  const open = await countVisibleEmphasis(page);
  expect(open.primaryLabels).toEqual(['追加']);
  expect(open.danger).toBe(0);
});

test('保証側が段落にコメントし、クライアントへ共有する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await openSharedReport(page);

  // 段落（追跡番号）を選んでから、見出しの主操作「コメントを追加」
  await page.locator(`li:has-text("${PARAGRAPH_FRAGMENT}") a[data-trace-id]`).first().click();
  await expect(page.locator('#trace-detail [data-trace-detail]')).toBeVisible();
  await page.locator('[data-page-actions]').getByRole('link', { name: 'コメントを追加' }).click();

  const panel = page.locator('#create-report-note');
  await expect(panel).toBeVisible();
  // 対象は選んだ段落が既定で入っている
  await expect(panel.locator('select[name="target"]')).toHaveValue(/^paragraph\|/);
  await panel.getByRole('textbox', { name: /^コメント/ }).fill(NOTE_BODY);
  await panel.getByLabel(/クライアントへ共有する/).check();
  await panel.getByRole('button', { name: '追加' }).click();

  await expect(page.getByText('コメントを追加しました')).toBeVisible();
  const note = page.locator('[data-report-note]', { hasText: NOTE_BODY });
  await expect(note).toBeVisible();
  await expect(note).toContainText('未回答');
});

test('Data Room の取得元に「開示レポート」が並ぶ（閲覧のみ）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await gotoEngagementPage(page, 'data-room');
  await expect(page.getByText('Read-only（企業原本）')).toBeVisible();
  const row = page.locator('tr', { hasText: /開示レポート No\.1 / }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('[data-source="report"]')).toHaveText('開示レポート');
});

test('企業がワークフローから保証側のコメントへ回答する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/workflows');
  const section = page.locator('#assurance-comments');
  await expect(section).toBeVisible();
  await expect(section).toContainText(NOTE_BODY.slice(0, 20));
  await section
    .getByRole('link', { name: /^段落「/ })
    .first()
    .click();

  await page.waitForURL(/\/enterprise\/assurance-comments\?/);
  const panel = page.locator('#respond-note');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(NOTE_BODY);
  // 送った回答は取り消せない（注記は回答欄の中に常に見える）
  await expect(panel).toContainText('取り消せません');
  await panel.getByRole('textbox', { name: /^回答/ }).fill(RESPONSE_BODY);
  await panel.getByRole('button', { name: '回答を送る' }).click();

  await expect(page.getByText('回答を送りました')).toBeVisible();
  const row = page.locator('tr', { hasText: NOTE_BODY.slice(0, 20) }).first();
  await expect(row).toContainText('回答済み');
});

test('保証側のレビュー Note に対象（段落・追跡番号）と企業の回答が見える', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await gotoEngagementPage(page, 'review-notes');
  const item = page.locator('li[data-t4d-record]', { hasText: NOTE_BODY }).first();
  await expect(item).toBeVisible();
  await expect(item.locator('[data-note-target]')).toContainText('開示レポート No.1');
  await expect(item.locator('[data-note-target]')).toContainText('段落');
  await expect(item.getByRole('list', { name: 'クライアントの回答' })).toContainText(RESPONSE_BODY);
  await expect(item).toContainText('回答済み');
});

test('企業が共有を取り下げると、保証側の開示レポートの一覧から消える', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${FY2025_PROJECT_PATH}?tab=outputs`);
  const row = page.locator('tr', { hasText: '社内承認済み版' }).first();
  await row.getByRole('button', { name: '社内承認済み版 No.1 の操作' }).click();
  await page.getByRole('menuitem', { name: '共有を取り下げる（ENG-2026-001）…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('保証側への共有を取り下げますか');
  await confirmInDialog(page);
  await expect(page.locator('#t4d-main')).toContainText('取り下げ済み');

  await loginAs(page, DEMO_USERS.assuranceManager);
  await gotoEngagementPage(page, 'reports');
  await expect(
    page
      .getByRole('table', { name: '共有された開示レポート' })
      .getByRole('link', { name: /^No\.1 / }),
  ).toHaveCount(0);
});
