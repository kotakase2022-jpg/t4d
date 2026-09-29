import { getDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import { appendDemoEdit, isPersistedTable, removeDemoEditsFor } from './demo-persistence';
import {
  applyQuery,
  matchesQueryFilters,
  type DbClient,
  type Query,
  type Row,
  type TableName,
} from './types';
import type { Uuid } from '@/types/domain';

/**
 * Demo / Fixture Mode の DbClient。
 * インメモリ配列に対して同じ Query 契約を実装する。
 */
/**
 * Cookie へ残す内容を軽くする。
 *
 * **列は落とさない**（落とすと、別インスタンスで復元したときに欠けた列を読む箇所が壊れる。
 * 実際に取込のジョブ画面が内部エラーになった）。
 * 代わりに、読み直しに使わない大きな値だけを空にする。
 *
 * 取込マッピングの出力は行数ぶんの対応表で最も大きいが、
 * プレビューが読むのは ingestionRows のほうで、この出力は使わない。
 * 残しておくと同じ Cookie に載っている取込結果を押し出してしまう。
 *
 * 開示本文の下書き（featureType 'disclosureBlockDraft'）は**そのまま残す**。
 * 候補（outputJson）も、許可リスト・土台の本文ハッシュ・段落ハッシュを持つ inputReferenceIds も、
 * 別インスタンスで候補を検証し直して採用するのに必要で、落とせる大きな列が無い
 * （sourceReferences は outputJson.sources と同じ内容だが、辞書圧縮で重複はほぼ無料）。
 * 実測（2026-09-29）: 根拠 3 件の実行で生 JSON 約 4.4KB → Cookie 上 約 2.2KB、
 * 根拠 9 件で 約 11.7KB → 約 3.5KB。1 件で 1 チャンク（3.8KB）を超えると Cookie に載らず、
 * 実行したインスタンスのメモリにだけ残る（docs/known-limitations.md D-3）。
 */
function persistedColumns(table: TableName, row: unknown): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  if (table === 'disclosureBlocks') return withoutWorkingBody(record);
  if (isDisclosureReviewNotification(table, row)) return { ...record, body: '' };
  if (table !== 'aiRuns' || record.featureType !== 'importMapping') return record;
  return { ...record, outputJson: {} };
}

/**
 * 節の自動保存本文（workingBody）は Cookie へ載せない。
 * 本文 AST は数 KB になり、1 回の自動保存で他のデモ操作（依頼・承認など）を押し出してしまう。
 * 自動保存は業務上の版ではないため、別インスタンスでは「自動保存なし」（現在の版から再開）に戻るだけで済む。
 *
 * 新規行は列を落とさずに空へ揃え（別インスタンスで欠けた列を読むと壊れるため）、
 * 更新は自動保存の 3 列ごと記録から外す（本文だけ消えて保存時刻が残る食い違いを作らない）。
 */
const WORKING_COLUMNS = ['workingBody', 'workingBaseVersionId', 'workingSavedAt'] as const;

/**
 * 開示のレビューの通知（依頼・差戻し・承認の知らせ）。
 *
 * 以前は Cookie へ載せず、別インスタンスでは「レビュー担当へ通知しました」と表示したのに
 * 通知が届いていなかった（ベルの件数も一覧も空）。本文（body）は長く、題名とリンク（href）で
 * 用件が分かるため、本文だけを空にして持ち回す（1 件あたりの容量を抑え、他の操作を押し出さない）
 */
function isDisclosureReviewNotification(table: TableName, row: unknown): boolean {
  if (table !== 'notifications') return false;
  const record = row as { category?: string; href?: string };
  return (
    record.category === 'review' &&
    typeof record.href === 'string' &&
    record.href.startsWith('/enterprise/disclosure-projects/')
  );
}

function withoutWorkingBody(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, workingBody: null, workingBaseVersionId: null, workingSavedAt: null };
}

function persistedPatch(table: TableName, patch: Record<string, unknown>): Record<string, unknown> {
  if (table !== 'disclosureBlocks') return patch;
  const rest = { ...patch };
  for (const column of WORKING_COLUMNS) delete rest[column];
  return rest;
}

export class DemoDbClient implements DbClient {
  readonly mode = 'demo' as const;

  constructor(private readonly db: FixtureDb = getDemoDb()) {}

  private table<K extends TableName>(name: K): Row<K>[] {
    return this.db[name] as unknown as Row<K>[];
  }

  async select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]> {
    return applyQuery(this.table(table) as object[], query as Query<object> | undefined).map((r) =>
      structuredClone(r),
    ) as Row<K>[];
  }

  async count<K extends TableName>(
    table: K,
    query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>,
  ): Promise<number> {
    return (this.table(table) as object[]).filter((r) =>
      matchesQueryFilters(r, query as Query<object> | undefined),
    ).length;
  }

  async findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null> {
    const found = (this.table(table) as unknown as Array<{ id?: string }>).find((r) => r.id === id);
    return found ? (structuredClone(found) as unknown as Row<K>) : null;
  }

  async insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]> {
    const target = this.table(table);
    const cloned = rows.map((r) => structuredClone(r));
    target.push(...cloned);

    // Demo Mode は状態がプロセスのメモリにしか無いため、人の操作だけ Cookie にも残す
    // （インスタンスが変わっても直前の操作が消えないようにする）。
    if (isPersistedTable(table)) {
      for (const row of cloned) {
        const record = row as unknown as { id?: string };
        if (record.id) {
          await appendDemoEdit(table, record.id, persistedColumns(table, row));
        }
      }
    }
    return cloned.map((r) => structuredClone(r));
  }

  async update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    const target = this.table(table) as unknown as Array<Record<string, unknown> & { id?: string }>;
    const index = target.findIndex((r) => r.id === id);
    const existing = target[index];
    if (index === -1 || !existing) throw new Error(`${String(table)} ${id} が見つかりません。`);
    const next = { ...existing, ...(patch as Record<string, unknown>) };
    target[index] = next;

    // 変更のあった列だけを Cookie へ（Cookie の容量を圧迫しないため）
    if (isPersistedTable(table)) {
      const persisted = persistedPatch(table, patch as unknown as Record<string, unknown>);
      if (Object.keys(persisted).length > 0) await appendDemoEdit(table, id, persisted);
    }
    return structuredClone(next) as unknown as Row<K>;
  }

  async softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    await this.update(table, id, { deletedAt: at } as unknown as Partial<Row<K>>);
  }

  /** デモリセット専用: メモリにある行の ID（組織を問わない）。Cookie に残った孤立した編集の判定に使う */
  allRowIds(table: TableName): string[] {
    return (this.table(table) as unknown as Array<{ id?: string }>).flatMap((r) =>
      r.id ? [r.id] : [],
    );
  }

  /**
   * デモリセット専用の物理削除。DbClient の契約（物理削除なし）には載せず、
   * Demo Mode（インメモリ Fixture ＋ demo-edits Cookie）の名前空間だけで完結させる。
   * Supabase 側に同等の操作は無い（追記専用テーブルは本番では巻き戻さない）。
   * 対象は ID を名指しした行のみ。テーブル全消しの経路は作らない。
   */
  async hardDeleteDemoRows<K extends TableName>(
    table: K,
    ids: ReadonlySet<string>,
  ): Promise<number> {
    const target = this.table(table) as unknown as Array<{ id?: string }>;
    const before = target.length;
    for (let i = target.length - 1; i >= 0; i -= 1) {
      const id = target[i]?.id;
      if (id && ids.has(id)) target.splice(i, 1);
    }
    // Cookie の持ち回りからも同じ行だけを取り除く（消した行が別インスタンスで蘇らないように）
    await removeDemoEditsFor(table, ids);
    return before - target.length;
  }
}
