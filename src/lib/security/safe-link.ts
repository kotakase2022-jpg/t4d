/**
 * アプリ内リンクの検証。
 *
 * AI（実 Provider）の出力や通知の遷移先など、**こちらが生成していない文字列**を
 * href として描画する箇所で使う。許可するのは企業側画面（`/enterprise/...`）だけで、
 * 外部 URL・`javascript:`・`..` による遡上（`/enterprise/../auditor/...` など）を弾く。
 */

/** 文字種の粗いふるい。`:` を含めないことで scheme 付き URL を排除する。 */
const SHAPE = /^\/enterprise\/[\w\-/?&=%.]*$/;

/**
 * デコード後に現れると危険な文字を含むか。
 * `:` は scheme、`\` は Windows 風パス／一部ブラウザでの `/` 相当、制御文字は
 * ヘッダー・属性への注入に使われる。
 * 正規表現ではなくコード値で判定する（制御文字リテラルを正規表現へ書かないため）。
 */
function hasDangerousChar(value: string): boolean {
  for (const char of value) {
    if (char === ':' || char === '\\') return true;
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSafeAppLink(link: string): boolean {
  if (!SHAPE.test(link)) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    return false; // 不正なパーセントエンコード
  }
  // デコードで scheme・バックスラッシュ・制御文字が現れるものを弾く。
  // ここで SHAPE を再適用すると、クエリに日本語を含む**正当なリンク**
  // （例: /enterprise/data?unit=%E6%9C%AC%E7%A4%BE）まで落ちてしまう。
  if (hasDangerousChar(decoded)) return false;

  // `..` / `.` を解決した実効パスが /enterprise/ 配下に留まることを確認する。
  // これにより `/enterprise/../auditor` や `%2e%2e` 経由の遡上を防ぐ。
  const normalized = new URL(decoded, 'http://t4d.invalid').pathname;
  return normalized.startsWith('/enterprise/');
}

/** 安全なら元のリンク、危険なら null。 */
export function safeAppLinkOrNull(link: string | null | undefined): string | null {
  return link && isSafeAppLink(link) ? link : null;
}
