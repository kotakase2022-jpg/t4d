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

  await dropFiles(page, [{ name: '写真.png', type: 'image/png', content: 'PNG' }]);

  // エラー画面へ飛ばさず、フォームの中で理由を伝える
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('写真.png');
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

test('タブ区切りの .txt は表として取り込まれる', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 6000 + (Date.now() % 900);
  await dropFiles(page, [
    {
      name: `実績-${marker}.txt`,
      type: 'text/plain',
      content: ['拠点\t項目\t値\t単位\t期間', `本社\t電力使用量\t${marker}\tMWh\tFY2026`].join(
        '\r\n',
      ),
    },
  ]);

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();
});

test('自由記述の .txt は資料として取り込み、数値の行にはしない', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await dropFiles(page, [
    {
      name: 'サステナビリティ委員会議事録.txt',
      type: 'text/plain',
      content: [
        'サステナビリティ委員会 議事録',
        '気候関連リスクの評価方法について審議した。',
        '取締役会への報告は四半期ごととする。',
      ].join('\n'),
    },
  ]);

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });
  // エラーにはせず、資料として扱った旨を伝える
  await expect(page.getByText(/資料として取り込みました/).first()).toBeVisible();
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});

test('自由記述の .txt は根拠資料の画面で中身を読める', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const name = `温室効果ガス算定手順書-${Date.now() % 10000}.txt`;
  await dropFiles(page, [
    {
      name,
      type: 'text/plain',
      content: [
        '温室効果ガス算定手順書',
        '第3条 Scope1 の算定範囲は、当社が所有または支配する設備からの直接排出とする。',
        '第4条 排出係数は環境省の公表値を用いる。',
      ].join('\n'),
    },
  ]);

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });

  await page.goto('/enterprise/evidence');
  const row = page.locator('#t4d-main tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: '画面内で開く' }).click();
  await page.waitForURL(/\/enterprise\/evidence\/[0-9a-f-]+/, { timeout: 30_000 });

  // 「この形式は画面内表示に対応していません」で終わらせない
  await expect(page.getByText('Scope1 の算定範囲')).toBeVisible();
  await expect(page.getByText('この形式は画面内表示に対応していません')).toHaveCount(0);
});
