import { expect, test, type Page } from '@playwright/test';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { DEMO_USERS, loginAs, switchDemoRole } from './helpers';

/**
 * 原稿の自動保存した本文が、画面を離れて戻ったときに別のサーバーへ届いても消えない
 * （状態がリクエストごとに消えるサーバーでだけ流す。playwright.stateless.config.ts）。
 *
 * デモ環境（Vercel）では自動保存の作業本文をサーバーのメモリにしか置かず、Cookie でも持ち回さない。
 * 別のサーバーでは作業本文が無く、以前は現在の版の本文から始まり、利用者の入力が消えたように見えた。
 * 画面はこのタブに控えた自動保存の本文を戻し、戻したことを示す（block-editor.tsx）。
 * 控えは、作業本文を最後に自動保存したのが本人だとサーバーが示すときだけ戻す（リセット後に古い入力を戻さない）。
 *
 * ファイル名を *.spec.ts にしないのは、通常の E2E（1 つのサーバーがメモリを持ち続ける）では作業本文が
 * サーバーに残り、この経路を通らないため（サーバーに作業本文が残ると、後の spec の原稿の初期状態も変わる）。
 * この構成では状態が Cookie にしか無く、テストごとに新しいブラウザの文脈で始まるため、各テストの操作
 * （開示優先モードの切替・リセットを含む）は後のテストへ残らない。
 */

const BLOCK_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2026}/blocks/${IDS.blocks.fy2026RiskOpportunity.block}`;
const TYPED = 'E2E: 別のサーバーでも消えない自動保存の本文（架空）';

const editorBody = (page: Page) => page.getByRole('region', { name: '本文' });
const restoredNotice = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'このタブに残っていた自動保存の本文' });

async function paragraphValues(page: Page): Promise<string[]> {
  return editorBody(page)
    .locator('textarea')
    .evaluateAll((elements) => elements.map((e) => (e as HTMLTextAreaElement).value));
}

async function typeNewParagraph(page: Page, text: string): Promise<void> {
  const inputs = editorBody(page).locator('textarea');
  const before = await inputs.count();
  await editorBody(page).getByRole('button', { name: '末尾に段落を追加' }).click();
  // 足した段落へフォーカスが移ってから打つ（移る前に打つと先頭の文字が別の場所へ入る）
  await expect(inputs).toHaveCount(before + 1);
  const added = await inputs.last().getAttribute('id');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe(added);
  await page.keyboard.type(text);
  await expect(inputs.last()).toHaveValue(text);
  await expect(page.getByText(/^保存済み/)).toBeVisible();
}

test('自動保存した本文は、画面を離れて別のサーバーに届いてもこのタブから戻る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();

  await typeNewParagraph(page, TYPED);

  // 別の画面へ移って戻る（リクエストごとに新しいサーバーなので、作業本文はサーバーに無い）
  await page.goto('/enterprise/disclosure-projects');
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();
  await expect(restoredNotice(page)).toBeVisible();
  await expect(editorBody(page).locator('textarea').last()).toHaveValue(TYPED);
  // 戻した本文はこのサーバーへ自動保存し直す
  await expect(page.getByText(/^保存済み/)).toBeVisible();
});

test('AI 候補を採用した本文も、画面を離れて別のサーバーに届いたときにこのタブから戻る（採用前の本文で上書きしない）', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();
  // 採用の前に入力して自動保存する（タブの控えは採用前の本文になる）
  await typeNewParagraph(page, TYPED);

  // 根拠を 1 つ選び、AI 下書き（Mock）の候補をすべて採用する
  const pane = page.getByRole('complementary', { name: '根拠パネル' });
  await pane.getByRole('tab', { name: '根拠資料' }).click();
  await pane
    .getByRole('checkbox', { name: /を AI の根拠に使う$/ })
    .first()
    .check();
  await editorBody(page).getByRole('button', { name: '選択した根拠から下書き' }).click();
  await expect(editorBody(page).getByText('本文の候補（差分プレビュー）')).toBeVisible();
  const before = await paragraphValues(page);
  await editorBody(page).getByRole('button', { name: 'すべて採用' }).click();
  await expect
    .poll(async () => (await paragraphValues(page)).length)
    .toBeGreaterThan(before.length);
  const adopted = await paragraphValues(page);
  expect(adopted).toContain(TYPED);

  // 別の画面へ移って戻る。採用した段落を含む本文が戻る（採用前の控えで上書きしない）
  await page.goto('/enterprise/disclosure-projects');
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();
  await expect(restoredNotice(page)).toBeVisible();
  await expect.poll(() => paragraphValues(page)).toEqual(adopted);
  await expect(page.getByText(/^保存済み/)).toBeVisible();
});

test('開示デモのリセットの後は、リセット前に入力した本文をこのタブから戻さない', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // リセットは開示優先モードのホームにある（管理者が有効にする）
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await page.getByLabel('有効にする').check();
  await page
    .locator('form')
    .filter({ has: page.getByRole('group', { name: '開示優先モード' }) })
    .getByRole('button', { name: '保存' })
    .click();
  await page.waitForURL(/flash=disclosureFirstChanged&state=on/);

  // 発表者がリハーサルで入力し（版にはしない）、同じタブで開示デモをリセットする
  await switchDemoRole(page, DEMO_USERS.sustainability);
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();
  await typeNewParagraph(page, TYPED);
  await page.goto('/enterprise/dashboard');
  await page.getByLabel('上記の範囲だけを初期状態へ戻すことを確認しました').check();
  await page.getByRole('button', { name: '開示デモを初期状態に戻す' }).click();
  await page.waitForURL(/flash=disclosureDemoReset/);

  // タブにはリハーサルの入力の控えが残っている（リセットはサーバーと Cookie だけを戻す）
  expect(await draftKeys(page)).not.toHaveLength(0);

  // 開き直すと初期状態（版 1）の本文のまま。画面は控えを戻さずに消す（消えたことで、戻すかどうかの
  // 判断が済んだと分かる）。リハーサルの入力を戻して自動保存し直さない
  await page.goto(BLOCK_PATH);
  await expect(editorBody(page)).toBeVisible();
  await expect.poll(() => draftKeys(page)).toHaveLength(0);
  await expect(restoredNotice(page)).toHaveCount(0);
  expect(await paragraphValues(page)).not.toContain(TYPED);
});

/** このタブに残っている作業本文の控え（sessionStorage のキー） */
async function draftKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('t4d.block-draft:')),
  );
}
