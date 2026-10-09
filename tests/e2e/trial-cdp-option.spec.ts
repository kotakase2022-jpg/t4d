import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEMO_USERS, confirmInDialog, loginAs, openMoreMenu } from './helpers';

/**
 * CDP オプション（トライアル対応 NF-38〜NF-41。e2e:trial-cdp-option）。
 *
 *  - NF-38: CDP 対応オプションの契約が無い組織（越権テスト用の組織）では、CDP の一覧・取込・質問は
 *    理由を出し（404 にしない）、出力 API は 403。契約のある組織（実演の組織）は従来どおり
 *  - NF-39: 一覧の担当・不足の列と保存ビュー、担当の一括割当（確認ダイアログ）、版の選択が一覧に効く、
 *    回答画面の担当・対応する T4D の情報（追加・外す）・根拠の再利用、作成者は承認できない（職務分離）
 *  - NF-40: AI 草案の説明は実際の入力どおり。CDP ポータルへの送信は含まないことを画面に書く
 *  - NF-41: AI 草案が埋められなかった情報を画面に出す
 *
 * 他の spec が使う質問（C0.1・C0.2・C6.1）を避け、C1.1b・C4.1・C8.2・C10.1・C12.1 を使う。
 */

test.describe.configure({ mode: 'serial' });

const CDP = '/enterprise/disclosures/cdp';

async function openQuestion(page: Page, code: string): Promise<string> {
  await page.goto(CDP);
  await page.getByRole('link', { name: code, exact: true }).first().click();
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\/[0-9a-f-]+$/);
  return page.url();
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

/** 折りたたみの節（CollapsibleSection）を開く。既に開いていれば何もしない */
async function openSection(section: Locator): Promise<void> {
  const details = section.locator('details').first();
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await details.locator('summary').first().click();
  }
}

test('契約の無い組織では CDP の画面は理由を出し、出力 API は 403（404 にしない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  for (const path of [CDP, `${CDP}/import`]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    const main = page.locator('#t4d-main');
    await expect(main.getByText('CDP 対応オプションは契約されていません').first()).toBeVisible();
    await expect(main.getByText('契約なし').first()).toBeVisible();
    await expect(main.getByText(/組織の管理者の画面からは有効にできません/)).toBeVisible();
    // 押しても使えない操作を並べない（その他・取込・出力が無い）
    await expect(main.locator('[data-more-menu]')).toHaveCount(0);
    await expect(main.locator('input[name="file"]')).toHaveCount(0);
  }
  const statuses = await page.evaluate(async () => ({
    cdp: (await fetch('/api/exports/cdp?format=csv')).status,
    csrd: (await fetch('/api/exports/cdp?framework=csrd&format=csv')).status,
  }));
  expect(statuses).toEqual({ cdp: 403, csrd: 200 });
});

test('契約のある組織: 一覧に担当・不足の列、「不足あり」「自分の担当」の保存ビュー、提供範囲の明記', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(CDP);
  const main = page.locator('#t4d-main');
  await expect(page.getByRole('heading', { level: 1, name: 'CDP 開示対応' })).toBeVisible();
  await expect(main.getByText('架空の縮小マスター（正式質問書ではありません）')).toBeVisible();
  await expect(main.locator('[data-cdp-scope]')).toContainText('CDP ポータルへの自動送信');

  const table = main
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: '不足' }) });
  await expect(table.getByRole('columnheader', { name: '担当' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '不足' })).toBeVisible();
  // 新規の記述式の質問（C12.1）は T4D の情報と結ばれておらず「未対応付け」
  await expect(table.locator('tbody tr', { hasText: 'C12.1' }).first()).toContainText('未対応付け');

  await page.goto(`${CDP}?gap=1`);
  const rows = page.locator('#t4d-main tbody tr[data-t4d-record]');
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) await expect(row).toContainText('不足');

  // 「その他」に承認済みだけの出力と DOCX がある（出力の権限があるとき）
  const menu = await openMoreMenu(main);
  await expect(menu.getByRole('menuitem', { name: '承認済みだけ XLSX で出力' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'DOCX（回答原稿）で出力' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('担当の一括割当: 件数と内訳を確認し、担当を選んで割り当てる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(CDP);
  const main = page.locator('#t4d-main');
  await main.getByLabel('C8.2 を選択').check();
  await main.getByLabel('C10.1 を選択').check();
  await expect(main.getByText('2 件を選択中')).toBeVisible();

  await main.getByRole('button', { name: '担当を割り当てる…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-confirm-scope]')).toContainText('選択した 2 件');
  await dialog.getByLabel('作成担当').selectOption({ label: DEMO_USERS.approver });
  await dialog.locator('[data-confirm-submit]').click();
  await expect(main.getByText('2 件の担当を割り当てました。')).toBeVisible();

  await page.goto(CDP);
  await expect(main.locator('tbody tr', { hasText: 'C8.2' }).first()).toContainText(
    DEMO_USERS.approver,
  );
  // 承認担当（承 花子）の「自分の担当」に出る
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${CDP}?owner=me`);
  await expect(page.locator('#t4d-main tbody tr', { hasText: 'C10.1' }).first()).toBeVisible();
});

test('版の選択は一覧に効く（過年度の版は確認用で、回答は始めない）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(CDP);
  await page.getByRole('link', { name: /CDP 2025/ }).click();
  await expect(page).toHaveURL(/version=/);
  const main = page.locator('#t4d-main');
  await expect(main.getByText('期間の質問書と違う版を表示しています')).toBeVisible();
  // 2025 年版には 2026 年の新規質問（C12.1）が無い
  await expect(main.getByRole('link', { name: 'C12.1', exact: true })).toHaveCount(0);
  await expect(main.getByRole('link', { name: 'C10.1', exact: true }).first()).toBeVisible();
  // 前の版との比較（版どうしを比べた結果）は 2026 年版で見る
  await page.goto(CDP);
  await expect(main.getByText(/前の版（CDP 2025（架空））との比較/)).toBeVisible();
});

test('回答画面: 担当の更新・T4D の情報の対応付け（追加・外す）・根拠の再利用', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await openQuestion(page, 'C8.2');
  const main = page.locator('#t4d-main');

  // 担当
  // （作成担当は一括割当の試験で承 花子。作成とレビューは別の人にする）
  await main.getByLabel('レビュー担当').selectOption({ label: DEMO_USERS.enterpriseAdmin });
  await main.getByRole('button', { name: '担当を更新' }).click();
  await settle(page);
  await expect(main.locator('[data-reviewer]')).toHaveText(DEMO_USERS.enterpriseAdmin);

  // 対応する T4D の情報（確認済みの定性情報を追加 → 外す）
  const data = main.locator('#question-data');
  await openSection(data);
  const addSection = data.locator('[data-form-section="optional"]', { hasText: '対応付けを追加' });
  await addSection.locator('summary').click();
  await addSection.getByLabel('対応付ける情報').selectOption({ label: '気候関連のガバナンス体制' });
  await addSection.getByRole('button', { name: '対応付けを追加' }).click();
  await settle(page);
  const narratives = main.locator('[data-linked-content="定性情報（確認済みの版）"]');
  await expect(narratives).toContainText('気候関連のガバナンス体制');
  await expect(narratives).toContainText('確認済みの版');

  await narratives.getByRole('button', { name: '外す…' }).first().click();
  await confirmInDialog(page);
  await settle(page);
  await expect(narratives).toContainText('対応付けた定性情報はありません。');

  // 根拠: 対応付けた指標（エネルギー）の承認済みデータの根拠を候補から選ぶ
  const evidence = main.locator('#question-evidence');
  await openSection(evidence);
  const candidates = evidence.locator('[data-evidence-candidates] li');
  await expect(candidates.first()).toBeVisible();
  const fileName = (await candidates.first().locator('span').first().innerText()).split('\n')[0]!;
  await candidates.first().getByRole('button', { name: '根拠にする…' }).click();
  await confirmInDialog(page);
  await settle(page);
  await expect(evidence.locator('[data-evidence-linked]')).toContainText(fileName.trim());
});

test('AI 草案: 説明は実際の入力どおり、埋められなかった情報を出す（AI は確定しない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await openQuestion(page, 'C12.1');
  const main = page.locator('#t4d-main');
  await expect(
    main.getByText(/承認済みデータ・前年回答と、この質問に対応付けた定性情報（確認済みの版）/),
  ).toBeVisible();
  await (await openMoreMenu(page)).getByRole('menuitem', { name: 'ドラフトを生成' }).click();
  await expect(main.getByText('Mock / AI未接続').first()).toBeVisible({ timeout: 30_000 });
  await expect(main.locator('[data-ai-missing]')).toContainText('AI が埋められなかった情報');
  await expect(
    main.getByText('AI 生成のままでは承認できません（DB 側でも禁止されています）。'),
  ).toBeVisible();
  // AI は候補の注記を閉じた節に入れない
  const candidate = main.getByText('AI の候補').first();
  await expect(candidate).toBeVisible();
});

test('職務分離: 現在の版を作った人は承認できず、別の承認者が承認する', async ({ page }) => {
  // 承認者（作成と承認を兼ねる）が自分で書いて依頼する
  await loginAs(page, DEMO_USERS.approver);
  const url = await openQuestion(page, 'C1.1b');
  await page.getByLabel('回答本文').fill('承認者が自分で書いた回答（職務分離の確認）');
  await page.getByRole('button', { name: '保存（下書き）' }).click();
  await settle(page);
  // 下書きのまま自分で承認する経路は無い（承認者は AI を使えないため「その他」自体が出ない。
  // 以前は「その他」に承認が入っていた）
  await expect(
    page.locator('#t4d-main [data-more-menu]').filter({ hasText: 'その他' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '承認', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'レビュー依頼' }).click();
  await settle(page);
  const approve = page.getByRole('button', { name: '承認', exact: true });
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await expect(
    page.getByText(
      '回答の現在の版を作成した人は承認できません。別の承認者に承認を依頼してください。',
    ),
  ).toBeAttached();

  // 作成担当（海野）が書き直して依頼すると、承認者が承認できる
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(url);
  await page.getByLabel('回答本文').fill('作成担当が書き直した回答（職務分離の確認）');
  await page.getByRole('button', { name: '保存（下書き）' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'レビュー依頼' }).click();
  await settle(page);

  await loginAs(page, DEMO_USERS.approver);
  await page.goto(url);
  await page.getByRole('button', { name: '承認', exact: true }).click();
  await settle(page);
  await expect(page.locator('#t4d-main').getByText('承認済み').first()).toBeVisible();
});

test('指標の対応付けを外し、AI の対応付けの候補を確定し直す（AI は確定しない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await openQuestion(page, 'C8.2');
  const main = page.locator('#t4d-main');
  const data = main.locator('#question-data');
  await openSection(data);
  const metricRow = data
    .locator('li', { has: page.getByRole('link', { name: '承認済みデータを見る' }) })
    .first();
  await expect(metricRow).toBeVisible();
  const metricName = (await metricRow.locator('span').first().innerText()).trim();
  await metricRow.getByRole('button', { name: '外す…' }).click();
  await expect(page.getByRole('dialog')).toContainText('指標の対応付けを外しますか');
  await confirmInDialog(page);
  await settle(page);
  await expect(
    data.locator('li', { has: page.getByRole('link', { name: '承認済みデータを見る' }) }),
  ).toHaveCount(0);

  // 一覧で AI の質問マッピング（候補）を出し、人が C8.2 の候補を確定する
  await page.goto(CDP);
  const menu = await openMoreMenu(page);
  await menu.getByRole('menuitem', { name: '質問マッピングを実行（AI）' }).click();
  await settle(page);
  const confirm = main.getByRole('button', { name: 'C8.2 の対応付けを確定' });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await settle(page);

  await openQuestion(page, 'C8.2');
  const after = page.locator('#question-data');
  await openSection(after);
  await expect(after).toContainText(metricName);
});

test('回答の無い年度: 保存で回答を始め、AI 草案でも回答を始める（読込では作らない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // 報告期間（ヘッダーの選択。Radix の Select）を FY2024 へ。FY2024 の CDP の回答は Fixture に無い
  const period = page.getByRole('combobox', { name: '報告期間' });
  await period.click();
  await page.getByRole('option', { name: 'FY2024', exact: true }).click();
  await expect(period).toContainText('FY2024');
  try {
    await openQuestion(page, 'C1.1b');
    const main = page.locator('#t4d-main');
    await expect(main.locator('[data-response-start]')).toContainText('回答を始めます');
    await page.getByLabel('回答本文').fill('E2E: FY2024 の回答を始める（架空）');
    await page.getByRole('button', { name: '保存（下書き）' }).click();
    await settle(page);
    await expect(main.locator('[data-response-start]')).toHaveCount(0);

    await openQuestion(page, 'C12.1');
    await expect(page.locator('#t4d-main [data-response-start]')).toBeVisible();
    await (await openMoreMenu(page)).getByRole('menuitem', { name: 'ドラフトを生成' }).click();
    await expect(page.locator('#t4d-main').getByText('Mock / AI未接続').first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    // 他の spec が見る報告期間（FY2026）へ戻す
    await page.getByRole('combobox', { name: '報告期間' }).click();
    await page.getByRole('option', { name: 'FY2026', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '報告期間' })).toContainText('FY2026');
  }
});
