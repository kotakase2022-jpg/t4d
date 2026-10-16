import { expect, test, type Page } from '@playwright/test';
import { DEMO_USERS, loginAs, openCollapsible } from './helpers';

/**
 * トライアルの範囲・条件・データ取扱（2026-10-16 の要望 ①④⑥⑦。plan §3.5 e2e:trial-scope-terms・CR-20〜CR-27）。
 *
 *  - トライアル概要: 算定の検証拠点 5（国内 1・海外 4。国コード）・将来の展開対象（全 30 拠点）・算定の検証範囲の
 *    拠点別の表・無償の範囲と別途協議（合意・標準機能・4 区分。超えても止めない・金額を出さない）・
 *    返却／削除の予定日とバックアップから消える見込み日
 *  - 展開対象の総拠点数が検証対象の拠点数より少ないと保存しない（入力は残る）
 *  - 改善管理表: 「別途協議」のタイル（費用区分で絞った表へ）、別途協議の区分の記録（費用区分が別途協議のときは必須）
 *  - データの取扱い: 処理を委ねる先の区分と秘密保持の根拠・AI の再学習・バックアップの残存期間と固定の文
 * すべて架空のデータ（デモ）。Demo Mode の「架空のトライアル記録」の注記は折りたたまない
 */

test.describe.configure({ mode: 'serial' });

const PATH = '/enterprise/trial';
const main = (page: Page) => page.locator('#t4d-main');
const FICTIONAL = '架空のトライアル記録です。実測値・実際の効果ではありません。';

test('概要: 検証拠点 5（国内 1・海外 4）・全 30 拠点・算定の検証範囲・無償の範囲と別途協議・削除の日付', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(PATH);
  await expect(main(page).getByText(FICTIONAL)).toBeVisible();

  // 計画: 算定の検証拠点（国コード・国内／海外の数）と将来の展開対象（全 N・うち検証 n）
  const sites = main(page).locator('[data-trial-verification-sites]');
  await expect(sites).toContainText('5 拠点（国内 1・海外 4）');
  await expect(sites).toContainText('タイ工場（TH）');
  await expect(sites).toContainText('米国工場（US）');
  await expect(main(page).locator('[data-trial-rollout]')).toContainText(
    '全 30 拠点（うち検証対象 5・残り 25）',
  );

  // 算定の検証範囲: 期間・Scope・活動と拠点別の状況（状態はラベル＋アイコン）
  const verification = main(page).getByRole('region', { name: '算定の検証範囲' });
  await expect(verification).toContainText('CY2025');
  const table = verification.getByRole('table', { name: '拠点別の検証の状況' });
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table.locator('tbody tr').first()).toContainText('東日本工場（JP）');
  await expect(table.locator('tbody tr').first()).toContainText('国内');
  await expect(
    verification.getByRole('link', { name: 'Scope1・2算定の概要を開く' }),
  ).toHaveAttribute('href', /\/enterprise\/ghg\/calculation\?period=/);

  // 無償の範囲と別途協議: 合意・標準機能の一覧・4 区分・超過の知らせ（操作は止めない）
  const free = main(page).getByRole('region', { name: '無償の範囲と別途協議' });
  await expect(free).toContainText('合意済み');
  await expect(free).toContainText('この一覧は製品の機能です。無償の範囲は上の合意に従います。');
  const kinds = free.getByRole('table', { name: '別途協議の区分' });
  await expect(kinds.locator('tbody tr')).toHaveCount(4);
  await expect(kinds).toContainText('大幅な拠点追加');
  await expect(kinds).toContainText('大量の PDF 等の一次データ処理');
  await expect(kinds).toContainText('外部システムとの個別連携');
  await expect(kinds).toContainText('新規機能の個別開発');
  await expect(free).toContainText('別途協議の対象になりうる利用があります（操作は止めません）');
  await expect(free).not.toContainText('円');

  // 終了時の扱い: 返却・削除の予定日と、バックアップから消える見込み日（予定日 + 合意した残存期間）
  await expect(main(page).locator('[data-trial-disposal]')).not.toContainText('未設定');
  await expect(main(page).locator('[data-trial-purge]')).toContainText('残存期間 35 日');
});

test('概要: 作成担当も検証範囲・無償の範囲を読める（合意の記録・計画の編集の操作は出さない）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(PATH);
  await expect(main(page).getByRole('region', { name: '算定の検証範囲' })).toBeVisible();
  await expect(main(page).getByRole('region', { name: '無償の範囲と別途協議' })).toBeVisible();
  await expect(main(page).getByRole('link', { name: '合意を記録' })).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: '計画を編集' })).toHaveCount(0);
});

test('計画: 展開対象の総拠点数が検証対象の拠点数より少ないと保存しない（入力は残る）', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=overview&edit=1`);
  const panel = page.locator('#trial-plan-panel');
  await expect(panel).toBeVisible();
  const section = await openCollapsible(panel, '算定の検証範囲と将来の展開対象');
  await expect(section.getByLabel('算定の検証期間')).toHaveValue(/.+/);
  await expect(section.getByRole('checkbox', { name: 'タイ工場（TH）' })).toBeChecked();
  const total = section.getByLabel('将来の展開対象の総拠点数');
  await expect(total).toHaveValue('30');
  await total.fill('4');
  await panel.getByRole('button', { name: '計画を保存' }).click();
  await expect(panel.getByRole('alert')).toContainText(
    '将来の展開対象の拠点数（4）が検証対象の拠点数（5）より少なくなっています',
  );
  await expect(panel.getByLabel('将来の展開対象の総拠点数')).toHaveValue('4');
  // 保存していないので概要は全 30 拠点のまま
  await page.goto(PATH);
  await expect(main(page).locator('[data-trial-rollout]')).toContainText('全 30 拠点');
});

test('改善管理表: 「別途協議」のタイルから絞り込み、区分を記録する（別途協議では区分が必須）', async ({
  page,
}) => {
  const title = `（E2E）社内システムとの連携の相談 ${Date.now()}`;
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`${PATH}?tab=feedback`);
  const tile = main(page).locator('[data-metric-tile]').filter({ hasText: '別途協議' });
  await expect(tile).toContainText('新規機能の個別開発 1');
  // タイルそのものが絞り込んだ一覧へのリンク
  await expect(tile).toHaveAttribute('href', /cost=separate_estimate/);
  await tile.click();
  await page.waitForURL(/cost=separate_estimate/);
  const table = main(page).getByRole('table', { name: '改善管理表' });
  await expect(table.locator('tbody tr').first()).toContainText('別途協議');

  // 新しい論点を登録し、費用区分を別途協議にする（区分を選ばないと断る）
  await page.goto(`${PATH}?tab=feedback&new=1`);
  const meeting = page.locator('#trial-meeting-panel');
  await meeting.getByLabel('件名').fill(title);
  await meeting.getByRole('button', { name: '論点を登録' }).click();
  await page.waitForURL(/flash=trialFeedbackRecorded/);
  await main(page)
    .getByRole('table', { name: '改善管理表' })
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('link', { name: '対応を記録' })
    .click();
  const triage = page.locator('#trial-triage-panel');
  await triage.locator('select[name="costClass"]').selectOption('separate_estimate');
  await triage.getByRole('button', { name: '対応を保存' }).click();
  await expect(triage.getByRole('alert')).toContainText('別途協議の区分');
  await triage.locator('select[name="scopeKind"]').selectOption('system_integration');
  await triage.getByRole('button', { name: '対応を保存' }).click();
  await page.waitForURL(/flash=trialFeedbackTriaged/);
  await expect(
    main(page)
      .getByRole('table', { name: '改善管理表' })
      .getByRole('row')
      .filter({ hasText: title }),
  ).toContainText('外部システムとの個別連携');

  // 概要の 4 区分に件数が反映される（止めずに知らせる）
  await page.goto(PATH);
  const kinds = main(page)
    .getByRole('region', { name: '無償の範囲と別途協議' })
    .getByRole('table', { name: '別途協議の区分' });
  await expect(
    kinds.locator('tbody tr').filter({ hasText: '外部システムとの個別連携' }),
  ).toContainText('別途協議の目安を超過');
});

test('データの取扱い: 処理を委ねる先の区分・秘密保持の根拠・AI の再学習・残存期間と固定の文', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings?tab=data-handling');
  await expect(page.getByText('デモの条件は架空の記録です')).toBeVisible();
  await expect(main(page)).toContainText('この環境が使う外部の処理先');

  const processors = main(page).getByRole('table', { name: '処理を委ねる先' });
  await expect(processors).toContainText('業務委託先');
  await expect(processors).toContainText('クラウドサービス提供者');
  await expect(processors).toContainText('AI サービス提供者');
  await expect(processors).toContainText('（架空）個別の秘密保持契約');
  await expect(
    processors.locator('tbody tr').filter({ hasText: 'AI サービス提供者' }),
  ).toContainText('再学習に使わない');

  const conditions = main(page).getByRole('table', { name: '合意した条件' });
  await expect(conditions).toContainText('処理を委ねる先（業務委託先・クラウド・AI）');
  await expect(
    conditions.locator('tr').filter({ hasText: 'バックアップの残存期間' }),
  ).toContainText('35 日');
  const residual = main(page).locator('[data-backup-residual]');
  await expect(residual).toContainText('合意: 35 日');
  await expect(residual).toContainText('それまで秘密情報として管理します');

  // 版の記録の欄は区分ごとの入力と残存期間（日）を、現在の版の値で開く
  await main(page)
    .locator('[data-page-actions]')
    .getByRole('link', { name: '条件の版を記録' })
    .click();
  const form = await openCollapsible(main(page), '処理を委ねる先（業務委託先・クラウド・AI）');
  await expect(form.getByLabel('クラウドサービス提供者')).toHaveValue(/（架空）クラウド事業者/);
  await expect(form.getByLabel('AI サービス提供者')).toHaveValue(/（架空）AI サービス提供者/);
  await expect(main(page).getByLabel('バックアップの残存期間（日）')).toHaveValue('35');
});
