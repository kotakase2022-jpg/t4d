import 'server-only';

import { toCsv, type ExportColumn } from '@/lib/exports';
import {
  APPLICABILITY_STATUS_LABELS,
  AVAILABILITY_STATUS_LABELS,
  BLOCK_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  EVIDENCE_USAGE_PURPOSE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  frameworkLegalLabel,
  REPORT_SNAPSHOT_KIND_LABELS,
  REVIEW_COMMENT_SEVERITY_LABELS,
  VALUE_KIND_LABELS,
} from '@/lib/domain/disclosure-status';
import { valueKindMarker } from '@/lib/domain/disclosure-block';
import {
  MISMATCH_KIND_LABELS,
  reconciledCountsText,
  reconciliationStateOf,
  type DocxExpectation,
  type SheetExpectation,
} from '@/lib/domain/export-reconciliation';
import {
  buildReportTrace,
  TRACE_REASON_LABELS,
  type TraceSummary,
  type TraceUnit,
} from '@/lib/domain/report-trace';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import type {
  ReportSnapshotDetail,
  SnapshotAnchor,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotIssue,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';
import type {
  BlockInline,
  BlockParagraph,
  ConfidentialityLevel,
  ExportArtifact,
  ExportAudience,
  ExportReconciliation,
  IsoDateTime,
  Uuid,
} from '@/types/domain';

/**
 * 開示レポートの出力（DOCX 原稿・XLSX 対応表・定量 CSV、追跡表・突合結果の XLSX）。指示書 §6.10。
 *
 * 入力は必ずスナップショット（ReportSnapshotDetail）。ライブの行を引かない
 * （同じスナップショットからは、いつ出力しても同じ本文・数値・参照になる: A31）。
 * 例外は「表示の補助」だけで、呼び出し側が ReportExportContext として渡す: 根拠を持つ定性情報の版
 * （追記専用の版から決まる）・承認者の表示名・定性情報の題名と版番号・根拠資料の名前と版、
 * 対応表に足す要求事項の判断（節の無い要求事項・対象外の理由・判断者・承認者）。
 *
 * 対外用（external）は次を既定で含めない（A32）:
 *  - 社内コメント（review_comments の本文）と、その存在を示す確認事項
 *  - 公開資料（confidentiality = public）以外の資料のファイル名 → 「社内資料」とだけ書く
 *  - 作成者などの個人に関する情報（利用者 ID・氏名）。追跡表（承認者の氏名を含む）も社内確認用だけ
 *
 * 生成したファイルを「提出済み」とは扱わない（出力は開示先への提出ではない）。
 *
 * 出力物の突合（NF-15）は、ここで作る同じ描画の結果（docxExpectation・mappingWorkbookModel・
 * metricCsvExpectation）を期待値にして、生成したファイルを読み戻して照合する
 * （src/lib/services/export-reconciliation.ts）。描画と期待値を別に書かない（食い違いを作らない）。
 */

/**
 * 描画の版。同じスナップショットから描く本文・表紙が変わる変更をしたら必ず上げる
 * （export_artifacts に記録し、同じ内容ハッシュの出力の違いを説明できるようにする。§6.10・§10.3）。
 * tests/unit/disclosure-report-template.test.ts が描画結果の指紋をこの版と組で固定している。
 *  - v1: 初版
 *  - v2: 表紙の基準の位置付けを frameworkLegalLabel に統一（草案 →「公開草案に基づく準備」等）、
 *        本文の推計・目標の数値に区分（（推計）（目標））を添える
 *  - v3（トライアル対応 NF-04・NF-14・NF-15）: 社内確認用 DOCX の段落末に追跡番号（［T-…］）、巻末に追跡表。
 *        対外用 DOCX は本文を変えず、段落のブックマークに追跡番号。XLSX に「トレース」シート、
 *        対応表に節の無い要求事項の行・判断の列（対象外の理由・判断者・承認者・固定後の変更）、
 *        定性情報は題名と版番号で出す
 */
export const DISCLOSURE_REPORT_TEMPLATE_VERSION = 'disclosure-report-v3';

export const AUDIENCE_DISPLAY: Record<ExportAudience, string> = {
  internal: '社内確認用',
  external: '対外用（社内コメント・非公開資料名を除く）',
};

// ======================================================================
// 出力の補助情報（スナップショット以外から渡す表示の材料）
// ======================================================================

/** 対応表に足す要求事項の判断（要求事項 1 件＝1 行。src/lib/services/requirement-matrix.ts の行から作る） */
export interface RequirementExportRow {
  frameworkVersionId: Uuid;
  itemId: Uuid;
  code: string;
  section: string;
  text: string;
  decisionLabel: string;
  decisionSourceLabel: string;
  exclusionReason: string | null;
  decidedByName: string | null;
  approvedByName: string | null;
  approvedAt: IsoDateTime | null;
}

export interface RequirementExportContext {
  rows: readonly RequirementExportRow[];
  /**
   * 基準ごと: スナップショットを固定した後に要求事項の判断が変わったか。true なら「確定後に変更あり」
   * （判断の値は現在のもの）。固定していない（v1 の写し）・比べられない基準は null
   */
  changedSinceSnapshot: ReadonlyMap<Uuid, boolean | null>;
}

export interface ReportExportContext {
  /** 根拠（引用位置）を持つ定性情報の版（追跡の判定に使う。追記専用の版から決まる） */
  narrativeVersionsWithEvidence: ReadonlySet<Uuid>;
  /** 承認者・レビュー者の表示名（社内確認用の追跡表だけに出す） */
  userNames: ReadonlyMap<Uuid, string>;
  /** 定性情報の版 → 題名と版番号 */
  narratives: ReadonlyMap<Uuid, { title: string; versionNo: number }>;
  /** 根拠資料の版（file_versions.id）→ 資料名・版・機密区分 */
  fileVersions: ReadonlyMap<
    Uuid,
    {
      fileId: Uuid | null;
      fileName: string;
      versionNo: number | null;
      confidentiality: ConfidentialityLevel;
    }
  >;
  /** 対応表に足す要求事項の判断。null なら節の要求事項の行だけ（従来どおり） */
  requirements: RequirementExportContext | null;
}

export const EMPTY_EXPORT_CONTEXT: ReportExportContext = {
  narrativeVersionsWithEvidence: new Set(),
  userNames: new Map(),
  narratives: new Map(),
  fileVersions: new Map(),
  requirements: null,
};

// ======================================================================
// 数式インジェクション対策
// ======================================================================

/**
 * 表計算ソフトが数式として解釈しうる先頭文字（CSV の既存ガードと同じ集合）。
 * 企業が入力した文字列が相手先の表計算ソフトで開かれるため、出力側で無害化する。
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** 先頭が数式の開始文字なら ' を前置して文字列として扱わせる（値は読めるまま） */
export function neutralizeFormula(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.includes(text[0] ?? '') ? `'${text}` : text;
}

// ======================================================================
// 本文の描画（DOCX・テスト・画面の確認で共通）
// ======================================================================

export interface RenderedParagraph {
  paragraphId: string;
  kind: 'heading' | 'paragraph';
  text: string;
}

/** 出典の表示。対外用では公開資料以外のファイル名を出さない */
export function anchorDisplay(anchor: SnapshotAnchor, audience: ExportAudience): string {
  const position =
    anchor.page !== null ? ` p.${anchor.page}` : anchor.locator ? ` ${anchor.locator}` : '';
  if (audience === 'external' && !isPublic(anchor.confidentiality)) {
    return '社内資料';
  }
  const edition =
    audience === 'internal' && anchor.fileVersionNo !== null ? ` 版${anchor.fileVersionNo}` : '';
  return `${anchor.fileName}${edition}${position}`;
}

function isPublic(level: ConfidentialityLevel): boolean {
  return level === 'public';
}

/**
 * 数値の表示（固定した版の値と単位）。値が無い版は状態を書き、0 として出さない。
 * 本文では推計・目標の区分を添える（対外の本文で実績と読ませない。§7.1・§10.4）。
 * 付表のように区分の列を別に持つ表では withKind: false で値だけを出す
 */
export function metricDisplay(
  mv: SnapshotMetricValue,
  options: { withKind?: boolean } = {},
): string {
  const marker = options.withKind === false ? '' : valueKindMarker(mv.valueKind);
  if (mv.availabilityStatus === 'value_present' && mv.value !== null) {
    return `${`${formatNumber(mv.value)} ${mv.unitOfMeasure}`.trim()}${marker}`;
  }
  if (mv.textValue) return `${mv.textValue}${marker}`;
  return `（${AVAILABILITY_STATUS_LABELS[mv.availabilityStatus]}）`;
}

function inlineText(
  inline: BlockInline,
  snapshot: ReportSnapshotDetail,
  audience: ExportAudience,
): string {
  switch (inline.t) {
    case 'text':
      return inline.text;
    case 'metric': {
      const mv = snapshot.metricValues.find(
        (m) => m.dataPointVersionId === inline.dataPointVersionId,
      );
      return mv ? metricDisplay(mv) : inline.display;
    }
    case 'narrative':
      return inline.quote;
    case 'cite': {
      const anchor = snapshot.anchors.find((a) => a.sourceAnchorId === inline.sourceAnchorId);
      return anchor ? `［出典: ${anchorDisplay(anchor, audience)}］` : '［出典: 不明］';
    }
  }
}

/**
 * 対外用で伏せる資料名（非公開の資料のファイル名）。出典印だけでなく、定性情報の引用文や地の文に
 * 書かれたファイル名も伏せる（以前の「資料から候補」は定性情報の本文にファイル名を書いていた）
 */
export function externalMaskedNames(
  snapshot: Pick<ReportSnapshotDetail, 'anchors'>,
  extraNonPublicFileNames: readonly string[] = [],
): string[] {
  const names = [
    ...snapshot.anchors.filter((a) => !isPublic(a.confidentiality)).map((a) => a.fileName),
    ...extraNonPublicFileNames,
  ]
    .map((n) => n.trim())
    // 短すぎる名前で本文の普通の語を伏せない
    .filter((n) => n.length >= 3);
  // 長い名前から置き換える（短い名前が長い名前の一部のとき、長い方を先に伏せる）
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

function maskNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) out = out.split(name).join('社内資料');
  return out;
}

/** 節の本文を段落ごとの文字列にする（節名と同じ見出し段落は重ねて出さない） */
export function renderBlockParagraphs(
  block: SnapshotBlock,
  snapshot: ReportSnapshotDetail,
  audience: ExportAudience,
  /** 対外用で伏せる資料名（externalMaskedNames）。社内確認用では使わない */
  maskedNames: readonly string[] = externalMaskedNames(snapshot),
): RenderedParagraph[] {
  return block.body.paragraphs
    .map((p) => {
      // 対外用では複数の非公開資料が同じ「社内資料」になるため、続けて同じ出典印を重ねない
      let previousCite: string | null = null;
      const parts: string[] = [];
      for (const inline of p.children) {
        const text = inlineText(inline, snapshot, audience);
        if (inline.t === 'cite') {
          if (text === previousCite) continue;
          previousCite = text;
        } else {
          previousCite = null;
        }
        // 出典印以外（地の文・定性情報の引用文）に書かれた非公開資料の名前も、対外用では伏せる
        parts.push(
          audience === 'external' && inline.t !== 'cite' ? maskNames(text, maskedNames) : text,
        );
      }
      return { paragraphId: p.id, kind: p.kind, text: parts.join('') };
    })
    .filter((p) => !(p.kind === 'heading' && p.text.trim() === block.title.trim()))
    .filter((p) => p.text.trim().length > 0);
}

// ======================================================================
// 追跡番号（NF-14）
// ======================================================================

/** 追跡の計算（写しと根拠を持つ定性情報の版だけから決まる）。frameworkVersionId で基準を絞る */
export function snapshotTrace(
  snapshot: ReportSnapshotDetail,
  context: Pick<ReportExportContext, 'narrativeVersionsWithEvidence'>,
  options: { frameworkVersionId?: Uuid | null; selectedCodes?: readonly string[] | null } = {},
): { units: TraceUnit[]; summary: TraceSummary } {
  return buildReportTrace(
    {
      blocks: snapshot.blocks,
      metricValues: snapshot.metricValues,
      narrativeVersionsWithEvidence: context.narrativeVersionsWithEvidence,
    },
    options,
  );
}

/** 段落の追跡番号（`節 ID:段落 ID` → 追跡番号）。段落 ID は節をまたいで重なりうるため節と組で引く */
export function paragraphTraceIds(units: readonly TraceUnit[]): Map<string, string> {
  return new Map(
    units
      .filter((u) => u.kind === 'paragraph')
      .map((u) => [`${u.blockId}:${u.paragraphId}`, u.traceId]),
  );
}

/** 社内確認用の段落の末尾に付ける追跡番号 */
export function traceSuffix(traceId: string): string {
  return ` ［${traceId}］`;
}

/** Word のブックマーク名（英字で始まり、英数字と _ だけ。追跡番号の - を _ に置き換える） */
export function traceBookmarkName(traceId: string): string {
  return traceId.replace(/[^A-Za-z0-9]/g, '_');
}

export interface RenderedTracedParagraph extends RenderedParagraph {
  /** 本文のある段落の追跡番号（見出し・追跡の単位でない段落は null） */
  traceId: string | null;
}

/** 節の本文の段落に追跡番号を添える（文字列は renderBlockParagraphs と同じ） */
export function renderTracedParagraphs(
  block: SnapshotBlock,
  snapshot: ReportSnapshotDetail,
  audience: ExportAudience,
  maskedNames: readonly string[],
  traceIds: ReadonlyMap<string, string>,
): RenderedTracedParagraph[] {
  return renderBlockParagraphs(block, snapshot, audience, maskedNames).map((p) => ({
    ...p,
    traceId:
      p.kind === 'paragraph' ? (traceIds.get(`${block.blockId}:${p.paragraphId}`) ?? null) : null,
  }));
}

/** 出力に書く段落の文字列（社内確認用は追跡番号を末尾に付ける。対外用は本文を変えない） */
export function outputParagraphText(
  paragraph: RenderedTracedParagraph,
  audience: ExportAudience,
): string {
  return audience === 'internal' && paragraph.traceId
    ? `${paragraph.text}${traceSuffix(paragraph.traceId)}`
    : paragraph.text;
}

const TRACE_KIND_LABELS: Record<TraceUnit['kind'], string> = { paragraph: '段落', number: '数値' };

function paragraphOf(snapshot: ReportSnapshotDetail, unit: TraceUnit): BlockParagraph | undefined {
  return snapshot.blocks
    .find((b) => b.blockId === unit.blockId)
    ?.body.paragraphs.find((p) => p.id === unit.paragraphId);
}

/** 追跡の単位の根拠（社内確認用の表示。段落は出典印と根拠つきの定性情報、数値は根拠資料の版） */
export function traceEvidenceText(
  snapshot: ReportSnapshotDetail,
  unit: TraceUnit,
  context: ReportExportContext,
): string {
  if (unit.kind === 'number') {
    const mv = snapshot.metricValues.find((m) => m.dataPointVersionId === unit.dataPointVersionId);
    const ids = mv?.evidenceFileVersionIds ?? [];
    const names = ids.map((id) => {
      const fv = context.fileVersions.get(id);
      return fv ? `${fv.fileName}${fv.versionNo !== null ? ` 版${fv.versionNo}` : ''}` : '根拠資料';
    });
    return [...new Set(names)].join('、') || '—';
  }
  const paragraph = paragraphOf(snapshot, unit);
  const parts: string[] = [];
  for (const inline of paragraph?.children ?? []) {
    if (inline.t === 'cite') {
      const anchor = snapshot.anchors.find((a) => a.sourceAnchorId === inline.sourceAnchorId);
      parts.push(anchor ? anchorDisplay(anchor, 'internal') : '出典不明');
    } else if (
      inline.t === 'narrative' &&
      context.narrativeVersionsWithEvidence.has(inline.narrativeVersionId)
    ) {
      const nv = context.narratives.get(inline.narrativeVersionId);
      parts.push(nv ? `定性情報「${nv.title}」版${nv.versionNo}の根拠` : '定性情報の根拠');
    } else if (inline.t === 'metric') {
      parts.push('数値の参照');
    }
  }
  return [...new Set(parts)].join('、') || '—';
}

/** 追跡の単位の数値の版（段落は段落の中で引用した数値、数値はその版） */
export function traceMetricText(snapshot: ReportSnapshotDetail, unit: TraceUnit): string {
  const ids =
    unit.kind === 'number'
      ? unit.dataPointVersionId
        ? [unit.dataPointVersionId]
        : []
      : (paragraphOf(snapshot, unit)?.children ?? []).flatMap((inline) =>
          inline.t === 'metric' ? [inline.dataPointVersionId] : [],
        );
  const texts = ids.map((id) => {
    const mv = snapshot.metricValues.find((m) => m.dataPointVersionId === id);
    return mv
      ? `${mv.metricName}／${mv.unitName}／${mv.periodCode}／版 ${mv.versionNo}（${mv.versionApproved ? '承認済み' : '未承認'}）`
      : '（写しに無い版）';
  });
  if (unit.kind === 'number' && ids.length === 0) return '参照なし（本文に直接書いた数値）';
  return [...new Set(texts)].join('、') || '—';
}

function approvedVersionText(block: SnapshotBlock | undefined): string {
  if (!block) return '—';
  if (block.versionNo === null) return '版なし';
  return `版 ${block.versionNo}（${block.isApprovedVersion ? '承認済み' : '未承認'}）`;
}

export const TRACE_TABLE_HEADERS = [
  '追跡番号',
  '種別',
  '節',
  '要求事項',
  '承認版',
  '承認者',
  '承認日時',
  '根拠',
  '数値の版',
  '追跡',
  '理由',
] as const;

/** 追跡表の行（社内確認用の DOCX・追跡表 XLSX で同じ列。空のセルを作らない＝読み戻しで照合できる） */
export function traceTableRows(
  snapshot: ReportSnapshotDetail,
  units: readonly TraceUnit[],
  context: ReportExportContext,
): string[][] {
  return units.map((u) => {
    const block = snapshot.blocks.find((b) => b.blockId === u.blockId);
    return [
      u.traceId,
      TRACE_KIND_LABELS[u.kind],
      u.blockTitle || '—',
      u.requirementCodes.join('、') || '—',
      approvedVersionText(block),
      u.approvedBy ? (context.userNames.get(u.approvedBy) ?? '（利用者不明）') : '—',
      u.approvedAt ? formatJst(u.approvedAt) : '—',
      traceEvidenceText(snapshot, u, context),
      traceMetricText(snapshot, u),
      u.traceable ? '追跡できる' : '追跡できない',
      u.reasons.map((r) => TRACE_REASON_LABELS[r]).join(' ') || '—',
    ];
  });
}

/**
 * 確認事項の表示。対外用は社内コメントの存在・定性情報の台帳名などを出さず、区分だけにする。
 */
export function issueDisplay(issue: SnapshotIssue, audience: ExportAudience): string | null {
  if (audience === 'internal') return issue.message;
  switch (issue.code) {
    case 'not_approved':
      return '未承認';
    case 'narrative_missing_fields':
      return '不足情報あり';
    case 'no_body':
      return '本文なし';
    case 'stale_metric_refs':
    case 'stale_narrative_refs':
      return '引用した情報の再確認が必要';
    case 'metric_not_approved':
    case 'metric_value_absent':
    case 'metric_missing':
      return '数値の確認が必要';
    case 'unresolved_major_comments':
    case 'unadopted_ai_candidate':
      // 社内のコメント・AI 候補の存在は対外用に出さない（未承認の表示で足りる）
      return null;
    default:
      return '確認事項あり';
  }
}

function blockIssueLines(block: SnapshotBlock, audience: ExportAudience): string[] {
  return [
    ...new Set(
      block.issues
        .map((issue) => issueDisplay(issue, audience))
        .filter((line): line is string => line !== null),
    ),
  ];
}

// ======================================================================
// 表示の共通部品
// ======================================================================

export function frameworksOf(snapshot: ReportSnapshotDetail): SnapshotFramework[] {
  return snapshot.frameworkVersions;
}

export function blocksOfFramework(
  snapshot: ReportSnapshotDetail,
  frameworkVersionId: Uuid,
): SnapshotBlock[] {
  return snapshot.blocks
    .filter((b) => b.frameworkVersionId === frameworkVersionId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 原稿の区分の表示。社内承認を保証・法定準拠の確定と取り違えさせない */
export function statusLine(snapshot: ReportSnapshotDetail, framework: SnapshotFramework): string {
  if (snapshot.snapshotKind === 'review_draft') {
    const hasIssues = snapshot.blocks.some(
      (b) => b.frameworkVersionId === framework.frameworkVersionId && b.issues.length > 0,
    );
    return hasIssues ? '草稿・未承認箇所あり（レビュー用）' : '草稿（レビュー用）';
  }
  return framework.draftStandardPrep
    ? `${REPORT_SNAPSHOT_KIND_LABELS.approved}（草案基準による準備。法定準拠の確定ではありません）`
    : `${REPORT_SNAPSHOT_KIND_LABELS.approved}（第三者による保証ではありません）`;
}

/** 出力ファイルに必ず載せる注意。ファイルを作ったことを提出・公表と取り違えさせない（§6.10） */
export const NOT_SUBMISSION_NOTICE =
  'ファイル作成は提出ではありません（開示先への提出・公表を意味しません）。内容は T4D のスナップショットに固定した版から生成しています。';

/** 社内承認を第三者保証と取り違えさせない注意（追跡表・突合結果の出力に載せる） */
export const INTERNAL_APPROVAL_NOTICE = '社内承認であり第三者保証ではありません。';

/** 突合の位置付け（突合結果の出力・画面で同じ文言） */
export const RECONCILIATION_NOTICE = '突合は T4D が生成したファイルと承認版の照合です。';

/** 表紙の「基準の位置付け」。草案は「公開草案に基づく準備」（画面と同じ文言。§8.1） */
function legalStatusText(framework: SnapshotFramework): string {
  return framework.legalStatus || framework.coverageStatus
    ? frameworkLegalLabel({
        legalStatus: framework.legalStatus,
        coverageStatus: framework.coverageStatus,
      })
    : '未確認';
}

function coverageText(framework: SnapshotFramework): string {
  return framework.coverageStatus
    ? FRAMEWORK_COVERAGE_STATUS_LABELS[framework.coverageStatus]
    : '未確認';
}

function periodText(framework: SnapshotFramework): string {
  return framework.periodStart && framework.periodEnd
    ? `${framework.periodStart}〜${framework.periodEnd}`
    : '—';
}

function kindText(snapshot: ReportSnapshotDetail): string {
  return REPORT_SNAPSHOT_KIND_LABELS[snapshot.snapshotKind];
}

export function coverRows(
  snapshot: ReportSnapshotDetail,
  framework: SnapshotFramework,
  audience: ExportAudience,
): Array<[string, string]> {
  return [
    ['報告主体', framework.reportingEntity || '—'],
    ['対象期間', periodText(framework)],
    ['基準', framework.label],
    ['基準の版', framework.versionCode ?? '—'],
    ['基準の位置付け', legalStatusText(framework)],
    ['要求事項の収録', coverageText(framework)],
    ['適用判断', APPLICABILITY_STATUS_LABELS[framework.applicabilityStatus]],
    ['目的', framework.purpose ? DISCLOSURE_PURPOSE_LABELS[framework.purpose] : '—'],
    ['区分', statusLine(snapshot, framework)],
    ['スナップショット', `${kindText(snapshot)} No.${snapshot.snapshotNo}`],
    ['スナップショットの作成日時', formatJst(snapshot.createdAt)],
    ['内容ハッシュ', snapshot.contentHash],
    ['出力区分', AUDIENCE_DISPLAY[audience]],
    ['テンプレート', DISCLOSURE_REPORT_TEMPLATE_VERSION],
  ];
}

// ======================================================================
// DOCX（基準ごとの原稿）
// ======================================================================

export interface DocxBuildOptions {
  audience: ExportAudience;
  frameworkVersionId: Uuid;
  /**
   * スナップショットの引用位置以外で伏せる非公開資料の名前。スナップショットに固定した一覧
   * （frozenMaskedFileNames）を渡す。固定していない古いスナップショットだけ出力時の資料一覧を渡す
   */
  nonPublicFileNames?: readonly string[];
}

/** 本文の節の見出しの次に置く「未承認」の注記（未承認の版を固定した草稿の節） */
function unapprovedMarker(block: SnapshotBlock): string | null {
  if (block.isApprovedVersion) return null;
  return `［未承認: ${BLOCK_STATUS_LABELS[block.status]}${block.versionNo !== null ? `・版 ${block.versionNo}` : ''}］`;
}

/** 本文が無い節に書く文 */
export const NO_BODY_TEXT = '（本文なし）';

export const CITED_TABLE_HEADING = '付表 本文で引用した数値';
export const CITED_TABLE_HEADERS = ['指標', '組織・拠点', '対象期間', '境界', '値', '区分', '版'];
export const TRACE_TABLE_HEADING = '追跡表（社内確認用）';

/** DOCX の本文・付表・追跡表の中身（描画と突合の期待値で同じものを使う） */
export interface DocxBodyModel {
  framework: SnapshotFramework;
  blocks: Array<{
    block: SnapshotBlock;
    marker: string | null;
    paragraphs: RenderedTracedParagraph[];
  }>;
  citedRows: string[][];
  /** 追跡表の行（社内確認用だけ。対外用は null） */
  traceRows: string[][] | null;
}

export function docxBodyModel(
  snapshot: ReportSnapshotDetail,
  options: DocxBuildOptions,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): DocxBodyModel {
  const framework = snapshot.frameworkVersions.find(
    (f) => f.frameworkVersionId === options.frameworkVersionId,
  );
  if (!framework) throw new Error('スナップショットに含まれない基準です。');
  const maskedNames = externalMaskedNames(snapshot, options.nonPublicFileNames ?? []);
  const trace = snapshotTrace(snapshot, context, {
    frameworkVersionId: framework.frameworkVersionId,
  });
  const traceIds = paragraphTraceIds(trace.units);
  const blocks = blocksOfFramework(snapshot, framework.frameworkVersionId);

  const citedVersionIds = new Set(
    blocks.flatMap((b) =>
      b.body.paragraphs.flatMap((p) =>
        p.children.flatMap((inline) => (inline.t === 'metric' ? [inline.dataPointVersionId] : [])),
      ),
    ),
  );
  const cited = snapshot.metricValues.filter((mv) => citedVersionIds.has(mv.dataPointVersionId));
  return {
    framework,
    blocks: blocks.map((block) => ({
      block,
      marker: unapprovedMarker(block),
      paragraphs: renderTracedParagraphs(block, snapshot, options.audience, maskedNames, traceIds),
    })),
    citedRows: cited.map((mv) => [
      mv.metricName,
      mv.unitName,
      mv.periodStart && mv.periodEnd ? `${mv.periodStart}〜${mv.periodEnd}` : mv.periodCode,
      mv.boundary,
      metricDisplay(mv, { withKind: false }),
      VALUE_KIND_LABELS[mv.valueKind],
      `版 ${mv.versionNo}`,
    ]),
    traceRows:
      options.audience === 'internal' ? traceTableRows(snapshot, trace.units, context) : null,
  };
}

/** 突合の期待値（DOCX）。描画と同じ中身から作る */
export function docxExpectation(
  snapshot: ReportSnapshotDetail,
  options: DocxBuildOptions,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): DocxExpectation {
  const model = docxBodyModel(snapshot, options, context);
  return {
    blocks: model.blocks.map(({ block, marker, paragraphs }) => ({
      title: block.title,
      marker,
      paragraphs:
        paragraphs.length === 0
          ? [{ location: `${block.title} 本文`, text: NO_BODY_TEXT }]
          : paragraphs.map((p, index) => ({
              location: `${block.title} 段落 ${index + 1}${p.traceId ? `（${p.traceId}）` : ''}`,
              text: outputParagraphText(p, options.audience),
            })),
    })),
    numberTable:
      model.citedRows.length > 0
        ? {
            heading: CITED_TABLE_HEADING,
            header: CITED_TABLE_HEADERS,
            rows: model.citedRows.map((cells, index) => ({
              location: `付表 ${index + 1} 行目（${cells[0]}）`,
              cells,
            })),
          }
        : null,
    // 追跡の単位が無い社内確認用は、表の代わりに文を置く（照合する表が無い）
    traceTable:
      model.traceRows && model.traceRows.length > 0
        ? {
            heading: TRACE_TABLE_HEADING,
            header: [...TRACE_TABLE_HEADERS],
            rows: model.traceRows.map((cells) => ({ location: `追跡表 ${cells[0]}`, cells })),
          }
        : null,
  };
}

export async function buildDisclosureDocx(
  snapshot: ReportSnapshotDetail,
  options: DocxBuildOptions,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): Promise<Uint8Array> {
  const model = docxBodyModel(snapshot, options, context);
  const { framework } = model;
  const { audience } = options;

  const {
    Bookmark,
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    TextRun,
    WidthType,
  } = await import('docx');

  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const children: Child[] = [];

  const table = (headers: readonly string[] | null, rows: string[][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        ...(headers
          ? [
              new TableRow({
                tableHeader: true,
                children: headers.map(
                  (h) =>
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun({ text: h, bold: true })] }),
                      ],
                    }),
                ),
              }),
            ]
          : []),
        ...rows.map(
          (row) =>
            new TableRow({
              children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
            }),
        ),
      ],
    });

  // --- 表紙 ---------------------------------------------------------------
  children.push(new Paragraph({ text: framework.projectName, heading: HeadingLevel.TITLE }));
  children.push(
    new Paragraph({ text: `開示原稿 — ${framework.label}`, heading: HeadingLevel.HEADING_2 }),
  );
  children.push(
    new Paragraph({
      children: [new TextRun({ text: statusLine(snapshot, framework), bold: true })],
    }),
  );
  children.push(
    new Paragraph({
      children: [new TextRun({ text: NOT_SUBMISSION_NOTICE, italics: true, size: 18 })],
    }),
  );
  if (framework.coverageStatus === 'not_loaded' || framework.coverageStatus === 'sample') {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `この基準の要求事項は「${coverageText(framework)}」です。要求事項への準拠を示す原稿ではありません。${framework.coverageNote ? `（${framework.coverageNote}）` : ''}`,
            italics: true,
            size: 18,
          }),
        ],
      }),
    );
  }
  children.push(table(null, coverRows(snapshot, framework, audience)));

  // --- 草稿: 未承認箇所・不足情報 ----------------------------------------------
  if (snapshot.snapshotKind === 'review_draft') {
    const lines = model.blocks.flatMap(({ block }) =>
      blockIssueLines(block, audience).map((line) => `・${block.title}: ${line}`),
    );
    children.push(new Paragraph({ text: '未承認箇所・不足情報', heading: HeadingLevel.HEADING_1 }));
    if (lines.length === 0) {
      children.push(new Paragraph('なし（すべての節が承認済みの版です）'));
    } else {
      for (const line of lines) children.push(new Paragraph(line));
    }
  }

  // --- 本文 ---------------------------------------------------------------
  for (const { block, marker, paragraphs } of model.blocks) {
    children.push(new Paragraph({ text: block.title, heading: HeadingLevel.HEADING_1 }));
    if (marker) {
      children.push(new Paragraph({ children: [new TextRun({ text: marker, bold: true })] }));
    }
    if (paragraphs.length === 0) {
      children.push(new Paragraph(NO_BODY_TEXT));
    }
    for (const p of paragraphs) {
      if (p.kind === 'heading') {
        children.push(new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_2 }));
        continue;
      }
      if (!p.traceId) {
        children.push(new Paragraph(p.text));
      } else if (audience === 'internal') {
        // 社内確認用: 段落末に小さな追跡番号（トレース画面・追跡表・XLSX のトレースと同じ番号）
        children.push(
          new Paragraph({
            children: [
              new TextRun(p.text),
              new TextRun({ text: traceSuffix(p.traceId), size: 16 }),
            ],
          }),
        );
      } else {
        // 対外用: 本文の文字は変えず、見えないブックマークに追跡番号を入れる
        children.push(
          new Paragraph({
            children: [
              new Bookmark({
                id: traceBookmarkName(p.traceId),
                children: [new TextRun(p.text)],
              }),
            ],
          }),
        );
      }
    }
  }

  // --- 付表: 本文で引用した数値 ---------------------------------------------------
  if (model.citedRows.length > 0) {
    children.push(new Paragraph({ text: CITED_TABLE_HEADING, heading: HeadingLevel.HEADING_1 }));
    children.push(table(CITED_TABLE_HEADERS, model.citedRows));
  }

  // --- 社内確認用だけ: 追跡表・節の版と社内コメント -----------------------------------
  if (audience === 'internal') {
    children.push(new Paragraph({ text: TRACE_TABLE_HEADING, heading: HeadingLevel.HEADING_1 }));
    if (model.traceRows && model.traceRows.length > 0) {
      children.push(table(TRACE_TABLE_HEADERS, model.traceRows));
    } else {
      children.push(new Paragraph('追跡の対象（本文のある段落・数値）はありません。'));
    }
    children.push(
      new Paragraph({ text: '節の版と承認状態（社内確認用）', heading: HeadingLevel.HEADING_1 }),
    );
    children.push(
      table(
        ['節', '版', '状態', '承認済みの版を固定', '要求事項'],
        model.blocks.map(({ block: b }) => [
          b.title,
          b.versionNo !== null ? `版 ${b.versionNo}` : '版なし',
          BLOCK_STATUS_LABELS[b.status],
          b.isApprovedVersion ? 'はい' : 'いいえ',
          b.requirements.map((r) => r.code).join('、') || '—',
        ]),
      ),
    );
    const comments = model.blocks.flatMap(({ block: b }) =>
      b.internalComments.map(
        (c) =>
          `・${b.title}${c.paragraphId ? `（段落 ${c.paragraphId}）` : ''}［${REVIEW_COMMENT_SEVERITY_LABELS[c.severity]}］${c.body}`,
      ),
    );
    children.push(
      new Paragraph({
        text: '社内コメント（対外用の原稿には含めません）',
        heading: HeadingLevel.HEADING_1,
      }),
    );
    if (comments.length === 0) children.push(new Paragraph('未解決のコメントはありません。'));
    for (const line of comments) children.push(new Paragraph(line));
  }

  const doc = new Document({
    creator: 'TERRAST for Disclosure (T4D)',
    title: `${framework.projectName} 開示原稿`,
    description: `${kindText(snapshot)} No.${snapshot.snapshotNo} / ${DISCLOSURE_REPORT_TEMPLATE_VERSION}`,
    sections: [{ children: children as never[] }],
  });
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

// ======================================================================
// XLSX（社内確認用の対応表・追跡表・突合結果）
// ======================================================================

type CellValue = string | number | null;

/** 表計算のシートの中身（描画と突合の期待値で同じものを使う） */
export interface XlsxSheetModel {
  name: string;
  header: string[];
  rows: Array<{ kind: 'paragraph' | 'number' | 'row'; cells: CellValue[] }>;
  widths: number[];
}

/** 書き出すセルの値（文字列は数式の開始文字を無害化。読み戻しの期待値も同じ値） */
export function xlsxCellValue(value: CellValue): CellValue {
  return typeof value === 'string' ? neutralizeFormula(value) : value;
}

/** 突合の期待値（表計算）。書き出すときと同じ無害化を通す */
export function sheetExpectations(sheets: readonly XlsxSheetModel[]): SheetExpectation[] {
  return sheets.map((sheet) => ({
    name: sheet.name,
    header: sheet.header.map(xlsxCellValue),
    rows: sheet.rows.map((row) => ({ kind: row.kind, cells: row.cells.map(xlsxCellValue) })),
  }));
}

/** シートの中身を XLSX にする（文字列は「文字列」書式・数式の無害化・見出しの固定） */
async function writeWorkbook(
  sheets: readonly XlsxSheetModel[],
  meta: { title: string; createdAt: IsoDateTime },
): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TERRAST for Disclosure (T4D)';
  // 生成時刻ではなくスナップショットの時刻を入れる（同じスナップショットの出力で揃える）
  workbook.created = new Date(meta.createdAt);
  workbook.modified = new Date(meta.createdAt);
  workbook.title = meta.title;

  type Worksheet = ReturnType<typeof workbook.addWorksheet>;
  /**
   * すべての文字列セルを「文字列」書式にし、数式の開始文字を無害化する。
   * exceljs は文字列を共有文字列として書くため現状でも数式にはならないが、
   * 将来の書式変更や別ツールでの再保存で数式に化けないよう出力側で固定する。
   */
  const addRow = (ws: Worksheet, values: CellValue[], header = false) => {
    const row = ws.addRow(values.map(xlsxCellValue));
    row.eachCell((cell) => {
      // 列単位の書式にすると見出し（文字列）まで数値書式になるため、セルごとに決める
      cell.numFmt = typeof cell.value === 'number' ? '#,##0.###' : '@';
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    if (header) {
      row.font = { bold: true };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF3FF' } };
    }
  };

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    addRow(ws, sheet.header, true);
    for (const row of sheet.rows) addRow(ws, row.cells);
    sheet.widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

function confidentialityText(level: ConfidentialityLevel): string {
  switch (level) {
    case 'public':
      return '公開';
    case 'internal':
      return '社内';
    case 'confidential':
      return '機密';
    case 'restricted':
      return '厳秘';
  }
}

function approvalStateText(block: SnapshotBlock): string {
  if (block.isApprovedVersion) return `承認済み（版 ${block.versionNo ?? '—'}）`;
  return `未承認（${BLOCK_STATUS_LABELS[block.status]}）`;
}

function metricVersionText(mv: SnapshotMetricValue): string {
  return `${mv.metricName}／${mv.unitName}／${mv.periodCode}／版 ${mv.versionNo}（${mv.versionApproved ? '承認済み' : '未承認'}）／${mv.dataPointVersionId}`;
}

/** 定性情報の版の表示（題名と版番号。分からなければ版 ID） */
function narrativeText(versionId: Uuid, context: ReportExportContext): string {
  const nv = context.narratives.get(versionId);
  return nv ? `${nv.title}（版 ${nv.versionNo}）` : versionId;
}

/** 固定後の変更の表示（基準ごと） */
function changedSinceText(
  frameworkVersionId: Uuid,
  requirements: RequirementExportContext | null,
): string {
  if (!requirements) return '';
  const changed = requirements.changedSinceSnapshot.get(frameworkVersionId);
  if (changed === true) return '確定後に変更あり（判断は現在の値）';
  if (changed === false) return 'なし';
  return '固定なし（現在の判断）';
}

/** 判断の列（要求事項の判断が無ければ空欄） */
function decisionCells(
  row: RequirementExportRow | undefined,
  frameworkVersionId: Uuid,
  requirements: RequirementExportContext | null,
): CellValue[] {
  if (!requirements) return ['', '', '', '', '', '', ''];
  return [
    row?.decisionLabel ?? '',
    row?.decisionSourceLabel ?? '',
    row?.exclusionReason ?? '',
    row?.decidedByName ?? '',
    row?.approvedByName ?? '',
    row?.approvedAt ? formatJst(row.approvedAt) : '',
    changedSinceText(frameworkVersionId, requirements),
  ];
}

/** 対応表に要求事項がない行の印 */
export const NO_BLOCK_TEXT = '（原稿の節なし）';

/** 対応表の行（テストからも同じ行を検査する） */
export function mappingRows(
  snapshot: ReportSnapshotDetail,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): CellValue[][] {
  const rows: CellValue[][] = [];
  const requirements = context.requirements;
  const requirementById = new Map((requirements?.rows ?? []).map((r) => [r.itemId, r]));
  for (const framework of snapshot.frameworkVersions) {
    const covered = new Set<Uuid>();
    for (const block of blocksOfFramework(snapshot, framework.frameworkVersionId)) {
      const inlines = block.body.paragraphs.flatMap((p) => p.children);
      const anchors = inlines
        .filter((i): i is Extract<BlockInline, { t: 'cite' }> => i.t === 'cite')
        .map((i) => snapshot.anchors.find((a) => a.sourceAnchorId === i.sourceAnchorId))
        .filter((a): a is SnapshotAnchor => Boolean(a));
      const metrics = inlines
        .filter((i): i is Extract<BlockInline, { t: 'metric' }> => i.t === 'metric')
        .map((i) =>
          snapshot.metricValues.find((m) => m.dataPointVersionId === i.dataPointVersionId),
        )
        .filter((m): m is SnapshotMetricValue => Boolean(m));
      const narratives = inlines
        .filter((i): i is Extract<BlockInline, { t: 'narrative' }> => i.t === 'narrative')
        .map((i) => i.narrativeVersionId);

      const evidence = [
        ...new Set(anchors.map((a) => `${anchorDisplay(a, 'internal')}（${a.sourceAnchorId}）`)),
      ].join('\n');
      const metricText = [...new Set(metrics.map(metricVersionText))].join('\n');
      const narrativeLines = [...new Set(narratives)].map((id) => narrativeText(id, context));
      const issues = block.issues.map((i) => i.message).join('\n');
      const requirementList =
        block.requirements.length > 0
          ? block.requirements
          : [{ itemId: '', code: '', section: '', text: '（要求事項の紐付けなし）' }];
      for (const requirement of requirementList) {
        if (requirement.itemId) covered.add(requirement.itemId);
        rows.push([
          framework.label,
          framework.versionCode ?? '',
          requirement.code,
          requirement.section,
          requirement.text,
          block.title,
          block.versionNo !== null ? `版 ${block.versionNo}` : '版なし',
          block.versionId ?? '',
          BLOCK_STATUS_LABELS[block.status],
          approvalStateText(block),
          evidence,
          metricText,
          narrativeLines.join('\n'),
          issues,
          ...decisionCells(
            requirement.itemId ? requirementById.get(requirement.itemId) : undefined,
            framework.frameworkVersionId,
            requirements,
          ),
        ]);
      }
    }
    // 節の無い要求事項（対象外・未判定・未対応を消さない。NF-04）
    for (const row of requirements?.rows ?? []) {
      if (row.frameworkVersionId !== framework.frameworkVersionId || covered.has(row.itemId)) {
        continue;
      }
      rows.push([
        framework.label,
        framework.versionCode ?? '',
        row.code,
        row.section,
        row.text,
        NO_BLOCK_TEXT,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        ...decisionCells(row, framework.frameworkVersionId, requirements),
      ]);
    }
  }
  return rows;
}

export const MAPPING_HEADERS = [
  '基準',
  '基準の版',
  '要求事項ID',
  '要求事項の節',
  '要求事項',
  '原稿の節',
  '節の版',
  '節の版ID',
  '節の状態',
  '承認状態',
  '根拠（ファイル・版・位置・引用ID）',
  '指標の版',
  '定性情報（題名・版）',
  '確認事項',
  '適用判断',
  '判断の出所',
  '対象外の理由',
  '判断者',
  '判断の承認者',
  '判断の承認日時',
  '固定後の変更',
];

export const TRACE_SHEET_HEADERS = [
  '追跡番号',
  '種別',
  '基準',
  '節',
  '段落ID',
  '本文・数値（出力と同じ文字列）',
  '要求事項',
  '承認版',
  '承認者',
  '承認日時',
  '根拠',
  '数値の版',
  '追跡',
  '理由',
];

/** 「トレース」シートの行（段落の行は出力と同じ文字列） */
export function traceSheetRows(
  snapshot: ReportSnapshotDetail,
  units: readonly TraceUnit[],
  context: ReportExportContext,
): XlsxSheetModel['rows'] {
  const frameworkLabel = new Map(
    snapshot.frameworkVersions.map((f) => [f.frameworkVersionId, f.label]),
  );
  const rendered = new Map<string, string>();
  for (const block of snapshot.blocks) {
    for (const p of renderBlockParagraphs(block, snapshot, 'internal', [])) {
      rendered.set(`${block.blockId}:${p.paragraphId}`, p.text);
    }
  }
  return units.map((u) => {
    const table = traceTableRows(snapshot, [u], context)[0]!;
    const mv =
      u.kind === 'number' && u.dataPointVersionId
        ? snapshot.metricValues.find((m) => m.dataPointVersionId === u.dataPointVersionId)
        : undefined;
    const text =
      u.kind === 'paragraph'
        ? (rendered.get(`${u.blockId}:${u.paragraphId}`) ?? u.text)
        : mv
          ? metricDisplay(mv)
          : u.text;
    return {
      kind: u.kind === 'paragraph' ? 'paragraph' : 'row',
      cells: [
        u.traceId,
        TRACE_KIND_LABELS[u.kind],
        frameworkLabel.get(u.frameworkVersionId) ?? '',
        u.blockTitle,
        u.paragraphId,
        text,
        table[3] ?? '',
        table[4] ?? '',
        table[5] ?? '',
        table[6] ?? '',
        table[7] ?? '',
        table[8] ?? '',
        table[9] ?? '',
        table[10] ?? '',
      ],
    };
  });
}

const TRACE_SHEET_WIDTHS = [16, 8, 22, 20, 14, 60, 18, 16, 14, 18, 40, 40, 12, 40];

/** 対応表 XLSX のシート（対応表・数値・根拠・トレース・スナップショット） */
export function mappingWorkbookModel(
  snapshot: ReportSnapshotDetail,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): XlsxSheetModel[] {
  const trace = snapshotTrace(snapshot, context);
  const sheets: XlsxSheetModel[] = [];
  sheets.push({
    name: '対応表',
    header: MAPPING_HEADERS,
    rows: mappingRows(snapshot, context).map((cells) => ({ kind: 'row', cells })),
    widths: [22, 18, 14, 14, 40, 20, 8, 38, 12, 20, 48, 60, 38, 48, 14, 16, 36, 14, 14, 18, 22],
  });
  sheets.push({
    name: '数値',
    header: [
      '指標コード',
      '指標',
      '組織・拠点',
      '対象期間',
      '期間開始',
      '期間終了',
      '境界',
      '値',
      '単位',
      '区分',
      '値の有無',
      '版',
      '承認',
      '変更理由',
      'Data Point 版 ID',
    ],
    rows: snapshot.metricValues.map((mv) => ({
      kind: 'number',
      cells: [
        mv.metricCode,
        mv.metricName,
        mv.unitName,
        mv.periodCode,
        mv.periodStart,
        mv.periodEnd,
        mv.boundary,
        mv.value,
        mv.unitOfMeasure,
        VALUE_KIND_LABELS[mv.valueKind],
        AVAILABILITY_STATUS_LABELS[mv.availabilityStatus],
        mv.versionNo,
        mv.versionApproved ? '承認済み' : '未承認',
        mv.changeReason ?? '',
        mv.dataPointVersionId,
      ],
    })),
    widths: [16, 30, 16, 10, 12, 12, 10, 14, 10, 8, 10, 6, 10, 30, 38],
  });
  sheets.push({
    name: '根拠',
    header: ['引用 ID', 'ファイル名', 'ファイルの版', '機密区分', '利用目的', '位置', '引用文'],
    rows: snapshot.anchors.map((anchor) => ({
      kind: 'row',
      cells: [
        anchor.sourceAnchorId,
        anchor.fileName,
        anchor.fileVersionNo,
        confidentialityText(anchor.confidentiality),
        anchor.usagePurpose ? EVIDENCE_USAGE_PURPOSE_LABELS[anchor.usagePurpose] : '未設定',
        anchor.page !== null ? `p.${anchor.page}` : (anchor.locator ?? ''),
        anchor.quoteText,
      ],
    })),
    widths: [38, 36, 10, 10, 14, 24, 80],
  });
  sheets.push({
    name: 'トレース',
    header: TRACE_SHEET_HEADERS,
    rows: traceSheetRows(snapshot, trace.units, context),
    widths: TRACE_SHEET_WIDTHS,
  });
  const infoRows: Array<[string, string]> = [
    ['種別', kindText(snapshot)],
    ['番号', `No.${snapshot.snapshotNo}`],
    ['ラベル', snapshot.label],
    ['作成日時', formatJst(snapshot.createdAt)],
    ['内容ハッシュ', snapshot.contentHash],
    ['承認経路の規則の版', snapshot.policyVersion ?? '—'],
    ['適用判断の版', snapshot.decisionIds.join(', ') || '—'],
    ['定性情報の版', snapshot.narrativeVersionIds.join(', ') || '—'],
    ['テンプレート', DISCLOSURE_REPORT_TEMPLATE_VERSION],
    ['追跡率', trace.summary.label],
    ['注意', NOT_SUBMISSION_NOTICE],
    ['社内承認', INTERNAL_APPROVAL_NOTICE],
  ];
  for (const f of snapshot.frameworkVersions) {
    infoRows.push([
      `基準: ${f.label}`,
      `版 ${f.versionCode ?? '—'}／${legalStatusText(f)}／${coverageText(f)}／${APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}／${statusLine(snapshot, f)}`,
    ]);
  }
  sheets.push({
    name: 'スナップショット',
    header: ['項目', '値'],
    rows: infoRows.map((cells) => ({ kind: 'row', cells })),
    widths: [28, 100],
  });
  return sheets;
}

function workbookTitle(snapshot: ReportSnapshotDetail, what: string): string {
  return `開示原稿 ${what}（${kindText(snapshot)} No.${snapshot.snapshotNo}）`;
}

export async function buildMappingXlsx(
  snapshot: ReportSnapshotDetail,
  context: ReportExportContext = EMPTY_EXPORT_CONTEXT,
): Promise<Uint8Array> {
  return writeWorkbook(mappingWorkbookModel(snapshot, context), {
    title: workbookTitle(snapshot, '対応表'),
    createdAt: snapshot.createdAt,
  });
}

/** 注記のシート（社内資料・提出ではない・社内承認であり第三者保証ではない） */
function noticeSheet(lines: readonly string[]): XlsxSheetModel {
  return {
    name: '注記',
    header: ['注記'],
    rows: lines.map((line) => ({ kind: 'row', cells: [line] })),
    widths: [120],
  };
}

/** 追跡表 XLSX（トレース画面の「追跡表を出力」。基準・選定ケースで絞った単位） */
export function traceWorkbookModel(
  snapshot: ReportSnapshotDetail,
  context: ReportExportContext,
  options: { frameworkVersionId?: Uuid | null; selectedCodes?: readonly string[] | null } = {},
): XlsxSheetModel[] {
  const trace = snapshotTrace(snapshot, context, options);
  return [
    {
      name: 'トレース',
      header: TRACE_SHEET_HEADERS,
      rows: traceSheetRows(snapshot, trace.units, context),
      widths: TRACE_SHEET_WIDTHS,
    },
    noticeSheet([
      `追跡率: ${trace.summary.label}`,
      trace.summary.selectedCodes
        ? `選定ケース（要求事項）: ${trace.summary.selectedCodes.join('、')}`
        : '選定ケース: 全件',
      `${kindText(snapshot)} No.${snapshot.snapshotNo}／内容ハッシュ ${snapshot.contentHash}`,
      '社内確認用の資料です。',
      INTERNAL_APPROVAL_NOTICE,
      NOT_SUBMISSION_NOTICE,
    ]),
  ];
}

export async function buildTraceXlsx(
  snapshot: ReportSnapshotDetail,
  context: ReportExportContext,
  options: { frameworkVersionId?: Uuid | null; selectedCodes?: readonly string[] | null } = {},
): Promise<Uint8Array> {
  return writeWorkbook(traceWorkbookModel(snapshot, context, options), {
    title: workbookTitle(snapshot, '追跡表'),
    createdAt: snapshot.createdAt,
  });
}

/** 突合結果の XLSX の材料（出力の記録と、止めた出力・外部ファイルの照合の記録） */
export interface ReconciliationExportInput {
  artifacts: ReadonlyArray<ExportArtifact & { generatedByName?: string }>;
  reconciliations: ReadonlyArray<ExportReconciliation & { createdByName?: string }>;
}

const RECONCILIATION_SOURCE_LABELS: Record<ExportReconciliation['source'], string> = {
  generated_blocked: '不一致で止めた出力',
  uploaded: '外部で編集したファイルの照合',
};

const RECONCILIATION_STATE_LABELS = {
  matched: '不一致 0 件',
  mismatched: '不一致あり',
  not_reconciled: '未突合',
} as const;

export function reconciliationWorkbookModel(
  snapshot: ReportSnapshotDetail,
  input: ReconciliationExportInput,
): XlsxSheetModel[] {
  const artifactRows: XlsxSheetModel['rows'] = input.artifacts.map((a) => ({
    kind: 'row',
    cells: [
      formatJst(a.generatedAt),
      a.format.toUpperCase(),
      AUDIENCE_DISPLAY[a.audience],
      a.fileName,
      RECONCILIATION_STATE_LABELS[reconciliationStateOf(a)],
      a.reconciledParagraphs,
      a.reconciledNumbers,
      a.reconciledRows,
      a.mismatchCount,
      a.checkerVersion ?? '',
      a.fileSha256,
    ],
  }));
  const reconciliationRows: XlsxSheetModel['rows'] = input.reconciliations.map((r) => ({
    kind: 'row',
    cells: [
      formatJst(r.createdAt),
      RECONCILIATION_SOURCE_LABELS[r.source],
      r.format.toUpperCase(),
      AUDIENCE_DISPLAY[r.audience],
      r.paragraphsChecked,
      r.numbersChecked,
      r.rowsChecked,
      r.mismatchCount,
      r.checkerVersion,
      r.fileSha256,
    ],
  }));
  const mismatchRows: XlsxSheetModel['rows'] = input.reconciliations.flatMap((r) =>
    r.mismatches.map((m) => ({
      kind: 'row' as const,
      cells: [
        formatJst(r.createdAt),
        RECONCILIATION_SOURCE_LABELS[r.source],
        MISMATCH_KIND_LABELS[m.kind],
        m.location,
        m.expected,
        m.actual,
      ],
    })),
  );
  return [
    {
      name: '出力の突合',
      header: [
        '出力日時',
        '形式',
        '区分',
        'ファイル名',
        '突合',
        '段落',
        '数値',
        '行',
        '不一致',
        '照合の規則',
        'ファイルのハッシュ',
      ],
      rows: artifactRows,
      widths: [18, 8, 26, 50, 12, 8, 8, 8, 8, 24, 66],
    },
    {
      name: '止めた出力・外部ファイル',
      header: [
        '日時',
        '種類',
        '形式',
        '区分',
        '段落',
        '数値',
        '行',
        '不一致',
        '照合の規則',
        'ファイルのハッシュ',
      ],
      rows: reconciliationRows,
      widths: [18, 26, 8, 26, 8, 8, 8, 8, 24, 66],
    },
    {
      name: '不一致の明細',
      header: ['日時', '種類', '区分', '位置', '承認版（期待値）', 'ファイル'],
      rows: mismatchRows,
      widths: [18, 26, 10, 40, 60, 60],
    },
    noticeSheet([
      RECONCILIATION_NOTICE,
      INTERNAL_APPROVAL_NOTICE,
      NOT_SUBMISSION_NOTICE,
      `${kindText(snapshot)} No.${snapshot.snapshotNo}／内容ハッシュ ${snapshot.contentHash}`,
      '外部で編集したファイルは保存していません（ファイルのハッシュと照合の結果だけを記録しています）。',
      `件数の内訳: ${
        input.artifacts
          .map((a) =>
            a.mismatchCount === null
              ? null
              : `${a.format.toUpperCase()} ${reconciledCountsText({
                  paragraphs: a.reconciledParagraphs,
                  numbers: a.reconciledNumbers,
                  rows: a.reconciledRows,
                })}`,
          )
          .filter((t): t is string => t !== null)
          .join('／') || '突合した出力はありません'
      }`,
    ]),
  ];
}

export async function buildReconciliationXlsx(
  snapshot: ReportSnapshotDetail,
  input: ReconciliationExportInput,
): Promise<Uint8Array> {
  return writeWorkbook(reconciliationWorkbookModel(snapshot, input), {
    title: workbookTitle(snapshot, '突合結果'),
    createdAt: snapshot.createdAt,
  });
}

// ======================================================================
// CSV（定量データ）
// ======================================================================

export function metricCsvColumns(audience: ExportAudience): ExportColumn<SnapshotMetricValue>[] {
  const columns: ExportColumn<SnapshotMetricValue>[] = [
    { key: 'metricCode', header: '指標コード', value: (m) => m.metricCode },
    { key: 'metricName', header: '指標', value: (m) => m.metricName },
    { key: 'unitName', header: '組織・拠点', value: (m) => m.unitName },
    { key: 'periodCode', header: '対象期間', value: (m) => m.periodCode },
    { key: 'periodStart', header: '期間開始', value: (m) => m.periodStart },
    { key: 'periodEnd', header: '期間終了', value: (m) => m.periodEnd },
    { key: 'boundary', header: '境界', value: (m) => m.boundary },
    // 値が無い版は空欄のまま（0 にしない）。状態は「値の有無」列で示す
    { key: 'value', header: '値', value: (m) => m.value, numeric: true },
    { key: 'unit', header: '単位', value: (m) => m.unitOfMeasure },
    { key: 'valueKind', header: '区分', value: (m) => VALUE_KIND_LABELS[m.valueKind] },
    {
      key: 'availability',
      header: '値の有無',
      value: (m) => AVAILABILITY_STATUS_LABELS[m.availabilityStatus],
    },
    { key: 'versionNo', header: '版', value: (m) => m.versionNo, numeric: true },
  ];
  if (audience === 'internal') {
    columns.push(
      {
        key: 'approval',
        header: '承認',
        value: (m) => (m.versionApproved ? '承認済み' : '未承認'),
      },
      { key: 'changeReason', header: '変更理由', value: (m) => m.changeReason ?? '' },
      { key: 'versionId', header: 'Data Point 版 ID', value: (m) => m.dataPointVersionId },
    );
  }
  return columns;
}

export function buildMetricCsv(snapshot: ReportSnapshotDetail, audience: ExportAudience): string {
  return toCsv({
    name: 'metrics',
    columns: metricCsvColumns(audience),
    rows: snapshot.metricValues,
  });
}

/** 突合の期待値（CSV）。CSV の書き出しと同じ無害化を通した値 */
export function metricCsvExpectation(
  snapshot: ReportSnapshotDetail,
  audience: ExportAudience,
): SheetExpectation {
  const columns = metricCsvColumns(audience);
  return {
    name: 'CSV',
    header: columns.map((c) => xlsxCellValue(c.header)),
    rows: snapshot.metricValues.map((mv) => ({
      kind: 'number' as const,
      cells: columns.map((c) => xlsxCellValue(c.value(mv))),
    })),
  };
}

// ======================================================================
// ファイル名
// ======================================================================

function safeFilePart(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

export function exportFileName(
  snapshot: ReportSnapshotDetail,
  format: 'docx' | 'xlsx' | 'csv',
  audience: ExportAudience,
  framework: SnapshotFramework | null,
): string {
  const projectName = snapshot.frameworkVersions[0]?.projectName ?? 'report';
  const kind = snapshot.snapshotKind === 'approved' ? '社内承認済み' : '草稿';
  const purpose =
    format === 'docx'
      ? `原稿_${safeFilePart(framework?.frameworkKey ?? 'framework')}`
      : format === 'xlsx'
        ? '対応表'
        : '数値';
  const who = audience === 'internal' ? '社内確認用' : '対外用';
  return `T4D_${safeFilePart(projectName)}_${kind}No${snapshot.snapshotNo}_${purpose}_${who}.${format}`;
}

/** 追跡表・突合結果（社内確認用の XLSX）のファイル名 */
export function auxiliaryFileName(
  snapshot: ReportSnapshotDetail,
  purpose: '追跡表' | '突合結果',
): string {
  const projectName = snapshot.frameworkVersions[0]?.projectName ?? 'report';
  const kind = snapshot.snapshotKind === 'approved' ? '社内承認済み' : '草稿';
  return `T4D_${safeFilePart(projectName)}_${kind}No${snapshot.snapshotNo}_${purpose}_社内確認用.xlsx`;
}
