import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { canonicalJson, diffChars, type DiffSegment } from '@/lib/domain/disclosure-block';
import {
  BLOCK_STATUS_LABELS,
  NARRATIVE_STATUS_LABELS,
  NARRATIVE_THEME_LABELS,
} from '@/lib/domain/disclosure-status';
import {
  NARRATIVE_TEMPLATE_FIELDS,
  missingTemplateFields,
  type NarrativeTemplateField,
} from '@/lib/domain/narrative-template';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { FieldValidationError } from '@/lib/services/disclosure-project';
import { listMembers, type MemberEntry } from '@/lib/services/identity';
import {
  createAnchorFromFragment,
  loadAnchorViews,
  type AnchorView,
} from '@/lib/services/source-anchor';
import type { DbClient } from '@/lib/repositories/types';
import {
  NARRATIVE_STATUSES,
  NARRATIVE_THEMES,
  type AuthorizationContext,
  type BlockStatus,
  type DisclosureBlockVersion,
  type IsoDateTime,
  type NarrativeRecord,
  type NarrativeStatus,
  type NarrativeTheme,
  type NarrativeVersion,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';

/**
 * 定性情報（docs/disclosure-first.md §3 0036、指示書 §6.5・§6.6・§6.8・§12.2 saveNarrative）。
 *
 * 定性情報は原稿とは別の、再利用できる記録。内容は版として追記し、台帳は状態と版へのポインタだけを持つ。
 * ここで守ること:
 *  - テンプレート項目は値のある項目だけをキーとして持つ（空欄を「入力済み」に見せない）。
 *    影響額・監督頻度・委員会名などを自動で補完しない。
 *  - 保存は基準の版（baseVersionId）を必ず受け取り、現在の版と違えば保存せず比較情報を返す（409 相当）。
 *  - 原稿から引用されている定性情報を変えるときは、先に影響する原稿を示す。
 *    原稿は採用時の本文を持っており、ここで書き換えることはない（§6.7・§6.8）。
 *  - 前年からの引継ぎは新しい年度の下書きの版を作るだけ。確認（承認）は引き継がない。
 *  - 「資料から候補を作成」は抜粋を並べるだけの規則ベース（AI は使わない）。候補と明示する。
 *  - 確認（確認済みにする）は人の操作だけ。
 */

// ======================================================================
// テンプレートの詳細項目（§6.6 の「詳細項目」。初期表示は narrative-template.ts）
// ======================================================================

/**
 * 詳細項目。初期表示の項目（NARRATIVE_TEMPLATE_FIELDS）は不足情報の判定に使うが、
 * 詳細項目は任意で、書かれていなくても不足とは数えない。キーは初期表示の項目と重ねない。
 */
export const NARRATIVE_DETAIL_FIELDS: Readonly<
  Record<NarrativeTheme, readonly NarrativeTemplateField[]>
> = {
  risk_opportunity: [
    { key: 'businessImpact', label: '事業への影響' },
    { key: 'impactPathway', label: '影響経路' },
    { key: 'scenarioAssumptions', label: 'シナリオ・前提' },
    { key: 'responsiblePerson', label: '責任者' },
    { key: 'relatedKpi', label: '関連 KPI' },
    { key: 'progress', label: '進捗' },
  ],
  financial_impact: [
    { key: 'timing', label: '現在／将来' },
    { key: 'targetPeriod', label: '対象期間' },
    { key: 'financialLineItems', label: '影響する財務項目' },
    { key: 'amountForm', label: '単一値／範囲' },
    { key: 'currency', label: '通貨' },
    { key: 'assumptions', label: '仮定' },
    { key: 'uncertainty', label: '不確実性' },
    { key: 'financialPlanningLink', label: '財務計画との関係' },
  ],
  governance: [
    { key: 'reportingLine', label: '報告経路' },
    { key: 'coveredPeriod', label: '対象期間' },
    { key: 'expertise', label: '専門性' },
    { key: 'decisionMaking', label: '意思決定' },
    { key: 'targetOversight', label: '目標の監督' },
    { key: 'changesFromPriorYear', label: '前年度からの変更' },
  ],
  strategy: [
    { key: 'policy', label: '方針' },
    { key: 'scope', label: '対象範囲' },
    { key: 'responsiblePerson', label: '責任者' },
    { key: 'deadline', label: '期限' },
    { key: 'resourceAllocation', label: '投資・資源配分' },
    { key: 'tradeOffs', label: 'トレードオフ' },
  ],
  policy_other: [
    { key: 'responsiblePerson', label: '責任者' },
    { key: 'reviewCycle', label: '見直しの周期' },
  ],
};

/** テンプレート（初期表示＋詳細）に定義された項目 */
export function narrativeFieldDefs(theme: NarrativeTheme): NarrativeTemplateField[] {
  return [...NARRATIVE_TEMPLATE_FIELDS[theme], ...NARRATIVE_DETAIL_FIELDS[theme]];
}

/** 財務的影響で「影響額」も「示さない理由」も無いときの注意（免除の可否は要求事項側の判断） */
export const NO_AMOUNT_NOTE =
  '定量化しない理由を登録できることと、基準上の免除が認められることは別です（免除の可否は要求事項側で判断します）。';

/**
 * テンプレート項目を正規化する。空欄は捨て（キーを持たない）、定義に無いキーは受け付けない。
 */
export function normalizeNarrativeFields(
  theme: NarrativeTheme,
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = new Set(narrativeFieldDefs(theme).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    const trimmed = (value ?? '').trim();
    if (trimmed) out[key] = trimmed.slice(0, 4000);
  }
  return out;
}

/** 版の内容ハッシュ（Fixture と同じ正規化。同じ内容なら同じ値） */
export function narrativeContentHash(v: {
  reportingPeriodId: Uuid;
  scopeNote: string;
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: Uuid[];
}): string {
  return contentHash(
    canonicalJson({
      reportingPeriodId: v.reportingPeriodId,
      scopeNote: v.scopeNote,
      fields: v.fields,
      body: v.body,
      sourceAnchorIds: v.sourceAnchorIds,
    }),
  );
}

/** 「資料から候補を作成」で作った版の変更理由（候補かどうかの判定に使う） */
export const CANDIDATE_CHANGE_REASON = '資料の抜粋から作成した候補（人の確認前）';

export function isCandidateVersion(
  version: Pick<NarrativeVersion, 'changeReason'> | null,
): boolean {
  return version?.changeReason === CANDIDATE_CHANGE_REASON;
}

// ======================================================================
// 利用先の逆引き（原稿 → 定性情報）
// ======================================================================

export interface NarrativeUsage {
  blockId: Uuid;
  blockTitle: string;
  blockStatus: BlockStatus;
  blockStatusLabel: string;
  projectId: Uuid;
  projectName: string;
  /** 原稿が引用している定性情報の版 */
  citedVersionId: Uuid;
  citedVersionNo: number | null;
  /** 引用しているのが定性情報の現在の版か（違えば原稿側で再確認が必要） */
  citesCurrent: boolean;
  /** 原稿のどの版が引用しているか（現在の版／承認済みの版） */
  via: Array<'current' | 'approved'>;
}

/**
 * 原稿（節）の現在の版・承認済みの版が引用している定性情報を、台帳ごとに集める。
 * 過去の版だけが引用していた定性情報は「利用先」に数えない。
 */
async function loadNarrativeUsageMap(
  db: DbClient,
  organizationId: Uuid,
  narrativeVersions: readonly NarrativeVersion[],
  records: readonly NarrativeRecord[],
): Promise<Map<Uuid, NarrativeUsage[]>> {
  const blocks = await db.select('disclosureBlocks', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const blockVersionIds = [
    ...new Set(
      blocks.flatMap((b) => [b.currentVersionId, b.approvedVersionId]).filter((id) => id !== null),
    ),
  ] as Uuid[];
  const [blockVersions, projects] = await Promise.all([
    blockVersionIds.length > 0
      ? db.select('disclosureBlockVersions', { where: { id: { in: blockVersionIds } } })
      : Promise.resolve([] as DisclosureBlockVersion[]),
    db.select('disclosureProjects', { where: { organizationId } }),
  ]);
  const versionById = new Map(narrativeVersions.map((v) => [v.id, v]));
  const recordById = new Map(records.map((r) => [r.id, r]));
  const map = new Map<Uuid, NarrativeUsage[]>();

  for (const block of blocks) {
    const project = projects.find((p) => p.id === block.projectId && !p.deletedAt);
    if (!project) continue;
    const entries = new Map<Uuid, NarrativeUsage>();
    for (const [via, versionId] of [
      ['current', block.currentVersionId],
      ['approved', block.approvedVersionId],
    ] as const) {
      const bv = blockVersions.find((v) => v.id === versionId);
      for (const ref of bv?.narrativeRefs ?? []) {
        const nv = versionById.get(ref);
        if (!nv) continue;
        const record = recordById.get(nv.narrativeRecordId);
        if (!record) continue;
        const key = `${record.id}`;
        const existing = entries.get(key);
        if (existing) {
          if (!existing.via.includes(via)) existing.via.push(via);
          continue;
        }
        entries.set(key, {
          blockId: block.id,
          blockTitle: block.title,
          blockStatus: block.status,
          blockStatusLabel: BLOCK_STATUS_LABELS[block.status],
          projectId: project.id,
          projectName: project.name,
          citedVersionId: nv.id,
          citedVersionNo: nv.versionNo,
          citesCurrent: record.currentVersionId === nv.id,
          via: [via],
        });
      }
    }
    for (const [recordId, usage] of entries) {
      const list = map.get(recordId) ?? [];
      list.push(usage);
      map.set(recordId, list);
    }
  }
  return map;
}

// ======================================================================
// 一覧（§6.5）
// ======================================================================

export interface NarrativeListRow {
  record: NarrativeRecord;
  currentVersion: NarrativeVersion | null;
  period: ReportingPeriod | null;
  scopeNote: string;
  themeLabel: string;
  statusLabel: string;
  ownerName: string | null;
  confirmedAt: IsoDateTime | null;
  /** 確認済みの版が現在の版と同じか（違えば「前の版を確認」） */
  confirmedIsCurrent: boolean;
  evidenceCount: number;
  missingFieldCount: number;
  usage: NarrativeUsage[];
  isCandidate: boolean;
  /** 前年から引き継いだ版か */
  carried: boolean;
}

export interface NarrativeListFilter {
  theme?: NarrativeTheme | null;
  status?: NarrativeStatus | null;
  q?: string | null;
}

function assertCanRead(ctx: AuthorizationContext): void {
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
}

export async function listNarratives(
  db: DbClient,
  ctx: AuthorizationContext,
  filter: NarrativeListFilter = {},
): Promise<NarrativeListRow[]> {
  assertCanRead(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [records, versions, periods, members] = await Promise.all([
    db.select('narrativeRecords', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: [{ column: 'theme' }, { column: 'title' }],
    }),
    db.select('narrativeVersions', { where: { organizationId } }),
    db.select('periods', { where: { organizationId } }),
    listMembers(db, ctx),
  ]);
  const usage = await loadNarrativeUsageMap(db, organizationId, versions, records);
  const q = (filter.q ?? '').trim().toLowerCase();

  return records
    .filter((r) => !filter.theme || r.theme === filter.theme)
    .filter((r) => !filter.status || r.status === filter.status)
    .map((record) => {
      const current = versions.find((v) => v.id === record.currentVersionId) ?? null;
      return {
        record,
        currentVersion: current,
        period: current ? (periods.find((p) => p.id === current.reportingPeriodId) ?? null) : null,
        scopeNote: current?.scopeNote ?? '',
        themeLabel: NARRATIVE_THEME_LABELS[record.theme],
        statusLabel: NARRATIVE_STATUS_LABELS[record.status],
        ownerName: record.ownerUserId
          ? (members.find((m) => m.userId === record.ownerUserId)?.displayName ?? null)
          : null,
        confirmedAt: record.confirmedAt,
        confirmedIsCurrent:
          record.confirmedVersionId !== null &&
          record.confirmedVersionId === record.currentVersionId,
        evidenceCount: current?.sourceAnchorIds.length ?? 0,
        missingFieldCount: current ? missingTemplateFields(record.theme, current.fields).length : 0,
        usage: usage.get(record.id) ?? [],
        isCandidate: isCandidateVersion(current),
        carried: current?.carriedFromVersionId != null,
      };
    })
    .filter(
      (row) =>
        !q ||
        row.record.title.toLowerCase().includes(q) ||
        row.record.tags.some((t) => t.toLowerCase().includes(q)) ||
        (row.currentVersion?.body ?? '').toLowerCase().includes(q),
    );
}

// ======================================================================
// 編集画面（§6.6）
// ======================================================================

export interface NarrativeVersionView {
  version: NarrativeVersion;
  period: ReportingPeriod | null;
  createdByName: string | null;
  isCurrent: boolean;
  isConfirmed: boolean;
}

export interface NarrativeEditorData {
  record: NarrativeRecord;
  currentVersion: NarrativeVersion | null;
  /** ポインタはあるが版が見つからない（Demo Mode の別インスタンスなど） */
  versionMissing: boolean;
  versions: NarrativeVersionView[];
  anchors: AnchorView[];
  usage: NarrativeUsage[];
  templateFields: readonly NarrativeTemplateField[];
  detailFields: readonly NarrativeTemplateField[];
  missingFields: NarrativeTemplateField[];
  periods: ReportingPeriod[];
  members: MemberEntry[];
  ownerName: string | null;
  confirmedByName: string | null;
  canWrite: boolean;
  isCandidate: boolean;
}

async function loadRecord(
  db: DbClient,
  ctx: AuthorizationContext,
  narrativeId: Uuid,
): Promise<NarrativeRecord> {
  const record = await db.findById('narrativeRecords', narrativeId);
  if (!record || record.deletedAt || record.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('定性情報が見つかりません。');
  }
  return record;
}

export async function getNarrativeEditor(
  db: DbClient,
  ctx: AuthorizationContext,
  narrativeId: Uuid,
): Promise<NarrativeEditorData> {
  assertCanRead(ctx);
  const record = await loadRecord(db, ctx, narrativeId);
  const organizationId = record.organizationId;
  const [versions, periods, members, allVersions, records] = await Promise.all([
    db.select('narrativeVersions', {
      where: { narrativeRecordId: record.id, organizationId },
      orderBy: { column: 'versionNo', dir: 'desc' },
    }),
    db.select('periods', { where: { organizationId }, orderBy: { column: 'code', dir: 'desc' } }),
    listMembers(db, ctx),
    db.select('narrativeVersions', { where: { organizationId } }),
    db.select('narrativeRecords', { where: { organizationId } }),
  ]);
  const current = versions.find((v) => v.id === record.currentVersionId) ?? null;
  const usageMap = await loadNarrativeUsageMap(db, organizationId, allVersions, records);
  const nameOf = (id: Uuid | null) =>
    id ? (members.find((m) => m.userId === id)?.displayName ?? '（組織外のユーザー）') : null;

  return {
    record,
    currentVersion: current,
    versionMissing: record.currentVersionId !== null && current === null,
    versions: versions.map((version) => ({
      version,
      period: periods.find((p) => p.id === version.reportingPeriodId) ?? null,
      createdByName: nameOf(version.createdBy),
      isCurrent: version.id === record.currentVersionId,
      isConfirmed: version.id === record.confirmedVersionId,
    })),
    anchors: current ? await loadAnchorViews(db, ctx, current.sourceAnchorIds) : [],
    usage: usageMap.get(record.id) ?? [],
    templateFields: NARRATIVE_TEMPLATE_FIELDS[record.theme],
    detailFields: NARRATIVE_DETAIL_FIELDS[record.theme],
    missingFields: current ? missingTemplateFields(record.theme, current.fields) : [],
    periods,
    members,
    ownerName: nameOf(record.ownerUserId),
    confirmedByName: nameOf(record.confirmedBy),
    canWrite: can(ctx, 'enterprise.disclosure.write'),
    isCandidate: isCandidateVersion(current),
  };
}

// ======================================================================
// 版の保存（§12.2 saveNarrative）
// ======================================================================

export interface SaveNarrativeInput {
  narrativeId: Uuid;
  /** 編集を始めたときの版。現在の版と違えば保存しない（競合） */
  baseVersionId: Uuid | null;
  reportingPeriodId: Uuid;
  scopeNote: string;
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: Uuid[];
  changeReason: string;
  /** 原稿から引用されている場合、影響一覧を確認したか */
  acknowledgeImpact: boolean;
}

export interface NarrativeFieldDiff {
  key: string;
  label: string;
  mine: string | null;
  latest: string | null;
  differs: boolean;
}

export interface NarrativeConflict {
  latestVersion: NarrativeVersion | null;
  latestCreatedByName: string | null;
  fieldDiffs: NarrativeFieldDiff[];
  /** 最新版の本文 → 自分の本文 の差分 */
  bodyDiff: DiffSegment[];
}

export type SaveNarrativeResult =
  | { status: 'saved'; version: NarrativeVersion }
  | { status: 'unchanged'; version: NarrativeVersion }
  | { status: 'needs_confirmation'; usage: NarrativeUsage[] }
  | { status: 'conflict'; conflict: NarrativeConflict };

function buildConflict(
  theme: NarrativeTheme,
  latest: NarrativeVersion | null,
  latestCreatedByName: string | null,
  mine: { fields: Record<string, string>; body: string },
): NarrativeConflict {
  const fieldDiffs = narrativeFieldDefs(theme).map((f) => {
    const a = mine.fields[f.key] ?? null;
    const b = latest?.fields[f.key] ?? null;
    return { key: f.key, label: f.label, mine: a, latest: b, differs: a !== b };
  });
  return {
    latestVersion: latest,
    latestCreatedByName,
    fieldDiffs,
    bodyDiff: diffChars(latest?.body ?? '', mine.body),
  };
}

async function validateAnchors(
  db: DbClient,
  ctx: AuthorizationContext,
  anchorIds: readonly Uuid[],
): Promise<Uuid[]> {
  const unique = [...new Set(anchorIds.filter((id) => id))];
  if (unique.length === 0) return [];
  const anchors = await db.select('sourceAnchors', { where: { id: { in: unique } } });
  const valid = new Set(
    anchors.filter((a) => a.organizationId === ctx.workspace.organizationId).map((a) => a.id),
  );
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new ValidationError(
      `根拠の引用位置が見つかりません（${invalid.length} 件）。引用し直してください。`,
    );
  }
  return unique;
}

async function validatePeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<ReportingPeriod> {
  const period = periodId ? await db.findById('periods', periodId) : null;
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new FieldValidationError({ reportingPeriodId: '年度を選んでください。' });
  }
  return period;
}

/**
 * 定性情報の新しい版を保存する。
 *  - baseVersionId が現在の版と違えば保存せず、最新版との比較情報を返す（409 相当）。
 *  - 原稿から引用されていれば、影響する原稿を返して確認を求める（原稿の本文は書き換えない）。
 *  - 内容が基準の版と同じなら版を増やさない。
 * 新しい版は未確認（下書き）。確認済みの版は台帳の confirmedVersionId に残る。
 */
export async function saveNarrative(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveNarrativeInput,
): Promise<SaveNarrativeResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const record = await loadRecord(db, ctx, input.narrativeId);
  const fields = normalizeNarrativeFields(record.theme, input.fields);
  const body = input.body.trim().slice(0, 20000);

  const versions = await db.select('narrativeVersions', {
    where: { narrativeRecordId: record.id, organizationId: record.organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
  });
  const current = versions.find((v) => v.id === record.currentVersionId) ?? null;

  if ((input.baseVersionId ?? null) !== record.currentVersionId) {
    const members = await listMembers(db, ctx);
    const createdBy = current?.createdBy ?? null;
    return {
      status: 'conflict',
      conflict: buildConflict(
        record.theme,
        current,
        createdBy ? (members.find((m) => m.userId === createdBy)?.displayName ?? null) : null,
        { fields, body },
      ),
    };
  }
  if (record.currentVersionId !== null && current === null) {
    throw new NotFoundError(
      '現在の版が見つかりません（デモ環境の再起動で版が失われた可能性があります）。画面を開き直してください。',
    );
  }

  if (!body && Object.keys(fields).length === 0) {
    throw new FieldValidationError({
      body: '本文かテンプレート項目のどちらかを入力してください。',
    });
  }
  const period = await validatePeriod(db, ctx, input.reportingPeriodId);
  const sourceAnchorIds = await validateAnchors(db, ctx, input.sourceAnchorIds);
  const scopeNote = input.scopeNote.trim().slice(0, 1000);
  const hash = narrativeContentHash({
    reportingPeriodId: period.id,
    scopeNote,
    fields,
    body,
    sourceAnchorIds,
  });
  if (current && current.contentHash === hash) return { status: 'unchanged', version: current };

  const changeReason = input.changeReason.trim();
  if (current && !changeReason) {
    throw new FieldValidationError({ changeReason: '変更の理由を入力してください。' });
  }

  const allVersions = await db.select('narrativeVersions', {
    where: { organizationId: record.organizationId },
  });
  const records = await db.select('narrativeRecords', {
    where: { organizationId: record.organizationId },
  });
  const usage =
    (await loadNarrativeUsageMap(db, record.organizationId, allVersions, records)).get(record.id) ??
    [];
  if (usage.length > 0 && !input.acknowledgeImpact) {
    return { status: 'needs_confirmation', usage };
  }

  const versionNo = (versions[0]?.versionNo ?? 0) + 1;
  const version: NarrativeVersion = {
    id: fid('narrative_version', `${record.id}/v${versionNo}`),
    organizationId: record.organizationId,
    narrativeRecordId: record.id,
    versionNo,
    reportingPeriodId: period.id,
    scopeNote,
    fields,
    body,
    sourceAnchorIds,
    carriedFromVersionId: null,
    changeReason: changeReason.slice(0, 1000) || null,
    originatedFromAiRunId: null,
    contentHash: hash,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  await db.insert('narrativeVersions', [version]);
  await db.update('narrativeRecords', record.id, {
    currentVersionId: version.id,
    // 新しい版は未確認。確認済みの版（confirmedVersionId）はそのまま残す
    status: 'draft',
    updatedAt: version.createdAt,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'narrative_version_created',
    resourceType: 'narrative_record',
    resourceId: record.id,
    afterSummary: `${record.title}: 版 ${versionNo}${changeReason ? `（${changeReason.slice(0, 80)}）` : ''}`,
    metadata: {
      versionId: version.id,
      baseVersionId: input.baseVersionId,
      sourceAnchorCount: sourceAnchorIds.length,
      impactedBlocks: usage.length,
    },
  });
  return { status: 'saved', version };
}

// ======================================================================
// 新規登録・候補作成・引継ぎ・確認
// ======================================================================

export interface CreateNarrativeInput {
  theme: string;
  title: string;
  ownerDepartment: string;
  tags: string[];
  reportingPeriodId: Uuid;
  scopeNote: string;
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: Uuid[];
}

async function insertRecordWithVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    theme: NarrativeTheme;
    title: string;
    ownerDepartment: string;
    tags: string[];
    period: ReportingPeriod;
    scopeNote: string;
    fields: Record<string, string>;
    body: string;
    sourceAnchorIds: Uuid[];
    changeReason: string;
  },
): Promise<{ record: NarrativeRecord; version: NarrativeVersion }> {
  const now = new Date().toISOString();
  const recordId = randomUUID();
  // 版を追記してから台帳のポインタを指し直す（DB の複合外部キーは遅延可能）
  const record: NarrativeRecord = {
    id: recordId,
    organizationId: ctx.workspace.organizationId,
    theme: input.theme,
    title: input.title,
    ownerUserId: ctx.userId,
    ownerDepartment: input.ownerDepartment,
    tags: input.tags,
    status: 'draft',
    currentVersionId: null,
    confirmedVersionId: null,
    confirmedBy: null,
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };
  const version: NarrativeVersion = {
    id: fid('narrative_version', `${recordId}/v1`),
    organizationId: record.organizationId,
    narrativeRecordId: recordId,
    versionNo: 1,
    reportingPeriodId: input.period.id,
    scopeNote: input.scopeNote,
    fields: input.fields,
    body: input.body,
    sourceAnchorIds: input.sourceAnchorIds,
    carriedFromVersionId: null,
    changeReason: input.changeReason,
    originatedFromAiRunId: null,
    contentHash: narrativeContentHash({
      reportingPeriodId: input.period.id,
      scopeNote: input.scopeNote,
      fields: input.fields,
      body: input.body,
      sourceAnchorIds: input.sourceAnchorIds,
    }),
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('narrativeRecords', [record]);
  await db.insert('narrativeVersions', [version]);
  const updated = await db.update('narrativeRecords', recordId, { currentVersionId: version.id });
  await recordAuditEvent(db, ctx, {
    eventType: 'narrative_version_created',
    resourceType: 'narrative_record',
    resourceId: recordId,
    afterSummary: `${record.title}: 版 1（${input.changeReason}）`,
    metadata: { versionId: version.id, sourceAnchorCount: input.sourceAnchorIds.length },
  });
  return { record: updated, version };
}

function parseTheme(value: string): NarrativeTheme | null {
  return (NARRATIVE_THEMES as readonly string[]).includes(value) ? (value as NarrativeTheme) : null;
}

/** 「新しく登録」 */
export async function createNarrative(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateNarrativeInput,
): Promise<{ record: NarrativeRecord; version: NarrativeVersion }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const errors: Record<string, string> = {};
  const theme = parseTheme(input.theme);
  if (!theme) errors.theme = '情報の種別を選んでください。';
  const title = input.title.trim();
  if (!title) errors.title = '題名を入力してください。';
  const fields = theme ? normalizeNarrativeFields(theme, input.fields) : {};
  const body = input.body.trim().slice(0, 20000);
  if (!body && Object.keys(fields).length === 0) {
    errors.body = '本文かテンプレート項目のどちらかを入力してください。';
  }
  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);
  const period = await validatePeriod(db, ctx, input.reportingPeriodId);
  const sourceAnchorIds = await validateAnchors(db, ctx, input.sourceAnchorIds);
  return insertRecordWithVersion(db, ctx, {
    theme: theme!,
    title: title.slice(0, 200),
    ownerDepartment: input.ownerDepartment.trim().slice(0, 100),
    tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 20),
    period,
    scopeNote: input.scopeNote.trim().slice(0, 1000),
    fields,
    body,
    sourceAnchorIds,
    changeReason: '新しく登録',
  });
}

/**
 * 「資料から候補を作成」（規則ベース。AI は使わない）。
 * 選んだ抜粋をそのまま引用として並べた本文の下書きを作り、引用位置を根拠に付ける。
 * テンプレート項目は埋めない（抜粋から影響額・頻度・委員会名などを推測しない）。
 * 過年度の記載・文体の参考の資料から取った抜粋は、本文でもそう明示する（当年度の事実に見せない）。
 */
export async function createNarrativeCandidateFromFragments(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    theme: string;
    title: string;
    reportingPeriodId: Uuid;
    fragmentIds: Uuid[];
  },
): Promise<{ record: NarrativeRecord; version: NarrativeVersion; warnings: string[] }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const errors: Record<string, string> = {};
  const theme = parseTheme(input.theme);
  if (!theme) errors.theme = '情報の種別を選んでください。';
  const title = input.title.trim();
  if (!title) errors.title = '題名を入力してください。';
  const fragmentIds = [...new Set(input.fragmentIds.filter(Boolean))];
  if (fragmentIds.length === 0) errors.fragmentIds = '候補に使う抜粋を 1 つ以上選んでください。';
  if (fragmentIds.length > 12) errors.fragmentIds = '一度に選べる抜粋は 12 件までです。';
  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);
  const period = await validatePeriod(db, ctx, input.reportingPeriodId);

  const fragments = await db.select('fragments', { where: { id: { in: fragmentIds } } });
  const own = fragments.filter((f) => f.organizationId === ctx.workspace.organizationId);
  if (own.length !== fragmentIds.length) throw new NotFoundError('選んだ抜粋が見つかりません。');
  const versionIds = [...new Set(own.map((f) => f.fileVersionId))];
  const fileVersions = await db.select('fileVersions', { where: { id: { in: versionIds } } });
  const files = await db.select('files', {
    where: { id: { in: [...new Set(fileVersions.map((v) => v.fileId))] } },
  });

  const warnings: string[] = [];
  const lines: string[] = [];
  const anchorIds: Uuid[] = [];
  // 選んだ順（資料 → ページ）に並べる
  const ordered = fragmentIds
    .map((id) => own.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
  for (const fragment of ordered) {
    const fv = fileVersions.find((v) => v.id === fragment.fileVersionId);
    const file = fv ? files.find((f) => f.id === fv.fileId && !f.deletedAt) : undefined;
    if (!file) throw new NotFoundError('抜粋の資料が見つかりません。');
    // 引用は抽出結果の文言そのもの（長い場合は先頭 1000 文字）
    const quote = fragment.text.trim().slice(0, 1000);
    const anchor = await createAnchorFromFragment(db, ctx, {
      fragmentId: fragment.id,
      quoteText: quote,
    });
    anchorIds.push(anchor.id);
    const place = fragment.locator ?? `p.${fragment.page}`;
    const purposeNote =
      file.usagePurpose === 'current_fact'
        ? ''
        : file.usagePurpose === 'prior_year_text'
          ? '［過年度の記載］'
          : file.usagePurpose === 'style_reference'
            ? '［文体の参考］'
            : '［利用目的未設定の資料］';
    if (file.usagePurpose !== 'current_fact') {
      warnings.push(
        `「${file.originalName}」は当年度の根拠として登録された資料ではありません。当年度の事実は別の資料で確認してください。`,
      );
    }
    lines.push(`${purposeNote}「${quote}」（${file.originalName}／${place}）`);
  }

  const created = await insertRecordWithVersion(db, ctx, {
    theme: theme!,
    title: title.slice(0, 200),
    ownerDepartment: '',
    tags: [],
    period,
    scopeNote: '',
    fields: {},
    body: lines.join('\n'),
    sourceAnchorIds: [...new Set(anchorIds)],
    changeReason: CANDIDATE_CHANGE_REASON,
  });
  return { ...created, warnings: [...new Set(warnings)] };
}

/**
 * 「前年から引継ぎ」。前の年度の版を写した新しい年度の下書きの版を作る。
 * 確認（承認）は引き継がない（台帳の状態は下書きに戻る）。引用位置も引き継がない
 * （前年度の資料を当年度の根拠に見せないため。元の版は carriedFromVersionId で辿れる）。
 */
export async function carryForwardNarrative(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeId: Uuid; targetPeriodId: Uuid },
): Promise<NarrativeVersion> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const record = await loadRecord(db, ctx, input.narrativeId);
  const target = await validatePeriod(db, ctx, input.targetPeriodId);
  const versions = await db.select('narrativeVersions', {
    where: { narrativeRecordId: record.id, organizationId: record.organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
  });
  const source = versions.find((v) => v.id === record.currentVersionId);
  if (!source) throw new NotFoundError('引き継ぐ元の版が見つかりません。');
  if (versions.some((v) => v.reportingPeriodId === target.id)) {
    throw new ValidationError(`${target.code} の版は既にあります。その版を編集してください。`);
  }
  const sourcePeriod = await db.findById('periods', source.reportingPeriodId);
  if (sourcePeriod && sourcePeriod.startDate >= target.startDate) {
    throw new ValidationError('引継ぎは、元の版より後の年度に対してだけ行えます。');
  }

  const versionNo = (versions[0]?.versionNo ?? 0) + 1;
  const scopeNote = source.scopeNote;
  const version: NarrativeVersion = {
    id: fid('narrative_version', `${record.id}/v${versionNo}`),
    organizationId: record.organizationId,
    narrativeRecordId: record.id,
    versionNo,
    reportingPeriodId: target.id,
    scopeNote,
    fields: { ...source.fields },
    body: source.body,
    sourceAnchorIds: [],
    carriedFromVersionId: source.id,
    changeReason: `${sourcePeriod?.code ?? '前年度'} の版 ${source.versionNo} から引継ぎ（当年度の根拠は未登録・未確認）`,
    originatedFromAiRunId: null,
    contentHash: narrativeContentHash({
      reportingPeriodId: target.id,
      scopeNote,
      fields: source.fields,
      body: source.body,
      sourceAnchorIds: [],
    }),
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  await db.insert('narrativeVersions', [version]);
  await db.update('narrativeRecords', record.id, {
    currentVersionId: version.id,
    status: 'draft',
    updatedAt: version.createdAt,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'narrative_version_created',
    resourceType: 'narrative_record',
    resourceId: record.id,
    afterSummary: `${record.title}: ${target.code} へ引継ぎ（版 ${versionNo}・下書き）`,
    metadata: { versionId: version.id, carriedFromVersionId: source.id },
  });
  return version;
}

/**
 * 人が確認する。確認できるのは画面で見ていた版（現在の版）だけ。
 * 確認後に版を追加しても、確認した版は confirmedVersionId に残る。
 */
export async function confirmNarrative(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeId: Uuid; versionId: Uuid },
): Promise<NarrativeRecord> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const record = await loadRecord(db, ctx, input.narrativeId);
  if (record.currentVersionId !== input.versionId) {
    throw new ValidationError(
      '確認しようとした版は最新ではありません。画面を開き直し、最新の版を確認してください。',
    );
  }
  const version = await db.findById('narrativeVersions', input.versionId);
  if (!version || version.narrativeRecordId !== record.id) {
    throw new NotFoundError('確認する版が見つかりません。');
  }
  if (record.status === 'confirmed' && record.confirmedVersionId === version.id) {
    throw new ValidationError('この版は既に確認済みです。');
  }
  const now = new Date().toISOString();
  const updated = await db.update('narrativeRecords', record.id, {
    status: 'confirmed',
    confirmedVersionId: version.id,
    confirmedBy: ctx.userId,
    confirmedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'narrative_confirmed',
    resourceType: 'narrative_record',
    resourceId: record.id,
    afterSummary: `${record.title}: 版 ${version.versionNo} を確認`,
    metadata: { versionId: version.id },
  });
  return updated;
}

export function isNarrativeStatus(value: unknown): value is NarrativeStatus {
  return typeof value === 'string' && (NARRATIVE_STATUSES as readonly string[]).includes(value);
}

export function isNarrativeTheme(value: unknown): value is NarrativeTheme {
  return typeof value === 'string' && (NARRATIVE_THEMES as readonly string[]).includes(value);
}
