import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PERIOD_IDS } from '@/lib/fixtures/dataset';
import {
  confirmInDialog,
  DEMO_USERS,
  loginAs,
  openCollapsible,
  openMoreMenu,
  openRowActions,
} from './helpers';

/**
 * 排出係数・算定ルール（plan §3.5 e2e:ghg-factors-rules。Scope1・2 の算定 S1）。架空データだけで行う。
 *
 * 係数セットの一覧に出所のバッジ（架空〔デモ〕）→ 架空のサンプル CSV を取り込み（小数点の記号を選ぶまで読まない）
 * → 下書き → 有効化（確認ダイアログ）→ 有効化の操作が消える → 割当で経路を確かめ、拠点の割当へ替える → 取り下げた
 * セットの係数は「セットが有効ではありません」になる（代わりを使わない）→ 割当を外して元へ戻す → 丸めの版を保存
 * → 区分規則を提案（根拠が空なら送れない）→ 最終承認者で承認（提案者本人には承認が無い）→ 取り下げ。
 *
 * 同じサーバーのメモリを後の spec と共有するため、算定の検証期間（CY2025）の入力は最後に元へ戻す:
 * 割当は外し、丸めの版は FY2026 に保存し、区分規則は CY2025 に効かない期間・貨物で作って取り下げる。
 */

const FACTORS = '/enterprise/ghg/calculation/factors';
const RULES = '/enterprise/ghg/calculation/rules';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const SET_CODE = `E2E-${SUFFIX}`;
const RULE_CODE = `LOGI-E${SUFFIX}`;

async function main(page: Page) {
  const main = page.locator('#t4d-main');
  await expect(main).toBeVisible();
  return main;
}

test.describe.configure({ mode: 'serial' });

test('係数セットの取込 → 有効化 → 割当 → 取り下げで「代わりを使わない」', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(FACTORS);
  let m = await main(page);
  await expect(
    page.getByRole('heading', { name: '排出係数（Scope1・2算定）', level: 1 }),
  ).toBeVisible();
  await expect(m.locator('[data-ghg-notice="N9"]')).toBeVisible();

  // 出所のバッジ（Fixture のセットは「架空（デモ）」）
  const sets = m.getByRole('table', { name: '係数のセット' });
  const org2025 = sets
    .locator('tr', { hasText: 'ORG-2025' })
    .filter({ hasNotText: 'ORG-2025R' })
    .first();
  await expect(org2025.locator('[data-status-domain="factorOrigin"]')).toHaveText(/架空（デモ）/);
  await expect(org2025.locator('[data-status-domain="ghgFactorSet"]')).toHaveText(/有効/);

  // 取込（CreatePanel）: 架空のサンプルをダウンロードして選ぶ
  await m.getByRole('link', { name: '係数セットを取り込む' }).click();
  const panel = page.getByRole('region', { name: '係数セットを取り込む' });
  await expect(panel).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('link', { name: '架空のサンプル（係数セット CSV）をダウンロード' }).click(),
  ]);
  const csv = readFileSync((await download.path())!);
  await panel.locator('input[name="code"]').fill(SET_CODE);
  await panel.locator('input[name="name"]').fill('組織指定（架空）2025 年版 改訂');
  await panel.locator('input[name="versionLabel"]').fill('2025 年版 改訂');
  await panel.locator('input[name="sourceLabel"]').fill('（架空）組織指定 2025 年版 改訂');
  await panel.locator('#factor-file').setInputFiles({
    name: 'factor-set-sample.csv',
    mimeType: 'text/csv',
    buffer: csv,
  });
  await panel.getByRole('button', { name: 'ファイルを読んで検証する' }).click();

  // 「0.437」のような値は小数点の記号を選ぶまで読まない（推測で埋めない）
  await expect(panel.getByRole('heading', { name: /^列の対応/ })).toBeVisible();
  await expect(panel.getByRole('list', { name: '検証のエラー' })).toContainText(
    '小数点の記号を選ぶと読める場合があります',
  );
  await expect(
    panel.getByRole('button', { name: '確定する（下書きのセットを作る）' }),
  ).toBeDisabled();
  await panel.locator('select[name="decimalSeparator"]').selectOption('dot');
  await panel.getByRole('button', { name: '列の対応を反映して検証する' }).click();
  await expect(panel.getByText('エラーなし')).toBeVisible();
  await expect(panel).toContainText('係数 8 件');
  await panel.getByRole('button', { name: '確定する（下書きのセットを作る）' }).click();

  await page.waitForURL(
    /\/enterprise\/ghg\/calculation\/factors\/[^/?]+\?flash=ghgFactorSetImported/,
  );
  m = await main(page);
  await expect(m.getByText('係数のセットを下書きとして取り込みました（係数 8 件）')).toBeVisible();
  await expect(m.locator('[data-status-domain="ghgFactorSet"]').first()).toHaveText(/下書き/);
  await expect(m.locator('[data-status-domain="factorOrigin"]').first()).toHaveText(/組織指定/);
  // 組織指定の係数を「架空値」と書かない（出所で出し分ける。plan K13）
  await expect(m.getByText('架空値（実係数ではありません）')).toHaveCount(0);
  const setUrl = page.url().split('?')[0]!;

  // 有効化（確認ダイアログ）→ 有効化の操作は出ない（係数は変えられない）
  await m.getByRole('button', { name: '有効にする' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgFactorSetActivated/);
  m = await main(page);
  await expect(m.getByText(/係数のセットを有効にしました/)).toBeVisible();
  await expect(m.locator('[data-status-domain="ghgFactorSet"]').first()).toHaveText(/有効/);
  await expect(m.getByRole('button', { name: '有効にする' })).toHaveCount(0);

  // 割当: タイ工場の電力（ロケーション基準）は国の割当で解決している
  await page.goto(`${FACTORS}?view=assignments`);
  m = await main(page);
  const needs = m.getByRole('table', { name: '必要な割当' });
  const thLocation = needs
    .locator('tr', { hasText: 'タイ工場' })
    .filter({ hasText: '電力（ロケーション基準）' })
    .first();
  await expect(thLocation).toContainText('国の割当（TH・電力（ロケーション基準）・2025 年版）');
  await expect(thLocation).toContainText('解決済み');

  // 拠点の割当へ替える（取り込んだセットのタイの係数）
  await thLocation.getByRole('link', { name: '割り当て直す' }).click();
  const assign = page.getByRole('region', { name: '係数を割り当てる' });
  await expect(assign).toBeVisible();
  await assign.locator('select[name="level"]').selectOption('unit');
  // 選べるのは有効なセットの、種類・活動・基準・国が合う係数だけ（取り込んだセットの係数も並ぶ）
  await expect(
    assign.locator(`select[name="factorId"] optgroup[label^="${SET_CODE}"]`),
  ).toHaveCount(1);
  const revised = assign
    .locator('select[name="factorId"] option')
    .filter({ hasText: 'ORG-2025R-ELEC-LOC-TH' })
    .first();
  await assign
    .locator('select[name="factorId"]')
    .selectOption((await revised.getAttribute('value'))!);
  await assign.locator('textarea[name="reason"]').fill('（架空）E2E: 改訂版の係数で確かめる');
  await assign.getByRole('button', { name: '割り当てる' }).click();
  await page.waitForURL(/flash=ghgAssignmentSaved/);
  m = await main(page);
  const thAfter = m
    .getByRole('table', { name: '必要な割当' })
    .locator('tr', { hasText: 'タイ工場' })
    .filter({ hasText: '電力（ロケーション基準）' })
    .first();
  await expect(thAfter).toContainText(
    '拠点の割当（タイ工場・電力（ロケーション基準）・2025 年版 改訂）',
  );

  // 取り込んだセットを取り下げると、拠点の割当は「セットが有効ではありません」になる（国の割当で代えない）
  await page.goto(setUrl);
  m = await main(page);
  const more = await openMoreMenu(m);
  await more.getByRole('menuitem', { name: '取り下げる…' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgFactorSetRetired/);
  await page.goto(`${FACTORS}?view=assignments`);
  m = await main(page);
  const thRetired = m
    .getByRole('table', { name: '必要な割当' })
    .locator('tr', { hasText: 'タイ工場' })
    .filter({ hasText: '電力（ロケーション基準）' })
    .first();
  await expect(thRetired).toContainText('割り当てた係数のセットが有効ではありません');
  await expect(m.getByText('係数が決まらない活動があります')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Scope1・2算定の画面' })).toContainText(
    '要対応',
  );

  // 割当を外して元へ戻す（確認ダイアログ）
  const current = m.getByRole('table', { name: 'いまの割当' });
  const menu = await openRowActions(current, '拠点 タイ工場 電力（ロケーション基準）');
  await menu.getByRole('menuitem', { name: '割当を外す…' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgAssignmentCleared/);
  m = await main(page);
  const thRestored = m
    .getByRole('table', { name: '必要な割当' })
    .locator('tr', { hasText: 'タイ工場' })
    .filter({ hasText: '電力（ロケーション基準）' })
    .first();
  await expect(thRestored).toContainText('国の割当（TH・電力（ロケーション基準）・2025 年版）');
  await expect(thRestored).toContainText('解決済み');

  // Fixture のセットの詳細は「架空値（実係数ではありません）」
  await page.goto(FACTORS);
  m = await main(page);
  await m
    .getByRole('table', { name: '係数のセット' })
    .getByRole('link', { name: 'ORG-2025', exact: true })
    .click();
  m = await main(page);
  await expect(m.getByText('架空値（実係数ではありません）')).toBeVisible();
  await expect(m.getByRole('heading', { name: /改良トンキロ法の式/ })).toBeVisible();
});

test('算定ルール: 丸めの版の保存と区分規則の提案・承認（提案者は承認できない）', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${RULES}?period=${encodeURIComponent(PERIOD_IDS.fy2026)}`);
  let m = await main(page);
  await expect(
    page.getByRole('heading', { name: '算定ルール（Scope1・2算定）', level: 1 }),
  ).toBeVisible();
  await expect(m.locator('[data-ghg-notice="N6"]')).toBeVisible();
  await expect(
    m.getByRole('heading', { name: /算定方針（FY2026・まだありません）/ }),
  ).toBeVisible();

  // 丸めの版を保存（FY2026。算定の検証期間の入力は変えない）
  const rounding = await openCollapsible(m, '丸め');
  await rounding.getByLabel('拠点×区分で丸める').check();
  await rounding.locator('input[name="round:site_scope:digits"]').fill('1');
  await m.getByRole('button', { name: '規則を保存（方針の新しい版）' }).click();
  await page.waitForURL(/flash=ghgPolicySaved/);
  m = await main(page);
  await expect(m.getByText('算定方針の版 1 を保存しました（前の版は残ります）。')).toBeVisible();
  await expect(m.getByRole('heading', { name: /算定方針（FY2026・版 1）/ })).toBeVisible();

  // 区分規則を提案。根拠が空なら送れない（必須）
  await m.getByRole('link', { name: '区分規則を提案' }).click();
  const panel = page.getByRole('region', { name: '区分規則を提案' });
  await expect(panel).toBeVisible();
  await panel.locator('input[name="code"]').fill(RULE_CODE);
  await panel.locator('input[name="name"]').fill('委託物流（E2E 確認用）を Scope1 とする');
  await panel.locator('input[name="cargoKinds"]').fill('E2E 確認用の貨物');
  await panel.locator('select[name="effectiveFromPeriodId"]').selectOption(PERIOD_IDS.fy2026);
  await panel.locator('select[name="effectiveToPeriodId"]').selectOption(PERIOD_IDS.fy2026);
  await panel.getByRole('button', { name: '提案する' }).click();
  const rationale = panel.locator('textarea[name="rationale"]');
  expect(await rationale.evaluate((el) => (el as HTMLTextAreaElement).validity.valueMissing)).toBe(
    true,
  );
  await expect(page).not.toHaveURL(/flash=ghgRuleProposed/);
  await rationale.fill('（架空）E2E: 自社便と同じ管理をしている輸送のため');
  await panel.getByRole('button', { name: '提案する' }).click();
  await page.waitForURL(/flash=ghgRuleProposed/);
  m = await main(page);
  await expect(m.getByText(`区分規則「${RULE_CODE}」を提案しました（承認待ち）`)).toBeVisible();
  const rules = m.getByRole('table', { name: '区分規則' });
  const proposed = rules.locator('tr', { hasText: RULE_CODE }).first();
  await expect(proposed.locator('[data-status-domain="ghgRule"]')).toHaveText(/承認待ち/);
  await expect(m.locator('[data-honesty="company-rule"]').first()).toBeVisible();
  // 提案者（承認の権限なし）には承認の操作が出ない
  await expect(proposed.getByRole('button', { name: '承認する' })).toHaveCount(0);

  // 最終承認者で承認
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${RULES}?period=${encodeURIComponent(PERIOD_IDS.fy2026)}`);
  m = await main(page);
  const row = m
    .getByRole('table', { name: '区分規則' })
    .locator('tr', { hasText: RULE_CODE })
    .first();
  await row.getByRole('button', { name: '承認する' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgRuleApproved/);
  m = await main(page);
  await expect(m.getByText(`区分規則「${RULE_CODE}」を承認しました`)).toBeVisible();
  const approved = m
    .getByRole('table', { name: '区分規則' })
    .locator('tr', { hasText: RULE_CODE })
    .first();
  await expect(approved.locator('[data-status-domain="ghgRule"]')).toHaveText(/承認済み/);
  await expect(approved).toContainText(DEMO_USERS.approver);

  // 後の spec と共有するメモリを汚さないよう取り下げる（取り下げの確認ダイアログ）
  const menu = await openRowActions(
    m.getByRole('table', { name: '区分規則' }),
    `${RULE_CODE} 委託物流（E2E 確認用）を Scope1 とする`,
  );
  await menu.getByRole('menuitem', { name: '取り下げる…' }).click();
  await confirmInDialog(page);
  await page.waitForURL(/flash=ghgRuleWithdrawn/);
  m = await main(page);
  await expect(
    m
      .getByRole('table', { name: '区分規則' })
      .locator('tr', { hasText: RULE_CODE })
      .first()
      .locator('[data-status-domain="ghgRule"]'),
  ).toHaveText(/取り下げ/);
});
