import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PERIOD_IDS } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { DEMO_USERS, loginAs } from './helpers';

/**
 * 開示優先モード（disclosure_first）の導線。**読み取りだけ**（状態を変える操作はしない）。
 *
 * - A01・A39: 既定（OFF）の組織は従来のメニュー・ホームのまま。新しい画面は URL で開ける。
 *   既存の Scope3・データ取込・SSBJ ドラフトの画面も従来のメニューと URL のまま。
 * - A37: キーボードだけで 一覧 → プロジェクト → 原稿 → 根拠 → レビュー依頼 まで辿れ、フォーカスが見える。
 * - A38: 1366px で本文・主 CTA・状態が読め、ページ全体の横スクロールが出ない。
 *   1366px ちょうどでも根拠パネルを閉じて本文を広げて編集でき（開閉ボタンは aria-expanded を持ち、
 *   閉じるとフォーカスが開閉ボタンへ戻る）、それより狭い幅では根拠パネルがドロワーになる。
 * - 要求事項タブの SSBJ の要求事項は、プロジェクトの報告期間の評価を開く（ヘッダーの期間と違えば帯で示す）。
 *
 * 開示優先モードを ON にする一連の操作は zz-disclosure-project.spec.ts（最後に OFF へ戻す）。
 */

const PROJECT_PATH = `/enterprise/disclosure-projects/${IDS.projects.fy2026}`;
const RISK_PATH = `${PROJECT_PATH}/blocks/${IDS.blocks.fy2026RiskOpportunity.block}`;
const PROJECT_NAME = 'FY2026 統合開示（SSBJ・CSRD域外準備）';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });

interface FocusedElement {
  tag: string;
  text: string;
  href: string | null;
  role: string | null;
  /** アプリの本文領域（#t4d-main）の中か。ヘッダー・左メニューの同じリンクと区別する */
  inMain: boolean;
}

/** Tab（または Shift+Tab）だけでフォーカスを進め、条件に合う要素に着いたら返す */
async function tabUntil(
  page: Page,
  matches: (el: FocusedElement) => boolean,
  options: { backwards?: boolean; max?: number } = {},
): Promise<FocusedElement> {
  const max = options.max ?? 200;
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press(options.backwards ? 'Shift+Tab' : 'Tab');
    const focused = await page.evaluate((): FocusedElement | null => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
        href: el.getAttribute('href'),
        role: el.getAttribute('role'),
        inMain: el.closest('#t4d-main') !== null,
      };
    });
    if (focused && matches(focused)) return focused;
  }
  throw new Error(`Tab を ${max} 回押しても目的の要素にフォーカスが届かない`);
}

/**
 * いまフォーカスのある要素が、キーボード操作のフォーカスとして目に見える。
 * 枠があるだけでなく、枠の色が白い背景に対して 3:1 以上のコントラストを持つこと
 * （WCAG 1.4.11。以前は ring-brand-100（約 1.1:1）の枠でも「見える」と判定していた）。
 * transition-colors のボタンは枠の色が 150ms かけて変わるため、落ち着くまで待って測る
 */
async function expectVisibleFocus(page: Page): Promise<void> {
  const measure = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      /** 白い背景に対するコントラスト比（色を読めなければ 0） */
      const contrastOnWhite = (color: string) => {
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color);
        if (!m) return 0;
        if (m[4] !== undefined && Number(m[4]) === 0) return 0;
        return 1.05 / (luminance([Number(m[1]), Number(m[2]), Number(m[3])]) + 0.05);
      };
      const outlineVisible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      const shadowColors =
        style.boxShadow === 'none' ? [] : (style.boxShadow.match(/rgba?\([^)]*\)/g) ?? []);
      return {
        focusVisible: el.matches(':focus-visible'),
        outline: outlineVisible && contrastOnWhite(style.outlineColor) >= 3,
        ring: shadowColors.some((c) => contrastOnWhite(c) >= 3),
        onScreen: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
      };
    });
  await expect
    .poll(
      async () => {
        const s = await measure();
        return s.outline || s.ring;
      },
      { timeout: 2_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  const state = await measure();
  expect(state.focusVisible, 'キーボードのフォーカスとして扱われていない').toBe(true);
  expect(
    state.outline || state.ring,
    'フォーカスの枠（outline / ring）が消えているか、背景とのコントラストが 3:1 未満',
  ).toBe(true);
  expect(state.onScreen, 'フォーカスのある要素が画面外にある').toBe(true);
}

/** ページ全体（文書と、アプリのスクロール領域）に横スクロールが出ていない */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.getElementById('t4d-main');
    return {
      document: doc.scrollWidth - doc.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow, '横スクロールが出ている（px）').toEqual({ document: 0, main: 0 });
}

/**
 * ヘッダーの中央の列（企業・期間・開示プロジェクト・デモの表示）が、右の操作に重ならず、
 * 開示プロジェクト名が読める幅で表示されている
 */
async function expectHeaderFits(page: Page): Promise<void> {
  const name = page.getByTestId('header-project-context').locator('a span.font-medium');
  await expect(name).toBeVisible();
  const box = await name.boundingBox();
  expect(box?.width ?? 0, 'ヘッダーのプロジェクト名の幅').toBeGreaterThan(80);
  const overlap = await page.evaluate(() => {
    const header = document.querySelector('header');
    const middle = header?.children[1] as HTMLElement | undefined;
    const right = header?.children[2] as HTMLElement | undefined;
    if (!middle || !right) return 'ヘッダーの列が見つからない';
    const middleRight = middle.getBoundingClientRect().right;
    const rightLeft = right.getBoundingClientRect().left;
    if (middleRight > rightLeft + 0.5)
      return `中央の列（右端 ${middleRight}）が右の操作（左端 ${rightLeft}）に重なる`;
    // 中央の列の子が列の外へはみ出して描かれない（はみ出しは切られる）
    return getComputedStyle(middle).overflowX === 'hidden'
      ? null
      : '中央の列がはみ出しを切っていない';
  });
  expect(overlap).toBeNull();
}

test('A01・A39: 開示優先モードが OFF（既定）なら従来のメニューとホームのまま、新しい画面は URL で開ける', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/dashboard');

  for (const label of [
    'ホーム',
    '開示対応',
    'ESG データ（GHG以外）',
    'GHG',
    '業務管理',
    'AI Copilot',
    '管理',
  ]) {
    await expect(sidebar(page).getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  for (const label of ['開示プロジェクト', '情報・根拠', 'ESG経営', 'タスク・承認']) {
    await expect(sidebar(page).getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
  // 従来のホーム（開示業務 / ESG経営 のタブ・4 カードは出さない）
  await expect(page.getByRole('navigation', { name: 'ホームの表示切替' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '開示の状況' })).toHaveCount(0);
  await expect(page.getByText(/^青海テクノロジー株式会社 ／ .+ ／ 提出期限/)).toBeVisible();

  // 新しい画面はメニューに無くても URL で開ける
  const routes: Array<[string, string | RegExp]> = [
    ['/enterprise/disclosure-projects', '開示プロジェクト'],
    [PROJECT_PATH, PROJECT_NAME],
    [RISK_PATH, 'リスク及び機会'],
    ['/enterprise/narratives', '定性情報'],
    ['/enterprise/esg', /^ESG ?経営$/],
    ['/enterprise/imports/standard', '数値を登録（CSV・手入力）'],
  ];
  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading }), path).toBeVisible();
  }

  // 既存の Scope3・データ取込・SSBJ ドラフトは従来のメニューから同じ URL で開ける（A39）
  for (const [label, href] of [
    ['Scope3データ取込', '/enterprise/ghg/suppliers'],
    ['データ取込', '/enterprise/imports'],
    ['開示ドラフト', '/enterprise/disclosures/ssbj/draft'],
  ] as const) {
    const link = sidebar(page).getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', href);
    await link.click();
    await page.waitForURL(new RegExp(`${href}$`));
    await expect(page.locator('#t4d-main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  // 従来の Evidence 画面は拡張前の入力項目・列のまま（開示優先の入力・列・入口を出さない。REG-F7）
  await page.goto('/enterprise/evidence');
  await expect(page.getByRole('heading', { level: 1, name: 'Evidence' })).toBeVisible();
  await expect(page.getByRole('link', { name: '定性情報の資料として登録する' })).toHaveCount(0);
  for (const name of ['usagePurpose', 'editionLabel', 'issuedOn', 'confidentiality']) {
    await expect(page.locator(`[name="${name}"]`), name).toHaveCount(0);
  }
  await expect(page.getByRole('columnheader', { name: 'スキャン' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '利用目的' })).toHaveCount(0);
  // スキャンの状態は DB の値（skipped など）ではなく、ラベルで示す（UX-R3-07）
  await expect(page.locator('#t4d-main').getByText('skipped', { exact: true })).toHaveCount(0);

  // 資料の画面（証憑）も従来の画面名・機能のまま（開示優先の利用目的・手動抜粋・引用の利用先を出さない。REG-2）
  await page
    .locator('#t4d-main')
    .getByRole('row', { name: /電力請求書_FY2026\.pdf/ })
    .getByRole('link', { name: '画面内で開く' })
    .click();
  await page.waitForURL(/\/enterprise\/evidence\/[0-9a-f-]+/);
  await expect(
    page.getByRole('navigation', { name: 'パンくず' }).getByRole('link', { name: 'Evidence' }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Evidence Viewer/);
  await expect(page.getByText(/^利用目的:/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '手動抜粋を登録' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^引用の利用先/ })).toHaveCount(0);
});

test('A37: キーボードだけで 一覧 → プロジェクト → 原稿 → 根拠 → レビュー依頼 まで辿れ、フォーカスが見える', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto('/enterprise/disclosure-projects');
  await expect(page.getByRole('heading', { level: 1, name: '開示プロジェクト' })).toBeVisible();

  // 一覧 → プロジェクト
  await tabUntil(page, (el) => el.inMain && el.tag === 'a' && el.href === PROJECT_PATH);
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`${PROJECT_PATH}$`));
  await expect(page.getByRole('heading', { level: 1, name: PROJECT_NAME })).toBeVisible();

  // プロジェクト → 原稿タブ
  await tabUntil(
    page,
    (el) => el.inMain && el.tag === 'a' && el.href === `${PROJECT_PATH}?tab=manuscripts`,
  );
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await page.waitForURL(/tab=manuscripts/);

  // 原稿一覧 → リスク及び機会の原稿
  await tabUntil(page, (el) => el.inMain && el.tag === 'a' && el.href === RISK_PATH);
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`${RISK_PATH}$`));
  await expect(page.getByRole('region', { name: '本文' })).toBeVisible();

  // 根拠パネル: Tab で選択中のタブ（根拠資料）に入り、矢印キーで関連数値へ切り替える
  await tabUntil(page, (el) => el.role === 'tab' && el.text === '根拠資料');
  await expectVisibleFocus(page);
  await page.keyboard.press('ArrowRight');
  const pane = page.getByRole('complementary', { name: '根拠パネル' });
  const metricsTab = pane.getByRole('tab', { name: '関連数値' });
  await expect(metricsTab).toBeFocused();
  await expect(metricsTab).toHaveAttribute('aria-selected', 'true');
  await expectVisibleFocus(page);
  await expect(pane.getByText('本文が引用している数値')).toBeVisible();

  // 主要な操作（レビュー依頼）へ戻れる。押さない（この spec は状態を変えない）
  await tabUntil(page, (el) => el.tag === 'button' && el.text === 'レビュー依頼', {
    backwards: true,
  });
  await expect(page.getByRole('button', { name: 'レビュー依頼', exact: true })).toBeFocused();
  await expectVisibleFocus(page);
});

test('A37: 開示プロジェクトの一覧・原稿一覧・原稿編集に重大なアクセシビリティ違反が無い', async ({
  page,
}) => {
  await loginAs(page, DEMO_USERS.sustainability);
  for (const path of [
    '/enterprise/disclosure-projects',
    `${PROJECT_PATH}?tab=manuscripts`,
    RISK_PATH,
  ]) {
    await page.goto(path);
    await expect(page.locator('#t4d-main')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, `${path}\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`).toEqual([]);
    // 主要な領域（main）は 1 つだけで入れ子にしない（best-practice のため上のタグには含まれない。UX-08）
    const landmarks = await new AxeBuilder({ page })
      .withRules(['landmark-no-duplicate-main', 'landmark-main-is-top-level', 'landmark-one-main'])
      .analyze();
    expect(
      landmarks.violations.map((v) => `${v.id}: ${v.help}`),
      path,
    ).toEqual([]);
  }
});

test('A38: 1366×768 で本文・主 CTA・状態が読め、1366px でも狭い幅でも根拠パネルを閉じて編集に戻れる', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await loginAs(page, DEMO_USERS.sustainability);
  await page.goto(RISK_PATH);

  const body = page.getByRole('region', { name: '本文' });
  const pane = page.getByRole('complementary', { name: '根拠パネル' });
  await expect(body).toBeVisible();
  await expect(body.locator('textarea').first()).toBeInViewport();
  await expect(page.getByRole('button', { name: 'レビュー依頼', exact: true })).toBeInViewport();
  // 状態: 本文状態・参照の鮮度・保存状態・下部の状態バー
  await expect(page.getByText('下書き', { exact: true }).first()).toBeInViewport();
  await expect(page.getByText('参照: 現行')).toBeInViewport();
  await expect(page.getByText('変更なし', { exact: true })).toBeInViewport();
  await expect(page.getByRole('toolbar', { name: '本文の状態' })).toBeInViewport();
  // 1366px では本文と根拠を並べて読める
  await expect(pane).toBeVisible();
  await expectNoHorizontalScroll(page);
  // ヘッダー: 開示プロジェクト名が潰れず、中央の列が右の操作（役割切替・通知）に重ならない（UX-R3-03）
  await expectHeaderFits(page);

  // 1366px ちょうどでも根拠パネルを閉じられる。閉じると本文が広がり、フォーカスは開閉ボタンへ戻る
  const toggle = page.getByRole('button', { name: '根拠パネル', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const widthWithPane = (await body.boundingBox())?.width ?? 0;
  await pane.getByRole('button', { name: '根拠パネルを閉じる' }).click();
  await expect(pane).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const widthWithoutPane = (await body.boundingBox())?.width ?? 0;
  expect(widthWithoutPane).toBeGreaterThan(widthWithPane + 200);
  await expectNoHorizontalScroll(page);
  // 閉じたまま本文を編集できる（入力はしない: この spec は状態を変えない）
  const firstParagraph = body.locator('textarea').first();
  await expect(firstParagraph).toBeEditable();
  // 開閉ボタンでもう一度並べて表示できる
  await toggle.click();
  await expect(pane).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // パネルの中で Esc を押しても閉じ、開閉ボタンへ戻る
  await pane.getByRole('tab', { name: '根拠資料' }).focus();
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(pane).toBeVisible();

  // 1440px（主な対象の幅）でもヘッダーのプロジェクト名が見え、重ならない
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectHeaderFits(page);

  // 狭い幅（アプリの最小幅 1280px）: 根拠パネルはドロワー（モーダルのダイアログ）。開いて閉じ、本文の編集に戻れる
  await page.setViewportSize({ width: 1280, height: 720 });
  const drawer = page.getByRole('dialog', { name: '根拠パネル' });
  await expect(pane).toBeHidden();
  await expect(drawer).toBeHidden();
  await expectNoHorizontalScroll(page);
  const trigger = page.getByRole('button', { name: '根拠パネル', exact: true });
  await expect(trigger).toBeInViewport();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(drawer.getByRole('tab', { name: '根拠資料' })).toBeVisible();
  // フォーカスはドロワーの中に留まる（背面の本文・状態の帯へ抜けない。UX-R3-08）
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
    const inside = await drawer.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `Tab ${i + 1} 回目でフォーカスがドロワーの外へ出た`).toBe(true);
  }
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await drawer.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `Shift+Tab ${i + 1} 回目でフォーカスがドロワーの外へ出た`).toBe(true);
  }
  await drawer.getByRole('button', { name: '根拠パネルを閉じる' }).click();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  // Esc でも閉じられる
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(body.locator('textarea').first()).toBeEditable();
  await expect(page.getByRole('button', { name: 'レビュー依頼', exact: true })).toBeInViewport();
});

test('要求事項タブの SSBJ の要求事項は、プロジェクトの報告期間の評価を開く', async ({ page }) => {
  await loginAs(page, DEMO_USERS.sustainability);
  // FY2025 のプロジェクト（ヘッダーの期間は既定の FY2026）
  await page.goto(`/enterprise/disclosure-projects/${IDS.projects.fy2025}?tab=requirements`);
  const link = page
    .locator('#t4d-main')
    .locator('a[href*="/enterprise/disclosures/ssbj/requirements/"]')
    .first();
  await expect(link).toHaveAttribute('href', new RegExp(`period=${PERIOD_IDS.fy2025}`));
  await link.click();
  await page.waitForURL(new RegExp(`period=${PERIOD_IDS.fy2025}`));
  const note = page.locator('#t4d-main').getByRole('note');
  await expect(note).toContainText('開示プロジェクトの報告期間（2025年度');
  await expect(note).toContainText('ヘッダーで選んでいる期間（2026年度');
});
