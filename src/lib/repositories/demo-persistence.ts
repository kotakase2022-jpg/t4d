import 'server-only';

import { cookies } from 'next/headers';
import {
  STREAM_MARK,
  decodeDemoEdits,
  dropOldestUnpinned,
  encodeDemoEditStream,
  isPersistedTable,
  type DemoEdit,
} from './demo-edit-codec';
import { randomUUID } from 'node:crypto';
import { isFreshFixturePerRequest } from './demo-fresh-fixture';
import {
  decodeDemoResetMark,
  encodeDemoResetMark,
  isNewerDemoReset,
  isPlausibleDemoResetMark,
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
 *
 * 2 つ（約 7.6KB）では、実演の流れ（§14.1 の 2〜7 手目: Scope3 → 標準 CSV → 定性 → AI 下書き →
 * レビュー・承認 → KPI）の後半で、前半の取込の数値が押し出されていた（自己監査 第 3 回 F3）。
 * 3 つ（約 11.4KB）にする。ほかの Cookie・ヘッダーを足しても、Node の既定のリクエストヘッダーの
 * 上限（16KB）に収まる。4 つ以上にすると上限に近づくため、容量は編集の縮小（demo-client.ts）で稼ぐ
 */
export const COOKIE_CHUNKS = 3;

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
  const values: string[] = [];
  for (let i = 0; i < COOKIE_CHUNKS; i += 1) values.push(store.get(chunkName(i))?.value ?? '');
  // 1 本の圧縮列を分けて持つ形式（STREAM_MARK）は、順につなげてから戻す。
  // 以前の形式（Cookie ごとに別々に圧縮）はそれぞれを戻す（デプロイをまたいだ Cookie も読めるように）
  const edits = values[0]?.startsWith(STREAM_MARK)
    ? decodeDemoEdits(values.join(''))
    : values.flatMap((raw) => (raw ? decodeDemoEdits(raw) : []));
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
 * 変更をチャンクへ詰める。すべての編集を 1 本に圧縮してから、Cookie 1 つの上限ごとに切り分ける。
 *
 * 以前は編集を Cookie ごとに分けて別々に圧縮していた（空きのあるチャンクへ詰める first-fit）。
 * 同じ UUID・列名が Cookie ごとに辞書へ載り直し、実演の流れでは 1 本で圧縮するより約 3 割大きかった。
 * 1 本にすれば詰め方で空きを残すことも無い。並びは追記の順番（n）で戻す。
 *
 * 返すのは切り分けたチャンクと、入りきらなかった編集（入りきらなければ全部。呼び出し側が古い順に落とす）。
 *
 * dense を指定すると、通常の圧縮で収まらないときに、より強い圧縮（約 5〜6% 小さい・約 10 倍遅い）を
 * 1 回だけ試す。実演の流れの後に CSRD の流れを続けると上限をわずかに超え、前半の確定版・出力を
 * 押し出していた（自己監査 F1）。人の操作 1 回の書き込みにだけ使う（押し出しの繰り返しでは使わない）
 */
export function packIntoChunks(
  edits: readonly DemoEdit[],
  options: { dense?: boolean } = {},
): {
  chunks: string[];
  overflow: DemoEdit[];
} {
  if (edits.length === 0) return { chunks: [], overflow: [] };
  const capacity = COOKIE_CHUNKS * MAX_BYTES_PER_COOKIE;
  let encoded = encodeDemoEditStream([...edits]);
  if (encoded.length > capacity && options.dense) {
    encoded = encodeDemoEditStream([...edits], { dense: true });
  }
  if (encoded.length > capacity) {
    return { chunks: [], overflow: [...edits] };
  }
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += MAX_BYTES_PER_COOKIE) {
    chunks.push(encoded.slice(i, i + MAX_BYTES_PER_COOKIE));
  }
  return { chunks, overflow: [] };
}

/** 1 件で Cookie 1 つ分（MAX_BYTES_PER_COOKIE）を超える編集か（そのような編集は持ち回さない） */
function tooLargeAlone(edit: DemoEdit): boolean {
  return encodeDemoEditStream([edit]).length > MAX_BYTES_PER_COOKIE;
}

/**
 * 押し出しても「古い操作を保持できませんでした」と知らせない場合。
 * 取込の行は 1 回の取込で数百行を追記し、同じ取込の後の行が前の行を押し出す。その取込の結果は
 * 同じリクエストで表示し終えているため、**同じ取込の行どうし**の押し出しだけは知らせない。
 * 取込ジョブ・ファイルの行や、別の操作による取込の行の押し出しは知らせる（別のサーバーでは
 * 取込の履歴・詳細が消えるため。以前は押し出された表だけを見て、原因を問わず黙っていた）
 */
function isQuietEviction(dropped: DemoEdit, cause: DemoEdit): boolean {
  if (dropped.t !== 'ingestionRows' || cause.t !== 'ingestionRows') return false;
  const jobOf = (edit: DemoEdit) => (edit.v as { jobId?: unknown }).jobId;
  return typeof jobOf(dropped) === 'string' && jobOf(dropped) === jobOf(cause);
}

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
 * replace: 前の編集の列と重ねず、この内容だけにする（削除の印。行の中身を持ち回さない）
 */
export async function appendDemoEdit(
  table: TableName,
  id: string,
  changed: Record<string, unknown>,
  options: { replace?: boolean } = {},
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
    v: options.replace ? { ...changed } : { ...(previous?.v ?? {}), ...changed },
    n: sequence,
  };

  // 単体で 1 チャンクに入らない編集は追記を諦める（同一インスタンス内では
  // メモリ上の Fixture に反映済み）。ここで諦めずに縮小ループへ進むと、
  // 「新しい 1 件も入らない → 既存の編集まで全部落ちて空 Cookie を書く」
  // という全消滅になる（レビュー指摘）。既存の持ち回りは守る。
  if (tooLargeAlone(nextEdit)) {
    return;
  }
  merged.push(nextEdit);

  // 全チャンクへ入りきらない分は、古い方から落とす。機能設定（開示優先モードの ON/OFF）は落とさない
  // （落とすと新しいインスタンスでメニューとホームが従来の構成へ戻り、実演の途中で画面が変わる）。
  // 人の操作 1 回の書き込みは、通常の圧縮で収まらなければ強い圧縮も試してから落とす。取込の行は
  // 1 回の取込で数百回書き込むため、遅い圧縮は使わない（取込の行は同じ取込の中で押し出し合う前提）
  const dense = table !== 'ingestionRows';
  let candidate = merged;
  let packed = packIntoChunks(candidate, { dense });
  const noisyTables = new Set<string>();
  while (candidate.length > 0 && packed.overflow.length > 0) {
    const next = dropOldestUnpinned(candidate) ?? candidate.slice(1);
    const dropped = candidate.find((e) => !next.includes(e));
    if (dropped && !isQuietEviction(dropped, nextEdit)) noisyTables.add(dropped.t);
    candidate = next;
    packed = packIntoChunks(candidate, { dense });
  }

  try {
    writeChunks(store, packed.chunks);
    if (isFreshFixturePerRequest()) {
      // 試験用の切替（pnpm test:e2e:stateless）のときだけ、Cookie の容量の推移を記録する。
      // 実演の流れで押し出しが起きないこと・ヘッダーの上限に余裕があることを実測するため
      // （console.log は本番コードで禁止のため、標準エラーへ出す。切替が無効なら何も出さない）
      const sizes = packed.chunks.map((c) => c.length);
      console.warn(
        `[t4d.demo-edits] ${table}:${id} total=${sizes.reduce((a, b) => a + b, 0)}B chunks=${sizes.join('/')} edits=${candidate.length}` +
          (noisyTables.size > 0 ? ` evicted=${[...noisyTables].join(',')}` : ''),
      );
    }
    // 古い操作を押し出したことを画面（デモの帯）で知らせる。別のサーバーでは押し出した操作が
    // 戻らないため、黙っていると「さっきの操作が消えた」ように見える。どの表の操作かを残し、
    // その表をリセットしたら知らせを消す（リセット後も古い注意を出し続けない）
    const noisy = [...noisyTables];
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

/**
 * このインスタンスのリセットの基準時刻を決める（まだなら今）。getDb が Cookie の操作をメモリへ
 * 適用する**前**に呼ぶ。以前は、ログイン後にリセットの印を見たときに初めて基準を決めていたため、
 * ログイン画面などで前のリハーサルの操作を適用した後の時刻が基準になり、その後に別のインスタンスで
 * 行ったリセットを「起動より前のリセット」と見なして反映しなかった
 */
export function ensureDemoResetBaseline(): void {
  appliedResets();
}

/** 反映済みの世代を進める（古い印で巻き戻さない） */
function recordApplied(mark: DemoResetMark): void {
  // 遠い未来を名乗る印を反映済みに記録すると、以後の本物の印をすべて古いと見なしてしまう
  if (!isPlausibleDemoResetMark(mark)) return;
  const applied = appliedResets();
  if (isNewerDemoReset(mark, applied.byOrganization.get(mark.organizationId), applied.baseline)) {
    applied.byOrganization.set(mark.organizationId, mark.epoch);
  }
}

/**
 * リセットを行ったことを Cookie に残す（このインスタンスは既に戻しているので反映済みとする）。
 * 印は最新の 1 件だけなので、前の印が数値データも戻すリセットで、まだ反映していないインスタンスが
 * ありうるときは、その範囲を引き継ぐ（数値データを戻し直しても、その後の操作は Cookie から再び適用される）
 */
export async function markDemoReset(
  organizationId: string,
  options: { includeDataPoints?: boolean } = {},
): Promise<void> {
  let store: CookieStore | null = null;
  try {
    store = await cookies();
  } catch {
    // リクエストスコープ外（テスト・CLI）では Cookie に残さない
  }
  const previous = store ? decodeDemoResetMark(store.get(RESET_COOKIE)?.value) : null;
  const mark: DemoResetMark = {
    organizationId,
    epoch: newDemoResetEpoch(Date.now(), randomUUID()),
    includesDataPoints:
      options.includeDataPoints === true ||
      (previous?.organizationId === organizationId && previous.includesDataPoints === true),
  };
  recordApplied(mark);
  if (!store) return;
  try {
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
    if (!mark || !isPlausibleDemoResetMark(mark)) return null;
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
  // 取り除いた後はふつう必ず入る。1 本に圧縮する形式では、中身によって縮み方がわずかに変わるため、
  // 万一入らなくても全部を捨てて空の Cookie を書かないよう、古い順に落として入れる
  // 強い圧縮で書いた Cookie から取り除いた後も、通常の圧縮だけでは収まらないことがあるため、強い圧縮も試す
  let candidate = remaining;
  let packed = packIntoChunks(candidate, { dense: true });
  while (candidate.length > 0 && packed.overflow.length > 0) {
    candidate = dropOldestUnpinned(candidate) ?? candidate.slice(1);
    packed = packIntoChunks(candidate, { dense: true });
  }
  try {
    writeChunks(store, packed.chunks);
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
