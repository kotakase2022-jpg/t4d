import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { removeDemoEditsFor } from '@/lib/repositories/demo-persistence';
import type { DbClient, Row, TableName } from '@/lib/repositories/types';
import type { AiFeatureType, AuthorizationContext } from '@/types/domain';

/**
 * 開示優先モードのデモを初期状態へ戻す（指示書 §14.2「明示したデモ領域だけに作用する」）。
 *
 * 対象は開示優先モードの表（プロジェクト・基準の適用判断・定性情報・引用位置・原稿・レビュー・
 * スナップショット・出力記録・KPI 目標）と、原稿の AI 下書きの実行記録だけ。いまの組織の行に限る。
 *  - デモ中に作られた行（Fixture に無い ID）は物理削除する（DemoDbClient.hardDeleteDemoRows）
 *  - Fixture の行が書き換えられていれば、Fixture の値へ戻す
 *  - Cookie の持ち回り（t4d.demo-edits）からも同じ行だけを取り除く（他の画面のデモ操作は残す）
 *
 * 触らないもの（他の領域）: 数値データ（Data Point と版）・資料（files）・SSBJ の評価・
 * Scope3 の算定・通知・タスク・監査ログ・機能設定（開示優先モードの ON/OFF）。
 * 機能設定を戻さないのは、リセットした瞬間にメニューとホームが従来の構成へ切り替わり、
 * 実演の途中で画面が変わってしまうため。
 *
 * Demo Mode 専用。Supabase Mode では実行を拒否する（追記専用の表を本番で巻き戻さない）。
 */

/** リセットの対象の表（開示優先モードの表。organizationFeatureSettings は意図して含めない） */
export const DISCLOSURE_DEMO_RESET_TABLES = [
  'disclosureProjects',
  'projectFrameworks',
  'projectFrameworkDecisions',
  'narrativeRecords',
  'narrativeVersions',
  'sourceAnchors',
  'disclosureBlocks',
  'disclosureBlockVersions',
  'reviewRequests',
  'reviewEvents',
  'reviewComments',
  'recheckDecisions',
  'reportSnapshots',
  'exportArtifacts',
  'kpiTargets',
] as const satisfies readonly TableName[];

export type DisclosureDemoResetTable = (typeof DISCLOSURE_DEMO_RESET_TABLES)[number];

/** 原稿の AI 下書き（ai_runs の featureType）。ai_runs は共有の表なので、この種類の行だけを消す */
const DISCLOSURE_AI_FEATURE: AiFeatureType = 'disclosureBlockDraft';

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
  options: { pristine?: FixtureDb } = {},
): Promise<DisclosureDemoResetResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
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

  for (const table of DISCLOSURE_DEMO_RESET_TABLES) {
    const fixtureRows = (pristine[table] as unknown as IdRow[]).filter(
      (r) => r.organizationId === organizationId,
    );
    const fixtureById = new Map(fixtureRows.map((r) => [r.id, r]));
    const currentRows = (await db.select(table, {
      where: { organizationId } as never,
    })) as unknown as IdRow[];

    const created = new Set(currentRows.filter((r) => !fixtureById.has(r.id)).map((r) => r.id));
    const touched = new Set<string>([...created, ...fixtureById.keys()]);

    // 先に Cookie の持ち回りから外しておく（戻す途中の追記で Cookie が溢れ、
    // 他の画面のデモ操作が押し出されるのを避ける）
    await removeDemoEditsFor(table, touched);

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
    await removeDemoEditsFor(table, touched);

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

  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'disclosure_demo_reset',
    resourceId: organizationId,
    afterSummary: `開示優先モードのデモデータを初期状態へ戻した（削除 ${removedRows} 行・復元 ${restoredRows} 行）`,
    metadata: { removedRows, restoredRows, byTable },
  });

  return { removedRows, restoredRows, byTable };
}
