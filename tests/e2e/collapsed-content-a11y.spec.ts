import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DEMO_USERS, focusRingClipIssues, loginAs } from './helpers';

/**
 * 既定で閉じた折りたたみの中身のアクセシビリティ（docs/disclosure-first.md §10.4）。
 *
 * 閉じた details の中身は描画されないため、各画面の axe（閉じた状態）では検査されない。
 * 説明・注記・補助表・「数値を表で見る」を閉じた画面で、すべての折りたたみを開いた状態でも
 * 重大な違反（serious / critical）が無いことを確かめる。幅は PC の最小想定 1280px
 * （表が横にはみ出してキーボードで読めないスクロール領域になる違反は、狭いほど起きやすい）。
 * 開閉（summary）にキーボードでフォーカスしたときのリングが、overflow のある祖先で切れないことも確かめる
 * （WCAG 2.4.7。枠いっぱいの summary を overflow-hidden の箱に入れるとリングが見えなくなる）。
 * 閲覧のみ（状態を変えない）。
 */

const PATHS = [
  '/enterprise/analysis/financial-impact',
  '/enterprise/analysis/financial-impact?sc=custom&r_energy=5',
  '/enterprise/analysis/trends',
  '/enterprise/analysis/trends?empty=1',
  '/enterprise/analysis/diagnosis',
  '/enterprise/analysis/regulations',
  '/enterprise/analysis/benchmark',
  '/enterprise/esg',
  '/enterprise/esg/scope1',
  '/enterprise/ghg',
  '/enterprise/ghg/suppliers',
  '/enterprise/dashboard',
  '/enterprise/disclosures/ssbj',
  '/enterprise/disclosures/ssbj/requirements',
  '/enterprise/disclosures/ssbj/settings',
  '/enterprise/disclosures/ssbj/plans',
  '/enterprise/disclosures/ssbj/collection',
  '/enterprise/disclosures/ssbj/draft',
  '/enterprise/disclosures/csrd',
  '/enterprise/disclosures/csrd/settings',
  '/enterprise/disclosures/csrd/settings/matters/E1',
  '/enterprise/disclosures/csrd/requirements',
  '/enterprise/disclosures/csrd/plans',
  '/enterprise/disclosures/csrd/collection',
  '/enterprise/disclosures/csrd/draft',
  '/enterprise/narratives',
  '/enterprise/data',
  '/enterprise/imports',
  '/enterprise/imports/standard',
  '/enterprise/disclosure-projects',
];

test('1280px: 既定で閉じた折りたたみをすべて開いても axe の重大な違反が無い', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  const problems: string[] = [];
  let openedTotal = 0;
  for (const path of PATHS) {
    await page.goto(path);
    await expect(page.locator('#t4d-main')).toBeVisible();
    openedTotal += await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLDetailsElement>('#t4d-main details')];
      for (const details of all) details.open = true;
      return all.length;
    });
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const violation of results.violations) {
      if (violation.impact === 'critical' || violation.impact === 'serious') {
        const targets = violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ');
        problems.push(`${path}: ${violation.id} ${targets}`);
      }
    }
  }
  // 折りたたみが 1 つも無ければ、この検査は何も確かめていない
  expect(openedTotal).toBeGreaterThan(PATHS.length);
  expect(problems.join('\n')).toBe('');
});

test('1280px: 折りたたみの開閉（summary）にキーボードでフォーカスすると、フォーカスリングが祖先の overflow で切れない', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.enterpriseAdmin);

  const problems: string[] = [];
  let checkedTotal = 0;
  for (const path of PATHS) {
    await page.goto(path);
    await expect(page.locator('#t4d-main')).toBeVisible();
    // 閉じた状態で見えている summary を 1 つずつ（閉じた details の中は描画されないため数えない）
    const result = await focusRingClipIssues(page, '#t4d-main details > summary');
    checkedTotal += result.checked;
    for (const issue of result.issues) problems.push(`${path}: ${issue}`);
  }
  // フォーカスできた summary が 1 つも無ければ、この検査は何も確かめていない
  expect(checkedTotal).toBeGreaterThan(PATHS.length);
  expect(problems.join('\n')).toBe('');
});
