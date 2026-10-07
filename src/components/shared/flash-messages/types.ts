/**
 * 結果の通知（`?flash=`）の登録簿の型。ドメインごとのファイル（Stage B の各スライスが所有）に分け、
 * flash.tsx が集約する。文言は URL の引数（件数など）から作る関数。
 */
export type FlashBuilder = (params: URLSearchParams) => string;

export type FlashRegistry = Record<string, FlashBuilder>;
