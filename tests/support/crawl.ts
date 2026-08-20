import { expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 画面クロールの共通処理。
 *
 * Demo Mode（tests/e2e）と Supabase Mode（tests/e2e-supabase）の両方から使う。
 * 同じ画面でも RLS が効くかどうかで描画経路が変わるため、両モードで回す価値がある。
 */

export const MAX_PAGES = 400;

/** 画面が壊れていることを示す文言（error.tsx / not-found.tsx が出す）。 */
const BROKEN_MARKERS = [
  '問題が発生しました',
  'ページが見つかりません',
  'Application error',
  'Internal Server Error',
  'This page could not be found',
];

/** 監査対象外の Console エラー（既知・無害）。 */
function isIgnorableConsoleError(text: string): boolean {
  return (
    text.includes('favicon') ||
    text.includes('Download the React DevTools') ||
    // Demo Mode の Fixture ファイルは実体を持たない（known-limitations D-2）
    text.includes('410')
  );
}

export function watchConsole(page: Page, sink: string[]): void {
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    if (isIgnorableConsoleError(m.text())) return;
    sink.push(`[console] ${new URL(page.url()).pathname} — ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e: Error) => {
    sink.push(`[pageerror] ${new URL(page.url()).pathname} — ${e.message.slice(0, 200)}`);
  });
}

/**
 * 到達可能なページをすべて開く（幅優先クロール）。
 *
 * 詳細ページ（Data Point / CDP 質問 / 取込ジョブ …）は一覧から辿って自動的に対象に入る。
 * ルート表を手で書くと「書き忘れた画面」を見逃すため、クロールにしている。
 */
export async function crawl(
  page: Page,
  seeds: string[],
  allowPrefixes: string[],
  problems: string[],
): Promise<string[]> {
  const queue = [...seeds];
  const seen = new Set<string>();
  const visited: string[] = [];

  // 同じ画面のフィルター違い（?page=1,2,3 …）を無限に辿らないよう、
  // 「パス ＋ クエリのキー名」で正規化する。フィルターの種類ごとに 1 回は必ず開く。
  const shapeOf = (path: string): string => {
    const url = new URL(path, 'http://x');
    const keys = [...url.searchParams.keys()].sort().join(',');
    return keys ? `${url.pathname}?${keys}` : url.pathname;
  };

  while (queue.length > 0 && visited.length < MAX_PAGES) {
    const path = queue.shift();
    if (!path || seen.has(shapeOf(path))) continue;
    seen.add(shapeOf(path));

    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      problems.push(`${path} — HTTP ${status}`);
      continue;
    }

    const landed = new URL(page.url()).pathname;
    if (landed === '/login') {
      problems.push(`${path} — ログインへ戻された（セッションが切れている）`);
      continue;
    }

    try {
      await expect(page.locator('#t4d-main')).toBeVisible({ timeout: 15_000 });
    } catch {
      problems.push(`${path} — 本文（#t4d-main）が表示されない`);
      continue;
    }

    const body = (await page.locator('body').innerText()).slice(0, 6000);
    const marker = BROKEN_MARKERS.find((m) => body.includes(m));
    if (marker) {
      problems.push(`${path} — 画面に「${marker}」が表示された`);
      continue;
    }

    visited.push(path);

    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.startsWith('/') && !h.startsWith('//')),
    );
    for (const href of links) {
      const clean = href.split('#')[0] ?? '';
      if (!clean || clean.startsWith('/api/')) continue;
      if (!allowPrefixes.some((p) => clean.startsWith(p))) continue;
      if (!seen.has(shapeOf(clean))) queue.push(clean);
    }
  }

  return visited;
}
