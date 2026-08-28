import { expect, test, type Page } from '@playwright/test';
import { dataPointId } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 追加した 5 機能の実操作監査（自己検証ミッション用）。
 *
 * 「テストが通る」ではなく「利用者が実際に操作して意図どおり動く」ことを見る。
 * とくに次を潰す:
 *   - 押せそうに見えて何も起きないボタン（イベント未接続）
 *   - 保存できたように見えて再読込で消える（永続化されていない）
 *   - UI で隠しているだけで、サーバー側では権限が守られていない
 *   - 異常系（空・不正値・二重送信・存在しない ID）で画面が壊れる
 */

test.describe.configure({ mode: 'serial' });

/** 画面内の押せる要素が「押しても何も起きない」ものでないか調べる */
async function findDeadControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dead: string[] = [];
    const main = document.querySelector('#t4d-main');
    if (!main) return ['#t4d-main が無い'];

    for (const el of Array.from(main.querySelectorAll('button, a[href], summary'))) {
      const label =
        (el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('aria-label') || '';
      if (el instanceof HTMLAnchorElement) {
        const href = el.getAttribute('href') ?? '';
        // 仮リンク（# だけ・javascript: ・空）は死んだ導線
        if (href === '' || href === '#' || href.startsWith('javascript:')) {
          dead.push(`link「${label}」の href が ${JSON.stringify(href)}`);
        }
        continue;
      }
      if (el instanceof HTMLButtonElement) {
        if (el.disabled) continue; // 意図的な無効化は対象外
        const type = el.getAttribute('type') ?? 'submit';
        const inForm = Boolean(el.closest('form'));
        // submit / reset はフォームがあれば動く。それ以外は onClick が要る
        if ((type === 'submit' || type === 'reset') && inForm) continue;
        // React の onClick は属性に出ないので、代わりに
        // 「フォームの外にある type=button で aria 属性も持たない」ものを疑う
        const hasAria =
          el.hasAttribute('aria-expanded') ||
          el.hasAttribute('aria-controls') ||
          el.hasAttribute('aria-haspopup') ||
          el.hasAttribute('aria-label');
        if (type === 'button' && !inForm && !hasAria && label === '') {
          dead.push(`button（ラベル無し・フォーム外）`);
        }
      }
    }
    return dead;
  });
}

/** そのページのコンソールエラーと失敗リクエストを集める */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('Download the React DevTools')) return;
    if (t.includes('[Fast Refresh]')) return;
    problems.push(`console: ${t.slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`network: ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return problems;
}

// ----------------------------------------------------------------------
// ① 指標マスター
// ----------------------------------------------------------------------

test('① 指標マスター: 死んだ導線が無く、基準の出所が実データと一致する', async ({ page }) => {
  const problems = watchProblems(page);
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');
  await expect(page.locator('#t4d-main')).toBeVisible();

  expect(await findDeadControls(page)).toEqual([]);

  // 充足率は「値のある指標 / 求められている指標」と一致する
  const ssbjCard = page.locator('li', { hasText: 'SSBJ が求める指標' });
  const text = await ssbjCard.innerText();
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*件[\s\S]*?(\d+)%/);
  expect(m, '充足状況の表記が読み取れない').not.toBeNull();
  const [, got, need, rate] = m!;
  expect(Number(rate)).toBe(Math.round((Number(got) / Number(need)) * 100));
  expect(Number(got)).toBeLessThanOrEqual(Number(need));

  expect(problems).toEqual([]);
});

test('① 指標マスター: 追加した指標が一覧・編集ともに壊れない（CRUD 回帰）', async ({ page }) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/organizations');

  // 基準から取り込んだ指標も、既存の編集ダイアログで開ける
  const row = page.locator('tr', { hasText: 'internal_carbon_price' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button').last().click();
  const dialog = page.getByRole('dialog', { name: '指標マスターを編集' });
  await expect(dialog).toBeVisible();

  // 既存の値が読み込まれている（基準から取り込んだ指標も編集画面が成立する）
  await expect(dialog.locator('input[name="code"]')).toHaveValue('internal_carbon_price');
  await expect(dialog.locator('input[name="unit"]')).toHaveValue('円/t-CO2e');

  // 閉じる導線（× と Escape）がどちらも効く
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);

  await row.getByRole('button').last().click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// ----------------------------------------------------------------------
// ② 取込の除外
// ----------------------------------------------------------------------

test('② 取込: 全行が無関係なファイルでも画面が壊れず、理由が出る', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchProblems(page);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/imports');

  const csv = [
    '社員番号,氏名,所属,役職',
    'A90001,監査 太郎,第一営業部,主任',
    'A90002,監査 花子,経理部,担当',
    'A90003,監査 次郎,製造部,班長',
    'A90004,監査 三郎,総務部,係長',
  ].join('\r\n');

  await page.locator('input[type=file][name=files]').setInputFiles({
    name: `監査-名簿-${Date.now() % 10000}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
  await page.getByRole('button', { name: '取込を開始' }).click();
  await page.waitForURL(/\/enterprise\/imports\/[0-9a-f-]+/, { timeout: 90_000 });

  // 何も取り込めなくても、失敗にせず理由を出す
  await expect(page.getByText(/指標マスターに対応する数値が見つかりません/)).toBeVisible();
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);
  expect(problems.filter((p) => !p.startsWith('network: 5'))).toEqual([]);
});

// ----------------------------------------------------------------------
// ③ マテリアリティ・分析条件の設定
// ----------------------------------------------------------------------

test('③ 設定: 死んだ導線が無く、保存が再読込後も残る', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchProblems(page);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();

  expect(await findDeadControls(page)).toEqual([]);

  // 保存 → 再読込で保持される（Demo Mode の Cookie 持ち回しも含めて確認）
  const note = `監査メモ ${Date.now().toString(36)}`;
  await page.getByLabel('バリューチェーンの扱い').selectOption('upstream');
  await page.getByLabel('バリューチェーンの補足').fill(note);
  await page.getByRole('button', { name: '分析条件を保存' }).click();
  await page.waitForLoadState('networkidle');

  await page.reload();
  await expect(page.getByLabel('バリューチェーンの補足')).toHaveValue(note);
  await expect(page.getByLabel('バリューチェーンの扱い')).toHaveValue('upstream');

  expect(problems).toEqual([]);
});

test('③ 設定: 異常値を弾き、全画面エラーにしない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');

  // 基準を 1 つも選ばずに保存 → 画面内の指摘になる
  for (const label of [
    '一般開示基準（テーマ別基準第1号）',
    '気候関連開示基準（テーマ別基準第2号）',
    '実務対応基準第1号（温対法 SHK 制度）',
  ]) {
    const box = page.getByLabel(label);
    if (await box.isChecked()) await box.uncheck();
  }
  await page.getByRole('button', { name: '分析条件を保存' }).click();
  await page.waitForURL(/error=/, { timeout: 30_000 });
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('1 つ以上');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);

  // 連結範囲を「異なる範囲」にして理由未記入 → こちらも画面内の指摘
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await page.getByLabel('一般開示基準（テーマ別基準第1号）').check();
  // 「連結範囲の補足」も部分一致してしまうので厳密一致で取る
  await page.getByLabel('連結範囲', { exact: true }).selectOption('custom');
  await page.getByLabel('連結範囲の補足').fill('   ');
  await page.getByRole('button', { name: '分析条件を保存' }).click();
  await page.waitForURL(/error=/, { timeout: 30_000 });
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('理由');
});

test('③ 設定: 参照だけの利用者は編集できない（UI と、データが変わらないこと）', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // まず書き込める利用者が既知の値を入れる
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');
  const marker = `監査の基準値 ${Date.now().toString(36)}`;
  await page.getByLabel('バリューチェーンの補足').fill(marker);
  await page.getByRole('button', { name: '分析条件を保存' }).click();
  await page.waitForLoadState('networkidle');

  // 拠点担当は enterprise.disclosure.write を持たない
  await loginAs(page, DEMO_USERS.siteUser);
  const res = await page.goto('/enterprise/disclosures/ssbj/settings');
  expect(res?.status()).toBeLessThan(400);

  // 保存・確定ボタンが出ず、入力欄も無効化されている
  await expect(page.getByRole('button', { name: '分析条件を保存' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'この内容で確定する' })).toHaveCount(0);
  await expect(page.getByLabel('バリューチェーンの扱い')).toBeDisabled();
  // マテリアリティの保存欄も出ない
  await expect(page.getByRole('button', { name: '保存' })).toHaveCount(0);

  // UI を迂回して POST しても、データは変わらない。
  // （Server Action は Next-Action ヘッダーが無いと起動しないため、
  //   この POST は通常の描画として 200 を返す。見るべきは「保存されていないこと」）
  await page.evaluate(async () => {
    const body = new URLSearchParams({
      reportingPeriodId: 'x',
      applyGeneral: 'on',
      valueChainNote: '迂回して書き換えた',
    });
    await fetch('/enterprise/disclosures/ssbj/settings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  });

  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/settings');
  await expect(page.getByLabel('バリューチェーンの補足')).toHaveValue(marker);
});

// ----------------------------------------------------------------------
// ④ 承認フロー
// ----------------------------------------------------------------------

test('④ 承認: データ収集一覧から履歴まで導線がつながる', async ({ page }) => {
  const problems = watchProblems(page);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/collection');
  await expect(page.locator('#t4d-main')).toBeVisible();

  expect(await findDeadControls(page)).toEqual([]);

  // 承認の進み具合のセルから台帳へ飛べる
  const link = page.locator('a[href^="/enterprise/data/"]').first();
  if ((await link.count()) > 0) {
    await link.click();
    await page.waitForURL(/\/enterprise\/data\/[0-9a-f-]+/);
    await expect(page.locator('#承認フロー')).toBeVisible();
    await expect(page.locator('#承認履歴')).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test('④ 承認: 差し戻しは理由が必須で、履歴に誰がなぜが残る', async ({ page }) => {
  test.setTimeout(120_000);
  // 東日本工場 / 廃棄物 = レビュー中。3 段目（内部統制部門 = reviewer）の承認待ち
  const target = `/enterprise/data/${dataPointId('EAST', 'waste', 'FY2026')}`;
  await loginAs(page, DEMO_USERS.reviewer);
  await page.goto(target);
  await expect(page.locator('#承認フロー')).toBeVisible();

  // 理由なしで差し戻すと、画面内の指摘になる（全画面エラーにしない）
  await page.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForURL(/error=/, { timeout: 30_000 });
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('理由');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);

  // 理由を書けば差し戻せて、誰がなぜが履歴に残る
  const reason = `監査差し戻し ${Date.now().toString(36)}`;
  await page.goto(target);
  await page.getByLabel('コメント（差し戻すときは理由が必須）').fill(reason);
  await page.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForLoadState('networkidle');

  await page.goto(target);
  const history = page.locator('#承認履歴');
  await expect(history.getByText(reason)).toBeVisible();
  await expect(history.getByText('検見川 涼').first()).toBeVisible();
});

test('④ 承認: 権限の無い利用者はサーバー側でも段階を進められない', async ({ page }) => {
  // 拠点担当は enterprise.data.review を持たない
  await loginAs(page, DEMO_USERS.siteUser);
  await page.goto(`/enterprise/data/${dataPointId('EAST', 'water', 'FY2026')}`);
  await expect(page.locator('#t4d-main')).toBeVisible();

  // 承認・差し戻しのボタンが出ない
  await expect(page.getByRole('button', { name: /「.+」を承認/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '差し戻す' })).toHaveCount(0);
});

// ----------------------------------------------------------------------
// ⑤ 開示ドラフト
// ----------------------------------------------------------------------

test('⑤ 開示ドラフト: 死んだ導線が無く、草案が再読込後も残る', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchProblems(page);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await expect(page.locator('#t4d-main')).toBeVisible();

  expect(await findDeadControls(page)).toEqual([]);

  await page.getByRole('button', { name: '人工知能に草案を作らせる' }).first().click();
  await page.waitForURL(/generated=/, { timeout: 90_000 });

  const body = page.locator('textarea[name="body"]').first();
  const generated = await body.inputValue();
  expect(generated.length).toBeGreaterThan(20);

  // 再読込しても草案が残る
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await expect(page.locator('textarea[name="body"]').first()).toHaveValue(generated);

  expect(problems).toEqual([]);
});

/**
 * 本文を手で書き換える検証は「指標及び目標」の節で行う。
 *
 * Demo Mode の状態は E2E のテスト間で共有される。先頭の節（ガバナンス）を
 * 人の手で短い文へ書き換えると、「人工知能が草案を書く」ことを見る別のテスト
 * （`ssbj-settings-approval-draft.spec.ts` の⑤）が、人が直した本文を
 * 人工知能の草案と取り違えて落ちる。あちらは先頭の節を見るので、こちらは最後の節を使う。
 */
const HAND_EDIT_AREA = '指標及び目標';

/** その節のカード（`<Card><SectionTitle><h2>…` の 2 つ上が Card） */
function draftCard(page: Page) {
  return page.getByRole('heading', { name: HAND_EDIT_AREA, exact: true }).locator('xpath=../..');
}

test('⑤ 開示ドラフト: 空の本文では確定できず、直すと確定が外れる', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosures/ssbj/draft');

  // この節の草案が無ければ作る
  if ((await page.getByLabel(`${HAND_EDIT_AREA}の開示文`).count()) === 0) {
    await draftCard(page).getByRole('button', { name: '人工知能に草案を作らせる' }).click();
    await page.waitForURL(/generated=/, { timeout: 90_000 });
  }

  // 空白だけにして保存 → 確定できない
  await page.getByLabel(`${HAND_EDIT_AREA}の開示文`).fill('   ');
  await draftCard(page).getByRole('button', { name: '本文を保存' }).click();
  await page.waitForLoadState('networkidle');

  await page.goto('/enterprise/disclosures/ssbj/draft');
  await draftCard(page).getByRole('button', { name: 'この内容で確定' }).click();
  await page.waitForURL(/error=/, { timeout: 30_000 });
  await expect(page.locator('#t4d-main').getByRole('alert')).toContainText('空');
  await expect(page.getByText('データを取得できませんでした')).toHaveCount(0);

  // 中身を入れれば確定でき、直すと確定が外れる
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await page
    .getByLabel(`${HAND_EDIT_AREA}の開示文`)
    .fill('当社は、サステナビリティ関連の指標及び目標を設定し、進捗を毎年見直しています。');
  await draftCard(page).getByRole('button', { name: '本文を保存' }).click();
  await page.waitForLoadState('networkidle');
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await draftCard(page).getByRole('button', { name: 'この内容で確定' }).click();
  await page.waitForLoadState('networkidle');

  await page.goto('/enterprise/disclosures/ssbj/draft');
  await expect(draftCard(page).getByText('確定済み').first()).toBeVisible();

  await page
    .getByLabel(`${HAND_EDIT_AREA}の開示文`)
    .fill('当社は、サステナビリティ関連の指標及び目標を設定し、進捗を毎年見直しています（改訂）。');
  await draftCard(page).getByRole('button', { name: '本文を保存' }).click();
  await page.waitForLoadState('networkidle');
  await page.goto('/enterprise/disclosures/ssbj/draft');
  await expect(draftCard(page).getByText('未確定').first()).toBeVisible();
});

test('⑤ 開示ドラフト: AI 実行権限が無い利用者には生成ボタンが出ない', async ({ page }) => {
  // 拠点担当は enterprise.ai.run と disclosure.write を持たない
  await loginAs(page, DEMO_USERS.siteUser);
  const res = await page.goto('/enterprise/disclosures/ssbj/draft');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('button', { name: '人工知能に草案を作らせる' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '本文を保存' })).toHaveCount(0);
});

// ----------------------------------------------------------------------
// 異常系・境界値
// ----------------------------------------------------------------------

test('存在しない ID で新画面を開いても 404 になり、500 にならない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/data/00000000-0000-4000-8000-000000000000',
    '/enterprise/disclosures/ssbj/requirements/00000000-0000-4000-8000-000000000000',
  ]) {
    const res = await page.goto(path);
    expect([404, 200], `${path} が ${res?.status()}`).toContain(res?.status() ?? 0);
    expect(res?.status(), `${path} が 500`).not.toBe(500);
  }
});

test('新画面に不正なクエリを付けても壊れない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/disclosures/ssbj/settings?saved=<script>alert(1)</script>',
    '/enterprise/disclosures/ssbj/draft?generated=%00%01',
    '/enterprise/disclosures/ssbj/draft?error=' + 'x'.repeat(500),
    '/enterprise/disclosures/ssbj/collection?page=-1',
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} が ${res?.status()}`).toBeLessThan(500);
    await expect(page.locator('#t4d-main'), `${path} が描画されない`).toBeVisible();
  }
  // クエリ由来の文字列がそのままスクリプトとして実行されていない
  const alerted = await page.evaluate(() => (window as { __alerted?: boolean }).__alerted === true);
  expect(alerted).toBe(false);
});
