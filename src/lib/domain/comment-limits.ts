/**
 * コメント・理由の入力の上限（画面の入力欄とサーバーの検証で同じ値を使う）。
 *
 * 画面が上限を知らないと、長い理由を書いたあとでサーバーに断られて入力が無駄になる。
 * サーバー専用の comments.ts に置くと Client Component（確認ダイアログの理由欄）から
 * 参照できないため、ここへ分けている。
 */
export const COMMENT_MAX_LENGTH = 2000;

/** 開示回答の差戻し理由をコメントに残すときの前置き（本文の上限はこの分だけ短くなる） */
export const RETURN_REASON_PREFIX = '差戻し理由: ';

/** 開示回答の差戻し理由として入力できる最大文字数（前置きを足してもコメントの上限に収まる長さ） */
export const RETURN_REASON_MAX_LENGTH = COMMENT_MAX_LENGTH - RETURN_REASON_PREFIX.length;
