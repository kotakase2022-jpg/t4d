import { expect, test, type Page } from '@playwright/test';
import {
  apiStatusAsViewer,
  confirmInDialog,
  DEMO_USERS,
  loginAs,
  openMoreMenu,
  openRowActions,
} from './helpers';

/**
 * トライアルの評価（トライアル対応 NF-32〜NF-36・plan §2.5）。
 *  - Demo Mode では先頭に「架空のトライアル記録」の注記を常に出す（折りたたまない）
 *  - 概要: 計画と実績を分母付きで並べ、超過は止めずに知らせる。選定ケースを出す
 *  - シナリオ: 実施は本人が記録し、判定は管理者が確認ダイアログで記録する（取り消せない）。率は n 併記
 *  - 改善管理表: 「ご意見・不具合」から送ると表に出る。見出しに必須要件 × 重大 × 未解決の件数
 *  - 作業時間: 両方 n ≥ 3 のときだけ短縮率。費用対効果: 試算の注記と、URL だけに載る入力
 *  - 検証結果・改善管理表の XLSX は管理者だけ（それ以外は 403）
 *
 * ヘッダーの「ご意見・不具合」（AppShell に取り付けた同じ部品 feedback-dialog.tsx）から、どの画面でも送れる。
 */

test.describe.configure({ mode: 'serial' });

const PATH = '/enterprise/trial';
const main = (page: Page) => page.locator('#t4d-main');
const tabs = (page: Page) => main(page).getByRole('navigation', { name: 'トライアルの評価の節' });
const FICTIONAL = '架空のトライアル記録です。実測値・実際の効果ではありません。';

test('概要: 架空の注記・計画と実績（分母付き）・超過の知らせ・選定ケースが見える', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1, name: 'トライアルの評価' })).toBeVisible();
  await expect(main(page).getByText(FICTIONAL)).toBeVisible();
  await expect(tabs(page).getByRole('link')).toHaveText([
    '概要',
    'シナリオ',
    '改善管理表',
    '作業時間',
    '費用対効果',
  ]);
  const strip = main(page).getByRole('region', { name: '計画と実績' });
  await expect(strip).toContainText('有効メンバー');
  await expect(strip).toContainText('/ 計画 10');
  await expect(strip).toContainText('承認段階（既定のルート）');
  await expect(main(page)).toContainText('計画を超えている項目があります（操作は止めません）');
  const cases = main(page).getByRole('table', { name: '選定ケース' });
  await expect(cases).toContainText('気候-10');
  await expect(cases).toContainText('40A-S01');
  await expect(cases).toContainText('サンプル（架空）');

  // 主操作は「計画を編集」。押すと作成・編集の欄が開く（保存はしない）
  await main(page).locator('[data-page-actions]').getByRole('link', { name: '計画を編集' }).click();
  await expect(page.locator('#trial-plan-panel')).toBeVisible();
  await expect(
    page.locator('#trial-plan-panel').getByRole('button', { name: '計画を保存' }),
  ).toBeVisible();
});

test('シナリオ: 作成担当が実施を記録し、率は件数（n）と一緒に出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?tab=scenarios`);
  await expect(main(page).getByText(FICTIONAL)).toBeVisible();
  const table = main(page).getByRole('table', { name: '検証シナリオ' });
  await expect(table.getByRole('row').filter({ hasText: 'TS-05' })).toContainText(
    '件数不足（n=2）',
  );
  // 判定は管理者だけ（作成担当の行の操作に「判定を記録…」は無い）
  await expect(main(page).getByRole('button', { name: /^TS-02 .+ の操作$/ })).toHaveCount(0);
  // 算定の再現と整合性の確認（主題と判定の目安。「一致」を判定の語に使わない）
  const calc = table.getByRole('row').filter({ hasText: 'S-CALC-01' });
  await expect(calc).toContainText('算定の再現と整合性の確認');
  await expect(calc).not.toContainText('一致');

  await table
    .getByRole('row')
    .filter({ hasText: 'TS-02' })
    .getByRole('link', { name: '実施を記録' })
    .click();
  const panel = page.locator('#trial-run-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#trial-run-scenario')).toHaveValue(/.+/);
  await panel.locator('#trial-run-completion').selectOption({ label: '自力で完了' });
  await panel.locator('#trial-run-minutes').fill('12');
  await panel.getByRole('button', { name: '実施を記録' }).click();
  await page.waitForURL(/flash=trialRunRecorded/);
  await expect(main(page).getByRole('status')).toContainText('シナリオ TS-02 の実施を記録しました');
  await expect(table.getByRole('row').filter({ hasText: 'TS-02' })).toContainText(
    '件数不足（n=2）',
  );
});

test('シナリオ: 管理者が確認ダイアログで判定を記録する（取り消せない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=scenarios`);
  const menu = await openRowActions(
    main(page),
    'TS-02 対象外と未対応を区別し、理由・担当・期限を確かめる',
  );
  await menu.getByRole('menuitem', { name: '判定を記録…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('取り消せません');
  await expect(dialog).toContainText('判定は評価者が決めます');
  await dialog.locator('select[name="judgement"]').selectOption('pass');
  await confirmInDialog(page, {
    reason: '（E2E）対象外は理由と承認者、未対応は担当と期限が見えた。',
  });
  await page.waitForURL(/flash=trialJudged/);
  await expect(main(page).getByRole('status')).toContainText('判定を記録しました');
  const row = main(page)
    .getByRole('table', { name: '検証シナリオ' })
    .getByRole('row')
    .filter({ hasText: 'TS-02' });
  await expect(row).toContainText('合格');
});

test('改善管理表: 「ご意見・不具合」から送ると表に出る。見出しに必須要件 × 重大 × 未解決', async ({
  page,
}) => {
  const title = `（E2E）保存の位置が分かりにくい ${Date.now()}`;
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(`${PATH}?tab=feedback`);
  await expect(main(page).getByText(FICTIONAL)).toBeVisible();
  await expect(
    main(page).getByRole('heading', { name: /^改善管理表（必須要件 × 重大 × 未解決 \d+ 件）$/ }),
  ).toBeVisible();

  await main(page).locator('[data-feedback-trigger]').click();
  const dialog = page.getByRole('dialog', { name: 'ご意見・不具合を送る' });
  await expect(dialog).toContainText('URL の検索条件・ID を除く');
  await dialog.locator('select[name="kind"]').selectOption('defect');
  await dialog.locator('select[name="severity"]').selectOption('minor');
  await dialog.locator('input[name="title"]').fill(title);
  await dialog.getByRole('button', { name: '送る' }).click();
  await expect(dialog.getByRole('status')).toContainText('改善管理表に登録しました');
  await dialog.getByRole('button', { name: '完了' }).click();

  await page.reload();
  const row = main(page)
    .getByRole('table', { name: '改善管理表' })
    .getByRole('row')
    .filter({ hasText: title });
  await expect(row).toContainText('不具合');
  await expect(row).toContainText('未着手');
});

test('ヘッダーの「ご意見・不具合」: 別の画面から送ると、画面を移らずに改善管理表に出る（画面のパターンを添える）', async ({
  page,
}) => {
  const title = `（E2E）ヘッダーから: 一覧の列が多い ${Date.now()}`;
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/data');
  // ヘッダー（main の外）の起動ボタン。主操作ではない（ghost）
  const trigger = page.locator('header [data-feedback-trigger]');
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('data-variant', 'ghost');
  await expect(main(page).locator('[data-feedback-trigger]')).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'ご意見・不具合を送る' });
  await dialog.locator('select[name="kind"]').selectOption('request');
  await dialog.locator('input[name="title"]').fill(title);
  await dialog.getByRole('button', { name: '送る' }).click();
  await expect(dialog.getByRole('status')).toContainText('改善管理表に登録しました');
  await dialog.getByRole('button', { name: '完了' }).click();
  await expect(page).toHaveURL(/\/enterprise\/data/);

  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=feedback`);
  const row = main(page)
    .getByRole('table', { name: '改善管理表' })
    .getByRole('row')
    .filter({ hasText: title });
  await expect(row).toContainText('要望');
});

test('作業時間: 両方 3 件以上の作業だけ短縮率を出し、目標は結果と別に示す', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?tab=timing`);
  const table = main(page).getByRole('table', { name: '作業ごとの比較' });
  await expect(table.getByRole('row').filter({ hasText: 'データ収集・転記' })).toContainText(
    '29.2% 短縮',
  );
  await expect(table.getByRole('row').filter({ hasText: '確認・突合' })).toContainText(
    '件数不足（現行 n=2・T4D n=1）',
  );
  await expect(table.getByRole('row').filter({ hasText: '目標（参考）' })).toBeVisible();
});

test('費用対効果: 試算の注記を常に出し、入力は URL だけに載せる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?tab=roi`);
  await expect(main(page)).toContainText('試算（実測効果ではない）');
  await expect(main(page)).toContainText('人件費の現金削減を意味しません');
  // 製品は単価・価格の既定値を持たない
  await expect(page.locator('#roi-price')).toHaveValue('');
  await page.locator('#roi-price').fill('6000');
  await page.locator('#roi-depts').fill('3');
  await page.locator('#roi-hours').fill('8');
  await page.locator('#roi-months').fill('12');
  await main(page).getByRole('button', { name: '試算する' }).click();
  await page.waitForURL(/price=6000/);
  const result = main(page).getByRole('region', { name: '試算の結果' });
  await expect(result).toContainText('288 時間');
  await expect(result).toContainText('1,728,000 円');
});

test('検証結果・改善管理表の XLSX は管理者だけ（作成担当には出さず、API は 403）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=scenarios`);
  const menu = await openMoreMenu(main(page));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: '検証結果・改善管理表を出力（XLSX）' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('検証結果');

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?tab=scenarios`);
  await expect(main(page).locator('[data-page-actions] [data-more-menu]')).toHaveCount(0);
  expect(await apiStatusAsViewer(page, '/api/exports/trial-report')).toBe(403);
});

test('管理者: 計画・選定ケース・合意と判断を保存する（判断は人が入力。AI は関与しない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=overview&edit=1`);
  const plan = page.locator('#trial-plan-panel');
  await expect(plan).toBeVisible();
  await plan
    .getByLabel('対象データの説明')
    .fill('（E2E）本社集約済みの 10 指標と、定性情報 10 節（架空）');
  await plan.getByRole('button', { name: '計画を保存' }).click();
  await page.waitForURL(/flash=trialPlanSaved/);
  await expect(main(page).getByRole('status')).toContainText('トライアルの計画を保存しました');

  await page.goto(`${PATH}?tab=overview&cases=1`);
  const cases = page.locator('#trial-cases-panel');
  await expect(cases).toBeVisible();
  await cases.getByRole('button', { name: '選定ケースを保存' }).click();
  await page.waitForURL(/flash=trialCasesSaved/);

  await page.goto(`${PATH}?tab=overview&decision=1`);
  const decision = page.locator('#trial-decision-panel');
  await expect(decision).toBeVisible();
  await decision.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=trialDecisionSaved/);
  // 架空の注記は保存の後も常に出る
  await expect(main(page).getByText(FICTIONAL)).toBeVisible();
});

test('管理者: 定例会の論点を登録し、対応と再検証を記録する', async ({ page }) => {
  const title = `（E2E）定例会: 横断対応表の列の並び ${Date.now()}`;
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=feedback`);
  await page
    .locator('[data-page-actions]')
    .getByRole('link', { name: '定例会などの論点を記録' })
    .click();
  const meeting = page.locator('#trial-meeting-panel');
  await expect(meeting).toBeVisible();
  await meeting.getByLabel('件名').fill(title);
  await meeting.getByRole('button', { name: '論点を登録' }).click();
  await page.waitForURL(/flash=trialFeedbackRecorded/);

  const row = main(page)
    .getByRole('table', { name: '改善管理表' })
    .getByRole('row')
    .filter({ hasText: title });
  await row.getByRole('link', { name: '対応を記録' }).click();
  const triage = page.locator('#trial-triage-panel');
  await expect(triage).toBeVisible();
  await triage.locator('select[name="status"]').selectOption('resolved');
  await triage.locator('select[name="costClass"]').selectOption('maintenance');
  await triage.getByRole('button', { name: '対応を保存' }).click();
  await page.waitForURL(/flash=trialFeedbackTriaged/);

  await main(page)
    .getByRole('table', { name: '改善管理表' })
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('link', { name: '対応を記録' })
    .click();
  const reverify = page.getByRole('form', { name: '再検証の結果' });
  await reverify.locator('select[name="result"]').selectOption('pass');
  await reverify.getByRole('button', { name: '再検証を記録' }).click();
  await page.waitForURL(/flash=trialReverified/);
});

test('作業時間を記録する（本人。訂正は追記）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${PATH}?tab=timing&new=1`);
  const panel = page.locator('#trial-timing-panel');
  await expect(panel).toBeVisible();
  // 他のテストが確かめている作業（転記・確認と突合）の件数を変えないよう、引継ぎの作業で記録する
  await panel.locator('select[name="taskKey"]').selectOption('handover');
  await panel.locator('select[name="mode"]').selectOption('t4d');
  await panel.locator('input[name="minutes"]').fill('25');
  await panel.getByRole('button', { name: '作業時間を記録' }).click();
  await page.waitForURL(/flash=trialTimingRecorded/);
  await expect(main(page).getByRole('status')).toBeVisible();
});
