/**
 * 資料・引用まわりの入力の上限（画面の入力欄とサーバーの検証で同じ値を使う）。
 * 画面が上限を知らないと、長い文言を手で写したあとにサーバーで断られ、入力が無駄になる。
 */

/** 手動抜粋の文言の最大文字数 */
export const MANUAL_EXCERPT_MAX_LENGTH = 4000;

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'skipped';

/** ウイルススキャンの状態の表示名（DB の値 skipped などを画面へそのまま出さない） */
export const SCAN_STATUS_LABELS: Record<ScanStatus, string> = {
  pending: '未実施',
  clean: '問題なし',
  infected: '検出あり',
  skipped: '対象外',
};

/** 状態ごとのバッジの色（色だけで伝えず、必ずラベルとアイコンを添える） */
export const SCAN_STATUS_TONES: Record<ScanStatus, 'neutral' | 'success' | 'danger'> = {
  pending: 'neutral',
  clean: 'success',
  infected: 'danger',
  skipped: 'neutral',
};

/**
 * 資料の形式の表示名。画面に MIME 型（application/vnd.openxmlformats-… など）をそのまま出さない。
 * 分からない形式は拡張子を大文字で添える（それも無ければ「その他の形式」）
 */
export function fileTypeLabel(mimeType: string | null | undefined, fileName = ''): string {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (
    mime.includes('wordprocessingml') ||
    mime === 'application/msword' ||
    ext === 'docx' ||
    ext === 'doc'
  ) {
    return 'Word 文書';
  }
  if (
    mime.includes('spreadsheetml') ||
    mime === 'application/vnd.ms-excel' ||
    ext === 'xlsx' ||
    ext === 'xls'
  ) {
    return 'Excel ブック';
  }
  if (mime.includes('presentationml') || ext === 'pptx') return 'PowerPoint';
  if (mime.includes('csv') || ext === 'csv') return 'CSV';
  if (mime.startsWith('image/')) {
    const kind = mime.slice('image/'.length).replace('jpeg', 'jpg').toUpperCase();
    return `画像（${kind || ext.toUpperCase() || '形式不明'}）`;
  }
  if (mime.startsWith('text/') || ext === 'txt') return 'テキスト';
  return ext ? `${ext.toUpperCase()} ファイル` : 'その他の形式';
}
