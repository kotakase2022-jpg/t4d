import 'server-only';

import { assertCan, assertEnterpriseWorkspace, can, NotFoundError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import {
  computeConsolidatedAggregation,
  summarizeScope3,
  type Scope3Status,
} from '@/lib/services/aggregation';
import { loadEnterpriseDashboard } from '@/lib/services/enterprise-data';
import { listNarratives } from '@/lib/services/narrative';
import type { DbClient, Where } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
  IsoDate,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { loadRegulatoryCoverage, regulationSummaryLine, type RegulationKey } from './regulations';
import { unitCoverageOf } from './unit-coverage';

/**
 * 現状診断（docs/disclosure-first.md §9.6）。閲覧専用（書かない）。
 *
 * 守っていること:
 *  - 単一の総合点・「準拠率」を出さない。領域ごとに事実（件数と分母）と状態だけを示す
 *    （状態は 不足あり／確認待ちあり／不足なし／算定対象外。点数にしない）
 *  - 割合は出さない。件数には必ず分母を添える。未入力・未収録を 0 として扱わない
 *  - 各領域・各行に、直すための画面へのリンクを置く
 *  - 権限は新サービス側で検査する（loadEnterpriseDashboard・computeConsolidatedAggregation は
 *    検査しないため）。開示の閲覧権限が無ければ、定性情報・開示対応の領域は出さない
 */

export const DIAGNOSIS_STATES = ['gap', 'pending', 'ok', 'not_applicable'] as const;
export type DiagnosisState = (typeof DIAGNOSIS_STATES)[number];

export const DIAGNOSIS_STATE_LABEL: Record<DiagnosisState, string> = {
  gap: '不足あり',
  pending: '確認待ちあり',
  ok: '不足なし',
  not_applicable: '算定対象外',
};

export const DIAGNOSIS_HIDDEN_NOTE = '閲覧権限が無い領域は表示していません';

export type DiagnosisAreaKey = 'collection' | 'evidence' | 'ghg' | 'narrative' | 'disclosure';

export interface DiagnosisLink {
  label: string;
  href: string;
}

export interface DiagnosisFact {
  key: string;
  label: string;
  /** 件数。値が無い事実（未算定など）は null で、text に表示を入れる */
  count: number | null;
  /** 分母。分母の無い事実は null */
  denominator: number | null;
  /** 分母が何の数か */
  denominatorLabel: string | null;
  /** 件・拠点・カテゴリ */
  unitLabel: string;
  text: string | null;
  href: string | null;
  /** この事実が状態の根拠になっているか（不足・確認待ち）。0 件なら null */
  attention: 'gap' | 'pending' | null;
}

export interface DiagnosisUnitRow {
  unitId: Uuid;
  unitName: string;
  approved: number;
  total: number;
  notSubmitted: number;
  reviewPending: number;
  validationErrors: number;
  href: string;
}

export interface DiagnosisGhgRow {
  code: string;
  label: string;
  /** 指標が登録されていなければ false（行は未登録として示す） */
  registered: boolean;
  approvedUnits: number;
  expectedUnits: number;
  reviewUnits: string[];
  unsubmittedUnits: string[];
  missingUnits: string[];
  noActualUnits: string[];
  href: string;
}

export interface DiagnosisScope3 {
  categoryTotal: number;
  presentCount: number;
  notApplicableCount: number;
  pendingCount: number;
  pendingLabels: string[];
  /** Scope3 合計（scope3_total）の登録値。未登録は null（Cat.1 の値で代えない） */
  totalValue: number | null;
  unitOfMeasure: string;
}

export interface DiagnosisFrameworkLine {
  key: RegulationKey;
  name: string;
  line: string;
  state: DiagnosisState;
}

export interface DiagnosisArea {
  key: DiagnosisAreaKey;
  title: string;
  /** 数値の出所（どの画面・どの集計と同じか） */
  source: string;
  state: DiagnosisState;
  stateLabel: string;
  stateReason: string;
  facts: DiagnosisFact[];
  links: DiagnosisLink[];
  units?: DiagnosisUnitRow[];
  ghg?: DiagnosisGhgRow[];
  excludedUnitNames?: string[];
  scope3?: DiagnosisScope3;
  frameworks?: DiagnosisFrameworkLine[];
}

export interface Diagnosis {
  period: ReportingPeriod;
  referenceDate: IsoDate;
  areas: DiagnosisArea[];
  /** 権限が無く出さなかった領域の名前 */
  hiddenAreas: string[];
  hiddenNote: string | null;
}

export interface DiagnosisInput {
  period: ReportingPeriod;
  periods: ReportingPeriod[];
  units: OrganizationUnit[];
  metrics: MetricDefinition[];
  referenceDate?: IsoDate;
}

function fact(
  key: string,
  label: string,
  count: number | null,
  denominator: number | null,
  options: {
    denominatorLabel?: string | null;
    unitLabel?: string;
    text?: string | null;
    href?: string | null;
    attention?: 'gap' | 'pending';
  } = {},
): DiagnosisFact {
  return {
    key,
    label,
    count,
    denominator,
    denominatorLabel: options.denominatorLabel ?? null,
    unitLabel: options.unitLabel ?? '件',
    text: options.text ?? null,
    href: options.href ?? null,
    // 0 件の事実は状態の根拠にしない（「不足あり」の理由として 0 件を強調しない）
    attention: options.attention && count !== null && count > 0 ? options.attention : null,
  };
}

function area(
  key: DiagnosisAreaKey,
  title: string,
  source: string,
  state: DiagnosisState,
  stateReason: string,
  facts: DiagnosisFact[],
  links: DiagnosisLink[],
): DiagnosisArea {
  return {
    key,
    title,
    source,
    state,
    stateLabel: DIAGNOSIS_STATE_LABEL[state],
    stateReason,
    facts,
    links,
  };
}

const joinNonEmpty = (parts: Array<string | null | false>) =>
  parts.filter((p): p is string => Boolean(p)).join('・');

// ----------------------------------------------------------------------
// データ収集・承認／証跡・承認の健全性（ダッシュボードと同じ集計）
// ----------------------------------------------------------------------

async function collectionAndEvidence(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DiagnosisInput,
  units: OrganizationUnit[],
  metrics: MetricDefinition[],
  referenceDate: IsoDate,
): Promise<[DiagnosisArea, DiagnosisArea]> {
  const organizationId = ctx.workspace.organizationId;
  const dashboard = await loadEnterpriseDashboard(db, ctx, input.period, units, metrics, {
    referenceDate,
  });
  // 分母（Data Point 総数・承認済み・差戻し・未完了タスク）はダッシュボードと同じ条件で数える
  const base: Where<DataPoint> = {
    organizationId,
    reportingPeriodId: input.period.id,
    deletedAt: { isNull: true },
  };
  const [total, approved, returned, openTasks] = await Promise.all([
    db.count('dataPoints', { where: base }),
    db.count('dataPoints', { where: { ...base, status: 'approved' } }),
    db.count('dataPoints', { where: { ...base, status: 'returned' } }),
    db.count('tasks', { where: { organizationId, status: { notIn: ['done', 'cancelled'] } } }),
  ]);
  const totalLabel = `${input.period.code} の Data Point 総数`;

  // ---- データ収集・承認
  const collectionFacts = [
    fact('approved', '承認済み', approved, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?status=approved',
    }),
    fact('not_submitted', '未提出（未着手・入力中）', dashboard.notSubmittedCount, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?status=not_started&status=draft',
      attention: 'gap',
    }),
    fact('returned', '差戻し', returned, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?status=returned',
      attention: 'gap',
    }),
    fact(
      'review_pending',
      'レビュー待ち（提出済み・レビュー中）',
      dashboard.reviewPendingCount,
      total,
      {
        denominatorLabel: totalLabel,
        href: '/enterprise/data?flag=review_pending',
        attention: 'pending',
      },
    ),
    fact('validation_error', '検証エラー', dashboard.validationErrorCount, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?flag=validation_error',
      attention: 'gap',
    }),
  ];
  let collectionState: DiagnosisState;
  let collectionReason: string;
  if (total === 0) {
    collectionState = 'not_applicable';
    collectionReason = `${input.period.code} のデータ項目がまだありません（0 件を「不足なし」とはしません）。収集の割り当てから始めてください。`;
  } else if (
    dashboard.notSubmittedCount > 0 ||
    returned > 0 ||
    dashboard.validationErrorCount > 0
  ) {
    collectionState = 'gap';
    collectionReason = `${joinNonEmpty([
      dashboard.notSubmittedCount > 0 && `未提出 ${dashboard.notSubmittedCount} 件`,
      returned > 0 && `差戻し ${returned} 件`,
      dashboard.validationErrorCount > 0 && `検証エラー ${dashboard.validationErrorCount} 件`,
    ])}があります（${total} 件中）。`;
  } else if (dashboard.reviewPendingCount > 0) {
    collectionState = 'pending';
    collectionReason = `レビュー待ちが ${dashboard.reviewPendingCount} 件あります（${total} 件中）。`;
  } else {
    collectionState = 'ok';
    collectionReason = `${total} 件すべてが承認済みで、検証エラーはありません。`;
  }
  const collection = area(
    'collection',
    'データ収集・承認',
    `ホーム（ダッシュボード）と同じ集計。${input.period.label} の Data Point（削除済みを除く）`,
    collectionState,
    collectionReason,
    collectionFacts,
    [
      { label: '非財務データの一覧', href: '/enterprise/data' },
      { label: 'ワークフロー（提出・承認）', href: '/enterprise/workflows' },
    ],
  );
  collection.units = dashboard.unitProgress.map((row) => ({
    unitId: row.unit.id,
    unitName: row.unit.name,
    approved: row.approved,
    total: row.total,
    notSubmitted: row.notStarted,
    reviewPending: row.submitted,
    validationErrors: row.errors,
    href: `/enterprise/data?unit=${row.unit.id}`,
  }));

  // ---- 証跡・承認の健全性
  const evidenceFacts = [
    fact('missing_evidence', '証跡不足', dashboard.missingEvidenceCount, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?flag=missing_evidence',
      attention: 'gap',
    }),
    fact(
      'approved_needs_recheck',
      '承認済み・要再確認（承認後に証跡不足）',
      dashboard.approvedNeedsRecheckCount,
      approved,
      {
        denominatorLabel: '承認済みの Data Point',
        href: '/enterprise/data?status=approved&flag=missing_evidence',
        attention: 'gap',
      },
    ),
    fact('changed_after_approval', '承認後に変更', dashboard.changedAfterApprovalCount, total, {
      denominatorLabel: totalLabel,
      href: '/enterprise/data?flag=changed_after_approval',
      attention: 'gap',
    }),
    fact('overdue_tasks', '期限超過のタスク', dashboard.overdueCount, openTasks, {
      denominatorLabel: '未完了のタスク（全期間）',
      href: '/enterprise/workflows?flag=overdue',
      attention: 'gap',
    }),
  ];
  const evidenceIssues = evidenceFacts.filter((f) => (f.count ?? 0) > 0);
  let evidenceState: DiagnosisState;
  let evidenceReason: string;
  if (evidenceIssues.length > 0) {
    evidenceState = 'gap';
    evidenceReason = `${evidenceIssues
      .map((f) => `${f.label} ${f.count} 件`)
      .join('・')}があります。`;
  } else if (total === 0 && openTasks === 0) {
    evidenceState = 'not_applicable';
    evidenceReason = `${input.period.code} のデータ項目・未完了のタスクがありません。`;
  } else {
    evidenceState = 'ok';
    evidenceReason = '証跡不足・要再確認・承認後の変更・期限超過のタスクはありません。';
  }
  const evidence = area(
    'evidence',
    '証跡・承認の健全性',
    'ホーム（ダッシュボード）と同じ集計。タスクの期限は画面上部の基準日で判定',
    evidenceState,
    evidenceReason,
    evidenceFacts,
    [
      { label: 'アラート', href: '/enterprise/alerts' },
      { label: 'Evidence（証跡）', href: '/enterprise/evidence' },
    ],
  );
  return [collection, evidence];
}

// ----------------------------------------------------------------------
// GHG 算定の網羅性
// ----------------------------------------------------------------------

const GHG_ROWS = [
  { code: 'scope1', label: 'Scope1' },
  { code: 'scope2', label: 'Scope2（マーケット基準）' },
  { code: 'scope2_location', label: 'Scope2（ロケーション基準）' },
] as const;

async function ghgArea(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DiagnosisInput,
  units: OrganizationUnit[],
  metrics: MetricDefinition[],
): Promise<DiagnosisArea> {
  const organizationId = ctx.workspace.organizationId;
  const [dataPoints, aggregation] = await Promise.all([
    db.select('dataPoints', {
      where: { organizationId, reportingPeriodId: input.period.id, deletedAt: { isNull: true } },
    }),
    computeConsolidatedAggregation(
      db,
      ctx,
      input.period,
      input.periods,
      GHG_ROWS.map((r) => r.code),
    ),
  ]);
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));

  const rows: DiagnosisGhgRow[] = GHG_ROWS.map(({ code, label }) => {
    const metric = metricByCode.get(code);
    if (!metric) {
      return {
        code,
        label,
        registered: false,
        approvedUnits: 0,
        expectedUnits: 0,
        reviewUnits: [],
        unsubmittedUnits: [],
        missingUnits: [],
        noActualUnits: [],
        href: '/enterprise/ghg',
      };
    }
    const coverage = unitCoverageOf(
      metric,
      units,
      dataPoints.filter((d) => d.metricId === metric.id),
    );
    return {
      code,
      label,
      registered: true,
      approvedUnits: coverage.approvedUnits.length + coverage.notApplicableUnits.length,
      expectedUnits: coverage.expected.length,
      reviewUnits: coverage.reviewUnits,
      unsubmittedUnits: coverage.unsubmittedUnits,
      missingUnits: coverage.missingUnits,
      noActualUnits: coverage.noActualUnits,
      href: `/enterprise/data?metric=${metric.id}`,
    };
  });

  // Scope3 は GHG 画面と同じ集計（期間の全 Data Point。承認前の行も「登録状況」として数える）
  const scope3Status: Scope3Status = summarizeScope3(metrics, dataPoints);
  const scope3: DiagnosisScope3 = {
    categoryTotal: scope3Status.categories.length,
    presentCount: scope3Status.presentCount,
    notApplicableCount: scope3Status.notApplicableCount,
    pendingCount: scope3Status.pendingCount,
    pendingLabels: scope3Status.categories
      .filter((c) => c.state !== 'value_present' && c.state !== 'not_applicable')
      .map((c) => `Cat.${c.category}`),
    totalValue: scope3Status.total.value,
    unitOfMeasure: scope3Status.total.metric?.unit ?? 't-CO2e',
  };

  const facts: DiagnosisFact[] = rows.map((row) =>
    row.registered
      ? fact(row.code, `${row.label} 承認済みの拠点`, row.approvedUnits, row.expectedUnits, {
          denominatorLabel: '連結対象の拠点（持分法・連結対象外を除く）',
          unitLabel: '拠点',
          href: row.href,
        })
      : fact(row.code, row.label, null, null, { text: '指標が未登録', href: row.href }),
  );
  facts.push(
    fact(
      'scope3_categories',
      'Scope3 値か対象外判断のあるカテゴリ',
      scope3.presentCount + scope3.notApplicableCount,
      scope3.categoryTotal,
      {
        denominatorLabel: 'Scope3 のカテゴリ（1〜15）',
        unitLabel: 'カテゴリ',
        href: '/enterprise/ghg',
      },
    ),
    fact('scope3_total', 'Scope3 合計', null, null, {
      text:
        scope3.totalValue === null
          ? '未算定'
          : `登録値あり（${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 }).format(scope3.totalValue)} ${scope3.unitOfMeasure}）`,
      href: '/enterprise/ghg',
    }),
  );

  const registered = rows.filter((r) => r.registered);
  const gapRows = registered.filter(
    (r) => r.missingUnits.length + r.unsubmittedUnits.length + r.noActualUnits.length > 0,
  );
  const reviewRows = registered.filter((r) => r.reviewUnits.length > 0);
  let state: DiagnosisState;
  let reason: string;
  if (registered.length === 0 || registered.every((r) => r.expectedUnits === 0)) {
    state = 'not_applicable';
    reason = 'GHG の指標、または連結対象の拠点が登録されていません。';
  } else if (gapRows.length > 0 || scope3.pendingCount > 0 || rows.some((r) => !r.registered)) {
    state = 'gap';
    reason = `${joinNonEmpty([
      ...gapRows.map((r) => `${r.label} 承認済み ${r.approvedUnits}/${r.expectedUnits} 拠点`),
      ...rows.filter((r) => !r.registered).map((r) => `${r.label} 指標が未登録`),
      scope3.pendingCount > 0 &&
        `Scope3 未登録・未算定のカテゴリ ${scope3.pendingCount}/${scope3.categoryTotal}`,
    ])}。`;
  } else if (reviewRows.length > 0) {
    state = 'pending';
    reason = `レビュー待ちの拠点があります（${reviewRows
      .map((r) => `${r.label}: ${r.reviewUnits.join('、')}`)
      .join(' ／ ')}）。`;
  } else {
    state = 'ok';
    reason =
      'Scope1・Scope2（2 方式）は連結対象の全拠点が承認済みで、Scope3 は全カテゴリに値か対象外判断があります。';
  }
  const result = area(
    'ghg',
    'GHG 算定の網羅性',
    `GHG 画面と同じ集計（連結集計・Scope3 のカテゴリ別状況）。${input.period.label}`,
    state,
    reason,
    facts,
    [
      { label: 'GHG の算定状況', href: '/enterprise/ghg' },
      { label: 'Scope3 サプライヤー', href: '/enterprise/ghg/suppliers' },
    ],
  );
  result.ghg = rows;
  result.scope3 = scope3;
  result.excludedUnitNames = (aggregation.metrics[0]?.excludedUnits ?? []).map((u) => u.unitName);
  return result;
}

// ----------------------------------------------------------------------
// 定性情報
// ----------------------------------------------------------------------

async function narrativeArea(db: DbClient, ctx: AuthorizationContext): Promise<DiagnosisArea> {
  const rows = await listNarratives(db, ctx);
  const total = rows.length;
  const confirmed = rows.filter((r) => r.record.status === 'confirmed').length;
  const drafts = rows.filter((r) => r.record.status === 'draft');
  const draftMissing = drafts.filter((r) => r.missingFieldCount > 0).length;
  const needsRecheck = rows.filter((r) => r.record.status === 'needs_recheck').length;
  const denominatorLabel = '登録済みの定性情報（全年度）';
  const facts = [
    fact('confirmed', '確認済み', confirmed, total, {
      denominatorLabel,
      href: '/enterprise/narratives?status=confirmed',
    }),
    fact('draft_missing_fields', 'テンプレート項目に不足がある下書き', draftMissing, total, {
      denominatorLabel,
      href: '/enterprise/narratives?status=draft',
      attention: 'gap',
    }),
    fact('drafts', '下書き（未確認）', drafts.length, total, {
      denominatorLabel,
      href: '/enterprise/narratives?status=draft',
      attention: 'pending',
    }),
    fact('needs_recheck', '要再確認', needsRecheck, total, {
      denominatorLabel,
      href: '/enterprise/narratives?status=needs_recheck',
      attention: 'gap',
    }),
  ];
  let state: DiagnosisState;
  let reason: string;
  if (total === 0) {
    state = 'gap';
    reason = '定性情報がまだ登録されていません。';
  } else if (needsRecheck > 0 || draftMissing > 0) {
    state = 'gap';
    reason = `${joinNonEmpty([
      needsRecheck > 0 && `要再確認 ${needsRecheck} 件`,
      draftMissing > 0 && `項目に不足がある下書き ${draftMissing} 件`,
    ])}があります（${total} 件中）。`;
  } else if (drafts.length > 0) {
    state = 'pending';
    reason = `未確認の下書きが ${drafts.length} 件あります（${total} 件中）。`;
  } else {
    state = 'ok';
    reason = `${total} 件すべて確認済みです。`;
  }
  return area(
    'narrative',
    '定性情報',
    '定性情報の一覧と同じ集計（年度で絞りません）',
    state,
    reason,
    facts,
    [{ label: '定性情報の一覧', href: '/enterprise/narratives' }],
  );
}

// ----------------------------------------------------------------------
// 開示対応（基準別）
// ----------------------------------------------------------------------

async function disclosureArea(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  referenceDate: IsoDate,
): Promise<DiagnosisArea> {
  const coverage = await loadRegulatoryCoverage(db, ctx, period, { referenceDate });
  const frameworks: DiagnosisFrameworkLine[] = coverage.rows.map((row) => {
    let state: DiagnosisState;
    if (row.notCalculatedReason) {
      state = 'not_applicable';
    } else {
      const c = row.breakdown?.counts;
      const open = c ? c.partial + c.not_covered + c.unconfirmed : 0;
      const unapproved = row.responses ? row.responses.total - row.responses.approved : 0;
      state =
        open > 0 || unapproved > 0 ? 'gap' : (row.breakdown?.aiOnly ?? 0) > 0 ? 'pending' : 'ok';
    }
    return { key: row.key, name: row.name, line: regulationSummaryLine(row), state };
  });
  const calculated = frameworks.filter((f) => f.state !== 'not_applicable');
  const gaps = calculated.filter((f) => f.state === 'gap');
  const pending = calculated.filter((f) => f.state === 'pending');
  let state: DiagnosisState;
  let reason: string;
  if (calculated.length === 0) {
    state = 'not_applicable';
    reason = '要求事項を収録している基準がありません。';
  } else if (gaps.length > 0) {
    state = 'gap';
    reason = `${gaps.map((f) => f.name).join('・')} に未対応・未確認の要求事項、または未承認の回答があります。`;
  } else if (pending.length > 0) {
    state = 'pending';
    reason = `${pending.map((f) => f.name).join('・')} に AI 判定だけで人が未確認の要求事項があります。`;
  } else {
    state = 'ok';
    reason = '算定した基準に、未対応・未確認の要求事項はありません。';
  }
  const result = area(
    'disclosure',
    '開示対応（基準別）',
    `各規制への対応度と同じ集計。${period.label}`,
    state,
    reason,
    [],
    [{ label: '各規制への対応度', href: '/enterprise/analysis/regulations' }],
  );
  result.frameworks = frameworks;
  return result;
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

/**
 * 現状診断を読む（書かない）。権限は enterprise.data.read。
 * 定性情報・開示対応の領域は enterprise.disclosure.read のときだけ含める
 */
export async function loadDiagnosis(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DiagnosisInput,
): Promise<Diagnosis> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  // 画面から渡る期間・拠点・指標も自組織のものだけを使う（他組織の行で集計しない）
  if (input.period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  const units = input.units.filter((u) => u.organizationId === organizationId);
  const metrics = input.metrics.filter((m) => m.organizationId === organizationId);
  const periods = input.periods.filter((p) => p.organizationId === organizationId);
  const referenceDate = input.referenceDate ?? getReferenceDate();
  const scoped: DiagnosisInput = { ...input, units, metrics, periods };

  const [[collection, evidence], ghg] = await Promise.all([
    collectionAndEvidence(db, ctx, scoped, units, metrics, referenceDate),
    ghgArea(db, ctx, scoped, units, metrics),
  ]);
  const areas: DiagnosisArea[] = [collection, evidence, ghg];
  const hiddenAreas: string[] = [];
  if (can(ctx, 'enterprise.disclosure.read')) {
    areas.push(await narrativeArea(db, ctx));
    areas.push(await disclosureArea(db, ctx, input.period, referenceDate));
  } else {
    hiddenAreas.push('定性情報', '開示対応（基準別）');
  }
  return {
    period: input.period,
    referenceDate,
    areas,
    hiddenAreas,
    hiddenNote: hiddenAreas.length > 0 ? DIAGNOSIS_HIDDEN_NOTE : null,
  };
}
