import { expect, test } from '@playwright/test';
import {
  DEMO_USERS,
  apiStatusAsViewer,
  confirmInDialog,
  loginAs,
  openMoreMenu,
  openRowActions,
} from './helpers';

/**
 * トライアル対応（2026-10）の管理・権限・ログ・データ取扱（plan e2e:trial-admin。NF-24〜NF-29・NF-37・NF-38）。
 *
 *  - 承認ルート: 3 段階のひな形を入れて保存（確認ダイアログ）→ 一覧に 3 段階で出る
 *    （他の spec の既定の 5 段階を変えないため、ここでは「既定」を外して保存する）
 *  - メンバー: 架空のメンバーの担当拠点を変える（確認ダイアログ）・利用の停止と「元に戻す」。
 *    Demo のログイン利用者は変えられない（理由を出す）
 *  - 招待: 担当拠点つきで招待リンクを発行すると、一覧に担当拠点が出る
 *  - 監査ログ: 設定の「その他」から開き、Fixture の記録を種類で絞り込める。権限の無い人は開けない
 *  - 役割と権限・データの取扱い（未合意の表示・版の記録・返却用の書き出しの確認）・機能設定の CDP の契約
 * 設定の画面の入口は企業管理者のまま（権限の挙動は変えない）
 */

test.describe.configure({ mode: 'serial' });

test('承認ルート: 3 段階のひな形を入れて保存すると、一覧に 3 段階で出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=approval');
  await expect(page.getByRole('heading', { name: /^承認ルート/ })).toBeVisible();

  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: '3 段階のひな形を入れる' })
    .click();
  const editor = page.locator('#approval-route-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('1 段目の段階名')).toHaveValue('拠点・部署の確認');
  await expect(editor.getByLabel('3 段目の段階名')).toHaveValue('最終承認');
  // 名前を変え、既定を外して保存する（他の spec の 5 段階の既定の経路を変えない）
  await editor.getByLabel('名称').fill('3 段階の承認（E2E）');
  await editor.getByRole('checkbox', { name: /既定の経路にする/ }).uncheck();
  await editor.getByRole('button', { name: '保存…' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    '進行中のデータは写しを持つため経路は変わりません',
  );
  await confirmInDialog(page);

  await page.waitForURL(/flash=approvalRouteSaved/);
  await expect(page.getByText('承認ルートを保存しました（3 段階）')).toBeVisible();
  const row = page.locator('tr', { hasText: '3 段階の承認（E2E）' });
  await expect(row).toContainText('1. 拠点・部署の確認');
  await expect(row).toContainText('3. 最終承認');
  await expect(row).toContainText('通常のデータ');
});

test('メンバー: 架空のメンバーの担当拠点を変えられ、Demo のログイン利用者は変えられない', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=members');

  // Demo のログイン利用者は理由付きで押せない
  const protectedMenu = await openRowActions(page, DEMO_USERS.siteUser);
  await expect(protectedMenu).toContainText('デモの利用者は変更できません');
  await page.keyboard.press('Escape');

  const menu = await openRowActions(page, '北原 灯');
  await menu.getByRole('menuitem', { name: /役割・担当拠点を変更/ }).click();
  const panel = page.locator('#member-edit');
  await expect(panel).toBeVisible();
  // デモで役割の変更が持ち回らないことは隠さない
  await expect(panel).toContainText('同じサーバーのメモリにだけ残ります');
  await panel.getByRole('checkbox', { name: '東日本工場' }).check();
  await panel.getByRole('button', { name: '変更を保存…' }).click();
  await confirmInDialog(page);

  await page.waitForURL(/flash=membershipUpdated/);
  await expect(page.locator('tr', { hasText: '北原 灯' })).toContainText('東日本工場');

  // 元に戻す（全社）
  await openRowActions(page, '北原 灯').then((m) =>
    m.getByRole('menuitem', { name: /役割・担当拠点を変更/ }).click(),
  );
  await page.locator('#member-edit').getByRole('checkbox', { name: '東日本工場' }).uncheck();
  await page.locator('#member-edit').getByRole('button', { name: '変更を保存…' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=membershipUpdated/);
  await expect(page.locator('tr', { hasText: '北原 灯' })).toContainText('全社');
});

test('メンバー: 利用を停止すると通知に「元に戻す」が出て、押すと再開する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=members');

  const menu = await openRowActions(page, '西川 蒼');
  await menu.getByRole('menuitem', { name: /利用を停止/ }).click();
  await expect(page.getByRole('dialog')).toContainText('記録は消えません');
  await confirmInDialog(page);
  await page.waitForURL(/flash=membershipSuspended/);
  const row = page.locator('tr', { hasText: '西川 蒼' });
  await expect(row).toContainText('停止中');

  await expect(page.getByText('メンバーの利用を停止しました')).toBeVisible();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await page.waitForURL(/flash=membershipResumed/);
  await expect(page.locator('tr', { hasText: '西川 蒼' })).toContainText('有効');
});

test('招待: 担当拠点を選んで招待リンクを発行すると、一覧に担当拠点が出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=invitations&new=1');
  await page.locator('input[name="email"]').first().fill('scoped-invite@demo.local');
  await page.getByRole('checkbox', { name: '拠点・グループ会社担当' }).check();
  await page.getByRole('checkbox', { name: '西日本工場' }).check();
  await page.getByRole('button', { name: '招待リンクを発行' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('tr', { hasText: 'scoped-invite@demo.local' })).toContainText(
    '西日本工場',
  );
});

test('監査ログ: 設定の「その他」から開き、Fixture の記録を種類で絞り込める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  const more = await openMoreMenu(page.locator('[data-page-actions]'));
  await more.getByRole('menuitem', { name: '監査ログを開く' }).click();
  await page.waitForURL(/\/enterprise\/audit-log/);
  await expect(page.getByRole('heading', { level: 1, name: '監査ログ' })).toBeVisible();
  // 追記専用・デモの範囲の注記は折りたたまない
  await expect(page.getByText('追記専用', { exact: false }).first()).toBeVisible();
  await expect(
    page.getByText(/同じサーバーのインスタンスで発生した記録と架空の記録だけ/),
  ).toBeVisible();

  await page.goto('/enterprise/audit-log?kind=data_approved');
  const table = page.getByRole('table', { name: '監査ログ' });
  await expect(table.locator('tbody tr').first()).toContainText('データの承認');
  await expect(
    page.locator('[data-page-actions]').getByRole('link', { name: 'CSV で出力' }),
  ).toHaveAttribute('href', /\/api\/exports\/audit-log\?kind=data_approved/);
});

test('監査ログ: 監査ログの閲覧権限が無い人は開けない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/audit-log');
  await expect(page.getByText('アクセス権限がありません')).toBeVisible();
  await expect(page.getByRole('table', { name: '監査ログ' })).toHaveCount(0);
  expect(await apiStatusAsViewer(page, '/api/exports/audit-log')).toBe(403);
});

test('役割と権限: 役割 × できることを権限の名前で示す（読み取り専用）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=roles');
  await expect(page.getByText(/自動テストで検査済み/)).toBeVisible();
  const row = page.locator('tr', { hasText: '監査ログの閲覧' });
  await expect(row).toContainText('できる');
  // 権限キーは出さない
  await expect(page.locator('#t4d-main')).not.toContainText('common.audit.read');
});

test('データの取扱い: 未合意を表示し、版を記録でき、返却用の書き出しは確認を通る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=data-handling');
  await expect(page.getByRole('heading', { name: 'システムの実態（自動）' })).toBeVisible();
  await expect(page.getByText('デモの条件は架空の記録です')).toBeVisible();
  await expect(page.getByRole('table', { name: '合意した条件' })).toContainText('未合意');

  await page.locator('[data-page-actions]').getByRole('link', { name: '条件の版を記録' }).click();
  await page.getByLabel('保存期間').fill('（架空）契約終了後 90 日');
  await page.getByRole('button', { name: 'この内容で版を記録' }).click();
  await page.waitForURL(/flash=dataTermsRecorded/);
  await expect(page.getByText(/データ取扱条件の第 2 版を記録しました/)).toBeVisible();
  await expect(page.getByRole('table', { name: '合意した条件' })).toContainText(
    '（架空）契約終了後 90 日',
  );

  const more = await openMoreMenu(page.locator('[data-page-actions]'));
  await more.getByRole('menuitem', { name: /全データを書き出す/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-confirm-scope]')).toContainText(/表 \d+・行 [\d,]+・資料/);
  const download = page.waitForEvent('download');
  await dialog.locator('[data-confirm-submit]').click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});

test('機能設定: CDP オプションの契約を読み取り専用で示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=features');
  await expect(page.getByRole('heading', { name: '契約オプション' })).toBeVisible();
  await expect(page.getByText('CDP 対応（オプション）')).toBeVisible();
  await expect(page.getByText('この画面からは変更できません')).toBeVisible();
  await expect(page.locator('#t4d-main')).toContainText('契約あり');
});

test('設定の入口は企業管理者のまま（作成担当は新しいタブにも入れない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const tab of ['approval', 'roles', 'data-handling']) {
    await page.goto(`/enterprise/settings?tab=${tab}`);
    await expect(page.getByText('アクセス権限がありません')).toBeVisible();
  }
});
