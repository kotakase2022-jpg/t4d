import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * UI 破綻の監査（自己検証ミッション用）。
 *
 * 本アプリは PC 専用（1280px 以上）なので、その範囲で
 *  - 横スクロールが body に出ない
 *  - 要素が画面外へはみ出さない
 *  - 長文・空データでも崩れない
 * を確認する。スマートフォン対応は要求範囲外なので検証しない。
 */

const PC_SIZES = [
  { width: 1280, height: 800, label: '1280' },
  { width: 1440, height: 900, label: '1440' },
  { width: 1920, height: 1080, label: '1920' },
];

const PATHS = [
  '/enterprise/dashboard',
  '/enterprise/data',
  '/enterprise/ghg',
  '/enterprise/disclosures/cdp',
  '/enterprise/disclosures/ssbj',
  // 列を足した画面・新設した画面は、横スクロールが出やすいので必ず含める
  '/enterprise/disclosures/ssbj/settings',
  '/enterprise/disclosures/ssbj/collection',
  '/enterprise/disclosures/ssbj/draft',
  '/enterprise/organizations',
  '/enterprise/evidence',
  '/enterprise/settings',
  '/enterprise/ai',
];

for (const size of PC_SIZES) {
  test(`${size.label}px: 主要画面で body に横スクロールが出ない`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await loginAs(page, DEMO_USERS.enterpriseAdmin);

    const overflowing: string[] = [];
    for (const path of PATHS) {
      await page.goto(path);
      await expect(page.locator('#t4d-main')).toBeVisible();
      // body が横に溢れていないこと（表などは内側の overflow-x で処理する設計）
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      if (overflow > 2) overflowing.push(`${path} (+${overflow}px)`);
    }
    expect(overflowing.join('\n')).toBe('');
  });
}

test('1280px: サイドバー・ヘッダー・本文が重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/data');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const main = await page.locator('#t4d-main').boundingBox();
  expect(main).not.toBeNull();
  // 本文が画面内に収まっている
  expect(main!.x).toBeGreaterThanOrEqual(0);
  expect(main!.x + main!.width).toBeLessThanOrEqual(1281);
});

test('長文データでもテーブルが崩れず、内側でスクロールする', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAs(page, DEMO_USERS.sustainability);

  // 長い検索語を入れても入力欄や本文が溢れない
  await page.goto(`/enterprise/data?q=${encodeURIComponent('あ'.repeat(200))}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'body が横に溢れている').toBeLessThanOrEqual(2);
});

test('デモモードのポップアップが画面外へ出ない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await page.getByRole('button', { name: 'デモモード' }).click();

  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();

  // 大きく動かしても画面内に留まる（clamp が効いている）
  const handle = dialog.getByRole('button', { name: /デモモードの案内を移動/ });
  await handle.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');

  const box = (await dialog.boundingBox())!;
  expect(box.x, 'ポップアップが左へ出た').toBeGreaterThan(-10);
  expect(box.y, 'ポップアップが上へ出た').toBeGreaterThan(-10);
  expect(box.x, 'ポップアップが右へ出た').toBeLessThan(1280);
  expect(box.y, 'ポップアップが下へ出た').toBeLessThan(800);
});

test('空データ時もレイアウトが保たれる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/data?q=zzz_no_match_zzz');
  await expect(page.getByText('該当するデータがありません')).toBeVisible();

  const main = await page.locator('#t4d-main').boundingBox();
  expect(main!.height, '空データで本文が潰れている').toBeGreaterThan(100);
});
