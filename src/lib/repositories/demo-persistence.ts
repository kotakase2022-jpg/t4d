import 'server-only';

import { cookies } from 'next/headers';
import {
  decodeDemoEdits,
  dropOldestUnpinned,
  encodeDemoEdits,
  isPersistedTable,
  type DemoEdit,
} from './demo-edit-codec';
import { randomUUID } from 'node:crypto';
import {
  decodeDemoResetMark,
  encodeDemoResetMark,
  isNewerDemoReset,
  newDemoResetEpoch,
  type DemoResetMark,
} from './demo-reset-sync';
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
export const MAX_BYTES_PER_COOKIE = 3800;
/**
 * 使う Cookie の数。
 *
 * 1 つだと 2 ファイルの取込がちょうど境界に乗ってしまい、
 * 「入るときと入らないときがある」という一番たちの悪い挙動になった
 * （本番スモークが 2 回に 1 回落ちた）。分割して余裕を持たせる。
 * 上限まで使っても約 7.6KB で、リクエストヘッダー全体の上限には届かない。
 */
export const COOKIE_CHUNKS = 2;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 60 * 60 * 8,
};

function chunkName(index: number): string {
  return index === 0 ? COOKIE_NAME : `${COOKIE_NAME}.${index}`;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * 古い順（追記した順）に並べる。チャンクへは空きのあるところへ詰めるため、
 * チャンクを読んだ順は追記の順と一致しない。押し出す順（古いものから）を保つため、
 * 追記の順番（n）で並べ直す。順番を持たない以前の Cookie の編集は、読んだ順のまま先頭に置く
 */
function inAppendOrder(edits: DemoEdit[]): DemoEdit[] {
  return edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => (a.edit.n ?? -1) - (b.edit.n ?? -1) || a.index - b.index)
    .map(({ edit }) => edit);
}

function readFrom(store: CookieStore): DemoEdit[] {
  const edits: DemoEdit[] = [];
  for (let i = 0; i < COOKIE_CHUNKS; i += 1) {
    const raw = store.get(chunkName(i))?.value;
    if (raw) edits.push(...decodeDemoEdits(raw));
  }
  return inAppendOrder(edits);
}

/** 現在の Cookie に入っている変更を読む（追記した順） */
export async function readDemoEdits(): Promise<DemoEdit[]> {
  // テストやスクリプトなど、リクエストスコープの外から呼ばれることがある。
  // その場合は Cookie が無いだけなので、静かに空で返す。
  try {
    return readFrom(await cookies());
  } catch {
    return [];
  }
}

/**
 * 変更をチャンクへ詰める。古い順に、入るいちばん前のチャンクへ入れる（first-fit）。
 *
 * 以前は「先頭から入るだけ」を 1 つ目のチャンクへ入れ、残りを次へ送っていた。大きな編集
 * （原稿の AI 下書きの実行 約 2.3KB）が 1 つ目に入らないと、それ以後の編集はすべて 2 つ目に回り、
 * 1 つ目に 1KB 以上の空きを残したまま押し出しが始まっていた（実演の 6 手目で 3 手目の取込が消えた）。
 * 並びは追記の順番（n）で戻せるため、チャンクをまたいで順序を保つ必要は無い。
 *
 * 返すのは詰めたチャンクと、どのチャンクにも入らなかった編集。
 */
export function packIntoChunks(edits: readonly DemoEdit[]): {
  chunks: string[];
  overflow: DemoEdit[];
} {
  const bins: DemoEdit[][] = [];
  const overflow: DemoEdit[] = [];
  for (const edit of edits) {
    let placed = false;
    for (let i = 0; i < COOKIE_CHUNKS; i += 1) {
      const candidate = [...(bins[i] ?? []), edit];
      if (encodeDemoEdits(candidate).length <= MAX_BYTES_PER_COOKIE) {
        bins[i] = candidate;
        placed = true;
        break;
      }
    }
    if (!placed) overflow.push(edit);
  }
  return {
    chunks: bins.filter((bin) => bin.length > 0).map((bin) => encodeDemoEdits(bin)),
    overflow,
  };
}

/**
 * 押し出しても「古い操作を保持できませんでした」と知らせない表。
 * 取込の行は 1 回の取込で数百行を追記し、同じ取込の後の行が前の行を押し出す。
 * 取込結果は同じリクエストで表示し終えており、大量の取込が同一インスタンスでしか
 * 参照できないことは取込の画面が案内している（docs/known-limitations.md D-3）
 */
const QUIET_EVICTION_TABLES: ReadonlySet<string> = new Set([
  'ingestionJobs',
  'ingestionJobFiles',
  'ingestionRows',
]);

function writeChunks(store: CookieStore, chunks: readonly string[]): void {
  for (let i = 0; i < COOKIE_CHUNKS; i += 1) {
    const value = chunks[i];
    // 使わなくなったチャンクは空にしておく（古い内容が残ると復元がずれる）
    store.set(chunkName(i), value ?? '', value ? COOKIE_OPTIONS : { ...COOKIE_OPTIONS, maxAge: 0 });
  }
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

  let store: CookieStore;
  try {
    store = await cookies();
  } catch {
    // リクエストスコープ外（テスト・CLI）では何もしない
    return;
  }
  const current = readFrom(store);

  const key = `${table}:${id}`;
  const merged = current.filter((e) => `${e.t}:${e.id}` !== key);
  const previous = current.find((e) => `${e.t}:${e.id}` === key);
  const sequence = current.reduce((max, e) => Math.max(max, e.n ?? 0), 0) + 1;
  const nextEdit: DemoEdit = {
    t: table,
    id,
    v: { ...(previous?.v ?? {}), ...changed },
    n: sequence,
  };

  // 単体で 1 チャンクに入らない編集は追記を諦める（同一インスタンス内では
  // メモリ上の Fixture に反映済み）。ここで諦めずに縮小ループへ進むと、
  // 「新しい 1 件も入らない → 既存の編集まで全部落ちて空 Cookie を書く」
  // という全消滅になる（レビュー指摘）。既存の持ち回りは守る。
  if (packIntoChunks([nextEdit]).chunks.length === 0) {
    return;
  }
  merged.push(nextEdit);

  // 全チャンクへ入りきらない分は、古い方から落とす。機能設定（開示優先モードの ON/OFF）は落とさない
  // （落とすと新しいインスタンスでメニューとホームが従来の構成へ戻り、実演の途中で画面が変わる）
  let candidate = merged;
  let packed = packIntoChunks(candidate);
  const evictedTables = new Set<string>();
  while (candidate.length > 0 && packed.overflow.length > 0) {
    const next = dropOldestUnpinned(candidate) ?? candidate.slice(1);
    const dropped = candidate.find((e) => !next.includes(e));
    if (dropped) evictedTables.add(dropped.t);
    candidate = next;
    packed = packIntoChunks(candidate);
  }

  try {
    writeChunks(store, packed.chunks);
    // 古い操作を押し出したことを画面（デモの帯）で知らせる。別のサーバーでは押し出した操作が
    // 戻らないため、黙っていると「さっきの操作が消えた」ように見える。どの表の操作かを残し、
    // その表をリセットしたら知らせを消す（リセット後も古い注意を出し続けない）
    const noisy = [...evictedTables].filter((t) => !QUIET_EVICTION_TABLES.has(t));
    if (noisy.length > 0) {
      writeEvicted(store, new Set([...readEvicted(store), ...noisy]));
    }
  } catch {
    // Server Component からは Cookie を書けない。読み取り経路では何もしない。
  }
}

// ----------------------------------------------------------------------
// 開示デモのリセットの印（ほかのインスタンスへの反映）
// ----------------------------------------------------------------------

/** 開示デモのリセットの印（組織と世代）。ほかのインスタンスがリセットを反映するのに使う */
const RESET_COOKIE = 't4d.demo-reset';

interface AppliedResets {
  /** このインスタンスが起動した時点の世代（これより前のリセットは起動時のメモリに含まれる） */
  baseline: string;
  /** 組織ごとに反映した最新の世代 */
  byOrganization: Map<string, string>;
}

/** このインスタンスが反映済みのリセット */
function appliedResets(): AppliedResets {
  const g = globalThis as unknown as { __t4dAppliedDemoResets?: AppliedResets };
  // 以前の形（Map）が残っていても、起動時点からやり直す
  if (!g.__t4dAppliedDemoResets || g.__t4dAppliedDemoResets instanceof Map) {
    g.__t4dAppliedDemoResets = {
      baseline: newDemoResetEpoch(Date.now(), '0'),
      byOrganization: new Map(),
    };
  }
  return g.__t4dAppliedDemoResets;
}

/** 反映済みの世代を進める（古い印で巻き戻さない） */
function recordApplied(mark: DemoResetMark): void {
  const applied = appliedResets();
  if (isNewerDemoReset(mark, applied.byOrganization.get(mark.organizationId), applied.baseline)) {
    applied.byOrganization.set(mark.organizationId, mark.epoch);
  }
}

/** リセットを行ったことを Cookie に残す（このインスタンスは既に戻しているので反映済みとする） */
export async function markDemoReset(organizationId: string): Promise<void> {
  const mark: DemoResetMark = {
    organizationId,
    epoch: newDemoResetEpoch(Date.now(), randomUUID()),
  };
  recordApplied(mark);
  try {
    const store = await cookies();
    store.set(RESET_COOKIE, encodeDemoResetMark(mark), COOKIE_OPTIONS);
  } catch {
    // リクエストスコープ外（テスト・CLI）では何もしない
  }
}

/**
 * このインスタンスがまだ反映していない、より新しいリセットの印（無ければ null）。
 * 印は署名の無い Cookie のため、呼び出し側（getSession）はログインした利用者の組織・権限と
 * 突き合わせてから反映し、markDemoResetApplied を呼ぶ
 */
export async function pendingDemoReset(): Promise<DemoResetMark | null> {
  try {
    const store = await cookies();
    const mark = decodeDemoResetMark(store.get(RESET_COOKIE)?.value);
    if (!mark) return null;
    const applied = appliedResets();
    return isNewerDemoReset(mark, applied.byOrganization.get(mark.organizationId), applied.baseline)
      ? mark
      : null;
  } catch {
    return null;
  }
}

export function markDemoResetApplied(mark: DemoResetMark): void {
  recordApplied(mark);
}

// ----------------------------------------------------------------------
// 押し出しの知らせ
// ----------------------------------------------------------------------

/** 古い操作を Cookie から押し出したことの印（デモの帯で注意を出す）。値は押し出した表の一覧 */
export const EVICTED_COOKIE = 't4d.demo-evicted';

/** 以前の形式（'1'）は、どの表かが分からない押し出し */
const UNKNOWN_EVICTION = '*';

function readEvicted(store: CookieStore): Set<string> {
  const raw = store.get(EVICTED_COOKIE)?.value;
  if (!raw) return new Set();
  if (raw === '1') return new Set([UNKNOWN_EVICTION]);
  return new Set(raw.split(',').filter((t) => /^[A-Za-z*]{1,64}$/.test(t)));
}

function writeEvicted(store: CookieStore, tables: ReadonlySet<string>): void {
  if (tables.size === 0) {
    store.set(EVICTED_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
    return;
  }
  store.set(EVICTED_COOKIE, [...tables].sort().join(','), COOKIE_OPTIONS);
}

/** Cookie の容量不足で古い操作を押し出したか */
export async function demoEditsWereEvicted(): Promise<boolean> {
  try {
    return readEvicted(await cookies()).size > 0;
  } catch {
    return false;
  }
}

/**
 * 押し出しの知らせを消す。tables を渡したときは、その表の押し出しだけを消す
 * （リセットでその表の行が Fixture の初期値へ戻り、押し出した操作が意味を失ったとき）。
 * 省略時（ログアウト）はすべて消す
 */
export async function clearDemoEviction(tables?: readonly string[]): Promise<void> {
  try {
    const store = await cookies();
    if (!tables) {
      writeEvicted(store, new Set());
      return;
    }
    const remaining = readEvicted(store);
    const before = remaining.size;
    for (const table of tables) remaining.delete(table);
    if (remaining.size !== before) writeEvicted(store, remaining);
  } catch {
    // リクエストスコープ外・Server Component では何もしない
  }
}

// ----------------------------------------------------------------------
// リセット用の取り除き
// ----------------------------------------------------------------------

/**
 * 条件に合う持ち回りだけを Cookie から取り除く（デモリセット用）。
 *
 * Cookie を丸ごと消すと、他の画面で行ったデモ操作（評価・コメント等）まで
 * 巻き添えで消える。取り除く対象を条件で名指しできるこの関数で、範囲をデモの
 * 該当データに限定する。localStorage など他の保存領域には触らない。
 */
export async function removeDemoEditsWhere(
  shouldRemove: (edit: DemoEdit) => boolean,
): Promise<void> {
  let store: CookieStore;
  try {
    store = await cookies();
  } catch {
    return;
  }
  const current = readFrom(store);
  const remaining = current.filter((e) => !shouldRemove(e));
  if (remaining.length === current.length) return;
  try {
    // 取り除いた後は必ず入る（入らなかった分は元から入っていない）
    writeChunks(store, packIntoChunks(remaining).chunks);
  } catch {
    // Server Component からは書けない。リセットは Server Action からのみ呼ぶ。
  }
}

/** 指定したテーブル×ID の持ち回りだけを Cookie から取り除く */
export async function removeDemoEditsFor(
  table: TableName,
  ids: ReadonlySet<string>,
): Promise<void> {
  await removeDemoEditsWhere((e) => e.t === table && ids.has(e.id));
}

export { applyDemoEdits, isPersistedTable } from './demo-edit-codec';
