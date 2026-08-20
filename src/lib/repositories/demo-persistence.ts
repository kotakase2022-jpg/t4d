import 'server-only';

import { cookies } from 'next/headers';
import type { FixtureDb } from '@/lib/fixtures/store';
import { decodeDemoEdits, encodeDemoEdits, type DemoEdit } from './demo-edit-codec';
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
/** Cookie の実サイズ上限。ヘッダー全体を圧迫しない範囲に抑える */
const MAX_BYTES = 3800;

/** Cookie に記録する対象テーブル（画面から人が編集するもの） */
const PERSISTED_TABLES = new Set<TableName>([
  // 取込系。1 ファイル数行程度のデモ操作なら Cookie に収まる。
  // 大量ファイルの取込は収まらないため、その場合は同一インスタンス内でのみ参照できる
  // （docs/known-limitations.md D-3 に記載）。
  'ingestionJobs',
  'ingestionJobFiles',
  'ingestionRows',
  'materialityTopics',
  'comments',
  'dataPoints',
  'dataPointVersions',
  'disclosureResponses',
  'metrics',
  'units',
  'notifications',
]);

export function isPersistedTable(table: TableName): boolean {
  return PERSISTED_TABLES.has(table);
}

/** 現在の Cookie に入っている変更を読む */
export async function readDemoEdits(): Promise<DemoEdit[]> {
  // テストやスクリプトなど、リクエストスコープの外から呼ばれることがある。
  // その場合は Cookie が無いだけなので、静かに空で返す。
  try {
    const store = await cookies();
    const raw = store.get(COOKIE_NAME)?.value;
    return raw ? decodeDemoEdits(raw) : [];
  } catch {
    return [];
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

  // 上限を超えたら古い方から落とす
  let candidate = merged;
  while (candidate.length > 0 && encodeDemoEdits(candidate).length > MAX_BYTES) {
    candidate = candidate.slice(1);
  }

  try {
    store.set(COOKIE_NAME, encodeDemoEdits(candidate), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
  } catch {
    // Server Component からは Cookie を書けない。読み取り経路では何もしない。
  }
}

/**
 * Fixture へ変更を再適用する。
 * 対象行が見つからない場合（別インスタンスで作られた新規行など）は無視する。
 */
export function applyDemoEdits(db: FixtureDb, edits: DemoEdit[]): void {
  for (const edit of edits) {
    const rows = db[edit.t as TableName] as unknown as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rows)) continue;
    const row = rows.find((r) => r.id === edit.id);
    if (row) {
      Object.assign(row, edit.v);
    } else if (edit.v && typeof edit.v === 'object' && 'id' in edit.v) {
      // 新規作成された行（コメントなど）は、そのまま足す
      rows.push({ ...edit.v });
    }
  }
}
