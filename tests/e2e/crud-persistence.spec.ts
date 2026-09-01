import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * CRUD の永続化とバリデーションの実操作検証（自己検証ミッション用）。
 *
 * 「保存したように見えるが実際は保存されていない」を潰すのが目的なので、
 * 保存 → **リロード** → 値が残っている、まで必ず確認する。
 */

test.describe.configure({ mode: 'serial' });

test('指標マスター: 作成 → 一覧反映 → リロード後も保持 → 編集 → 反映', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const code = `audit_${Date.now().toString(36)}`;
  const name = `監査用指標 ${code}`;

  // Create（ダイアログで入力する）
  await page.getByRole('button', { name: '指標を追加' }).click();
  const dialog = page.getByRole('dialog', { name: '指標マスターを追加' });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="name"]').fill(name);
  await dialog.locator('input[name="unit"]').fill('件');
  await dialog.getByRole('button', { name: '追加する' }).click();
  await page.waitForLoadState('networkidle');

  // 一覧へ反映
  await expect(page.getByText(name).first()).toBeVisible();

  // リロードしても残る（＝永続化されている）
  await page.reload();
  await expect(page.getByText(name).first()).toBeVisible();

  // Update: 名称を変更して保存
  await page.getByRole('button', { name: `${name} を編集` }).click();
  const editDialog = page.getByRole('dialog', { name: '指標マスターを編集' });
  await expect(editDialog).toBeVisible();
  await editDialog.locator('input[name="name"]').fill(`${name}（更新後）`);
  await editDialog.getByRole('button', { name: '更新する' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.getByText(`${name}（更新後）`).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(`${name}（更新後）`).first()).toBeVisible();
});

test('指標マスター: 必須項目と重複コードが弾かれる（不正値でDBを汚さない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  await page.getByRole('button', { name: '指標を追加' }).click();
  const dialog = page.getByRole('dialog', { name: '指標マスターを追加' });
  await expect(dialog).toBeVisible();

  // 必須項目が空なら送信できない（ブラウザの必須検証）
  await dialog.getByRole('button', { name: '追加する' }).click();
  const codeInput = dialog.locator('input[name="code"]');
  const invalid = await codeInput.evaluate((el: HTMLInputElement) => !el.checkValidity());
  expect(invalid, '必須項目が空でも送信できてしまう').toBe(true);

  // 既存コードと重複させるとサーバー側で拒否される
  await codeInput.fill('scope1');
  await dialog.locator('input[name="name"]').fill('重複コード検証');
  await dialog.locator('input[name="unit"]').fill('t');
  await dialog.getByRole('button', { name: '追加する' }).click();
  await page.waitForLoadState('networkidle');

  // 一覧に重複レコードが増えていない
  await page.goto('/enterprise/organizations');
  await expect(page.getByText('重複コード検証')).toHaveCount(0);
});

test('Data Point: 値の編集がDBへ反映され、リロード後も保持される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?status=draft');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const detail = page.getByRole('link', { name: '詳細' }).first();
  test.skip((await detail.count()) === 0, '編集可能な Data Point が無い');
  await detail.click();
  await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const valueInput = page.locator('input[name="value"]');
  test.skip((await valueInput.count()) === 0, 'この状態では値編集フォームが出ない');

  const before = await valueInput.inputValue();
  const next = String(Number(before.replace(/,/g, '') || '0') + 7);
  const reason = `監査検証 ${Date.now().toString(36)}`;

  await valueInput.fill(next);
  await page.locator('input[name="changeReason"]').fill(reason);
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  // 画面に反映される
  await expect(page.locator('input[name="value"]')).toHaveValue(next);

  // **リロードしても保持される**（＝実際に永続化されている）
  await page.goto(url);
  await expect(page.locator('input[name="value"]')).toHaveValue(next);
  // 変更理由が履歴に残る
  await expect(page.getByText(reason).first()).toBeVisible();
});

/** 自由記述でマテリアリティを追加する（区分の提示から 1 つ選ぶ） */
async function addMaterialityViaUi(page: import('@playwright/test').Page, name: string) {
  await page.getByLabel('マテリアリティ名（自由記述）').fill(name);
  // 入力すると区分の候補が提示される。一致する語が無い名前では
  // 最有力が出ないので、利用者として「環境」を明示的に選ぶ
  await expect(page.getByText('区分を選ぶ').first()).toBeVisible();
  await page.getByRole('radio', { name: '区分: 環境' }).check();
  await page.getByRole('button', { name: 'マテリアリティを追加' }).click();
  await expect(
    page.locator('li', { hasText: name }).first(),
    `追加した「${name}」が一覧に出ない`,
  ).toBeVisible();
}

test('マテリアリティ: 追加 → 評価 → 編集 → 削除が永続化される（CRUD）', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // Create: 自由記述で追加。気候の語から「環境」が提示される
  const name = `気候変動と炭素価格 ${Date.now().toString(36)}`;
  await page.getByLabel('マテリアリティ名（自由記述）').fill(name);
  await expect(page.getByText(/一致した語/).first()).toBeVisible();
  await page.getByRole('button', { name: 'マテリアリティを追加' }).click();
  const row = page.locator('li', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText('環境')).toBeVisible();

  // Read: リロードしても残る
  await page.reload();
  await expect(page.locator('li', { hasText: name })).toBeVisible();

  // Update(評価): 理由つきで評価し、リロード後も保持される
  const reason = `監査検証 ${Date.now().toString(36)}`;
  const assessRow = page.locator('li', { hasText: name });
  await assessRow.getByRole('combobox', { name: /の重要度/ }).selectOption('high');
  await assessRow.getByRole('textbox', { name: /の評価理由/ }).fill(reason);
  await assessRow.getByRole('button', { name: '評価を保存' }).click();
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.locator('li', { hasText: name }).getByText('重要度：高').first()).toBeVisible();

  // Update(編集): 名前を変えられる
  const renamed = `${name}（改訂）`;
  await page
    .locator('li', { hasText: name })
    .getByRole('button', { name: /を編集/ })
    .click();
  const editForm = page.locator('li', { hasText: name }).locator('form', {
    has: page.getByRole('button', { name: '変更を保存' }),
  });
  await editForm.locator('input[name="title"]').fill(renamed);
  await editForm.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.locator('li', { hasText: renamed })).toBeVisible();

  // Delete: 確認を挟んで削除し、リロード後も消えたまま
  const target = page.locator('li', { hasText: renamed });
  await target.getByRole('button', { name: /を削除/ }).click();
  await expect(target.getByText('削除しますか？')).toBeVisible();
  await target.getByRole('button', { name: '削除する' }).click();
  await expect(page.locator('li', { hasText: renamed })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('li', { hasText: renamed })).toHaveCount(0);
});

test('マテリアリティ: 評価理由は必須で、誤りは入力欄のそばに出る', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const name = `理由必須の検証 ${Date.now().toString(36)}`;
  await addMaterialityViaUi(page, name);

  // 必須の明示がある
  const row = page.locator('li', { hasText: name });
  await expect(row.getByText('（必須）')).toBeVisible();

  // 理由なしで保存 → 誤りの指摘が**その行の中**に出る（画面トップではない）
  await row.getByRole('combobox', { name: /の重要度/ }).selectOption('high');
  await row.getByRole('textbox', { name: /の評価理由/ }).fill('   ');
  await row.getByRole('button', { name: '評価を保存' }).click();
  await expect(row.getByRole('alert')).toContainText('評価理由を入力してください');
  // 画面トップのフラッシュには出ていない（?error= リダイレクトを使っていない）
  expect(page.url()).not.toContain('error=');

  // 保存されていない（リロードすると未評価のまま）
  await page.reload();
  await expect(page.locator('li', { hasText: name }).getByText('未評価').first()).toBeVisible();
});

test('コメント: 投稿が永続化され、リロード後も残る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data');
  await page.locator('tbody a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
  const url = page.url();

  const body = `監査コメント ${Date.now().toString(36)}`;
  const commentBox = page.locator('textarea[name="body"]').first();
  test.skip((await commentBox.count()) === 0, 'コメント欄が出ていない');
  await commentBox.fill(body);
  await page.getByRole('button', { name: 'コメントする' }).first().click();
  await page.waitForLoadState('networkidle');

  await page.goto(url);
  await expect(page.getByText(body)).toBeVisible();
});
