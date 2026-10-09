import 'server-only';

import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import {
  TRACE_REASON_LABELS,
  findTraceUnits,
  type TraceSummary,
  type TraceUnit,
} from '@/lib/domain/report-trace';
import {
  EMPTY_EXPORT_CONTEXT,
  anchorDisplay,
  metricDisplay,
  renderBlockParagraphs,
  snapshotTrace,
  type ReportExportContext,
} from '@/lib/exports/disclosure-report';
import {
  loadOwnedProject,
  loadOwnedSnapshot,
  verifySnapshotIntegrity,
  type ReportSnapshotDetail,
  type SnapshotAnchor,
  type SnapshotBlock,
  type SnapshotFramework,
  type SnapshotMetricValue,
  type SnapshotRequirement,
} from '@/lib/services/report-snapshot';
import type { DbClient, Row, TableName, Where } from '@/lib/repositories/types';
import type { AuthorizationContext, IsoDateTime, Uuid } from '@/types/domain';

/**
 * スナップショットの内容とトレース（トライアル対応 NF-14。スライド 10 の評価 #1「出力レポートの本文・数値から
 * 要求事項・根拠・承認版へ遡る」「選定ケースの追跡率 100%」）。
 *
 *  - 追跡の判定は写し（スナップショット）だけから決める純関数（src/lib/domain/report-trace.ts）に任せる。
 *    ここは表示の材料（承認者の名前・定性情報の題名と版・根拠資料の名前）を足すだけで、何も書かない
 *  - 出力（DOCX・XLSX）と同じ材料を loadTraceContext で作る（画面と出力で追跡番号・追跡率を食い違わせない）
 *  - 権限（enterprise.disclosure.read）は ID の検索より先に確かめる。他テナントの ID は「見つからない」
 *  - 選定ケース（要求事項コードの集合）は URL の codes が優先。無ければトライアル計画の選定ケース
 *    （このプロジェクトを対象にした計画）、それも無ければ全件
 */

const MAX_QUERY_LENGTH = 200;

/** id の一覧で引く。空なら問い合わせない（PostgREST の in.() に空を渡さない） */
async function selectByIds<K extends TableName>(
  db: DbClient,
  table: K,
  ids: readonly Uuid[],
  organizationId: Uuid | null,
): Promise<Row<K>[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const where = organizationId ? { organizationId, id: { in: unique } } : { id: { in: unique } };
  return db.select(table, { where: where as Where<Row<K>> });
}

/**
 * 出力・トレース画面の表示の材料（根拠を持つ定性情報の版・承認者の名前・定性情報の題名と版・根拠資料）。
 * 定性情報の版・資料の版は追記専用で、同じスナップショットなら同じ結果になる（名前の表示を除く）
 */
export async function loadTraceContext(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
): Promise<Omit<ReportExportContext, 'requirements'>> {
  const organizationId = ctx.workspace.organizationId;
  const narrativeIds = new Set<Uuid>(snapshot.narrativeVersionIds);
  for (const block of snapshot.blocks) {
    for (const paragraph of block.body.paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'narrative') narrativeIds.add(inline.narrativeVersionId);
      }
    }
  }
  const narrativeVersions = await selectByIds(
    db,
    'narrativeVersions',
    [...narrativeIds],
    organizationId,
  );
  const records = await selectByIds(
    db,
    'narrativeRecords',
    narrativeVersions.map((v) => v.narrativeRecordId),
    organizationId,
  );
  const userIds = [
    snapshot.createdBy,
    ...snapshot.blocks.flatMap((b) =>
      b.approval ? [b.approval.approvedBy, b.approval.reviewedBy ?? ''] : [],
    ),
  ].filter((id) => id !== '');
  const profiles = await selectByIds(db, 'profiles', userIds, null);
  const fileVersionIds = [
    ...snapshot.metricValues.flatMap((m) => m.evidenceFileVersionIds ?? []),
    ...snapshot.anchors.map((a) => a.fileVersionId),
  ];
  const fileVersions = await selectByIds(db, 'fileVersions', fileVersionIds, organizationId);
  const files = await selectByIds(
    db,
    'files',
    fileVersions.map((v) => v.fileId),
    organizationId,
  );
  return {
    narrativeVersionsWithEvidence: new Set(
      narrativeVersions.filter((v) => v.sourceAnchorIds.length > 0).map((v) => v.id),
    ),
    userNames: new Map(profiles.map((p) => [p.id, p.displayName])),
    narratives: new Map(
      narrativeVersions.map((v) => [
        v.id,
        {
          title: records.find((r) => r.id === v.narrativeRecordId)?.title ?? '（定性情報）',
          versionNo: v.versionNo,
        },
      ]),
    ),
    fileVersions: new Map(
      fileVersions.map((v) => {
        const file = files.find((f) => f.id === v.fileId);
        return [
          v.id,
          {
            fileId: file?.id ?? null,
            fileName: file?.originalName ?? '（ファイル名不明）',
            versionNo: v.versionNo,
            // 機密区分が分からない資料は公開扱いにしない
            confidentiality: file?.confidentiality ?? 'confidential',
          },
        ];
      }),
    ),
  };
}

// ======================================================================
// 画面（スナップショットの内容とトレース）
// ======================================================================

export interface TraceParagraphView {
  paragraphId: string;
  kind: 'heading' | 'paragraph';
  /** 出力（社内確認用）と同じ文字列。追跡番号は付けない */
  text: string;
  /** 段落の追跡の単位（見出し・追跡の単位でない段落は null） */
  unit: TraceUnit | null;
  numbers: TraceUnit[];
}

export interface TraceBlockView {
  block: SnapshotBlock;
  /** 選定ケースに含まれる節か（含まれない節も本文は出す。追跡率の分母には入れない） */
  inScope: boolean;
  paragraphs: TraceParagraphView[];
}

export interface TraceEvidenceView {
  kind: 'anchor' | 'narrative' | 'metric_file';
  label: string;
  /** 資料の詳細へ（資料が分かるとき） */
  fileId: Uuid | null;
  page: number | null;
  quote: string | null;
}

export interface TraceMetricView {
  metric: SnapshotMetricValue;
  display: string;
  evidence: Array<{ fileId: Uuid | null; label: string }>;
}

export interface TraceUnitDetail {
  unit: TraceUnit;
  block: SnapshotBlock;
  requirements: SnapshotRequirement[];
  approval: {
    versionNo: number | null;
    isApprovedVersion: boolean;
    approvedByName: string | null;
    reviewedByName: string | null;
    approvedAt: IsoDateTime | null;
    reviewRequestId: Uuid | null;
  };
  evidence: TraceEvidenceView[];
  metrics: TraceMetricView[];
  narratives: Array<{
    versionId: Uuid;
    title: string;
    versionNo: number | null;
    hasEvidence: boolean;
  }>;
  reasonLabels: string[];
}

export type TraceCaseSource = 'query' | 'trial_program' | 'all';

export interface SnapshotTraceView {
  project: { id: Uuid; name: string };
  snapshot: ReportSnapshotDetail;
  integrityOk: boolean;
  frameworks: SnapshotFramework[];
  framework: SnapshotFramework | null;
  blocks: TraceBlockView[];
  units: TraceUnit[];
  summary: TraceSummary;
  caseSource: TraceCaseSource;
  /** トライアル計画の選定ケース（このプロジェクトが対象のとき。切替の候補に出す） */
  trialCaseCodes: string[] | null;
  createdByName: string;
  search: { query: string; hits: TraceUnit[] } | null;
  selected: TraceUnitDetail | null;
}

/** URL の codes（カンマ・読点・空白区切り）を要求事項コードの一覧にする */
export function parseTraceCodes(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const codes = value
    .split(/[,、\s]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length <= 40)
    .slice(0, 200);
  return codes.length > 0 ? [...new Set(codes)] : null;
}

/** トライアル計画の選定ケース（このプロジェクトを対象にした計画の要求事項のコード） */
async function trialCaseCodes(
  db: DbClient,
  organizationId: Uuid,
  projectId: Uuid,
): Promise<string[] | null> {
  const programs = await db.select('trialPrograms', { where: { organizationId } });
  const program = programs.find(
    (p) => p.projectId === projectId && p.selectedRequirementItemIds.length > 0,
  );
  if (!program) return null;
  const items = await db.select('disclosureItems', {
    where: { id: { in: program.selectedRequirementItemIds } },
  });
  const codes = [...new Set(items.map((i) => i.code))];
  return codes.length > 0 ? codes : null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function detailOf(
  snapshot: ReportSnapshotDetail,
  unit: TraceUnit,
  context: Omit<ReportExportContext, 'requirements'>,
): TraceUnitDetail | null {
  const block = snapshot.blocks.find((b) => b.blockId === unit.blockId);
  if (!block) return null;
  const paragraph = block.body.paragraphs.find((p) => p.id === unit.paragraphId);
  const nameOf = (id: Uuid | null | undefined) =>
    id ? (context.userNames.get(id) ?? '（利用者不明）') : null;
  const evidence: TraceEvidenceView[] = [];
  const narratives: TraceUnitDetail['narratives'] = [];
  const metricIds: Uuid[] = [];
  if (unit.kind === 'number') {
    if (unit.dataPointVersionId) metricIds.push(unit.dataPointVersionId);
  } else {
    for (const inline of paragraph?.children ?? []) {
      if (inline.t === 'cite') {
        const anchor = snapshot.anchors.find((a) => a.sourceAnchorId === inline.sourceAnchorId);
        if (anchor && !evidence.some((e) => e.label === anchorDisplay(anchor, 'internal'))) {
          evidence.push(anchorEvidence(anchor));
        }
      } else if (inline.t === 'narrative') {
        if (narratives.some((n) => n.versionId === inline.narrativeVersionId)) continue;
        const nv = context.narratives.get(inline.narrativeVersionId);
        narratives.push({
          versionId: inline.narrativeVersionId,
          title: nv?.title ?? '（定性情報）',
          versionNo: nv?.versionNo ?? null,
          hasEvidence: context.narrativeVersionsWithEvidence.has(inline.narrativeVersionId),
        });
      } else if (inline.t === 'metric') {
        if (!metricIds.includes(inline.dataPointVersionId))
          metricIds.push(inline.dataPointVersionId);
      }
    }
  }
  const metrics: TraceMetricView[] = metricIds.flatMap((id) => {
    const mv = snapshot.metricValues.find((m) => m.dataPointVersionId === id);
    if (!mv) return [];
    return [
      {
        metric: mv,
        display: metricDisplay(mv),
        evidence: (mv.evidenceFileVersionIds ?? []).map((fvId) => {
          const fv = context.fileVersions.get(fvId);
          return {
            fileId: fv?.fileId ?? null,
            label: fv
              ? `${fv.fileName}${fv.versionNo !== null ? ` 版${fv.versionNo}` : ''}`
              : '根拠資料',
          };
        }),
      },
    ];
  });
  return {
    unit,
    block,
    requirements: block.requirements,
    approval: {
      versionNo: block.versionNo,
      isApprovedVersion: block.isApprovedVersion,
      approvedByName: nameOf(block.approval?.approvedBy),
      reviewedByName: nameOf(block.approval?.reviewedBy),
      approvedAt: block.approval?.approvedAt ?? null,
      reviewRequestId: block.approval?.reviewRequestId ?? null,
    },
    evidence,
    metrics,
    narratives,
    reasonLabels: unit.reasons.map((r) => TRACE_REASON_LABELS[r]),
  };
}

function anchorEvidence(anchor: SnapshotAnchor): TraceEvidenceView {
  return {
    kind: 'anchor',
    label: anchorDisplay(anchor, 'internal'),
    fileId: anchor.fileId,
    page: anchor.page,
    quote: anchor.quoteText || null,
  };
}

/**
 * トレース画面の材料。frameworkVersionId を省くと先頭の基準。codes を渡すと選定ケース（分母が変わる）。
 * unit（追跡番号）を渡すとその単位の詳細、query を渡すと出力物の文・数値・追跡番号で探す
 */
export async function loadSnapshotTrace(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    projectId: Uuid;
    snapshotId: Uuid;
    frameworkVersionId?: Uuid | null;
    codes?: readonly string[] | null;
    /** 'all' なら選定ケースを使わず全件 */
    caseMode?: 'default' | 'all';
    unit?: string | null;
    query?: string | null;
  },
): Promise<SnapshotTraceView> {
  assertEnterpriseWorkspace(ctx);
  // 権限は ID の検索より先に確かめる（権限の無い人に、ID の有無で応答を変えない）
  assertCan(ctx, 'enterprise.disclosure.read');
  const project = await loadOwnedProject(db, ctx, input.projectId);
  const snapshot = await loadOwnedSnapshot(db, ctx, input.snapshotId);
  if (snapshot.projectId !== project.id) {
    throw new NotFoundError('スナップショットが見つかりません。');
  }
  const integrityOk = verifySnapshotIntegrity(snapshot);
  const context = await loadTraceContext(db, ctx, snapshot);
  const framework =
    snapshot.frameworkVersions.find((f) => f.frameworkVersionId === input.frameworkVersionId) ??
    snapshot.frameworkVersions[0] ??
    null;

  const programCodes = await trialCaseCodes(db, ctx.workspace.organizationId, project.id);
  const queryCodes = input.codes && input.codes.length > 0 ? [...input.codes] : null;
  const caseSource: TraceCaseSource = queryCodes
    ? 'query'
    : input.caseMode !== 'all' && programCodes
      ? 'trial_program'
      : 'all';
  const selectedCodes =
    caseSource === 'query' ? queryCodes : caseSource === 'trial_program' ? programCodes : null;

  const trace = snapshotTrace(
    snapshot,
    { ...EMPTY_EXPORT_CONTEXT, ...context },
    { frameworkVersionId: framework?.frameworkVersionId ?? null, selectedCodes },
  );
  const unitsByParagraph = new Map<string, TraceUnit[]>();
  for (const unit of trace.units) {
    const key = `${unit.blockId}:${unit.paragraphId}`;
    unitsByParagraph.set(key, [...(unitsByParagraph.get(key) ?? []), unit]);
  }
  const selectedSet = selectedCodes ? new Set(selectedCodes) : null;
  const blocks: TraceBlockView[] = framework
    ? snapshot.blocks
        .filter((b) => b.frameworkVersionId === framework.frameworkVersionId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((block) => ({
          block,
          inScope: !selectedSet || block.requirements.some((r) => selectedSet.has(r.code)),
          paragraphs: renderBlockParagraphs(block, snapshot, 'internal', []).map((p) => {
            const units = unitsByParagraph.get(`${block.blockId}:${p.paragraphId}`) ?? [];
            return {
              paragraphId: p.paragraphId,
              kind: p.kind,
              text: p.text,
              unit: units.find((u) => u.kind === 'paragraph') ?? null,
              numbers: units.filter((u) => u.kind === 'number'),
            };
          }),
        }))
    : [];

  // 出力物の文・数値・追跡番号から探す（出力と同じ文字列でも、本文の文字列でも当たるようにする）
  const query = input.query ? normalize(input.query).slice(0, MAX_QUERY_LENGTH) : '';
  let search: SnapshotTraceView['search'] = null;
  if (query !== '') {
    const rendered = new Map<string, string>();
    for (const view of blocks) {
      for (const p of view.paragraphs) {
        if (p.unit) rendered.set(p.unit.traceId, normalize(p.text));
      }
    }
    const metricText = (u: TraceUnit) => {
      const mv = u.dataPointVersionId
        ? snapshot.metricValues.find((m) => m.dataPointVersionId === u.dataPointVersionId)
        : undefined;
      return mv ? normalize(metricDisplay(mv)) : '';
    };
    const hits = new Map<string, TraceUnit>();
    for (const u of findTraceUnits(trace.units, query)) hits.set(u.traceId, u);
    for (const u of trace.units) {
      if (
        rendered.get(u.traceId)?.includes(query) ||
        (metricText(u) !== '' && metricText(u).includes(query))
      ) {
        hits.set(u.traceId, u);
      }
    }
    search = { query, hits: trace.units.filter((u) => hits.has(u.traceId)) };
  }

  const selectedUnit = input.unit
    ? (trace.units.find((u) => u.traceId === input.unit) ?? null)
    : null;
  const createdByName = context.userNames.get(snapshot.createdBy) ?? '—';
  return {
    project: { id: project.id, name: project.name },
    snapshot,
    integrityOk,
    frameworks: snapshot.frameworkVersions,
    framework,
    blocks,
    units: trace.units,
    summary: trace.summary,
    caseSource,
    trialCaseCodes: programCodes,
    createdByName,
    search,
    selected: selectedUnit ? detailOf(snapshot, selectedUnit, context) : null,
  };
}
