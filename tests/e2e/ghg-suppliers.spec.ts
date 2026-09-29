import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildSupplierDemoFiles } from '../../src/lib/fixtures/supplier-demo-files';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * Scope3 Cat.1 のサプライヤー内訳の可視化と、一次データ（素データ）取込。
 *
 * Demo Mode の状態はテスト間で共有されるため、取込の対象は
 * 他のテストが触らない未提出サプライヤー（SUP-06/07、SUP-23/24/27/28/29）に限定する。
 * このファイル内の順序に依存する（可視化 → テンプレート → 旧形式取込 →
 * 素データ取込と原単位の紐づけ → 再紐づけ）。合計値はファイル内で積み上がる。
 */

test.describe.configure({ mode: 'serial' });

test('GHG 画面にサプライヤー内訳（提出状況・構成比・一次データ比率）が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 見出しは「一次データ」から改名（金額×係数の推計を含むため。W0 O6）
  await expect(
    page.getByRole('heading', { name: 'Scope3 Category 1 サプライヤー内訳（算定根拠）' }),
  ).toBeVisible();

  // 提出済みの社は構成比付きで並ぶ（Fixture: 常盤精密工業 18.0 / 143.1 ≒ 12.6%）
  const tokiwa = page.locator('tr', { hasText: '常盤精密工業' }).first();
  await expect(tokiwa.getByText('提出済み')).toBeVisible();
  await expect(tokiwa.getByText(/12\.\d%/)).toBeVisible();

  // 素データの種類が混在する: 物理量（活動量 × 係数）と報告排出量
  const denryoku = page.locator('tr', { hasText: '東雲電力サービス' }).first();
  await expect(denryoku.getByText(/活動量 42,000 kWh/)).toBeVisible();
  const ostsee = page.locator('tr', { hasText: 'Ostsee Metallwerke' }).first();
  await expect(ostsee.getByText(/サプライヤー報告排出量/)).toBeVisible();

  // 未提出の社は不足データとして見え、取込への導線を持つ
  const missing = page.locator('tr', { hasText: '若草金属工業' }).first();
  await expect(missing.getByText('未提出')).toBeVisible();
  await expect(missing.getByRole('link', { name: 'サプライヤーデータ取込へ' })).toBeVisible();

  // 一次データ比率は定義を明示する: （固有 28.8 ＋ 活動量ベース 61.0）÷ 確定値 50,620.5。
  // 金額×係数（推計）は分子に入れない（W0 O6）
  await expect(page.getByText('確定値に占める一次データ比率')).toBeVisible();
  await expect(page.getByText(/金額×係数（推計）は含めない/)).toBeVisible();
});

test('CSV テンプレートがダウンロードでき、未提出の社と 3 種別の記入例が並ぶ', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  // 左メニュー: 現在地は Scope3データ取込 配下の Cat.1（算定サマリーが同時に光らない）
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await expect(nav.getByRole('link', { name: 'Cat.1', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByRole('link', { name: '算定サマリー', exact: true })).not.toHaveAttribute(
    'aria-current',
    'page',
  );

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV テンプレート' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('サプライヤーデータ取込テンプレート');
  expect(download.suggestedFilename()).toContain('.csv');

  // 未提出の SUP-06 / SUP-07 が記入行として並び、種別・単位列と記入例が付く
  const body = fs.readFileSync((await download.path())!, 'utf8');
  expect(body).toContain('SUP-06');
  expect(body).toContain('SUP-07');
  expect(body).toContain('データ種別');
  expect(body).toContain('記入例');
});

test('旧形式（金額のみ）の CSV を取り込むと、未提出の社が提出済みへ変わる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');
  await expect(page.getByRole('heading', { name: 'サプライヤーデータ取込' })).toBeVisible();

  // 取込前: SUP-06 は未提出
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

  // プレビュー: 金額データとして仕訳され、排出量が計算される（12,400 千円 × 0.00063 = 7.8）
  const previewRow = page.locator('tr', { hasText: '若草金属工業' }).filter({
    has: page.locator('input[type="checkbox"]'),
  });
  await expect(previewRow).toBeVisible();
  // exact 指定: 係数名「金属材料（購入金額ベース）」にも「金額」が含まれるため
  await expect(previewRow.getByText('金額', { exact: true })).toBeVisible();
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

  // GHG 画面の内訳にも反映される（143.1 + 7.8 + 2.0 = 152.9）
  await page.goto('/enterprise/ghg');
  const imported = page.locator('tr', { hasText: '若草金属工業' }).first();
  await expect(imported.getByText('提出済み')).toBeVisible();
  await expect(page.getByText('152.9').first()).toBeVisible();
});

test('素データ（独式・物理量/金額混在）を自動仕訳し、原単位を紐づけて確定できる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  // デモ用サンプルファイルの導線がある
  await expect(
    page.getByRole('heading', { name: /デモ用サンプルファイル（多様なフォーマット・言語）/ }),
  ).toBeVisible();

  // サンプルと同じ内容（同一の決定論生成モジュール）をアップロードする
  const activity = buildSupplierDemoFiles().find((f) => f.key === 'activity')!;
  await page.locator('#supplier-file').setInputFiles({
    name: activity.fileName,
    mimeType: activity.mimeType,
    buffer: Buffer.from(activity.content, 'utf8'),
  });
  await page.getByRole('button', { name: '解析する' }).click();

  // kWh は原単位が単位から自動解決される（28,400 kWh × 0.000434 = 12.3）
  const autoRow = page.locator('tr', { hasText: '曙光電機' }).first();
  await expect(autoRow.getByText('物理量')).toBeVisible();
  await expect(autoRow.getByText('単位から一意に決定')).toBeVisible();
  await expect(autoRow.getByText('12.3')).toBeVisible();

  // kg は鋼材・アルミの 2 候補 → 紐づけ待ち。人が選んでチェックする
  const kgRow = page.locator('tr', { hasText: 'ひなた包装' }).first();
  await expect(kgRow.getByText('原単位の紐づけ待ち')).toBeVisible();
  await kgRow.getByRole('combobox').selectOption('EF-STEEL-KG');
  await kgRow.getByRole('checkbox').check();

  // 金額（千円）の行も複数候補 → EF-PUR-METAL を紐づける
  const jpyRow = page.locator('tr', { hasText: 'かささぎ電子材料' }).first();
  // exact 指定: 原単位セレクトの候補名（〜購入金額ベース〜）にも「金額」が含まれるため
  await expect(jpyRow.getByText('金額', { exact: true })).toBeVisible();
  await jpyRow.getByRole('combobox').selectOption('EF-PUR-METAL');
  await jpyRow.getByRole('checkbox').check();

  // 確定（8.0 + 12.3 + 4.8 + 3.1 + 3.3 = 31.5 を追記 → 152.9 + 31.5 = 184.4）
  await page.getByRole('button', { name: 'チェックした行を確定する' }).click();
  await page.waitForURL(/flash=supplierImported/);
  await expect(page.getByText('184.4').first()).toBeVisible();
  await expect(
    page.locator('tr', { hasText: 'ひなた包装' }).first().getByText('提出済み'),
  ).toBeVisible();
});

test('確定済みの素データ行は「原単位の紐づけ状況」から紐づけ直せる（新しい版を追記）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg/suppliers');

  // 紐づけ状況テーブルは固有の列見出し「現在の原単位」でスコープする
  // （見出しを持つ祖先 div でのスコープはページ全体に一致してしまう）
  const mapping = page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: '現在の原単位' }) });
  // 直前のテストで取り込んだ ひなた包装（1,480 kg × 鋼材 0.0021 = 3.1）。
  // セレクトの候補名にも係数名が含まれるため、セル役割で特定する
  const row = mapping.locator('tr', { hasText: 'ひなた包装' }).first();
  await expect(row.getByRole('cell', { name: '鋼材（重量ベース）EF-STEEL-KG' })).toBeVisible();

  // アルミ係数へ紐づけ直す（1,480 kg × 0.009 = 13.3 ／ 合計 184.4 − 3.1 + 13.3 = 194.6）
  await row.getByRole('combobox').selectOption('EF-ALU-KG');
  await row.getByRole('button', { name: '更新' }).click();
  await page.waitForURL(/flash=factorRelinked/);
  await expect(page.getByText(/排出量原単位を紐づけ直し/)).toBeVisible();
  await expect(page.getByText('194.6').first()).toBeVisible();

  const relinked = page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: '現在の原単位' }) })
    .locator('tr', { hasText: 'ひなた包装' })
    .first();
  await expect(
    relinked.getByRole('cell', { name: 'アルミ材（重量ベース）EF-ALU-KG' }),
  ).toBeVisible();
});
