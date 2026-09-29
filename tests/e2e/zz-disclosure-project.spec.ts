import fs from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { dataPointId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { parseDocx } from '@/lib/imports/docx-text';
import {
  DEMO_USERS,
  carriesDemoState,
  carryDemoState,
  loginAs,
  peakCarriedCookieHeader,
  switchDemoRole,
} from './helpers';

/**
 * 開示優先モード（D0 デモ）の一連の業務を、同じプロジェクト（FY2026）の上で最後まで通す。
 * 指示書 §15「P1 の E2E」: CSV 登録 → 数値確認 → 定性登録 → 根拠引用 → 原稿 → レビュー差戻し →
 * 再提出 → 承認 → DOCX 出力 → 元データ訂正 → 再確認。作業を別々の Fixture で成功させず、
 * 前のテストが作った状態（取り込んだ数値・登録した定性情報・引用位置・原稿の版）を次が使う。
 *
 * AI 下書きは MockAIProvider（決定論的）で動かす。D0 の Mock 動作の検証であり、本番モデルの試験ではない。
 * 役割の切替はヘッダーの「役割切替（デモ）」（デモ専用機構）を使う。
 *
 * zz- で始めているのは、Demo Mode の共有状態（機能設定・数値・原稿）を変えるため。
 * 最後に開示デモをリセットし、開示優先モードを OFF に戻す（失敗した場合も afterAll で戻す）。
 * 数値データはリセットの対象外（欧州販売子会社の水使用量 FY2026 は訂正した値のまま残る）。
 */

test.describe.configure({ mode: 'serial' });

const PROJECT = IDS.projects.fy2026;
const PROJECT_PATH = `/enterprise/disclosure-projects/${PROJECT}`;
const blockPath = (blockId: string) => `${PROJECT_PATH}/blocks/${blockId}`;
const RISK = IDS.blocks.fy2026RiskOpportunity.block;
const ESRS = IDS.blocks.fy2026Esrs40aGovernance.block;
const METRICS = IDS.blocks.fy2026Metrics.block;

/** 取り込み・訂正する数値（欧州販売子会社 / 水使用量 / FY2026。証跡必須ではない指標） */
const WATER_EU_FY2026 = dataPointId('EU', 'water', 'FY2026');
const IMPORTED_VALUE = '23480.5';
const IMPORTED_DISPLAY = '23,480.5 m3';
const CORRECTED_VALUE = '23512.8';
const CORRECTED_DISPLAY = '23,512.8 m3';

const NARRATIVE_TITLE = 'E2E 委員会でのリスク・機会の審議（架空）';
const COMMITTEE_FRAGMENT = '識別したリスク及び機会を審議した';
const METRIC_SENTENCE_HEAD = 'E2E確認: 欧州販売子会社の2026年度の水使用量は';
const FIX_SUFFIX = '（集計範囲は欧州販売子会社の全拠点）';
const INTERNAL_COMMENT = 'E2E社内メモ: 集計範囲の書き方は社内の表記基準に合わせています。';
const RETURN_REASON = 'E2E: 数値の集計範囲を本文に明記してください。';

function standardCsv(value: string): Buffer {
  const rows = [
    'metric_code,period_start,period_end,entity_code,value,unit,source_reference',
    `water,2026-04-01,2027-03-31,EU,${value},m3,欧州販売子会社 検針票の再集計（架空）`,
  ];
  // 表計算ソフトから保存した CSV と同じく BOM 付き UTF-8 にする
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  return Buffer.concat([bom, Buffer.from(`${rows.join('\n')}\n`, 'utf-8')]);
}

const editorBody = (page: Page) => page.getByRole('region', { name: '本文' });
const rightPane = (page: Page) => page.getByRole('complementary', { name: '根拠パネル' });

async function gotoBlock(page: Page, blockId: string): Promise<void> {
  await page.goto(blockPath(blockId));
  await expect(editorBody(page)).toBeVisible();
}

/** 段落の入力欄と、段落の枠（参照・表示を含む） */
function paragraph(page: Page, paragraphId: string): { input: Locator; item: Locator } {
  return {
    input: page.locator(`[id="para-input-${paragraphId}"]`),
    item: page.locator(`[id="para-${paragraphId}"]`),
  };
}

/** 末尾に段落を足し、フォーカスが移った新しい段落の ID を返す */
async function addParagraph(page: Page): Promise<string> {
  await editorBody(page).getByRole('button', { name: '末尾に段落を追加' }).click();
  const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '');
  await expect.poll(focusedId).toMatch(/^para-input-/);
  return (await focusedId()).replace(/^para-input-/, '');
}

/** 数値参照を入れた段落（差戻し・修正・出力の確認で使う） */
let metricParagraphId = '';

/** 標準 CSV を検証 → 差分を確かめて → 登録を確定する */
async function importStandardCsv(
  page: Page,
  file: { name: string; buffer: Buffer },
  reason: string,
): Promise<Locator> {
  await page.goto('/enterprise/imports/standard');
  await page
    .locator('#standard-csv-file')
    .setInputFiles({ name: file.name, mimeType: 'text/csv', buffer: file.buffer });
  await page.getByRole('button', { name: '検証する（まだ登録しません）' }).click();
  const diff = page.locator('section[aria-labelledby="standard-diff-title"]');
  await expect(diff).toBeVisible();
  // UX-F14: 検証の結果（エラーの件数を含む）を読み上げ、フォーカスを結果の見出しへ移す
  await expect(
    page.getByRole('status').filter({ hasText: '検証しました（まだ登録していません）' }),
  ).toContainText('エラー 0 行');
  await expect(page.getByRole('heading', { name: '3. 検証' })).toBeFocused();
  const row = diff.locator('tbody tr').filter({ hasText: 'water' });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('変更', { exact: true })).toBeVisible();
  await page.getByLabel(/変更理由（必須・新しい版に残ります/).fill(reason);
  await page.getByRole('button', { name: '登録を確定' }).click();
  await expect(page.getByRole('status').filter({ hasText: '登録を確定しました' })).toContainText(
    '新しい版 1 件',
  );
  return row;
}

async function downloadDocx(page: Page, link: Locator): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const filePath = await download.path();
  const parsed = await parseDocx(new Uint8Array(await fs.readFile(filePath)));
  expect(parsed.status).toBe('parsed');
  return parsed.paragraphs.join('\n');
}

/**
 * 出力 API をブラウザ内の fetch で呼び、本文と内容ハッシュ（X-T4D-Content-Hash）を得る。
 * page.request は Secure 属性のセッション Cookie を http://127.0.0.1 へ送らないため使わない。
 */
async function fetchDocx(page: Page, href: string): Promise<{ text: string; hash: string }> {
  const response = await page.evaluate(async (url) => {
    const res = await fetch(url);
    const bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
    return { status: res.status, hash: res.headers.get('x-t4d-content-hash') ?? '', bytes };
  }, href);
  expect(response.status).toBe(200);
  const parsed = await parseDocx(new Uint8Array(response.bytes));
  expect(parsed.status).toBe('parsed');
  return { text: parsed.paragraphs.join('\n'), hash: response.hash };
}

/** 出力した文書の本文を試験結果に残す（DOCX の中身を後から人が確かめられるように） */
async function attachText(name: string, text: string): Promise<void> {
  const file = test.info().outputPath(`${name.replace(/[^\w一-龠ぁ-んァ-ヶー]+/g, '_')}.txt`);
  await fs.writeFile(file, text, 'utf-8');
  await test.info().attach(name, { path: file, contentType: 'text/plain' });
}

/** 承認済みスナップショットの対外用 DOCX（SSBJ）の URL。後の「訂正後も不変」の比較に使う */
let approvedExternalDocxHref = '';
let approvedExternalContentHash = '';

async function setDisclosureFirst(page: Page, on: boolean): Promise<void> {
  await page.goto('/enterprise/settings');
  await page.getByLabel(on ? '有効にする' : '無効にする（従来の構成）').check();
  await page
    .locator('form')
    .filter({ has: page.getByRole('group', { name: '開示優先モード' }) })
    .getByRole('button', { name: '保存' })
    .click();
  await page.waitForURL(new RegExp(`flash=disclosureFirstChanged&state=${on ? 'on' : 'off'}`));
}

/** 開示デモのリセット（ホームの開示業務タブにある。開示優先モードが ON のときだけ表示される） */
async function resetDisclosureDemo(page: Page): Promise<void> {
  await page.getByLabel('上記の範囲だけを初期状態へ戻すことを確認しました').check();
  await page.getByRole('button', { name: '開示デモを初期状態に戻す' }).click();
  await page.waitForURL(/flash=disclosureDemoReset/);
  await expect(page.getByText(/開示デモのデータを初期状態に戻しました/)).toBeVisible();
}

// 状態がリクエストごとに消えるサーバーの E2E（playwright.stateless.config.ts）では、前の手順の結果を
// Cookie だけで次の手順へ渡す（実演の発表者と同じく 1 つのブラウザを使い続ける）。通常の E2E では何もしない
test.afterEach(async ({ context }, testInfo) => {
  await carryDemoState(context, testInfo.title);
});

test.afterAll(async ({ browser }) => {
  if (carriesDemoState()) {
    const peak = peakCarriedCookieHeader();
    console.log(
      `[stateless] 実演の流れの最大: Cookie ヘッダー ${peak.bytes}B（操作の記録 ${peak.editsBytes}B）— ${peak.label}`,
    );
  }
  // 途中で失敗しても、後続の spec が既定の状態（開示デモ初期状態・開示優先モード OFF）を見るように戻す。
  // 正常に最後まで進んだ場合は最後のテストで戻し済みで、ここでは何も変わらない
  const author = await browser.newPage();
  try {
    await loginAs(author, DEMO_USERS.sustainability);
    await author.goto('/enterprise/dashboard');
    const resetVisible = await author
      .getByRole('button', { name: '開示デモを初期状態に戻す' })
      .isVisible();
    if (resetVisible) await resetDisclosureDemo(author);
  } finally {
    await author.close();
  }
  const admin = await browser.newPage();
  try {
    await loginAs(admin, DEMO_USERS.enterpriseAdmin);
    await setDisclosureFirst(admin, false);
  } finally {
    await admin.close();
  }
});

test('A01: 管理者が開示優先モードを有効にすると、新しいメニューと開示業務のホームに切り替わる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  await expect(page.getByText(/開示優先モードを有効にしました/)).toBeVisible();

  const sidebar = page.getByRole('navigation', { name: 'メインナビゲーション' });
  for (const label of ['開示プロジェクト', '情報・根拠', 'ESG経営', 'タスク・承認']) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  // 既存の画面は新しいツリーのどこかから開ける（URL は変わらない）
  await expect(sidebar.getByRole('link', { name: '定量データ', exact: true })).toHaveAttribute(
    'href',
    '/enterprise/data',
  );
  await expect(
    sidebar.getByRole('link', { name: 'Scope3データ取込', exact: true }),
  ).toHaveAttribute('href', '/enterprise/ghg/suppliers');
  await expect(sidebar.getByRole('link', { name: '開示対応', exact: true })).toHaveCount(0);

  // ホームは「開示業務」タブ: 4 カード・自分の作業・分母付きの進捗
  await switchDemoRole(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await expect(
    page
      .getByRole('navigation', { name: 'ホームの表示切替' })
      .getByRole('link', { name: '開示業務' }),
  ).toHaveAttribute('aria-current', 'page');
  const cards = page.getByRole('region', { name: '開示の状況' }).getByRole('listitem');
  await expect(cards).toHaveCount(4);
  for (const label of ['未解決の必須情報', 'レビュー待ち', '承認後に変更が発生', '次の提出期限']) {
    await expect(cards.filter({ hasText: label })).toHaveCount(1);
  }
  await expect(page.getByText(/自分が次に行う作業（[1-9]\d* 件/)).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'リスク及び機会' }).getByRole('link'),
  ).toBeVisible();
  await expect(page.getByText(/適用確定済み \d+ 項目中、承認済み \d+ 項目/)).toBeVisible();
  await expect(page.getByText(/適用未判定 \d+ 件/)).toBeVisible();
  // 報告期間の日付は 1 回だけ（期間名に日付が入っているため重ねて出さない）
  await expect(page.getByText(/^青海テクノロジー株式会社 ／ 2026年度/)).toHaveText(
    '青海テクノロジー株式会社 ／ 2026年度（2026-04-01〜2027-03-31）',
  );
});

test('CSV 登録（訂正行）→ 数値確認（旧版と変更理由・二重登録なし・提出と承認）', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await loginAs(page, DEMO_USERS.sustainability);

  const row = await importStandardCsv(
    page,
    { name: 'eu-water-fy2026.csv', buffer: standardCsv(IMPORTED_VALUE) },
    'E2E: 検針票の再集計により訂正',
  );
  // 差分: 取り込んだ値と既存の版（旧値は残す）
  await expect(row).toContainText('23,480.5');
  await expect(row).toContainText(/v\d+/);

  // 同じ内容を名前を変えて検証し直しても、変更なしとして扱い版を作らない（A03）
  await page.getByRole('button', { name: '続けて登録する' }).click();
  await page.locator('#standard-csv-file').setInputFiles({
    name: 'eu-water-fy2026-copy.csv',
    mimeType: 'text/csv',
    buffer: standardCsv(IMPORTED_VALUE),
  });
  await page.getByRole('button', { name: '検証する（まだ登録しません）' }).click();
  const duplicate = page
    .locator('section[aria-labelledby="standard-diff-title"] tbody tr')
    .filter({ hasText: 'water' });
  await expect(duplicate.getByText('変更なし', { exact: true })).toBeVisible();
  await expect(duplicate).toContainText('既存の値と同じため、新しい版は作りません');

  // 数値確認: 台帳に新しい版が追加され、旧版と変更理由が残る（A04）
  await page.goto(`/enterprise/data/${WATER_EU_FY2026}`);
  await expect(page.getByRole('heading', { name: '水使用量 — 欧州販売子会社' })).toBeVisible();
  const history = page.locator('table').filter({ hasText: '変更理由' }).last();
  const current = history.getByRole('row').filter({ hasText: '現在' });
  await expect(current).toContainText('23,480.5');
  await expect(current).toContainText('E2E: 検針票の再集計により訂正');
  expect(await history.locator('tbody tr').count()).toBeGreaterThanOrEqual(2);

  // 提出 → 承認の道筋（5 段階）を役割切替で通す（取り込んだ値は自動承認しない）
  await page.getByRole('button', { name: '提出', exact: true }).click();
  await expect(page.getByText('承認フロー（0 / 5 段階）')).toBeVisible();
  const stageActors = [
    DEMO_USERS.reviewer,
    DEMO_USERS.sustainability,
    DEMO_USERS.reviewer,
    DEMO_USERS.enterpriseAdmin,
    DEMO_USERS.approver,
  ];
  for (const [index, actor] of stageActors.entries()) {
    await switchDemoRole(page, actor);
    const approveStage = page.getByRole('button', { name: /「.+」を承認/ });
    await expect(approveStage, `${actor} が ${index + 1} 段目を承認できない`).toBeVisible();
    await approveStage.click();
    await expect(page.getByText(`承認フロー（${index + 1} / 5 段階）`)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /「.+」を承認/ })).toHaveCount(0);
});

test('定性情報を登録し、委員会資料の一部を根拠として引用する', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/narratives/new');
  await page.locator('#nv-theme').selectOption('risk_opportunity');
  await page.locator('#nv-title').fill(NARRATIVE_TITLE);
  await page
    .locator('#nv-body')
    .fill(
      '2026年度第3回サステナビリティ委員会で、気候関連リスク・機会の評価資料に基づき、識別したリスク及び機会を審議しました。財務的影響の算定は継続中です。',
    );

  const documents = page.locator('aside[aria-labelledby="doc-pane-title"]');
  const committee = await documents
    .locator('#doc-select option', { hasText: '第3回サステナビリティ委員会' })
    .getAttribute('value');
  expect(committee).toBeTruthy();
  await documents.locator('#doc-select').selectOption(committee ?? '');
  const fragment = documents.getByRole('listitem').filter({ hasText: COMMITTEE_FRAGMENT });
  await fragment.getByRole('button', { name: 'この箇所を引用' }).click();
  // 段落全体ではなく、その一部だけを引用する
  await fragment.getByLabel(/引用する文言/).fill(COMMITTEE_FRAGMENT);
  await fragment.getByRole('button', { name: '根拠として追加' }).click();
  await expect(documents.getByText('根拠に加えました')).toBeVisible();
  const anchors = page.locator('section[aria-labelledby="nv-anchors"]');
  await expect(anchors).toContainText(`「${COMMITTEE_FRAGMENT}」`);
  await expect(anchors).toContainText('第3章 3.1 第1段落');

  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL(/\/enterprise\/narratives\/[0-9a-f-]+\?flash=narrativeCreated/);
  await expect(page.locator('section[aria-labelledby="nv-anchors"]')).toContainText(
    COMMITTEE_FRAGMENT,
  );
  // 人が内容を確認して初めて「確認済み」（AI・取込で自動確認しない）
  await page.getByRole('button', { name: '内容を確認済みにする（人の確認）' }).click();
  await page.waitForURL(/flash=narrativeConfirmed/);
  await expect(page.getByRole('button', { name: '確認済み' })).toBeDisabled();
});

test('原稿: 数値参照と定性情報の引用を挿入し、AI 下書き（Mock）の 1 段落を採用して版を作り、レビューを依頼する', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);

  // ホーム → FY2026 のプロジェクト → 原稿 → リスク及び機会（A02: 対象期間が一致）
  await page.goto('/enterprise/dashboard');
  await page.getByRole('link', { name: 'FY2026 統合開示（SSBJ・CSRD域外準備）' }).first().click();
  await page.waitForURL(new RegExp(`${PROJECT_PATH}$`));
  await expect(page.getByText('報告期間 FY2026（2026-04-01〜2027-03-31）')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'プロジェクトのタブ' })
    .getByRole('link', { name: '原稿' })
    .click();
  await page.waitForURL(/tab=manuscripts/);
  await page.getByRole('link', { name: 'リスク及び機会', exact: true }).click();
  await page.waitForURL(new RegExp(`${blockPath(RISK)}$`));
  const editor = editorBody(page);
  const pane = rightPane(page);
  await expect(editor).toBeVisible();

  // 数値参照（CSV で取り込み、承認まで通した版）
  metricParagraphId = await addParagraph(page);
  const { input: metricParagraph, item: metricItem } = paragraph(page, metricParagraphId);
  await metricParagraph.fill(`${METRIC_SENTENCE_HEAD} `);
  await pane.getByRole('tab', { name: '関連数値' }).click();
  await pane.getByLabel('数値を絞り込む').fill('欧州販売子会社');
  const candidate = pane.getByRole('listitem').filter({
    has: page.getByRole('button', {
      name: `水使用量（欧州販売子会社）${IMPORTED_DISPLAY} を本文へ挿入`,
    }),
  });
  await expect(candidate.getByText('承認済み', { exact: true })).toBeVisible();
  await candidate.getByRole('button', { name: /を本文へ挿入/ }).click();
  await expect(metricParagraph).toHaveValue(/⟦[^⟧]+⟧$/);
  await metricParagraph.fill(`${await metricParagraph.inputValue()} です。`);
  await expect(metricItem).toContainText(`${METRIC_SENTENCE_HEAD} ${IMPORTED_DISPLAY} です。`);

  // 定性情報の引用（登録・確認した版）
  const quoteParagraph = paragraph(page, await addParagraph(page)).input;
  await pane.getByRole('tab', { name: '根拠資料' }).click();
  const narrative = pane.getByRole('listitem').filter({ hasText: NARRATIVE_TITLE });
  await expect(narrative.getByText('確認済みの版')).toBeVisible();
  await narrative.getByRole('button', { name: '引用を挿入' }).click();
  await expect(quoteParagraph).toHaveValue(/^⟦[^⟧]+⟧$/);

  // AI 下書き（Mock）: 選んだ根拠（登録した定性情報と、委員会資料の引用位置）だけから候補を出す
  await pane
    .getByRole('checkbox', { name: `定性情報「${NARRATIVE_TITLE}」を AI の根拠に使う` })
    .check();
  await pane
    .getByRole('checkbox', {
      name: /第3回サステナビリティ委員会 資料（架空）\.txt 第3章 3\.1 第1段落 を AI の根拠に使う/,
    })
    .check();
  await expect(editor.getByText('選択中の根拠: 2 件')).toBeVisible();
  await expect(editor.getByText('デモ生成（Mock）')).toBeVisible();
  await editor.getByRole('button', { name: '選択した根拠から下書き' }).click();
  await expect(editor.getByText('本文の候補（差分プレビュー）')).toBeVisible();
  const paragraphsBefore = await editor.locator('textarea').count();
  await editor.getByRole('button', { name: 'この段落を採用' }).first().click();
  await expect(editor.getByText('AI 候補を採用').first()).toBeVisible();
  expect(await editor.locator('textarea').count()).toBeGreaterThanOrEqual(paragraphsBefore);
  // 残りの候補は採用しないまま確認を終える（未採用の候補を残すとレビューを依頼できない）
  await editor.getByRole('button', { name: '候補の確認を終える' }).click();
  await expect(editor.getByRole('button', { name: '候補の確認を終える' })).toHaveCount(0);

  // 版として保存 → レビュー依頼
  await page.getByRole('button', { name: '版として保存' }).click();
  await page.locator('#change-reason').fill('E2E: 数値参照・定性情報・AI 候補の採用を反映');
  await page.getByRole('button', { name: 'この内容で版を作る' }).click();
  await page.waitForURL(/flash=blockVersionSaved&version=2/);
  await expect(page.getByText('本文を版 2 として保存しました')).toBeVisible();
  await expect(editor).toContainText(`${METRIC_SENTENCE_HEAD} ${IMPORTED_DISPLAY} です。`);

  await page.getByRole('button', { name: 'レビュー依頼', exact: true }).click();
  await page.waitForURL(/flash=reviewRequested/);
  await expect(page.getByText('レビューを依頼しました')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /レビュー・承認（版 2 を審査中）/ }),
  ).toBeVisible();

  // ESRS-40a 準備の節も同じ規則でレビューへ回す（確定には適用する基準の全節の承認が要る）
  await gotoBlock(page, ESRS);
  await page.getByRole('button', { name: 'レビュー依頼', exact: true }).click();
  await page.waitForURL(/flash=reviewRequested/);

  // 指標の節: 引用した Scope1 に承認後の新版がある → 再確認（引用中の版を理由付きで維持）
  await page.goto(`${blockPath(METRICS)}/recheck`);
  const recheckItem = page.locator('#t4d-main').getByRole('heading', { name: /Scope1 排出量/ });
  await expect(recheckItem).toBeVisible();
  await expect(page.getByText('再確認が必要', { exact: true }).first()).toBeVisible();
  await page
    .getByLabel('引用中の版を維持する理由（必須）')
    .first()
    .fill('E2E: 訂正は集計範囲の注記のみで、本文が引用した承認済みの値は変わらないため');
  await page.getByRole('button', { name: '引用中の版を維持' }).first().click();
  await page.waitForURL(/flash=recheckDecided&decision=keep_old/);
  await expect(page.getByText('引用中の版を維持と判断済み').first()).toBeVisible();
});

test('レビュー: 差戻し → 修正・再提出 → レビュー完了 → 作成者は承認できない → 最終承認', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await gotoBlock(page, RISK);

  // レビュアー: 社内コメント（参考）を残し、段落を指定して理由付きで差し戻す
  await switchDemoRole(page, DEMO_USERS.reviewer);
  const pane = rightPane(page);
  await pane.getByRole('tab', { name: /コメント/ }).click();
  expect(metricParagraphId).not.toBe('');
  await pane.getByLabel('対象の段落').selectOption(metricParagraphId);
  await pane.locator('#new-comment').fill(INTERNAL_COMMENT);
  await pane.getByRole('button', { name: 'コメントする' }).click();
  await expect(pane.getByText(INTERNAL_COMMENT)).toBeVisible();

  await page.getByLabel('差戻しの対象の段落（必須）').selectOption(metricParagraphId);
  await page.getByLabel('差戻しの理由（必須）').fill(RETURN_REASON);
  await page.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForURL(/flash=reviewReturned/);
  await expect(page.getByText('差し戻しました（理由と対象の段落を記録しました）。')).toBeVisible();

  // ESRS-40a 準備の節はレビューを完了して最終承認へ回す
  await gotoBlock(page, ESRS);
  await page.getByRole('button', { name: 'レビューを完了する' }).click();
  await page.waitForURL(/flash=reviewCompleted/);

  // 作成担当: 差し戻された段落を直して版を作り、再提出する
  await gotoBlock(page, RISK);
  await switchDemoRole(page, DEMO_USERS.sustainability);
  await expect(page.getByText(RETURN_REASON).first()).toBeAttached();
  const metricParagraph = paragraph(page, metricParagraphId).input;
  const before = await metricParagraph.inputValue();
  expect(before).toMatch(/です。$/);
  await metricParagraph.fill(before.replace(/です。$/, `です${FIX_SUFFIX}。`));
  await page.getByRole('button', { name: '版として保存' }).click();
  await page.locator('#change-reason').fill('E2E: 差戻しを受けて集計範囲を明記');
  await page.getByRole('button', { name: 'この内容で版を作る' }).click();
  await page.waitForURL(/flash=blockVersionSaved&version=3/);
  await page.getByRole('button', { name: 'レビュー依頼', exact: true }).click();
  await page.waitForURL(/flash=reviewRequested/);
  await expect(
    page.getByRole('heading', { name: /レビュー・承認（版 3 を審査中）/ }),
  ).toBeVisible();

  // レビュアー: レビュー完了（参考コメントは阻害しない）
  await switchDemoRole(page, DEMO_USERS.reviewer);
  await page.getByRole('button', { name: 'レビューを完了する' }).click();
  await page.waitForURL(/flash=reviewCompleted/);

  // 作成担当は最終承認できない（ボタンを出さず、理由を示す。サーバー側でも職務分離で拒否する）
  await switchDemoRole(page, DEMO_USERS.sustainability);
  await expect(
    page.getByRole('heading', { name: /レビュー・承認（版 3 を審査中）/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '最終承認する（社内承認）' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'レビューを完了する' })).toHaveCount(0);

  // 最終承認者が承認する（版 3 を固定）
  await switchDemoRole(page, DEMO_USERS.approver);
  await page.getByRole('button', { name: '最終承認する（社内承認）' }).click();
  await page.waitForURL(/flash=reviewApproved/);
  await expect(page.getByText(/最終承認しました（社内承認の記録/)).toBeVisible();
  const history = page.getByText(/これまでのレビュー（\d+ 件）/);
  await history.click();
  await expect(page.getByText(`理由: ${RETURN_REASON}`).first()).toBeVisible();

  await gotoBlock(page, ESRS);
  await page.getByRole('button', { name: '最終承認する（社内承認）' }).click();
  await page.waitForURL(/flash=reviewApproved/);
});

test('レポートを確定し、承認済みスナップショットから対外用 DOCX を出力する', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${PROJECT_PATH}?tab=outputs`);
  const confirm = page.getByRole('button', { name: 'レポートを確定する' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(/snapshotCreated=\d+&kind=approved/);
  await expect(
    page.getByRole('status').filter({ hasText: /スナップショット No\.\d+ を作成しました/ }),
  ).toContainText('社内承認済み版');

  const approvedRow = page
    .getByRole('row')
    .filter({ has: page.getByText('社内承認済み版', { exact: true }) })
    .first();
  // SSBJ の DOCX 原稿（ESRS-40a 準備の原稿は別ファイル）
  const ssbjDocx = (audience: 'external' | 'internal') =>
    approvedRow.locator(
      `a[href*="format=docx"][href*="audience=${audience}"]:not([href*="${IDS.esrs40aVersion}"])`,
    );
  const external = ssbjDocx('external');
  const internal = ssbjDocx('internal');
  await expect(external).toHaveText('対外用');
  await expect(internal).toHaveText('社内確認用');
  approvedExternalDocxHref = (await external.getAttribute('href')) ?? '';
  expect(approvedExternalDocxHref).toContain('audience=external');

  const externalText = await downloadDocx(page, external);
  await attachText('対外用 DOCX の本文', externalText);
  // 承認した本文（差戻し後に直した版 3）と、単位付きの数値
  expect(externalText).toContain(`${METRIC_SENTENCE_HEAD} ${IMPORTED_DISPLAY} です${FIX_SUFFIX}。`);
  expect(externalText).toContain('社内承認済み版');
  expect(externalText).toContain('2026-04-01');
  // 社内コメントは対外用に含めない（A32）
  expect(externalText).not.toContain(INTERNAL_COMMENT);
  expect(externalText).not.toContain('社内コメント（対外用の原稿には含めません）');

  // 同じスナップショットの社内確認用には社内コメントが載る（対外用で除いたことの裏付け）
  const internalText = await downloadDocx(page, internal);
  await attachText('社内確認用 DOCX の本文', internalText);
  expect(internalText).toContain(INTERNAL_COMMENT);
  expect(internalText).toContain(IMPORTED_DISPLAY);

  const fetched = await fetchDocx(page, approvedExternalDocxHref);
  expect(fetched.text).toBe(externalText);
  approvedExternalContentHash = fetched.hash;
  expect(approvedExternalContentHash).not.toBe('');

  // 出力の記録（形式・区分・ファイルのハッシュ）が残る
  await page.reload();
  await expect(
    page.getByRole('row').filter({ hasText: '対外用（社内コメント・非公開資料名を除く）' }).first(),
  ).toBeVisible();
});

test('元データを訂正すると、原稿は「再確認が必要」になり、承認済みスナップショットと出力は変わらない', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);

  // 同じ標準 CSV の経路で、承認済みの値を訂正する（新しい版・承認後に変更）
  const row = await importStandardCsv(
    page,
    { name: 'eu-water-fy2026-correction.csv', buffer: standardCsv(CORRECTED_VALUE) },
    'E2E: 検針票の差し替えにより再訂正',
  );
  await expect(row).toContainText('承認済みの値です');

  // 原稿: 承認済みの節に「再確認が必要」。本文（承認した版）は訂正前の値のまま
  await gotoBlock(page, RISK);
  const toc = page.getByRole('navigation', { name: '節の目次' });
  await expect(toc.getByRole('link').filter({ hasText: 'リスク及び機会' })).toContainText(
    '再確認が必要',
  );
  await expect(page.getByText('参照: 上流に新版あり')).toBeVisible();
  await expect(editorBody(page)).toContainText(`${IMPORTED_DISPLAY} です${FIX_SUFFIX}。`);
  await test.info().attach('訂正後の原稿（再確認が必要）', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('link', { name: /引用先の変更を再確認する/ }).click();
  const item = page.locator('#t4d-main').getByRole('heading', { name: /水使用量/ });
  await expect(item).toBeVisible();
  await expect(page.getByText(IMPORTED_DISPLAY).first()).toBeVisible();
  await expect(page.getByText(CORRECTED_DISPLAY).first()).toBeVisible();
  await expect(page.getByText('変更理由: E2E: 検針票の差し替えにより再訂正')).toBeVisible();

  // 原稿一覧の「再確認が必要」にも出る
  await page.goto(`${PROJECT_PATH}?tab=manuscripts&filter=recheck`);
  await expect(page.getByRole('link', { name: 'リスク及び機会', exact: true })).toBeVisible();

  // 承認済みスナップショット: 内容は変えず、上流の変更を注意として示すだけ（§10.3・A31）
  await page.goto(`${PROJECT_PATH}?tab=outputs`);
  const approvedRow = page
    .getByRole('row')
    .filter({ has: page.getByText('社内承認済み版', { exact: true }) })
    .first();
  await expect(approvedRow.getByText(/作成後に上流が更新（\d+ 件）/)).toBeVisible();
  const again = await fetchDocx(page, approvedExternalDocxHref);
  await attachText('訂正後に同じスナップショットから出力した対外用 DOCX の本文', again.text);
  expect(again.hash).toBe(approvedExternalContentHash);
  expect(again.text).toContain(`${METRIC_SENTENCE_HEAD} ${IMPORTED_DISPLAY} です${FIX_SUFFIX}。`);
  expect(again.text).not.toContain(CORRECTED_DISPLAY);
});

test('後片付け: 開示デモを初期状態に戻し、開示優先モードを OFF にする', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');
  await resetDisclosureDemo(page);

  // リセット後: リスク及び機会は下書き（版 1）に戻り、デモ中に作った定性情報は消える
  await gotoBlock(page, RISK);
  await expect(page.getByRole('heading', { name: /レビュー・承認/ })).toHaveCount(0);
  await expect(editorBody(page)).not.toContainText(METRIC_SENTENCE_HEAD);
  await page.goto('/enterprise/narratives');
  await expect(page.getByText(NARRATIVE_TITLE)).toHaveCount(0);

  await switchDemoRole(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, false);
  await expect(page.getByText('開示優先モードを無効にしました')).toBeVisible();
  const sidebar = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await expect(sidebar.getByRole('link', { name: '開示対応', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: '開示プロジェクト', exact: true })).toHaveCount(0);
});
