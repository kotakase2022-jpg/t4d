import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * SSBJ ギャップ分析の 5 画面。
 *
 * 「AI が判定して終わり」ではなく、対象判定 → 分析 → 担当者の確認 → 対応計画 →
 * データ収集 が 1 本の流れとして操作できることを、実ブラウザで確かめる。
 * 画面の文言がすべて日本語であることもここで担保する。
 */

test.describe('SSBJ 対応状況（全体状況）', () => {
  test('3 つの整備度・件数内訳・領域別・優先ギャップが出る', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj');
    const main = page.locator('#t4d-main');
    await expect(main).toBeVisible();

    // 単一の総合点にまとめず、3 つに分けて出す
    await expect(main.getByText('開示対応度')).toBeVisible();
    await expect(main.getByText('データ整備度')).toBeVisible();
    await expect(main.getByText('業務プロセス・内部統制整備度')).toBeVisible();

    // 件数の内訳（対応状況とは別に、重要性なし・対象外・確認待ちを持つ）
    for (const label of [
      '全要求事項',
      '対応済み',
      'おおむね対応',
      '一部対応',
      '未対応',
      '重要性なし',
      '対象外',
      '確認待ち',
    ]) {
      await expect(main.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // 4 領域の対応状況
    await expect(main.getByText('領域別の対応状況')).toBeVisible();
    for (const area of ['ガバナンス', '戦略', 'リスク管理', '指標及び目標']) {
      await expect(main.getByText(area, { exact: true }).first()).toBeVisible();
    }

    // 優先度の高いギャップが目立つ位置にある
    await expect(main.getByText('優先して対応するギャップ')).toBeVisible();
    await expect(main.getByText('初年度対応を優先する項目')).toBeVisible();

    // 8 段階の基本フロー
    await expect(main.getByText('人工知能によるギャップ分析')).toBeVisible();
    await expect(main.getByText('担当者による確認')).toBeVisible();
    await expect(main.getByText('データ収集・開示・内部統制')).toBeVisible();
  });

  test('画面内に英語のカタカナ語ではない生の英単語ラベルを使っていない', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj');
    const main = page.locator('#t4d-main');
    // 置き換え対象として指示された語が残っていないこと
    for (const banned of ['ダッシュボード', 'アセスメント', 'ステータス', 'コンプライアント']) {
      await expect(main.getByText(banned, { exact: false })).toHaveCount(0);
    }
  });
});

test.describe('SSBJ 要求事項一覧', () => {
  test('一覧が出て、絞り込みが効く', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/requirements');
    const main = page.locator('#t4d-main');

    // 表の見出しが日本語で、AI 判定と最終判定が別の列になっている
    for (const header of [
      '要求事項',
      '領域',
      '適用区分',
      '重要性',
      '人工知能による判定',
      '最終判定',
      '優先度',
      '担当部署',
    ]) {
      await expect(main.getByRole('columnheader', { name: header })).toBeVisible();
    }

    const allRows = await page.locator('tbody tr').count();
    expect(allRows).toBeGreaterThan(50);

    // 未対応で絞り込むと件数が減る
    await page.goto('/enterprise/disclosures/ssbj/requirements?coverage=not_covered');
    const filtered = await page.locator('tbody tr').count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(allRows);
  });
});

test.describe('SSBJ 要求事項の詳細・ギャップ分析', () => {
  test('要求事項と現在の開示内容を左右に並べ、3 観点の対応状況を出す', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/requirements');
    await page.locator('tbody tr a').first().click();
    await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);

    const main = page.locator('#t4d-main');
    // 左: 要求事項（基準の原文まで出す）
    await expect(main.getByText('SSBJ 要求事項')).toBeVisible();
    await expect(main.getByText('基準の原文')).toBeVisible();
    // 右: 現在の開示内容
    await expect(main.getByText('現在の開示内容')).toBeVisible();
    // 3 種類のギャップ
    await expect(main.getByText('開示ギャップ')).toBeVisible();
    await expect(main.getByText('データギャップ')).toBeVisible();
    await expect(main.getByText('業務プロセス・内部統制ギャップ')).toBeVisible();
    // 優先順位の根拠
    await expect(main.getByText('優先順位の評価')).toBeVisible();
    await expect(main.getByText('制度上の重要性')).toBeVisible();
    await expect(main.getByText('第三者保証への影響')).toBeVisible();
  });

  test('人工知能の判定は候補で、担当者が確認して最終判定になる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/requirements?coverage=not_covered');
    await page.locator('tbody tr a').first().click();
    await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);
    const main = page.locator('#t4d-main');

    // 分析を実行する
    await main.getByRole('button', { name: /ギャップ分析/ }).click();
    await page.waitForLoadState('networkidle');

    await expect(main.getByText('人工知能による評価')).toBeVisible();
    await expect(
      main.getByText('この判定は候補です。最終判定は担当者の確認で確定します。'),
    ).toBeVisible();
    // 評価コメント本文にも同じ語が出るため、見出しに限定して確かめる
    await expect(main.getByText('不足している情報', { exact: true })).toBeVisible();
    await expect(main.getByText('推奨される対応', { exact: true })).toBeVisible();

    // 分析直後は確認待ち
    await expect(main.getByText('確認待ち').first()).toBeVisible();

    // 担当者が確認して確定する
    await main.getByLabel('確認コメント').fill('内容を確認しました');
    await main.getByRole('button', { name: '最終判定として確定する' }).click();
    await page.waitForLoadState('networkidle');
    await expect(main.getByText('最終判定', { exact: true })).toBeVisible();
    // ラジオの選択肢（「…承認する」）と区別するため完全一致で確かめる
    await expect(main.getByText('人工知能の判定を承認', { exact: true })).toBeVisible();
  });

  test('対象外にするには理由が必要（理由なしはエラーになる）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/requirements');
    await page.locator('tbody tr a').first().click();
    await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);
    const main = page.locator('#t4d-main');

    await main.getByLabel('適用区分').selectOption('not_applicable');
    await main.getByLabel('対象外とする理由').fill('   ');
    await main.getByRole('button', { name: '判定を保存' }).click();
    await page.waitForLoadState('networkidle');

    // 全画面エラーではなく、画面内の警告として出る
    await expect(main.getByRole('alert')).toContainText('理由を入力');
    await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  });
});

test.describe('SSBJ 対応計画とデータ収集', () => {
  test('対応計画の一覧に担当・期限・対応状況が出て、更新できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/plans');
    const main = page.locator('#t4d-main');

    for (const header of ['対応内容', '関連する要求事項', '観点', '対応区分', '期限', '対応状況']) {
      await expect(main.getByRole('columnheader', { name: header })).toBeVisible();
    }
    await expect(main.getByText('期限超過')).toBeVisible();

    // 対応状況を更新できる
    const row = page.locator('tbody tr').first();
    await row.getByRole('combobox').last().selectOption('in_progress');
    await row.getByRole('button', { name: '更新' }).click();
    await page.waitForLoadState('networkidle');
    await expect(main.getByRole('alert')).toHaveCount(0);
  });

  test('データ収集管理に、対応計画から作られたデータ項目が出る', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto('/enterprise/disclosures/ssbj/collection');
    const main = page.locator('#t4d-main');

    await expect(main.getByText('収集対象')).toBeVisible();
    await expect(main.getByText('収集の進捗')).toBeVisible();
    for (const header of ['データ項目', '集計対象範囲', '入力担当者', '提出期限', '収集状況']) {
      await expect(main.getByRole('columnheader', { name: header })).toBeVisible();
    }
    // 対応計画で作った Scope3 のデータ項目が拠点ごとに並ぶ
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
  });
});
