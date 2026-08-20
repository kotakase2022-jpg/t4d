import 'server-only';

import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DisclosureFrameworkVersion,
  FrameworkKey,
  ReportingPeriod,
} from '@/types/domain';

/**
 * 開示対応の「準備段階」を可視化する（CDP / SSBJ 共通）。
 *
 * 一覧画面にいきなり入ると、初めて使う担当者は
 * 「どのバージョンの質問に答えているのか」「過去回答は入っているのか」が分からない。
 * ここでは前段の 2 ステップ（バージョン選択・過去データ取込）の到達状況を集め、
 * 画面がその順序でナビゲートできるようにする。
 */

export interface FrameworkVersionOption {
  id: string;
  year: number;
  label: string;
  status: DisclosureFrameworkVersion['status'];
  /** 質問数（この版で答える対象の数） */
  itemCount: number;
  /** 既定で選ばれる版か（published 優先） */
  isDefault: boolean;
}

export interface ImportedPeriodStatus {
  periodId: string;
  periodLabel: string;
  /** その年度に取り込まれている回答数 */
  responseCount: number;
  /** 承認済みの回答数 */
  approvedCount: number;
}

export interface DisclosureOnboarding {
  frameworkKey: FrameworkKey;
  /** Step 1: 選べるバージョン */
  versions: FrameworkVersionOption[];
  selectedVersionId: string | null;
  /** Step 2: 年度ごとの取込状況（複数年） */
  periods: ImportedPeriodStatus[];
  /** 過去年度（当期以外）に回答が 1 件でもあるか */
  hasPastData: boolean;
  /** Step 3 へ進めるか（バージョンが決まっていること） */
  readyForReview: boolean;
}

export async function loadDisclosureOnboarding(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  currentPeriod: ReportingPeriod,
  periods: ReportingPeriod[],
  selectedVersionId?: string | null,
): Promise<DisclosureOnboarding | null> {
  const organizationId = ctx.workspace.organizationId;

  const frameworks = await db.select('frameworks', { where: { key: frameworkKey }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;

  const versionRows = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  if (versionRows.length === 0) return null;

  const defaultVersion = versionRows.find((v) => v.status === 'published') ?? versionRows[0]!;

  const versions: FrameworkVersionOption[] = await Promise.all(
    versionRows.map(async (v) => {
      const items = await db.select('disclosureItems', { where: { frameworkVersionId: v.id } });
      return {
        id: v.id,
        year: v.year,
        label: v.label,
        status: v.status,
        itemCount: items.length,
        isDefault: v.id === defaultVersion.id,
      };
    }),
  );

  // 年度ごとの取込状況。当期だけでなく過去年度も見せる（複数年の取込が要件）
  const periodStatuses: ImportedPeriodStatus[] = await Promise.all(
    periods.map(async (p) => {
      const responses = await db.select('disclosureResponses', {
        where: { organizationId, reportingPeriodId: p.id },
      });
      return {
        periodId: p.id,
        periodLabel: p.label,
        responseCount: responses.length,
        approvedCount: responses.filter((r) => r.status === 'approved').length,
      };
    }),
  );

  const hasPastData = periodStatuses.some(
    (p) => p.periodId !== currentPeriod.id && p.responseCount > 0,
  );

  const selected =
    (selectedVersionId && versions.find((v) => v.id === selectedVersionId)?.id) ??
    defaultVersion.id;

  return {
    frameworkKey,
    versions,
    selectedVersionId: selected,
    periods: periodStatuses,
    hasPastData,
    readyForReview: Boolean(selected),
  };
}
