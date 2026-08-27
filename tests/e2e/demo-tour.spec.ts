import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * デモモード（機能追加要望 ③）。
 *
 * 話の軸は SSBJ 対応。機能を並べるのではなく、
 *   現在地 → 何が足りないか → 誰がいつまでに何をするか → データをどう集めるか
 *   → 根拠と承認をどう残すか → 他の開示にも使い回せる
 * という 1 本の仕事を追う構成になっていることを確かめる。
 */

test.describe.configure({ mode: 'serial' });

const TOTAL_STEPS = 12;

test('デモモードは SSBJ 対応の現在地から始まり、要求事項へ進む', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // サイドバー最下部のボタンから開始（最初のステップ = ホーム）
  await page.getByRole('button', { name: 'デモモード' }).click();
  await page.waitForURL(/\/enterprise\/dashboard/);

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`1 / ${TOTAL_STEPS}`);
  await expect(dialog).toContainText('SSBJ 対応の現在地');
  await expect(dialog).toContainText('見どころ');

  // 2 番目で SSBJ 対応状況へ入り、SSBJ の 8 段階のどこかが示される
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj$/);
  await expect(dialog).toContainText(`2 / ${TOTAL_STEPS}`);
  await expect(dialog).toContainText('単一の点数にまとめない');
  await expect(dialog).toContainText('手順');

  // 3 番目で要求事項一覧へ
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements/);
  await expect(dialog).toContainText(`3 / ${TOTAL_STEPS}`);
  await expect(dialog).toContainText('対象判定・重要性判断');

  // 戻る → SSBJ 対応状況へ戻る
  await dialog.getByRole('button', { name: '戻る' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj$/);
  await expect(dialog).toContainText(`2 / ${TOTAL_STEPS}`);
});

test('ギャップ分析の画面へ直行し、人工知能が確定しないことを案内する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();
  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();

  // 4 番目 = 最優先のギャップの詳細画面へ飛ぶ。
  // 遷移の完了を待たずに連打すると、前の遷移の途中で次が始まって取りこぼす
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj$/);
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements$/);
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);
  await expect(dialog).toContainText(`4 / ${TOTAL_STEPS}`);
  await expect(dialog).toContainText('ギャップ分析');

  // 実際にギャップ分析の画面が出ている
  const main = page.locator('#t4d-main');
  await expect(main.getByText('開示ギャップ')).toBeVisible();
  await expect(main.getByText('データギャップ')).toBeVisible();

  // 5 番目は同じ画面のまま「人工知能は確定しない」を案内する
  await dialog.getByRole('button', { name: '次へ' }).click();
  await expect(dialog).toContainText(`5 / ${TOTAL_STEPS}`);
  await expect(dialog).toContainText('人工知能は確定しない');
  await expect(main.getByText('担当者による確認')).toBeVisible();
});

test('対応計画・データ収集まで一巡し、「ツアーを終了」で閉じられる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();

  // 6 番目 = 対応計画。各ステップの遷移を待ってから次へ進む
  const advance = async (expected: RegExp) => {
    await dialog.getByRole('button', { name: '次へ' }).click();
    await page.waitForURL(expected);
  };
  await advance(/\/enterprise\/disclosures\/ssbj$/);
  await advance(/\/enterprise\/disclosures\/ssbj\/requirements$/);
  await advance(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);
  // 5 番目は同じ画面のまま案内だけ切り替わる
  await dialog.getByRole('button', { name: '次へ' }).click();
  await expect(dialog).toContainText(`5 / ${TOTAL_STEPS}`);
  await advance(/\/enterprise\/disclosures\/ssbj\/plans/);
  await expect(dialog).toContainText('対応計画の作成');

  // 7 番目 = データ収集
  await advance(/\/enterprise\/disclosures\/ssbj\/collection/);
  await expect(dialog).toContainText('ギャップから収集依頼までつながる');

  // 最後まで進む
  await advance(/\/enterprise\/imports/);
  await advance(/\/enterprise\/data/);
  await advance(/\/enterprise\/evidence/);
  await advance(/\/enterprise\/disclosures\/cdp/);
  await advance(/\/enterprise\/workflows/);
  await expect(dialog).toContainText(`${TOTAL_STEPS} / ${TOTAL_STEPS}`);

  await dialog.getByRole('button', { name: 'ツアーを終了' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);
});

test('Escape とツアー中の × でいつでも終了できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);

  // × ボタンでも終了できる
  await page.getByRole('button', { name: 'デモモード' }).click();
  await page.getByRole('button', { name: 'デモモードを終了' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);
});

test('監査法人ワークスペースにはデモモードボタンが出ない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'デモモード' })).toHaveCount(0);
});

test('ホームの SSBJ カードから、未対応の要求事項へ直行できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  const main = page.locator('#t4d-main');

  await expect(main.getByText('SSBJ 対応度')).toBeVisible();
  await main.getByText('SSBJ 未対応').click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\?/);
  // 未対応・未確認だけに絞り込まれている
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
});
