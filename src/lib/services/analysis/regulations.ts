import 'server-only';

import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import { isCsrdInScope } from '@/lib/domain/csrd';
import {
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  MATERIALITY_BASIS_LABELS,
  frameworkLegalLabel,
} from '@/lib/domain/disclosure-status';
import { combineCoverage } from '@/lib/domain/ssbj';
import { loadCsrdRequirementViews } from '@/lib/services/csrd/requirements';
import { hasOption, OPTION_NOT_CONTRACTED_MESSAGES } from '@/lib/services/organization-options';
import type { DbClient } from '@/lib/repositories/types';
import {
  SSBJ_COVERAGE_STATUSES,
  type AuthorizationContext,
  type DisclosureFrameworkVersion,
  type DisclosureItem,
  type FrameworkKey,
  type IsoDate,
  type ReportingPeriod,
  type SsbjCoverageStatus,
  type Uuid,
} from '@/types/domain';

/**
 * 各規制への対応度（docs/disclosure-first.md §9.6）。閲覧専用（書かない）。
 *
 * 守っていること:
 *  - 重み付きの「対応度%」・「準拠率」・単一の総合点を出さない。件数と分母だけを返す
 *  - 人が確認済みの件数と、AI 判定のみ（人が未確認）の件数を分ける
 *  - 要求事項・評価項目が未収録の基準は 0% と出さず、算定しない理由を返す
 *  - SSBJ は ssbj_assessments を読むだけ（loadSsbjOverview / loadSsbjRequirementViews は表示時に
 *    評価行を作るため使わない）。行が無い要求事項は既定（適用・未評価・未確認）として数える
 *  - CSRD は Stage A の loadCsrdRequirementViews だけを使う（DMA から毎回導出した適用）
 *  - 回答は基準ごとの回答だけを数える（cdpReadiness は CDP と CSRD を混ぜ、下書きを準備済みと
 *    数えるため使わない）
 */

/** 行の順（§9.6） */
export const REGULATION_ORDER = ['ssbj', 'csrd', 'esrs_40a', 'cdp', 'msci', 'ftse'] as const;
export type RegulationKey = (typeof REGULATION_ORDER)[number];

/** 画面に出す基準の短い名前 */
export const REGULATION_NAME: Record<RegulationKey, string> = {
  ssbj: 'SSBJ',
  csrd: 'CSRD（ESRS）',
  esrs_40a: 'ESRS-40a',
  cdp: 'CDP',
  msci: 'MSCI',
  ftse: 'FTSE',
};

export type RegulationPositioningKind = 'published' | 'draft_prep' | 'sample' | 'planned' | 'other';

export interface RegulationLink {
  label: string;
  href: string;
}

export interface CoverageBreakdown {
  /** 評価対象のうち、3 観点をまとめた状況（最も遅れている観点）ごとの件数 */
  counts: Record<SsbjCoverageStatus, number>;
  /** 人が確認（確定）済み */
  humanConfirmed: number;
  /** AI の判定だけがあり、人が未確認 */
  aiOnly: number;
}

export interface RegulationRow {
  key: RegulationKey;
  name: string;
  /** DB に登録された基準の名前（未登録は null） */
  frameworkName: string | null;
  versionLabel: string | null;
  positioning: { kind: RegulationPositioningKind; label: string };
  materialityLabel: string;
  coverage: { label: string; itemCount: number | null; note: string | null };
  /** 評価対象 n / 分母。算定しない基準は null */
  inScope: {
    count: number;
    denominator: number;
    /** 分母の説明（何を数えた分母か） */
    denominatorLabel: string;
    /** 評価対象のうち暫定（CSRD: DMA 確定前）の件数。該当しない基準は null */
    provisional: number | null;
  } | null;
  breakdown: CoverageBreakdown | null;
  /** 内訳を出さない理由（CDP: 3 観点の評価を持たない） */
  breakdownNote: string | null;
  /** 回答の承認 n / 全項目（CDP・CSRD）。回答を持たない基準は null */
  responses: { approved: number; total: number } | null;
  /**
   * 回答が必要な要求事項の承認 n / 件数（CSRD: 評価対象＝常に適用・重要と判断した事項だけ。
   * 重要でないと判断した要求事項は回答を求めない）。現状診断の「未承認の回答」はこちらで数える。
   * 表示は全項目の n / 件数（responses）のまま。区別が無い基準は null（responses と同じ）
   */
  responsesRequired: { approved: number; total: number } | null;
  responsesNote: string | null;
  /** 算定しない理由（0% と出さない） */
  notCalculatedReason: string | null;
  notes: string[];
  links: RegulationLink[];
}

export interface RegulatoryCoverage {
  period: ReportingPeriod;
  referenceDate: IsoDate;
  rows: RegulationRow[];
}

const PLANNED_LABEL = '今後対応予定';

/** CDP 対応オプションが無い組織の CDP の行（算定しない理由） */
export const CDP_OPTION_NOT_CONTRACTED_REASON = 'オプション未契約のため算定しない';

/** 改正 ESRS は未収録（CSRD の行に必ず添える） */
export const CSRD_REVISED_ESRS_NOTE = '改正 ESRS（2026-07-03 採択・未発効）は未収録';

/** 内訳の数え方の違い（SSBJ は AI の判定が 3 観点に入る、CSRD は人の値だけ） */
export const SSBJ_BREAKDOWN_AI_NOTE =
  '内訳には、担当者が未確認の AI 判定（「AI 判定のみ」の件数）も含みます（SSBJ の対応状況画面と同じ扱い）。SSBJ の対応状況画面の「未対応」は未確認を含みますが、ここでは未対応と未確認を分けて数えます。';
export const CSRD_BREAKDOWN_NOTE =
  '内訳は人が入力・確定した値だけで数えます（AI の候補だけの要求事項は「未確認」に入ります）。';

const NOT_CALCULATED_REASON: Record<RegulationKey, string> = {
  ssbj: '要求事項が未収録のため算定しない',
  csrd: '要求事項が未収録のため算定しない',
  esrs_40a: '要求事項が未収録（公開草案）のため算定しない',
  cdp: '質問が未収録のため算定しない',
  msci: '評価項目マスター未収録のため算定しない',
  ftse: '評価項目マスター未収録のため算定しない',
};

const LINKS: Record<RegulationKey, RegulationLink[]> = {
  ssbj: [
    {
      label: '未対応・未確認の要求事項',
      href: '/enterprise/disclosures/ssbj/requirements?scope=in_scope&coverage=not_covered&coverage=unconfirmed',
    },
    { label: 'SSBJ 対応状況', href: '/enterprise/disclosures/ssbj' },
  ],
  csrd: [
    {
      label: 'AI 判定の確認待ち',
      href: '/enterprise/disclosures/csrd/requirements?review=awaiting',
    },
    {
      label: '未対応・未確認の要求事項',
      href: '/enterprise/disclosures/csrd/requirements?applicability=always&applicability=material&coverage=not_covered&coverage=unconfirmed',
    },
    { label: 'CSRD 対応状況', href: '/enterprise/disclosures/csrd' },
  ],
  esrs_40a: [{ label: '開示プロジェクト（準備）', href: '/enterprise/disclosure-projects' }],
  cdp: [{ label: 'CDP の回答', href: '/enterprise/disclosures/cdp' }],
  msci: [{ label: 'MSCI 対応の実装状況', href: '/enterprise/disclosures/msci' }],
  ftse: [{ label: 'FTSE 対応の実装状況', href: '/enterprise/disclosures/ftse' }],
};

function emptyCounts(): Record<SsbjCoverageStatus, number> {
  return Object.fromEntries(SSBJ_COVERAGE_STATUSES.map((s) => [s, 0])) as Record<
    SsbjCoverageStatus,
    number
  >;
}

function positioningOf(version: DisclosureFrameworkVersion | null): RegulationRow['positioning'] {
  if (!version) return { kind: 'planned', label: PLANNED_LABEL };
  const label = frameworkLegalLabel(version);
  if (label === 'サンプル（架空）') return { kind: 'sample', label };
  if (version.legalStatus === 'draft') return { kind: 'draft_prep', label };
  if (version.legalStatus === 'promulgated' || version.legalStatus === 'effective') {
    return { kind: 'published', label };
  }
  return { kind: 'other', label };
}

interface Master {
  frameworkName: string;
  version: DisclosureFrameworkVersion;
  items: DisclosureItem[];
}

/** 基準の現行版（公開版、無ければ最新）と要求事項。基準・版が無ければ null（今後対応予定） */
async function loadMaster(db: DbClient, key: FrameworkKey): Promise<Master | null> {
  const frameworks = await db.select('frameworks', { where: { key }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const version = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!version) return null;
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: version.id },
    orderBy: { column: 'sortOrder' },
  });
  return { frameworkName: framework.name, version, items };
}

function baseRow(key: RegulationKey, master: Master | null): RegulationRow {
  const version = master?.version ?? null;
  const itemCount = master ? master.items.length : null;
  return {
    key,
    name: REGULATION_NAME[key],
    frameworkName: master?.frameworkName ?? null,
    versionLabel: version?.label ?? null,
    positioning: positioningOf(version),
    materialityLabel: version?.materialityBasis
      ? MATERIALITY_BASIS_LABELS[version.materialityBasis]
      : '未登録',
    coverage: {
      label: !master
        ? 'マスター未収録'
        : version?.coverageStatus
          ? FRAMEWORK_COVERAGE_STATUS_LABELS[version.coverageStatus]
          : '収録状況未登録',
      itemCount,
      note: version?.coverageNote ?? null,
    },
    inScope: null,
    breakdown: null,
    breakdownNote: null,
    responses: null,
    responsesRequired: null,
    responsesNote: null,
    notCalculatedReason: itemCount ? null : NOT_CALCULATED_REASON[key],
    notes: [],
    links: LINKS[key],
  };
}

/** 回答の承認 n / 全項目（その基準の要求事項の回答だけを数える。下書き・レビュー中は数えない） */
async function approvedResponses(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  items: readonly DisclosureItem[],
): Promise<{ approved: number; total: number }> {
  if (items.length === 0) return { approved: 0, total: 0 };
  const itemIds = new Set(items.map((i) => i.id));
  const responses = await db.select('disclosureResponses', {
    where: {
      organizationId: ctx.workspace.organizationId,
      reportingPeriodId: period.id,
      itemId: { in: [...itemIds] },
    },
  });
  const approvedItems = new Set(
    responses.filter((r) => itemIds.has(r.itemId) && r.status === 'approved').map((r) => r.itemId),
  );
  return { approved: approvedItems.size, total: items.length };
}

/**
 * SSBJ の「①分析条件」で選んだ基準から、評価対象の節を決める（ssbj-gap.ts の loadSsbjItems と同じ規則）。
 * 未設定なら絞り込まない（SSBJ の要求事項画面と件数をそろえる）
 */
async function ssbjSectionPrefixes(
  db: DbClient,
  organizationId: Uuid,
  periodId: Uuid,
): Promise<string[] | null> {
  const rows = await db.select('ssbjAnalysisSettings', {
    where: { organizationId, reportingPeriodId: periodId },
    limit: 1,
  });
  const settings = rows[0];
  if (!settings) return null;
  const prefixes: string[] = [];
  if (settings.applyGeneral) prefixes.push('一般');
  if (settings.applyClimate) prefixes.push('気候');
  if (settings.applyPractical) prefixes.push('実務対応');
  return prefixes.length > 0 ? prefixes : null;
}

async function ssbjRow(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<RegulationRow> {
  const master = await loadMaster(db, 'ssbj');
  const row = baseRow('ssbj', master);
  row.responsesNote =
    'SSBJ は要求事項ごとの回答を持ちません（本文は節ごとの開示ドラフトで作成します）。';
  if (!master || master.items.length === 0) return row;

  const organizationId = ctx.workspace.organizationId;
  const prefixes = await ssbjSectionPrefixes(db, organizationId, period.id);
  const items = prefixes
    ? master.items.filter((item) => prefixes.some((p) => item.section.startsWith(p)))
    : master.items;
  const assessments = await db.select('ssbjAssessments', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const byItem = new Map(assessments.map((a) => [a.itemId, a]));

  const breakdown: CoverageBreakdown = { counts: emptyCounts(), humanConfirmed: 0, aiOnly: 0 };
  let inScope = 0;
  for (const item of items) {
    // 行が無い要求事項は、SSBJ の画面が作る既定（適用・未評価・3 観点とも未確認）と同じに数える
    const a = byItem.get(item.id);
    const applicable = (a?.applicability ?? 'applicable') === 'applicable';
    const notMaterial = a?.materiality === 'not_material';
    if (!applicable || notMaterial) continue;
    inScope += 1;
    const combined = a
      ? combineCoverage(a.disclosureStatus, a.dataStatus, a.processStatus)
      : 'unconfirmed';
    breakdown.counts[combined] += 1;
    // 人の確認は最終判定（finalStatus）の有無で決める（SSBJ の画面の「確認待ち」と同じ規則）
    if (a && a.finalStatus !== null) breakdown.humanConfirmed += 1;
    else if (a && a.aiStatus !== null) breakdown.aiOnly += 1;
  }
  row.inScope = {
    count: inScope,
    denominator: items.length,
    denominatorLabel: prefixes
      ? `分析条件で適用する基準（${prefixes.join('・')}）の要求事項`
      : '収録している要求事項（分析条件が未設定のため全件）',
    provisional: null,
  };
  row.breakdown = breakdown;
  row.notes.push('評価対象は「適用」かつ「重要性なし」以外の要求事項です。');
  // SSBJ の AI ギャップ分析は 3 観点の列に直接書く（担当者が後で確認する）ため、内訳には
  // 未確認の AI 判定も入る。CSRD（AI は候補の列だけ）と同じ意味に見せないよう明記する
  if (breakdown.aiOnly > 0) row.notes.push(SSBJ_BREAKDOWN_AI_NOTE);
  return row;
}

async function csrdRow(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  referenceDate: IsoDate,
): Promise<RegulationRow> {
  const master = await loadMaster(db, 'csrd');
  const row = baseRow('csrd', master);
  row.notes.push(CSRD_REVISED_ESRS_NOTE);
  if (!master || master.items.length === 0) return row;

  const loaded = await loadCsrdRequirementViews(db, ctx, period, { referenceDate });
  if (!loaded) return row;
  const inScope = loaded.views.filter((v) => isCsrdInScope(v.applicability));
  const breakdown: CoverageBreakdown = { counts: emptyCounts(), humanConfirmed: 0, aiOnly: 0 };
  for (const view of inScope) {
    breakdown.counts[view.combined] += 1;
    if (view.reviewState === 'human') breakdown.humanConfirmed += 1;
    else if (view.reviewState === 'ai_only') breakdown.aiOnly += 1;
  }
  row.inScope = {
    count: inScope.length,
    denominator: loaded.masterTotal,
    denominatorLabel: '収録しているサンプル（架空）の要求事項',
    provisional: inScope.filter((v) => v.applicability.provisional).length,
  };
  row.breakdown = breakdown;
  row.responses = {
    approved: loaded.views.filter((v) => v.response?.status === 'approved').length,
    total: loaded.views.length,
  };
  row.responsesRequired = {
    approved: inScope.filter((v) => v.response?.status === 'approved').length,
    total: inScope.length,
  };
  row.notes.unshift(
    '評価対象は「ESRS 2（常に適用）」と、ダブル・マテリアリティで重要と判断した事項の要求事項です。',
    CSRD_BREAKDOWN_NOTE,
  );
  if (!loaded.dmaConfirmed) {
    row.notes.push('DMA が未確定のため、テーマ別の適用は暫定です。');
  }
  return row;
}

async function cdpRow(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<RegulationRow> {
  const master = await loadMaster(db, 'cdp');
  const row = baseRow('cdp', master);
  // CDP は組織ごとに契約するオプション（トライアル対応 NF-38）。契約が無ければ算定しない（0 件と出さない）
  if (!(await hasOption(db, ctx, 'cdp'))) {
    row.notCalculatedReason = CDP_OPTION_NOT_CONTRACTED_REASON;
    row.notes.push(OPTION_NOT_CONTRACTED_MESSAGES.cdp);
    row.links = [];
    return row;
  }
  if (!master || master.items.length === 0) return row;
  row.inScope = {
    count: master.items.length,
    denominator: master.items.length,
    denominatorLabel: `${master.version.label} の全質問`,
    provisional: null,
  };
  row.breakdownNote =
    'CDP は 3 観点（開示・データ・業務プロセス）の評価を行っていないため、内訳は回答の承認状況で示します。';
  row.responses = await approvedResponses(db, ctx, period, master.items);
  return row;
}

/** 要求事項・評価項目を収録していない基準（ESRS-40a・MSCI・FTSE） */
async function uncollectedRow(db: DbClient, key: 'esrs_40a' | 'msci' | 'ftse') {
  const master = await loadMaster(db, key);
  const row = baseRow(key, master);
  // マスターがあっても要求事項が 0 件なら算定しない（baseRow が理由を入れる）。
  // 将来マスターを収録したときに黙って 0% と出さないよう、ここでは集計しない
  if (master && master.items.length > 0) {
    row.notes.push('評価項目の集計は未対応です（件数だけを示します）。');
    row.notCalculatedReason = '評価の仕組みが未対応のため算定しない';
  }
  return row;
}

/**
 * 各規制への対応度（行の順 SSBJ・CSRD・ESRS-40a・CDP・MSCI・FTSE）。書かない。
 * 権限は enterprise.disclosure.read。期間は自組織のものに限る
 */
export async function loadRegulatoryCoverage(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  options: { referenceDate?: IsoDate } = {},
): Promise<RegulatoryCoverage> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  // 画面から渡る期間オブジェクトも信用しない（他組織の期間 ID で他テナントの行を読ませない）
  const stored = await db.findById('periods', period.id);
  if (!stored || stored.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  const referenceDate = options.referenceDate ?? getReferenceDate();

  const [ssbj, csrd, esrs40a, cdp, msci, ftse] = await Promise.all([
    ssbjRow(db, ctx, stored),
    csrdRow(db, ctx, stored, referenceDate),
    uncollectedRow(db, 'esrs_40a'),
    cdpRow(db, ctx, stored),
    uncollectedRow(db, 'msci'),
    uncollectedRow(db, 'ftse'),
  ]);
  return { period: stored, referenceDate, rows: [ssbj, csrd, esrs40a, cdp, msci, ftse] };
}

// ----------------------------------------------------------------------
// 1 行の要約（現状診断の「開示対応（基準別）」が使う）
// ----------------------------------------------------------------------

/** 基準ごとの 1 行要約。割合は出さず「n / 分母 件」で書く */
export function regulationSummaryLine(row: RegulationRow): string {
  if (row.notCalculatedReason) {
    return `${row.positioning.label}。${row.notCalculatedReason}`;
  }
  const parts: string[] = [];
  if (row.inScope) {
    parts.push(
      `評価対象 ${row.inScope.count} / ${row.inScope.denominator} 件${
        row.inScope.provisional ? `（うち暫定 ${row.inScope.provisional} 件）` : ''
      }`,
    );
  }
  if (row.breakdown) {
    const c = row.breakdown.counts;
    parts.push(
      `対応済み ${c.covered}・おおむね ${c.mostly_covered}・一部 ${c.partial}・未対応 ${c.not_covered}・未確認 ${c.unconfirmed} 件`,
    );
    parts.push(
      `人が確認 ${row.breakdown.humanConfirmed} 件・AI 判定のみ ${row.breakdown.aiOnly} 件`,
    );
  }
  if (row.responses) {
    parts.push(`回答の承認 ${row.responses.approved} / ${row.responses.total} 件`);
  }
  return `${row.positioning.label}。${parts.join('、')}`;
}
