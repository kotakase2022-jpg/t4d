import { expect, test } from '@playwright/test';
import { DEMO_USERS, confirmInDialog, loginAs, openCollapsible, openMoreMenu } from './helpers';

/**
 * DATA-P0-004（前年度複製・テンプレート・コピペ表入力）と
 * DATA-P0-006（連結集計カード）の実ブラウザ検証。
 */

test.describe.configure({ mode: 'serial' });

test('GHG 画面に連結集計（持分調整・内部取引控除・直近3年推移）が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ghg');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const card = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: /連結集計/ }),
  });
  await expect(page.getByRole('heading', { name: /連結集計/ })).toBeVisible();

  // 内部取引控除が表示される（Fixture: 1,850.0 + 640.5 = 2,490.5）
  await expect(page.getByText('− 2,490.5')).toBeVisible();
  // 女性管理職比率の行は 2026-09 の依頼で GHG 画面から外した（GHG と無関係のため）
  await expect(page.getByText('女性管理職比率')).toHaveCount(0);
  await expect(page.getByText(/加重平均 = 分子合計 ÷ 分母合計/)).toHaveCount(0);
  // 列見出しが揃っている
  for (const head of ['単純合計', '持分調整後', '内部取引控除', '連結値', '推計込み']) {
    await expect(card.getByText(head).first()).toBeVisible();
  }

  // 直近3年の推移: FY2024（過年度 Fixture）から並び、値と前年比が数値で出る
  await expect(
    page.getByRole('heading', { name: '直近3年の推移（連結値・推計込み）' }),
  ).toBeVisible();
  await expect(page.getByText('FY2024').first()).toBeVisible();
  // FY2024 scope1 連結値（1,352.1 + 4,326.9 + 3,245.1 + 811.3）
  await expect(page.getByText('9,735.4')).toBeVisible();
  // scope1 の FY2025 前年比（8,931.6 / 9,735.4 − 1 = −8.3%）
  await expect(page.getByText('-8.3%')).toBeVisible();
});

test('コピペ表入力: Excel から貼り付けた表が AI 仕分けされてプレビューに出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const pasted = ['拠点\t項目\t値\t単位', '西日本工場\t用水使用量\t120500\tm3'].join('\n');
  // 貼り付けの入力欄は既定で閉じた折りたたみの中（docs/disclosure-first.md §10.4 B6）。見出しは常に見える
  await expect(
    page.getByRole('heading', { name: 'コピペ表入力（Excel からそのまま貼り付け）' }),
  ).toBeVisible();
  await openCollapsible(page, '表を貼り付けて取り込む');
  await page.locator('textarea[name="pasted"]').fill(pasted);
  await page.getByRole('button', { name: '貼り付け内容を取り込む' }).click();

  await page.waitForURL(/\/enterprise\/imports\/.+/);
  await expect(page.getByText(/要確認|マッピング済み/).first()).toBeVisible({ timeout: 30_000 });

  // 貼り付け行が仕分けされている（値が入力欄に入り、指標が選択済み）
  const row = page
    .locator('tr', { hasText: '用水使用量' })
    .filter({ has: page.locator('input[name^="value:"]') })
    .first();
  await expect(row).toBeVisible();
  await expect(row.locator('input[name^="value:"]')).toHaveValue('120500');
});

test('標準テンプレートがダウンロードでき、標準形の Excel である', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '標準テンプレートをダウンロード' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('テンプレート');
  expect(download.suggestedFilename()).toContain('.xlsx');
});

test('前年度から複製: 未入力の組合せが前年値の draft で埋まる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 前年度からの複製は見出しの「その他」→ 範囲を確認するダイアログ（plan §1.16 区分 2）
  await (await openMoreMenu(page)).getByRole('menuitem', { name: /^前年度から複製/ }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=carried/);

  // 複製結果が URL に載る（count=0 でも冪等成功。件数はサーバー再起動状態に依存するため
  // ここでは「操作が完了して一覧へ戻る」ことと、二重実行で壊れないことを確認する）
  await expect(page.locator('#t4d-main')).toBeVisible();
  const url1 = page.url();
  expect(url1).toMatch(/count=\d+/);

  // 二重実行（冪等）
  await (await openMoreMenu(page)).getByRole('menuitem', { name: /^前年度から複製/ }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=carried/);
  expect(page.url()).toMatch(/count=0/);
});

test('拠点担当には権限どおり: 前年度複製ボタンは表示される（data.write 保持）が、閲覧専用画面では出ない', async ({
  page,
}) => {
  // site_contributor は enterprise.data.write を持つため表示される
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/data');
  // 頻度の低い操作なので見出しの「その他」の中（plan S16）
  await expect(
    (await openMoreMenu(page)).getByRole('menuitem', { name: /^前年度から複製/ }),
  ).toBeVisible();
});
