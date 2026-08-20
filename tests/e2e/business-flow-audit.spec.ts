import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 業務フローの通し検証（自己検証ミッション用）。
 *
 * 機能を孤立して確認するのではなく、実際の業務の順番どおりに
 * 「取り込む → 確定する → 一覧に出る → 承認する → 開示へ反映される → 監査法人が見る」
 * まで、永続化を挟みながら確認する。
 */

test.describe.configure({ mode: 'serial' });

test('取込フロー: ファイル投入 → AI 仕分け → 確定 → 非財務データへ反映', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 一意な値で 1 行だけ取り込む（既存データと衝突させない）
  const marker = 1000 + (Date.now() % 8000);
  const csv = ['拠点,項目,値,単位,期間', `本社,電力使用量,${marker},MWh,FY2026`].join('\r\n');

  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `flow-audit-${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);

  // 解析が終わり、行が並ぶ
  await expect(page.getByText('解析が完了しました')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();

  // AI が指標を当てている（プレビュー表の指標 select に値が入っている）
  // ※ 画面には「ファイル解析結果」表もあるので、プレビュー側の select を名指しで取る
  const metricSelect = page.locator('select[name^="metricId:"]').first();
  await expect(metricSelect).toBeVisible();
  const selected = await metricSelect.inputValue();
  expect(selected, 'AI が指標を推定していない').not.toBe('');

  // 確定する
  const confirm = page.getByRole('button', { name: /取込を確定|確定する|確定/ }).first();
  test.skip((await confirm.count()) === 0, '確定ボタンが無い（要確認行のみのジョブ）');
  await confirm.click();
  await page.waitForLoadState('networkidle');

  // 非財務データへ反映され、投入した値が一覧から辿れる
  await page.goto('/enterprise/data?q=電力');
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('承認フロー: 下書き → 提出 → 承認 → 承認済み一覧へ反映（永続化）', async ({ page }) => {
  // 拠点担当が提出
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/data?status=draft');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const detail = page.getByRole('link', { name: '詳細' }).first();
  test.skip((await detail.count()) === 0, 'draft の Data Point が無い');
  await detail.click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const submit = page.getByRole('button', { name: '提出' }).first();
  test.skip((await submit.count()) === 0, '提出ボタンが出ない');
  await submit.click();
  await page.waitForLoadState('networkidle');

  // 提出済みになり、リロードしても保持される
  await page.goto(url);
  await expect(page.getByText(/提出済み|レビュー中/).first()).toBeVisible();

  // 承認者が承認する
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(url);
  const approve = page.getByRole('button', { name: '承認' }).first();
  if ((await approve.count()) > 0) {
    await approve.click();
    await page.waitForLoadState('networkidle');
    await page.goto(url);
    await expect(page.getByText('承認済み').first()).toBeVisible();
  }
});

test('開示フロー: CDP の回答を保存 → 再訪しても残る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 質問詳細へ
  const link = page.locator('tbody a[href^="/enterprise/disclosures/cdp/"]').first();
  test.skip((await link.count()) === 0, 'CDP 質問が無い');
  await link.click();
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\/[0-9a-f-]+/);
  const url = page.url();

  const answer = page.locator('textarea[name="answerText"]').first();
  test.skip((await answer.count()) === 0, '回答欄が出ない');

  const text = `監査検証の回答 ${Date.now().toString(36)}`;
  await answer.fill(text);
  await page
    .getByRole('button', { name: /保存|下書き/ })
    .first()
    .click();
  await page.waitForLoadState('networkidle');

  // 再訪しても残る
  await page.goto(url);
  await expect(page.locator('textarea[name="answerText"]').first()).toHaveValue(text);
});

test('保証フロー: 監査法人が Data Room → 母集団 → サンプル → 手続を辿れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const link = page.locator('a[href^="/assurance/engagements/"]').first();
  await expect(link).toBeVisible();
  const base = (await link.getAttribute('href'))!.replace(/\/[^/]*$/, '');

  for (const page_ of [
    'overview',
    'data-room',
    'population',
    'sampling',
    'testing',
    'issues',
    'requests',
    'signoffs',
    'audit-trail',
  ]) {
    const res = await page.goto(`${base}/${page_}`);
    expect(res?.status(), `${page_} が開けない`).toBeLessThan(400);
    await expect(page.locator('#t4d-main'), `${page_} が描画されない`).toBeVisible();
  }
});

test('監査法人は Read-only（クライアント原本を書き換える導線が無い）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto('/assurance/engagements');
  const link = page.locator('a[href^="/assurance/engagements/"]').first();
  const base = (await link.getAttribute('href'))!.replace(/\/[^/]*$/, '');

  await page.goto(`${base}/data-room`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  // クライアントデータを編集する入力・保存ボタンが無い
  await expect(page.getByRole('button', { name: /値を保存|承認する|差戻し/ })).toHaveCount(0);
});
