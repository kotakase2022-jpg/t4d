import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * Scope3 Cat.1 のサプライヤー内訳の可視化と、サプライヤーデータ取込。
 *
 * Demo Mode の状態はテスト間で共有されるため、取込の対象は
 * 他のテストが触らない SUP-06 / SUP-07（Fixture では未提出）に限定する。
 * このファイル内の順序に依存する（可視化 → テンプレート → 取込 → 反映の確認）。
 * テンプレートの行内容は取込で変わるため、テンプレート検証は取込より先に置く。
 */

test.describe.configure({ mode: 'serial' });

test('GHG 画面にサプライヤー内訳（提出状況・構成比・一次データ比率）が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await expect(
    page.getByRole('heading', { name: 'Scope3 Category 1 サプライヤー内訳（一次データ）' }),
  ).toBeVisible();

  // 提出済みの社は構成比付きで並ぶ（Fixture: 常盤精密工業 18.0 / 53.3 ≒ 33.8%）
  const tokiwa = page.locator('tr', { hasText: '常盤精密工業' }).first();
  await expect(tokiwa.getByText('提出済み')).toBeVisible();
  await expect(tokiwa.getByText(/33\.\d%/)).toBeVisible();

  // 未提出の社は不足データとして見え、取込への導線を持つ
  const missing = page.locator('tr', { hasText: '若草金属工業' }).first();
  await expect(missing.getByText('未提出')).toBeVisible();
  await expect(missing.getByRole('link', { name: 'サプライヤーデータ取込へ' })).toBeVisible();

  // 一次データ比率（確定値 50,620.5 に対する 53.3）を数値で併記する
  await expect(page.getByText('確定値に占める一次データ比率')).toBeVisible();
  await expect(page.getByText('残りは購買金額ベースの推計')).toBeVisible();
});

test('CSV テンプレートがダウンロードでき、未提出の社が行に並ぶ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  // 左メニュー: 現在地はサプライヤーデータ取込だけ（算定サマリーが同時に光らない）
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await expect(
    nav.getByRole('link', { name: 'サプライヤーデータ取込', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: '算定サマリー', exact: true })).not.toHaveAttribute(
    'aria-current',
    'page',
  );

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV テンプレート' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('サプライヤーデータ取込テンプレート');
  expect(download.suggestedFilename()).toContain('.csv');

  // 未提出の SUP-06 / SUP-07 が記入行として先に並ぶ（取込テストより前に検証する）
  const body = fs.readFileSync((await download.path())!, 'utf8');
  expect(body).toContain('SUP-06');
  expect(body).toContain('SUP-07');
  expect(body).toContain('記入例');
});

test('サプライヤー CSV を取り込むと、未提出の社が提出済みへ変わる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');
  await expect(page.getByRole('heading', { name: 'サプライヤーデータ取込' })).toBeVisible();

  // 取込前: SUP-06 / SUP-07 は未提出
  const statusTable = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: /サプライヤー別の提出状況/ }),
  });
  await expect(
    statusTable.locator('tr', { hasText: '若草金属工業' }).getByText('未提出'),
  ).toBeVisible();

  // CSV を選んで解析（規則ベース・AI 不使用）
  await page
    .locator('#supplier-file')
    .setInputFiles(path.join(__dirname, 'fixtures', 'supplier-purchases-fy2026.csv'));
  await page.getByRole('button', { name: '解析する' }).click();

  // プレビュー: 排出量が計算され、新規のバッジが付く（12,400 千円 × 0.00063 = 7.8）
  const previewRow = page.locator('tr', { hasText: '若草金属工業' }).filter({
    has: page.locator('input[type="checkbox"]'),
  });
  await expect(previewRow).toBeVisible();
  await expect(previewRow.getByText('7.8')).toBeVisible();
  await expect(previewRow.getByText('新規')).toBeVisible();

  // 確定 → flash で結果が伝わる
  await page.getByRole('button', { name: 'チェックした行を確定する' }).click();
  await page.waitForURL(/flash=supplierImported/);
  await expect(page.getByText(/サプライヤーデータを取り込み/)).toBeVisible();

  // 提出状況が更新される
  await expect(
    page.locator('tr', { hasText: '若草金属工業' }).first().getByText('提出済み'),
  ).toBeVisible();

  // GHG 画面の内訳にも反映される（53.3 + 7.8 + 2.0 = 63.1）
  await page.goto('/enterprise/ghg');
  const imported = page.locator('tr', { hasText: '若草金属工業' }).first();
  await expect(imported.getByText('提出済み')).toBeVisible();
  await expect(page.getByText('63.1').first()).toBeVisible();
});
