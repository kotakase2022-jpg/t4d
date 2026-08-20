import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * AUTH-P0-001（招待: アプリ内リンク方式）と AI-P0-001（Copilot 対話）の実ブラウザ検証。
 * パスワード再設定・MFA は実 Auth が必要なため Supabase E2E 側で検証する。
 */

test.describe.configure({ mode: 'serial' });

test('管理者が招待リンクを発行し、本人が受諾してログイン状態で参加できる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 招待を作成（メール送信は行わない旨が明示されている）
  await expect(page.getByText('招待メールは送信しません')).toBeVisible();
  await page.locator('input[name="email"]').first().fill('shinme@demo.local');
  await page.getByRole('checkbox', { name: '拠点・グループ会社担当' }).check();
  await page.getByRole('button', { name: '招待リンクを発行' }).click();
  await page.waitForLoadState('networkidle');

  // 招待リンクが表示される
  const linkCell = page.locator('code', { hasText: '/invite/' }).first();
  await expect(linkCell).toBeVisible();
  const invitePath = (await linkCell.textContent())!.trim();

  // 本人（未ログイン）がリンクを開いて参加
  await page.context().clearCookies();
  await page.goto(invitePath);
  await expect(page.getByText('への招待')).toBeVisible();
  await expect(page.getByText('shinme@demo.local')).toBeVisible();
  await page.locator('input[name="displayName"]').fill('新芽 育');
  await page.getByRole('button', { name: '参加する' }).click();

  // Demo Mode では受諾と同時にログインしワークスペースへ
  await page.waitForURL(/\/workspace|\/enterprise/);
  await expect(page.getByText('新芽 育').first()).toBeVisible();

  // 管理者側: メンバー一覧に現れ、招待は受諾済みになる
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await expect(page.locator('tr', { hasText: '新芽 育' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'shinme@demo.local' }).last()).toContainText(
    '受諾済み',
  );
});

test('失効した招待リンクは使用できない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');

  await page.locator('input[name="email"]').first().fill('too-late@demo.local');
  await page.getByRole('checkbox', { name: '閲覧者' }).check();
  await page.getByRole('button', { name: '招待リンクを発行' }).click();
  await page.waitForLoadState('networkidle');

  const row = page.locator('tr', { hasText: 'too-late@demo.local' });
  const invitePath = (await row.locator('code').textContent())!.trim();
  await row.getByRole('button', { name: '失効' }).click();
  await page.waitForLoadState('networkidle');
  await expect(row).toContainText('失効');

  await page.context().clearCookies();
  await page.goto(invitePath);
  await expect(page.getByText('この招待は使用できません')).toBeVisible();
  await expect(page.getByRole('button', { name: '参加する' })).toHaveCount(0);
});

test('Copilot 対話: 実データに基づく回答が根拠つきで返り、会話が継続する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.locator('input[name="question"]').fill('Scope1 の当年値と前年比は？');
  await page.getByRole('button', { name: '質問する' }).click();

  // 回答に数値と出典が含まれる（Mock は承認済み集計から決定論的に答える）
  await expect(page.getByText(/t-CO2e です/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('出典').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'GHG 集計' })).toBeVisible();

  // 2 ターン目（会話の継続）
  await page.locator('input[name="question"]').fill('収集の進捗は？');
  await page.getByRole('button', { name: '質問する' }).click();
  await expect(page.getByText(/承認済み \d+ 件/).first()).toBeVisible({ timeout: 30_000 });
  // 1 ターン目も画面に残っている
  await expect(page.getByText('Scope1 の当年値と前年比は？')).toBeVisible();

  // Provenance（AI 実行履歴）へ記録される。revalidate 後に一覧へ現れる
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: 'Copilot 対話' }).first()).toBeVisible();
});

test('Copilot は分からないことに推測で答えない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/ai');
  await page.locator('input[name="question"]').fill('明日の天気を教えてください');
  await page.getByRole('button', { name: '質問する' }).click();
  await expect(page.getByText('答えられる情報がありません')).toBeVisible({ timeout: 30_000 });
});
