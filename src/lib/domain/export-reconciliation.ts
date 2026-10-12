/**
 * 出力の自動突合（トライアル対応 NF-15。スライド 10 の評価 #4「承認済みの本文・数値と出力した原稿・表を突合」）。
 *
 * 生成した（または外部で編集した）ファイルを読み戻した結果と、承認版（スナップショット）から作った期待値を
 * 決定論で照合する純粋関数だけを置く。AI は使わない。期待値は出力と同じ描画の関数
 * （src/lib/exports/disclosure-report.ts）が作り、ファイルの読み戻し（DOCX の段落・XLSX のセル・CSV の行）は
 * サービス（src/lib/services/export-reconciliation.ts）が行う。ここは DB にも画面にも依存しない。
 *
 * 比べ方:
 *  - 文字列は空白の正規化だけを行う（連続する空白・改行を 1 つの空白にし、前後を落とす）。
 *    それ以外（全角・半角・句読点）は変えない（1 文字の違いも不一致にする）
 *  - DOCX は表紙から末尾までを照合する。節は見出しを手掛かりに順に照合し（余計な段落が 1 つ入っても、
 *    次の節から照合し直す）、照合しなかった段落（節の末尾・表の前後・末尾に足した記述）は余分として数える。
 *    表（付表の数値・追跡表）は空のセルを読み戻せないため、空でないセルを順に照合する
 *  - 表計算・CSV はセル単位で照合する（行の数が違えば足りない／余分な行、期待値に無いシートは余分として数える）
 *  - 承認の照合（承認済みスナップショットなら全節が承認版・引用した数値が承認済み）も不一致に数える
 *  - 固定後の上流の変更（現行との違い）は不一致に数えない（呼び出し側が別欄で示す）
 */

import type { ReportSnapshotDetail } from '@/lib/domain/report-snapshot-content';
import type { ExportArtifact, ExportReconciliationMismatch, Uuid } from '@/types/domain';

/**
 * 照合の規則の版（export_artifacts.checker_version・export_reconciliations.checker_version）。
 * v2: DOCX は表紙から末尾まで照合し、期待値に無い段落（節の末尾・表の前後・末尾）と XLSX の期待値に無い
 * シートを余分として数える（v1 は見出しの間を読み飛ばしていた）
 */
export const RECONCILIATION_CHECKER_VERSION = 'export-reconciliation-v2';

/** 不一致の明細の上限（Supabase は先頭 50 件。Demo は Cookie の都合で DEMO_RECONCILIATION_MISMATCH_MAX） */
export const RECONCILIATION_MISMATCH_LIMIT = 50;

/** 明細の期待値・実際の値の長さの上限（記録を小さく保つ。位置で特定できれば十分） */
export const MISMATCH_TEXT_MAX = 100;
export const MISMATCH_LOCATION_MAX = 60;

export type MismatchKind = ExportReconciliationMismatch['kind'];

export interface ReconciliationCounts {
  /** 照合した段落（DOCX の本文の段落・表計算の追跡シートの段落の行） */
  paragraphs: number;
  /** 照合した数値（DOCX の付表の行・表計算の数値シートの行・CSV の行） */
  numbers: number;
  /** 照合したそのほかの行（対応表・根拠・追跡表など） */
  rows: number;
}

export interface ReconciliationResult extends ReconciliationCounts {
  mismatchCount: number;
  /** 不一致の明細（全件。記録するときに上限で切る） */
  mismatches: ExportReconciliationMismatch[];
}

// ======================================================================
// 正規化
// ======================================================================

/** 空白の正規化（連続する空白・改行・タブを 1 つの空白にし、前後を落とす） */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** セルの値を比べられる文字列にする（空・null・undefined は空文字、数値は String） */
export function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return normalizeText(String(value));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 違いが始まる位置の少し前から切り出す（長い段落の末尾の違いも明細に見えるように） */
const DIFFERENCE_CONTEXT = 20;

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

function clipFrom(text: string, start: number, max: number): string {
  if (start <= 0) return clip(text, max);
  return clip(`…${text.slice(start)}`, max);
}

/**
 * 明細を 1 件作る（長い文字列は切る）。期待値と実際の値が両方あるときは、違いが始まる位置の少し前から
 * 切り出す（同じ書き出しが続く長い段落でも、どこが違うかが見える）
 */
export function mismatch(
  kind: MismatchKind,
  location: string,
  expected: string,
  actual: string,
): ExportReconciliationMismatch {
  const diffAt =
    expected.length > MISMATCH_TEXT_MAX || actual.length > MISMATCH_TEXT_MAX
      ? firstDifference(expected, actual)
      : 0;
  const start = Math.max(0, diffAt - DIFFERENCE_CONTEXT);
  return {
    kind,
    location: clip(location, MISMATCH_LOCATION_MAX),
    expected: clipFrom(expected, start, MISMATCH_TEXT_MAX),
    actual: clipFrom(actual, start, MISMATCH_TEXT_MAX),
  };
}

const MISSING = '（ありません）';

// ======================================================================
// DOCX
// ======================================================================

export interface DocxExpectedParagraph {
  /** 位置（例「ガバナンス 段落 2」） */
  location: string;
  text: string;
}

export interface DocxExpectedBlock {
  /** 節の見出し（照合の手掛かり） */
  title: string;
  /** 見出しの次の注記（未承認の版の印）。無ければ null */
  marker: string | null;
  paragraphs: DocxExpectedParagraph[];
}

export interface DocxExpectedTable {
  /** 表の前の見出し（照合の手掛かり） */
  heading: string;
  header: string[];
  rows: Array<{ location: string; cells: string[] }>;
}

export interface DocxExpectation {
  /** 本文より前（表紙・草稿の未承認箇所）。読み戻した先頭から順に照合する */
  preamble: DocxExpectedParagraph[];
  blocks: DocxExpectedBlock[];
  /** 付表（本文で引用した数値）。引用が無ければ null */
  numberTable: DocxExpectedTable | null;
  /** 追跡表（社内確認用だけ）。無ければ null */
  traceTable: DocxExpectedTable | null;
  /** 追跡表より後ろ（社内確認用の節の版と承認状態・社内コメント）。順に照合する */
  trailer: DocxExpectedParagraph[];
}

function emptyResult(): ReconciliationResult {
  return { paragraphs: 0, numbers: 0, rows: 0, mismatchCount: 0, mismatches: [] };
}

function push(result: ReconciliationResult, item: ExportReconciliationMismatch): void {
  result.mismatchCount += 1;
  result.mismatches.push(item);
}

/**
 * 期待値に無い段落（読み戻した並びの from 〜 to の手前）を、1 段落ずつ「余分」として数える。
 * 節の末尾・表の前後・文書の末尾に外部で足した記述を、照合を飛ばして「一致」にしないため
 */
function pushExtras(
  actual: readonly string[],
  from: number,
  to: number,
  after: string,
  result: ReconciliationResult,
): void {
  for (let k = from; k < to; k += 1) {
    push(result, mismatch('extra', `${after}の後`, '（なし）', actual[k] ?? ''));
  }
}

/**
 * 段落の並びを読み戻した位置から順に照合する。余計な段落が 1 つ入っている（次が期待どおり）なら
 * 余分として数えて続ける。戻り値は照合した次の位置
 */
function compareSequence(
  expected: readonly DocxExpectedParagraph[],
  actual: readonly string[],
  from: number,
  result: ReconciliationResult,
  count: () => void,
): number {
  let i = from;
  for (const paragraph of expected) {
    count();
    const want = normalizeText(paragraph.text);
    if (actual[i] === want) {
      i += 1;
      continue;
    }
    if (actual[i + 1] === want) {
      push(result, mismatch('extra', paragraph.location, '（なし）', actual[i] ?? ''));
      i += 2;
      continue;
    }
    push(result, mismatch('paragraph', paragraph.location, want, actual[i] ?? MISSING));
    i += 1;
  }
  return i;
}

/**
 * 表の空でないセルを、読み戻した段落の並びと順に照合する。表の見出しより前に残った段落は余分として数える。
 * 戻り値は表の後ろの位置
 */
function compareDocxTable(
  table: DocxExpectedTable,
  actual: readonly string[],
  from: number,
  after: string,
  kind: MismatchKind,
  result: ReconciliationResult,
  count: (n: number) => void,
): number {
  const headingIndex = actual.indexOf(normalizeText(table.heading), from);
  if (headingIndex < 0) {
    push(result, mismatch('missing', table.heading, table.heading, MISSING));
    count(table.rows.length);
    return from;
  }
  pushExtras(actual, from, headingIndex, after, result);
  let i = headingIndex + 1;
  for (const cell of table.header.map(normalizeText).filter((c) => c !== '')) {
    if (actual[i] === cell) i += 1;
    else {
      push(result, mismatch('row', `${table.heading} 見出し`, cell, actual[i] ?? MISSING));
      i += 1;
    }
  }
  for (const row of table.rows) {
    count(1);
    const cells = row.cells.map(normalizeText).filter((c) => c !== '');
    const got = actual.slice(i, i + cells.length);
    const differs = cells.findIndex((cell, k) => got[k] !== cell);
    if (differs >= 0) {
      push(result, mismatch(kind, row.location, cells[differs] ?? '', got[differs] ?? MISSING));
    }
    i += cells.length;
  }
  return i;
}

/**
 * DOCX の読み戻し（段落の並び。表のセルも 1 段落として並ぶ）と期待値を照合する。
 * 表紙から文書の末尾まで、期待値の並びを順にたどる。節は見出しを手掛かりに照合し直す（余計な段落が
 * 入っても次の節から合わせる）が、飛ばした段落（前の節の末尾・表の前後・文書の末尾に足した記述）は
 * すべて余分として数える。読み戻した段落を 1 つも照合せずに残さない（外部で足した主張を「一致」にしない）
 */
export function compareDocx(
  expectation: DocxExpectation,
  paragraphs: readonly string[],
): ReconciliationResult {
  const result = emptyResult();
  const actual = paragraphs.map(normalizeText).filter((p) => p !== '');
  // 表紙・草稿の未承認箇所は件数に数えない（照合はする）
  let cursor = compareSequence(expectation.preamble, actual, 0, result, () => {});
  let after = '表紙';
  for (const block of expectation.blocks) {
    const titleIndex = actual.indexOf(normalizeText(block.title), cursor);
    if (titleIndex < 0) {
      result.paragraphs += block.paragraphs.length;
      push(result, mismatch('missing', `節「${block.title}」`, block.title, MISSING));
      continue;
    }
    pushExtras(actual, cursor, titleIndex, after, result);
    let i = titleIndex + 1;
    if (block.marker !== null) {
      const marker = normalizeText(block.marker);
      if (actual[i] === marker) i += 1;
      else
        push(result, mismatch('paragraph', `${block.title} の注記`, marker, actual[i] ?? MISSING));
    }
    cursor = compareSequence(block.paragraphs, actual, i, result, () => {
      result.paragraphs += 1;
    });
    after = `節「${block.title}」`;
  }
  if (expectation.numberTable) {
    cursor = compareDocxTable(
      expectation.numberTable,
      actual,
      cursor,
      after,
      'number',
      result,
      (n) => {
        result.numbers += n;
      },
    );
    after = expectation.numberTable.heading;
  }
  if (expectation.traceTable) {
    cursor = compareDocxTable(expectation.traceTable, actual, cursor, after, 'row', result, (n) => {
      result.rows += n;
    });
    after = expectation.traceTable.heading;
  }
  if (expectation.trailer.length > 0) {
    const first = normalizeText(expectation.trailer[0]!.text);
    // 巻末の最初の見出しまでに残った段落（追跡表の後ろに足した行など）は余分
    const start = actual.indexOf(first, cursor);
    if (start >= 0) {
      pushExtras(actual, cursor, start, after, result);
      cursor = start;
    }
    cursor = compareSequence(expectation.trailer, actual, cursor, result, () => {});
    after = '巻末';
  }
  pushExtras(actual, cursor, actual.length, after, result);
  return result;
}

// ======================================================================
// 表（XLSX のシート・CSV）
// ======================================================================

export type ExpectedCell = string | number | null;

export interface SheetExpectation {
  name: string;
  header: ExpectedCell[];
  rows: Array<{ kind: 'paragraph' | 'number' | 'row'; cells: ExpectedCell[] }>;
}

/** 読み戻したシート（行ごとのセルの値。1 行目が見出し） */
export type ActualSheet = ReadonlyArray<ReadonlyArray<unknown>>;

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function compareRow(
  sheetName: string,
  rowNo: number,
  expected: readonly ExpectedCell[],
  actual: ReadonlyArray<unknown> | undefined,
  kind: MismatchKind,
  result: ReconciliationResult,
): void {
  const width = Math.max(expected.length, actual?.length ?? 0);
  for (let c = 0; c < width; c += 1) {
    const want = normalizeCell(expected[c]);
    const got = normalizeCell(actual?.[c]);
    if (want !== got) {
      push(
        result,
        mismatch(kind, `${sheetName}!${columnLetter(c)}${rowNo}`, want, got === '' ? MISSING : got),
      );
      // 同じ行の続きのセルは数えない（1 行の違いを 1 件として示す）
      return;
    }
  }
}

/** シート単位でセルを照合する。シートが無ければ 1 件の不一致（見つからない） */
export function compareSheets(
  expected: readonly SheetExpectation[],
  actual: ReadonlyMap<string, ActualSheet>,
): ReconciliationResult {
  const result = emptyResult();
  for (const sheet of expected) {
    const rows = actual.get(sheet.name);
    for (const row of sheet.rows) {
      if (row.kind === 'paragraph') result.paragraphs += 1;
      else if (row.kind === 'number') result.numbers += 1;
      else result.rows += 1;
    }
    if (!rows) {
      push(result, mismatch('missing', `シート「${sheet.name}」`, sheet.name, MISSING));
      continue;
    }
    compareRow(sheet.name, 1, sheet.header, rows[0], 'row', result);
    sheet.rows.forEach((row, index) => {
      const kind: MismatchKind = row.kind === 'paragraph' ? 'paragraph' : row.kind;
      compareRow(sheet.name, index + 2, row.cells, rows[index + 1], kind, result);
    });
    const extra = rows.length - 1 - sheet.rows.length;
    if (extra > 0) {
      push(
        result,
        mismatch(
          'extra',
          `${sheet.name}!${sheet.rows.length + 2} 行目以降`,
          '（なし）',
          `${extra} 行`,
        ),
      );
    }
  }
  // 期待値に無いシート（外部で足したシート）は余分。照合しないまま「一致」にしない
  const expectedNames = new Set(expected.map((s) => s.name));
  for (const [name, rows] of actual) {
    if (expectedNames.has(name)) continue;
    push(result, mismatch('extra', `シート「${name}」`, '（なし）', `${rows.length} 行`));
  }
  return result;
}

/**
 * CSV を行・セルに分ける（RFC 4180。引用符の中の , 改行 "" を扱う）。先頭の BOM と末尾の空行は落とす
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ======================================================================
// 承認の照合
// ======================================================================

/**
 * 承認済みスナップショットなら、対象の節がすべて承認版（固定した版＝承認済みの版）で、本文が引用した
 * 数値がすべて承認済みであること。草稿は未承認を含むのが前提のため照合しない（空を返す）
 */
export function approvalMismatches(
  snapshot: Pick<ReportSnapshotDetail, 'snapshotKind' | 'blocks' | 'metricValues'>,
  frameworkVersionId: Uuid | null,
): ExportReconciliationMismatch[] {
  if (snapshot.snapshotKind !== 'approved') return [];
  const out: ExportReconciliationMismatch[] = [];
  const blocks = snapshot.blocks.filter(
    (b) => frameworkVersionId === null || b.frameworkVersionId === frameworkVersionId,
  );
  const cited = new Set<Uuid>();
  for (const block of blocks) {
    if (!block.isApprovedVersion || block.versionId === null) {
      out.push(mismatch('approval', `節「${block.title}」`, '承認済みの版', '未承認の版'));
    } else if (block.approvedVersionId !== null && block.approvedVersionId !== block.versionId) {
      out.push(
        mismatch('approval', `節「${block.title}」`, '承認済みの版', '承認済みの版と違う版'),
      );
    }
    for (const paragraph of block.body.paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'metric') cited.add(inline.dataPointVersionId);
      }
    }
  }
  for (const id of cited) {
    const mv = snapshot.metricValues.find((m) => m.dataPointVersionId === id);
    if (!mv) {
      out.push(mismatch('approval', '引用した数値', '承認済みの版', '写しに無い版'));
    } else if (!mv.versionApproved) {
      out.push(
        mismatch(
          'approval',
          `${mv.metricName}（${mv.unitName}・${mv.periodCode}）`,
          '承認済みの版',
          `版 ${mv.versionNo}（未承認）`,
        ),
      );
    }
  }
  return out;
}

/** 照合の結果を 1 つにまとめる（件数を足し、明細を並べる） */
export function mergeResults(...results: ReconciliationResult[]): ReconciliationResult {
  const out = emptyResult();
  for (const r of results) {
    out.paragraphs += r.paragraphs;
    out.numbers += r.numbers;
    out.rows += r.rows;
    out.mismatchCount += r.mismatchCount;
    out.mismatches.push(...r.mismatches);
  }
  return out;
}

/** 承認の照合の不一致を結果に足す */
export function withApprovalCheck(
  result: ReconciliationResult,
  approval: readonly ExportReconciliationMismatch[],
): ReconciliationResult {
  return {
    ...result,
    mismatchCount: result.mismatchCount + approval.length,
    mismatches: [...approval, ...result.mismatches],
  };
}

// ======================================================================
// 表示の補助（画面・出力で同じ言い方にする）
// ======================================================================

export type ReconciliationStateKey =
  'matched' | 'mismatched' | 'nothing_checked' | 'not_reconciled';

/**
 * 照合の結果の状態。不一致が 0 件でも、照合した段落・数値・行が 1 つも無ければ「一致」とは言わない
 * （節の無い基準の原稿など。何も比べていないのに一致と示さない）
 */
export function reconciliationOutcomeOf(
  mismatchCount: number,
  counts: { paragraphs: number | null; numbers: number | null; rows: number | null },
): Exclude<ReconciliationStateKey, 'not_reconciled'> {
  if (mismatchCount > 0) return 'mismatched';
  const checked = (counts.paragraphs ?? 0) + (counts.numbers ?? 0) + (counts.rows ?? 0);
  return checked > 0 ? 'matched' : 'nothing_checked';
}

/** 出力の記録の突合の状態。列が null の出力（突合の列を足す前の出力）は未突合 */
export function reconciliationStateOf(
  artifact: Pick<
    ExportArtifact,
    | 'mismatchCount'
    | 'checkerVersion'
    | 'reconciledParagraphs'
    | 'reconciledNumbers'
    | 'reconciledRows'
  >,
): ReconciliationStateKey {
  if (artifact.mismatchCount === null || artifact.checkerVersion === null) return 'not_reconciled';
  return reconciliationOutcomeOf(artifact.mismatchCount, {
    paragraphs: artifact.reconciledParagraphs,
    numbers: artifact.reconciledNumbers,
    rows: artifact.reconciledRows,
  });
}

/** 件数の内訳（例「段落 12・数値 4」）。0 件の区分は省く。全部 0 なら「照合対象なし」 */
export function reconciledCountsText(counts: {
  paragraphs: number | null;
  numbers: number | null;
  rows: number | null;
}): string {
  const parts = [
    counts.paragraphs ? `段落 ${counts.paragraphs}` : null,
    counts.numbers ? `数値 ${counts.numbers}` : null,
    counts.rows ? `行 ${counts.rows}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join('・') : '照合対象なし';
}

export const MISMATCH_KIND_LABELS: Readonly<Record<MismatchKind, string>> = {
  paragraph: '段落',
  number: '数値',
  row: '行',
  approval: '承認',
  missing: '見つからない',
  extra: '余分',
};
