/**
 * 取込の名前（ファイル名。複数ならファイル数を添える）。取込ジョブの内部 ID を画面に出さない
 * （一覧の行・取込確認の画面の見出しで同じ名前を使う。plan §1.17）
 */
export function importJobTitle(fileNames: readonly string[]): string {
  if (fileNames.length === 0) return '（ファイルなし）';
  if (fileNames.length === 1) return fileNames[0]!;
  return `${fileNames[0]} ほか ${fileNames.length - 1} ファイル`;
}
