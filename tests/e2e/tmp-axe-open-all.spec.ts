import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DEMO_USERS, loginAs } from './helpers';

// 一時的な確認用（Stage C）。すべての details を開いた状態で axe を流す。確認後に削除する
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
  '/enterprise/disclosures/ssbj/plans',
  '/enterprise/disclosures/ssbj/collection',
  '/enterprise/disclosures/ssbj/draft',
  '/enterprise/disclosures/csrd',
  '/enterprise/disclosures/csrd/settings',
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

for (const width of [1280, 1440]) {
  test(`${width}px: 折りたたみをすべて開いても axe の重大な違反が無い`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    const problems: string[] = [];
    for (const path of PATHS) {
      await page.goto(path);
      await expect(page.locator('#t4d-main')).toBeVisible();
      await page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>('#t4d-main details'))
          d.open = true;
      });
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      for (const v of results.violations) {
        if (v.impact === 'critical' || v.impact === 'serious') {
          problems.push(
            `${path}: ${v.id} ${v.nodes
              .map((n) => n.target.join(' '))
              .slice(0, 3)
              .join(' | ')}`,
          );
        }
      }
    }
    expect(problems.join('\n')).toBe('');
  });
}
