import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { ghgBatchId } from '../../src/lib/fixtures/ghg-verification';
import {
  confirmInDialog,
  DEMO_USERS,
  loginAs,
  openMoreMenu,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * 活動量の取込と改良トンキロ法（plan §3.5 e2e:ghg-activity-tonkm・CR-05・CR-06・CR-19。架空データ）。
 *
 * 輸送実績のサンプル（E20）を取込 → 検証で見なし積載率・下限・範囲外の警告と件数 → 取込（確認中）→
 * バッチの詳細で t·km → 原単位 → 燃料 → CO2 の段と積載率の出所のバッジ、試算の注記 → 確定（確認ダイアログ）→
 * 海外拠点の輸送には固定文 N5。公的参照プリセット（N10）は閲覧だけ。最後に開示デモを初期状態に戻す（GHG の表も戻る）。
 */

const LIST = '/enterprise/ghg/calculation/activity';
const SAMPLE_LABEL = '輸送実績（架空・東日本工場の追加 6 行）CSV';

test.describe.configure({ mode: 'serial' });

test.describe('活動量の取込と改良トンキロ法', () => {
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

  test('一覧: 充足・見なし積載率と下限の件数（N7）・架空の注記（N9）・公的参照プリセット（N10）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(LIST);
    await expect(
      page.getByRole('heading', { name: '活動量（Scope1・2算定）', level: 1 }),
    ).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N9"]')).toBeVisible();
    await expect(page.locator('[data-honesty="fictional"]').first()).toBeVisible();
    // 委託物流の輸送実績 24 行のうち、積載率なし 4 行・5% の行 1 行（下限 10%）
    const n7 = page.locator('[data-ghg-notice="N7"]');
    await expect(n7).toBeVisible();
    await expect(n7).toContainText('（4 行）');
    await expect(n7).toContainText('10% として算定しました（1 行）');
    // 拠点 × 活動の充足（検証 5 拠点）
    for (const code of ['EAST', 'TH1', 'VN1', 'MX1', 'US1']) {
      await expect(page.locator(`[data-coverage-site="${code}"]`).first()).toBeVisible();
    }
    await expect(
      page.locator('[data-coverage-site="EAST"][data-coverage-kind="transport"]'),
    ).toContainText('すべて受領');
    // 公的参照プリセット: 既定では適用しない。N10 は折りたたみの外
    const preset = page.locator('#tonkm-preset');
    await expect(preset.getByText('既定では適用しません')).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N10"]')).toBeVisible();
    await expect(preset.getByRole('cell', { name: '⑦' })).toBeVisible();
  });

  test('本社サステナ担当: 輸送実績のサンプルを検証し（警告と件数）、確認中として取り込み、試算を確かめて確定する', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(LIST);
    await page.locator('[data-action-id="open-activity-import"]').click();
    const panel = page.locator('#activity-import');
    await expect(panel.getByRole('navigation', { name: '活動量の取込の段階' })).toBeVisible();

    // 種類と拠点（輸送実績・東日本工場・追加）→ ファイル
    await panel.getByLabel('種類').selectOption('transport');
    await panel.getByLabel('拠点').selectOption({ label: '東日本工場（EAST・JP）' });
    await expect(panel.getByLabel('取り込み方')).toHaveValue('');
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: SAMPLE_LABEL }).click();
    const download = await downloadPromise;
    const buffer = fs.readFileSync((await download.path())!);
    await page.locator('#activity-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'text/csv',
      buffer,
    });

    // 検証（保存しない）: 列は列名から提案、見なし積載率 1・下限 1・範囲外 1
    await panel.locator('[data-action-id="verify-activity"]').click();
    await expect(panel.getByText('取り込めます')).toBeVisible();
    await expect(panel.locator('[data-mapping-field="maxPayloadKg"] select')).toHaveValue(
      '最大積載量(kg)',
    );
    const summary = panel.locator('[data-activity-preview-summary]');
    await expect(summary).toContainText('取り込める行6 行');
    await expect(summary).toContainText('見なし積載率1 行');
    await expect(summary).toContainText('下限を適用1 行');
    await expect(summary).toContainText('最大積載量が範囲外1 行');
    await expect(panel.locator('[data-ghg-notice="N7"]')).toContainText('（1 行）');
    await expect(panel.getByText('積載率の下限を適用').first()).toBeVisible();
    await expect(panel.getByText('見なし積載率（原単位表）').first()).toBeVisible();
    await expect(panel.getByText('最大積載量が式の範囲外').first()).toBeVisible();

    // 取込（確認中のバッチ）→ 詳細へ
    await panel.locator('[data-action-id="import-activity-file"]').click();
    await page.waitForURL(
      /\/enterprise\/ghg\/calculation\/activity\/[0-9a-f-]{36}\?.*flash=ghgActivityImported/,
    );
    await expect(page.getByText('活動量を取り込みました（6 行・確認中）')).toBeVisible();
    await expect(page.getByRole('heading', { name: '活動量の取込の詳細', level: 1 })).toBeVisible();
    await expect(page.locator('[data-status-domain="ghgActivityBatch"]').first()).toContainText(
      '確認中',
    );
    await expect(page.getByText('試算です（算定の記録ではありません）')).toBeVisible();
    await expect(page.locator('[data-honesty="estimate"]').first()).toBeVisible();
    await expect(page.locator('[data-ghg-notice="N7"]')).toBeVisible();

    // 展開行: t·km → 原単位（告示の形・実測）→ 燃料 → CO2
    const table = page.locator('[data-data-table="ghg-activity-lines"]');
    await table.getByRole('button', { name: '1 行目 の詳細を開く' }).click();
    const first = table.locator('[data-trial-steps="1"]');
    await expect(first).toBeVisible();
    await expect(first.getByText('輸送トンキロ')).toBeVisible();
    await expect(first.getByText('燃料使用原単位（L/(t·km)）')).toBeVisible();
    await expect(first.getByText('燃料使用量')).toBeVisible();
    await expect(first.getByText('CO2（試算・未丸め）')).toBeVisible();
    await expect(first.getByText(/告示の形 x ＝/)).toBeVisible();
    await expect(first.locator('[data-status-domain="ghgLoadFactorSource"]')).toContainText('実測');
    // 3 行目は積載率なし（見なし積載率の原単位表）、4 行目は 5%（下限を適用）
    await table.getByRole('button', { name: '3 行目 の詳細を開く' }).click();
    await expect(
      table.locator('[data-trial-steps="3"] [data-status-domain="ghgLoadFactorSource"]'),
    ).toContainText('見なし（原単位表）');
    await table.getByRole('button', { name: '4 行目 の詳細を開く' }).click();
    await expect(
      table.locator('[data-trial-steps="4"] [data-status-domain="ghgLoadFactorSource"]'),
    ).toContainText('下限を適用');

    // 確定（確認ダイアログ・区分 2）
    await page.locator('[data-action-id="confirm-activity-batch"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('この活動量を確定しますか')).toBeVisible();
    await expect(dialog).toContainText('見なし積載率 1');
    await confirmInDialog(page);
    await page.waitForURL(/flash=ghgActivityConfirmed/);
    await expect(page.getByText('活動量を確定しました（6 行）')).toBeVisible();
    await expect(page.locator('[data-status-domain="ghgActivityBatch"]').first()).toContainText(
      '確定',
    );
    await expect(page.locator('[data-action-id="confirm-activity-batch"]')).toHaveCount(0);

    // 一覧の取込の記録に確定として出る
    await page.goto(LIST);
    const batches = page.locator('[data-data-table="ghg-activity-batches"]');
    await expect(batches.getByRole('link', { name: download.suggestedFilename() })).toBeVisible();
  });

  test('本社サステナ担当: エネルギーのサンプルを確認中として取り込み、確定せずに破棄する（取り消せない・算定に使わない）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(`${LIST}?new=1`);
    const panel = page.locator('#activity-import');
    await panel.getByLabel('種類').selectOption('energy');
    await panel.getByLabel('拠点').selectOption({ label: '米国工場（US1・US）' });
    const downloadPromise = page.waitForEvent('download');
    await panel
      .getByRole('link', { name: 'エネルギー（架空・米国工場の 7 月の訂正）XLSX' })
      .click();
    const download = await downloadPromise;
    await page.locator('#activity-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: fs.readFileSync((await download.path())!),
    });
    await panel.locator('[data-action-id="verify-activity"]').click();
    await expect(panel.getByText('取り込めます')).toBeVisible();
    await panel.locator('[data-action-id="import-activity-file"]').click();
    await page.waitForURL(
      /\/enterprise\/ghg\/calculation\/activity\/[0-9a-f-]{36}\?.*flash=ghgActivityImported/,
    );
    await expect(page.locator('[data-status-domain="ghgActivityBatch"]').first()).toContainText(
      '確認中',
    );
    // 破棄は「その他」（区分 1・取り消せない）。確定の主操作とは別
    const menu = await openMoreMenu(page.locator('#t4d-main'));
    await menu.getByRole('menuitem', { name: /^破棄する/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('この取込を破棄しますか')).toBeVisible();
    await confirmInDialog(page);
    await page.waitForURL(/flash=ghgActivityDiscarded/);
    await expect(
      page.getByText('活動量の取込を破棄しました。行は記録として残り、算定には使いません。'),
    ).toBeVisible();
    await expect(page.locator('[data-status-domain="ghgActivityBatch"]').first()).toContainText(
      '破棄',
    );
    await expect(page.locator('[data-action-id="confirm-activity-batch"]')).toHaveCount(0);
  });

  test('公的参照プリセット: 取込用 CSV を排出係数で取り込むと、出所「公的参照」の下書きのセットになる（有効にするまで算定に使わない）', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(LIST);
    const link = page.locator('#tonkm-preset [data-preset-download="shk_r5"]');
    await expect(link).toHaveAttribute('href', '/api/exports/ghg-preset-factor-set?fuelCo2=shk_r5');
    const downloadPromise = page.waitForEvent('download');
    await link.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^公的参照プリセット_改良トンキロ法_R5以降_.+\.csv$/,
    );
    const csv = fs.readFileSync((await download.path())!);

    await page.goto('/enterprise/ghg/calculation/factors?new=1');
    const panel = page.getByRole('region', { name: '係数セットを取り込む' });
    await panel.locator('input[name="code"]').fill('PUB-R5-E2E');
    await panel.locator('input[name="name"]').fill('公的参照（改良トンキロ法・燃料）E2E');
    await panel.locator('select[name="origin"]').selectOption('public_reference');
    await panel.locator('input[name="versionLabel"]').fill('告示 令和4年改正まで');
    await panel.locator('input[name="sourceLabel"]').fill('告示・算定省令（公的参照プリセット）');
    await panel.locator('#factor-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'text/csv',
      buffer: csv,
    });
    await panel.getByRole('button', { name: 'ファイルを読んで検証する' }).click();
    // 列の対応は見出しの語から決まる。小数点の記号は選ぶまで読まない（推測で埋めない）
    await expect(panel.getByRole('list', { name: '検証のエラー' })).toContainText(
      '小数点の記号を選ぶと読める場合があります',
    );
    await panel.locator('select[name="decimalSeparator"]').selectOption('dot');
    await panel.getByRole('button', { name: '列の対応を反映して検証する' }).click();
    await expect(panel.getByText('エラーなし')).toBeVisible();
    await expect(panel).toContainText('係数 6 件');
    await panel.getByRole('button', { name: '確定する（下書きのセットを作る）' }).click();
    await page.waitForURL(
      /\/enterprise\/ghg\/calculation\/factors\/[^/?]+\?flash=ghgFactorSetImported/,
    );
    const main = page.locator('#t4d-main');
    await expect(
      main.getByText('係数のセットを下書きとして取り込みました（係数 6 件）'),
    ).toBeVisible();
    await expect(main.locator('[data-status-domain="factorOrigin"]').first()).toHaveText(
      /公的参照/,
    );
    await expect(main.locator('[data-status-domain="ghgFactorSet"]').first()).toHaveText(/下書き/);
    // 公的資料の値を「架空値」と書かない（出所で出し分ける）
    await expect(main.getByText('架空値（実係数ではありません）')).toHaveCount(0);
    // 式は燃料ごとに 1 つ（軽油・揮発油）。告示の値のまま
    await expect(main.getByRole('heading', { name: /^改良トンキロ法の式: / })).toHaveCount(2);
    await expect(main.getByRole('heading', { name: /^見なし積載率の原単位表: / })).toHaveCount(2);
  });

  test('海外拠点の輸送を取り込むときは固定文 N5 を出す', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(`${LIST}?new=1`);
    const panel = page.locator('#activity-import');
    await panel.getByLabel('種類').selectOption('transport');
    await panel.getByLabel('拠点').selectOption({ label: 'タイ工場（TH1・TH）' });
    await expect(panel.locator('[data-ghg-notice="N5"]')).toBeVisible();
    await panel.getByLabel('種類').selectOption('energy');
    await expect(panel.locator('[data-ghg-notice="N5"]')).toHaveCount(0);
  });

  test('レビュー担当: 取込・確定の操作は出ない（閲覧と試算だけ）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.reviewer);
    await page.goto(LIST);
    await expect(
      page.getByRole('heading', { name: '活動量（Scope1・2算定）', level: 1 }),
    ).toBeVisible();
    await expect(page.locator('[data-action-id="open-activity-import"]')).toHaveCount(0);
    await page.goto(`${LIST}/${ghgBatchId('EAST', 'transport')}`);
    await expect(page.getByText('試算です（算定の記録ではありません）')).toBeVisible();
    await expect(page.locator('[data-action-id="confirm-activity-batch"]')).toHaveCount(0);
  });
});
