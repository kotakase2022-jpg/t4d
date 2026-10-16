import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { GHG_FIXTURE_IDS } from '../../src/lib/fixtures/ghg-verification';
import {
  confirmInDialog,
  DEMO_USERS,
  loginAs,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * 既存の算定結果との照合・差異の原因（plan §3.5 e2e:ghg-reconciliation・CR-11〜CR-15。架空データ）。
 *
 * 既存結果のサンプルを取込（拠点の対応付けを選ぶ）→ 許容差を入れて照合 → 6 種の原因・片側のみ・許容差内 →
 * レビュー担当で原因を記録 → 仮説の再計算で米国工場の差が許容差内になる（保存しない）→ XLSX →
 * 本文に判定語としての「一致」が無い。最後に開示デモを初期状態に戻す（GHG の表も戻る）。
 */

const LIST = '/enterprise/ghg/calculation/reconciliation';
const G = GHG_FIXTURE_IDS;
const FIXTURE_DETAIL = `${LIST}/${G.reconciliation}`;
const FIXTURE_BASELINE_LABEL = '既存算定結果（架空）CY2025';

/** 「一致」が出てよいのは、一致を保証しないことを述べる否定の文だけ */
function strayMatches(text: string): number {
  let rest = text;
  for (const phrase of ['一致を保証するものではありません']) {
    rest = rest.split(phrase).join('');
  }
  return rest.split('一致').length - 1;
}

const itemsTable = (page: Page) => page.locator('[data-data-table="ghg-reconciliation-items"]');
/** 項目の行（展開行〔閉じている〕は含めない） */
const itemRows = (page: Page) => itemsTable(page).locator('tr[data-t4d-record]');

test.describe.configure({ mode: 'serial' });

test.describe('既存の算定結果との照合', () => {
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

  test('本社サステナ担当: 既存結果のサンプルを取り込み（拠点の対応付けを選ぶ）、許容差を入れて照合する', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(LIST);
    await expect(
      page.getByRole('heading', { name: '既存の算定結果との照合', level: 1 }),
    ).toBeVisible();
    // 誠実さの表示: 整合性の確認（一致の保証ではない）・架空のデータ。折りたたまない
    await expect(page.locator('[data-ghg-notice="N3"]')).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N9"]')).toBeVisible();
    await expect(page.locator('[data-honesty="consistency-check"]').first()).toBeVisible();
    await expect(
      page.locator('[data-data-table="ghg-baselines"]').getByText(FIXTURE_BASELINE_LABEL),
    ).toBeVisible();

    // 取込（副操作）: ファイル → 列の対応と拠点の対応付け → 検証 → 確定
    await page.locator('[data-action-id="import-baseline"]').click();
    const panel = page.locator('#import-baseline');
    await expect(
      panel.getByRole('navigation', { name: '既存の算定結果の取込の段階' }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: '既存の算定結果（架空・拠点×活動の合計）XLSX' }).click();
    const download = await downloadPromise;
    const buffer = fs.readFileSync((await download.path())!);
    await page.locator('#baseline-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });
    // 列の対応は見出しから既定値。拠点の対応付けは選んでいない（推測しない）
    await expect(panel.locator('#baseline-map-siteCode')).toHaveValue('拠点コード');
    await expect(panel.getByLabel('拠点コード EAST の対応付け')).toHaveValue('');
    await panel.getByRole('button', { name: '検証する' }).click();
    await expect(panel.getByText('このままでは確定できません')).toBeVisible();
    await expect(panel.getByText(/拠点の対応付けを選んでいない拠点コードがあります/)).toBeVisible();
    await expect(panel.locator('[data-action-id="confirm-baseline-import"]')).toBeDisabled();

    await panel.locator('#baseline-decimal-separator').selectOption('dot');
    for (const [code, label] of [
      ['EAST', '東日本工場（EAST・JP）'],
      ['MX1', 'メキシコ工場（MX1・MX）'],
      ['TH1', 'タイ工場（TH1・TH）'],
      ['VN1', 'ベトナム工場（VN1・VN）'],
    ] as const) {
      await panel.getByLabel(`拠点コード ${code} の対応付け`).selectOption({ label });
    }
    await panel.getByRole('button', { name: '検証する' }).click();
    await expect(
      panel.getByText('確定できます。名前を確かめて「確定する…」を押してください。'),
    ).toBeVisible();
    await expect(panel.getByText('粒度: 拠点×活動')).toBeVisible();
    await panel.locator('[data-action-id="confirm-baseline-import"]').click();
    await confirmInDialog(page);
    await page.waitForURL(/flash=ghgBaselineImported/);
    await expect(
      page.getByText('既存の算定結果を取り込みました（19 行）', { exact: false }),
    ).toBeVisible();

    // 照合: 既存結果 BL-1 の行の「これと照合」→ 許容差（既定値なし）を入れる
    const blRow = page
      .locator('[data-data-table="ghg-baselines"] tr[data-t4d-record]')
      .filter({ hasText: FIXTURE_BASELINE_LABEL });
    await blRow.getByRole('link', { name: 'これと照合' }).click();
    const reconcile = page.locator('#reconcile');
    await expect(reconcile.getByText(`「${FIXTURE_BASELINE_LABEL}」`)).toBeVisible();
    const absInputs = reconcile.locator('input[name$=":abs"]');
    await expect(absInputs).toHaveCount(4);
    for (const input of await absInputs.all()) await expect(input).toHaveValue('');
    // 許容差を入れずに照合すると、既定値を置かずに断る
    await reconcile.getByRole('button', { name: '照合する' }).click();
    await expect(page.getByText(/許容差が入っていない区分があります/)).toBeVisible();
    await page.locator('#reconcile').locator('input[name$=":abs"]').first().waitFor();
    for (const input of await page.locator('#reconcile input[name$=":abs"]').all()) {
      await input.fill('0.05');
    }
    for (const input of await page.locator('#reconcile input[name$=":rel"]').all()) {
      await input.fill('0.1');
    }
    await page.locator('#reconcile').getByRole('button', { name: '照合する' }).click();
    await page.waitForURL(/\/reconciliation\/[0-9a-f-]{36}\?.*flash=ghgReconciled/);
    await expect(
      page.getByText(/照合を記録しました（項目 \d+ 件・許容差の外 \d+ 件）/),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '照合の詳細', level: 1 })).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N3"]')).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N4"]')).toBeVisible();

    // 6 種の原因・片側のみ・許容差内が、別々の項目として出る
    const detail = page.url().split('?')[0]!;
    await page.goto(`${detail}?verdict=needs_review&size=100`);
    for (const cause of ['排出係数（値・年度・版）', '単位換算', '区分']) {
      await expect(itemRows(page).getByText(cause, { exact: true }).first()).toBeVisible();
    }
    await page.goto(`${detail}?verdict=unexplained`);
    await expect(itemRows(page).getByText('米国工場（US）').first()).toBeVisible();
    await expect(
      itemRows(page)
        .locator('[data-status-domain="ghgCause"][data-status-value="residual"]')
        .first(),
    ).toBeVisible();
    await page.goto(`${detail}?verdict=one_sided`);
    await expect(itemRows(page).getByText('メキシコ工場（MX）')).toBeVisible();
    await expect(itemRows(page).getByText('対象範囲（行の有無）')).toBeVisible();
    await page.goto(`${detail}?unit=${G.units.th}`);
    await expect(itemRows(page).getByText('丸め', { exact: true }).first()).toBeVisible();
    await page.goto(`${detail}?verdict=within_tolerance`);
    await expect(
      itemRows(page)
        .locator('[data-status-domain="ghgReconItem"][data-status-value="within_tolerance"]')
        .first(),
    ).toBeVisible();

    // 展開行: 原因別の寄与（帯と数値の表）・残差・確認の記録
    await page.goto(`${detail}?verdict=unexplained`);
    await itemsTable(page)
      .getByRole('button', { name: /の詳細を開く$/ })
      .first()
      .click();
    const breakdown = page.locator('[data-item-breakdown]').first();
    await expect(breakdown).toBeVisible();
    await expect(breakdown.getByRole('table', { name: '原因別の寄与' })).toBeVisible();
    await expect(breakdown.getByRole('img', { name: /原因別の寄与の大きさ/ })).toBeVisible();
    await expect(breakdown.getByText('まだ確認の記録はありません。')).toBeVisible();
  });

  test('レビュー担当: 照合を始める操作は出ず、項目の「原因を記録」で原因を記録する（本人名義・追記）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.reviewer);
    await page.goto(LIST);
    await expect(page.locator('[data-ghg-notice="N3"]')).toBeVisible();
    await expect(page.locator('[data-action-id="reconcile"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="import-baseline"]')).toHaveCount(0);

    await page.goto(`${FIXTURE_DETAIL}?verdict=needs_review`);
    const firstRow = itemRows(page).first();
    await expect(firstRow).toContainText('ベトナム工場（VN）');
    await firstRow.getByRole('link', { name: '原因を記録' }).click();
    const panel = page.locator('#record-cause');
    await expect(panel.getByRole('heading', { name: '差異の原因を記録する' })).toBeVisible();
    await panel.locator('#record-cause-select').selectOption({ label: '排出係数（値・年度・版）' });
    await panel
      .locator('#record-cause-comment')
      .fill('（架空）既存の算定は 2024 年版の係数で算定していた');
    await panel.getByRole('button', { name: '原因を記録する' }).click();
    await page.waitForURL(/flash=ghgCauseRecorded/);
    await expect(page.getByText(/差異の原因を記録しました/)).toBeVisible();
    await expect(
      page.locator('[data-metric-tile]').filter({ hasText: '原因を確認済み' }).first(),
    ).toContainText(/原因を確認済み\s*1\s*\/\s*\d+/);
    const notes = page.getByRole('region', { name: '確認の記録' });
    await expect(
      notes.getByText('（架空）既存の算定は 2024 年版の係数で算定していた'),
    ).toBeVisible();
    await expect(notes.getByText('検見川 涼')).toBeVisible();
  });

  test('仮説の再計算（係数セット 2024 年版）で米国工場の差が許容差内になる。保存しない', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.reviewer);
    await page.goto(FIXTURE_DETAIL);
    const section = page.locator('#whatif');
    await expect(section.locator('[data-ghg-notice="N8"]')).toBeVisible();
    await section.locator('#whatif-select').selectOption({
      label: '係数セットを「組織指定（架空）2024 年版」（2024 年版）に置き換える',
    });
    await section.getByRole('button', { name: '仮説で再計算する' }).click();
    await page.waitForURL(/whatif=set/);
    const result = page.locator('[data-whatif-result]');
    await expect(result).toBeVisible();
    await expect(result.getByText(/許容差内になる項目 \d+ 件/)).toBeVisible();
    const us = result.locator('tr[data-whatif-item]').filter({ hasText: '米国工場（US）' });
    await expect(us.first()).toContainText('許容差内になる');
    // 保存しない: 照合の判定（米国工場は原因不明〔残差〕のまま）
    await page.goto(`${FIXTURE_DETAIL}?verdict=unexplained`);
    await expect(itemRows(page).getByText('米国工場（US）').first()).toBeVisible();
  });

  test('照合の結果を XLSX で出力する（本社サステナ担当）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(FIXTURE_DETAIL);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action-id="export-reconciliation"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('照合結果');
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('照合の一覧・詳細の本文に、判定語としての「一致」が無い', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    for (const url of [LIST, FIXTURE_DETAIL, `${FIXTURE_DETAIL}?verdict=unexplained`]) {
      await page.goto(url);
      await expect(page.locator('[data-ghg-notice="N3"]')).toBeVisible();
      const text = await page.locator('#t4d-main').innerText();
      expect(strayMatches(text), url).toBe(0);
      expect(text).toContain('整合性の確認');
    }
  });
});
