import type { FixtureDb } from '@/lib/fixtures/store';
import type { AiFeatureType } from '@/types/domain';
import type { TableName } from './types';

/**
 * 開示デモのリセットを、インスタンスをまたいで反映する（Demo Mode 専用・副作用は引数の FixtureDb だけ）。
 *
 * Demo Mode の状態はインスタンスのメモリにあり、リセットは「リセットを受けたインスタンス」の
 * メモリと Cookie だけを戻していた。ほかのインスタンスはリセット前の状態（レビュー中・承認済みの節、
 * デモ中に作った定性情報）を持ち続け、次のリハーサルでその状態が見えていた。
 * リセットのたびに Cookie へ「リセットの印（組織と世代）」を残し、ほかのインスタンスは
 * 最初のリクエストでこの関数を使って同じ範囲を Fixture の初期値へ戻してから Cookie を適用する。
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

/** 原稿の AI 下書き（ai_runs の featureType）。ai_runs は共有の表なので、この種類の行だけを戻す */
export const DISCLOSURE_AI_FEATURE: AiFeatureType = 'disclosureBlockDraft';

/** 開示の画面を指す通知（依頼・差戻し・再確認の知らせ）。リセットで消えた依頼・節を指し続けないよう戻す */
export function isDisclosureNotification(row: { href?: string | null }): boolean {
  return (row.href ?? '').startsWith('/enterprise/disclosure-projects/');
}

interface OrgRow {
  id: string;
  organizationId?: string;
}

function restoreTable(
  target: OrgRow[],
  pristine: readonly OrgRow[],
  organizationId: string,
  inScope: (row: OrgRow) => boolean = () => true,
): void {
  const fixtureRows = pristine.filter((r) => r.organizationId === organizationId && inScope(r));
  const fixtureIds = new Set(fixtureRows.map((r) => r.id));
  // デモ中に作られた行（Fixture に無い行）を消す
  for (let i = target.length - 1; i >= 0; i -= 1) {
    const row = target[i];
    if (!row || row.organizationId !== organizationId || !inScope(row)) continue;
    if (!fixtureIds.has(row.id)) target.splice(i, 1);
  }
  // Fixture の行を初期値へ戻す（無ければ足す）
  for (const fixtureRow of fixtureRows) {
    const index = target.findIndex((r) => r.id === fixtureRow.id);
    const copy = structuredClone(fixtureRow);
    if (index === -1) target.push(copy);
    else target[index] = copy;
  }
}

/**
 * 組織の開示デモの範囲を Fixture の初期値へ戻す（resetDisclosureDemoData がメモリに対して行うことと同じ）。
 * 数値データ・資料・機能設定などほかの領域には触れない。
 */
export function restoreDisclosureDemoTables(
  target: FixtureDb,
  pristine: FixtureDb,
  organizationId: string,
): void {
  for (const table of DISCLOSURE_DEMO_RESET_TABLES) {
    restoreTable(
      target[table] as unknown as OrgRow[],
      pristine[table] as unknown as OrgRow[],
      organizationId,
    );
  }
  restoreTable(
    target.aiRuns as unknown as OrgRow[],
    pristine.aiRuns as unknown as OrgRow[],
    organizationId,
    (row) => (row as unknown as { featureType?: string }).featureType === DISCLOSURE_AI_FEATURE,
  );
  restoreTable(
    target.notifications as unknown as OrgRow[],
    pristine.notifications as unknown as OrgRow[],
    organizationId,
    (row) => isDisclosureNotification(row as unknown as { href?: string | null }),
  );
}

/** リセットの印（Cookie の値）。組織と世代 */
export interface DemoResetMark {
  organizationId: string;
  epoch: string;
}

export function encodeDemoResetMark(mark: DemoResetMark): string {
  return `${mark.organizationId}:${mark.epoch}`;
}

export function decodeDemoResetMark(raw: string | null | undefined): DemoResetMark | null {
  if (!raw) return null;
  const match = /^([0-9a-f-]{36}):([A-Za-z0-9._-]{1,64})$/i.exec(raw);
  if (!match || !match[1] || !match[2]) return null;
  return { organizationId: match[1], epoch: match[2] };
}
