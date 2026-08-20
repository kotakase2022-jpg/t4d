import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 異種データの一括取込（機能追加要望 ①）。
 * フォーマット・言語・文字コードが異なるファイルを実ブラウザから同時にアップロードし、
 * AI 自動仕分けの結果がプレビューに出るところまでを通す。
 */

test.describe.configure({ mode: 'serial' });

test('言語・形式・文字コードが異なる 4 ファイルを一括取込し、AI が自動仕分けする', async ({
  page,
}) => {
  const dataset = await buildHeterogeneousDataset();
  const pick = (prefix: string) => {
    const f = dataset.find((d) => d.name.startsWith(prefix))!;
    return { name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) };
  };

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 日本語 SJIS CSV ＋ ドイツ語セミコロン CSV ＋ 英語 Excel ＋ 中国語 CSV を同時に
  await page.locator('input[name="files"]').setInputFiles([
    pick('06_'), // Shift_JIS CSV
    pick('17_'), // ドイツ語 CSV（1.234,5 kWh）
    pick('28_'), // 英語 Excel（Scope 1）
    pick('22_'), // 中国語 CSV（用电量）
  ]);
  await page.getByRole('button', { name: '取込を開始' }).click();

  // ジョブ詳細へ遷移し、処理完了（プレビュー表示）までポーリングされる
  await page.waitForURL(/\/enterprise\/imports\/.+/);
  await expect(page.getByText(/要確認|マッピング済み|プレビュー/).first()).toBeVisible({
    timeout: 30_000,
  });

  // ドイツ語ファイルの行: 値 1.234,5 が 1234.5 として解釈され、指標が自動選択されている
  // （最初の一致はファイル一覧の行なので、プレビュー行 = 値入力欄を持つ行に絞る）
  const germanRow = page
    .locator('tr', { hasText: 'Stromverbrauch' })
    .filter({ has: page.locator('input[name^="value:"]') })
    .first();
  await expect(germanRow).toBeVisible();
  await expect(germanRow.locator('input[name^="value:"]')).toHaveValue('1234.5');
  // 指標セレクタに energy が自動選択されている（AI 仕分けの結果）
  await expect(germanRow.locator('select').first()).not.toHaveValue('');

  // 中国語ファイルの行も現れる（事前加工なしで受理されている）
  await expect(
    page
      .locator('tr', { hasText: '用电量' })
      .filter({ has: page.locator('input[name^="value:"]') })
      .first(),
  ).toBeVisible();

  // Shift_JIS ファイルが文字化けせずに表示されている
  await expect(page.getByText('用水使用量').first()).toBeVisible();
});
