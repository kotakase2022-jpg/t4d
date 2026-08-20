import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route Guard ＋ Content Security Policy。
 *
 * 認可の本体は Server Component / Server Action（`requireEnterpriseSession` 等）と
 * DB の RLS が担う。middleware は
 *   1. 未ログインで保護ルートを直接叩いた場合にログインへ戻す
 *   2. リクエストごとの nonce を発行して CSP を組み立てる
 * を担当する。
 *
 * CSP は next.config.ts の静的ヘッダーではなくここで設定する。
 * nonce はリクエストごとに変える必要があり、静的ヘッダーでは表現できないため。
 * Next.js は middleware が**リクエストヘッダー**へ設定した CSP から nonce を読み取り、
 * 自身が挿入する script タグへ自動的に付与する。
 */

const PROTECTED_PREFIXES = ['/enterprise', '/assurance', '/notifications', '/profile'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * ブラウザから Supabase Auth（MFA・パスワード再設定）へ直接 fetch するため、
 * 設定された Supabase URL の origin を connect-src へ含める。
 * ハードコードの *.supabase.co だけだとローカルスタックや自己ホストで
 * ブラウザ側の認証呼び出しが CSP に落とされる。
 */
function supabaseOrigin(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // http/https 以外（javascript: など）は origin が "null" になり、
    // CSP へそのまま入れる意味が無い。ディレクティブを汚さないよう捨てる。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';

  return [
    "default-src 'self'",
    // 'strict-dynamic' により、nonce 付きスクリプトが読み込むチャンクも許可される。
    // 開発時のみ HMR のため 'unsafe-eval' を許す（本番ビルドには含めない）。
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`.trim(),
    // Next.js / Tailwind が挿入する style 要素のため style-src は unsafe-inline を残す。
    // script と違い、スタイル経由の任意コード実行は起きない（docs/known-limitations.md S-6）。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://*.supabase.co https://*.supabase.in ${supabaseOrigin()}`.trim() +
      (isDev ? ' ws: http://127.0.0.1:* http://localhost:*' : ''),
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Supabase Mode のセッション更新。
 *
 * Server Component は Cookie を書けないため、アクセストークンの更新は
 * middleware で行う必要がある（@supabase/ssr の推奨構成）。
 * Demo Mode では何もしない。
 */
async function refreshSupabaseSession(request: NextRequest, response: NextResponse): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return;

  const { createServerClient } = await import('@supabase/ssr');
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: object }>) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getSession() は Cookie のセッションを読み、**期限切れの場合のみ**
  // GoTrue へ更新を投げて Cookie を書き戻す（有効期限内はネットワーク往復なし）。
  // 以前は毎リクエスト getUser() を呼んでいたが、これはプリフェッチ・API を含む
  // 全リクエストで GoTrue → Postgres の接続を発生させ、高負荷時に
  // ローカルスタックの接続枯渇（= セッション喪失に見える 500）を招いた。
  // トークンの真正性検証は session.ts の getUser()（リクエスト内キャッシュ済み）が担う。
  await supabase.auth.getSession();
}

export async function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next.js はこのリクエストヘッダーから nonce を抽出して自身の script へ付与する
  requestHeaders.set('content-security-policy', csp);

  const { pathname } = request.nextUrl;

  if (isProtected(pathname)) {
    const demoUser = request.cookies.get('t4d_demo_user')?.value;
    const supabaseAuth = request.cookies
      .getAll()
      .some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));

    if (!demoUser && !supabaseAuth) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      const redirect = NextResponse.redirect(url);
      redirect.headers.set('content-security-policy', csp);
      return redirect;
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  await refreshSupabaseSession(request, response);
  return response;
}

export const config = {
  matcher: [
    /*
     * 静的アセット・画像最適化・favicon を除外する。
     */
    '/((?!_next/static|_next/image|favicon.ico|brand/).*)',
  ],
};
