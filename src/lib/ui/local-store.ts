/**
 * 端末ごとの利便（最近使った画面・保存ビュー・ナビの開閉・「はじめに」を閉じた印・表示件数の好み）
 * を localStorage に置くための小さな道具（plan §4 末尾）。
 *
 * - 共有したい状態・確実に残したい状態は置かない（別の端末・別の利用者には届かない）
 * - プライベートウィンドウ・サイトデータの拒否・サーバー描画では使えない。読み書きは必ず try/catch で、
 *   使えなくても画面の描画は同じになるようにする（呼び出し側は null を「保存なし」として扱う）
 */

/** 端末の保存を利用者・組織ごとに分ける鍵（AppShell が配る viewerKey と同じ形） */
export function viewerKeyOf(ctx: {
  userId: string;
  workspace: { organizationId: string };
}): string {
  return `${ctx.userId}:${ctx.workspace.organizationId}`;
}

export const LOCAL_KEYS = {
  nav: (viewerKey: string) => `t4d.nav.v1.${viewerKey}`,
  recent: (viewerKey: string) => `t4d.recent.v1.${viewerKey}`,
  table: (viewerKey: string, tableId: string) => `t4d.table.v1.${viewerKey}.${tableId}`,
  gettingStarted: (viewerKey: string) => `t4d.getting-started.v1.${viewerKey}`,
} as const;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** JSON を読み、検証して返す。無い・壊れている・使えないときは null */
export function readLocal<T>(key: string, parse: (raw: unknown) => T | null): T | null {
  try {
    const raw = storage()?.getItem(key);
    if (raw === null || raw === undefined) return null;
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** JSON で書く。使えないときは何もしない（容量超過も含めて黙って諦める） */
export function writeLocal(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 端末の利便なので、保存できなくても操作は続けられる */
  }
}

export function removeLocal(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* noop */
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
