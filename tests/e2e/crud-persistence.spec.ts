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

test('マテリアリティ: 重要と評価するなら理由が必須（サーバー側で拒否）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const row = page.locator('tr', { hasText: 'サプライチェーン管理' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill('   '); // 空白のみ
  await row.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  // エラーになり、空白だけの理由は保存されない
  await page.goto('/enterprise/disclosures/ssbj');
  const after = page.locator('tr', { hasText: 'サプライチェーン管理' });
  const rationale = await after.textContent();
  expect(rationale, '空白のみの理由が保存されてしまった').toContain('購入部品の調達先');
});

test('マテリアリティ: 評価の変更が永続化される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj');

  const reason = `監査検証 ${Date.now().toString(36)}`;
  const row = page.locator('tr', { hasText: '資源循環・廃棄物' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill(reason);
  await row.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  await page.reload();
  await expect(page.getByText(reason)).toBeVisible();
  // バッジ（評価結果）で確認する。select の option にも同じ文言があるため first を取る
  await expect(
    page.locator('tr', { hasText: '資源循環・廃棄物' }).getByText('重要度：高').first(),
  ).toBeVisible();
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
