import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 50 ファイルの一括取込。
 * 「事前加工なしで 50 ファイルをまとめて投入し、AI が仕分ける」が要求仕様。
 *
 * **ファイル名を zz- で始めているのは、最後に実行させるため。**
 * Demo Mode の状態はプロセスで共有されるので、50 ファイルを投入すると
 * Evidence 一覧などの並びが変わり、先に固定データを見るテストが落ちる。
 */
test('50 ファイルを一括投入して、プレビューまで到達する', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHeterogeneousDataset();
  const files = dataset.map((f) => ({
    name: f.name,
    mimeType: f.mimeType,
    buffer: Buffer.from(f.bytes),
  }));
  expect(files.length, 'データセットが 50 ファイル').toBeGreaterThanOrEqual(50);

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const started = Date.now();
  await page.locator('input[name="files"]').setInputFiles(files);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  const count = await rows.count();
  console.log(`50 ファイル取込: 行数=${count} 所要=${Math.round((Date.now() - started) / 1000)}s`);
  expect(count, '取込行が 1 件も出ていない').toBeGreaterThan(50);
});

test('50 ファイルの取込を確定でき、非財務データへ反映される', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHeterogeneousDataset();
  const files = dataset.slice(0, 50).map((f) => ({
    name: f.name,
    mimeType: f.mimeType,
    buffer: Buffer.from(f.bytes),
  }));

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await page.locator('input[name="files"]').setInputFiles(files);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });

  await page.getByRole('button', { name: '選択した行を確定' }).click();
  await page.waitForURL(/\/enterprise\/data/, { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText('取込内容を確定');
});

test('51 ファイル以上は理由付きで断る', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHeterogeneousDataset();
  const files = [...dataset, ...dataset.slice(0, 1)].map((f, i) => ({
    name: `${i}_${f.name}`,
    mimeType: f.mimeType,
    buffer: Buffer.from(f.bytes),
  }));
  expect(files.length).toBeGreaterThan(50);

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await page.locator('input[name="files"]').setInputFiles(files);
  await page.getByRole('button', { name: '取込を開始' }).click();

  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('50 ファイルまで');
});
