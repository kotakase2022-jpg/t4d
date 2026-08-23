import 'server-only';

import { cookies } from 'next/headers';
import {
  decodeDemoEdits,
  encodeDemoEdits,
  isPersistedTable,
  type DemoEdit,
} from './demo-edit-codec';
import type { TableName } from './types';

/**
 * Demo Mode の書き込みを **Cookie で持ち回す**ための最小の永続化。
 *
 * Demo Mode の状態はプロセスのメモリ（globalThis）にしか無い。
 * Vercel はリクエストごとに別インスタンスへ振り分けることがあるため、
 * 保存した直後にリロードすると変更が消えたように見える
 * （docs/known-limitations.md D-3）。本番は環境変数を持たない Demo Mode で
 * 動かす方針のため、外部ストアを使って解決することはできない。
 *
 * そこで「ユーザーがこのセッションで行った変更」だけを Cookie に記録し、
 * 読み取り時に Fixture へ再適用する。デモとして見せたい操作
 * （評価の登録・コメント・値の編集など）が、インスタンスをまたいでも残る。
 *
 * 制約:
 *  - Cookie は 4KB 程度が上限。**行全体ではなく、変更のあった列だけ**を記録する。
 *  - 上限を超えたら古い変更から捨てる（デモ用途として許容する）。
 *  - 取込ジョブのような大きなデータは対象外（同一リクエスト内で完結させている）。
 */

const COOKIE_NAME = 't4d.demo-edits';
/**
 * Cookie 1 つあたりの実サイズ上限。ブラウザの上限（約 4KB）に名前と属性の分を残す。
 */
const MAX_BYTES_PER_COOKIE = 3800;
/**
 * 使う Cookie の数。
 *
 * 1 つだと 2 ファイルの取込がちょうど境界に乗ってしまい、
 * 「入るときと入らないときがある」という一番たちの悪い挙動になった
 * （本番スモークが 2 回に 1 回落ちた）。分割して余裕を持たせる。
 * 上限まで使っても約 7.6KB で、リクエストヘッダー全体の上限には届かない。
 */
const COOKIE_CHUNKS = 2;

function chunkName(index: number): string {
  return index === 0 ? COOKIE_NAME : `${COOKIE_NAME}.${index}`;
}

/** 現在の Cookie に入っている変更を読む */
export async function readDemoEdits(): Promise<DemoEdit[]> {
  // テストやスクリプトなど、リクエストスコープの外から呼ばれることがある。
  // その場合は Cookie が無いだけなので、静かに空で返す。
  try {
    const store = await cookies();
    const edits: DemoEdit[] = [];
    for (let i = 0; i < COOKIE_CHUNKS; i += 1) {
      const raw = store.get(chunkName(i))?.value;
      if (raw) edits.push(...decodeDemoEdits(raw));
    }
    return edits;
  } catch {
    return [];
  }
}

/**
 * 変更をチャンクへ詰め直す。
 * 1 つの Cookie に収まる範囲で古い順に詰め、入りきらない分は次のチャンクへ送る。
 */
function packIntoChunks(edits: DemoEdit[]): string[] {
  const chunks: string[] = [];
  let rest = [...edits];

  for (let i = 0; i < COOKIE_CHUNKS && rest.length > 0; i += 1) {
    // このチャンクへ入るだけ入れる（後ろ＝新しい変更を優先して残す）
    let take = rest.length;
    while (take > 0 && encodeDemoEdits(rest.slice(0, take)).length > MAX_BYTES_PER_COOKIE) {
      take -= 1;
    }
    if (take === 0) break;
    chunks.push(encodeDemoEdits(rest.slice(0, take)));
    rest = rest.slice(take);
  }
  return chunks;
}

/** チャンクへ実際に収まった件数 */
function countPacked(chunks: string[]): number {
  return chunks.reduce((count, chunk) => count + decodeDemoEdits(chunk).length, 0);
}

/**
 * 変更を Cookie へ追記する。
 * 同じ (table, id) は最新で置き換え、サイズ超過分は古い順に捨てる。
 */
export async function appendDemoEdit(
  table: TableName,
  id: string,
  changed: Record<string, unknown>,
): Promise<void> {
  if (!isPersistedTable(table)) return;

  let store: Awaited<ReturnType<typeof cookies>>;
  try {
    store = await cookies();
  } catch {
    // リクエストスコープ外（テスト・CLI）では何もしない
    return;
  }
  const current = await readDemoEdits();

  const key = `${table}:${id}`;
  const merged = current.filter((e) => `${e.t}:${e.id}` !== key);
  const previous = current.find((e) => `${e.t}:${e.id}` === key);
  merged.push({ t: table, id, v: { ...(previous?.v ?? {}), ...changed } });

  // 全チャンクへ入りきらない分は、古い方から落とす
  let candidate = merged;
  let chunks = packIntoChunks(candidate);
  while (candidate.length > 0 && countPacked(chunks) < candidate.length) {
    candidate = candidate.slice(1);
    chunks = packIntoChunks(candidate);
  }

  try {
    const options = {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 60 * 60 * 8,
    };
    for (let i = 0; i < COOKIE_CHUNKS; i += 1) {
      const value = chunks[i];
      // 使わなくなったチャンクは空にしておく（古い内容が残ると復元がずれる）
      store.set(chunkName(i), value ?? '', value ? options : { ...options, maxAge: 0 });
    }
  } catch {
    // Server Component からは Cookie を書けない。読み取り経路では何もしない。
  }
}

export { applyDemoEdits, isPersistedTable } from './demo-edit-codec';
