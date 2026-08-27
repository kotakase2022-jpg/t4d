import { deflateRawSync, inflateRawSync } from 'node:zlib';

import type { FixtureDb } from '@/lib/fixtures/store';
import type { TableName } from './types';

/**
 * Demo Mode の変更差分を Cookie へ収めるための符号化。
 *
 * Cookie は 4KB 程度が上限で、取込 1 行は UUID を 7 個持つ。
 * そのうち jobId・jobFileId・organizationId・reportingPeriodId・aiRunId は
 * 同じジョブの全行で同じ値になる。deflate だけでは 2 倍程度にしか縮まないため、
 * **2 回以上現れる文字列を辞書へ移して参照に置き換えてから** deflate する。
 * 実測で 8〜10 倍になり、20〜30 行の取込結果が 1 つの Cookie に収まる。
 *
 * 副作用が無く Cookie にも依存しないので、この層だけ単体テストできる
 * （`demo-persistence.ts` は `server-only` のため直接はテストできない）。
 */

/** 1 件の変更（upsert）。v は「変更のあった列」だけを持つ */
export interface DemoEdit {
  /** テーブル名 */
  t: string;
  /** 主キー */
  id: string;
  /** 変更後の列（部分） */
  v: Record<string, unknown>;
}

/**
 * 圧縮形式の目印。
 * 旧形式は必ず `JSON.stringify([...])` の base64url なので先頭は 'W' になる。
 * '2' と衝突しないため、この 1 文字で新旧を判別できる。
 */
const VERSION_2 = '2';

/**
 * 辞書参照の目印。制御文字なので実データにはまず現れないが、
 * 万一含まれていても壊れないよう、二重化して退避する。
 */
const REF = String.fromCharCode(1);

/** 辞書に載せる最小長。短い文字列は参照にしても得しない */
const MIN_DICT_LENGTH = 8;

function countStrings(value: unknown, counts: Map<string, number>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_DICT_LENGTH) counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) countStrings(v, counts);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) countStrings(v, counts);
  }
}

function replaceStrings(value: unknown, index: Map<string, number>): unknown {
  if (typeof value === 'string') {
    const ref = index.get(value);
    if (ref !== undefined) return REF + ref;
    // 実データが目印で始まっていたら二重化しておき、復号時に区別できるようにする
    return value.startsWith(REF) ? REF + value : value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, index));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, index)]));
  }
  return value;
}

function restoreStrings(value: unknown, table: string[]): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(REF)) return value;
    if (value.startsWith(REF + REF)) return value.slice(1);
    return table[Number(value.slice(1))] ?? '';
  }
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, table));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, table)]));
  }
  return value;
}

function pack(edits: DemoEdit[]): [string[], unknown] {
  const counts = new Map<string, number>();
  countStrings(edits, counts);
  const table = [...counts.entries()].filter(([, n]) => n >= 2).map(([s]) => s);
  const index = new Map(table.map((s, i) => [s, i]));
  return [table, replaceStrings(edits, index)];
}

function unpack(packed: unknown): unknown {
  if (!Array.isArray(packed) || packed.length !== 2) return packed;
  const [table, body] = packed as [string[], unknown];
  return restoreStrings(body, Array.isArray(table) ? table : []);
}

export function encodeDemoEdits(edits: DemoEdit[]): string {
  return (
    VERSION_2 +
    deflateRawSync(Buffer.from(JSON.stringify(pack(edits)), 'utf8')).toString('base64url')
  );
}

/**
 * 展開後の上限。Cookie は 4KB 弱でも、圧縮を効かせれば展開後は数百 MB になりうる。
 * 偽造 Cookie 1 つでプロセスのメモリを枯渇させられないよう、展開時点で打ち切る。
 * 正規の Cookie は 40KB 程度（取込 45 行）に収まる。
 */
const MAX_INFLATED_BYTES = 512 * 1024;

export function decodeDemoEdits(raw: string): DemoEdit[] {
  try {
    if (raw.startsWith(VERSION_2)) {
      const json = inflateRawSync(Buffer.from(raw.slice(1), 'base64url'), {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString('utf8');
      const parsed = unpack(JSON.parse(json));
      return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
    }
    // 旧形式（無圧縮）の Cookie も読めるようにしておく
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
  } catch {
    // 壊れた Cookie で画面が落ちないよう、空として扱う
    return [];
  }
}

/**
 * Cookie に記録する対象テーブル（画面から人が編集するもの）。
 *
 * この一覧は書き込み時と読み取り時の**両方**で使う。
 * ここに無い表は Cookie 経由で一切触れないので、なりすましや証跡の改ざんに
 * 使える表（organizationMemberships / membershipRoles / auditEvents / signoffs）は
 * 意図的に外している。
 *
 * 逆に、ここへ入れた表は「偽の Cookie で作られた行」が混ざりうる。
 * Demo Mode のデータはすべて架空で、デモアカウントは誰でも使える前提
 * （docs/known-limitations.md D-4）なので、デモとして見せたい操作を優先している。
 */
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
  // 起票した案件・付与した許諾も持ち回す。
  // 入れないと「作った直後に開くと 404」になる（本番スモークで再現した）。
  'engagements',
  'engagementMembers',
  'grants',
  // AI の実行結果。?run=<id> で読み直す画面が多く、
  // 持ち回さないと「実行したのに何も出ない」になる。
  'aiRuns',
  // SSBJ の設定と開示ドラフト。どちらも「操作した直後に結果を見せる」画面なので、
  // 持ち回さないと本番 Demo Mode で操作が消えたように見える（本番スモークで再現した）。
  //
  // ssbjAssessments は**入れない**。要求事項 133 件の評価行を初回表示で一括作成するため、
  // Cookie の容量を使い切って他の操作（コメント・値編集）を押し出してしまう。
  'ssbjAnalysisSettings',
  'ssbjDisclosureDrafts',
  // 承認の道筋。段階を承認した結果が消えると、進み具合が巻き戻って見える。
  // 1 回の提出で作るのは 5 行なので容量に収まる
  'dataPointApprovalSteps',
]);

export function isPersistedTable(table: TableName): boolean {
  return PERSISTED_TABLES.has(table);
}

/**
 * Fixture へ変更を再適用する。
 * 対象行が見つからない場合（別インスタンスで作られた新規行など）は無視する。
 *
 * **Cookie の中身は信用しない。** httpOnly は JavaScript から読めなくするだけで、
 * 攻撃者が自分で Cookie ヘッダーを組み立てて送るのは防げない。
 * Fixture DB はプロセス全体で共有されるため、検証せずに適用すると
 * 「1 リクエストで全利用者のデータを書き換える」ことができてしまう。
 *
 * そこで、書き込み時と**同じ許可リスト**をここでも通す。
 * これにより organizationMemberships（ロール注入）・membershipRoles・auditEvents・signoffs
 * といった、なりすましや証跡の改ざんに使える表には一切届かない。
 */
export function applyDemoEdits(db: FixtureDb, edits: DemoEdit[]): void {
  for (const edit of edits) {
    // 書き込み側の許可リスト（isPersistedTable）と対にする。
    // 片側だけの防御は、Cookie を偽造されると意味を持たない。
    if (!isPersistedTable(edit.t as TableName)) continue;
    const rows = db[edit.t as TableName] as unknown as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rows)) continue;
    if (!edit.v || typeof edit.v !== 'object' || Array.isArray(edit.v)) continue;
    const row = rows.find((r) => r.id === edit.id);
    if (row) {
      Object.assign(row, edit.v);
    } else if ('id' in edit.v) {
      // 新規作成された行（コメントなど）は、そのまま足す
      rows.push({ ...edit.v });
    }
  }
}
