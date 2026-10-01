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
  // CSRD のダブル・マテリアリティ・評価・計画・開示ドラフト（docs/disclosure-first.md §9.3）。
  // 収集項目の割当（metricAssignments）は数値の収集の領域なので戻さない
  'csrdAnalysisSettings',
  'csrdDmaMatters',
  'csrdDmaIros',
  'csrdAssessments',
  'csrdActionPlans',
  'csrdDisclosureDrafts',
] as const satisfies readonly TableName[];

export type DisclosureDemoResetTable = (typeof DISCLOSURE_DEMO_RESET_TABLES)[number];

/**
 * 「数値データも戻す」を選んだときに戻す表（Data Point と版・承認の道筋・検証結果・標準 CSV の取込）。
 * 承認の記録（approvals）は Data Point を対象にした行だけを戻す（開示回答の承認は別の領域）。
 * 実演の 3 手目（標準 CSV）・8 手目（数値の訂正）の結果が残ると、次のリハーサルの再確認・取込の
 * プレビューが初期状態と変わるため（指示書 §14.2「デモ開始時に初期状態を再現できる」）
 */
export const DATA_DEMO_RESET_TABLES = [
  'dataPoints',
  'dataPointVersions',
  'dataPointApprovalSteps',
  'validations',
  'quantitativeImportBatches',
] as const satisfies readonly TableName[];

/** 数値データのリセットで戻す承認の記録か */
export function isDataPointApproval(row: { targetType?: string | null }): boolean {
  return row.targetType === 'data_point';
}

/** 原稿の AI 下書き（ai_runs の featureType）。ai_runs は共有の表なので、この種類の行だけを戻す */
export const DISCLOSURE_AI_FEATURE: AiFeatureType = 'disclosureBlockDraft';

/**
 * 開示デモのリセットで戻す AI の実行の種類（原稿の下書きと、CSRD のギャップ分析・草案）。
 * 戻した評価・節が指さなくなった CSRD の実行を、実行の一覧に残さない
 */
export const DISCLOSURE_RESET_AI_FEATURES: ReadonlySet<string> = new Set<AiFeatureType>([
  DISCLOSURE_AI_FEATURE,
  'csrdGapAnalysis',
  'csrdDisclosureDraft',
]);

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
  options: { includeDataPoints?: boolean } = {},
): void {
  if (options.includeDataPoints) {
    for (const table of DATA_DEMO_RESET_TABLES) {
      restoreTable(
        target[table] as unknown as OrgRow[],
        pristine[table] as unknown as OrgRow[],
        organizationId,
      );
    }
    restoreTable(
      target.approvals as unknown as OrgRow[],
      pristine.approvals as unknown as OrgRow[],
      organizationId,
      (row) => isDataPointApproval(row as unknown as { targetType?: string }),
    );
  }
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
    (row) =>
      DISCLOSURE_RESET_AI_FEATURES.has(
        (row as unknown as { featureType?: string }).featureType ?? '',
      ),
  );
  restoreTable(
    target.notifications as unknown as OrgRow[],
    pristine.notifications as unknown as OrgRow[],
    organizationId,
    (row) => isDisclosureNotification(row as unknown as { href?: string | null }),
  );
}

/**
 * リセットの印（Cookie の値）。組織と世代。
 * 世代は「リセットした時刻（ミリ秒・13 桁）-乱数」で、時刻の順に並ぶ。
 * 乱数だけの世代では新旧を比べられず、別々にリセットした 2 つのブラウザの印が
 * 同じインスタンスで交互に「未反映」と判定され、リクエストのたびに開示デモを戻し合っていた
 */
export interface DemoResetMark {
  organizationId: string;
  epoch: string;
  /** 数値データ（DATA_DEMO_RESET_TABLES）も戻したリセットか */
  includesDataPoints?: boolean;
}

const EPOCH_PATTERN = /^(\d{13})-([A-Za-z0-9]{1,40})$/;

/** 新しい世代（時刻の順に並ぶ） */
export function newDemoResetEpoch(now: number, random: string): string {
  return `${String(Math.max(0, Math.floor(now))).padStart(13, '0')}-${random.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || '0'}`;
}

/** 世代の時刻。時刻を持たない世代（以前の形式）は null */
export function demoResetEpochTime(epoch: string): number | null {
  const match = EPOCH_PATTERN.exec(epoch);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * 印がこのインスタンスで反映済みの世代より新しいか。
 * 以前の形式（時刻なし）の印は比べられないため反映しない（戻し合いを起こさない）。
 * 反映済みの世代が無いときは、インスタンスの起動時点（baselineEpoch）と比べる。
 * 起動より前のリセットは、起動時のメモリ（Fixture の初期値）に既に含まれている
 */
export function isNewerDemoReset(
  mark: DemoResetMark,
  appliedEpoch: string | undefined,
  baselineEpoch: string,
): boolean {
  if (demoResetEpochTime(mark.epoch) === null) return false;
  const against = appliedEpoch ?? baselineEpoch;
  const markTime = demoResetEpochTime(mark.epoch) ?? 0;
  const againstTime = demoResetEpochTime(against) ?? 0;
  if (markTime !== againstTime) return markTime > againstTime;
  return mark.epoch > against;
}

/** インスタンス間の時計のずれとして許す幅 */
export const DEMO_RESET_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * 印の時刻がありうる範囲か。印は署名の無い Cookie で、遠い未来の時刻を名乗る印を一度でも反映すると、
 * 以後の本物の印（Date.now() の時刻）がすべて「古い」と見なされ、そのインスタンスはリセットを
 * 反映しなくなる。現在時刻より先（時計のずれの幅を超えるもの）は受け付けない
 */
export function isPlausibleDemoResetMark(mark: DemoResetMark, now: number = Date.now()): boolean {
  const time = demoResetEpochTime(mark.epoch);
  return time !== null && time <= now + DEMO_RESET_MAX_FUTURE_MS;
}

/** 数値データも戻したリセットの印の末尾 */
const DATA_SCOPE_SUFFIX = ':data';

export function encodeDemoResetMark(mark: DemoResetMark): string {
  return `${mark.organizationId}:${mark.epoch}${mark.includesDataPoints ? DATA_SCOPE_SUFFIX : ''}`;
}

export function decodeDemoResetMark(raw: string | null | undefined): DemoResetMark | null {
  if (!raw) return null;
  const match = /^([0-9a-f-]{36}):([A-Za-z0-9._-]{1,64}?)(:data)?$/i.exec(raw);
  if (!match || !match[1] || !match[2]) return null;
  return {
    organizationId: match[1],
    epoch: match[2],
    ...(match[3] ? { includesDataPoints: true } : {}),
  };
}
