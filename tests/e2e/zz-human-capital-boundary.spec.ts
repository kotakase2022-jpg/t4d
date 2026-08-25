import { expect, test } from '@playwright/test';
import { buildHumanCapitalDataset } from '../../scripts/human-capital-dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 人的資本 20 ファイルの同時取込とバウンダリ差異の検知。
 *
 * zz- で始めているのは最後に実行させるため（Demo Mode の共有状態を汚すので、
 * 固定データを見るテストの後に回す）。
 */
test('20 ファイルを同時取込し、バウンダリ差異が警告としてプレビューに出る', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHumanCapitalDataset();
  expect(dataset).toHaveLength(20);

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await page
    .locator('input[name="files"]')
    .setInputFiles(
      dataset.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) })),
    );
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  expect(await rows.count(), '人事システム出力の深さ（数百行）が出ていない').toBeGreaterThan(300);

  // バウンダリ差異の警告が人へ見える形で出る
  const main = page.locator('#t4d-main');
  await expect(main.getByText(/バウンダリ差異（雇用範囲）/).first()).toBeVisible();
  await expect(main.getByText(/バウンダリ差異（管理職の定義）/).first()).toBeVisible();
  await expect(main.getByText(/バウンダリ差異（期間の基準）/).first()).toBeVisible();
  await expect(main.getByText(/集計範囲を揃えてから確定してください/).first()).toBeVisible();

  // 差異のある行は自動チェックされていない（勝手に確定させない）
  const conflictRow = page.locator('tr', { hasText: 'バウンダリ差異' }).first();
  await expect(conflictRow.locator('input[type="checkbox"]')).not.toBeChecked();
});
