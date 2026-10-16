import { expect, test, type Page } from '@playwright/test';
import {
  DEMO_USERS,
  confirmInDialog,
  loginAs,
  openCollapsible,
  openMoreMenu,
  setDisclosureFirst,
} from './helpers';

/**
 * Scope1・2 の算定の実行・結果（plan §3.5 e2e:ghg-calculation・CR-08・CR-09・CR-10・CR-15・CR-16。架空データ）。
 *
 * 概要（5 拠点・国コード・二重表示・承認待ちの注記 N2）→ 算定を実行 → 算定明細（二重表示・拠点別・明細の展開で各段）→
 * CSV → Data Point に下書き反映（承認されない）→ GHG 算定サマリーの「Scope1・2 の算定と照合」と架空値のバッジ
 * （Fixture のセットなので出る）。
 * 前後で開示デモを初期状態に戻す（GHG の表と数値データ。下書き反映で作った Data Point を残さない）。
 */

const OVERVIEW = '/enterprise/ghg/calculation';

/** 開示デモを初期状態に戻す（数値データも。GHG の算定の表はリセットの範囲に入っている） */
async function resetDemoIncludingDataPoints(page: Page): Promise<void> {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  await page.goto('/enterprise/dashboard');
  const menu = await openMoreMenu(page.locator('#t4d-main'));
  await menu.getByRole('menuitem', { name: /^開示デモを初期状態に戻す/ }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/数値データも初期値へ戻す/)
    .check();
  await confirmInDialog(page, { acknowledge: '上記の範囲だけを初期状態へ戻すことを確認しました' });
  await page.waitForURL(/flash=disclosureDemoReset/);
  await setDisclosureFirst(page, false);
}

test.describe.configure({ mode: 'serial' });

test.describe('Scope1・2 の算定の実行・結果', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await resetDemoIncludingDataPoints(page);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await resetDemoIncludingDataPoints(page);
    } finally {
      await page.close();
    }
  });

  test('概要: 5 拠点（国コード）の拠点別の結果・二重表示・承認待ちの注記 → 算定を実行 → 明細の展開・CSV → 下書き反映（承認されない）', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(OVERVIEW);
    const main = page.locator('#t4d-main');
    await expect(main.getByRole('heading', { level: 1, name: 'Scope1・2算定' })).toBeVisible();
    // 誠実さの表示（折りたたまない）: 架空のデータ・デモデータ
    await expect(main.locator('[data-ghg-notice="N9"]')).toBeVisible();
    await expect(main.locator('[data-honesty="demo-data"]').first()).toBeVisible();
    await expect(main.getByRole('navigation', { name: '算定の検証の段階' })).toBeVisible();

    // 拠点別の結果: 国内 1・海外 4 の 5 拠点（国コード付き）と状態のバッジ
    const sites = main.getByRole('table', { name: '拠点別の結果' });
    for (const [code, country] of [
      ['EAST', '（JP・国内）'],
      ['TH1', '（TH・海外）'],
      ['VN1', '（VN・海外）'],
      ['MX1', '（MX・海外）'],
      ['US1', '（US・海外）'],
    ] as const) {
      const row = sites.locator(`[data-site-row="${code}"]`);
      await expect(row).toContainText(country);
      await expect(row.locator('[data-status-domain="ghgSiteStatus"]')).toBeVisible();
    }
    await expect(sites.locator('tbody tr')).toHaveCount(5);

    // 二重表示: 区分規則 LOGI-01 は承認待ち（N2）。R-1 は再分類していないので、組織の算定ルールのバッジ
    // （標準区分と異なる区分を含む）は出さない。計は移動だけ（±0）
    const dualSection = main.getByRole('region', { name: '報告区分と既定区分' });
    await expect(dualSection.locator('[data-ghg-notice="N2"]')).toBeVisible();
    await expect(dualSection.locator('[data-ghg-notice="N1"]')).toHaveCount(0);
    await expect(dualSection.locator('[data-honesty="company-rule"]')).toHaveCount(0);
    await expect(dualSection.locator('[data-ghg-notice="N6"]')).toBeVisible();
    const dual = dualSection.getByRole('table', { name: '報告区分と既定区分' });
    await expect(dual.locator('[data-dual-row="scope1_scope3_total"]')).toContainText(
      '±0（移動だけ・二重計上なし）',
    );
    // Scope2 の 2 基準は別々の行（足した行は無い）
    await expect(dual.locator('[data-dual-row="scope2_location"]')).toBeVisible();
    await expect(dual.locator('[data-dual-row="scope2"]')).toBeVisible();

    // 算定の記録（Fixture の R-1）が一覧にある
    const runs = main.locator('[data-data-table="ghg-calc-runs"]');
    await expect(runs.locator('tr[data-t4d-record]')).toHaveCount(1);

    // ---- 算定を実行（主操作）→ 算定明細へ ----
    await main.locator('[data-action-id="run-calculation"]').click();
    await page.waitForURL(
      /\/enterprise\/ghg\/calculation\/runs\/[0-9a-f-]{36}\?flash=ghgRunCreated/,
    );
    const runUrl = page.url().split('?')[0]!;
    await expect(
      main.getByText(/算定を実行し、算定の記録を作りました（算定行 \d+ 行）/),
    ).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: '算定明細' })).toBeVisible();
    await expect(main.getByText('最新の入力').first()).toBeVisible();
    await expect(main.locator('[data-ghg-notice="N9"]')).toBeVisible();
    // 見なし積載率・下限の行がある（N7）
    await expect(main.locator('[data-ghg-notice="N7"]')).toBeVisible();
    await expect(main.getByRole('table', { name: '報告区分と既定区分' })).toBeVisible();
    await expect(main.getByRole('table', { name: '拠点別の結果（この記録）' })).toBeVisible();

    // 明細の展開で各段（活動量 → 換算 → 係数 → 排出量 → 区分）
    const lines = main.locator('[data-data-table="ghg-run-lines"]');
    await lines
      .getByRole('button', { name: /の詳細を開く$/ })
      .first()
      .click();
    const detail = lines.locator('[data-line-detail]').first();
    await expect(detail).toBeVisible();
    for (const term of ['活動量', '換算', '排出係数', '係数の解決経路', '排出量', '区分']) {
      await expect(detail.getByText(term, { exact: true })).toBeVisible();
    }
    // 改良トンキロ法の行: t·km → 燃料使用原単位 → 積載率の出所（ラベル＋アイコン）→ 燃料
    await page.goto(`${runUrl}?method=tonkm_improved`);
    await lines
      .getByRole('button', { name: /の詳細を開く$/ })
      .first()
      .click();
    const transport = lines.locator('[data-line-detail]').first();
    await expect(transport.getByText('燃料使用原単位', { exact: true })).toBeVisible();
    await expect(transport.locator('[data-status-domain="ghgLoadFactorSource"]')).toBeVisible();
    await expect(transport.getByText('燃料', { exact: true })).toBeVisible();

    // ---- CSV（E18。副操作）----
    const downloadPromise = page.waitForEvent('download');
    await main.locator('[data-action-id="export-calculation-csv"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^算定明細_CY2025_[0-9a-f]{8}\.csv$/);

    // ---- Data Point に下書き反映（主操作。確認ダイアログ）→ 承認されない ----
    await page.goto(runUrl);
    const posting = main.getByRole('table', { name: 'Data Point への反映（報告区分）' });
    await expect(posting.locator('tr[data-posting-action="create"]')).toHaveCount(15);
    await main.locator('[data-action-id="post-to-data-points"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/新規作成 15 件/)).toBeVisible();
    await expect(dialog.getByText(/承認はしません/)).toBeVisible();
    await confirmInDialog(page);
    await page.waitForURL(/flash=ghgRunPosted/);
    await expect(main.getByText(/Data Point に下書きの版を反映しました（新規 15 件/)).toBeVisible();
    await expect(main.getByText(/承認はしていません/)).toBeVisible();
    // 反映先はすべて下書き。承認済みは無い（確定は承認フローで人が行う）
    const statuses = posting.locator('[data-status-domain="dataPoint"]');
    await expect(statuses).toHaveCount(15);
    await expect(posting.locator('[data-status-value="draft"]')).toHaveCount(15);
    await expect(posting.locator('[data-status-value="approved"]')).toHaveCount(0);
    await expect(posting.locator('tr[data-posting-action="unchanged"]')).toHaveCount(15);
    // 同じ値の再反映は押せない（理由を出す）
    await expect(main.locator('[data-action-id="post-to-data-points"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Data Point の詳細に算定内訳（Σ 算定行（記録 #…））が付く（算定内訳は既定で閉じた節）
    await posting.getByRole('link').first().click();
    await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]{36}/);
    const breakdown = await openCollapsible(page.locator('#t4d-main'), /^算定の内訳（1 式）$/);
    await expect(breakdown.getByText(/^Σ 算定行（記録 #[0-9a-f]{8}）$/)).toBeVisible();

    // 概要へ戻ると、最新の記録で拠点は「算定済み」
    await page.goto(OVERVIEW);
    await expect(
      main.getByRole('table', { name: '拠点別の結果' }).locator('[data-status-value="calculated"]'),
    ).toHaveCount(5);
  });

  test('役割: レビュー担当・最終承認者は「算定を実行」を押せない（理由付き）。拠点担当は担当外の拠点を含むため押せない', async ({
    page,
  }) => {
    for (const [user, reason] of [
      [DEMO_USERS.reviewer, /権限/],
      [DEMO_USERS.approver, /権限/],
      [DEMO_USERS.siteUser, /担当外の拠点（.+）を含むため実行できません/],
    ] as const) {
      await loginAs(page, user);
      await page.goto(OVERVIEW);
      const main = page.locator('#t4d-main');
      // 閲覧はできる（拠点別の結果・二重表示）。主操作は押せないボタンとして残し、理由を出す
      await expect(main.getByRole('table', { name: '拠点別の結果' })).toBeVisible();
      const run = main.locator('[data-action-id="run-calculation"]');
      await expect(run).toHaveAttribute('aria-disabled', 'true');
      await expect(main.locator('#action-reason-run-calculation')).toHaveText(reason);
      // 算定明細の「Data Point に下書き反映」も押せない（書きの権限・担当拠点）
      await main.locator('[data-data-table="ghg-calc-runs"] tr[data-t4d-record] a').first().click();
      await page.waitForURL(/\/enterprise\/ghg\/calculation\/runs\/[0-9a-f-]{36}/);
      await expect(main.locator('[data-action-id="post-to-data-points"]')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });

  test('GHG 算定サマリー: 「Scope1・2 の算定と照合」と係数の出所のバッジ（Fixture のセットは架空）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/ghg');
    const section = page.getByRole('region', { name: 'Scope1・2 の算定と照合' });
    await expect(section).toBeVisible();
    await expect(section.locator('[data-status-domain="factorOrigin"]').first()).toContainText(
      '架空（デモ）',
    );
    await expect(
      section.getByRole('table', { name: 'Scope1・2 の算定の拠点別の結果' }),
    ).toBeVisible();
    await expect(section.locator('[data-ghg-notice="N2"]')).toBeVisible();
    // 二重表示（算定の概要・明細と同じ表）
    await expect(section.getByRole('table', { name: '報告区分と既定区分' })).toBeVisible();
    // 排出係数マスター（Cat.1 の Fixture の係数）は架空値のまま（出所で出し分け）
    await expect(
      page.locator('#ghg-emission-factors').getByText('架空値（実係数ではありません）'),
    ).toBeVisible();
    // 内部取引控除の文は推移の控除の有無から導く（Fixture は FY2026 から）
    await expect(
      page.getByText('内部取引控除は FY2026 から適用（過年度は控除前の値）。'),
    ).toBeVisible();
    await section.getByRole('link', { name: 'Scope1・2算定を開く' }).click();
    await page.waitForURL(/\/enterprise\/ghg\/calculation\?period=/);
    await expect(page.getByRole('heading', { level: 1, name: 'Scope1・2算定' })).toBeVisible();
  });
});
