import path from 'node:path';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { dataPointId } from '@/lib/fixtures/dataset';
import { DEMO_USERS, gotoEngagementPage, gotoEnterprise, loginAs } from './helpers';

/**
 * E2E: 企業スライスと監査法人スライスの通し（指示書 20 章 Playwright 1〜16）。
 *
 * Demo Mode（環境変数なし）で実行する。サーバープロセス内の Fixture DB を共有するため、
 * 直列（serial）で実行し、前のステップの結果を次のステップが利用する。
 */

const CSV_PATH = path.resolve(process.cwd(), 'tests/e2e/fixtures/east-plant-fy2026.csv');

let engagementId = '';

test.describe.configure({ mode: 'serial' });

test.describe('企業 Vertical Slice', () => {
  test('1-2. 企業管理者でログインし、ダッシュボードの KPI が表示される', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await expect(page).toHaveURL(/\/enterprise\/dashboard/);

    // ブランド（ロゴは実体埋め込み・外部参照でない）
    const logo = page.getByRole('link', { name: 'TERRAST for Disclosure ホームへ' }).locator('img');
    await expect(logo).toHaveAttribute('src', /_next\/image.*t4d-logo/);

    // デモデータ Badge が常時表示される
    await expect(page.getByText('デモデータ')).toBeVisible();

    // KPI（指示書 15.1）
    for (const label of [
      '期限超過',
      '未提出',
      'Validation Error',
      'Evidence 不足',
      'Review 待ち',
      '承認率',
      'CDP 準備度',
    ]) {
      await expect(page.getByRole('link', { name: new RegExp(label) }).first()).toBeVisible();
    }

    await expect(page.getByRole('heading', { name: '拠点別進捗' })).toBeVisible();
    await expect(page.getByText('東日本工場').first()).toBeVisible();
  });

  test('KPI クリックで Filter 付き一覧へ遷移する', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await page
      .getByRole('link', { name: /Validation Error/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/enterprise\/data\?flag=validation_error/);
    await expect(page.getByText('適用中', { exact: false }).or(page.getByText('件'))).toBeTruthy();
  });

  test('3-5. CSV を取り込み、プレビューを修正して確定する', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await gotoEnterprise(page, 'imports');

    await page.setInputFiles('#import-files', CSV_PATH);
    await page.getByRole('button', { name: '取込を開始' }).click();

    // 取込ジョブ画面へ遷移し、ポーリングで解析が完了する
    await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);
    await expect(page.getByRole('heading', { name: /取込ジョブ/ })).toBeVisible();
    await expect(page.getByText('解析が完了しました。')).toBeVisible({ timeout: 60_000 });

    // ファイル解析結果（文字コード判定・ヘッダー推定）
    await expect(page.getByText('east-plant-fy2026.csv')).toBeVisible();
    await expect(page.getByRole('heading', { name: /取込プレビュー/ })).toBeVisible();

    // AI が指標を特定できなかった行に警告が出ている
    await expect(
      page.getByText('指標を特定できませんでした。手動で選択してください。').first(),
    ).toBeVisible();

    // 4. プレビュー修正: 未判定の行は取り込まない、指標が特定できた行は取り込む
    // （ファイル解析結果テーブルと区別するため、確定フォーム内の行に限定する）
    const previewForm = page.locator('form', {
      has: page.getByRole('button', { name: '選択した行を確定' }),
    });
    const rows = previewForm.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      const metricSelect = row.locator('select').first();
      const value = await metricSelect.inputValue();
      const checkbox = row.locator('input[type="checkbox"]');
      if (value === '') {
        await checkbox.uncheck();
      } else {
        await checkbox.check();
      }
    }

    // 5. 確定
    await page.getByRole('button', { name: '選択した行を確定' }).click();
    await page.waitForURL(/\/enterprise\/data/);
    await expect(page.getByRole('heading', { name: '非財務データ' })).toBeVisible();
  });

  test('6. 提出 → レビュー → 承認が動作する', async ({ page }) => {
    // Fixture の ID は決定論的なので、対象を直接指定して安定させる
    // （東日本工場 / 水使用量 = 差戻し中。Evidence 必須ではない指標）
    const targetPath = `/enterprise/data/${dataPointId('EAST', 'water', 'FY2026')}`;

    // 拠点担当が提出
    await loginAs(page, DEMO_USERS.siteUser);
    await page.goto(targetPath);
    await expect(page.getByRole('heading', { name: /水使用量/ })).toBeVisible();

    await page.getByRole('button', { name: '提出' }).click();
    await expect(page.getByText('提出済み').first()).toBeVisible();

    // 拠点担当には承認ボタンが出ない
    await expect(page.getByRole('button', { name: '承認', exact: true })).toHaveCount(0);

    // レビュー担当が差戻し理由付きで差し戻せる
    await loginAs(page, DEMO_USERS.reviewer);
    await page.goto(targetPath);
    await page.getByLabel('差戻し理由').fill('検針票の対象期間を確認してください。');
    await page.getByRole('button', { name: '差戻し' }).click();
    await expect(page.getByText('差戻し').first()).toBeVisible();
    // 差戻し理由は承認履歴とコメントの両方に残るため first() で確認する
    await expect(page.getByText('検針票の対象期間を確認してください。').first()).toBeVisible();

    // 再提出 → 承認の道筋を 5 段階すべて通す
    await loginAs(page, DEMO_USERS.siteUser);
    await page.goto(targetPath);
    await page.getByRole('button', { name: '提出' }).click();

    // 段階ごとに承認できる役割が違う。道筋の定義どおりの順で承認していく
    const stageActors = [
      DEMO_USERS.reviewer, // 1. 拠点責任者の確認
      DEMO_USERS.sustainability, // 2. 本社主管部門の確認
      DEMO_USERS.reviewer, // 3. 内部統制部門の確認
      DEMO_USERS.enterpriseAdmin, // 4. サステナビリティ推進部長の承認
      DEMO_USERS.approver, // 5. 担当役員の承認
    ];
    for (const actor of stageActors) {
      await loginAs(page, actor);
      await page.goto(targetPath);
      const approveStage = page.getByRole('button', { name: /「.+」を承認/ });
      await expect(approveStage, `${actor} がこの段階を承認できない`).toBeVisible();
      await approveStage.click();
      await page.waitForLoadState('networkidle');
    }

    // 5 段階すべてを通して初めて承認済みになる
    await page.goto(targetPath);
    await expect(page.getByText('承認済み').first()).toBeVisible();
  });

  test('承認の道筋がある間は、段階を飛ばして承認できない', async ({ page }) => {
    // 欧州販売子会社 / Scope1 = 提出済みで 1 段目の承認待ち。
    // Demo Mode の状態はテスト間で共有されるので、他のテストが触らないデータを使う
    // （WEST/waste は承認フローのテストが 1 段目を進めてしまう）
    const targetPath = `/enterprise/data/${dataPointId('EU', 'scope1', 'FY2026')}`;

    await loginAs(page, DEMO_USERS.approver);
    await page.goto(targetPath);

    // 押しても必ず失敗する「承認」ボタンは置かず、承認フローへ誘導する
    await expect(page.getByRole('button', { name: '承認', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /承認フローへ（\d+\/5 段階）/ })).toBeVisible();

    // 本社サステナ担当は 1 段目（拠点責任者の確認）の承認者ではないので、
    // 承認ボタンの代わりに「誰の番か」が出る
    await loginAs(page, DEMO_USERS.sustainability);
    await page.goto(targetPath);
    await expect(page.getByRole('button', { name: /「.+」を承認/ })).toHaveCount(0);
    await expect(page.getByText(/あなたはこの段階の承認者ではありません/)).toBeVisible();
  });

  test('拠点担当は承認ボタンを持たない（権限による UI 分岐）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.siteUser);
    await gotoEnterprise(page, 'data');
    await page.getByRole('link', { name: '詳細' }).first().click();
    await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
    await expect(page.getByRole('button', { name: '承認', exact: true })).toHaveCount(0);
  });

  test('7. CDP の AI ドラフトを作成し、人が編集してから承認する', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await gotoEnterprise(page, 'disclosures/cdp');
    await expect(page.getByRole('heading', { name: 'CDP 開示対応' })).toBeVisible();
    // 架空マスターである旨の表示
    await expect(page.getByText('架空の縮小マスター（正式質問書ではありません）')).toBeVisible();

    // Scope1 の数値質問を開く
    await page.getByRole('link', { name: 'C6.1' }).first().click();
    await page.waitForURL(/\/enterprise\/disclosures\/cdp\/[0-9a-f-]+/);

    // AI ドラフト生成
    await page.getByRole('button', { name: 'ドラフトを生成' }).click();
    await expect(page.getByText('Mock / AI未接続').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('参照元')).toBeVisible();
    await expect(
      page.getByText('AI 生成のままでは承認できません（DB 側でも禁止されています）。'),
    ).toBeVisible();

    // 人が編集して保存すると AI 由来フラグが外れる
    const editor = page.getByLabel('回答本文');
    await editor.fill(
      '担当者が内容を確認し、算定範囲（連結）を追記しました。Scope1 の実績値は承認済みデータに基づきます。',
    );
    await page.getByRole('button', { name: '保存（下書き）' }).click();
    await expect(
      page.getByText('AI 生成のままでは承認できません（DB 側でも禁止されています）。'),
    ).toHaveCount(0);

    // 承認者が承認
    const questionUrl = page.url();
    await loginAs(page, DEMO_USERS.approver);
    await page.goto(questionUrl);
    await page.getByRole('button', { name: '承認' }).click();
    await expect(page.getByText('承認済み').first()).toBeVisible();
  });

  test('Export（CSV）がダウンロードできる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.approver);
    await gotoEnterprise(page, 'data');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'CSV' }).first().click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });
});

test.describe('監査法人 Vertical Slice', () => {
  test('8-9. 監査法人マネージャーでログインし、案件が表示される', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await expect(page).toHaveURL(/\/assurance\/dashboard/);
    await expect(page.getByRole('heading', { name: '案件ホーム' })).toBeVisible();
    await expect(page.getByText('青海テクノロジー株式会社').first()).toBeVisible();

    engagementId = await gotoEngagementPage(page, 'overview');
    expect(engagementId).not.toBe('');
    await expect(page.getByRole('heading', { name: /ENG-2026-001/ })).toBeVisible();
  });

  test('未アサインの法人管理者はクライアントデータを閲覧できない', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceAdmin);
    await expect(page).toHaveURL(/\/assurance\/dashboard/);
    await expect(page.getByText('アサインされている案件がありません')).toBeVisible();

    // URL 直打ちでも閲覧不可（404 相当）
    await page.goto(`/assurance/engagements/${engagementId}/data-room`);
    await expect(page.getByText('ページが見つかりません')).toBeVisible();
  });

  test('Data Room はクライアント原本を Read-only で表示し、Snapshot 後変更を検知する', async ({
    page,
  }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/data-room`);

    await expect(page.getByText('Read-only（企業原本）')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Snapshot 固定後の変更/ })).toBeVisible();

    // 許諾範囲外（欧州販売子会社・水使用量）は表示されない
    await expect(page.getByText('欧州販売子会社')).toHaveCount(0);
  });

  test('10. Snapshot を新規作成できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/data-room`);

    await page.getByLabel('Snapshot ラベル').fill('SNAP-E2E');
    await page.getByRole('button', { name: 'Snapshot を固定' }).click();
    await expect(page.getByRole('heading', { name: /Snapshot: SNAP-E2E/ })).toBeVisible();
  });

  test('11. サンプルを抽出できる（Seed を記録し再現可能）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceStaff);
    await page.goto(`/assurance/engagements/${engagementId}/sampling`);

    await page.getByLabel('サンプル名').fill('SMP-E2E');
    await page.getByLabel('乱数 Seed').fill('E2E-SEED-001');
    await page.getByLabel('サンプル件数').fill('4');
    await page.getByRole('button', { name: 'サンプルを抽出' }).click();

    await expect(page.getByRole('heading', { name: /SMP-E2E（4 件）/ })).toBeVisible();
    // Seed はヘッダーと各行の選定理由の両方に現れる
    await expect(page.getByText('Seed: E2E-SEED-001', { exact: true })).toBeVisible();
  });

  test('12. Testing 三ペインで手続結果と結論を記録できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceStaff);
    await page.goto(`/assurance/engagements/${engagementId}/testing`);

    // 三ペイン（左: サンプル一覧 / 中央: 手続 / 右: Evidence）
    await expect(page.getByRole('heading', { name: /SMP-E2E/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Procedure Checklist' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Evidence/ }).first()).toBeVisible();

    // 先頭手続の結果を記録
    await page.getByRole('button', { name: '記録' }).first().click();
    await expect(page.getByText('pass').first()).toBeVisible();

    // 結論を入力して作成完了
    await page.getByLabel('結論').fill('原資料と照合し、重要な相違は識別されなかった。');
    await page.getByLabel('調書番号').fill('WP-E2E-01');
    await page.getByRole('button', { name: '作成完了（Prepared）' }).click();
    await expect(page.getByText('作成済み').first()).toBeVisible();
  });

  test('自己レビューは禁止されている', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceStaff);
    await page.goto(`/assurance/engagements/${engagementId}/testing`);
    await expect(
      page.getByText(
        '自身が作成した調書を自身でレビューすることはできません（自己レビュー禁止）。',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'レビュー完了（Reviewed）' })).toBeDisabled();
  });

  test('13. PBC（資料依頼）を作成できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/requests`);

    await page.getByLabel('件名').fill('E2E 追加資料の依頼');
    await page.getByLabel('期限').fill('2026-09-30');
    await page
      .getByLabel('依頼内容（企業側に表示されます）')
      .fill('算定根拠資料をご提出ください。');
    await page
      .getByLabel('内部メモ（監査法人内部限定・企業側からは見えません）')
      .fill('企業側からは見えない内部メモ');
    await page.getByRole('button', { name: '送付' }).click();

    await expect(page.getByText('E2E 追加資料の依頼')).toBeVisible();
    await expect(page.getByText('企業側からは見えない内部メモ')).toBeVisible();
  });

  test('企業側からは PBC の内部メモが見えない', async ({ page }) => {
    await loginAs(page, DEMO_USERS.sustainability);
    await gotoEnterprise(page, 'workflows');
    await expect(page.getByText('E2E 追加資料の依頼')).toBeVisible();
    await expect(page.getByText('企業側からは見えない内部メモ')).toHaveCount(0);
  });

  test('14. Issue（指摘）を作成できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/issues`);

    // 「内容」は既存 Issue の解消フォームにも現れるため、起票フォームに限定する
    const createForm = page.locator('form', {
      has: page.getByRole('button', { name: '起票', exact: true }),
    });
    await createForm.getByLabel('タイトル').fill('E2E 指摘: 算定根拠の不足');
    await createForm.getByLabel('重要度').selectOption('high');
    await createForm
      .getByLabel('内容', { exact: true })
      .fill('算定根拠資料が不足しているため、再計算を確認できなかった。');
    await createForm.getByRole('button', { name: '起票' }).click();

    await expect(page.getByText('E2E 指摘: 算定根拠の不足')).toBeVisible();
    await expect(page.getByText(/未解決の重要度「高」の指摘が/)).toBeVisible();
  });

  test('15. 抑止条件がある間は Sign-off が実行できない', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assurancePartner);
    await page.goto(`/assurance/engagements/${engagementId}/signoffs`);

    await expect(page.getByRole('heading', { name: /Partner Approved/ })).toBeVisible();
    await expect(page.getByText('抑止中').first()).toBeVisible();

    // 抑止理由が具体的に列挙されている
    await expect(page.getByText(/未解決の重要度「高」の指摘が/).first()).toBeVisible();
    await expect(page.getByText(/未着手・実施中のサンプルテストが/).first()).toBeVisible();

    // ボタンは disabled
    const button = page.getByRole('button', { name: /として Sign-off/ }).last();
    await expect(button).toBeDisabled();

    // 代理 Sign-off の禁止が明示されている
    await expect(page.getByText(/代理 Sign-off は禁止/)).toBeVisible();
  });

  test('16. High Issue を解消すると該当の抑止条件が外れる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/issues`);

    // 未解決の Issue をすべて解消する（クリックごとにフォーム数が 1 つ減るのを待つ）
    const resolveButtons = page.getByRole('button', { name: '解消として記録' });
    let remaining = await resolveButtons.count();
    expect(remaining).toBeGreaterThan(0);

    while (remaining > 0) {
      await page.getByLabel('解消内容').first().fill('企業側の修正を確認し、解消とした。');
      await resolveButtons.first().click();
      await expect(resolveButtons).toHaveCount(remaining - 1);
      remaining -= 1;
    }

    await expect(page.getByText(/未解決の重要度「高」の指摘が/)).toHaveCount(0);

    // Sign-off 画面から High Issue の抑止が消えている
    await page.goto(`/assurance/engagements/${engagementId}/signoffs`);
    await expect(page.getByText(/未解決の重要度「高」の指摘が/)).toHaveCount(0);
    // 他の抑止（テスト未完了）は残っている＝抑止ロジックが個別に効いている
    await expect(page.getByText(/未着手・実施中のサンプルテストが/).first()).toBeVisible();
  });

  test('案件パッケージ Export（XLSX）がダウンロードできる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/exports`);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'XLSX でダウンロード' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('監査ログが追記専用である旨と主要イベントが記録されている', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto(`/assurance/engagements/${engagementId}/audit-trail`);
    await expect(page.getByText(/監査ログは.*追記専用/)).toBeVisible();
    await expect(page.getByText('snapshot_created').first()).toBeVisible();
    await expect(page.getByText('sample_created').first()).toBeVisible();
  });
});

test.describe('アクセシビリティ', () => {
  const pages: Array<{ name: string; setup: 'enterprise' | 'assurance'; path: string }> = [
    { name: '企業ダッシュボード', setup: 'enterprise', path: '/enterprise/dashboard' },
    { name: '非財務データ一覧', setup: 'enterprise', path: '/enterprise/data' },
    { name: 'CDP ワークスペース', setup: 'enterprise', path: '/enterprise/disclosures/cdp' },
    { name: '監査法人ダッシュボード', setup: 'assurance', path: '/assurance/dashboard' },
  ];

  for (const target of pages) {
    test(`${target.name} に重大な a11y 違反がない`, async ({ page }) => {
      await loginAs(
        page,
        target.setup === 'enterprise' ? DEMO_USERS.enterpriseAdmin : DEMO_USERS.assuranceManager,
      );
      await page.goto(target.path);
      await expect(page.locator('#t4d-main')).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

      const serious = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
    });
  }

  test('j / k で一覧のレコード間を移動できる', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await gotoEnterprise(page, 'data');

    const rows = page.locator('tbody tr[data-t4d-record]');
    await expect(rows.first()).toBeVisible();

    // 未選択の状態で j を押すと先頭行へ
    await page.keyboard.press('j');
    const firstHref = await rows.nth(0).locator('a[href]').first().getAttribute('href');
    await expect(page.locator(`a[href="${firstHref}"]`).first()).toBeFocused();

    // j で次の行、k で戻る
    await page.keyboard.press('j');
    const secondHref = await rows.nth(1).locator('a[href]').first().getAttribute('href');
    expect(secondHref).not.toBe(firstHref);
    await expect(page.locator(`a[href="${secondHref}"]`).first()).toBeFocused();

    await page.keyboard.press('k');
    await expect(page.locator(`a[href="${firstHref}"]`).first()).toBeFocused();
  });

  test('入力中はショートカットが発火しない', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await gotoEnterprise(page, 'data');

    const search = page.locator('[data-t4d-list-search]').first();
    await search.click();
    await search.fill('jjkk');
    // 検索欄の値がそのまま入り、フォーカスも移動しない
    await expect(search).toHaveValue('jjkk');
    await expect(search).toBeFocused();
  });

  test('e で Evidence セクションへ移動する', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await page.goto(`/enterprise/data/${dataPointId('EAST', 'scope1', 'FY2026')}`);
    await expect(page.locator('#t4d-main')).toBeVisible();

    await page.keyboard.press('e');
    await expect(page.locator('[data-t4d-shortcut="evidence"]')).toBeFocused();
  });

  test('キーボードショートカット（Ctrl+K）でコマンドパレットが開く', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('コマンドパレット検索')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('未ログインで保護ルートへ直接アクセスするとログインへ戻される', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/enterprise/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});

/**
 * Client 側遷移（Soft Navigation）の回帰テスト。
 *
 * Next.js 15.5.23 では Layout と Page の間に Suspense 境界（`loading.tsx` を含む）が
 * あると、RSC Payload を受信済みでも遷移が確定せず URL が変わらないまま固まる
 * （https://github.com/vercel/next.js/issues/86151）。
 * 本アプリはこれを踏まえて Loading 境界を置いていない（docs/known-limitations.md 10 章）。
 * 境界が再び追加されるとここで落ちる。
 */
test.describe('Client 側遷移', () => {
  test('未訪問ルートへの Link クリックで URL と本文が切り替わる（監査法人）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.assuranceManager);
    await page.goto('/assurance/engagements');
    await expect(page.locator('#t4d-main')).toBeVisible();

    await page.getByRole('link', { name: 'ENG-2026-001' }).first().click();
    await expect(page).toHaveURL(/\/assurance\/engagements\/[^/]+\/overview/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: '案件情報' })).toBeVisible();

    // 同じ [engagementId] 配下の別ルートへも Client 遷移できる
    await page.getByRole('link', { name: 'Data Room', exact: true }).first().click();
    await expect(page).toHaveURL(/\/assurance\/engagements\/[^/]+\/data-room/, { timeout: 15_000 });
  });

  test('未訪問ルートへの Link クリックで URL と本文が切り替わる（企業）', async ({ page }) => {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await gotoEnterprise(page, 'data');

    await page.getByRole('link', { name: '詳細' }).first().click();
    await expect(page).toHaveURL(/\/enterprise\/data\/[0-9a-f-]+/, { timeout: 15_000 });
    await expect(page.locator('#t4d-main')).toBeVisible();
  });
});
