import { useSyncExternalStore } from 'react';

/**
 * 左メニューの「優先枝」の保存（docs/disclosure-first.md §10.1 現在地の規則）。
 *
 * 従来ツリーでは定性情報が SSBJ と CSRD の 2 か所に出る。どちらを現在地にするかを、利用者が最後に
 * たどった枝（祖先ラベルの経路。例 `開示対応 / CSRD`）で決める。表示の便宜だけなので
 * タブ内の sessionStorage に置き、サーバーへは送らない（§10.5）。位置キー（添字）は権限で項目が隠れると
 * ずれるため保存しない。
 *
 * SSR と初回描画（ハイドレーション）は null（＝木の順で SSBJ 側）で決定的にし、マウント後に保存値を当てる
 * （サイドバーの折りたたみ状態と同じ扱い。表示が 1 回切り替わりうる）。
 * sessionStorage が使えない環境（プライベートブラウズの制限など）では、読み書きとも null 扱いで既定に従う。
 */

export const NAV_BRANCH_STORAGE_KEY = 't4d.sidebar.branch';

const listeners = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage;
}

/** 覚えている優先枝。無い・読めないときは null */
export function readNavBranch(): string | null {
  try {
    const value = storage()?.getItem(NAV_BRANCH_STORAGE_KEY) ?? null;
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

/** 優先枝を覚える（null は削除）。同じタブの購読者（useNavBranch）へすぐ知らせる */
export function rememberNavBranch(branch: string | null): void {
  try {
    const store = storage();
    if (store) {
      if (branch === null) store.removeItem(NAV_BRANCH_STORAGE_KEY);
      else store.setItem(NAV_BRANCH_STORAGE_KEY, branch);
    }
  } catch {
    // 保存できない環境では覚えない（readNavBranch が null を返し、既定の SSBJ 側に従う）
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** サーバーとハイドレーション中は保存値を読まない（描画を決定的にする） */
function serverSnapshot(): string | null {
  return null;
}

/** 覚えている優先枝（サイドバーの現在地の同点解消に使う） */
export function useNavBranch(): string | null {
  return useSyncExternalStore(subscribe, readNavBranch, serverSnapshot);
}
