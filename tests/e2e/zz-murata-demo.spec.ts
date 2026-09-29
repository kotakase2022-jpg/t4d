import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildMurataFiles } from '../../scripts/murata-dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 村田製作所向けデモ: リセット → 20 ファイル一括 UI 投入 → 候補選択 → 確定 → リセット。
 *
 * Demo Mode の状態はテスト間で共有される。このファイルはリセットで
 * Scope3 Cat.1 の算定版を初期化してしまうため、**必ず最後**（zz- 接頭辞・
 * workers=1・アルファベット順）に実行する。
 * 実ブラウザの file input を通し、実際のパーサーと保存処理を検証する
 * （取り込み迂回の実装では通らない）。
 */

test.describe.configure({ mode: 'serial' });

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'test-results', 'murata-demo');

test('デモリセット: 削除範囲の確認つきで算定版を初期状態へ戻せる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  // デモ表示の注意書きと、デモデータセットの取得導線がある
  await expect(
    page.getByText('デモ環境｜サンプルデータ・表示スコアはシミュレーション'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /投入用 ZIP（20 ファイルのみ）/ })).toHaveAttribute(
    'href',
    '/demo/murata-scope3-cat1-upload.zip',
  );

  // 削除範囲の説明と確認チェックが必須
  await expect(page.getByText(/削除範囲: この組織 ×/)).toBeVisible();
  await page.getByRole('checkbox', { name: '上記の削除範囲を確認しました' }).check();
  await page.getByRole('button', { name: '取込済みの算定版をリセットする' }).click();
  await page.waitForURL(/flash=supplierDemoReset/);
  await expect(page.getByText(/サプライヤーデモの算定版をリセットしました/)).toBeVisible();

  // 初期状態（Fixture: 内訳合計 143.1）に戻っている
  await expect(page.getByText('143.1').first()).toBeVisible();
});

test('20 ファイルを一括投入 → 候補を選択 → 240 明細を確定できる', async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  const files = await buildMurataFiles();
  expect(files).toHaveLength(20);
  await page.locator('#supplier-file').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.bytes),
    })),
  );
  await page.getByRole('button', { name: '解析する' }).click();

  // 全体サマリー: 20 ファイル・明細 240 行・信頼度 80〜97%
  const summary = page.getByText(/解析結果: 20 ファイル・明細 240 行/);
  await expect(summary).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(/信頼度 最小 \d+% ／ 平均 \d+% ／ 最大 \d+%（80〜97% 内 100%）/),
  ).toBeVisible();

  // 合計行・注記行は取込対象外として明示される（黙って捨てない・二重計上しない）
  await expect(
    page.getByText('合計行と判定したため取込対象外です（明細行と重複するため）。').first(),
  ).toBeVisible();
  await expect(
    page.getByText('注記・フッター行と判定したため取込対象外です。').first(),
  ).toBeVisible();

  // 候補行: セラミック基板は 3 候補・推薦（生産国一致の中国係数）が初期選択済み
  const ceramicRow = page.locator('tr', { hasText: 'HTCC セラミック基板 CS-88' }).first();
  await expect(ceramicRow.getByText('推薦候補を選択中（変更可）')).toBeVisible();
  const ceramicSelect = ceramicRow.getByRole('combobox');
  await expect(ceramicSelect).toHaveValue('DEMO-EF-CERSUB-CN-M2');
  const optionCount = await ceramicSelect.locator('option').count();
  expect(optionCount).toBe(4); // 「原単位を選択…」+ 3 候補

  // 候補を変更するとクライアント側で排出量が再計算される（520 m2 × 0.055 = 28.6）
  await ceramicSelect.selectOption('DEMO-EF-PCB-GLB-M2');
  await expect(ceramicRow.getByText('28.6')).toBeVisible();
  // 推薦へ戻す（520 m2 × 0.018 = 9.4）
  await ceramicSelect.selectOption('DEMO-EF-CERSUB-CN-M2');
  await expect(ceramicRow.getByText('9.4')).toBeVisible();

  // 推薦なしの金額行（みずほ紙器の副資材）は人が選ぶまで確定対象にならない
  const miscRow = page.locator('tr', { hasText: '梱包用副資材一式（上期）' }).first();
  await expect(miscRow.getByText('原単位の紐づけ待ち')).toBeVisible();
  await expect(miscRow.getByRole('checkbox')).toBeDisabled();
  await miscRow.getByRole('combobox').selectOption('EF-PUR-PACK');
  await miscRow.getByRole('checkbox').check();
  const miscRow2 = page.locator('tr', { hasText: '梱包用副資材一式（下期）' }).first();
  await miscRow2.getByRole('combobox').selectOption('EF-PUR-PACK');
  await miscRow2.getByRole('checkbox').check();

  // 信頼度セルはデモ表示（ツールチップに実測スコアを併記）
  const confidenceCell = ceramicRow.locator('span[title*="実測スコア"]');
  await expect(confidenceCell).toBeVisible();

  // 2026-09-15 指示①-1: ファイル名クリックで投入した元ファイルがダウンロードされる
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '01_白鳳化学工業_納入実績_2025年度.xlsx' }).click();
  const redownload = await downloadPromise;
  expect(redownload.suggestedFilename()).toBe('01_白鳳化学工業_納入実績_2025年度.xlsx');

  // 2026-09-15 指示①-2: 数値を手修正するとその場で再計算される（520 → 1040 で倍の 18.7）
  const ceramicAmount = ceramicRow.getByLabel(/HTCC セラミック基板 CS-88 の数値/);
  await ceramicAmount.fill('1040');
  await expect(ceramicRow.getByText('18.7')).toBeVisible();
  await ceramicAmount.fill('520'); // 期待合計を変えないよう戻す
  await expect(ceramicRow.getByText('9.4')).toBeVisible();

  // 2026-09-15 指示①-2: 解決済みの行も原単位を選び直せる（セレクトに解決値が初期選択）
  const bacoRow = page.locator('tr', { hasText: '高純度炭酸バリウム BC-90A' }).first();
  await expect(bacoRow.getByRole('combobox')).toHaveValue('DEMO-EF-BACO3-JP-KG');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, '01-preview-20-files.png'),
    fullPage: false,
  });

  // 確定 → 内訳合計 6,760.3（既存 13 社 143.1 + 新規 20 社 6,617.2）
  await page.getByRole('button', { name: 'チェックした行を確定する' }).click();
  await page.waitForURL(/flash=supplierImported/, { timeout: 120_000 });
  await expect(page.getByText(/新規 20 社/)).toBeVisible();
  await expect(page.getByText('6,760.3').first()).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, '02-confirmed-total.png'),
    fullPage: false,
  });

  // GHG 画面の内訳にも反映される
  await page.goto('/enterprise/ghg');
  await expect(page.getByText('6,760.3').first()).toBeVisible();
  const murataSupplier = page.locator('tr', { hasText: '深圳華聯電路板有限公司' }).first();
  await expect(murataSupplier.getByText('提出済み')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, '03-ghg-breakdown.png'),
    fullPage: false,
  });
});

test('リセット → 再投入で同じ結果が再現される（削除は積んだ算定版のみ）', async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  await page.getByRole('checkbox', { name: '上記の削除範囲を確認しました' }).check();
  await page.getByRole('button', { name: '取込済みの算定版をリセットする' }).click();
  await page.waitForURL(/flash=supplierDemoReset/);
  await expect(page.getByText(/削除した版 1 件/)).toBeVisible();
  await expect(page.getByText('143.1').first()).toBeVisible();

  // 同じ 20 ファイルを再投入（候補は推薦のまま・副資材のみ選択）→ 同じ合計
  const files = await buildMurataFiles();
  await page.locator('#supplier-file').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.bytes),
    })),
  );
  await page.getByRole('button', { name: '解析する' }).click();
  await expect(page.getByText(/解析結果: 20 ファイル・明細 240 行/)).toBeVisible({
    timeout: 120_000,
  });
  for (const label of ['梱包用副資材一式（上期）', '梱包用副資材一式（下期）'] as const) {
    const row = page.locator('tr', { hasText: label }).first();
    await row.getByRole('combobox').selectOption('EF-PUR-PACK');
    await row.getByRole('checkbox').check();
  }
  await page.getByRole('button', { name: 'チェックした行を確定する' }).click();
  await page.waitForURL(/flash=supplierImported/, { timeout: 120_000 });
  await expect(page.getByText('6,760.3').first()).toBeVisible();
});
