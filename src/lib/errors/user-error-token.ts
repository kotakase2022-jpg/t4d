/**
 * 業務エラー（`?error=`）の出どころの確認。middleware（Edge）とサーバーの両方から使う純関数・定数
 * （'server-only' を付けない。Node の crypto にも依存しない）。
 *
 * 業務エラーは withUserFacingError が `?error=<文>` に載せて元の画面へ戻し、画面（FlashMessage・
 * GlobalErrorNotice・ログイン・招待・ワークスペース選択）がその文を「システムのエラー」として出す。
 * URL の文をそのまま信じると、第三者が作ったリンク
 * （例: `/login?error=パスワードを support@… へ送ってから再ログインしてください`）の文が、
 * 本物のログイン画面の赤い警告として出てしまう。
 *
 * そこで、エラーを載せるときに使い捨ての合言葉（token）を発行し、同じ値を Cookie と URL（`et`）の
 * 両方に置く。両者が一致しない `?error=` は、middleware がサーバーの描画から外し（内部の書き換え）、
 * クライアントの GlobalErrorNotice も出さない。他サイトから被害者の Cookie は書けないため、外から作った
 * リンクの文は表示されない。Cookie はブラウザが持ち回るので、リダイレクトの描画が別のインスタンスに
 * 届いても（Vercel）確認できる。
 */

/** エラーの文を載せる URL のパラメータ */
export const USER_ERROR_PARAM = 'error';
/** 合言葉を載せる URL のパラメータ */
export const USER_ERROR_TOKEN_PARAM = 'et';
/** 合言葉を置く Cookie */
export const USER_ERROR_TOKEN_COOKIE = 't4d_error_token';
/** 合言葉の有効期間（秒）。戻った画面の再読み込みでも理由を出し続けられる長さ */
export const USER_ERROR_TOKEN_MAX_AGE = 10 * 60;

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** document.cookie から合言葉を読む（クライアント用。読めなければ undefined） */
export function userErrorTokenFromCookie(cookie: string): string | undefined {
  const prefix = `${USER_ERROR_TOKEN_COOKIE}=`;
  const hit = cookie.split(/;\s*/).find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

/** 使い捨ての合言葉（推測できない 128 bit） */
export function newUserErrorToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * URL の `?error=` が、このブラウザに対してサーバーが載せたものか。
 * `?error=` が無ければ確かめるものが無いので true。
 */
export function isIssuedUserError(
  params: URLSearchParams,
  cookieToken: string | undefined,
): boolean {
  if (!params.has(USER_ERROR_PARAM)) return true;
  const token = params.get(USER_ERROR_TOKEN_PARAM);
  return token !== null && TOKEN_PATTERN.test(token) && token === cookieToken;
}
