import 'server-only';

import { isCountedInTotals } from '@/lib/domain/boundaries';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  ClientAccessGrant,
  DataPoint,
  Engagement,
  GrantSubjectType,
  IsoDateTime,
  Uuid,
} from '@/types/domain';

/**
 * Data Room を許諾と承認に同期する（トライアル対応 NF-22。読み取り時に導出し、書き込まない）。
 *
 * これまで Data Room の行は data_room_items（共有の操作で作る行）だけから作っていたため、許諾を足しても
 * 承認しても保証側に出なかった。ここでは **許諾（指標×組織×期間）と企業側の承認済み Data Point** から
 * 導出する。条件は DB 関数 t4d.assurance_can_read_data_point（0011）と同じ（承認済み・削除されていない・
 * 指標／組織／期間のすべてに取り消されていない許諾がある・案件のクライアントのデータ）に、
 * 内部取引の明細行を除く（isCountedInTotals。連結時の控除額であり、母集団に入れると二重計上になる）を足す。
 *
 * 共有日時は「3 つの許諾のうち最後に付与した日時」と「承認日時」の遅い方。
 * data_room_items は取り下げの記録と開示レポートの写し（NF-20）のために使い続ける。
 *
 * 認可は呼び出し側（assertEngagementMember など）で確かめる。ここは案件の ID から読むだけ
 * （同じ関数を企業側の設定「アクセス許諾」の件数にも使うため）。
 */

export interface SharedDataPoint {
  dataPoint: DataPoint;
  /** 許諾日時（3 つの許諾の最後）と承認日時の遅い方 */
  sharedAt: IsoDateTime;
  /** 指標の許諾が Evidence を含むか（DB の t4d.assurance_can_read_file_version と同じく指標の許諾で決まる） */
  includesEvidence: boolean;
  /** 根拠となった許諾（指標・組織・期間の順） */
  grantIds: [Uuid, Uuid, Uuid];
}

function laterOf(a: IsoDateTime, b: IsoDateTime | null): IsoDateTime {
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * 純粋関数の本体（テストと Supabase Mode の結果の比較に使う）。grants は取り消されていないものを渡すこと
 * （取り消し済みが混ざっていても除く）
 */
export function deriveSharedDataPoints(
  engagement: Pick<Engagement, 'id' | 'clientOrganizationId'>,
  grants: readonly ClientAccessGrant[],
  dataPoints: readonly DataPoint[],
): SharedDataPoint[] {
  const active = grants.filter((g) => g.engagementId === engagement.id && g.revokedAt === null);
  const bySubject = new Map<GrantSubjectType, Map<Uuid, ClientAccessGrant>>();
  for (const g of active) {
    const map = bySubject.get(g.subjectType) ?? new Map<Uuid, ClientAccessGrant>();
    // 同じ対象に複数の許諾があれば、最初に付与したものを根拠にする（共有日時を早い方に寄せる）
    const prev = map.get(g.subjectId);
    if (!prev || g.grantedAt < prev.grantedAt) map.set(g.subjectId, g);
    bySubject.set(g.subjectType, map);
  }
  const grantOf = (subject: GrantSubjectType, id: Uuid) => bySubject.get(subject)?.get(id) ?? null;

  const out: SharedDataPoint[] = [];
  for (const dp of dataPoints) {
    if (dp.organizationId !== engagement.clientOrganizationId) continue;
    if (dp.status !== 'approved' || dp.deletedAt !== null) continue;
    if (!isCountedInTotals(dp)) continue;
    const metricGrant = grantOf('metric', dp.metricId);
    const unitGrant = grantOf('organization_unit', dp.unitId);
    const periodGrant = grantOf('reporting_period', dp.reportingPeriodId);
    if (!metricGrant || !unitGrant || !periodGrant) continue;
    const grantedAt = [metricGrant, unitGrant, periodGrant]
      .map((g) => g.grantedAt)
      .reduce((a, b) => (a >= b ? a : b));
    out.push({
      dataPoint: dp,
      sharedAt: laterOf(grantedAt, dp.approvedAt),
      includesEvidence: metricGrant.includesEvidence,
      grantIds: [metricGrant.id, unitGrant.id, periodGrant.id],
    });
  }
  return out.sort(
    (a, b) =>
      (a.sharedAt < b.sharedAt ? -1 : a.sharedAt > b.sharedAt ? 1 : 0) ||
      (a.dataPoint.id < b.dataPoint.id ? -1 : 1),
  );
}

/** 案件で保証側へ共有中の承認済み Data Point（読み取り時に導出） */
export async function listSharedDataPoints(
  db: DbClient,
  engagementId: Uuid,
): Promise<SharedDataPoint[]> {
  const engagement = isUuid(engagementId) ? await db.findById('engagements', engagementId) : null;
  if (!engagement) return [];
  const grants = await db.select('grants', {
    where: { engagementId: engagement.id, revokedAt: { isNull: true } },
  });
  const ids = (subject: GrantSubjectType) =>
    grants.filter((g) => g.subjectType === subject).map((g) => g.subjectId);
  const metricIds = ids('metric');
  const unitIds = ids('organization_unit');
  const periodIds = ids('reporting_period');
  if (metricIds.length === 0 || unitIds.length === 0 || periodIds.length === 0) return [];
  const dataPoints = await db.select('dataPoints', {
    where: {
      organizationId: engagement.clientOrganizationId,
      status: 'approved',
      deletedAt: { isNull: true },
      metricId: { in: metricIds },
      unitId: { in: unitIds },
      reportingPeriodId: { in: periodIds },
    },
  });
  return deriveSharedDataPoints(engagement, grants, dataPoints);
}

/**
 * Data Room に出す Data Point（許諾×承認の導出から、企業が明示的に取り下げた Data Point を除いたもの）。
 * data_room_items の **取り下げの記録** を守る: 取り下げた行だけがあり有効な行が無い Data Point は出さない。
 * Data Room の表示・Snapshot の固定・資料依頼の対象・保証側の資料の閲覧（storage の canReadEvidence）が
 * 同じこの関数を使う（assurance.ts から再公開）。認可は呼び出し側
 */
export async function listDataRoomDataPoints(
  db: DbClient,
  engagementId: Uuid,
): Promise<SharedDataPoint[]> {
  const [shared, items] = await Promise.all([
    listSharedDataPoints(db, engagementId),
    db.select('dataRoomItems', { where: { engagementId, sourceType: 'data_point' } }),
  ]);
  const active = new Set(items.filter((i) => i.withdrawnAt === null).map((i) => i.sourceId));
  const withdrawn = new Set(
    items.filter((i) => i.withdrawnAt !== null && !active.has(i.sourceId)).map((i) => i.sourceId),
  );
  return shared.filter((row) => !withdrawn.has(row.dataPoint.id));
}

/** 「前回表示以降に共有された n 件」の絞込（since は ISO 日時。null・不正なら全件） */
export function sharedSince(
  rows: readonly SharedDataPoint[],
  since: string | null | undefined,
): SharedDataPoint[] {
  if (!since || Number.isNaN(Date.parse(since))) return [...rows];
  const t = Date.parse(since);
  return rows.filter((r) => Date.parse(r.sharedAt) > t);
}
