import { expect, test } from '@playwright/test';
import { dataPointId } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 5 つの追加要望のうち、画面まで通す必要があるもの。
 *   ① 指標マスターに開示基準の出所が出る
 *   ② 取込で無関係な行が警告なしに外れる
 *   ③ ①マテリアリティ・分析条件の設定を未完了から進められる
 *   ④ 最大 5 階層の承認と、いつ誰が承認・修正・差し戻したかの履歴
 *   ⑤ 開示ドラフトを人工知能に書かせる
 */

test('① 指標マスターに、どの開示基準が求めている指標かが出る', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 基準ごとの充足状況が先に見える
  await expect(page.getByText('開示基準からみた指標の充足状況')).toBeVisible();
  await expect(page.getByText('SSBJ が求める指標')).toBeVisible();
  await expect(page.getByText('CDP が求める指標')).toBeVisible();
  await expect(page.getByText('CSRD が求める指標')).toBeVisible();

  // 指標マスターに出所の列がある
  await expect(page.getByRole('columnheader', { name: '求めている基準' })).toBeVisible();

  // SSBJ 第2号 第55項が求める Scope3 のカテゴリー別指標が入っている
  const row = page.locator('tr', { hasText: 'scope3_cat11' });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('SSBJ')).toBeVisible();

  // SSBJ 第79項の移行リスク資産（気候関連の財務影響）も入っている
  await expect(page.locator('tr', { hasText: 'transition_risk_assets' })).toHaveCount(1);
});

test('② 指標と関係の無い行は、警告を出さずに取り込み対象外になる', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 4000 + (Date.now() % 900);
  const csv = [
    '拠点,項目,値,単位',
    `本社,電力使用量,${marker},MWh`,
    '作成者,山田 太郎,,',
    '承認者,鈴木 花子,,',
  ].join('\r\n');

  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `無関係混在-${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });

  // 件数だけは必ず伝える。黙って消さない
  const summary = page.getByText(/指標マスターと関係が無いため、2 行を取り込み対象外/);
  await expect(summary).toBeVisible();
  // 指標の行は残っている
  await expect(page.getByText(String(marker)).first()).toBeVisible();

  // 外した行に「指標を特定できませんでした」を出さない。
  // 行そのものは畳んだ中に残す（外した判断が誤っていたときに気づけるようにするため）
  await expect(page.locator('#t4d-main').getByText('指標を特定できませんでした')).toHaveCount(0);
  await summary.click(); // details を開く
  await expect(page.locator('#t4d-main').getByText('山田 太郎')).toBeVisible();
});

test('③ マテリアリティ・分析条件の設定を、未完了から確定まで進められる', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);

  // 入口は「完了」ではなく「未完了」から始まる
  await page.goto('/enterprise/disclosures/ssbj');
  await expect(page.getByText('マテリアリティ・分析条件の設定')).toBeVisible();

  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByText('決めること（3 項目）')).toBeVisible();
  // 3 項目とも未完了で始まる
  await expect(page.locator('#t4d-main').getByText('未完了')).not.toHaveCount(0);

  // ① 適用する基準と ② 報告の範囲を決める
  await page.getByLabel('バリューチェーンの扱い').selectOption('both');
  await page.getByRole('button', { name: '分析条件を保存' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('適用する基準を決める')).toBeVisible();

  // ③ マテリアリティをすべて評価する。
  //
  // 「未評価の行」で絞り込むことはできない。select の <option> にも「未評価」が
  // あるため、評価済みの行にも一致してしまう。行番号で順に埋める。
  const rowsOf = () => page.locator('#t4d-main tr').filter({ has: page.getByRole('combobox') });
  const topicCount = await rowsOf().count();
  expect(topicCount).toBeGreaterThan(0);

  for (let i = 0; i < topicCount; i += 1) {
    const row = rowsOf().nth(i); // 保存のたびに再描画されるので毎回引き直す
    await row.getByRole('combobox').selectOption('medium');
    await row.getByRole('textbox').fill('当年度の事業内容を踏まえて評価しました。');
    await row.getByRole('button', { name: '保存' }).click();
    await page.waitForLoadState('networkidle');
  }

  // 3 項目すべてが決まると確定できる
  await page.goto('/enterprise/disclosures/ssbj/settings');
  const confirm = page.getByRole('button', { name: 'この内容で確定する' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj/, { timeout: 30_000 });

  // 入口の表示が「確定済み」に変わる
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.locator('#t4d-main').getByText('確定済み').first()).toBeVisible();
});

test('④ 最大 5 階層の承認と、いつ誰が承認・修正・差し戻したかが見られる', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);

  // データ収集の一覧に承認の進み具合が出る
  await page.goto('/enterprise/disclosures/ssbj/collection');
  await expect(page.locator('#t4d-main')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '承認の進み具合' })).toBeVisible();

  // 台帳のデータから承認フローと履歴を辿れる
  await page.goto('/enterprise/data');
  await page.locator('a[href^="/enterprise/data/"]').first().click();
  await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);

  await expect(page.getByText(/承認フロー（\d+ \/ 5 段階）/)).toBeVisible();
  // 5 段階すべてが並ぶ（段名は本文・案内文・履歴にも出るので先頭を見る）
  const flow = page.locator('#承認フロー');
  await expect(flow.getByText('拠点責任者の確認').first()).toBeVisible();
  await expect(flow.getByText('担当役員の承認').first()).toBeVisible();

  // いつ・誰が・何をしたかの履歴
  await expect(page.getByText(/承認・修正の履歴/)).toBeVisible();
});

test('④ 承認待ちの段階を承認すると、次の段階へ進み履歴に残る', async ({ page }) => {
  test.setTimeout(120_000);
  // 西日本工場 / 廃棄物 = 提出済み。1 段目「拠点責任者の確認」は reviewer が承認する
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(`/enterprise/data/${dataPointId('WEST', 'waste', 'FY2026')}`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const approve = page.getByRole('button', { name: /「.+」を承認/ });
  await expect(approve).toBeVisible();
  await approve.click();
  await page.waitForLoadState('networkidle');

  // 履歴に承認が残る
  await expect(page.locator('#t4d-main').getByText('承認').first()).toBeVisible();
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});

test('⑤ 開示ドラフトを人工知能に書かせ、直して確定できる', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);

  // 対応状況の右上から開示ドラフトへ入れる（手順 8 のカードにも同じ語が出るので厳密一致で取る）
  await page.goto('/enterprise/disclosures/ssbj');
  await page.getByRole('link', { name: '開示ドラフト', exact: true }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/draft/);

  await expect(page.getByText('ガバナンス').first()).toBeVisible();
  // 何を根拠に書くのかが先に説明されている
  await expect(page.getByText(/対応済み.*おおむね対応.*とした要求事項/)).toBeVisible();

  // 草案を作らせる
  await page.getByRole('button', { name: '人工知能に草案を作らせる' }).first().click();
  await page.waitForURL(/generated=/, { timeout: 60_000 });

  // 草案が本文として出て、そのまま開示しない旨の警告が付く
  const body = page.locator('textarea[name="body"]').first();
  await expect(body).toBeVisible();
  expect((await body.inputValue()).length).toBeGreaterThan(20);
  await expect(page.getByText(/そのまま開示せず/).first()).toBeVisible();

  // 書けなかった箇所が理由つきで出る
  await expect(page.getByText(/書けなかった箇所/).first()).toBeVisible();

  // 人が直して確定できる
  await body.fill('当社は、サステナビリティ関連のリスク及び機会を取締役会が監督しています。');
  await page.getByRole('button', { name: '本文を保存' }).first().click();
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'この内容で確定' }).first().click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#t4d-main').getByText('確定済み').first()).toBeVisible();
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});
