/**
 * XML・XHTML の文字のエスケープ（iXBRL のプレビュー・テキストブロックの値）。
 *
 * 本文・節名・指標名は利用者が入力した文字列で、そのまま HTML に入れると `<script>` などが要素になる。
 * 出力に入れる利用者の文字列は必ずここを通す（属性値も同じ関数で、引用符も変える）。
 * XML 1.0 で使えない制御文字は落とす（文書が壊れて読めなくなるのを防ぐ）
 */
export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- XML 1.0 で使えない制御文字（タブ・改行・復帰は残す）
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}
