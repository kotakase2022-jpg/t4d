import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { parseDocx } from '@/lib/imports/docx-text';
import { dataPointId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { DEMO_USERS, loginAs, openCollapsible, openRowActions } from './helpers';

/**
 * トレース・出力・突合・影響の表示（トライアル対応 NF-13〜NF-16 の画面。e2e:trial-trace-outputs）。
 *
 * 出力タブ → FY2025 の社内承認済みスナップショット（Fixture・架空）の「内容とトレースを開く」→ 追跡率（分母付き）
 * → 段落を選ぶ → 要求事項・承認版（承認者・日時）・根拠・数値 → 追跡番号で探す → 追跡できない要素の絞込 → axe。
 * DOCX を出力すると、出力の記録の「突合」が「不一致 0 件」になる。出力した DOCX を「外部で編集したファイルを照合」
 * に入れると一致と記録される（ファイルは保存しない）。データの詳細に「この数値を使っている原稿・レポート」。
 *
 * スナップショットを新しく作らない（他の spec が FY2025 の No.1 を前提にするため）。
 */

test.describe.configure({ mode: 'serial' });

const FY2025_PROJECT_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2025}`;
/** FY2025 の承認済みスナップショットの追跡率（tests/integration/report-trace.test.ts と同じ値） */
const FY2025_TRACE_LABEL = '2 / 5（段落 1 / 4・数値 1 / 1）';

function approvedRow(page: Page) {
  return page
    .getByRole('row')
    .filter({ has: page.getByText('社内承認済み版', { exact: true }) })
    .first();
}

/** 出力 API をブラウザ内の fetch で呼ぶ（Cookie が付く。Secure のセッション Cookie を送るため page.request は使わない） */
async function fetchBytes(page: Page, href: string): Promise<{ status: number; bytes: number[] }> {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, bytes: Array.from(new Uint8Array(await res.arrayBuffer())) };
  }, href);
}

test('出力タブのスナップショットから「内容とトレース」を開き、追跡率と遡り先を確かめる', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${FY2025_PROJECT_PATH}?tab=outputs`);
  const row = approvedRow(page);
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: '内容とトレースを開く' }).click();
  await page.waitForURL(/\/snapshots\/[^/?]+/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'スナップショットの内容とトレース' }),
  ).toBeVisible();

  // 誠実さの注記（閉じない）
  const main = page.locator('#t4d-main');
  await expect(main).toContainText('第三者による保証ではありません');
  await expect(main).toContainText('ファイル作成は提出ではありません');
  await expect(main.getByText('社内承認版').first()).toBeVisible();

  // 追跡率（分母付き）
  await expect(page.getByTestId('trace-rate')).toHaveText(`追跡率 ${FY2025_TRACE_LABEL}`);
  await expect(page.getByRole('img', { name: /追跡できる要素/ })).toBeVisible();

  // 段落を選ぶ → 要求事項・承認版（承認者・日時）・数値
  await page.locator('a[data-trace-id="T-MT-1"]').click();
  await page.waitForURL(/unit=T-MT-1/);
  const detail = page.getByTestId('trace-detail');
  await expect(detail).toContainText('T-MT-1');
  await expect(detail).toContainText('追跡できる');
  await expect(detail).toContainText('気候-47(1)');
  await expect(detail).toContainText('最終承認者');
  await expect(detail).toContainText('承 花子');
  await expect(detail).toContainText('1,240.5 t-CO2e');
  await expect(detail.getByRole('link', { name: /Scope1|排出量/ }).first()).toBeVisible();

  // 追跡できない段落は理由を出す
  await page.locator('a[data-trace-id="T-G-1"]').click();
  await page.waitForURL(/unit=T-G-1/);
  await expect(detail).toContainText('追跡できない理由');
  await expect(detail).toContainText('根拠（出典印・根拠つきの定性情報・数値参照）がありません');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('出力物の追跡番号から段落を探し、追跡できない要素だけに絞れる', async ({ page }) => {
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${FY2025_PROJECT_PATH}?tab=outputs`);
  await approvedRow(page).getByRole('link', { name: '内容とトレースを開く' }).click();
  await page.waitForURL(/\/snapshots\/[^/?]+/);

  await page.getByLabel('出力物の文・数値・追跡番号から段落を探す').fill('T-MT-1');
  await page.getByRole('button', { name: '探す' }).click();
  await page.waitForURL(/q=T-MT-1/);
  const hits = page.getByTestId('trace-search-results');
  await expect(hits).toContainText('「T-MT-1」に当たる要素');
  await hits
    .getByRole('link', { name: /T-MT-1/ })
    .first()
    .click();
  await expect(page.getByTestId('trace-detail')).toContainText('T-MT-1');

  await page
    .getByRole('navigation', { name: '表示する要素' })
    .getByRole('link', { name: /追跡できない要素/ })
    .click();
  await page.waitForURL(/filter=untraceable/);
  await expect(page.locator('a[data-trace-id="T-G-1"]')).toBeVisible();
  // 追跡できる段落は絞込で出さない
  await expect(page.locator('a[data-trace-id="T-MT-1"]')).toHaveCount(0);
});

test('出力した DOCX は承認版と突合され、出力の記録に「不一致 0 件」が残る。外部ファイルの照合も一致する', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.approver);
  await page.goto(`${FY2025_PROJECT_PATH}?tab=outputs`);
  const row = approvedRow(page);
  const internalHref = await row
    .locator('a[href*="format=docx"][href*="audience=internal"]')
    .first()
    .getAttribute('href');
  const externalHref = await row
    .locator('a[href*="format=docx"][href*="audience=external"]')
    .first()
    .getAttribute('href');

  // 社内確認用の DOCX は段落末に追跡番号（トレース画面と同じ番号）
  const internal = await fetchBytes(page, internalHref!);
  expect(internal.status).toBe(200);
  const internalText = (await parseDocx(new Uint8Array(internal.bytes))).paragraphs.join('\n');
  expect(internalText).toContain('［T-MT-1］');
  expect(internalText).toContain('追跡表（社内確認用）');

  // 対外用の本文には追跡番号を出さない
  const external = await fetchBytes(page, externalHref!);
  expect(external.status).toBe(200);
  const externalText = (await parseDocx(new Uint8Array(external.bytes))).paragraphs.join('\n');
  expect(externalText).not.toContain('［T-');

  // 出力の記録の「突合」
  await page.reload();
  const records = page.getByRole('table', { name: '出力の記録' });
  await expect(records.getByText('不一致 0 件').first()).toBeVisible();
  await expect(records).toContainText('段落');

  // 外部で編集したファイルを照合（ここでは出力したままのファイル）。ファイルは保存せず結果だけを記録する
  const menu = await openRowActions(page, '社内承認済み版 No.1');
  await menu.getByRole('menuitem', { name: '外部で編集したファイルを照合' }).click();
  await page.waitForURL(/reconcile=1/);
  const panel = page.locator('#external-reconcile');
  await expect(panel).toBeVisible();
  await panel.getByLabel(/ファイル（\.docx・\.xlsx/).setInputFiles({
    name: '原稿_対外用.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(external.bytes),
  });
  await panel.getByLabel('出力区分').selectOption('external');
  await panel.getByRole('button', { name: '照合する' }).click();
  await page.waitForURL(/reconciliation=/);
  const result = page.getByTestId('reconciliation-result');
  await expect(result).toContainText('承認版と一致しました');
  await expect(result).toContainText('アップロードしたファイルは保存していません');
});

test('データの詳細に「この数値を使っている原稿・レポート」と、固定したレポートへのリンクが出る', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(`/enterprise/data/${dataPointId('HQ', 'scope1', 'FY2025')}`);
  const section = await openCollapsible(page, /影響する節/);
  await expect(
    page.getByRole('heading', { name: /この数値を使っている原稿・レポート/ }),
  ).toBeVisible();
  await expect(section.getByRole('link', { name: '社内承認済み版 No.1' })).toBeVisible();
  await expect(section).toContainText('固定したレポートの内容は、この数値を修正しても変わりません');
});
