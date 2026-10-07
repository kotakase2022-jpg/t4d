import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import {
  assuranceSamples,
  countVisibleEmphasis,
  ENTERPRISE_SAMPLES,
  resolveSample,
  type RouteSample,
} from '@tests/support/route-samples';
import { DEMO_USERS, loginAs, setDisclosureFirst } from './helpers';

/**
 * One Screen, One Primary（docs/ui-redesign/plan.md §1.6・§5.2）。
 *
 * 全ルート × 役割で画面を開き、main の中で見えている primary（[data-variant="primary"]）が 1 つ以下、
 * ダイアログの外に danger（[data-variant="danger"]）が無いことを確かめる。
 *
 * Stage A は現状の違反をスライス別の許容リスト（基準ファイル）に固定し、Stage B が各自の表を空にした。
 * Stage C で許容リストそのものを消して厳格化した（例外なし）。違反は画面とボタンの名前で報告する。
 */

test.describe.configure({ mode: 'serial' });

async function audit(page: Page, role: string, samples: RouteSample[]): Promise<string[]> {
  const problems: string[] = [];
  for (const sample of samples) {
    const url = await resolveSample(page, sample);
    if (!url) {
      // 詳細画面の一覧が空（この役割に見えない・データが無い）。その旨を残し、数えない
      console.log(`[primary-audit] ${role} ${sample.key}: 一覧に行が無いため開けない`);
      continue;
    }
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (response?.status() === 404 && url.startsWith('/assurance/engagements/')) {
      // 案件のメンバーでない役割（法人管理者など）には、案件の存在を秘匿して 404 を返す（仕様）。開けない画面は数えない
      console.log(
        `[primary-audit] ${role} ${sample.key}: 案件のメンバーでないため 404（存在の秘匿）`,
      );
      continue;
    }
    await expect(page.locator('#t4d-main')).toBeVisible();
    const counts = await countVisibleEmphasis(page);
    if (counts.primary > 1 || counts.danger > 0) {
      problems.push(
        `${role} ${sample.key}（${url}）: primary ${counts.primary}（${counts.primaryLabels.join('・')}）・danger ${counts.danger}（${counts.dangerLabels.join('・')}）`,
      );
    }
  }
  return problems;
}

const ENTERPRISE_ROLES = [
  ['admin', DEMO_USERS.enterpriseAdmin],
  ['preparer', DEMO_USERS.sustainability],
  ['site', DEMO_USERS.siteUser],
  ['reviewer', DEMO_USERS.reviewer],
  ['approver', DEMO_USERS.approver],
] as const;

for (const [role, user] of ENTERPRISE_ROLES) {
  test(`従来メニュー: ${role} の全画面で primary は 1 つ以下`, async ({ page }) => {
    test.setTimeout(600_000);
    await loginAs(page, user);
    const problems = await audit(page, `classic:${role}`, ENTERPRISE_SAMPLES);
    expect(problems).toEqual([]);
  });
}

test('開示優先モード: ホーム・取込・資料の primary は 1 つ以下（5 役割）', async ({ page }) => {
  test.setTimeout(600_000);
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  const problems: string[] = [];
  try {
    for (const [role, user] of ENTERPRISE_ROLES) {
      await loginAs(page, user);
      problems.push(
        ...(await audit(
          page,
          `disclosure:${role}`,
          ENTERPRISE_SAMPLES.filter((s) => s.disclosureFirst),
        )),
      );
    }
  } finally {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await setDisclosureFirst(page, false);
  }
  expect(problems).toEqual([]);
});

const ASSURANCE_ROLES = [
  ['partner', DEMO_USERS.assurancePartner],
  ['manager', DEMO_USERS.assuranceManager],
  ['staff', DEMO_USERS.assuranceStaff],
  ['firm-admin', DEMO_USERS.assuranceAdmin],
] as const;

for (const [role, user] of ASSURANCE_ROLES) {
  test(`監査法人: ${role} の全画面で primary は 1 つ以下`, async ({ page }) => {
    test.setTimeout(300_000);
    await loginAs(page, user);
    const problems = await audit(page, `assurance:${role}`, assuranceSamples(ENGAGEMENT_IDS.main));
    expect(problems).toEqual([]);
  });
}
