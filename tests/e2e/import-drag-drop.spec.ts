import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * データ収集のドラッグ&ドロップ。
 *
 * 既存の取込テストは `setInputFiles` で file input へ直接入れており、
 * **ドロップの経路は一度も通っていなかった**。画面が「ここへドロップ」と
 * 案内している以上、その経路で最後まで取り込めることを確かめる。
 */

/** 実ブラウザのドロップを再現する（DataTransfer にファイルを載せて drop を投げる） */
async function dropFiles(
  page: import('@playwright/test').Page,
  files: Array<{ name: string; type: string; content: string }>,
) {
  const dataTransfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      dt.items.add(new File(['﻿' + item.content], item.name, { type: item.type }));
    }
    return dt;
  }, files);

  const zone = page.locator('label[for="import-files"]');
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });
}

test('ドロップしたファイルがそのまま取り込まれ、プレビューまで進む', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 4000 + (Date.now() % 4000);
  await dropFiles(page, [
    {
      name: `drop-${marker}.csv`,
      type: 'text/csv',
      content: ['拠点,項目,値,単位,期間', `本社,電力使用量,${marker},MWh,FY2026`].join('\r\n'),
    },
  ]);

  // ドロップした時点で、何を取り込もうとしているかが画面に出る
  await expect(page.getByText(`drop-${marker}.csv`)).toBeVisible();

  // そのまま解析が始まり、プレビューへ進む
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();
});

test('複数ファイルをまとめてドロップできる', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 8000 + (Date.now() % 1000);
  await dropFiles(page, [
    {
      name: `drop-a-${marker}.csv`,
      type: 'text/csv',
      content: ['拠点,項目,値,単位,期間', `本社,電力使用量,${marker},MWh,FY2026`].join('\r\n'),
    },
    {
      name: `drop-b-${marker}.csv`,
      type: 'text/csv',
      content: ['拠点,項目,値,単位,期間', `東日本工場,取水量,${marker},m3,FY2026`].join('\r\n'),
    },
  ]);

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });
  // 2 ファイルとも解析されている
  await expect(page.getByText(`drop-a-${marker}.csv`).first()).toBeVisible();
  await expect(page.getByText(`drop-b-${marker}.csv`).first()).toBeVisible();
});

test('クリックで選んだ場合も、選択したファイル名が画面に出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const marker = 2000 + (Date.now() % 1000);
  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `picked-${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿拠点,項目,値,単位,期間\r\n本社,電力使用量,10,MWh,FY2026', 'utf8'),
  });

  await expect(page.getByText(`picked-${marker}.csv`)).toBeVisible();
});

test('取り込めないファイルをドロップしたら、理由とファイル名を画面に出す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await dropFiles(page, [
    { name: '議事録.txt', type: 'text/plain', content: '取り込めない形式のファイル' },
  ]);

  // エラー画面へ飛ばさず、フォームの中で理由を伝える
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('議事録.txt');
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('拡張子');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  // 取込画面に留まる（プレビューへ進まない）
  await expect(page).toHaveURL(/\/enterprise\/imports$/);
});

test('取り込めるファイルと取り込めないファイルが混ざっていたら、どれが駄目かを名指しする', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await dropFiles(page, [
    {
      name: '実績.csv',
      type: 'text/csv',
      content: '拠点,項目,値,単位,期間\r\n本社,電力使用量,10,MWh,FY2026',
    },
    { name: '写真.png', type: 'image/png', content: 'PNG' },
  ]);

  const alert = page.locator('#t4d-main').getByRole('alert');
  await expect(alert).toContainText('写真.png');
  await expect(alert, '取り込めるファイルまで拒否されたように書かない').not.toContainText(
    '実績.csv',
  );
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});
