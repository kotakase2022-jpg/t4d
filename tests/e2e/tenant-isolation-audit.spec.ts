import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS, ORG_IDS, dataPointId } from '@/lib/fixtures/dataset';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * テナント分離の回帰テスト（独立検収 2026-08-16 で発見された Critical に対応）。
 *
 * **Demo Mode には行レベルの防御が無い**（`DemoDbClient.findById` は単なる配列検索）。
 * したがって「見えないはずのものが見えない」ことを、
 * RLS ではなく**アプリ層だけで**担保できているかをここで検証する。
 * 本番は Demo Mode で動いているため、この経路が実質の最終防衛線になる。
 *
 * 検証する攻撃:
 *   A. 他テナントの Evidence を fileVersionId 指定で取得する（C-1）
 *   B. 他法人の Issue / レビュー Note を Server Action で書き換える（C-2）
 *   C. 他社の許諾を取り消す（C-2）
 */

test.describe.configure({ mode: 'serial' });

/**
 * Evidence 取得の可否を判定する。
 *
 * 認可を通ると signed-url は download へリダイレクトする。
 * Fixture 由来のファイルは実体が無いので download は 410 を返すが、
 * **410 に到達した時点で認可ゲートは通過している**。
 * 拒否されている場合は signed-url 自身が 404 を返し、リダイレクトが起きない。
 * したがって「最終的にどのパスへ着いたか」で判定する（状態コードだけでは区別できない）。
 */
async function evidenceReachable(page: Page, url: string): Promise<boolean> {
  // 実ブラウザの遷移で追う（fetch のリダイレクト追従はダウンロード応答で不安定なため）
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const finalPath = new URL(page.url()).pathname;
  if (finalPath === '/api/files/download') return true;
  // 拒否は signed-url 自身が 404 を返す
  expect(response?.status(), `拒否時は 404 のはず (${url})`).toBe(404);
  return false;
}
/** 企業 A（青海）の Evidence file_version を 1 件取得する。 */
async function anyEvidenceVersionIdOfAomi(page: Page): Promise<string | null> {
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto(`/enterprise/data/${dataPointId('EAST', 'scope1', 'FY2026')}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  return page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="fileVersionId="]')][0] as
      HTMLAnchorElement | undefined;
    if (!a) return null;
    return new URL(a.href).searchParams.get('fileVersionId');
  });
}

test('A: 別テナントの企業は他社の Evidence を取得できない', async ({ page }) => {
  const versionId = await anyEvidenceVersionIdOfAomi(page);
  test.skip(!versionId, '青海テクノロジーに Evidence が紐付いていない');

  // 所有者本人は取得できる（＝テストが「常に拒否」で通ってしまうのを防ぐ対照）
  expect(
    await evidenceReachable(page, `/api/files/signed-url?fileVersionId=${versionId}`),
    '所有者は認可を通過するべき（対照）',
  ).toBe(true);

  // 別テナント（蒼天マテリアル）は取得できてはいけない
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  expect(
    await evidenceReachable(page, `/api/files/signed-url?fileVersionId=${versionId}`),
    '別テナントは拒否されるべき',
  ).toBe(false);
});

test('A2: 無関係な監査法人は他社の Evidence を取得できない', async ({ page }) => {
  const versionId = await anyEvidenceVersionIdOfAomi(page);
  test.skip(!versionId, '青海テクノロジーに Evidence が紐付いていない');

  // くろべ監査法人は青海テクノロジーと保証契約を持たない
  await loginAs(page, DEMO_USERS.otherAssuranceManager);
  await page.goto('/assurance/dashboard');

  expect(await evidenceReachable(page, `/api/files/signed-url?fileVersionId=${versionId}`)).toBe(
    false,
  );

  // 他法人の engagementId を騙っても通らない
  expect(
    await evidenceReachable(
      page,
      `/api/files/signed-url?fileVersionId=${versionId}&engagementId=${ENGAGEMENT_IDS.main}`,
    ),
    '所属しない案件 ID を騙っても拒否されるべき',
  ).toBe(false);
});

/** Server Action を直接 POST する（画面にボタンが無くても実行できてしまうかを見る）。 */
async function postServerAction(
  page: Page,
  path: string,
  fields: Record<string, string>,
): Promise<number> {
  return page.evaluate(
    async ({ p, f }) => {
      const body = new URLSearchParams(f);
      const res = await fetch(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return res.status;
    },
    { p: path, f: fields },
  );
}

test('B: 他法人の Issue を Server Action で解消できない', async ({ page }) => {
  // 被害者側の Issue が open であることを確認
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT_IDS.main}/issues`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  const issueId = await page.evaluate(() => {
    const input = document.querySelector('input[name="issueId"]') as HTMLInputElement | null;
    return input?.value ?? null;
  });
  test.skip(!issueId, '解消可能な Issue が無い');
  const before = await page.locator('#t4d-main').innerText();

  // 攻撃者（別法人）は被害者の案件を閲覧できない
  await loginAs(page, DEMO_USERS.otherAssuranceManager);
  const view = await page.goto(`/assurance/engagements/${ENGAGEMENT_IDS.main}/issues`);
  expect(view?.status(), '他法人の案件は閲覧できないはず').toBe(404);

  // 自分の案件の URL へ、他法人の issueId を混ぜて POST する
  await page.goto(`/assurance/engagements/${ENGAGEMENT_IDS.other}/issues`);
  await postServerAction(page, `/assurance/engagements/${ENGAGEMENT_IDS.other}/issues`, {
    engagementId: ENGAGEMENT_IDS.other,
    issueId: issueId as string,
    resolution: 'CROSS_TENANT_WRITE_ATTEMPT',
  });

  // 被害者側で書き換わっていないこと
  await loginAs(page, DEMO_USERS.assuranceManager);
  await page.goto(`/assurance/engagements/${ENGAGEMENT_IDS.main}/issues`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  const after = await page.locator('#t4d-main').innerText();
  expect(after).not.toContain('CROSS_TENANT_WRITE_ATTEMPT');
  expect(after).toBe(before);
});

test('C: 他社の許諾を Server Action で取り消せない', async ({ page }) => {
  // 被害者（青海テクノロジー）の許諾 ID を取得
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();
  const grantId = await page.evaluate(() => {
    const input = document.querySelector('input[name="grantId"]') as HTMLInputElement | null;
    return input?.value ?? null;
  });
  test.skip(!grantId, '許諾が無い');
  const revokedBefore = await page.getByRole('button', { name: '再付与' }).count();

  // 攻撃者（蒼天マテリアル）が他社の grantId を指定して取消を試みる
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/settings');
  await postServerAction(page, '/enterprise/settings', {
    grantId: grantId as string,
    revoke: 'true',
  });

  // 被害者側で取り消されていないこと
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await page.goto('/enterprise/settings');
  await expect(page.locator('#t4d-main')).toBeVisible();
  expect(await page.getByRole('button', { name: '再付与' }).count()).toBe(revokedBefore);
});

test('D: 別テナントの組織 ID を含む storageKey を直接叩けない', async ({ page }) => {
  await loginAs(page, DEMO_USERS.otherEnterpriseAdmin);
  await page.goto('/enterprise/dashboard');
  const status = await page.evaluate(
    async (u) => (await fetch(u)).status,
    `/api/files/download?bucket=evidence-private&key=${encodeURIComponent(
      `enterprise/${ORG_IDS.aomi}/evidence/00000000-0000-4000-8000-00000000abcd/data.bin`,
    )}`,
  );
  expect(status).toBeGreaterThanOrEqual(400);
});
