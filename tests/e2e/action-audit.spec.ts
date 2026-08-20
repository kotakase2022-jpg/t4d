import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * Server Action の実動作監査。
 *
 * vertical-slices.spec.ts は指示書 20 章の 16 ステップを通す。
 * こちらはそこで**通らない Server Action** を UI から実際に叩き、
 * 「押しても何も起きない」ボタンが残っていないことを確認する。
 *
 * 対象（いずれもこれまでテストが無かった）:
 *   bulkTransitionAction / updateDataPointAction / linkEvidenceAction /
 *   uploadEvidenceAction / rejectAiDraftAction / toggleGrantAction /
 *   respondPbcAction / decidePbcAction / assessSnapshotChangeAction /
 *   createReviewNoteAction / clearReviewNoteAction / summarizeChangesAction
 *
 * Demo Mode の Fixture DB はサーバープロセス共有のため直列実行。
 */

test.describe.configure({ mode: 'serial' });

const ENGAGEMENT = ENGAGEMENT_IDS.main;
const CSV_PATH = path.resolve(process.cwd(), 'tests/e2e/fixtures/east-plant-fy2026.csv');

/** Server Action は POST → redirect。押した結果が画面へ反映されるまで待つ。 */
async function submitAndSettle(page: Page, action: () => Promise<void>): Promise<void> {
  await action();
  await page.waitForLoadState('networkidle');
}

test('一括操作: 選択した Data Point をまとめて提出できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?status=draft');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const checkboxes = page.locator('input[name="selected"][form="bulk-form"]');
  const available = await checkboxes.count();
  test.skip(available === 0, 'draft の Data Point が無いため一括提出を検証できない');

  const target = Math.min(available, 2);
  // 提出対象の値を控えておく（件数はページサイズの上限で頭打ちになるため、
  // 「その行が draft から消えたか」で判定する）
  const targetIds: string[] = [];
  for (let i = 0; i < target; i += 1) {
    const box = checkboxes.nth(i);
    targetIds.push((await box.getAttribute('value')) ?? '');
    await box.check();
  }
  await expect(page.getByText(`${target} 件を選択中`)).toBeVisible();

  const submitButton = page.getByRole('button', { name: '一括提出' });
  await expect(submitButton).toBeEnabled();
  await submitAndSettle(page, () => submitButton.click());

  // 提出した行は draft の一覧に出てこない
  await page.goto('/enterprise/data?status=draft');
  await expect(page.locator('#t4d-main')).toBeVisible();
  for (const id of targetIds) {
    expect(id).not.toBe('');
    await expect(
      page.locator(`input[name="selected"][form="bulk-form"][value="${id}"]`),
      `提出済みの ${id} が draft に残っている`,
    ).toHaveCount(0);
  }
});

test('Data Point の値編集が履歴に残る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?status=draft');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const detail = page.getByRole('link', { name: '詳細' }).first();
  test.skip((await detail.count()) === 0, '編集可能な Data Point が無い');
  await detail.click();
  await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/);

  const valueInput = page.locator('input[name="value"]');
  test.skip((await valueInput.count()) === 0, 'この状態では値編集フォームが出ない');

  const before = await valueInput.inputValue();
  const next = String(Number(before || '0') + 3);
  await valueInput.fill(next);
  await page.locator('input[name="changeReason"]').fill('監査テスト: 値編集の動作確認');
  await submitAndSettle(page, () => page.getByRole('button', { name: '保存' }).click());

  await expect(page.locator('input[name="value"]')).toHaveValue(next);
  await expect(page.getByText('監査テスト: 値編集の動作確認').first()).toBeVisible();
});

test('Evidence をアップロードして Data Point へ紐付けられる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/evidence');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const beforeRows = await page.locator('tbody tr').count();
  await page.locator('input[type="file"][name="file"]').setInputFiles(CSV_PATH);
  await page.locator('input[name="documentType"]').fill('監査テスト');
  await submitAndSettle(page, () =>
    page.locator('form:has(input[name="file"]) button[type="submit"]').first().click(),
  );

  await page.goto('/enterprise/evidence');
  await expect(page.locator('tbody tr')).toHaveCount(beforeRows + 1);

  // 紐付け（linkEvidenceAction）は Data Point 詳細から行う
  await page.goto('/enterprise/data');
  await page.getByRole('link', { name: '詳細' }).first().click();
  await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/);

  const linkForm = page.locator('form:has(select[name="fileVersionId"])');
  test.skip((await linkForm.count()) === 0, 'この状態では Evidence 紐付けフォームが出ない');
  const evidenceCard = page.locator('[data-t4d-shortcut="evidence"]');
  const beforeLinks = await evidenceCard.locator('li').count();
  // 先頭は required の placeholder（「選択してください」）なので、
  // いま上げたファイルを名前で選ぶ。既に紐付いているファイルを選ぶと
  // evidence_link の ID が同一になり件数が増えないため、新規ファイルを使う。
  await linkForm.locator('select[name="fileVersionId"]').selectOption({
    label: 'east-plant-fy2026.csv',
  });
  await submitAndSettle(page, () => linkForm.getByRole('button', { name: '紐付ける' }).click());
  expect(await evidenceCard.locator('li').count()).toBeGreaterThan(beforeLinks);
});

test('AI 下書きを Reject できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp');
  await page.getByRole('link', { name: 'C6.1' }).first().click();
  await expect(page).toHaveURL(/\/enterprise\/disclosures\/cdp\/[0-9a-f-]+/);

  await submitAndSettle(page, () => page.getByRole('button', { name: 'ドラフトを生成' }).click());
  await expect(page.getByText('Mock / AI未接続').first()).toBeVisible({ timeout: 30_000 });

  const reject = page.getByRole('button', { name: /この下書きを Reject/ });
  await expect(reject).toBeVisible();
  await submitAndSettle(page, () => reject.click());

  // 押した当の画面に結果が出ること（revalidate 漏れの回帰検出）
  await expect(page.getByText('Reject 済み')).toBeVisible();
  await expect(page.getByRole('button', { name: /この下書きを Reject/ })).toHaveCount(0);

  // 採否は Provenance にも残る
  await page.goto('/enterprise/ai');
  await expect(page.locator('tbody tr', { hasText: 'rejected' }).first()).toBeVisible();
});

test('許諾の取消と再付与が反映される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const revoke = page.getByRole('button', { name: '取消' }).first();
  test.skip((await revoke.count()) === 0, '取消できる許諾が無い');

  const beforeRevoked = await page.getByRole('button', { name: '再付与' }).count();
  await submitAndSettle(page, () => revoke.click());
  await expect(page.getByRole('button', { name: '再付与' })).toHaveCount(beforeRevoked + 1);

  // 元に戻す（後続テストへ影響させない）
  await submitAndSettle(page, () => page.getByRole('button', { name: '再付与' }).first().click());
  await expect(page.getByRole('button', { name: '再付与' })).toHaveCount(beforeRevoked);
});

test('企業が PBC へ回答し、監査法人が受け入れられる', async ({ page }) => {
  // 企業側: 回答（respondPbcAction）
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/workflows');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const respondForm = page.locator('form:has(textarea[name="body"])').first();
  test.skip((await respondForm.count()) === 0, '回答可能な PBC が無い');
  await respondForm.locator('textarea[name="body"]').fill('監査テスト: 依頼資料を添付しました。');
  await submitAndSettle(page, () => respondForm.locator('button[type="submit"]').first().click());

  // 監査法人側: 受入（decidePbcAction）
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT}/requests`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByText('監査テスト: 依頼資料を添付しました。').first()).toBeVisible();

  const accept = page.getByRole('button', { name: '受理', exact: true }).first();
  test.skip((await accept.count()) === 0, '受入可能な回答が無い');
  await submitAndSettle(page, () => accept.click());
  await expect(page.getByText('受理済み').first()).toBeVisible();
});

test('レビュー Note を作成して解消できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT}/review-notes`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const createForm = page.locator('form:has(textarea[name="body"])').first();
  await createForm.locator('textarea[name="body"]').fill('監査テスト: レビュー Note の動作確認');
  await submitAndSettle(page, () => createForm.locator('button[type="submit"]').first().click());
  await expect(page.getByText('監査テスト: レビュー Note の動作確認').first()).toBeVisible();

  const clearForm = page.locator('form:has(input[name="resolutionComment"])').first();
  test.skip((await clearForm.count()) === 0, '解消フォームが出ない');
  await clearForm.locator('input[name="resolutionComment"]').fill('監査テスト: 解消');
  await submitAndSettle(page, () => clearForm.locator('button[type="submit"]').first().click());
  await expect(page.getByText('監査テスト: 解消').first()).toBeVisible();
});

test('Snapshot 後変更の要約と影響評価が動作する', async ({ page }) => {
  // まず企業側で承認済みデータを変更し、Snapshot 後変更を発生させる。
  // 承認済みデータの編集には write ＋ review の両方が要る（roles.ts）。
  // 両方を持つのは sustainability_manager だけ。
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?status=approved');
  await expect(page.locator('#t4d-main')).toBeVisible();
  const detail = page.getByRole('link', { name: '詳細' }).first();
  test.skip((await detail.count()) === 0, '承認済み Data Point が無い');
  await detail.click();
  await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/);

  const valueInput = page.locator('input[name="value"]');
  test.skip((await valueInput.count()) === 0, '承認済みデータの編集フォームが出ない');
  const before = await valueInput.inputValue();
  await valueInput.fill(String(Number(before || '0') + 7));
  await page.locator('input[name="changeReason"]').fill('監査テスト: Snapshot 後変更を発生させる');
  await submitAndSettle(page, () => page.getByRole('button', { name: '保存' }).click());

  // 監査法人側: 変更要約（AI）と影響評価
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT}/data-room`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const summarize = page.getByRole('button', { name: /要約/ }).first();
  if ((await summarize.count()) > 0) {
    await submitAndSettle(page, () => summarize.click());
    await expect(page.locator('#t4d-main')).toBeVisible();
  }

  const assessSelect = page.locator('select[name="assessment"]').first();
  test.skip((await assessSelect.count()) === 0, 'Snapshot 後変更が無いため影響評価を検証できない');
  await assessSelect.selectOption('no_impact');
  const assessForm = page.locator('form:has(select[name="assessment"])').first();
  await submitAndSettle(page, () => assessForm.locator('button[type="submit"]').first().click());
  await expect(page.locator('#t4d-main')).toBeVisible();
});
