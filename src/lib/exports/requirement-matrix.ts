import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { neutralizeFormula } from '@/lib/exports/disclosure-report';
import { EXPORT_CONTENT_TYPES, toCsv, type ExportColumn } from '@/lib/exports';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { statusLabel } from '@/lib/ui/status/registry';
import {
  REQUIREMENT_COVERAGE_CATEGORIES,
  type RequirementCoverageCategory,
} from '@/lib/domain/requirement-coverage';
import type { DbClient } from '@/lib/repositories/types';
import { loadCrosswalk, type CrosswalkView } from '@/lib/services/crosswalk';
import {
  loadRequirementMatrix,
  type RequirementMatrix,
  type RequirementMatrixFramework,
  type RequirementMatrixRow,
} from '@/lib/services/requirement-matrix';
import type { AuthorizationContext, Uuid } from '@/types/domain';

/**
 * 要求事項・情報対応表（トライアル対応 NF-04 の出力。スライド 11 の成果物 #01）。
 *
 * XLSX のシート: 対応表（全件）・対象外一覧・未対応一覧・基準別件数（分母付き）・基準横断（NF-09）・注記。
 * CSV は「対応表（全件）」だけ。行は画面と同じ loadRequirementMatrix の行（件数を食い違わせない）。
 * 企業が入力した文字列は、相手先の表計算ソフトで数式として動かないよう先頭を無害化する（CSV は toCsv が行う）。
 * 社内資料。社内承認であり第三者保証ではない。基準の位置付け（公表済み・公開草案・サンプル）を必ず併記する。
 */

export const REQUIREMENT_MATRIX_EXPORT_VERSION = 'requirement-matrix-v1';

export const MATRIX_NOTES: readonly string[] = [
  'この対応表は社内資料です。承認は企業内の承認であり、第三者による保証ではありません。',
  '区分（充足確認済み／追加確認が必要／未対応／未判定／対象外）は、出力した時点の判断・原稿・数値・根拠から毎回導いた値です（保存した値ではありません）。',
  '対象外・非重要は、理由があり別の人が承認したものだけを「対象外」とし、承認待ち・理由なしは「未判定」として分母に残しています。',
  '公開草案・サンプルの基準は「充足確認済み」にしません（上限は「追加確認が必要」）。サンプル（架空）の要求事項は基準の条文ではありません。',
  'AI の判定は「候補」の列にだけ出しています。人の判断・評価とは別です。',
  '要求事項が未収録の基準は「要求事項未収録のため算定しない」とし、0 件として数えていません。',
];

/** 1 要求事項 1 行（全列） */
export const MATRIX_COLUMNS: ExportColumn<RequirementMatrixRow>[] = [
  { key: 'framework', header: '基準・版', value: (r) => r.frameworkLabel },
  { key: 'positioning', header: '位置付け', value: (r) => r.frameworkPositioning },
  { key: 'code', header: '要求事項コード', value: (r) => r.code },
  { key: 'section', header: '節', value: (r) => r.section },
  { key: 'title', header: '要求事項', value: (r) => r.title },
  { key: 'decision', header: '適用判断', value: (r) => r.decisionLabel },
  { key: 'decisionSource', header: '判断の出所', value: (r) => r.decisionSourceLabel },
  { key: 'exclusionReason', header: '対象外・非重要の理由', value: (r) => r.exclusionReason ?? '' },
  { key: 'decidedBy', header: '判断者', value: (r) => r.decidedByName ?? '' },
  { key: 'approvedBy', header: '承認者（対象外）', value: (r) => r.approvedByName ?? '' },
  { key: 'approvedAt', header: '承認日時（対象外）', value: (r) => formatJst(r.approvedAt) },
  { key: 'category', header: '区分', value: (r) => r.categoryLabel },
  { key: 'reasons', header: '区分の理由', value: (r) => r.reasons.join(' ') },
  { key: 'gaps', header: '不足', value: (r) => r.gapLabels.join('・') },
  {
    key: 'blocks',
    header: '原稿の節（版・状態）',
    value: (r) =>
      r.blocks
        .map(
          (b) =>
            `${b.title}${b.translation ? '（翻訳版）' : ''}（版 ${b.versionNo ?? '—'}・${b.statusLabel}）`,
        )
        .join(' / '),
  },
  {
    key: 'approval',
    header: '承認（版・承認者・日時）',
    value: (r) =>
      r.blocks
        .filter((b) => b.approvedVersionNo !== null)
        .map(
          (b) =>
            `${b.title}: 版 ${b.approvedVersionNo}・${b.approvedByName ?? '—'}・${formatJst(b.approvedAt)}`,
        )
        .join(' / '),
  },
  {
    key: 'excerpt',
    header: '本文抜粋（200 字）',
    value: (r) => r.blocks.find((b) => !b.translation)?.excerpt ?? '',
  },
  {
    key: 'metrics',
    header: '数値（指標・組織・期間・境界・値・版・承認）',
    value: (r) =>
      r.metrics
        .map(
          (m) =>
            `${m.metricName}／${m.unitName}／${m.periodCode}／${m.boundary || '—'}／${m.value} ${m.unitOfMeasure}／版 ${m.versionNo}／${m.approved ? '承認済み' : '未承認'}`,
        )
        .join(' / '),
  },
  {
    key: 'evidence',
    header: '根拠（資料・版・位置）',
    value: (r) =>
      r.evidence
        .map(
          (e) => `${e.fileName}（版 ${e.fileVersionNo ?? '—'}）${e.locator ? ` ${e.locator}` : ''}`,
        )
        .join(' / '),
  },
  {
    key: 'narratives',
    header: '定性情報（題名・版）',
    value: (r) => r.narratives.map((n) => `${n.title}（版 ${n.versionNo}）`).join(' / '),
  },
  { key: 'owner', header: '担当', value: (r) => r.ownerName ?? '' },
  { key: 'due', header: '期限', value: (r) => (r.dueDate ? formatJstDate(r.dueDate) : '') },
  { key: 'ownerDueSource', header: '担当・期限の出所', value: (r) => r.ownerDueSourceLabel },
  { key: 'actionPlans', header: '対応計画（未完了）', value: (r) => r.actionPlans.join(' / ') },
  {
    key: 'crosswalk',
    header: '横断対応',
    value: (r) =>
      r.crosswalk
        .map(
          (c) =>
            `${c.counterpartFramework} ${c.counterpartCode ?? '（対応先なし）'}: ${c.relationLabel}${c.sample ? '（サンプル）' : ''}`,
        )
        .join(' / '),
  },
  { key: 'humanEvaluation', header: '人の評価', value: (r) => r.humanEvaluationLabel ?? '' },
  {
    key: 'aiCandidate',
    header: 'AI の判定（候補・未確認）',
    value: (r) => r.aiCandidateLabel ?? '',
  },
];

const LIST_COLUMN_KEYS = [
  'framework',
  'code',
  'title',
  'decision',
  'exclusionReason',
  'decidedBy',
  'approvedBy',
  'approvedAt',
  'category',
  'reasons',
  'gaps',
  'owner',
  'due',
  'ownerDueSource',
  'actionPlans',
];

function pick(keys: readonly string[]): ExportColumn<RequirementMatrixRow>[] {
  return keys.map((key) => MATRIX_COLUMNS.find((c) => c.key === key)!);
}

/** 対象外一覧: 対象外・非重要の判断（承認待ち・差戻しを含む。区分は別列） */
export function exclusionRowsOf(rows: readonly RequirementMatrixRow[]): RequirementMatrixRow[] {
  return rows.filter((r) => r.exclusionReason !== null || r.category === 'excluded');
}

/** 未対応一覧: 区分が「未対応」 */
export function notAddressedRowsOf(rows: readonly RequirementMatrixRow[]): RequirementMatrixRow[] {
  return rows.filter((r) => r.category === 'not_addressed');
}

/** 基準別件数の行（未収録の基準は理由を出し、件数は空欄にする） */
export function countRowsOf(frameworks: readonly RequirementMatrixFramework[]): string[][] {
  const header = [
    '基準・版',
    '位置付け',
    '分母（収録された要求事項）',
    ...REQUIREMENT_COVERAGE_CATEGORIES.map((c) => statusLabel('requirementCoverage', c)),
    '備考',
  ];
  return [
    header,
    ...frameworks.map((f) =>
      f.mode === 'not_loaded'
        ? [
            f.label,
            f.positioning,
            '',
            ...REQUIREMENT_COVERAGE_CATEGORIES.map(() => ''),
            f.notCalculatedReason ?? '',
          ]
        : [
            f.label,
            f.positioning,
            String(f.total),
            ...REQUIREMENT_COVERAGE_CATEGORIES.map((c: RequirementCoverageCategory) =>
              String(f.counts[c]),
            ),
            // 分母は収録した要求事項の件数。一部だけ収録した基準は、その範囲を書く（基準の全件と取り違えさせない）
            [f.isSample ? 'サンプル（架空）の要求事項です' : '', f.coverage ?? '']
              .filter((t) => t !== '')
              .join('／'),
          ],
    ),
  ];
}

/** 基準横断のシートの行（NF-09） */
export function crosswalkSheetRows(view: CrosswalkView | null): string[][] {
  const header = [
    'SSBJ の要求事項',
    'SSBJ の区分',
    '対応先の基準',
    '対応先の要求事項',
    '対応先の区分',
    '関係',
    '片側だけ充足',
    '共通本文（定性情報）',
    '根拠・説明',
    '出所',
  ];
  if (!view) return [header];
  const category = (c: RequirementCoverageCategory | null, inProject: boolean) =>
    c ? statusLabel('requirementCoverage', c) : inProject ? '—' : 'プロジェクトに無い基準';
  return [
    header,
    ...view.rows.map((r) => [
      `${r.ssbj.code ?? ''} ${r.ssbj.title ?? ''}`.trim(),
      category(r.ssbj.category, r.ssbj.inProject),
      r.counterpart.frameworkLabel,
      r.counterpart.code
        ? `${r.counterpart.code} ${r.counterpart.title ?? ''}`.trim()
        : '（対応先なし）',
      r.counterpart.code ? category(r.counterpart.category, r.counterpart.inProject) : '—',
      statusLabel('crosswalkRelation', r.relation),
      r.oneSided ? 'はい（もう一方は追加確認が必要）' : '',
      r.sharedNarratives.map((n) => `${n.title}（版 ${n.versionNo}）`).join(' / '),
      r.rationale,
      r.sample ? 'サンプル（架空の整理。公表資料に基づくものではありません）' : (r.sourceRef ?? ''),
    ]),
  ];
}

export function buildRequirementMatrixCsv(matrix: RequirementMatrix): string {
  return toCsv({ name: '対応表', columns: MATRIX_COLUMNS, rows: matrix.rows });
}

export async function buildRequirementMatrixXlsx(
  matrix: RequirementMatrix,
  crosswalk: CrosswalkView | null,
  meta: { organizationName: string; generatedAt: string },
): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TERRAST for Disclosure (T4D)';
  workbook.created = new Date(meta.generatedAt);
  workbook.title = `要求事項・情報対応表 ${matrix.project.name}`;
  type Worksheet = ReturnType<typeof workbook.addWorksheet>;

  /** 文字列は数式として解釈されないよう先頭を無害化する */
  const addRow = (ws: Worksheet, values: Array<string | number | null>) =>
    ws.addRow(values.map((v) => (typeof v === 'string' ? neutralizeFormula(v) : v)));
  const header = (ws: Worksheet, values: string[]) => {
    const row = addRow(ws, values);
    row.font = { bold: true };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF3FF' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const rowSheet = (
    name: string,
    columns: ExportColumn<RequirementMatrixRow>[],
    rows: readonly RequirementMatrixRow[],
  ) => {
    const ws = workbook.addWorksheet(name);
    header(
      ws,
      columns.map((c) => c.header),
    );
    for (const row of rows)
      addRow(
        ws,
        columns.map((c) => c.value(row)),
      );
    columns.forEach((c, index) => {
      ws.getColumn(index + 1).width = Math.max(12, Math.min(48, c.header.length * 2 + 6));
    });
    return ws;
  };

  rowSheet('対応表', MATRIX_COLUMNS, matrix.rows);
  rowSheet('対象外一覧', pick(LIST_COLUMN_KEYS), exclusionRowsOf(matrix.rows));
  rowSheet('未対応一覧', pick(LIST_COLUMN_KEYS), notAddressedRowsOf(matrix.rows));

  const counts = workbook.addWorksheet('基準別件数');
  const [countHeader, ...countRows] = countRowsOf(matrix.frameworks);
  header(counts, countHeader!);
  for (const row of countRows) addRow(counts, row);

  const cross = workbook.addWorksheet('基準横断');
  const [crossHeader, ...crossRows] = crosswalkSheetRows(crosswalk);
  header(cross, crossHeader!);
  for (const row of crossRows) addRow(cross, row);

  const notes = workbook.addWorksheet('注記');
  header(notes, ['項目', '内容']);
  addRow(notes, ['組織', meta.organizationName]);
  addRow(notes, ['開示プロジェクト', matrix.project.name]);
  addRow(notes, ['出力日時', formatJst(meta.generatedAt)]);
  addRow(notes, ['形式の版', REQUIREMENT_MATRIX_EXPORT_VERSION]);
  for (const f of matrix.frameworks)
    addRow(notes, [
      '基準の位置付け',
      `${f.label}: ${f.positioning}${f.coverage ? `／${f.coverage}` : ''}`,
    ]);
  for (const note of MATRIX_NOTES) addRow(notes, ['注記', note]);
  notes.getColumn(1).width = 18;
  notes.getColumn(2).width = 100;

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

// ======================================================================
// 出力の実行（API から呼ぶ。テストからも同じ関数を呼ぶ）
// ======================================================================

export const REQUIREMENT_MATRIX_FORMATS = ['xlsx', 'csv'] as const;
export type RequirementMatrixFormat = (typeof REQUIREMENT_MATRIX_FORMATS)[number];

export function parseRequirementMatrixFormat(value: string | null): RequirementMatrixFormat | null {
  return value === 'xlsx' || value === 'csv' ? value : null;
}

function safeFilePart(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

export interface RequirementMatrixExport {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  rowCount: number;
}

/**
 * 要求事項・情報対応表を出力する。権限（enterprise.export.run）を ID より先に確かめ、
 * プロジェクトは閲覧権限と組織で確かめる（他の組織は「見つかりません」）。書くのは監査ログ（export_created）だけ
 */
export async function exportRequirementMatrix(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; format: RequirementMatrixFormat },
): Promise<RequirementMatrixExport> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.export.run');
  const matrix = await loadRequirementMatrix(db, ctx, { projectId: input.projectId });
  const generatedAt = new Date().toISOString();
  const baseName = `T4D_要求事項・情報対応表_${safeFilePart(ctx.workspace.organizationName)}_${safeFilePart(matrix.project.name)}`;
  let bytes: Uint8Array;
  if (input.format === 'csv') {
    bytes = new TextEncoder().encode(buildRequirementMatrixCsv(matrix));
  } else {
    const crosswalk = await loadCrosswalk(db, ctx, { projectId: input.projectId });
    bytes = await buildRequirementMatrixXlsx(matrix, crosswalk, {
      organizationName: ctx.workspace.organizationName,
      generatedAt,
    });
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'requirement_matrix',
    resourceId: matrix.project.id,
    afterSummary: `要求事項・情報対応表 ${matrix.rows.length} 行を ${input.format.toUpperCase()} で出力`,
    metadata: {
      format: input.format,
      frameworks: matrix.frameworks.length,
      version: REQUIREMENT_MATRIX_EXPORT_VERSION,
    },
  });
  return {
    bytes,
    contentType: EXPORT_CONTENT_TYPES[input.format],
    fileName: `${baseName}.${input.format}`,
    rowCount: matrix.rows.length,
  };
}
