import { expect, test, type Page } from '@playwright/test';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import {
  DEMO_USERS,
  carriesDemoState,
  carryDemoState,
  confirmInDialog,
  loginAs,
  peakCarriedCookieHeader,
  resetCarriedDemoState,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * Scope1・2 の算定と照合の流れ（plan §3.3-5）を、すべてのリクエストが別インスタンスに届く構成
 * （playwright.stateless.config.ts。リクエストごとに Fixture を作り直す）の画面で通す。状態は Cookie だけ。
 * Service の層の同じ流れは tests/integration/stateless-ghg-chain.test.ts（Cookie の大きさ 3,000B 以下）。
 *
 *   開示デモのリセット → 本社サステナ担当が概要で承認待ちの注記 N2 を確かめる → 最終承認者が区分規則 LOGI-01 を
 *   承認 → 本社サステナ担当が算定を実行（R-2）→ 二重表示で再分類分が Scope1 に出る（N1）→ 既存結果 BL-1 と照合
 *   （許容差は人が入れる）→ レビュー担当がベトナム工場の電力に原因「排出係数」を記録 → 米国工場の仮説の再計算
 *   （係数セット 2024 年版）で差が閉じる（保存しない）→ 米国工場に原因を記録 → トライアル概要の拠点別の状態が更新
 *   → 最後に開示デモを初期状態に戻す（本番チェーン設定でも流すため、共有のデモ状態を既定へ戻す）
 *
 * 押し出し（容量不足で古い操作を捨てること）は各テストの後に 0 であることを確かめる（carryDemoState）。
 * ファイル名を *.spec.ts にしないのは、通常の E2E では同じ内容を ghg-*.spec.ts が確かめているため。
 */

test.describe.configure({ mode: 'serial' });

const G = GHG_FIXTURE_IDS;
const OVERVIEW = '/enterprise/ghg/calculation';
const RULES = `${OVERVIEW}/rules`;
const RULE_CODE = 'LOGI-01';
const VN_COMMENT = '（流れ）2024 年版の係数で算定していた';
const US_COMMENT = '（流れ）仮説（2024 年版）で差が閉じた';

const main = (page: Page) => page.locator('#t4d-main');
/** 照合の項目の行（展開行〔閉じている〕は含めない） */
const itemRows = (page: Page) =>
  page.locator('[data-data-table="ghg-reconciliation-items"] tr[data-t4d-record]');

/** 流れの中で作った算定の記録・照合（前のテストの画面から次のテストへ渡す） */
let runUrl = '';
let reconciliationUrl = '';

test.beforeAll(() => {
  // 前の spec（実演・CSRD・試行の流れ）の Cookie を持ち込まない。初期状態の Fixture から始める
  resetCarriedDemoState();
});

test.afterEach(async ({ context }, testInfo) => {
  await carryDemoState(context, testInfo.title);
});

test.afterAll(() => {
  if (carriesDemoState()) {
    const peak = peakCarriedCookieHeader();
    console.log(
      `[stateless] GHG の流れの最大: Cookie ヘッダー ${peak.bytes}B（操作の記録 ${peak.editsBytes}B）— ${peak.label}`,
    );
    // plan §2.7: GHG の流れ単独で操作の記録は 3,000B 以下
    expect(peak.editsBytes).toBeLessThanOrEqual(3_000);
  }
});

test('開始: 開示デモを初期状態に戻す（GHG の流れは初期状態から始める）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  await page.goto('/enterprise/dashboard');
  await resetDisclosureDemo(page);
  await setDisclosureFirst(page, false);
});

test('概要: 本社サステナ担当が区分規則の承認待ち（N2）と架空のデータの注記（N9）を確かめる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(OVERVIEW);
  await expect(main(page).locator('[data-ghg-notice="N9"]')).toBeVisible();
  const dual = main(page).getByRole('region', { name: '報告区分と既定区分' });
  await expect(dual.locator('[data-ghg-notice="N2"]')).toBeVisible();
  // 承認待ちだけ（R-1 は再分類していない）なら、組織の算定ルールのバッジは出さない
  await expect(dual.locator('[data-honesty="company-rule"]')).toHaveCount(0);
  // Fixture の記録 R-1 で 5 拠点は算定済み
  const sites = main(page).getByRole('table', { name: '拠点別の結果' });
  await expect(sites.locator('tbody tr')).toHaveCount(5);
});

test('承認: 最終承認者が区分規則 LOGI-01 を承認する（提案者ではない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${RULES}?status=proposed`);
  const row = main(page)
    .getByRole('table', { name: '区分規則' })
    .locator('tr', { hasText: RULE_CODE })
    .first();
  await expect(row.locator('[data-status-domain="ghgRule"]')).toHaveText(/承認待ち/);
  await row.getByRole('button', { name: '承認する' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgRuleApproved/);
  // 次の画面（別のサーバー）でも承認済み
  await page.goto(RULES);
  await expect(
    main(page)
      .getByRole('table', { name: '区分規則' })
      .locator('tr', { hasText: RULE_CODE })
      .first()
      .locator('[data-status-domain="ghgRule"]'),
  ).toHaveText(/承認済み/);
});

test('算定: 本社サステナ担当が算定を実行し、二重表示で委託物流が Scope1 へ移る（移動だけ）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(OVERVIEW);
  // 規則の承認で入力が変わったので、R-1 の拠点は「再算定が必要」
  const sites = main(page).getByRole('table', { name: '拠点別の結果' });
  await expect(sites.locator('[data-status-value="recalc_needed"]')).toHaveCount(5);
  await main(page).locator('[data-action-id="run-calculation"]').click();
  await page.waitForURL(/\/enterprise\/ghg\/calculation\/runs\/[0-9a-f-]{36}\?flash=ghgRunCreated/);
  runUrl = page.url().split('?')[0]!;
  await expect(main(page).getByRole('heading', { level: 1, name: '算定明細' })).toBeVisible();
  // 承認した規則による報告区分（N1）。計は移動だけ
  await expect(main(page).locator('[data-ghg-notice="N1"]').first()).toBeVisible();
  const dual = main(page).getByRole('table', { name: '報告区分と既定区分' });
  await expect(dual.locator('[data-dual-row="scope1_scope3_total"]')).toContainText(
    '±0（移動だけ・二重計上なし）',
  );
  // 次の画面（別のサーバー）でも記録が残り、算定行を作り直して同じ表を出す
  await page.goto(runUrl);
  await expect(main(page).getByText('最新の入力').first()).toBeVisible();
  await expect(
    main(page).locator('[data-data-table="ghg-run-lines"] tr[data-t4d-record]').first(),
  ).toBeVisible();
  // 概要: 規則で報告区分を変えた最新の記録には、N1 と組織の算定ルールのバッジを出す
  await page.goto(OVERVIEW);
  const overviewDual = main(page).getByRole('region', { name: '報告区分と既定区分' });
  await expect(overviewDual.locator('[data-ghg-notice="N1"]').first()).toBeVisible();
  await expect(overviewDual.locator('[data-honesty="company-rule"]')).toBeVisible();
});

test('照合: 算定明細の「この記録で照合する」から許容差を入れて既存結果 BL-1 と照合する', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(runUrl);
  await main(page).locator('[data-action-id="reconcile-this-run"]').click();
  await page.waitForURL(/\/enterprise\/ghg\/calculation\/reconciliation\?.*reconcile=1/);
  const reconcile = page.locator('#reconcile');
  await expect(reconcile.getByText('「既存算定結果（架空）CY2025」')).toBeVisible();
  // 許容差は既定値を置かない（人が入れる）
  for (const input of await reconcile.locator('input[name$=":abs"]').all()) {
    await expect(input).toHaveValue('');
    await input.fill('0.05');
  }
  for (const input of await reconcile.locator('input[name$=":rel"]').all()) {
    await input.fill('0.1');
  }
  await reconcile.getByRole('button', { name: '照合する' }).click();
  await page.waitForURL(/\/reconciliation\/[0-9a-f-]{36}\?.*flash=ghgReconciled/);
  reconciliationUrl = page.url().split('?')[0]!;
  await expect(main(page).locator('[data-ghg-notice="N3"]')).toBeVisible();
  // 規則の承認後の記録では、委託物流の区分の差は出ない（既存の算定も Scope1）
  await page.goto(`${reconciliationUrl}?verdict=needs_review&size=100`);
  await expect(itemRows(page).first()).toBeVisible();
  await expect(itemRows(page).getByText('区分', { exact: true })).toHaveCount(0);
});

test('原因の記録: レビュー担当がベトナム工場の電力に「排出係数」を記録する（本人名義）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(`${reconciliationUrl}?verdict=needs_review&unit=${G.units.vn}`);
  const row = itemRows(page).first();
  await expect(row).toContainText('ベトナム工場（VN）');
  await row.getByRole('link', { name: '原因を記録' }).click();
  const panel = page.locator('#record-cause');
  await panel.locator('#record-cause-select').selectOption({ label: '排出係数（値・年度・版）' });
  await panel.locator('#record-cause-comment').fill(VN_COMMENT);
  await panel.getByRole('button', { name: '原因を記録する' }).click();
  await page.waitForURL(/flash=ghgCauseRecorded/);
  await expect(page.getByText(/差異の原因を記録しました/)).toBeVisible();
  await expect(
    page.locator('[data-metric-tile]').filter({ hasText: '原因を確認済み' }).first(),
  ).toContainText(/原因を確認済み\s*1\s*\//);
});

test('仮説の再計算: 米国工場は係数セット 2024 年版で差が許容差内になる（保存しない）→ 原因を記録する', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(reconciliationUrl);
  const section = page.locator('#whatif');
  await expect(section.locator('[data-ghg-notice="N8"]')).toBeVisible();
  await section.locator('#whatif-select').selectOption({
    label: '係数セットを「組織指定（架空）2024 年版」（2024 年版）に置き換える',
  });
  await section.getByRole('button', { name: '仮説で再計算する' }).click();
  await page.waitForURL(/whatif=set/);
  const result = page.locator('[data-whatif-result]');
  const us = result.locator('tr[data-whatif-item]').filter({ hasText: '米国工場（US）' });
  await expect(us.first()).toContainText('許容差内になる');

  // 保存しない: 判定は原因不明（残差）のまま。原因は確認者が記録する（残差の項目はコメントが必須）
  await page.goto(`${reconciliationUrl}?verdict=unexplained`);
  const row = itemRows(page).filter({ hasText: '米国工場（US）' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: '原因を記録' }).click();
  const panel = page.locator('#record-cause');
  await panel.locator('#record-cause-select').selectOption({ label: '排出係数（値・年度・版）' });
  await panel.locator('#record-cause-comment').fill(US_COMMENT);
  await panel.getByRole('button', { name: '原因を記録する' }).click();
  await page.waitForURL(/flash=ghgCauseRecorded/);
  await expect(
    page.locator('[data-metric-tile]').filter({ hasText: '原因を確認済み' }).first(),
  ).toContainText(/原因を確認済み\s*2\s*\//);
});

test('トライアル概要: 算定の検証範囲の拠点別の状態が、新しい記録と照合で更新される', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/trial?tab=overview');
  const region = main(page).getByRole('region', { name: '算定の検証範囲' });
  const table = region.getByRole('table', { name: '拠点別の検証の状況' });
  await expect(table.locator('tbody tr')).toHaveCount(5);
  // 再算定が必要な拠点は無い（新しい記録 R-2 が最新の入力）。タイ工場は全項目が許容差内（照合済み）
  await expect(table.locator('[data-status-value="recalc_needed"]')).toHaveCount(0);
  await expect(
    table.locator('tr', { hasText: 'タイ工場（TH）' }).locator('[data-status-value="reconciled"]'),
  ).toBeVisible();
  await expect(
    table
      .locator('tr', { hasText: 'ベトナム工場（VN）' })
      .locator('[data-status-value="reconciliation_review"]'),
  ).toBeVisible();
});

test('終了: 開示デモを初期状態に戻す（GHG の表も戻る。共有のデモ状態を既定へ）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  await page.goto('/enterprise/dashboard');
  await resetDisclosureDemo(page);
  await setDisclosureFirst(page, false);
  // リセットの後は区分規則が承認待ちに戻る（別のサーバーでも）
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(RULES);
  await expect(
    main(page)
      .getByRole('table', { name: '区分規則' })
      .locator('tr', { hasText: RULE_CODE })
      .first()
      .locator('[data-status-domain="ghgRule"]'),
  ).toHaveText(/承認待ち/);
});
