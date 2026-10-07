import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import { DEMO_USERS, confirmInDialog, loginAs, openMoreMenu } from './helpers';

/**
 * UI 再設計で置き場所が変わった機能・新しく UI を付けた機能を、新しい置き場所から実行して確かめる
 * （docs/ui-redesign/regression.md の「Changed」と、plan §5.1-1 の NO_E2E_YET を埋める E2E）。
 *
 * 置き場所: 見出しの「その他」・行の「操作」・作成パネル（?new=1）・段階 UI（?step=）・確認ダイアログ・
 * 結果の通知の「元に戻す」。どれも「開いてから押す」ことで、L2 へ移した操作が実際に使えることを確かめる。
 *
 * デモの状態（共有のメモリ）を変えるため、全件の最後に流す（ファイル名の zzzz-）。
 * 作ったものは、消せるものは同じテストの中で消す（IRO・チームのメンバー・許諾の取消）。
 */

test.describe.configure({ mode: 'serial' });

const STAMP = Date.now().toString(36);

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

test('F048: SSBJ 要求事項の「その他」から前年度の評価を引き継ぎ、結果が通知に出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/requirements');
  const menu = await openMoreMenu(page);
  await menu.getByRole('menuitem', { name: /^前年度の評価を引き継ぐ/ }).click();
  // 区分 2 の確認（範囲 1 行と、上書きする内容の説明）を通す
  await expect(page.getByRole('dialog')).toContainText('今年度に担当者の確認（最終判定）');
  await confirmInDialog(page);
  await page.waitForURL(/flash=ssbjCarriedOver/);
  await expect(
    page.getByRole('status').filter({ hasText: /前年度の評価|引き継げる前年度の評価/ }),
  ).toBeVisible();
});

test('E03: SSBJ 要求事項の CSV は「その他」から書き出せる（絞り込みを反映）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/requirements?priority=high');
  const menu = await openMoreMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: /^CSV を書き出す/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
});

test('F044: SSBJ 対応計画の作成パネル（?new=1）からデータ収集項目を作成できる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/plans');
  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: 'データ収集項目を作成' })
    .click();
  await page.waitForURL(/[?&]new=1/);
  const form = page.locator('form', { has: page.locator('input[name="metricCode"]') });
  await expect(form).toBeVisible();
  // 提出期限は報告期間の提出期限が既定（plan D3）
  await expect(form.getByLabel('提出期限')).not.toHaveValue('');
  const name = `再設計検証の収集項目 ${STAMP}`;
  await form.getByLabel('データ項目コード').fill(`e2e_${STAMP}`);
  await form.getByLabel('データ項目名').fill(name);
  await form.getByRole('button', { name: 'データ収集項目を作成' }).click();
  await settle(page);
  await page.goto('/enterprise/disclosures/ssbj/collection?size=100');
  await expect(page.getByText(name).first()).toBeVisible();
});

test('F049・F050: CSRD 設定の段階（?step=）で報告範囲・評価方法を保存できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd/settings?step=boundary');
  await page.getByRole('button', { name: '報告範囲を保存' }).click();
  await page.waitForURL(/flash=csrdBoundarySaved/);
  await expect(page.getByRole('status').first()).toBeVisible();

  await page.goto('/enterprise/disclosures/csrd/settings?step=method');
  await page.getByRole('button', { name: '評価方法を保存' }).click();
  await page.waitForURL(/flash=csrdMethodSaved/);
  await expect(page.getByRole('status').first()).toBeVisible();
});

test('F052・F053: CSRD 事項の IRO を作成パネルで追加し、行の「操作」から確認して削除できる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/csrd/settings/matters/S1?new=1');
  const form = page.locator('form', { has: page.locator('input[name="description"]') }).first();
  await expect(form).toBeVisible();
  const description = `再設計検証のリスク ${STAMP}`;
  await form.locator('input[name="iroType"][value="risk"]').check();
  await form.locator('input[name="description"]').fill(description);
  const horizon = form.locator('select[name="timeHorizon"]');
  const firstHorizon = await horizon
    .locator('option')
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).find((value) => value !== ''),
    );
  await horizon.selectOption(firstHorizon ?? '');
  await form.locator('select[name="financialLikelihood"]').selectOption('3');
  await form.locator('select[name="financialMagnitude"]').selectOption('3');
  await form.getByRole('button', { name: 'IRO を追加' }).click();
  await page.waitForURL(/flash=csrdIroSaved/);

  const row = page.locator('tr', { hasText: description });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /の操作$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^削除/ }).click();
  // 取り消せない操作は範囲と結果（論理削除・DMA の確定の取消）を本文に出す
  await expect(page.getByRole('dialog')).toContainText('論理削除です');
  await confirmInDialog(page);
  await page.waitForURL(/flash=csrdIroDeleted/);
  await expect(page.locator('tr', { hasText: description })).toHaveCount(0);
});

test('F104: ESG経営の目標を作成パネル（?new=1）から登録できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/esg/targets');
  await page.locator('[data-page-actions]').getByRole('link', { name: '目標を登録' }).click();
  await page.waitForURL(/[?&]new=1/);
  const form = page.locator('form', { has: page.locator('select[name="metricId"]') });
  await expect(form).toBeVisible();
  const metric = form.locator('select[name="metricId"]');
  const firstMetric = await metric
    .locator('option')
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).find((value) => value !== ''),
    );
  await metric.selectOption(firstMetric ?? '');
  await form.locator('input[name="targetYear"]').fill('2035');
  await form.locator('input[name="targetValue"]').fill('100');
  await form.getByRole('button', { name: '目標を登録' }).click();
  await expect(page.getByRole('status').filter({ hasText: /を登録しました/ })).toBeVisible();
});

test('F087: 開示プロジェクトの原稿タブの作成パネルから節を追加できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosure-projects');
  const href = await page
    .locator('#t4d-main a[href^="/enterprise/disclosure-projects/"]')
    .evaluateAll((links) =>
      links
        .map((a) => a.getAttribute('href') ?? '')
        .find((h) => /^\/enterprise\/disclosure-projects\/[0-9a-f-]{36}$/.test(h)),
    );
  expect(href, 'プロジェクトの一覧に行が必要').toBeTruthy();
  await page.goto(`${href}?tab=manuscripts`);
  await page.locator('[data-page-actions]').getByRole('link', { name: '節を追加' }).click();
  await page.waitForURL(/[?&]new=1/);
  const title = `再設計検証の節 ${STAMP}`;
  await page.getByLabel('題名').fill(title);
  await page.getByLabel(/^節のキー/).fill(`e2e_${STAMP}`);
  await page
    .locator('form', { has: page.locator('input[name="sectionKey"]') })
    .getByRole('button', { name: '節を追加' })
    .click();
  await page.waitForURL(/\/blocks\/[0-9a-f-]+\?flash=blockCreated/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
});

test('F074: 回答のレビュー依頼と、理由必須の差戻し（理由はコメントに残る）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await page.getByRole('link', { name: 'C0.2' }).first().click();
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\/[0-9a-f-]+/);
  const url = page.url();
  await page.getByLabel('回答本文').fill(`再設計検証の回答 ${STAMP}`);
  await page.getByRole('button', { name: '保存（下書き）' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'レビュー依頼' }).click();
  await settle(page);

  await loginAs(page, DEMO_USERS.approver);
  await page.goto(url);
  const reason = `再設計検証の差戻し理由 ${STAMP}`;
  await page.getByRole('button', { name: '差戻し…' }).click();
  // 理由は必須（空では送られない）
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-confirm-submit]').click();
  await expect(dialog).toBeVisible();
  await confirmInDialog(page, { reason, reasonLabel: '差戻し理由' });
  await settle(page);
  await page.goto(url);
  await expect(page.getByText(`差戻し理由: ${reason}`)).toBeVisible();
});

test('F121: 案件の概要の「チームを変更」でメンバーを加え、外せる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  const overview = `/assurance/engagements/${ENGAGEMENT_IDS.main}/overview`;
  await page.goto(overview);
  await page.getByRole('link', { name: 'チームを変更' }).click();
  await page.waitForURL(/[?&]team=1/);
  const form = page.locator('form', { has: page.locator('select[name="userId"]') });
  await expect(form, 'チームに加えられる法人メンバーが必要').toBeVisible();
  const candidate = await form.locator('select[name="userId"] option').first().innerText();
  await form.getByRole('button', { name: 'チームに加える' }).click();
  await settle(page);

  await page.goto(`${overview}?team=1#engagement-info`);
  const memberRow = page.locator('li', { hasText: candidate }).filter({
    has: page.getByRole('button', { name: 'チームから外す' }),
  });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole('button', { name: 'チームから外す' }).click();
  await settle(page);
  await page.goto(`${overview}?team=1#engagement-info`);
  await expect(
    page
      .locator('li', { hasText: candidate })
      .filter({ has: page.getByRole('button', { name: 'チームから外す' }) }),
  ).toHaveCount(0);
});

test('F118: 設定の入口は企業管理者のまま。管理者は許諾を取り消し、通知の「元に戻す」で再付与できる', async ({
  page,
}) => {
  // 権限の挙動は変えない（指示書 §30。R1・plan Q6 は見送り）: 作成担当は設定の画面に入れない
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/settings?tab=grants');
  await expect(page.getByText('アクセス権限がありません')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消…' })).toHaveCount(0);

  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=grants');
  await expect(page.getByText('アクセス権限がありません')).toHaveCount(0);

  const revoke = page.getByRole('button', { name: '取消…' }).first();
  await expect(revoke, '取消できる許諾が必要').toBeVisible();
  const before = await page.getByRole('button', { name: '再付与' }).count();
  await revoke.click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=grantRevoked/);
  await expect(page.getByRole('button', { name: '再付与' })).toHaveCount(before + 1);
  // 区分 3（可逆）: 結果の通知に「元に戻す」
  await page.getByRole('status').getByRole('button', { name: '元に戻す' }).click();
  await page.waitForURL(/flash=grantRestored/);
  await expect(page.getByRole('button', { name: '再付与' })).toHaveCount(before);
});

test('F042: SSBJ 要求事項の詳細の作成パネルから対応計画を追加できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/requirements/top-priority');
  await page.waitForURL(/\/ssbj\/requirements\/[0-9a-f-]{36}/);
  await page.getByRole('link', { name: '対応計画に追加' }).first().click();
  await page.waitForURL(/[?&]new=1/);
  const form = page.locator('form', { has: page.locator('input[name="title"]') }).first();
  await expect(form).toBeVisible();
  const title = `再設計検証の対応計画 ${STAMP}`;
  await form.getByLabel('対応内容').fill(title);
  await form.getByRole('button', { name: '対応計画に追加' }).click();
  await settle(page);
  await expect(page.locator('td', { hasText: title })).toBeVisible();
});

test('F082: 開示プロジェクトを 3 段階の作成画面で作れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosure-projects');
  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: 'プロジェクトを作成' })
    .click();
  await page.waitForURL(/\/enterprise\/disclosure-projects\/new/);
  const name = `再設計検証のプロジェクト ${STAMP}`;
  await page.locator('#pf-name').fill(name);
  await page.getByRole('button', { name: '次へ' }).click();
  const purpose = page.locator('input[name="purposes"]').first();
  if (!(await purpose.isChecked())) await purpose.check();
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: '保存して準備を始める' }).click();
  await page.waitForURL(/\/enterprise\/disclosure-projects\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
});
