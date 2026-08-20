import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 2026-08-19 の追加要望 6 点の実ブラウザ検証。
 * ①（人的資本データの取込）は integration 側で 20 ファイルを通しているため、
 * ここでは画面から見える ②〜⑥ を確認する。
 */

test.describe.configure({ mode: 'serial' });

test('② 非財務データの組織タグに「連結対象のみ」があり、持分法適用の組織が外れる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const body = page.locator('tbody');
  const jvTag = page.getByRole('button', { name: '青海マテリアル合弁会社', exact: true });
  const consolidatedTag = page.getByRole('button', { name: '連結対象のみ', exact: true });

  // タグが組織フィルタに並んでいる
  await expect(consolidatedTag).toBeVisible();

  // 持分法適用の組織だけを選ぶと、その行が実際に存在する
  await jvTag.click();
  await page.waitForLoadState('networkidle');
  await expect(body.getByText('青海マテリアル合弁会社').first()).toBeVisible();

  // そこへ「連結対象のみ」を重ねると 0 件になる（連結対象ではないため）
  await consolidatedTag.click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('該当するデータがありません')).toBeVisible();

  // 「連結対象のみ」だけにすると、連結対象の組織は出て、持分法適用の組織は出ない
  await jvTag.click();
  await page.waitForLoadState('networkidle');
  await expect(body.getByText('青海マテリアル合弁会社')).toHaveCount(0);
  await expect(body.first()).toBeVisible();
});

test('③ Evidence のプレビューが紙面として表示され、明細と合計が読める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');
  // 先頭行は他テストがアップロードしたファイルになりうるので、Fixture の請求書を名指しで開く
  const row = page.locator('tr', { hasText: '電力請求書' }).first();
  await row.getByRole('link', { name: '画面内で開く' }).click();
  await expect(page).toHaveURL(/\/enterprise\/evidence\/[0-9a-f-]+/);

  // 紙面のヘッダー・明細・合計・フッター
  await expect(page.getByText(/請求番号|交付番号|作成:|対象期間:/).first()).toBeVisible();
  await expect(page.getByText(/合計|ご請求金額|再生利用量/).first()).toBeVisible();
  await expect(page.getByText('架空のサンプル資料')).toBeVisible();
});

test('④ デモモードのポップアップをドラッグで移動できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');

  await page.getByRole('button', { name: 'デモモード' }).click();
  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();

  const before = await dialog.boundingBox();
  expect(before).not.toBeNull();

  // ヘッダー（ドラッグハンドル）を掴んで動かす
  const handle = dialog.getByRole('button', { name: /デモモードの案内を移動/ });
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2 - 160, { steps: 10 });
  await page.mouse.up();

  const after = await dialog.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.x - before!.x), '横に移動していない').toBeGreaterThan(100);
  expect(Math.abs(after!.y - before!.y), '縦に移動していない').toBeGreaterThan(80);
});

test('④ キーボードでもポップアップを移動できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  const handle = dialog.getByRole('button', { name: /デモモードの案内を移動/ });
  const before = (await dialog.boundingBox())!;

  await handle.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');

  const after = (await dialog.boundingBox())!;
  expect(before.x - after.x, '左へ移動していない').toBeGreaterThan(40);
});

test('⑤ CDP がバージョン選択 → 過去データ取込 → 一覧の順に案内される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 3 ステップのナビ
  await expect(page.getByText('バージョン（FY）を選ぶ')).toBeVisible();
  await expect(page.getByText('過去データを取り込む')).toBeVisible();
  await expect(page.getByText('新規分・不足分に対応する')).toBeVisible();

  // バージョン切替（過年度の版を選べる）
  await expect(page.getByRole('link', { name: /CDP 2026/ })).toBeVisible();
  const past = page.getByRole('link', { name: /CDP 2025/ });
  await expect(past).toBeVisible();
  await past.click();
  await expect(page).toHaveURL(/version=/);

  // 取込導線
  await expect(page.getByRole('link', { name: '過去回答を取り込む' })).toBeVisible();
});

test('⑥ SSBJ がマテリアリティ登録 → 収集 → 充足度 → 不足一覧の順になる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await expect(page.getByText('マテリアリティを登録する')).toBeVisible();
  await expect(page.getByText('対象データを集める')).toBeVisible();
  await expect(page.getByText('不足項目に対応する')).toBeVisible();

  // 充足度が数値で可視化されている
  await expect(page.getByText('マテリアリティ充足度')).toBeVisible();

  // マテリアリティ評価表があり、重要度と根拠が出ている
  await expect(page.getByText('気候変動（GHG 排出）')).toBeVisible();
  await expect(page.getByText('重要度：高').first()).toBeVisible();

  // 評価を更新できる（重要と評価するなら理由が要る）
  const row = page.locator('tr', { hasText: '水資源の利用' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill('取水量の多い拠点を新設したため重要度を引き上げ');
  await row.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('取水量の多い拠点を新設したため重要度を引き上げ')).toBeVisible();
});
