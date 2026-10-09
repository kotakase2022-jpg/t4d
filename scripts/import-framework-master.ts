/**
 * 基準マスター（要求事項の構造）の登録スクリプト（トライアル対応 NF-07・NF-08。運営側〔Suslab〕だけが使う）。
 *
 *   # 検証と差分レポートだけ（既定。ファイルは書かない）
 *   pnpm exec tsx scripts/import-framework-master.ts --input master.json [--previous-fixture esrs_40a/esrs-40a-trial-sample]
 *   pnpm exec tsx scripts/import-framework-master.ts --input items.csv --meta version.json
 *   # 生成物を書く（src/lib/frameworks/imported/<基準>-<版コード>.json と index.ts を更新）→ pnpm seed:generate
 *   pnpm exec tsx scripts/import-framework-master.ts --input master.json --write [--report diff.md]
 *   # 空の登録簿（index.ts）だけを作る
 *   pnpm exec tsx scripts/import-framework-master.ts --init-registry
 *
 * 守っていること（docs/disclosure-first.md の規則・plan K5）:
 *  - 入れるのは**一次資料で人が確認した構造**だけ（項番・節・要約題名・回答型・前の版の項番・出典・確認日）。
 *    条文・本文を書き写す欄は無く、知らない欄（text・body・guidance など）を含む入力は拒否する。題名は 120 字まで
 *  - 公開草案は legalStatus 'draft'、試行用の架空サンプルは 'sample'（題名は「（サンプル）」で始め、
 *    項番は「-S01」の形。草案らしい項番を作らない）。サンプル以外は出典 URL・確認日・確認者が必須
 *  - 生成物は決定的（同じ入力から同じ ID・同じバイト列。実行日時を書かない）。ID は Fixture と同じ fid の規則
 *  - 差分（追加・削除・文言の変更・改番）は Markdown で出す（顧客の画面には出さない）。改番は前の版の項番
 *    （previousItemCode）で対応を取り、削除＋追加にしない（domain/framework-diff.ts）
 *  - 実在の顧客名・実データは入れない（マスターは基準の構造だけ）
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  FRAMEWORK_DIFF_KIND_LABELS,
  diffFrameworkItems,
  type DiffItem,
} from '../src/lib/domain/framework-diff';
import { fid } from '../src/lib/fixtures/ids';
import {
  ANSWER_TYPES,
  FRAMEWORK_COVERAGE_STATUSES,
  FRAMEWORK_KEYS,
  FRAMEWORK_LEGAL_STATUSES,
  MATERIALITY_BASES,
  type AnswerType,
  type DisclosureFrameworkVersion,
  type DisclosureItem,
  type FrameworkCoverageStatus,
  type FrameworkKey,
  type FrameworkLegalStatus,
  type ItemChangeType,
  type MaterialityBasis,
} from '../src/types/domain';

// ----------------------------------------------------------------------
// 入力の形
// ----------------------------------------------------------------------

export const MASTER_SCHEMA = 't4d-framework-master@1';

/** 題名（要約）の上限。条文を書き写させない */
export const TITLE_MAX = 120;
export const SECTION_MAX = 120;
export const CODE_MAX = 40;
export const SOURCE_MAX = 300;

const VERSION_KEYS = [
  'frameworkKey',
  'versionCode',
  'label',
  'year',
  'status',
  'legalStatus',
  'coverageStatus',
  'coverageNote',
  'materialityBasis',
  'issuedAt',
  'effectiveAt',
  'jurisdiction',
  'sourceUrl',
  'verifiedAt',
  'verifiedBy',
  'previousVersionCode',
  'items',
] as const;

const ITEM_KEYS = [
  'code',
  'section',
  'title',
  'answerType',
  'previousItemCode',
  'source',
  'verifiedOn',
  'required',
  'parentCode',
  'options',
] as const;

export interface MasterItemInput {
  code: string;
  section: string;
  /** 要約題名（本アプリで付した要約。条文ではない） */
  title: string;
  answerType: AnswerType;
  previousItemCode: string | null;
  /** 出典（資料名・節・段落など。URL は版の sourceUrl） */
  source: string;
  /** 一次資料で確認した日 */
  verifiedOn: string | null;
  required: boolean;
  parentCode: string | null;
  options: string[];
}

export interface MasterInput {
  frameworkKey: FrameworkKey;
  versionCode: string;
  label: string;
  year: number;
  status: DisclosureFrameworkVersion['status'];
  legalStatus: FrameworkLegalStatus;
  coverageStatus: FrameworkCoverageStatus;
  coverageNote: string | null;
  materialityBasis: MaterialityBasis | null;
  issuedAt: string | null;
  effectiveAt: string | null;
  jurisdiction: string | null;
  sourceUrl: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  previousVersionCode: string | null;
  items: MasterItemInput[];
}

/** 生成物（Fixture に入れる行と同じ形。ID は決定的） */
export interface FrameworkMasterFile {
  schema: typeof MASTER_SCHEMA;
  frameworkKey: FrameworkKey;
  version: DisclosureFrameworkVersion;
  items: DisclosureItem[];
}

export class MasterValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `基準マスターの入力に誤りがあります（${problems.length} 件）:\n- ${problems.join('\n- ')}`,
    );
    this.name = 'MasterValidationError';
  }
}

// ----------------------------------------------------------------------
// 検証
// ----------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_CODE = /^[a-z0-9][a-z0-9._-]{1,60}$/;
/** 試行用サンプルの項番（例 40A-S01）。公開草案らしい項番を作らない */
const SAMPLE_CODE = /-S\d{2,}$/;
const SAMPLE_TITLE_PREFIX = '（サンプル）';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function str(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * 入力（JSON を読んだ値）を検査して、型の付いた入力にする。誤りはまとめて MasterValidationError で返す
 */
export function parseMasterInput(
  raw: unknown,
  options: { previousItemCodes?: ReadonlySet<string> | null } = {},
): MasterInput {
  const problems: string[] = [];
  if (!isRecord(raw))
    throw new MasterValidationError(['入力が JSON のオブジェクトではありません。']);

  for (const key of Object.keys(raw)) {
    if (!(VERSION_KEYS as readonly string[]).includes(key)) {
      problems.push(`版に知らない欄「${key}」があります（条文・本文は収録しません）。`);
    }
  }

  const frameworkKey = str(raw.frameworkKey);
  if (!frameworkKey || !(FRAMEWORK_KEYS as readonly string[]).includes(frameworkKey)) {
    problems.push(`frameworkKey は ${FRAMEWORK_KEYS.join('／')} のどれかにしてください。`);
  }
  const versionCode = str(raw.versionCode) ?? '';
  if (!VERSION_CODE.test(versionCode)) {
    problems.push('versionCode は半角英小文字・数字・. _ - の 2〜61 文字にしてください。');
  }
  const label = str(raw.label) ?? '';
  if (!label || label.length > TITLE_MAX)
    problems.push(`label は 1〜${TITLE_MAX} 字にしてください。`);
  const year = raw.year;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 2100) {
    problems.push('year は 2000〜2100 の整数にしてください。');
  }
  const status = str(raw.status) ?? 'draft';
  if (!['draft', 'published', 'superseded'].includes(status)) {
    problems.push('status は draft／published／superseded のどれかにしてください。');
  }
  const legalStatus = str(raw.legalStatus);
  if (!legalStatus || !(FRAMEWORK_LEGAL_STATUSES as readonly string[]).includes(legalStatus)) {
    problems.push(`legalStatus は ${FRAMEWORK_LEGAL_STATUSES.join('／')} のどれかにしてください。`);
  }
  const coverageStatus = str(raw.coverageStatus);
  if (
    !coverageStatus ||
    !(FRAMEWORK_COVERAGE_STATUSES as readonly string[]).includes(coverageStatus)
  ) {
    problems.push(
      `coverageStatus は ${FRAMEWORK_COVERAGE_STATUSES.join('／')} のどれかにしてください。`,
    );
  }
  const materialityBasis = str(raw.materialityBasis);
  if (
    materialityBasis !== null &&
    !(MATERIALITY_BASES as readonly string[]).includes(materialityBasis)
  ) {
    problems.push(
      `materialityBasis は ${MATERIALITY_BASES.join('／')} のどれか（または null）にしてください。`,
    );
  }
  const isSample = legalStatus === 'sample';
  if (isSample && coverageStatus !== 'sample') {
    problems.push(
      '試行用サンプル（legalStatus sample）は coverageStatus も sample にしてください。',
    );
  }
  if (!isSample && coverageStatus === 'sample') {
    problems.push('coverageStatus sample は試行用サンプル（legalStatus sample）だけに使えます。');
  }

  const dates: Array<[string, string | null]> = [
    ['issuedAt', str(raw.issuedAt)],
    ['effectiveAt', str(raw.effectiveAt)],
    ['verifiedAt', str(raw.verifiedAt)],
  ];
  for (const [name, value] of dates) {
    if (value !== null && value !== '' && !isValidDate(value)) {
      problems.push(`${name} は YYYY-MM-DD の日付にしてください。`);
    }
  }
  const sourceUrl = str(raw.sourceUrl);
  const verifiedAt = str(raw.verifiedAt);
  const verifiedBy = str(raw.verifiedBy);
  if (!isSample) {
    // 一次資料で確認した構造だけを入れる（出典・確認日・確認者が無いものは入れない）
    if (!sourceUrl || !/^https:\/\/[^\s]+$/.test(sourceUrl)) {
      problems.push('sourceUrl（一次資料の https の URL）が必要です。');
    }
    if (!verifiedAt) problems.push('verifiedAt（一次資料で確認した日）が必要です。');
    if (!verifiedBy) problems.push('verifiedBy（確認した人・組織）が必要です。');
  } else if (sourceUrl !== null && sourceUrl !== '' && !/^https:\/\/[^\s]+$/.test(sourceUrl)) {
    problems.push('sourceUrl は https の URL にしてください。');
  }

  const rawItems = Array.isArray(raw.items) ? raw.items : null;
  if (!rawItems) problems.push('items（要求事項の配列）が必要です。');
  const items: MasterItemInput[] = [];
  if (rawItems) {
    if (rawItems.length === 0 && coverageStatus !== 'not_loaded') {
      problems.push('要求事項が 0 件の版は coverageStatus を not_loaded にしてください。');
    }
    if (rawItems.length > 0 && coverageStatus === 'not_loaded') {
      problems.push('要求事項を収録する版に coverageStatus not_loaded は使えません。');
    }
    const seen = new Set<string>();
    rawItems.forEach((entry, index) => {
      const at = `items[${index + 1}]`;
      if (!isRecord(entry)) {
        problems.push(`${at}: オブジェクトではありません。`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!(ITEM_KEYS as readonly string[]).includes(key)) {
          problems.push(`${at}: 知らない欄「${key}」があります（条文・本文は収録しません）。`);
        }
      }
      const code = str(entry.code) ?? '';
      const section = str(entry.section) ?? '';
      const title = str(entry.title) ?? '';
      const answerType = str(entry.answerType) ?? 'text';
      const previousItemCode = str(entry.previousItemCode) || null;
      const source = str(entry.source) ?? '';
      const verifiedOn = str(entry.verifiedOn) || null;
      const parentCode = str(entry.parentCode) || null;
      if (!code || code.length > CODE_MAX || /\s/.test(code)) {
        problems.push(`${at}: code は空白を含まない 1〜${CODE_MAX} 字にしてください。`);
      } else if (seen.has(code)) {
        problems.push(`${at}: code「${code}」が重複しています。`);
      }
      seen.add(code);
      if (!section || section.length > SECTION_MAX) {
        problems.push(`${at}: section は 1〜${SECTION_MAX} 字にしてください。`);
      }
      if (!title || title.length > TITLE_MAX || /[\r\n]/.test(title)) {
        problems.push(
          `${at}: title（要約題名）は改行を含まない 1〜${TITLE_MAX} 字にしてください（条文を書き写さない）。`,
        );
      }
      if (!(ANSWER_TYPES as readonly string[]).includes(answerType)) {
        problems.push(`${at}: answerType は ${ANSWER_TYPES.join('／')} のどれかにしてください。`);
      }
      if (source.length > SOURCE_MAX) problems.push(`${at}: source は ${SOURCE_MAX} 字までです。`);
      if (verifiedOn !== null && !isValidDate(verifiedOn)) {
        problems.push(`${at}: verifiedOn は YYYY-MM-DD の日付にしてください。`);
      }
      if (isSample) {
        if (!title.startsWith(SAMPLE_TITLE_PREFIX)) {
          problems.push(
            `${at}: 試行用サンプルの題名は「${SAMPLE_TITLE_PREFIX}」で始めてください。`,
          );
        }
        if (!SAMPLE_CODE.test(code)) {
          problems.push(
            `${at}: 試行用サンプルの項番は「-S01」の形にしてください（公開草案らしい項番を作らない）。`,
          );
        }
      } else {
        if (!source) problems.push(`${at}: source（出典）が必要です。`);
        if (!verifiedOn) problems.push(`${at}: verifiedOn（確認日）が必要です。`);
      }
      if (
        previousItemCode &&
        options.previousItemCodes &&
        !options.previousItemCodes.has(previousItemCode)
      ) {
        problems.push(`${at}: previousItemCode「${previousItemCode}」は前の版にありません。`);
      }
      const opts = Array.isArray(entry.options) ? entry.options : [];
      if (!opts.every((o) => typeof o === 'string' && o.length <= TITLE_MAX)) {
        problems.push(`${at}: options は ${TITLE_MAX} 字までの文字列の配列にしてください。`);
      }
      items.push({
        code,
        section,
        title,
        answerType: answerType as AnswerType,
        previousItemCode,
        source,
        verifiedOn,
        required: entry.required === true,
        parentCode,
        options: opts.filter((o): o is string => typeof o === 'string'),
      });
    });
    const previousCodes = items.map((i) => i.previousItemCode).filter((c): c is string => !!c);
    for (const code of new Set(previousCodes)) {
      if (previousCodes.filter((c) => c === code).length > 1) {
        problems.push(
          `previousItemCode「${code}」が複数の要求事項に付いています（対応は 1 対 1）。`,
        );
      }
    }
    for (const item of items) {
      if (item.parentCode && !seen.has(item.parentCode)) {
        problems.push(
          `code「${item.code}」の parentCode「${item.parentCode}」がこの版にありません。`,
        );
      }
    }
  }

  if (problems.length > 0) throw new MasterValidationError(problems);
  return {
    frameworkKey: frameworkKey as FrameworkKey,
    versionCode,
    label,
    year: year as number,
    status: status as MasterInput['status'],
    legalStatus: legalStatus as FrameworkLegalStatus,
    coverageStatus: coverageStatus as FrameworkCoverageStatus,
    coverageNote: str(raw.coverageNote) || null,
    materialityBasis: (materialityBasis as MaterialityBasis | null) ?? null,
    issuedAt: str(raw.issuedAt) || null,
    effectiveAt: str(raw.effectiveAt) || null,
    jurisdiction: str(raw.jurisdiction) || null,
    sourceUrl: sourceUrl || null,
    verifiedAt: verifiedAt || null,
    verifiedBy: verifiedBy || null,
    previousVersionCode: str(raw.previousVersionCode) || null,
    items,
  };
}

// ----------------------------------------------------------------------
// CSV（要求事項）＋版の JSON
// ----------------------------------------------------------------------

/** RFC 4180 の CSV を読む（ダブルクォート・改行を含む値・BOM に対応） */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
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
    } else if (ch === '\n' || ch === '\r') {
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
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const CSV_COLUMNS: Record<string, (typeof ITEM_KEYS)[number]> = {
  code: 'code',
  section: 'section',
  title: 'title',
  answer_type: 'answerType',
  previous_item_code: 'previousItemCode',
  source: 'source',
  verified_on: 'verifiedOn',
  required: 'required',
  parent_code: 'parentCode',
};

/** 要求事項の CSV（見出し行あり）を items の配列にする。知らない列は欄として残し、検査で拒否する */
export function csvToItems(text: string): Array<Record<string, unknown>> {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  return rows.slice(1).map((cells) => {
    const entry: Record<string, unknown> = {};
    header.forEach((name, index) => {
      const key = CSV_COLUMNS[name] ?? name;
      const value = (cells[index] ?? '').trim();
      if (key === 'required')
        entry.required = value === 'true' || value === '1' || value === '必須';
      else entry[key] = value === '' ? null : value;
    });
    return entry;
  });
}

// ----------------------------------------------------------------------
// 生成物（決定的）
// ----------------------------------------------------------------------

function changeTypeOf(
  item: MasterItemInput,
  previous: ReadonlyMap<string, Pick<DisclosureItem, 'questionText'>> | null,
): ItemChangeType {
  if (!previous) return 'new';
  const prior = previous.get(item.previousItemCode ?? item.code);
  if (!prior) return 'new';
  return prior.questionText === item.title ? 'carry_forward' : 'changed';
}

/**
 * Fixture に入れる行（版と要求事項）を作る。ID・日時は入力だけから決める（実行のたびに変わらない）
 */
export function buildFrameworkMasterFile(
  input: MasterInput,
  previousItems: ReadonlyArray<Pick<DisclosureItem, 'code' | 'questionText'>> | null = null,
): FrameworkMasterFile {
  const versionKey = `${input.frameworkKey}/${input.versionCode}`;
  const createdAt = `${input.verifiedAt ?? `${input.year}-01-01`}T00:00:00.000Z`;
  const previous = previousItems ? new Map(previousItems.map((i) => [i.code, i])) : null;
  const version: DisclosureFrameworkVersion = {
    id: fid('framework_version', versionKey),
    frameworkId: fid('framework', input.frameworkKey),
    year: input.year,
    label: input.label,
    status: input.status,
    isFixture: input.legalStatus === 'sample',
    createdAt,
    versionCode: input.versionCode,
    legalStatus: input.legalStatus,
    issuedAt: input.issuedAt,
    effectiveAt: input.effectiveAt,
    jurisdiction: input.jurisdiction,
    materialityBasis: input.materialityBasis,
    sourceUrl: input.sourceUrl,
    verifiedAt: input.verifiedAt,
    verifiedBy: input.verifiedBy,
    coverageStatus: input.coverageStatus,
    coverageNote: input.coverageNote,
  };
  const items: DisclosureItem[] = input.items.map((item, index) => ({
    id: fid('disclosure_item', `${versionKey}/${item.code}`),
    frameworkVersionId: version.id,
    code: item.code,
    section: item.section,
    sortOrder: index,
    questionText: item.title,
    // 条文は入れない。出典（資料の節・段落）だけ。確認日は差分に出ないよう生成物の別の欄に残さない
    guidance: item.source ? `出典: ${item.source}` : '',
    answerType: item.answerType,
    options: item.options,
    required: item.required,
    parentCode: item.parentCode,
    changeType: changeTypeOf(item, previous),
    previousItemCode: item.previousItemCode,
    createdAt,
  }));
  return { schema: MASTER_SCHEMA, frameworkKey: input.frameworkKey, version, items };
}

/** 決定的な JSON（キーの順を固定・末尾に改行） */
export function serializeMasterFile(file: FrameworkMasterFile): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortKeys(value[key])]),
      );
    }
    return value;
  };
  return `${JSON.stringify(sortKeys(file), null, 2)}\n`;
}

export function masterFileName(
  file: Pick<FrameworkMasterFile, 'frameworkKey' | 'version'>,
): string {
  return `${file.frameworkKey}-${file.version.versionCode ?? 'unknown'}.json`;
}

/** 生成した JSON の一覧から、登録簿（index.ts）の本文を作る（決定的。名前順） */
export function renderRegistry(fileNames: readonly string[]): string {
  const sorted = [...fileNames].filter((n) => n.endsWith('.json')).sort();
  const imports = sorted.map((name, index) => `import master${index} from './${name}';`).join('\n');
  const list = sorted
    .map((_, index) => `  master${index} as unknown as ImportedFrameworkMaster,`)
    .join('\n');
  return `/**
 * 登録スクリプト（scripts/import-framework-master.ts）が生成する基準マスターの登録簿。手で編集しない。
 * 一次資料で人が確認した構造（項番・節・要約題名・出典・確認日）だけ。条文は入れない。
 * Fixture（src/lib/fixtures/store.ts）がこの一覧を読み、pnpm seed:generate で seed.sql に入る。
 */
import type { DisclosureFrameworkVersion, DisclosureItem, FrameworkKey } from '@/types/domain';
${imports ? `${imports}\n` : ''}
export interface ImportedFrameworkMaster {
  schema: '${MASTER_SCHEMA}';
  frameworkKey: FrameworkKey;
  version: DisclosureFrameworkVersion;
  items: DisclosureItem[];
}

export const IMPORTED_FRAMEWORK_MASTERS: readonly ImportedFrameworkMaster[] = [${list ? `\n${list}\n` : ''}];
`;
}

// ----------------------------------------------------------------------
// 差分レポート（Markdown。運営側だけ）
// ----------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function renderDiffReport(
  previous: { label: string; items: readonly DiffItem[] } | null,
  next: FrameworkMasterFile,
): string {
  const lines: string[] = [
    `# 基準マスターの差分: ${next.version.label}`,
    '',
    '運営側の確認用（顧客の画面には出しません）。改番は前の版の項番（previousItemCode）で対応を取っています。',
    '対応付け（節・定性情報・横断対応表・対象外の判断）の引継ぎは自動では行いません。影響先は開示プロジェクトの設定タブで「要再確認」として確認します。',
    '',
    `- 基準: ${next.frameworkKey}／版コード: ${next.version.versionCode ?? '—'}／位置付け: ${next.version.legalStatus ?? '—'}／収録: ${next.version.coverageStatus ?? '—'}`,
    `- 出典: ${next.version.sourceUrl ?? '（サンプル）'}／確認日: ${next.version.verifiedAt ?? '—'}／確認者: ${next.version.verifiedBy ?? '—'}`,
    `- 要求事項: ${next.items.length} 件`,
    '',
  ];
  if (!previous) {
    lines.push('前の版の指定が無いため、すべて追加として扱います。', '');
    return `${lines.join('\n')}\n`;
  }
  const diff = diffFrameworkItems(previous.items, next.items);
  lines.push(
    `## 比較元: ${previous.label}`,
    '',
    `| 区分 | 件数 |`,
    `| --- | ---: |`,
    `| ${FRAMEWORK_DIFF_KIND_LABELS.added} | ${diff.added.length} |`,
    `| ${FRAMEWORK_DIFF_KIND_LABELS.removed} | ${diff.removed.length} |`,
    `| ${FRAMEWORK_DIFF_KIND_LABELS.changed} | ${diff.changed.length} |`,
    `| ${FRAMEWORK_DIFF_KIND_LABELS.renumbered} | ${diff.renumbered.length} |`,
    `| ${FRAMEWORK_DIFF_KIND_LABELS.unchanged} | ${diff.unchangedCount} |`,
    '',
  );
  const changed = diff.entries.filter((e) => e.kind !== 'unchanged');
  if (changed.length > 0) {
    lines.push('| 区分 | 前の版の項番 | 新しい版の項番 | 題名 |', '| --- | --- | --- | --- |');
    for (const e of changed) {
      const kind =
        e.kind === 'renumbered' && e.textChanged
          ? `${FRAMEWORK_DIFF_KIND_LABELS.renumbered}（文言も変更）`
          : FRAMEWORK_DIFF_KIND_LABELS[e.kind];
      lines.push(
        `| ${kind} | ${escapeCell(e.fromCode ?? '—')} | ${escapeCell(e.toCode ?? '—')} | ${escapeCell(e.title)} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------

export const DEFAULT_OUT_DIR = path.join('src', 'lib', 'frameworks', 'imported');

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function loadPrevious(
  args: readonly string[],
): Promise<{ label: string; items: DisclosureItem[] } | null> {
  const fromFile = argValue(args, '--previous');
  if (fromFile) {
    const file = JSON.parse(await readFile(fromFile, 'utf8')) as FrameworkMasterFile;
    return { label: file.version.label, items: file.items };
  }
  const fromFixture = argValue(args, '--previous-fixture');
  if (fromFixture) {
    const [key, code] = fromFixture.split('/');
    // Fixture の版（架空サンプル・SSBJ の正式版など）と比べる。読むだけ
    const { createFixtureDb } = await import('../src/lib/fixtures/store');
    const db = createFixtureDb();
    const framework = db.frameworks.find((f) => f.key === key);
    const version = db.frameworkVersions.find(
      (v) => v.frameworkId === framework?.id && (v.versionCode === code || v.id === code),
    );
    if (!version) throw new Error(`前の版 ${fromFixture} が Fixture にありません。`);
    return {
      label: version.label,
      items: db.disclosureItems.filter((i) => i.frameworkVersionId === version.id),
    };
  }
  return null;
}

async function readInput(args: readonly string[]): Promise<unknown> {
  const input = argValue(args, '--input');
  if (!input) throw new Error('--input <master.json|items.csv> を指定してください。');
  const text = await readFile(input, 'utf8');
  if (input.toLowerCase().endsWith('.csv')) {
    const metaPath = argValue(args, '--meta');
    if (!metaPath)
      throw new Error('CSV の要求事項には --meta <version.json>（版の情報）が必要です。');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    return { ...meta, items: csvToItems(text) };
  }
  return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
}

async function writeRegistry(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const names = (await readdir(outDir)).filter((n) => n.endsWith('.json'));
  await writeFile(path.join(outDir, 'index.ts'), renderRegistry(names), 'utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = path.resolve(process.cwd(), argValue(args, '--out-dir') ?? DEFAULT_OUT_DIR);
  if (args.includes('--init-registry')) {
    await writeRegistry(outDir);
    console.log(
      `登録簿を書きました: ${path.relative(process.cwd(), path.join(outDir, 'index.ts'))}`,
    );
    return;
  }
  const previous = await loadPrevious(args);
  const parsed = parseMasterInput(await readInput(args), {
    previousItemCodes: previous ? new Set(previous.items.map((i) => i.code)) : null,
  });
  const file = buildFrameworkMasterFile(parsed, previous?.items ?? null);
  const report = renderDiffReport(previous, file);
  const reportPath = argValue(args, '--report');
  if (!args.includes('--write')) {
    console.log('検証に通りました（--write を付けるまでファイルは書きません）。\n');
    console.log(report);
    return;
  }
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, masterFileName(file));
  await writeFile(target, serializeMasterFile(file), 'utf8');
  await writeRegistry(outDir);
  if (reportPath) await writeFile(reportPath, report, 'utf8');
  else console.log(report);
  console.log(
    `書きました: ${path.relative(process.cwd(), target)}（次に pnpm seed:generate で seed.sql を作り直します）`,
  );
}

if (process.argv[1]?.endsWith('import-framework-master.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
