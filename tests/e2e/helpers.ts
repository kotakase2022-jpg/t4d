import { expect, type Page } from '@playwright/test';

/**
 * E2E 共通ヘルパー。
 *
 * Demo Mode（環境変数なし）で動作させる前提。
 * ログインはデモアカウントのボタンを押すだけ（本番 Auth とは別経路）。
 */

export const DEMO_USERS = {
  enterpriseAdmin: '青海 太郎',
  siteUser: '東 一郎',
  sustainability: '海野 みどり',
  reviewer: '検見川 涼',
  approver: '承 花子',
  assuranceManager: '青葉 健',
  assurancePartner: '保 統括',
  assuranceStaff: '若葉 新',
  assuranceAdmin: '法人 管理',
  /** 別テナント（越権テスト用）。ログイン画面下部の折りたたみ内にある。 */
  otherEnterpriseAdmin: '蒼天 次郎',
  otherAssuranceManager: '黒部 誠',
} as const;

export async function logout(page: Page): Promise<void> {
  await page.goto('/workspace');
  const menu = page.getByRole('button', { name: /ユーザーメニュー/ });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.getByRole('menuitem', { name: 'ログアウト' }).click();
    await page.waitForURL('**/login');
  }
}

/** デモアカウントでログインし、ワークスペースを選択する。 */
export async function loginAs(page: Page, displayName: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'デモログイン' })).toBeVisible();

  // ログイン導線は 2 種類ある。
  //  ・主要アカウント: ボタンの中に氏名が入っている
  //  ・別テナント（越権テスト用）: 折りたたみ（details）の中で、
  //    ボタンのラベルは「ログイン」・氏名は隣の span
  const card = page.locator('button', { hasText: displayName }).first();
  if ((await card.count()) > 0) {
    await card.click();
  } else {
    const disclosure = page.locator('summary', { hasText: '越権テスト用' }).first();
    if ((await disclosure.count()) > 0) await disclosure.click();
    await page.locator('li', { hasText: displayName }).locator('button[type="submit"]').click();
  }
  await page.waitForURL('**/workspace');

  // ワークスペースが 1 つならそのまま選択
  const workspaceButton = page.locator('form button[type="submit"]').first();
  await workspaceButton.click();
  await page.waitForURL(/\/(enterprise|assurance)\//);
}

export async function gotoEnterprise(page: Page, path: string): Promise<void> {
  await page.goto(`/enterprise/${path}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
}

/** 監査法人ワークスペースで、対象案件の指定ページへ移動する。 */
export async function gotoEngagementPage(page: Page, pageName: string): Promise<string> {
  await page.goto('/assurance/engagements');
  const link = page.getByRole('link', { name: 'ENG-2026-001' }).first();
  await link.click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  const engagementId = page.url().match(/engagements\/([^/]+)\//)?.[1] ?? '';
  await page.goto(`/assurance/engagements/${engagementId}/${pageName}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  return engagementId;
}
