import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import {
  DEMO_USERS,
  confirmInDialog,
  loginAs,
  openCollapsible,
  openMoreMenu,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * XBRL Stage 1（トライアル対応 NF-42・NF-43。plan §3.6 e2e:trial-xbrl）。
 *
 * FY2025 の社内承認済みスナップショット（架空）と SAMPLE（架空）のタクソノミ・既定の対応付けで、
 * 書き込みなしに対応付け・検証・事実の一覧・社内確認用のプレビューまで見せる。
 *  - タブはキーボードで開ける・axe の重大な違反が無い
 *  - 先頭に SAMPLE・提出用ではない注記（折りたたまない）
 *  - 出力（プレビュー・xBRL-JSON・照合表）のリンクは出力の権限があるときだけ
 *  - プレビューの先頭に「提出用ではありません」の帯
 *  - 承認権限者は候補を選んだときだけ一括確定が出る（主操作。ここでは確定せず閉じる＝状態を変えない）
 *  - 「今後対応」は提出用ファイル（Stage 2〜3）だけを残す（NF-43）
 */

const PROJECT_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2025}`;
const XBRL_TAB = `${PROJECT_PATH}?tab=xbrl`;

async function openXbrlTab(page: Page): Promise<void> {
  await page.goto(XBRL_TAB);
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.locator('[data-xbrl-honesty]')).toBeVisible();
}

test('XBRL タブ: キーボードで開け、SAMPLE・提出用ではない注記と指標の帯・一覧・事実が見える（axe）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PROJECT_PATH);
  // タブはリンク。キーボード（フォーカス → Enter）で開ける
  const tab = page.getByRole('navigation', { name: 'プロジェクトのタブ' }).getByRole('link', {
    name: /^XBRL/,
  });
  await tab.focus();
  await expect(tab).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(/tab=xbrl/);

  const main = page.locator('#t4d-main');
  const honesty = main.locator('[data-xbrl-honesty]');
  await expect(honesty).toContainText('提出用ではありません');
  await expect(honesty).toContainText('SAMPLE（架空）');
  await expect(honesty).toContainText('公式の検証ではありません');
  await expect(honesty.locator('[data-honesty="not-filing-ready"]')).toBeVisible();
  await expect(honesty.locator('[data-honesty="sample-master"]')).toBeVisible();

  const strip = main.getByRole('region', { name: 'XBRL の対応付けと検証' });
  await expect(strip.getByText('確定', { exact: true })).toBeVisible();
  await expect(strip.getByText('事実の追跡')).toBeVisible();

  const table = main.locator('[data-data-table="xbrl-mappings"]');
  await expect(table.getByRole('table', { name: /XBRL の対応付け/ })).toBeVisible();
  await expect(table.getByText('（サンプル）スコープ1 温室効果ガス排出量')).toBeVisible();
  await expect(table.locator('[data-status-domain="xbrlMapping"]').first()).toBeVisible();

  const facts = await openCollapsible(main, /^事実の一覧（3 件・追跡 3 \/ 3）$/);
  await expect(facts.getByText('t4ds:SampleScope1GhgEmissions')).toBeVisible();
  await expect(main.locator('[data-xbrl-findings]')).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
});

test('出力のリンクは出力の権限があるときだけ。プレビューの先頭に「提出用ではありません」の帯', async ({
  page,
}) => {
  // レビュー担当は閲覧・編集はできるが出力の権限が無い
  await loginAs(page, DEMO_USERS.reviewer);
  await openXbrlTab(page);
  const main = page.locator('#t4d-main');
  await expect(main.getByRole('link', { name: /インライン XBRL プレビュー/ })).toHaveCount(0);
  await expect(main.locator('[data-action-id="xbrl-preview"]')).toHaveCount(0);

  await loginAs(page, DEMO_USERS.sustainability);
  await openXbrlTab(page);
  const preview = main.getByRole('link', { name: /インライン XBRL プレビュー（社内確認用）/ });
  await expect(preview).toBeVisible();
  // その他に xBRL-JSON・照合表（出力の群）
  const menu = await openMoreMenu(main);
  await expect(menu.getByRole('menuitem', { name: /xBRL-JSON・社内確認用/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /照合表（CSV・社内確認用）/ })).toBeVisible();
  await page.keyboard.press('Escape');

  const href = (await preview.getAttribute('href'))!;
  await page.goto(href);
  const banner = page.locator('[data-t4d-not-filing-ready]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('提出用ではありません');
  // 帯は本文（節）より前
  const order = await page.evaluate(() => {
    const bannerEl = document.querySelector('[data-t4d-not-filing-ready]');
    const firstSection = document.querySelector('section.block');
    return bannerEl && firstSection
      ? Boolean(bannerEl.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING)
      : false;
  });
  expect(order).toBe(true);
  await expect(page.locator('script')).toHaveCount(0);
});

test('承認権限者: 候補を選んだときだけ「選択した対応付けを確定」が出る（確認ダイアログで止める）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.approver);
  await openXbrlTab(page);
  const main = page.locator('#t4d-main');
  // 選択 0 件では一括のバーを出さない
  await expect(main.locator('[data-bulk-action-bar]')).toHaveCount(0);
  const candidate = main
    .locator('[data-data-table="xbrl-mappings"] tr[data-row-status="候補"]')
    .first();
  await expect(candidate).toBeVisible();
  await candidate.locator('input[type="checkbox"][data-t4d-select]').check();
  const bar = main.locator('[data-bulk-action-bar]');
  await expect(bar).toBeVisible();
  const confirm = bar.getByRole('button', { name: '選択した対応付けを確定' });
  await expect(confirm).toHaveAttribute('data-variant', 'primary');
  await confirm.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-confirm-scope]')).toContainText('1 件');
  await expect(dialog).toContainText('職務分離');
  // 確定せずに閉じる（Demo の共有状態を変えない）
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('今後対応: XBRL は提出用ファイル（Stage 2〜3）だけを残し、SSBJ は 133 項目を収録済みと示す', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/roadmap');
  const main = page.locator('#t4d-main');
  await expect(main.getByText('提出用ファイル（公式タクソノミ・公式検証）')).toBeVisible();
  await expect(main.getByText('Stage 2〜3')).toBeVisible();
  await expect(main.getByText('XBRL / iXBRL 提出 Package')).toHaveCount(0);
  await expect(main.getByText(/SSBJ は正式 133 項目を収録済み/)).toBeVisible();
  await expect(main.getByText(/SSBJ 10 項目/)).toHaveCount(0);
});

/**
 * 対応付けの操作（作成担当が候補を作る → 承認権限者が確定 → 対象外 → 取り消し → 削除）。AI の候補・タクソノミの設定。
 * 共有の状態（FY2025 の XBRL の対応付け）を変えるため、このファイルの最後に置き、終わったら開示デモのリセットで戻す
 */
test.describe('XBRL の対応付けの操作（共有の状態を変える。最後に戻す）', () => {
  test.describe.configure({ mode: 'serial' });
  let conceptLabel = '';

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await loginAs(page, DEMO_USERS.enterpriseAdmin);
      await setDisclosureFirst(page, true);
      await page.goto('/enterprise/dashboard');
      await resetDisclosureDemo(page);
      await setDisclosureFirst(page, false);
    } finally {
      await page.close();
    }
  });

  test('作成担当: 節を、まだ使っていない文章の概念へ対応付ける（候補として保存）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await openXbrlTab(page);
    const table = page.locator('[data-data-table="xbrl-mappings"]');
    // FY2025 の対象はすべて対応付け済み（Fixture）。見出しの「対応付けを追加」から、節を別の概念へ足す
    await page.locator('[data-page-actions]').getByRole('link', { name: '対応付けを追加' }).click();
    const panel = page.locator('#xbrl-new-panel');
    await expect(panel).toBeVisible();
    const target = await panel
      .locator('select[name="targetKey"] option')
      .evaluateAll((els) =>
        els
          .map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }))
          .find((o) => o.text.startsWith('節:')),
      );
    expect(target, '節の対象が無い').toBeDefined();
    await panel.locator('select[name="targetKey"]').selectOption(target!.value);
    // 一覧でまだ使っていない文章の概念（テキストブロック）を選ぶ
    const tableText = await table.innerText();
    const options = await panel
      .locator('select[name="conceptId"] optgroup[label="文章の概念（テキストブロック）"] option')
      .evaluateAll((els) =>
        els.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })),
      );
    const unused = options.find((o) => !tableText.includes(o.text.trim()));
    expect(unused, '未使用の文章の概念が SAMPLE に無い').toBeDefined();
    conceptLabel = unused!.text.trim();
    await panel.locator('select[name="conceptId"]').selectOption(unused!.value);
    await panel.getByRole('button', { name: /候補として保存/ }).click();
    await page.waitForURL(/xbrlResult=saved/);
    await expect(
      table.locator('tr[data-row-status="候補"]', { hasText: conceptLabel }),
    ).toBeVisible();
  });

  test('承認権限者: 作成者以外が行の「確定…」で確定する（確認ダイアログ）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.approver);
    await openXbrlTab(page);
    const row = page
      .locator('[data-data-table="xbrl-mappings"] tr[data-row-status="候補"]', {
        hasText: conceptLabel,
      })
      .first();
    await row.getByRole('button', { name: '確定…' }).click();
    await expect(page.getByRole('dialog')).toContainText('この対応付けを確定しますか');
    await confirmInDialog(page);
    await page.waitForURL(/xbrlResult=confirmed/);
    await expect(
      page.locator('[data-data-table="xbrl-mappings"] tr[data-row-status="確定"]', {
        hasText: conceptLabel,
      }),
    ).toBeVisible();
  });

  test('作成担当: 対象外にする（理由）→ 取り消す → 削除する', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await openXbrlTab(page);
    const table = page.locator('[data-data-table="xbrl-mappings"]');
    const rowOf = () => table.locator('tr[data-row-id]', { hasText: conceptLabel }).first();

    await rowOf()
      .getByRole('button', { name: /の操作$/ })
      .click();
    await page.getByRole('menuitem', { name: '対象外にする…' }).click();
    await confirmInDialog(page, { reason: 'E2E: 社内確認の対象外（架空）' });
    await page.waitForURL(/xbrlResult=excluded/);
    await expect(rowOf()).toHaveAttribute('data-row-status', '対象外');

    await rowOf().getByRole('button', { name: '対象外を取り消す' }).click();
    await page.waitForURL(/xbrlResult=restored/);
    await expect(rowOf()).toHaveAttribute('data-row-status', '候補');

    await rowOf()
      .getByRole('button', { name: /の操作$/ })
      .click();
    await page.getByRole('menuitem', { name: '削除…' }).click();
    await expect(page.getByRole('dialog')).toContainText('この対応付けを削除しますか');
    await confirmInDialog(page);
    await page.waitForURL(/xbrlResult=deleted/);
    await expect(table.locator('tr[data-row-id]', { hasText: conceptLabel })).toHaveCount(0);
  });

  test('AI の候補は候補のまま入り（確定しない）、タクソノミの設定は人が保存する', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await openXbrlTab(page);
    const table = page.locator('[data-data-table="xbrl-mappings"]');
    // FY2025 の対象はすべて対応付け済み（Fixture）で、AI の候補は「未対応付け」が無いと出せない
    // （押せない理由が出る）。候補を出す対象を作るため、節の確定済みの対応付けを 1 件削除する
    const blockRow = table
      .locator('tr[data-row-status="確定"]', { hasText: '節（テキストブロック）' })
      .first();
    const blockTitle = (
      await blockRow.locator('span.block.font-medium.text-ink').first().innerText()
    ).trim();
    await blockRow.getByRole('button', { name: /の操作$/ }).click();
    await page.getByRole('menuitem', { name: '削除…' }).click();
    await expect(page.getByRole('dialog')).toContainText('この対応付けを削除しますか');
    await confirmInDialog(page);
    await page.waitForURL(/xbrlResult=deleted/);
    await expect(
      table.locator('tr[data-row-status="未対応付け"]', { hasText: blockTitle }),
    ).toBeVisible();

    const confirmedBefore = await table.locator('tr[data-row-status="確定"]').count();
    const menu = await openMoreMenu(page.locator('#t4d-main'));
    await menu.getByRole('menuitem', { name: 'AI に対応付けの候補を出させる' }).click();
    await page.waitForURL(/xbrlResult=suggested/);
    // AI は確定しない: 外した節は「候補」で入り、確定の件数は変わらない
    await expect(
      table.locator('tr[data-row-status="候補"]', { hasText: blockTitle }),
    ).toBeVisible();
    await expect(table.locator('tr[data-row-status="確定"]')).toHaveCount(confirmedBefore);

    const frameworks = page.locator('[data-xbrl-frameworks]');
    const form = frameworks.locator('form').first();
    await form.getByRole('button', { name: '設定する' }).click();
    await page.waitForURL(/xbrlResult=taxonomy/);
  });
});
