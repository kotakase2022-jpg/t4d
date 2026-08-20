import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 過去回答の Import・構造化（CDP-P0-003）。
 * 実ブラウザで実ファイルをアップロードし、プレビュー → 確定 → 反映まで通す。
 */

test.describe.configure({ mode: 'serial' });

const CSV = [
  '質問コード,回答',
  'C0.1,【E2E】当社は精密電子部品の設計・製造を行っています。',
  'C1.1,はい',
  'C99.9,存在しない質問コード',
].join('\r\n');

test('CSV をアップロードして過去回答を取り込める', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp/import');
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.locator('input[name="file"]').setInputFiles({
    name: 'CDP2025_回答.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf-8'),
  });
  await page.getByRole('button', { name: '解析する' }).click();

  // プレビューが出る（保存はまだされていない）
  await page.waitForURL(/\/import\?file=/);
  await expect(page.getByRole('heading', { name: /解析結果/ })).toBeVisible();

  // 一致した行はチェック済み、マスターに無いコードは取り込めない
  const matchedRow = page.locator('tbody tr', { hasText: 'C0.1' }).first();
  await expect(matchedRow).toContainText('一致');
  await expect(matchedRow.locator('input[name="selected"]')).toBeChecked();

  const unknownRow = page.locator('tbody tr', { hasText: 'C99.9' }).first();
  await expect(unknownRow).toContainText('質問コード不明');
  await expect(unknownRow.locator('input[name="selected"]')).toHaveCount(0);

  // 確定する
  await page.getByRole('button', { name: /件を取り込む/ }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/cdp\?imported=/);

  // 当年度の質問詳細から前年回答として参照できる
  await page.goto('/enterprise/disclosures/cdp');
  await page.locator('a', { hasText: 'C0.1' }).first().click();
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByText('【E2E】当社は精密電子部品')).toBeVisible();
});

test('Word ファイルも取り込める', async ({ page }) => {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  const doc = new Document({
    sections: [
      {
        children: ['C1.1 はい', 'C0.2 2025-04-01 〜 2026-03-31'].map(
          (text) => new Paragraph({ children: [new TextRun(text)] }),
        ),
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp/import');
  await page.locator('input[name="file"]').setInputFiles({
    name: 'CDP2025_回答.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(buffer),
  });
  await page.getByRole('button', { name: '解析する' }).click();

  await page.waitForURL(/\/import\?file=/);
  await expect(page.getByRole('heading', { name: /解析結果/ })).toBeVisible();
  await expect(page.getByText('Word として解析')).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: 'C1.1' }).first()).toContainText('一致');
});

test('質問コードを含まないファイルは取り込めず、理由が表示される', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/cdp/import');
  await page.locator('input[name="file"]').setInputFiles({
    name: 'wrong.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('拠点,値\nHQ,100', 'utf-8'),
  });
  await page.getByRole('button', { name: '解析する' }).click();

  await page.waitForURL(/\/import\?file=/);
  await expect(page.getByText(/特定できませんでした/)).toBeVisible();
  await expect(page.getByText('取り込める回答が見つかりませんでした')).toBeVisible();
});

test('開示の書き込み権限が無いロールは取込画面を使えない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto('/enterprise/disclosures/cdp/import');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByText('この操作を行う権限がありません')).toBeVisible();
  await expect(page.locator('input[name="file"]')).toHaveCount(0);
});
