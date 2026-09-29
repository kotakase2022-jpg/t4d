import 'server-only';

import { toCsv, type ExportColumn } from '@/lib/exports';
import {
  APPLICABILITY_STATUS_LABELS,
  AVAILABILITY_STATUS_LABELS,
  BLOCK_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  EVIDENCE_USAGE_PURPOSE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  FRAMEWORK_LEGAL_STATUS_LABELS,
  REPORT_SNAPSHOT_KIND_LABELS,
  REVIEW_COMMENT_SEVERITY_LABELS,
  VALUE_KIND_LABELS,
} from '@/lib/domain/disclosure-status';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import type {
  ReportSnapshotDetail,
  SnapshotAnchor,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotIssue,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';
import type { BlockInline, ConfidentialityLevel, ExportAudience, Uuid } from '@/types/domain';

/**
 * 開示レポートの出力（DOCX 原稿・XLSX 対応表・定量 CSV）。指示書 §6.10。
 *
 * 入力は必ずスナップショット（ReportSnapshotDetail）だけ。ライブの行を引かない
 * （同じスナップショットからは、いつ出力しても同じ本文・数値・参照になる: A31）。
 *
 * 対外用（external）は次を既定で含めない（A32）:
 *  - 社内コメント（review_comments の本文）と、その存在を示す確認事項
 *  - 公開資料（confidentiality = public）以外の資料のファイル名 → 「社内資料」とだけ書く
 *  - 作成者などの個人に関する情報（利用者 ID・氏名）
 *
 * 生成したファイルを「提出済み」とは扱わない（出力は開示先への提出ではない）。
 */

export const DISCLOSURE_REPORT_TEMPLATE_VERSION = 'disclosure-report-v1';

export const AUDIENCE_DISPLAY: Record<ExportAudience, string> = {
  internal: '社内確認用',
  external: '対外用（社内コメント・非公開資料名を除く）',
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

/** 数値の表示（固定した版の値と単位）。値が無い版は状態を書き、0 として出さない */
export function metricDisplay(mv: SnapshotMetricValue): string {
  if (mv.availabilityStatus === 'value_present' && mv.value !== null) {
    return `${formatNumber(mv.value)} ${mv.unitOfMeasure}`.trim();
  }
  if (mv.textValue) return mv.textValue;
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

/** 節の本文を段落ごとの文字列にする（節名と同じ見出し段落は重ねて出さない） */
export function renderBlockParagraphs(
  block: SnapshotBlock,
  snapshot: ReportSnapshotDetail,
  audience: ExportAudience,
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
        parts.push(text);
      }
      return { paragraphId: p.id, kind: p.kind, text: parts.join('') };
    })
    .filter((p) => !(p.kind === 'heading' && p.text.trim() === block.title.trim()))
    .filter((p) => p.text.trim().length > 0);
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

function legalStatusText(framework: SnapshotFramework): string {
  return framework.legalStatus ? FRAMEWORK_LEGAL_STATUS_LABELS[framework.legalStatus] : '未確認';
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
}

export async function buildDisclosureDocx(
  snapshot: ReportSnapshotDetail,
  options: DocxBuildOptions,
): Promise<Uint8Array> {
  const framework = snapshot.frameworkVersions.find(
    (f) => f.frameworkVersionId === options.frameworkVersionId,
  );
  if (!framework) throw new Error('スナップショットに含まれない基準です。');
  const { audience } = options;

  const {
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

  const table = (headers: string[] | null, rows: string[][]) =>
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

  const blocks = blocksOfFramework(snapshot, framework.frameworkVersionId);

  // --- 草稿: 未承認箇所・不足情報 ----------------------------------------------
  if (snapshot.snapshotKind === 'review_draft') {
    const lines = blocks.flatMap((block) =>
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
  for (const block of blocks) {
    children.push(new Paragraph({ text: block.title, heading: HeadingLevel.HEADING_1 }));
    if (!block.isApprovedVersion) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `［未承認: ${BLOCK_STATUS_LABELS[block.status]}${block.versionNo !== null ? `・版 ${block.versionNo}` : ''}］`,
              bold: true,
            }),
          ],
        }),
      );
    }
    const paragraphs = renderBlockParagraphs(block, snapshot, audience);
    if (paragraphs.length === 0) {
      children.push(new Paragraph('（本文なし）'));
    }
    for (const p of paragraphs) {
      children.push(
        p.kind === 'heading'
          ? new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_2 })
          : new Paragraph(p.text),
      );
    }
  }

  // --- 付表: 本文で引用した数値 ---------------------------------------------------
  const citedVersionIds = new Set(
    blocks.flatMap((b) =>
      b.body.paragraphs.flatMap((p) =>
        p.children.flatMap((inline) => (inline.t === 'metric' ? [inline.dataPointVersionId] : [])),
      ),
    ),
  );
  const cited = snapshot.metricValues.filter((mv) => citedVersionIds.has(mv.dataPointVersionId));
  if (cited.length > 0) {
    children.push(
      new Paragraph({ text: '付表 本文で引用した数値', heading: HeadingLevel.HEADING_1 }),
    );
    children.push(
      table(
        ['指標', '組織・拠点', '対象期間', '境界', '値', '区分', '版'],
        cited.map((mv) => [
          mv.metricName,
          mv.unitName,
          mv.periodStart && mv.periodEnd ? `${mv.periodStart}〜${mv.periodEnd}` : mv.periodCode,
          mv.boundary,
          metricDisplay(mv),
          VALUE_KIND_LABELS[mv.valueKind],
          `版 ${mv.versionNo}`,
        ]),
      ),
    );
  }

  // --- 社内確認用だけ: 節の版と社内コメント -----------------------------------------
  if (audience === 'internal') {
    children.push(
      new Paragraph({ text: '節の版と承認状態（社内確認用）', heading: HeadingLevel.HEADING_1 }),
    );
    children.push(
      table(
        ['節', '版', '状態', '承認済みの版を固定', '要求事項'],
        blocks.map((b) => [
          b.title,
          b.versionNo !== null ? `版 ${b.versionNo}` : '版なし',
          BLOCK_STATUS_LABELS[b.status],
          b.isApprovedVersion ? 'はい' : 'いいえ',
          b.requirements.map((r) => r.code).join('、') || '—',
        ]),
      ),
    );
    const comments = blocks.flatMap((b) =>
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
// XLSX（社内確認用の対応表）
// ======================================================================

type CellValue = string | number | null;

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

/** 対応表の行（テストからも同じ行を検査する） */
export function mappingRows(snapshot: ReportSnapshotDetail): CellValue[][] {
  const rows: CellValue[][] = [];
  for (const framework of snapshot.frameworkVersions) {
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
      const narrativeText = [...new Set(narratives)].join('\n');
      const issues = block.issues.map((i) => i.message).join('\n');
      const requirementList =
        block.requirements.length > 0
          ? block.requirements
          : [{ itemId: '', code: '', section: '', text: '（要求事項の紐付けなし）' }];
      for (const requirement of requirementList) {
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
          narrativeText,
          issues,
        ]);
      }
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
  '定性情報の版ID',
  '確認事項',
];

export async function buildMappingXlsx(snapshot: ReportSnapshotDetail): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TERRAST for Disclosure (T4D)';
  // 生成時刻ではなくスナップショットの時刻を入れる（同じスナップショットの出力で揃える）
  workbook.created = new Date(snapshot.createdAt);
  workbook.modified = new Date(snapshot.createdAt);
  workbook.title = `開示原稿 対応表（${kindText(snapshot)} No.${snapshot.snapshotNo}）`;

  type Worksheet = ReturnType<typeof workbook.addWorksheet>;
  /**
   * すべての文字列セルを「文字列」書式にし、数式の開始文字を無害化する。
   * exceljs は文字列を共有文字列として書くため現状でも数式にはならないが、
   * 将来の書式変更や別ツールでの再保存で数式に化けないよう出力側で固定する。
   */
  const addRow = (ws: Worksheet, values: CellValue[], header = false) => {
    const row = ws.addRow(values.map((v) => (typeof v === 'string' ? neutralizeFormula(v) : v)));
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
  const setWidths = (ws: Worksheet, widths: number[]) => {
    widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const mapping = workbook.addWorksheet('対応表');
  addRow(mapping, MAPPING_HEADERS, true);
  for (const row of mappingRows(snapshot)) addRow(mapping, row);
  setWidths(mapping, [22, 18, 14, 14, 40, 20, 8, 38, 12, 20, 48, 60, 38, 48]);

  const metrics = workbook.addWorksheet('数値');
  addRow(
    metrics,
    [
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
    true,
  );
  for (const mv of snapshot.metricValues) {
    addRow(metrics, [
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
    ]);
  }
  setWidths(metrics, [16, 30, 16, 10, 12, 12, 10, 14, 10, 8, 10, 6, 10, 30, 38]);

  const evidence = workbook.addWorksheet('根拠');
  addRow(
    evidence,
    ['引用 ID', 'ファイル名', 'ファイルの版', '機密区分', '利用目的', '位置', '引用文'],
    true,
  );
  for (const anchor of snapshot.anchors) {
    addRow(evidence, [
      anchor.sourceAnchorId,
      anchor.fileName,
      anchor.fileVersionNo,
      confidentialityText(anchor.confidentiality),
      anchor.usagePurpose ? EVIDENCE_USAGE_PURPOSE_LABELS[anchor.usagePurpose] : '未設定',
      anchor.page !== null ? `p.${anchor.page}` : (anchor.locator ?? ''),
      anchor.quoteText,
    ]);
  }
  setWidths(evidence, [38, 36, 10, 10, 14, 24, 80]);

  const info = workbook.addWorksheet('スナップショット');
  addRow(info, ['項目', '値'], true);
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
    ['注意', NOT_SUBMISSION_NOTICE],
  ];
  for (const f of snapshot.frameworkVersions) {
    infoRows.push([
      `基準: ${f.label}`,
      `版 ${f.versionCode ?? '—'}／${legalStatusText(f)}／${coverageText(f)}／${APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}／${statusLine(snapshot, f)}`,
    ]);
  }
  for (const row of infoRows) addRow(info, row);
  setWidths(info, [28, 100]);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
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
