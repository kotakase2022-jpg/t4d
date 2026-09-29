import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  clearDemoEviction,
  markDemoReset,
  removeDemoEditsWhere,
} from '@/lib/repositories/demo-persistence';
import type { DemoEdit } from '@/lib/repositories/demo-edit-codec';
import {
  DATA_DEMO_RESET_TABLES,
  DISCLOSURE_AI_FEATURE,
  DISCLOSURE_DEMO_RESET_TABLES,
  isDataPointApproval,
  isDisclosureNotification,
} from '@/lib/repositories/demo-reset-sync';
import type { DbClient, Row, TableName } from '@/lib/repositories/types';

type ResetTable =
  | (typeof DISCLOSURE_DEMO_RESET_TABLES)[number]
  | (typeof DATA_DEMO_RESET_TABLES)[number]
  | Extract<TableName, 'approvals'>;
import type { AuthorizationContext } from '@/types/domain';

/**
 * 開示優先モードのデモを初期状態へ戻す（指示書 §14.2「明示したデモ領域だけに作用する」）。
 *
 * 対象は開示優先モードの表（プロジェクト・基準の適用判断・定性情報・引用位置・原稿・レビュー・
 * スナップショット・出力記録・KPI 目標）と、原稿の AI 下書きの実行記録だけ。いまの組織の行に限る。
 *  - デモ中に作られた行（Fixture に無い ID）は物理削除する（DemoDbClient.hardDeleteDemoRows）
 *  - Fixture の行が書き換えられていれば、Fixture の値へ戻す
 *  - Cookie の持ち回り（t4d.demo-edits）からも同じ行だけを取り除く（他の画面のデモ操作は残す）
 *
 * 通知は、開示の画面（依頼・差戻し・再確認）を指すデモ中の通知だけを消す（消えた依頼・節を指し続けないため）。
 * 「数値データも戻す」を選んだときだけ、数値データ（Data Point と版・Data Point の承認の記録・承認の道筋・
 * 検証結果・標準 CSV の取込）も同じ方法で戻す（実演の 3 手目・8 手目を次のリハーサルへ持ち越さない）。
 * 既定で触らないもの（他の領域）: 数値データ（Data Point と版）・資料（files）・SSBJ の評価・
 * Scope3 の算定・そのほかの通知・タスク・監査ログ・機能設定（開示優先モードの ON/OFF）。
 * 機能設定を戻さないのは、リセットした瞬間にメニューとホームが従来の構成へ切り替わり、
 * 実演の途中で画面が変わってしまうため。
 *
 * Demo Mode 専用。Supabase Mode では実行を拒否する（追記専用の表を本番で巻き戻さない）。
 */

// 対象の表の一覧は、別インスタンスへの反映（demo-reset-sync.ts）と同じものを使う
export { DISCLOSURE_DEMO_RESET_TABLES };
export type { DisclosureDemoResetTable } from '@/lib/repositories/demo-reset-sync';

export interface DisclosureDemoResetResult {
  /** デモ中に作られて削除した行 */
  removedRows: number;
  /** Fixture の値へ戻した行 */
  restoredRows: number;
  byTable: Record<string, { removed: number; restored: number }>;
}

interface IdRow {
  id: string;
  organizationId?: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Fixture の行と違う列だけを取り出す（違いが無ければ空） */
function diffToFixture(current: Record<string, unknown>, fixture: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(fixture)) {
    if (!sameValue(current[key], fixture[key])) patch[key] = fixture[key];
  }
  return patch;
}

export async function resetDisclosureDemoData(
  db: DbClient,
  ctx: AuthorizationContext,
  options: {
    pristine?: FixtureDb;
    /**
     * 数値データ（Data Point と版・承認の道筋・検証結果・標準 CSV の取込）も戻すか。
     * 実演の 3 手目（標準 CSV）・8 手目（数値の訂正）を次のリハーサルへ持ち越さないために選ぶ
     */
    includeDataPoints?: boolean;
  } = {},
): Promise<DisclosureDemoResetResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  // 数値データまで戻すのは、数値の入力権限もある人だけ（開示の担当だけでは数値を書き換えられない）
  if (options.includeDataPoints) assertCan(ctx, 'enterprise.data.write');
  if (!(db instanceof DemoDbClient)) {
    throw new ValidationError(
      'デモリセットは Demo Mode 専用です。実運用データベースでは実行できません。',
    );
  }

  const organizationId = ctx.workspace.organizationId;
  // Fixture は決定論的に作られる（ID・日時とも基準日から決まる）ため、作り直した値が初期状態になる
  const pristine = options.pristine ?? createFixtureDb();
  const byTable: DisclosureDemoResetResult['byTable'] = {};
  let removedRows = 0;
  let restoredRows = 0;

  const tables: ReadonlyArray<ResetTable> = options.includeDataPoints
    ? [...DATA_DEMO_RESET_TABLES, 'approvals', ...DISCLOSURE_DEMO_RESET_TABLES]
    : DISCLOSURE_DEMO_RESET_TABLES;
  for (const table of tables) {
    // 承認の記録は Data Point の承認だけを戻す（開示回答の承認は別の領域）
    const inScope = (row: IdRow) =>
      table !== 'approvals' || isDataPointApproval(row as { targetType?: string });
    const fixtureRows = (pristine[table] as unknown as IdRow[]).filter(
      (r) => r.organizationId === organizationId && inScope(r),
    );
    const fixtureById = new Map(fixtureRows.map((r) => [r.id, r]));
    const currentRows = (
      (await db.select(table, {
        where: { organizationId } as never,
      })) as unknown as IdRow[]
    ).filter(inScope);

    const created = new Set(currentRows.filter((r) => !fixtureById.has(r.id)).map((r) => r.id));
    const touched = new Set<string>([...created, ...fixtureById.keys()]);
    // このインスタンスのメモリにある行（どの組織の行でも）と、Fixture にある行（どの組織の行でも）
    const inMemory = new Set(db.allRowIds(table));
    const inPristine = new Set((pristine[table] as unknown as IdRow[]).map((r) => r.id));
    /**
     * Cookie から取り除く編集。メモリの行（touched）に加えて、この組織の名義の編集と、
     * どこにも行が無い部分更新（このインスタンスが規則に合わず受け付けなかった編集の残り）も取り除く。
     * 残すと、リセット後も毎回検査されては捨てられ、Cookie の容量だけを使い続ける
     */
    const shouldRemove = (edit: DemoEdit): boolean => {
      if (edit.t !== table) return false;
      if (touched.has(edit.id)) return true;
      const owner = (edit.v as { organizationId?: unknown }).organizationId;
      if (owner === organizationId) return true;
      return owner === undefined && !inMemory.has(edit.id) && !inPristine.has(edit.id);
    };

    // 先に Cookie の持ち回りから外しておく（戻す途中の追記で Cookie が溢れ、
    // 他の画面のデモ操作が押し出されるのを避ける）
    await removeDemoEditsWhere(shouldRemove);

    const removed = created.size > 0 ? await db.hardDeleteDemoRows(table, created) : 0;

    let restored = 0;
    const currentById = new Map(currentRows.map((r) => [r.id, r]));
    for (const fixtureRow of fixtureRows) {
      const current = currentById.get(fixtureRow.id);
      if (!current) {
        await db.insert(table, [structuredClone(fixtureRow) as unknown as Row<typeof table>]);
        restored += 1;
        continue;
      }
      const patch = diffToFixture(
        current as unknown as Record<string, unknown>,
        fixtureRow as unknown as Record<string, unknown>,
      );
      if (Object.keys(patch).length === 0) continue;
      await db.update(table, fixtureRow.id, structuredClone(patch) as Partial<Row<typeof table>>);
      restored += 1;
    }

    // 戻した行の追記（update / insert が Cookie へ書いた分）も取り除く。
    // Fixture と同じ値なので持ち回る必要がない
    await removeDemoEditsWhere(shouldRemove);

    byTable[table] = { removed, restored };
    removedRows += removed;
    restoredRows += restored;
  }

  // 原稿の AI 下書き（デモ中の実行分）。Fixture の実行記録は残す
  const fixtureAiRunIds = new Set(pristine.aiRuns.map((r) => r.id));
  const aiRuns = await db.select('aiRuns', { where: { organizationId } });
  const demoAiRuns = new Set(
    aiRuns
      .filter((r) => r.featureType === DISCLOSURE_AI_FEATURE && !fixtureAiRunIds.has(r.id))
      .map((r) => r.id),
  );
  const removedAiRuns = demoAiRuns.size > 0 ? await db.hardDeleteDemoRows('aiRuns', demoAiRuns) : 0;
  byTable.aiRuns = { removed: removedAiRuns, restored: 0 };
  removedRows += removedAiRuns;

  // デモ中に届いた開示の通知（消した依頼・節を指すもの）。Fixture の通知は残す
  const fixtureNotificationIds = new Set(pristine.notifications.map((n) => n.id));
  const notifications = await db.select('notifications', { where: { organizationId } });
  const demoNotifications = new Set(
    notifications
      .filter((n) => isDisclosureNotification(n) && !fixtureNotificationIds.has(n.id))
      .map((n) => n.id),
  );
  const removedNotifications =
    demoNotifications.size > 0
      ? await db.hardDeleteDemoRows('notifications', demoNotifications)
      : 0;
  byTable.notifications = { removed: removedNotifications, restored: 0 };
  removedRows += removedNotifications;

  // ほかのインスタンスにも同じリセットを反映させる（次のリクエストで Fixture の初期値へ戻す）
  await markDemoReset(organizationId, { includeDataPoints: options.includeDataPoints === true });
  // 戻した表の押し出しの知らせは、戻した今は意味を失う（ほかの表の押し出しの知らせは残す）
  await clearDemoEviction(tables);

  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'disclosure_demo_reset',
    resourceId: organizationId,
    afterSummary: `開示優先モードのデモデータを初期状態へ戻した（削除 ${removedRows} 行・復元 ${restoredRows} 行）`,
    metadata: { removedRows, restoredRows, byTable },
  });

  return { removedRows, restoredRows, byTable };
}
