import type * as React from 'react';

/**
 * 画面の操作の型（plan §3.2）。見出しの PageActions・行の RowActions・「その他」メニュー・
 * 確認ダイアログが同じ形で操作を受け取る（同じ意味の操作を画面ごとに別の部品で描かない。指示書 §23）。
 *
 * 型と純関数だけ（React の描画には依存しない）。Server Component で組み立て、クライアントの
 * メニュー部品へ渡す（Server Action・リンク・文字列だけなので RSC 境界を越えられる）。
 */

/** フォームの Server Action（FormData を受ける） */
export type ServerAction = (formData: FormData) => void | Promise<void>;

export interface ActionBase {
  /** 画面内で一意（テストの目印 data-action-id） */
  id: string;
  /** 動詞で始まる業務の言葉（アイコンだけにしない） */
  label: string;
  icon?: React.ReactNode;
  /** 権限が無いなど、出さない操作（描かない。サーバー側の検査はそのまま） */
  hidden?: boolean;
  /** 状態の都合で今は押せない理由（押せないボタンとして残し、理由を Hint と読み上げで出す） */
  disabledReason?: string;
  /**
   * キーボードの近道（plan §1.11）。'new' は「n でその画面の新規作成を開く」の飛び先
   * （`data-t4d-shortcut="new"` を出す。record-shortcuts.tsx が押す）。1 画面に 1 つだけ付ける
   */
  shortcut?: 'new';
}

/**
 * 危険な操作の確認（plan §1.16 の 3 区分）:
 *  - irreversible: 取り消せない（範囲 1 行を常に出す。リセットは必須チェック）
 *  - bulk: 一括・上書き（件数・内訳・前後の値のプレビュー。差戻しは理由必須）
 *  - reversible: 実行後に「元に戻す」を出せるもの（逆操作が無いなら irreversible にする）
 */
export type ConfirmTier = 'irreversible' | 'bulk' | 'reversible';

export interface ConfirmSpec {
  tier: ConfirmTier;
  /** 問いかけの題（例: このデータを差し戻しますか） */
  title: string;
  /** 範囲 1 行。常に本文に出す（「上記の範囲」が指すもの。§10.4 で閉じない） */
  scope: string;
  /** 結果の箇条（何が起きるか） */
  consequences?: string[];
  /** 必須のチェック（リセット）。name はサーバーが検査する既存の名前 */
  acknowledge?: { name: string; label: string };
  /** 理由の入力（差戻しは required） */
  reason?: { name: string; label: string; required: boolean; placeholder?: string };
  /** 件数・状態の内訳・前後の値 */
  preview?: React.ReactNode;
  /** 確定ボタンの文言（ダイアログの中の唯一の primary／danger） */
  confirmLabel: string;
  /** 確定ボタンを danger で描く（取り消せない破壊的な操作）。既定は tier が irreversible のとき */
  destructive?: boolean;
  /** 本文に足す任意の入力（例: 数値データも戻すかの選択） */
  extraFields?: React.ReactNode;
}

export type ActionSpec =
  | (ActionBase & { kind: 'link'; href: string; download?: boolean; external?: boolean })
  | (ActionBase & {
      kind: 'submit';
      action: ServerAction;
      fields?: Record<string, string>;
      pendingLabel?: string;
    })
  | (ActionBase & {
      kind: 'confirm';
      action: ServerAction;
      fields?: Record<string, string>;
      confirm: ConfirmSpec;
    });

/** メニューの項目（「その他」・行の「操作」） */
export type MenuActionSpec = ActionSpec & {
  /** 破壊的な操作（区切り線の下・赤字＋アイコン） */
  destructive?: boolean;
  /** 並べる群: main（日常）→ export（出力）→ advanced（AI・技術情報・管理） */
  group?: 'main' | 'export' | 'advanced';
};

/** 見出しの secondary の上限。3 つ目以降は「その他」へ送る（plan §1.6） */
export const MAX_SECONDARY_ACTIONS = 2;

export function visibleActions<T extends { hidden?: boolean }>(
  items: readonly T[] | undefined,
): T[] {
  return (items ?? []).filter((item) => !item.hidden);
}

const GROUP_ORDER: Record<NonNullable<MenuActionSpec['group']>, number> = {
  main: 0,
  export: 1,
  advanced: 2,
};

/**
 * メニューの並び: 群の順（日常 → 出力 → 高度）、破壊的な操作は最後（区切り線の下）。
 * 同じ群の中は渡された順
 */
export function orderMenuItems(items: readonly MenuActionSpec[]): MenuActionSpec[] {
  return visibleActions(items)
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(Boolean(a.item.destructive)) - Number(Boolean(b.item.destructive)) ||
        GROUP_ORDER[a.item.group ?? 'main'] - GROUP_ORDER[b.item.group ?? 'main'] ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/**
 * 見出しの操作を primary 1・secondary ≤2・その他に振り分ける（plan §1.6・§3.2）。
 * hidden は除く。secondary の 3 つ目以降は「その他」の先頭（main 群）へ送る
 */
export function splitPageActions(input: {
  primary?: ActionSpec;
  secondary?: readonly ActionSpec[];
  more?: readonly MenuActionSpec[];
}): { primary: ActionSpec | null; secondary: ActionSpec[]; more: MenuActionSpec[] } {
  const primary = input.primary && !input.primary.hidden ? input.primary : null;
  const secondary = visibleActions(input.secondary);
  const shown = secondary.slice(0, MAX_SECONDARY_ACTIONS);
  const overflow: MenuActionSpec[] = secondary
    .slice(MAX_SECONDARY_ACTIONS)
    .map((action) => ({ ...action, group: 'main' as const }));
  return { primary, secondary: shown, more: orderMenuItems([...overflow, ...(input.more ?? [])]) };
}
