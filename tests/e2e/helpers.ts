import {
  expect,
  test,
  type BrowserContext,
  type Cookie,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * E2E 共通ヘルパー。
 *
 * Demo Mode（環境変数なし）で動作させる前提。
 * ログインはデモアカウントのボタンを押すだけ（本番 Auth とは別経路）。
 */

export const DEMO_USERS = {
  enterpriseAdmin: '青海 太郎',
  siteUser: '東 一郎',
  sustainability: '海野 みどり',
  reviewer: '検見川 涼',
  approver: '承 花子',
  assuranceManager: '青葉 健',
  assurancePartner: '保 統括',
  assuranceStaff: '若葉 新',
  assuranceAdmin: '法人 管理',
  /** 別テナント（越権テスト用）。ログイン画面下部の折りたたみ内にある。 */
  otherEnterpriseAdmin: '蒼天 次郎',
  otherAssuranceManager: '黒部 誠',
} as const;

export async function logout(page: Page): Promise<void> {
  await page.goto('/workspace');
  const menu = page.getByRole('button', { name: /ユーザーメニュー/ });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.getByRole('menuitem', { name: 'ログアウト' }).click();
    await page.waitForURL('**/login');
  }
}

// ----------------------------------------------------------------------
// Demo Mode の状態の持ち回り（playwright.stateless.config.ts だけが使う）
// ----------------------------------------------------------------------

/**
 * Demo Mode の状態を運ぶ Cookie（操作の記録・リセットの印・押し出しの知らせ）。
 * ログインの Cookie（t4d_demo_user・t4d_workspace）は含めない
 */
function isDemoStateCookie(cookie: Pick<Cookie, 'name'>): boolean {
  return cookie.name.startsWith('t4d.demo-');
}

/**
 * 1 つのブラウザの Cookie を最後まで持ち回す設定か（metadata.carryDemoState）。
 * 状態がリクエストごとに消えるサーバー（リクエストごとに新しい Fixture）では、状態は Cookie にしか無い。
 * 実演の発表者は 1 つのブラウザで操作し、アプリのログイン・ログアウトは操作の記録を消さないため、
 * テストごとに新しい文脈を作る Playwright の既定を、発表者のブラウザに合わせる
 */
export function carriesDemoState(): boolean {
  try {
    return test.info().project.metadata?.carryDemoState === true;
  } catch {
    return false;
  }
}

/** 前のテストの終わりに持っていた Demo Mode の Cookie（持ち回す設定のときだけ使う） */
let carriedDemoCookies: Cookie[] = [];
/** 実演の流れの中で最も大きかった Cookie ヘッダー（名前=値; を足した長さ）と、そのときの操作 */
let peakCookieHeader = { bytes: 0, editsBytes: 0, label: '' };

function cookieHeaderBytes(cookies: readonly Cookie[]): number {
  return Buffer.byteLength(cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'utf8');
}

/**
 * テストの終わりに Demo Mode の Cookie を控え、次のテストの文脈へ渡す。あわせて Cookie の大きさを
 * 記録し、押し出し（容量不足で古い操作を捨てた印）が起きていないことを確かめる
 */
export async function carryDemoState(context: BrowserContext, label: string): Promise<void> {
  if (!carriesDemoState()) return;
  const all = await context.cookies();
  carriedDemoCookies = all.filter(isDemoStateCookie);
  const header = cookieHeaderBytes(all);
  const edits = carriedDemoCookies
    .filter((c) => c.name.startsWith('t4d.demo-edits'))
    .map((c) => c.value.length);
  const editsBytes = edits.reduce((a, b) => a + b, 0);
  if (header > peakCookieHeader.bytes) peakCookieHeader = { bytes: header, editsBytes, label };
  const evicted = all.find((c) => c.name === 't4d.demo-evicted')?.value ?? '';
  const line = `[stateless] ${label}: Cookie ヘッダー ${header}B（操作の記録 ${editsBytes}B = ${edits.join('/') || '0'}）${evicted ? ` 押し出し: ${evicted}` : ''}`;
  console.log(line);
  await test.info().attach('demo-cookie-size', { body: line, contentType: 'text/plain' });
  // 押し出しが起きると、別インスタンスでは前の手順の結果が戻らない（後の手順が偶然通っても信用できない）
  expect(evicted, `${label} で古い操作が押し出された`).toBe('');
}

/** 持ち回した中で最大の Cookie ヘッダー（afterAll で報告する） */
export function peakCarriedCookieHeader(): { bytes: number; editsBytes: number; label: string } {
  return peakCookieHeader;
}

/**
 * 持ち回した Demo Mode の Cookie と最大値の記録を捨てる（別の流れを初期状態の Fixture から始めるとき）。
 * 同じワーカーで続けて流れる spec は、前の spec の終わりの Cookie（リセットの印・機能設定・操作の記録）を
 * 受け取ってしまう。前の spec の結果を次の流れの前提にせず、Cookie の大きさも流れごとに測るため。
 * 持ち回さない構成（通常の E2E）では、何も持ち回していないので影響しない
 */
export function resetCarriedDemoState(): void {
  carriedDemoCookies = [];
  peakCookieHeader = { bytes: 0, editsBytes: 0, label: '' };
}

/** デモアカウントでログインし、ワークスペースを選択する。 */
export async function loginAs(page: Page, displayName: string): Promise<void> {
  if (carriesDemoState()) {
    // ログインの Cookie だけを消す（Demo Mode の操作の記録は、同じブラウザのまま持ち回す）
    const current = (await page.context().cookies()).filter(isDemoStateCookie);
    await page.context().clearCookies();
    const keep = current.length > 0 ? current : carriedDemoCookies;
    if (keep.length > 0) await page.context().addCookies(keep);
  } else {
    await page.context().clearCookies();
  }
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'デモログイン' })).toBeVisible();

  // ログイン導線は 2 種類ある。
  //  ・主要アカウント: ボタンの中に氏名が入っている
  //  ・別テナント（越権テスト用）: 折りたたみ（details）の中で、
  //    ボタンのラベルは「ログイン」・氏名は隣の span
  const card = page.locator('button', { hasText: displayName }).first();
  if ((await card.count()) > 0) {
    await card.click();
  } else {
    const disclosure = page.locator('summary', { hasText: '越権テスト用' }).first();
    if ((await disclosure.count()) > 0) await disclosure.click();
    await page.locator('li', { hasText: displayName }).locator('button[type="submit"]').click();
  }
  await page.waitForURL('**/workspace');

  // ワークスペースが 1 つならそのまま選択
  const workspaceButton = page.locator('form button[type="submit"]').first();
  await workspaceButton.click();
  await page.waitForURL(/\/(enterprise|assurance)\//);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ヘッダーの「役割切替（デモ）」で同じ組織のデモ利用者へ切り替える（ログアウトしない）。
 * 切替後は今いる画面へ戻る。ヘッダーの現在の利用者が変わるまで待つ。
 */
export async function switchDemoRole(page: Page, displayName: string): Promise<void> {
  const name = escapeRegExp(displayName);
  const trigger = page.getByRole('button', { name: /^役割切替（デモ）/ });
  await trigger.click();
  await page.getByRole('menuitem', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`^役割切替（デモ） 現在: ${name}・`) }),
  ).toBeVisible();
  await expect(page.locator('#t4d-main')).toBeVisible();
}

// ----------------------------------------------------------------------
// 既定で閉じた折りたたみ（docs/disclosure-first.md §10.4）
// ----------------------------------------------------------------------

function pageOf(scope: Page | Locator): Page {
  return 'goto' in scope ? scope : scope.page();
}

/**
 * 折りたたみ（details）を開く。閉じていれば summary を押し、開いていれば何もしない（何度呼んでもよい）。
 * 閉じた中身は toBeVisible・getByRole・fill が失敗するため、中身を確かめる前に呼ぶ。
 *
 * summary は文字列（部分一致・大文字小文字を区別しない）か正規表現。Collapsible・MoreInfo の要点の文
 * （data-collapsible-summary。「開く／閉じる」の印を含まない）で照合するので、`^…$` も使える。
 * 既存の素の details は summary 全体の文字で照合する。入れ子の内側は外側を先に開く。
 * 戻り値は開いた details（中身の確認の範囲に使う）
 */
export async function openCollapsible(
  scope: Page | Locator,
  summary: string | RegExp,
): Promise<Locator> {
  const page = pageOf(scope);
  const byLabel = scope
    .locator('summary')
    .filter({ has: page.locator('[data-collapsible-summary]', { hasText: summary }) });
  const byText = scope.locator('summary').filter({ hasText: summary });
  const target = byLabel.or(byText).first();
  await expect(target, `折りたたみ「${String(summary)}」が見つからない`).toBeVisible();
  const details = target.locator('xpath=..');
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await target.click();
  await expect(details).toHaveJSProperty('open', true);
  return details;
}

/**
 * 支援技術に渡る開閉の状態（Chromium のアクセシビリティ・ツリーの expanded）。
 * ネイティブの <summary> は aria-expanded 属性を持たず、ブラウザが親の details の open から expanded を渡す。
 * 属性ではなくツリーを読むことで、「閉じている／開いている」が読み上げに届いていることを確かめる。
 * selector は 1 つの要素に当たる CSS セレクタ（例 `#trend-rules > summary`）。expanded を持たなければ undefined
 */
export async function accessibleExpanded(
  page: Page,
  selector: string,
): Promise<boolean | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`要素「${selector}」が見つからない`);
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const expanded = nodes[0]?.properties?.find((p) => p.name === 'expanded');
    return expanded === undefined ? undefined : expanded.value.value === true;
  } finally {
    await cdp.detach();
  }
}

/** フォーカス中の要素がキーボードのフォーカスとして扱われ、輪郭線（フォーカスリング）が描かれているか */
export async function focusRingOfActiveElement(
  page: Page,
): Promise<{ tag: string; focusVisible: boolean; outlined: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: '', focusVisible: false, outlined: false };
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      focusVisible: el.matches(':focus-visible'),
      outlined: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
    };
  });
}

export async function gotoEnterprise(page: Page, path: string): Promise<void> {
  await page.goto(`/enterprise/${path}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
}

/** 監査法人ワークスペースで、対象案件の指定ページへ移動する。 */
export async function gotoEngagementPage(page: Page, pageName: string): Promise<string> {
  await page.goto('/assurance/engagements');
  const link = page.getByRole('link', { name: 'ENG-2026-001' }).first();
  await link.click();
  await page.waitForURL(/\/assurance\/engagements\/[^/]+\/overview/);
  const engagementId = page.url().match(/engagements\/([^/]+)\//)?.[1] ?? '';
  await page.goto(`/assurance/engagements/${engagementId}/${pageName}`);
  await expect(page.locator('#t4d-main')).toBeVisible();
  return engagementId;
}

// ----------------------------------------------------------------------
// 開示優先モードの切替と開示デモのリセット（変更する spec が最後に既定の状態へ戻すため）
// ----------------------------------------------------------------------

/** 管理者の設定画面で開示優先モードを切り替える（enterprise.org.manage が要る） */
export async function setDisclosureFirst(page: Page, on: boolean): Promise<void> {
  await page.goto('/enterprise/settings');
  await page.getByLabel(on ? '有効にする' : '無効にする（従来の構成）').check();
  await page
    .locator('form')
    .filter({ has: page.getByRole('group', { name: '開示優先モード' }) })
    .getByRole('button', { name: '保存' })
    .click();
  await page.waitForURL(new RegExp(`flash=disclosureFirstChanged&state=${on ? 'on' : 'off'}`));
}

/**
 * 開示デモのリセット（ホームの開示業務タブにある。開示優先モードが ON のときだけ表示される）。
 * 開示優先モードの表と CSRD の 6 表（DMA・評価・計画・開示ドラフト）を Fixture の値へ戻す
 */
export async function resetDisclosureDemo(page: Page): Promise<void> {
  await page.getByLabel('上記の範囲だけを初期状態へ戻すことを確認しました').check();
  await page.getByRole('button', { name: '開示デモを初期状態に戻す' }).click();
  await page.waitForURL(/flash=disclosureDemoReset/);
  await expect(page.getByText(/開示デモのデータを初期状態に戻しました/)).toBeVisible();
}

/**
 * selector に当たる要素（summary・リンクなど）にキーボード操作のフォーカスを当て、フォーカスリング
 * （outline）が overflow のある祖先で切れていないかを調べる。切れていれば理由の文を返す。
 *
 * - キーボードで 1 回操作してから focus() する（その後のスクリプトのフォーカスも :focus-visible になる）
 * - フォーカスで端までスクロールしたときに画面の縁で切れるのは位置の問題でどこでも起きるため、
 *   中央へ寄せてから、置かれた箱の中に収まるかだけを見る
 * - 切り取る範囲: overflow hidden／clip は内側（padding box）。スクロールする要素はスクロールできる
 *   中身の全体（端までスクロールしても見えない部分だけを切れたとみなす）
 * - 描画されていない要素（閉じた details の中など）は数えない。checked は調べた要素の数
 */
export async function focusRingClipIssues(
  page: Page,
  selector: string,
): Promise<{ issues: string[]; checked: number }> {
  await page.keyboard.press('Tab');
  return page.evaluate((sel) => {
    const issues: string[] = [];
    let checked = 0;
    for (const target of document.querySelectorAll<HTMLElement>(sel)) {
      target.focus();
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (document.activeElement !== target || !target.matches(':focus-visible')) continue;
      checked += 1;
      const style = getComputedStyle(target);
      const extent = (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0);
      const ring = {
        left: rect.left - extent,
        right: rect.right + extent,
        top: rect.top - extent,
        bottom: rect.bottom + extent,
      };
      for (let el = target.parentElement; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        const clips = (value: string) => value !== 'visible';
        if (!clips(s.overflowX) && !clips(s.overflowY)) continue;
        const r = el.getBoundingClientRect();
        const scrolls = (value: string) => value === 'auto' || value === 'scroll';
        const left = r.left + el.clientLeft - (scrolls(s.overflowX) ? el.scrollLeft : 0);
        const top = r.top + el.clientTop - (scrolls(s.overflowY) ? el.scrollTop : 0);
        const width = scrolls(s.overflowX) ? el.scrollWidth : el.clientWidth;
        const height = scrolls(s.overflowY) ? el.scrollHeight : el.clientHeight;
        const clippedX =
          clips(s.overflowX) && (ring.left < left - 0.5 || ring.right > left + width + 0.5);
        const clippedY =
          clips(s.overflowY) && (ring.top < top - 0.5 || ring.bottom > top + height + 0.5);
        if (clippedX || clippedY) {
          const name = target.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40) ?? '';
          const where = `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')}`;
          const px = (n: number) => Math.round(n);
          issues.push(
            `「${name}」のリングが ${where}（overflow ${s.overflowX}/${s.overflowY}）で切れる` +
              `（リング x ${px(ring.left)}〜${px(ring.right)}・y ${px(ring.top)}〜${px(ring.bottom)}、` +
              `箱 x ${px(left)}〜${px(left + width)}・y ${px(top)}〜${px(top + height)}）`,
          );
          break;
        }
      }
    }
    return { issues, checked };
  }, selector);
}
