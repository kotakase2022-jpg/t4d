import { expect, test } from '@playwright/test';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';

/**
 * 本番スモークテスト（自己検証ミッション用）。
 *
 *   PROD_BASE_URL=https://terrast-t4d.vercel.app pnpm exec playwright test production-smoke
 *
 * 本番は Demo Mode（架空データ・環境変数なし）なので、
 * 本番データを壊す操作は行わない。読み取りと、Demo データ上での
 * 一時的な操作（コメント・マテリアリティ評価）に留める。
 */

const BASE = process.env.PROD_BASE_URL ?? 'https://terrast-t4d.vercel.app';

test.describe.configure({ mode: 'serial' });

/** 本番のデモログイン（パスワード不要） */
async function prodLogin(page: import('@playwright/test').Page, displayName: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole('heading', { name: 'デモログイン' })).toBeVisible();
  // 別テナントのアカウントは折りたたみの中にあるので、必要なら開く
  const details = page.locator('details', { hasText: '越権テスト用' });
  if ((await details.count()) > 0) {
    const open = await details.first().evaluate((el: HTMLDetailsElement) => el.open);
    if (!open) await details.first().locator('summary').click();
  }
  await page.locator('form', { hasText: displayName }).getByRole('button').first().click();
  await page.waitForURL(/\/workspace|\/enterprise|\/assurance/);
  if (new URL(page.url()).pathname === '/workspace') {
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL(/\/(enterprise|assurance)\//);
  }
}

test('本番: 主要画面が描画され、コンソール・ネットワークに異常が無い', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('Download the React DevTools')) return;
    problems.push(`console: ${t.slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) {
      problems.push(`network: ${r.status()} ${r.url().replace(BASE, '')}`);
    }
  });

  await prodLogin(page, '青海 太郎');

  for (const path of [
    '/enterprise/dashboard',
    '/enterprise/data',
    '/enterprise/imports',
    '/enterprise/organizations',
    '/enterprise/evidence',
    '/enterprise/workflows',
    '/enterprise/ghg',
    '/enterprise/disclosures/cdp',
    '/enterprise/disclosures/ssbj',
    '/enterprise/disclosures/csrd',
    '/enterprise/alerts',
    '/enterprise/ai',
    '/enterprise/reports',
    '/enterprise/settings',
    '/notifications',
  ]) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${path} が ${res?.status()}`).toBeLessThan(400);
    await expect(page.locator('#t4d-main'), `${path} が描画されない`).toBeVisible();
  }

  expect(problems.join('\n')).toBe('');
});

test('本番: 一覧の絞り込み・並べ替え・ページングが動く', async ({ page }) => {
  await prodLogin(page, '海野 みどり');

  await page.goto(`${BASE}/enterprise/data`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 組織タグ「連結対象のみ」
  await page.getByRole('button', { name: '連結対象のみ', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('tbody').getByText('青海マテリアル合弁会社')).toHaveCount(0);

  // 状態フィルタ
  await page.goto(`${BASE}/enterprise/data?status=approved`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 並べ替え
  await page.goto(`${BASE}/enterprise/data?sort=value&dir=desc`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // ページング（範囲外でも壊れない）
  await page.goto(`${BASE}/enterprise/data?page=9999`);
  await expect(page.locator('#t4d-main')).toBeVisible();
});

test('本番: Evidence が紙面として表示される', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/evidence`);
  await page
    .locator('tr', { hasText: '電力請求書' })
    .first()
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/[0-9a-f-]+/);

  await expect(page.getByText(/請求番号/).first()).toBeVisible();
  await expect(page.getByText(/合計使用電力量|ご請求金額/).first()).toBeVisible();
  await expect(page.getByText('架空のサンプル資料')).toBeVisible();
});

test('本番: AI Copilot が実データに基づいて答える', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/ai`);

  await page.locator('input[name="question"]').fill('Scope1 の当年値と前年比は？');
  await page.getByRole('button', { name: '質問する' }).click();

  // 回答はサーバーアクションの戻り値で描画される（リダイレクトしない）
  await expect(page.getByText(/t-CO2e です/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('出典').first()).toBeVisible();
});

test('本番: 取込フロー（ファイル投入 → AI 仕分け → プレビュー）が動く', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 1000 + (Date.now() % 8000);
  const csv = ['拠点,項目,値,単位,期間', `本社,電力使用量,${marker},MWh,FY2026`].join('\r\n');
  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `prod-smoke-${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);

  await expect(page.getByText('解析が完了しました')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();
  // AI が指標を推定している
  const metricSelect = page.locator('select[name^="metricId:"]').first();
  await expect(metricSelect).toBeVisible();
  expect(await metricSelect.inputValue()).not.toBe('');
});

test('本番: SSBJ のマテリアリティ登録が永続化される', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/disclosures/ssbj`);
  await expect(page.getByText('マテリアリティ充足度')).toBeVisible();

  const reason = `本番スモーク ${Date.now().toString(36)}`;
  const row = page.locator('tr', { hasText: '労働安全衛生' });
  await row.getByRole('combobox').selectOption('high');
  await row.getByRole('textbox').fill(reason);
  await row.getByRole('button', { name: '保存' }).click();
  await page.waitForLoadState('networkidle');

  await page.reload();
  await expect(page.getByText(reason)).toBeVisible();
});

test('本番: 権限制御（未ログイン・他テナント）が効いている', async ({ page }) => {
  // 未ログインでは保護画面へ入れない
  await page.context().clearCookies();
  await page.goto(`${BASE}/enterprise/data`);
  await expect(page).toHaveURL(/\/login/);

  // 別テナントは他社の Evidence を開けない
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/evidence`);
  const href = (await page
    .locator('a[href^="/enterprise/evidence/"]')
    .first()
    .getAttribute('href'))!;

  await prodLogin(page, '蒼天 次郎');
  const res = await page.goto(`${BASE}${href}`);
  expect(res?.status(), '他テナントのファイルが見えている').toBe(404);
});

test('本番: 監査法人ワークスペースが Read-only で動く', async ({ page }) => {
  await prodLogin(page, '青葉 健');
  await page.goto(`${BASE}/assurance/engagements`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // Demo Mode の在庫はインスタンスごとに違う（別セッションが起票した案件が
  // 一覧にだけ出ることがある）。判定を安定させるため Fixture の案件を名指しする。
  const row = page.locator('tr', { hasText: 'ENG-2026-001' });
  await expect(row, 'Fixture の案件が一覧に無い').toBeVisible();
  const base = (await row
    .locator('a[href^="/assurance/engagements/"]')
    .first()
    .getAttribute('href'))!.replace(/\/[^/]*$/, '');
  for (const p of ['overview', 'data-room', 'population', 'sampling', 'testing', 'signoffs']) {
    const res = await page.goto(`${BASE}${base}/${p}`);
    expect(res?.status(), `${p} が開けない`).toBeLessThan(400);
    await expect(page.locator('#t4d-main')).toBeVisible();
  }
});

test('本番: 多言語・多形式のファイルを一括取込して AI が仕分けする', async ({ page }) => {
  // 本番（Demo Mode）は取込結果を Cookie に控えて持ち回す。複数ファイルでも
  // 直後のプレビューが読めることを、実際のファイルで確認する。
  const dataset = await buildHeterogeneousDataset();
  const pick = (prefix: string) => {
    const f = dataset.find((d) => d.name.startsWith(prefix))!;
    return { name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) };
  };

  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  await page.locator('input[name="files"]').setInputFiles([pick('06_'), pick('17_')]);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/);

  // ドイツ語の 1.234,5 が 1234.5 として解釈され、指標が自動選択されている
  const germanRow = page
    .locator('tr', { hasText: 'Stromverbrauch' })
    .filter({ has: page.locator('input[name^="value:"]') })
    .first();
  await expect(germanRow).toBeVisible({ timeout: 60_000 });
  await expect(germanRow.locator('input[name^="value:"]')).toHaveValue('1234.5');
  await expect(germanRow.locator('select').first()).not.toHaveValue('');

  // Shift_JIS のファイルが文字化けせずに読めている
  await expect(page.locator('#t4d-main')).toContainText('使用量');
});

test('本番: 企業が監査法人へアクセス許諾を新規付与できる', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/settings`);

  const form = page.locator('form', { hasText: '許諾する' });
  await expect(form, '許諾を新規付与するフォームが無い').toBeVisible();

  await form.locator('select[name="subjectType"]').selectOption('metric');
  await form.locator('select[name="subjectId"]').selectOption({ label: '水使用量' });
  await form.getByRole('button', { name: '許諾する' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.locator('tr', { hasText: '水使用量' }).first()).toContainText('有効');
});

test('本番: 通知を既読にできる', async ({ page }) => {
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/notifications`);

  const unreadBefore = await page.getByText('未読', { exact: true }).count();
  expect(unreadBefore, '未読の通知が必要').toBeGreaterThan(0);

  await page.getByRole('button', { name: '既読にする' }).first().click();
  await page.waitForLoadState('networkidle');

  expect(await page.getByText('未読', { exact: true }).count()).toBe(unreadBefore - 1);
});

test('本番: 入力の誤りが理由付きで画面に出る（digest だけにならない）', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/settings`);

  const form = page.locator('form', { hasText: '許諾する' });
  await form.locator('select[name="subjectType"]').selectOption('reporting_period');
  await form.locator('select[name="subjectId"]').selectOption({ label: 'Scope1 排出量' });
  await form.getByRole('button', { name: '許諾する' }).click();

  await page.waitForURL(/error=/);
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('正しくありません');
});

test('本番: 監査法人が新しい案件を起票できる', async ({ page }) => {
  await prodLogin(page, '青葉 健');
  await page.goto(`${BASE}/assurance/engagements`);

  const form = page.locator('form', { hasText: '起票' });
  await expect(form, '案件を起票するフォームが無い').toBeVisible();

  const code = `ENG-PROD-${Math.floor(Date.now() % 100000)}`;
  await form.locator('input[name="code"]').fill(code);
  await form.locator('input[name="name"]').fill('本番スモークの保証契約');
  await form.getByRole('button', { name: '起票' }).click();

  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  await expect(page.locator('#t4d-main')).toContainText('本番スモークの保証契約');
});

test('本番: SSBJ の開示ドラフトを出力できる', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/disclosures/ssbj`);

  // 正式基準マスター（133 項目・転載許可・出所表記）が本番に載っていること。
  // 旧デプロイのままでもスモークが通ってしまった実績があるため、内容で判定する
  await expect(page.getByText('正式基準準拠（転載許可取得済み）')).toBeVisible();
  await expect(page.getByText('出所：サステナビリティ基準委員会', { exact: false })).toBeVisible();
  await expect(page.locator('#t4d-main')).not.toContainText('架空の縮小マスター');
  // 要求事項そのものは一覧画面に移した（対応状況画面は集計を出す）
  await expect(page.getByText('全 133 要求事項', { exact: false })).toHaveCount(0);

  const link = page.getByRole('link', { name: /開示ドラフト（DOCX）/ });
  await expect(link, 'SSBJ の Export 導線が無い').toBeVisible();

  const href = (await link.getAttribute('href'))!;
  const res = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, disposition: r.headers.get('content-disposition') ?? '' };
  }, href);
  expect(res.status).toBe(200);
  expect(decodeURIComponent(res.disposition)).toContain('SSBJ');
});

test('本番: AI に異常値の原因を説明させられる（値は変わらない）', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/data?flag=validation_error`);
  const href = (await page.locator('a[href^="/enterprise/data/"]').first().getAttribute('href'))!;
  await page.goto(`${BASE}${href}`);

  const valueBefore = await page.locator('input[name="value"]').inputValue();
  await page.getByRole('button', { name: 'AI に原因を説明させる' }).click();
  await page.waitForURL(/explain=/);

  await expect(page.getByText('考えられる原因:').first()).toBeVisible();
  expect(await page.locator('input[name="value"]').inputValue()).toBe(valueBefore);
});

test('本番: 報告年度を追加できる', async ({ page }) => {
  await prodLogin(page, '青海 太郎');
  await page.goto(`${BASE}/enterprise/organizations`);

  await expect(page.getByRole('heading', { name: /報告年度（/ })).toBeVisible();
  await page.getByRole('button', { name: '報告年度を追加' }).click();

  const code = `FY${2040 + (Date.now() % 50)}`;
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="code"]').fill(code);
  await dialog.locator('input[name="label"]').fill(`${code} 年度`);
  await dialog.locator('input[name="startDate"]').fill('2040-04-01');
  await dialog.locator('input[name="endDate"]').fill('2041-03-31');
  await dialog.getByRole('button', { name: '作成' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.locator('tr', { hasText: code }).first()).toBeVisible();
});

test('本番: 50 ファイルを一括取込し、プレビューから確定まで通る', async ({ page }) => {
  test.setTimeout(300_000);
  const dataset = await buildHeterogeneousDataset();
  const files = dataset.slice(0, 50).map((f) => ({
    name: f.name,
    mimeType: f.mimeType,
    buffer: Buffer.from(f.bytes),
  }));
  expect(files.length).toBe(50);

  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await page.locator('input[name="files"]').setInputFiles(files);
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  // インスタンスが変わっても、タブが預かった内容からプレビューが出る
  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  const count = await rows.count();
  expect(count, '50 ファイル分の行が出ていない').toBeGreaterThan(50);

  // 確定して台帳へ反映
  await page.getByRole('button', { name: '選択した行を確定' }).click();
  await page.waitForURL(/\/enterprise\/data/, { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText('取込内容を確定');
});

test('本番: 人的資本 20 ファイルの同時取込でバウンダリ差異が検知される', async ({ page }) => {
  test.setTimeout(300_000);
  const { buildHumanCapitalDataset } = await import('../../scripts/human-capital-dataset');
  const dataset = await buildHumanCapitalDataset();
  expect(dataset).toHaveLength(20);

  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await page
    .locator('input[name="files"]')
    .setInputFiles(
      dataset.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) })),
    );
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 240_000 });

  const rows = page.locator('input[name^="value:"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  expect(await rows.count(), '明細の深さが出ていない').toBeGreaterThan(300);

  const main = page.locator('#t4d-main');
  await expect(main.getByText(/バウンダリ差異（雇用範囲）/).first()).toBeVisible();
  await expect(main.getByText(/バウンダリ差異（管理職の定義）/).first()).toBeVisible();
  await expect(main.getByText(/集計範囲を揃えてから確定してください/).first()).toBeVisible();

  // 帳票に混ざる小計・合計行が検知され、明細と一緒には確定されない（二重計上の防止）
  await expect(main.getByText(/集計行（小計・合計）の可能性があります/).first()).toBeVisible();
  const totalRow = page.locator('tr', { hasText: '集計行（小計・合計）の可能性' }).first();
  await expect(totalRow.locator('input[type="checkbox"]')).not.toBeChecked();

  // 帳票名・出力条件の行がデータ行として並んでいない
  await expect(main.getByText('在籍者集計表（部門別・雇用区分別）')).toHaveCount(0);
});

test('本番: SSBJ の 5 画面が動く（対応状況・要求事項・詳細・対応計画・データ収集）', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await prodLogin(page, '海野 みどり');
  const main = page.locator('#t4d-main');

  // ① 対応状況: 単一の総合点ではなく 3 つの整備度を出す
  await page.goto(`${BASE}/enterprise/disclosures/ssbj`);
  await expect(main.getByText('開示対応度')).toBeVisible();
  await expect(main.getByText('データ整備度')).toBeVisible();
  await expect(main.getByText('業務プロセス・内部統制整備度')).toBeVisible();
  await expect(main.getByText('領域別の対応状況')).toBeVisible();
  await expect(main.getByText('優先して対応するギャップ')).toBeVisible();

  // ② 要求事項一覧: 正式基準の 133 項目が並び、AI 判定と最終判定が別の列になっている
  await page.goto(`${BASE}/enterprise/disclosures/ssbj/requirements`);
  await expect(main.getByText('全 133 要求事項', { exact: false })).toBeVisible();
  await expect(main.getByRole('columnheader', { name: '人工知能による判定' })).toBeVisible();
  await expect(main.getByRole('columnheader', { name: '最終判定' })).toBeVisible();
  expect(await page.locator('tbody tr').count()).toBe(133);

  // ③ 詳細: 3 種類のギャップと優先順位の根拠
  await page.locator('tbody tr a').first().click();
  await page.waitForURL(/\/requirements\/[0-9a-f-]+/);
  await expect(main.getByText('開示ギャップ')).toBeVisible();
  await expect(main.getByText('データギャップ')).toBeVisible();
  await expect(main.getByText('業務プロセス・内部統制ギャップ')).toBeVisible();
  await expect(main.getByText('優先順位の評価')).toBeVisible();

  // ④ 対応計画
  await page.goto(`${BASE}/enterprise/disclosures/ssbj/plans`);
  await expect(main.getByRole('columnheader', { name: '対応区分' })).toBeVisible();

  // ⑤ データ収集
  await page.goto(`${BASE}/enterprise/disclosures/ssbj/collection`);
  await expect(main.getByRole('columnheader', { name: 'データ項目' })).toBeVisible();
});

test('本番: デモシナリオが SSBJ 対応を軸に一巡する', async ({ page }) => {
  test.setTimeout(180_000);
  await prodLogin(page, '海野 みどり');

  // ホームの起点が SSBJ になっている
  await page.goto(`${BASE}/enterprise/dashboard`);
  const main = page.locator('#t4d-main');
  await expect(main.getByText('SSBJ 対応度')).toBeVisible();
  await expect(main.getByText('SSBJ 未対応')).toBeVisible();

  // デモモードを開始すると SSBJ 対応の現在地から始まる
  await page.getByRole('button', { name: 'デモモード' }).click();
  const dialog = page.getByRole('dialog', { name: /デモモード/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 / 12');
  await expect(dialog).toContainText('SSBJ 対応の現在地');

  // 4 番目で最優先ギャップの詳細へ直行する。
  // 遷移の完了を待たずに連打すると、前の遷移の途中で次が始まって取りこぼす
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj$/);
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements$/);
  await dialog.getByRole('button', { name: '次へ' }).click();
  await page.waitForURL(/\/enterprise\/disclosures\/ssbj\/requirements\/[0-9a-f-]+/);
  await expect(main.getByText('開示ギャップ')).toBeVisible();
  await expect(dialog).toContainText('手順 4');

  await dialog.getByRole('button', { name: 'デモモードを終了' }).click();
  await expect(page.getByRole('dialog', { name: /デモモード/ })).toHaveCount(0);
});

test('本番: ファイルをドロップするとそのまま取込が始まる', async ({ page }) => {
  test.setTimeout(180_000);
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 5000 + (Date.now() % 3000);
  const dataTransfer = await page.evaluateHandle((value) => {
    const dt = new DataTransfer();
    const csv = ['拠点,項目,値,単位,期間', `本社,電力使用量,${value},MWh,FY2026`].join('\r\n');
    dt.items.add(new File(['\ufeff' + csv], `prod-drop-${value}.csv`, { type: 'text/csv' }));
    return dt;
  }, marker);

  const zone = page.locator('label[for="import-files"]');
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });

  // 受け付けたことが画面に出る
  await expect(page.getByText(`prod-drop-${marker}.csv`).first()).toBeVisible();
  // ボタンを押さなくても解析が始まり、プレビューへ進む
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 120_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();
});

test('本番: 取り込めないファイルはエラー画面に落とさず、理由を名指しする', async ({ page }) => {
  test.setTimeout(120_000);
  await prodLogin(page, '海野 みどり');
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['PNG'], '写真.png', { type: 'image/png' }));
    return dt;
  });
  const zone = page.locator('label[for="import-files"]');
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });

  // 「データを取得できませんでした」ではなく、どのファイルがなぜ駄目かを画面で伝える
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('写真.png');
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('拡張子');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});

test('本番: .txt は中身で振り分けて取り込む（表は行に、自由記述は資料に）', async ({ page }) => {
  test.setTimeout(180_000);
  await prodLogin(page, '海野 みどり');
  const zone = page.locator('label[for="import-files"]');

  // 1. タブ区切りの .txt は表として読み、値が行になる
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const marker = 8000 + (Date.now() % 900);
  const tabbed = await page.evaluateHandle((value) => {
    const dt = new DataTransfer();
    const txt = ['拠点\t項目\t値\t単位\t期間', `本社\t電力使用量\t${value}\tMWh\tFY2026`].join(
      '\r\n',
    );
    dt.items.add(new File(['﻿' + txt], `prod-tab-${value}.txt`, { type: 'text/plain' }));
    return dt;
  }, marker);
  await zone.dispatchEvent('dragover', { dataTransfer: tabbed });
  await zone.dispatchEvent('drop', { dataTransfer: tabbed });

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 120_000 });
  await expect(page.getByText(String(marker)).first()).toBeVisible();

  // 2. 自由記述の .txt はエラーにせず、資料として取り込む
  await page.goto(`${BASE}/enterprise/imports`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  const prose = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    const txt = [
      'サステナビリティ委員会 議事録',
      '気候関連リスクの評価方法について審議した。',
      '取締役会への報告は四半期ごととする。',
    ].join('\n');
    dt.items.add(new File([txt], 'prod-議事録.txt', { type: 'text/plain' }));
    return dt;
  });
  await page
    .locator('label[for="import-files"]')
    .dispatchEvent('dragover', { dataTransfer: prose });
  await page.locator('label[for="import-files"]').dispatchEvent('drop', { dataTransfer: prose });

  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 120_000 });
  await expect(page.getByText(/資料として取り込みました/).first()).toBeVisible();
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
});
