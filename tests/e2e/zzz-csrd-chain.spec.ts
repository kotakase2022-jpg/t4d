import { expect, test, type Page } from '@playwright/test';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import {
  DEMO_USERS,
  carriesDemoState,
  carryDemoState,
  loginAs,
  peakCarriedCookieHeader,
  resetCarriedDemoState,
  resetDisclosureDemo,
  setDisclosureFirst,
} from './helpers';

/**
 * CSRD（ダブル・マテリアリティ）の一連の操作を、同じ期間（FY2026）の上で最後まで通す
 * （docs/disclosure-first.md §9.7 zzz-csrd-chain）。前の手順が作った状態を次の手順が使う:
 *
 *   対応状況（DMA 未確定・暫定）→ 設定 G1 で インパクト=重要でない・財務=重要＋根拠 → DMA 確定 →
 *   要求事項で G1-1/G1-4 が「適用（財務）」・暫定が消える → E1-6 詳細で AI 分析（デモ生成）→
 *   候補を採用 → 対応計画を追加 → 計画画面で対応中へ → 収集画面で scope2_location の収集項目を作成 →
 *   開示ドラフト E1 を生成 → 本文に採用 → 保存 → 確定（「両面」の文言、E5 は対象外）→
 *   要求事項の詳細から回答画面へ
 *
 * 通常の E2E と、リクエストごとに Fixture を作り直す構成（playwright.stateless.config.ts）の両方で流す。
 * 後者では状態が Cookie にしか無いため、各テストの後に Cookie を持ち回し（carryDemoState）、
 * 押し出し（容量不足で古い操作を捨てること）が 0 であることを確かめる。
 *
 * AI は MockAIProvider（決定論的）。D0 の Mock の動作の確認であり、本番モデルの試験ではない。
 * AI の出力は候補の列にだけ入り、採用・確定はすべて人の操作で行う（CLAUDE.md §0.4）。
 *
 * zzz- で始めているのは、Demo Mode の共有状態（CSRD の DMA・評価・計画・草案）を変えるため（最後に流す）。
 * 最後のテストで開示デモをリセットして CSRD の 6 表と、CSRD の計画から作った収集項目（本社の
 * scope2_location FY2026 の割当）を初期状態へ戻す（失敗した場合も afterAll で戻す）。リセットの後は、
 * 状況の表に計画の無い「収集依頼済み（未入力）」が残らず、同じサーバーへこの spec を流し直せる。
 */

test.describe.configure({ mode: 'serial' });

const BASE = '/enterprise/disclosures/csrd';
const E1_6 = CSRD_IDS.items['ESRS-E1-6']!;
const DETAIL_E1_6 = `${BASE}/requirements/${E1_6}`;
/** 回答画面（既存の共有ビュー）。要求事項の詳細（/csrd/requirements/{id}）と区別する */
const ANSWER_E1_6 = new RegExp(`${BASE}/${E1_6}$`);

const PLAN_TITLE = 'E2E Scope2 ロケーション基準の排出量を集める（架空）';
const IMPACT_RATIONALE = 'E2E: 贈収賄への関与の算定結果 2.2 は閾値 3.0 未満（架空）';
const FINANCIAL_RATIONALE = 'E2E: 制裁金の算定結果 3.2 は閾値 3.0 以上（架空）';
const BODY_SUFFIX = '（E2E: 担当者が確認して加筆。架空）';

/** 最後のテストで初期状態へ戻したか（途中で失敗したら afterAll で戻す） */
let restored = false;

const main = (page: Page) => page.locator('#t4d-main');
const flash = (page: Page) => page.getByRole('status');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const requirementsTable = (page: Page) => page.getByRole('table', { name: 'CSRD 要求事項の評価' });
const requirementRow = (page: Page, code: string) =>
  requirementsTable(page).locator('tbody tr', { hasText: code });

test.beforeAll(() => {
  // 前の spec（zz-disclosure-project）の Cookie を引き継がず、初期状態の Fixture から始める
  resetCarriedDemoState();
});

// 状態がリクエストごとに消えるサーバーの E2E では、前の手順の結果を Cookie だけで次の手順へ渡す
test.afterEach(async ({ context }, testInfo) => {
  await carryDemoState(context, testInfo.title);
});

/** 開示優先モードを一時的に有効にして開示デモをリセットし、無効へ戻す（管理者） */
async function restoreCsrdDemo(page: Page): Promise<void> {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  try {
    await page.goto('/enterprise/dashboard');
    await resetDisclosureDemo(page);
  } finally {
    await setDisclosureFirst(page, false);
  }
}

test.afterAll(async ({ browser }) => {
  if (carriesDemoState()) {
    const peak = peakCarriedCookieHeader();
    console.log(
      `[stateless] CSRD の流れの最大: Cookie ヘッダー ${peak.bytes}B（操作の記録 ${peak.editsBytes}B）— ${peak.label}`,
    );
  }
  if (restored) return;
  // 途中で失敗しても、後で同じサーバーを使う E2E が CSRD の初期状態（DMA 未確定）を見るように戻す
  const admin = await browser.newPage();
  try {
    await restoreCsrdDemo(admin);
  } finally {
    await admin.close();
  }
});

test('対応状況: DMA は未確定で、テーマ別の要求事項の適用は暫定（評価対象 9 / 12）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: /CSRD 開示対応/ })).toBeVisible();
  await expect(
    main(page).getByText('DMA が未確定のため、テーマ別の要求事項の適用は暫定です', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(main(page).getByText(/評価対象（常に適用・重要）\s*9 \/ 12\s*件/)).toBeVisible();
  await expect(main(page).getByText(/10 \/ 12 件の適用は DMA 確定前の暫定です/)).toBeVisible();

  // 設定（工程①）へ。G1 だけが未評価のため、まだ確定できない
  await main(page).getByRole('link', { name: '設定（報告範囲・DMA）を開く' }).click();
  await page.waitForURL(`**${BASE}/settings`);
  await expect(main(page).getByRole('button', { name: 'DMA を確定する' })).toBeDisabled();
  await expect(main(page).getByText(/未評価: G1 企業行動/)).toBeVisible();
  // 取り消す確定が無い間は、保存で「確定が取り消される」とは書かない（§10.4）
  await expect(main(page)).not.toContainText('保存すると DMA の確定は取り消されます');
});

test('DMA: G1 をインパクト=重要でない・財務=重要と根拠付きで判断し、DMA を確定する', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/settings`);
  const dma = page.getByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' });
  await dma.getByRole('link', { name: 'G1 企業行動' }).click();
  await page.waitForURL(`**${BASE}/settings/matters/G1`);

  // 算定結果は提案。判断は人が軸ごとに根拠を付けて行う
  const impact = page.getByRole('group', { name: /インパクト重要性/ });
  const financial = page.getByRole('group', { name: /財務的重要性/ });
  await impact.getByLabel('重要でない', { exact: true }).check();
  await impact.getByLabel('根拠（重要／重要でないを選んだときは必須）').fill(IMPACT_RATIONALE);
  await financial.getByLabel('重要', { exact: true }).check();
  await financial
    .getByLabel('根拠（重要／重要でないを選んだときは必須）')
    .fill(FINANCIAL_RATIONALE);
  await page.getByRole('button', { name: '判断を保存' }).click();
  await page.waitForURL(/flash=csrdMatterDecided/);
  await expect(flash(page)).toContainText('サステナビリティ事項の判断を保存しました');
  // 人の判断の結果は「財務のみ」。根拠は保存されている
  await expect(page.getByRole('heading', { level: 1, name: /G1 企業行動/ })).toBeVisible();
  await expect(main(page).getByText('財務のみ').first()).toBeVisible();
  await expect(page.getByRole('group', { name: /財務的重要性/ }).getByRole('textbox')).toHaveValue(
    FINANCIAL_RATIONALE,
  );

  // 10 事項すべてが判断済みになったので、人が DMA を確定する
  await page.goto(`${BASE}/settings`);
  await main(page).getByRole('button', { name: 'DMA を確定する' }).click();
  await page.waitForURL(/flash=csrdDmaConfirmed/);
  await expect(flash(page)).toContainText('ダブル・マテリアリティ評価（DMA）を確定しました');
  await expect(main(page).getByText('DMA 確定済み')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'DMA を確定する' })).toHaveCount(0);
  // 確定の後は、各フォームの保存で確定が取り消されることを閉じずに見せる
  await expect(
    main(page).getByText('保存すると DMA の確定は取り消されます（前提が変わるため）。'),
  ).toBeVisible();
  await expect(
    main(page).getByText('保存すると DMA の確定は取り消されます（人の判断は変わりません）。'),
  ).toBeVisible();
});

test('要求事項: G1-1・G1-4 が「適用（財務）」になり、暫定が消える（評価対象 11 / 12）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/requirements`);
  await expect(requirementsTable(page).locator('tbody tr')).toHaveCount(12);
  for (const code of ['ESRS-G1-1', 'ESRS-G1-4']) {
    await expect(requirementRow(page, code).getByText('適用（財務）')).toBeVisible();
  }
  await expect(requirementsTable(page)).not.toContainText('暫定（DMA 確定前）');
  // E5-5 は重要でない（対象外）のまま
  await expect(requirementRow(page, 'ESRS-E5-5').getByText('対象外（重要でない）')).toBeVisible();

  await page.goto(BASE);
  await expect(main(page).getByText(/評価対象（常に適用・重要）\s*11 \/ 12\s*件/)).toBeVisible();
  await expect(main(page).getByText(/の適用は DMA 確定前の暫定です/)).toHaveCount(0);
});

test('E1-6: AI ギャップ分析（デモ生成）→ 候補を採用 → 対応計画を追加する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(DETAIL_E1_6);
  await expect(page.getByRole('heading', { level: 1, name: /ESRS-E1-6/ })).toBeVisible();

  await page.getByRole('button', { name: 'AI ギャップ分析を実行（デモ生成）' }).click();
  await page.waitForURL(/flash=csrdGapAnalyzed/);
  await expect(flash(page)).toContainText('結果は候補です');
  await expect(main(page).getByText('デモ生成（Mock）').first()).toBeVisible();
  await expect(main(page).getByText('確認待ち', { exact: true })).toBeVisible();

  // AI の候補は人が採用して初めて確定する
  await page.getByRole('button', { name: '候補を採用' }).click();
  await page.waitForURL(/flash=csrdReviewSaved/);
  await expect(flash(page)).toContainText('AI の候補を採用して確定しました');
  await expect(main(page).getByText('確認待ち', { exact: true })).toHaveCount(0);

  const planForm = main(page)
    .locator('form')
    .filter({ has: page.getByRole('button', { name: '対応計画に追加' }) });
  // ラベルで包んだ入力欄は、名前に選択中の値が入る（例:「観点 開示」）ため、名前（name 属性）で指す
  await planForm.locator('select[name="gapKind"]').selectOption({ label: 'データ' });
  await planForm.locator('select[name="actionType"]').selectOption({ label: 'データ収集' });
  await planForm.locator('input[name="department"]').fill('環境管理部');
  await planForm.getByLabel('対応内容（必須）').fill(PLAN_TITLE);
  await planForm.locator('input[name="dueDate"]').fill('2026-11-30');
  await planForm.locator('select[name="priority"]').selectOption({ label: '高' });
  await planForm.getByRole('button', { name: '対応計画に追加' }).click();
  await page.waitForURL(/flash=csrdPlanCreated/);
  await expect(flash(page)).toContainText('対応計画を追加しました');
  const plans = page.getByRole('table', { name: 'この要求事項の対応計画' });
  await expect(plans.locator('tbody tr', { hasText: PLAN_TITLE })).toContainText('未着手');
});

test('対応計画: CSRD の計画画面で「対応中」へ更新する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/plans`);
  const table = page.getByRole('table', { name: 'CSRD 対応計画の一覧' });
  // Fixture の 2 件（E1-4・S1-9）＋追加した 1 件。SSBJ の計画は並ばない
  await expect(table.locator('tbody tr')).toHaveCount(3);
  const row = table.locator('tbody tr', { hasText: PLAN_TITLE });
  await expect(row.getByRole('link', { name: 'ESRS-E1-6' })).toHaveAttribute('href', DETAIL_E1_6);

  await row
    .getByRole('combobox', { name: `${PLAN_TITLE} の対応状況` })
    .selectOption({ label: '対応中' });
  await row.getByRole('button', { name: `${PLAN_TITLE} を更新` }).click();
  await page.waitForURL(/flash=csrdPlanUpdated/);
  await expect(flash(page)).toContainText('対応計画を更新しました');
  await expect(
    page
      .getByRole('table', { name: 'CSRD 対応計画の一覧' })
      .locator('tbody tr', { hasText: PLAN_TITLE })
      .getByRole('combobox', { name: `${PLAN_TITLE} の対応状況` }),
  ).toHaveValue('in_progress');
});

test('データ収集: 状況の表から scope2_location の収集項目を計画から作成する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/collection`);
  const status = page.getByRole('table', {
    name: '評価対象の要求事項 × 指標 × 拠点の当期の状況',
  });
  // scope2_location は当期のデータも割当も無い（全拠点で未入力）。0 として扱わない
  const s2Row = status.locator('tbody tr', { hasText: 'scope2_location' });
  await expect(s2Row).toHaveCount(1);
  await expect(s2Row).toContainText('未入力');
  await s2Row.getByRole('link', { name: '収集項目を作成' }).click();
  await page.waitForURL(/[?&]metric=scope2_location/);

  // 状況の表から来ると、計画と指標が初期値に入る（URL の値はサーバーが照合する）
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: '収集項目を作成' }) });
  const planSelect = form.getByRole('combobox', { name: '対象の対応計画' });
  await expect(planSelect.locator('option:checked')).toContainText(PLAN_TITLE);
  await expect(form.getByRole('combobox', { name: 'データ項目コード' })).toHaveValue(
    'scope2_location',
  );
  await form
    .getByRole('combobox', { name: '集計対象範囲（拠点）' })
    .selectOption({ label: '本社' });
  await form.getByRole('button', { name: '収集項目を作成' }).click();
  await page.waitForURL(/flash=csrdCollectionCreated/);
  await expect(flash(page)).toContainText('データ収集項目を作成しました（scope2_location）');

  const created = page.getByRole('table', { name: '計画から作成した収集項目' });
  const createdRow = created.locator('tbody tr', { hasText: 'scope2_location' });
  await expect(createdRow).toHaveCount(1);
  await expect(createdRow).toContainText('本社');
  await expect(createdRow).toContainText(PLAN_TITLE);
  await expect(createdRow).toContainText('未入力');
  // 状況の表では、本社に収集を依頼済み（値はまだ無い）
  await expect(
    page
      .getByRole('table', { name: '評価対象の要求事項 × 指標 × 拠点の当期の状況' })
      .locator('tbody tr', { hasText: 'scope2_location' }),
  ).toContainText('収集依頼済み（未入力）');

  // 次の工程は開示ドラフト
  await expect(main(page).getByRole('link', { name: 'CSRD 開示ドラフト' })).toHaveAttribute(
    'href',
    `${BASE}/draft`,
  );
});

test('開示ドラフト: E1 を生成 → 本文に採用 → 保存 → 確定する。E5 は対象外のまま', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`${BASE}/draft`);
  await expect(main(page).getByText(/DMA）は確定済みです/)).toBeVisible();
  const e1 = () => page.getByRole('region', { name: 'E1 気候変動' });

  await e1().getByRole('button', { name: 'AI 草案を作成（デモ生成）' }).click();
  await page.waitForURL(/flash=csrdDraftGenerated/);
  await expect(flash(page)).toContainText('本文には入っていません');
  // AI 草案は候補の枠に出る。両面で重要と判断した事項であることを明示する
  await expect(e1()).toContainText('AI 草案（候補・デモ生成）');
  await expect(e1()).toContainText('インパクトと財務の両面で重要と判断');
  await expect(e1().getByRole('textbox', { name: 'E1 気候変動の本文' })).toHaveValue('');

  // 人が本文に採用し、加筆して保存し、保存済みの本文で確定する
  await e1().getByRole('button', { name: '本文に採用' }).click();
  await page.waitForURL(/flash=csrdDraftAdopted/);
  const body = e1().getByRole('textbox', { name: 'E1 気候変動の本文' });
  await expect(body).toHaveValue(/インパクトと財務の両面で重要と判断/);
  const adopted = await body.inputValue();
  await body.fill(`${adopted}${BODY_SUFFIX}`);
  await e1().getByRole('button', { name: '本文を保存' }).click();
  await page.waitForURL(/flash=csrdDraftSaved/);
  await expect(e1()).toContainText('AI 草案から担当者が修正');
  await e1().getByRole('button', { name: '保存済みの本文で確定' }).click();
  await page.waitForURL(/flash=csrdDraftConfirmed/);
  await expect(flash(page)).toContainText('本文を確定しました');
  await expect(e1()).toContainText(/確定: .+（海野 みどり）/);
  await expect(e1().getByRole('textbox', { name: 'E1 気候変動の本文' })).toHaveValue(
    `${adopted}${BODY_SUFFIX}`,
  );

  // E5 は重要でない（対象外）のため作れない。G1 は財務のみで評価対象になり、作れるようになった
  const e5 = page.getByRole('region', { name: 'E5 資源利用と循環経済' });
  await expect(e5).toContainText('対象外');
  await expect(e5.getByRole('button')).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'G1 企業行動' })
      .getByRole('button', { name: 'AI 草案を作成（デモ生成）' }),
  ).toBeVisible();
  // 定性情報（全基準共通の資産）へは右上から
  await expect(main(page).getByRole('link', { name: '定性情報' })).toHaveAttribute(
    'href',
    '/enterprise/narratives',
  );
});

test('要求事項の詳細から回答画面（版・承認）へ進み、要求事項の評価へ戻れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(DETAIL_E1_6);
  // 担当者が採用した評価と、追加した計画（対応中）・収集項目が詳細に出る
  await expect(main(page).getByText('デモ生成（Mock）').first()).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'この要求事項の対応計画' })
      .locator('tbody tr', { hasText: PLAN_TITLE }),
  ).toContainText('対応中');

  await main(page).getByRole('link', { name: '回答を編集（版・承認）' }).click();
  await page.waitForURL(ANSWER_E1_6);
  await expect(page.getByRole('heading', { name: /ESRS-E1-6/ }).first()).toBeVisible();
  // 回答画面でも、左メニューの現在地は CSRD の「要求事項」（2 階層目以下の現在地は 1 つ）
  const csrdList = sidebar(page).getByRole('list', { name: 'CSRD', exact: true });
  await expect(csrdList.locator('a[aria-current="page"]')).toHaveText('要求事項');

  await main(page).getByRole('link', { name: '要求事項の評価へ戻る' }).click();
  await page.waitForURL(`**${DETAIL_E1_6}`);
  await expect(page.getByRole('heading', { level: 1, name: /ESRS-E1-6/ })).toBeVisible();
});

test('開示デモのリセットで、CSRD の DMA・評価・計画・草案が初期状態へ戻る', async ({ page }) => {
  await restoreCsrdDemo(page);
  restored = true;

  await page.goto(BASE);
  await expect(
    main(page).getByText('DMA が未確定のため、テーマ別の要求事項の適用は暫定です', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(main(page).getByText(/評価対象（常に適用・重要）\s*9 \/ 12\s*件/)).toBeVisible();
  await page.goto(`${BASE}/plans`);
  await expect(
    page.getByRole('table', { name: 'CSRD 対応計画の一覧' }).locator('tbody tr'),
  ).toHaveCount(2);
  await page.goto(`${BASE}/draft`);
  await expect(
    page.getByRole('region', { name: 'E1 気候変動' }).getByRole('button', {
      name: 'AI 草案を作成（デモ生成）',
    }),
  ).toBeVisible();
  // CSRD の計画から作った収集項目（本社の scope2_location）も戻る（計画の無い割当を残さない）
  await page.goto(`${BASE}/collection`);
  const s2Row = page
    .getByRole('table', { name: '評価対象の要求事項 × 指標 × 拠点の当期の状況' })
    .locator('tbody tr', { hasText: 'scope2_location' });
  await expect(s2Row).toHaveCount(1);
  await expect(s2Row).not.toContainText('収集依頼済み');
  await expect(
    page.getByRole('table', { name: '計画から作成した収集項目' }).locator('tbody tr', {
      hasText: 'scope2_location',
    }),
  ).toHaveCount(0);
  // 開示優先モードは既定（OFF）へ戻した
  await expect(sidebar(page).getByRole('link', { name: '開示対応', exact: true })).toBeVisible();
});
