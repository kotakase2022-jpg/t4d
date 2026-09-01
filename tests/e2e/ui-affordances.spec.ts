import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 「見えてはいるが使えない」UI の回帰テスト。
 * 独立再監査で見つかった UI / アクセシビリティの指摘に対応する。
 */

test('列表示メニューがキーボードだけで操作できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');

  const trigger = page.getByRole('button', { name: '列表示の切替' });
  await trigger.focus();
  await page.keyboard.press('Enter');

  // Radix のメニュー項目として認識される（以前は素の Link で、矢印キーが効かなかった）
  const items = page.getByRole('menuitemcheckbox');
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  expect(count).toBeGreaterThan(3);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/cols=/);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('コマンドパレットが選択中の候補を支援技術へ伝える', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/dashboard');

  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'コマンドパレット検索' });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('aria-controls', 't4d-cmdk-list');

  await input.fill('CDP');
  // 属性はレンダリング後に付くので、待てる形で確かめる
  await expect(input, '選択中の候補が伝わっていない').toHaveAttribute(
    'aria-activedescendant',
    /t4d-cmdk-option-\d+/,
  );

  const active = (await input.getAttribute('aria-activedescendant'))!;
  await expect(page.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');
});

test('メンバーの状態が日本語のラベルとアイコンで表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');

  const table = page.locator('table').first();
  await expect(table).toContainText('有効');
  // 生の enum が残っていない
  await expect(table).not.toContainText('active');
  await expect(table).not.toContainText('suspended');
});

test('取込画面がドロップを受け付ける', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const zone = page.locator('label[for="import-files"]');
  await expect(zone).toContainText('ここへドロップ');

  // DataTransfer でファイルを落とす
  await zone.dispatchEvent('dragover', {});
  await page.evaluate(() => {
    const zoneEl = document.querySelector('label[for="import-files"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['拠点,項目,値\n本社,電力使用量,10'], 'drop.csv', { type: 'text/csv' }),
    );
    zoneEl.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });

  const fileCount = await page
    .locator('#import-files')
    .evaluate((el) => (el as HTMLInputElement).files?.length ?? 0);
  expect(fileCount, 'ドロップしたファイルが input へ移っていない').toBe(1);
});

test('マテリアリティの理由未入力が、入力欄のそばの指摘になる', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/disclosures/ssbj/settings');

  // 課題は利用者が自由記述で登録する。まず追加してから理由未入力を試す
  const name = `理由未入力の検証 ${Date.now().toString(36)}`;
  await page.getByLabel('マテリアリティ名（自由記述）').fill(name);
  // 一致する語が無い名前なので、区分は利用者が選ぶ（提示は候補どまり）
  await page.getByRole('radio', { name: '区分: 社会' }).check();
  await page.getByRole('button', { name: 'マテリアリティを追加' }).click();
  const row = page.locator('li', { hasText: name });
  await expect(row).toBeVisible();

  await row.getByRole('combobox', { name: /の重要度/ }).selectOption('high');
  await row.getByRole('textbox', { name: /の評価理由/ }).fill('');
  await row.getByRole('button', { name: '評価を保存' }).click();

  // 誤りの指摘は操作した行の中に出る。画面トップへ飛ばさない（?error= を使わない）
  await expect(row.getByRole('alert')).toContainText('評価理由を入力してください');
  expect(page.url()).not.toContain('error=');
  // 全画面のエラー境界には落ちていない
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});
