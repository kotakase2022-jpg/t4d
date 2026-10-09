import { expect, test, type Page } from '@playwright/test';
import { ENGAGEMENT_IDS } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import {
  ROUTE_CATALOG,
  canOpenRoute,
  resolveRouteHref,
  routeForPath,
} from '@/components/shared/route-catalog';
import { permissionsFor } from '@/lib/authorization/can';
import type { PermissionKey, RoleKey } from '@/types/domain';
import { DEMO_USERS, loginAs, setDisclosureFirst } from './helpers';

/**
 * 全ルートに到達できる（E2E。docs/ui-redesign/plan.md §5.2・IF §7.2）。
 *
 * 種はホームだけ。サイドバー・本文の内部リンクを、ルートのパターンごとに 1 回ずつ辿る。
 * リンクで辿れなかった画面は Command Palette で画面名を引き、その画面の候補が出ることを確かめる。
 * 期待集合は「その役割が開ける画面」（ROUTE_CATALOG の権限）。期待集合 ⊆ 訪問 ∪ パレット。
 * 同時に次も確かめる:
 *  - メニューの項目を開いて「アクセス権限がありません」にならない（メニューは権限で絞っているため）
 *  - 画面に出ている出力のリンク（/api/…）が 403 にならない（権限の無い出力リンクを出さない。R3）
 *  既知の例外の表（KNOWN_FORBIDDEN_EXPORTS・KNOWN_MENU_DENIED）は空（Stage C で例外なしにした）
 */

test.describe.configure({ mode: 'serial' });

/**
 * 既知の例外の表（Stage A が現状を固定し、Stage B・C が直して空にした。例外なしで検査する）。
 * 新しい例外を足すときは理由と担当を書く。起きなくなった例外は「表から消す」で失敗する（常に通るだけの表にしない）
 *  - KNOWN_FORBIDDEN_EXPORTS: 出力リンクが権限の無い役割にも出ている画面（IF §6.2 R3）
 *  - KNOWN_MENU_DENIED: メニューに出ているのに開くと「アクセス権限がありません」になる項目（鍵は「モード:役割 パターン」）。
 *    開示優先の「数値を登録（標準CSV）」は取込の権限で出し分け、「開示プロジェクト」の行は閲覧権限が無い役割では
 *    開ける最初の子（SSBJ）へのリンクにした（nav-config.ts の linkPermission）
 */
const KNOWN_FORBIDDEN_EXPORTS: Record<string, string> = {};
const KNOWN_MENU_DENIED: Record<string, string> = {};

interface Visit {
  pattern: string;
  url: string;
  fromMenu: boolean;
}

/**
 * パターンごとに 1 回ずつ辿る（同じ画面の絞り込み違いは辿らない）。
 * 同じ画面へ本文のリンク（例: ホームの「自分の作業」の絞り込み付き）で先に着いても、メニューにもあれば
 * 「メニューの項目」として扱い、メニューの URL で検査する（本文のリンクが先に着くと検査から漏れるため）
 */
async function crawlPatterns(page: Page, seed: string, prefixes: string[]): Promise<Visit[]> {
  const queue: Array<{ url: string; fromMenu: boolean }> = [{ url: seed, fromMenu: true }];
  const seen = new Map<string, Visit | null>();
  const visits: Visit[] = [];
  while (queue.length > 0 && visits.length < 120) {
    const next = queue.shift()!;
    const route = routeForPath(next.url);
    if (!route || route.entryOnly) continue;
    if (seen.has(route.pattern)) {
      const earlier = seen.get(route.pattern);
      if (next.fromMenu && earlier && !earlier.fromMenu) {
        earlier.fromMenu = true;
        earlier.url = next.url;
      }
      continue;
    }
    seen.set(route.pattern, null);
    const response = await page.goto(next.url, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() >= 400) continue;
    if (!prefixes.some((p) => new URL(page.url()).pathname.startsWith(p))) continue;
    const visit: Visit = { pattern: route.pattern, url: next.url, fromMenu: next.fromMenu };
    visits.push(visit);
    seen.set(route.pattern, visit);
    const links = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="メインナビゲーション"]');
      return [...document.querySelectorAll('a[href]')].map((a) => ({
        href: a.getAttribute('href') ?? '',
        fromMenu: nav?.contains(a) ?? false,
      }));
    });
    for (const link of links) {
      if (!link.href.startsWith('/') || link.href.startsWith('/api/')) continue;
      if (!prefixes.some((p) => link.href.startsWith(p))) continue;
      queue.push({ url: link.href.split('#')[0]!, fromMenu: link.fromMenu });
    }
  }
  return visits;
}

/** パレットで画面名を引き、その画面の候補が出るか */
async function paletteOffers(page: Page, label: string, href: string): Promise<boolean> {
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'コマンドパレット検索' });
  await expect(input).toBeVisible();
  await input.fill(label);
  const option = page.locator(`[role="option"][data-palette-href="${href}"]`);
  const found = await option
    .first()
    .waitFor({ state: 'attached', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.press('Escape');
  return found;
}

async function checkRole(
  page: Page,
  role: string,
  roles: RoleKey[],
  workspace: 'enterprise' | 'assurance',
  seed: string,
): Promise<string[]> {
  const problems: string[] = [];
  const set = permissionsFor(roles);
  const can = (permission: PermissionKey) => set.has(permission);
  // 既知の例外の鍵は役割名だけで引く（モードの接頭辞を外す）
  const knownKey = (pattern: string) => `${role.replace(/^disclosure:/, '')} ${pattern}`;
  const prefixes =
    workspace === 'enterprise'
      ? ['/enterprise/', '/notifications', '/profile']
      : ['/assurance/', '/notifications', '/profile'];
  const visits = await crawlPatterns(page, seed, prefixes);
  const visited = new Set(visits.map((v) => v.pattern));
  // 既知の例外のうち、実際に起きたもの（起きなくなった例外は表から消させる。常に通るだけの表にしない）
  const usedMenuDenied = new Set<string>();
  const usedExports = new Set<string>();

  // メニューの項目を開いて権限なしにならない
  for (const visit of visits.filter((v) => v.fromMenu)) {
    await page.goto(visit.url, { waitUntil: 'domcontentloaded' });
    if (
      await page
        .getByText('アクセス権限がありません')
        .isVisible()
        .catch(() => false)
    ) {
      const key = `${role} ${visit.pattern}`;
      if (KNOWN_MENU_DENIED[key]) usedMenuDenied.add(key);
      else problems.push(`${role}: メニューの ${visit.url} が「アクセス権限がありません」`);
    }
    // 出力のリンクが 403 にならない
    const exports = await page
      .locator('#t4d-main a[href^="/api/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    for (const href of [...new Set(exports)].slice(0, 5)) {
      // 画面のリンクを押したときと同じ Cookie で取りに行く（page.request はログインの Cookie を送らず 401 になる）
      const fetchStatus = () =>
        page.evaluate(async (url) => {
          try {
            // 資料のリンク（/api/files/signed-url）は保存先の署名付き URL へ転送する。転送は追わない
            // （別オリジンへの転送は fetch では読めない。転送されたなら 403 ではない）
            const res = await fetch(url, { credentials: 'same-origin', redirect: 'manual' });
            return res.type === 'opaqueredirect' ? 302 : res.status;
          } catch {
            return -1;
          }
        }, href);
      let status = await fetchStatus();
      if (status === -1) {
        // 画面の読み込みの途中で取りに行くと、通信が打ち切られることがある。読み込みを待って 1 度だけやり直す
        await page.waitForLoadState('load');
        status = await fetchStatus();
      }
      if (status === -1) {
        problems.push(`${role}: ${visit.url} の出力リンク ${href} を取得できない`);
        continue;
      }
      if (status === 401) {
        problems.push(
          `${role}: ${visit.url} の出力リンク ${href} が 401（ログインの状態で取れていない）`,
        );
        continue;
      }
      if (status !== 403) continue;
      const key = knownKey(visit.pattern);
      if (KNOWN_FORBIDDEN_EXPORTS[key]) usedExports.add(key);
      else problems.push(`${role}: ${visit.url} の出力リンク ${href} が 403`);
    }
  }

  // 起きなくなった既知の例外（直したら表から消す）。出力の例外は従来メニューの実行で確かめる
  // （開示優先のメニューには出力のある画面の一部しか無いため）
  for (const key of Object.keys(KNOWN_MENU_DENIED)) {
    if (key.startsWith(`${role} `) && !usedMenuDenied.has(key)) {
      problems.push(`既知の例外「${key}」が起きなくなった。KNOWN_MENU_DENIED から消す`);
    }
  }
  if (!role.startsWith('disclosure:')) {
    for (const key of Object.keys(KNOWN_FORBIDDEN_EXPORTS)) {
      if (key.startsWith(`${role} `) && !usedExports.has(key)) {
        problems.push(`既知の例外「${key}」が起きなくなった。KNOWN_FORBIDDEN_EXPORTS から消す`);
      }
    }
  }

  // 期待集合（その役割が開ける画面）⊆ 訪問 ∪ パレット
  for (const entry of ROUTE_CATALOG) {
    if (entry.entryOnly || !entry.href) continue;
    if (entry.workspace !== workspace && entry.workspace !== 'common') continue;
    if (!canOpenRoute(entry, can)) continue;
    if (visited.has(entry.pattern)) continue;
    const href = resolveRouteHref(entry, ENGAGEMENT_IDS.main);
    if (!href) continue;
    if (!(await paletteOffers(page, entry.label, href))) {
      problems.push(
        `${role}: ${entry.label}（${entry.pattern}）にメニュー・リンク・パレットのどれからも届かない`,
      );
    }
  }
  return problems;
}

const ENTERPRISE = [
  ['admin', DEMO_USERS.enterpriseAdmin, ['enterprise_admin']],
  ['preparer', DEMO_USERS.sustainability, ['sustainability_manager']],
  ['site', DEMO_USERS.siteUser, ['site_contributor']],
  ['reviewer', DEMO_USERS.reviewer, ['reviewer']],
  ['approver', DEMO_USERS.approver, ['approver', 'reviewer']],
] as const;

for (const [role, user, roles] of ENTERPRISE) {
  test(`従来メニュー: ${role} はその役割が開ける全画面に届く`, async ({ page }) => {
    test.setTimeout(600_000);
    await loginAs(page, user);
    const problems = await checkRole(page, role, [...roles], 'enterprise', '/enterprise/dashboard');
    expect(problems).toEqual([]);
  });
}

test('開示優先モード: 5 役割がその役割の開ける全画面に届く', async ({ page }) => {
  test.setTimeout(900_000);
  await loginAs(page, DEMO_USERS.enterpriseAdmin);
  await setDisclosureFirst(page, true);
  const problems: string[] = [];
  try {
    for (const [role, user, roles] of ENTERPRISE) {
      await loginAs(page, user);
      problems.push(
        ...(await checkRole(
          page,
          `disclosure:${role}`,
          [...roles],
          'enterprise',
          '/enterprise/dashboard',
        )),
      );
    }
  } finally {
    await loginAs(page, DEMO_USERS.enterpriseAdmin);
    await setDisclosureFirst(page, false);
  }
  expect(problems.map((p) => p.replace(/^disclosure:/, ''))).toEqual([]);
});

const ASSURANCE = [
  ['partner', DEMO_USERS.assurancePartner, ['engagement_partner']],
  ['manager', DEMO_USERS.assuranceManager, ['assurance_manager']],
  ['staff', DEMO_USERS.assuranceStaff, ['assurance_staff']],
  ['firm-admin', DEMO_USERS.assuranceAdmin, ['assurance_admin']],
] as const;

for (const [role, user, roles] of ASSURANCE) {
  test(`監査法人: ${role} はその役割が開ける全画面に届く`, async ({ page }) => {
    test.setTimeout(300_000);
    await loginAs(page, user);
    const problems = await checkRole(page, role, [...roles], 'assurance', '/assurance/dashboard');
    expect(problems).toEqual([]);
  });
}

/**
 * トライアル対応（2026-10）の詳細画面は固定の行き先（href）を持たないため、上の期待集合（パレット）には入らない。
 * 入口の画面の本文に、その画面へのリンクがあることを役割ごとに確かめる（plan 付録 D の入口）
 */
const TRIAL_DETAIL_ENTRIES = [
  {
    name: '要求事項の詳細（プロジェクト）',
    from: `/enterprise/disclosure-projects/${DISCLOSURE_FIRST_IDS.projects.fy2026}?tab=requirements&fw=${DISCLOSURE_FIRST_IDS.projectFrameworks.fy2026Esrs40a}`,
    link: /^\/enterprise\/disclosure-projects\/[0-9a-f-]{36}\/requirements\/[0-9a-f-]{36}$/,
  },
  {
    name: '要求事項の詳細（プロジェクト）— 横断対応表の行から',
    from: `/enterprise/disclosure-projects/${DISCLOSURE_FIRST_IDS.projects.fy2026}?tab=crosswalk`,
    link: /^\/enterprise\/disclosure-projects\/[0-9a-f-]{36}\/requirements\/[0-9a-f-]{36}$/,
  },
  {
    name: 'スナップショットの内容とトレース',
    from: `/enterprise/disclosure-projects/${DISCLOSURE_FIRST_IDS.projects.fy2025}?tab=outputs`,
    link: /^\/enterprise\/disclosure-projects\/[0-9a-f-]{36}\/snapshots\/[0-9a-f-]{36}$/,
  },
] as const;

for (const [role, user] of [
  ['preparer', DEMO_USERS.sustainability],
  ['reviewer', DEMO_USERS.reviewer],
  ['approver', DEMO_USERS.approver],
] as const) {
  test(`トライアル対応の詳細画面: ${role} は入口の画面のリンクから届く`, async ({ page }) => {
    await loginAs(page, user);
    const problems: string[] = [];
    for (const entry of TRIAL_DETAIL_ENTRIES) {
      await page.goto(entry.from, { waitUntil: 'domcontentloaded' });
      const hrefs = await page
        .locator('#t4d-main a[href]')
        .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
      const target = hrefs.map((h) => h.split(/[?#]/)[0]!).find((h) => entry.link.test(h));
      if (!target) {
        problems.push(`${role}: ${entry.name} への入口のリンクが ${entry.from} に無い`);
        continue;
      }
      const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
      if (!response || response.status() >= 400) {
        problems.push(`${role}: ${entry.name}（${target}）が ${response?.status()}`);
        continue;
      }
      if (
        await page
          .getByText('アクセス権限がありません')
          .isVisible()
          .catch(() => false)
      ) {
        problems.push(`${role}: ${entry.name}（${target}）が「アクセス権限がありません」`);
      }
    }
    expect(problems).toEqual([]);
  });
}
