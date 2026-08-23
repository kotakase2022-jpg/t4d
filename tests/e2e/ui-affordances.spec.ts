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

test('マテリアリティの理由未入力が、全画面エラーではなく画面内の指摘になる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/disclosures/ssbj');

  const row = page.locator('tr', { hasText: '水資源の利用' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill('');
  await row.getByRole('button', { name: '保存' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('理由を入力');
  // 全画面のエラー境界には落ちていない
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});
