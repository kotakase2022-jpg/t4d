import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import { parseUploadedFile, validateUpload } from '@/lib/imports/parsers';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, DisclosureItem, FrameworkKey, Uuid } from '@/types/domain';

/**
 * 過去回答の Import・構造化（CDP-P0-003）。
 *
 * Excel / CSV / PDF / Word を受け取り、**質問単位へ分解**して
 * 「質問コード → 回答本文」の構造化データにする。
 *
 * 取り込んだ内容は必ず**プレビューを経て人が確認してから**保存する
 * （AI・自動処理が回答を確定しない）。保存先は過去期間の回答であり、
 * 当年度の回答は書き換えない。
 */

export interface ExtractedAnswer {
  itemCode: string;
  answerText: string;
  /** 元ファイル上の位置（行番号・ページ・段落番号） */
  locator: string;
}

export interface ImportPreviewRow extends ExtractedAnswer {
  /** マスターの質問と一致した場合のみ入る */
  itemId: Uuid | null;
  questionText: string | null;
  /** 既に同じ期間の回答が存在する場合は上書きになる */
  existingResponseId: Uuid | null;
  status: 'matched' | 'unknown_code' | 'empty_answer';
}

export interface ImportPreview {
  fileName: string;
  parsedAs: 'table' | 'pdf' | 'docx';
  rows: ImportPreviewRow[];
  warnings: string[];
}

/**
 * 質問コードらしき文字列。
 * CDP: C1.1 / C1.1b、CSRD: E1-6 など英字コードに加え、
 * SSBJ 正式マスターの「一般-9」「気候-47(1)」「気候-56-2」「実務-7」を認識する。
 */
const ITEM_CODE_PATTERN =
  /((?:一般|気候|実務)-\d{1,3}(?:-\d)?(?:\(\d\))?|\b(?:[A-Z]{1,6}\d*(?:[-.]\d+[a-z]?)+|[A-Z]{2,6}-[A-Z]\d+)\b)/;

/** 表のヘッダーから「質問コード列」「回答列」を推定する。 */
export function detectAnswerColumns(headers: string[]): {
  code: string | null;
  answer: string | null;
} {
  const norm = (s: string) => s.replace(/\s/g, '').toLowerCase();
  const code =
    headers.find((h) =>
      /(質問コード|設問コード|questioncode|itemcode|コード|code)/.test(norm(h)),
    ) ?? null;
  const answer = headers.find((h) => /(回答|answer|response|記載内容|内容)/.test(norm(h))) ?? null;
  return { code, answer };
}

/** 表形式（CSV / Excel）から質問単位の回答を取り出す。 */
export function extractFromTable(
  headers: string[],
  rows: Array<Record<string, string>>,
  rowNumbers: number[],
): { answers: ExtractedAnswer[]; warnings: string[] } {
  const { code, answer } = detectAnswerColumns(headers);
  if (!code || !answer) {
    return {
      answers: [],
      warnings: [
        `質問コード列と回答列を特定できませんでした（見出し: ${headers.join(' / ') || 'なし'}）。` +
          '「質問コード」「回答」という見出しを含む表にしてください。',
      ],
    };
  }

  const answers: ExtractedAnswer[] = [];
  rows.forEach((row, i) => {
    const rawCode = (row[code] ?? '').trim();
    if (!rawCode) return;
    answers.push({
      itemCode: rawCode,
      answerText: (row[answer] ?? '').trim(),
      locator: `行 ${rowNumbers[i] ?? i + 1}`,
    });
  });
  return { answers, warnings: [] };
}

/**
 * 連続したテキスト（PDF / Word）から質問単位の回答を取り出す。
 * 「質問コードで始まる行」を区切りとみなし、次の区切りまでを回答本文とする。
 */
export function extractFromLines(lines: Array<{ text: string; locator: string }>): {
  answers: ExtractedAnswer[];
  warnings: string[];
} {
  const answers: ExtractedAnswer[] = [];
  let currentCode: string | null = null;
  let currentLocator = '';
  let buffer: string[] = [];

  const flush = () => {
    if (currentCode) {
      answers.push({
        itemCode: currentCode,
        answerText: buffer.join('\n').trim(),
        locator: currentLocator,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    // 行頭の質問コードだけを区切りとみなす（本文中の言及で切らない）
    const head = text.match(new RegExp(`^${ITEM_CODE_PATTERN.source}`));
    if (head) {
      flush();
      currentCode = head[1] ?? null;
      currentLocator = line.locator;
      const rest = text.slice(head[0].length).replace(/^[\s:：.。、,]+/, '');
      if (rest) buffer.push(rest);
    } else if (currentCode) {
      buffer.push(text);
    }
  }
  flush();

  const warnings =
    answers.length === 0
      ? ['質問コードで始まる行が見つかりませんでした。「C1.1 ...」のような形式にしてください。']
      : [];
  return { answers, warnings };
}

export async function buildImportPreview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    frameworkKey: FrameworkKey;
    targetPeriodId: Uuid;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<ImportPreview> {
  assertCan(ctx, 'enterprise.disclosure.write');

  const validation = validateUpload(input.fileName, input.mimeType, input.bytes.byteLength);
  if (!validation.ok) throw new Error(validation.message ?? 'ファイルを受け付けられません。');

  const period = await db.findById('periods', input.targetPeriodId);
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }

  const parsed = await parseUploadedFile(validation.safeName, input.mimeType, input.bytes);
  let answers: ExtractedAnswer[];
  const warnings: string[] = [];
  let parsedAs: ImportPreview['parsedAs'];

  switch (parsed.kind) {
    case 'table': {
      parsedAs = 'table';
      const r = extractFromTable(parsed.table.headers, parsed.table.rows, parsed.table.rowNumbers);
      answers = r.answers;
      warnings.push(...parsed.table.warnings, ...r.warnings);
      break;
    }
    case 'pdf': {
      parsedAs = 'pdf';
      if (parsed.pdf.status !== 'parsed') {
        // 「抽出できなかった」を成功扱いにしない
        throw new Error(parsed.pdf.message ?? 'PDF からテキストを抽出できませんでした。');
      }
      const lines = parsed.pdf.pages.flatMap((p) =>
        p.text.split(/\r?\n/).map((text) => ({ text, locator: `p.${p.page}` })),
      );
      const r = extractFromLines(lines);
      answers = r.answers;
      warnings.push(...r.warnings);
      break;
    }
    case 'docx': {
      parsedAs = 'docx';
      if (parsed.docx.status !== 'parsed') {
        throw new Error(parsed.docx.message ?? 'Word から本文を抽出できませんでした。');
      }
      const r = extractFromLines(
        parsed.docx.paragraphs.map((text, i) => ({ text, locator: `段落 ${i + 1}` })),
      );
      answers = r.answers;
      warnings.push(...r.warnings);
      break;
    }
    default:
      throw new Error(parsed.message);
  }

  const items = await loadFrameworkItems(db, input.frameworkKey);
  const itemByCode = new Map(items.map((i) => [i.code.toUpperCase(), i]));
  const existing = await db.select('disclosureResponses', {
    where: {
      organizationId: ctx.workspace.organizationId,
      reportingPeriodId: input.targetPeriodId,
    },
  });
  const existingByItemId = new Map(existing.map((r) => [r.itemId, r]));

  const rows: ImportPreviewRow[] = answers.map((a) => {
    const item = itemByCode.get(a.itemCode.toUpperCase()) ?? null;
    const status: ImportPreviewRow['status'] = !item
      ? 'unknown_code'
      : a.answerText === ''
        ? 'empty_answer'
        : 'matched';
    return {
      ...a,
      itemId: item?.id ?? null,
      questionText: item?.questionText ?? null,
      existingResponseId: item ? (existingByItemId.get(item.id)?.id ?? null) : null,
      status,
    };
  });

  return { fileName: validation.safeName, parsedAs, rows, warnings };
}

export interface ConfirmImportResult {
  created: number;
  updated: number;
  linkedToCurrent: number;
}

/**
 * プレビューで人が選んだ行だけを保存する。
 * 過去期間の回答として保存し、当年度の回答には `previousResponseId` を張るだけで
 * **回答本文は書き換えない**。
 */
export async function confirmDisclosureImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    targetPeriodId: Uuid;
    currentPeriodId: Uuid;
    selections: Array<{ itemId: Uuid; answerText: string }>;
  },
): Promise<ConfirmImportResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  for (const periodId of [input.targetPeriodId, input.currentPeriodId]) {
    const period = await db.findById('periods', periodId);
    if (!period || period.organizationId !== organizationId) {
      throw new NotFoundError('報告期間が見つかりません。');
    }
  }
  if (input.targetPeriodId === input.currentPeriodId) {
    throw new Error('過去回答の取込先に当年度は指定できません。');
  }

  const targetResponses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: input.targetPeriodId },
  });
  const targetByItemId = new Map(targetResponses.map((r) => [r.itemId, r]));
  const currentResponses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: input.currentPeriodId },
  });
  const currentByItemId = new Map(currentResponses.map((r) => [r.itemId, r]));

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  let linkedToCurrent = 0;

  for (const sel of input.selections) {
    const item = await db.findById('disclosureItems', sel.itemId);
    if (!item) continue;

    const existing = targetByItemId.get(sel.itemId);
    let responseId: Uuid;

    if (existing) {
      await db.update('disclosureResponses', existing.id, {
        answerText: sel.answerText,
        updatedAt: now,
        updatedBy: ctx.userId,
      });
      responseId = existing.id;
      updated += 1;
    } else {
      responseId = fid(
        'disclosure_response',
        `${organizationId}/${sel.itemId}/${input.targetPeriodId}`,
      );
      await db.insert('disclosureResponses', [
        {
          id: responseId,
          organizationId,
          itemId: sel.itemId,
          reportingPeriodId: input.targetPeriodId,
          // 過去年度の提出済み回答なので承認済みとして取り込む
          status: 'approved',
          currentVersionId: null,
          answerText: sel.answerText,
          answerNumeric: null,
          answerChoice: [],
          ownerUserId: null,
          reviewerUserId: null,
          approvedAt: now,
          approvedBy: ctx.userId,
          previousResponseId: null,
          carryForwardDecision: null,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ]);
      created += 1;
    }

    // 当年度の回答から前年回答として参照できるようにする（本文は触らない）
    const currentResponse = currentByItemId.get(sel.itemId);
    if (currentResponse && currentResponse.previousResponseId !== responseId) {
      await db.update('disclosureResponses', currentResponse.id, {
        previousResponseId: responseId,
        updatedAt: now,
        updatedBy: ctx.userId,
      });
      linkedToCurrent += 1;
    }
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'disclosure_response',
    resourceId: input.targetPeriodId,
    afterSummary: `過去回答を取込: 新規 ${created} / 更新 ${updated} / 当年紐付け ${linkedToCurrent}`,
  });

  return { created, updated, linkedToCurrent };
}

async function loadFrameworkItems(
  db: DbClient,
  frameworkKey: FrameworkKey,
): Promise<DisclosureItem[]> {
  const frameworks = await db.select('frameworks', { where: { key: frameworkKey }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return [];
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id, status: 'published' },
    orderBy: { column: 'year', dir: 'desc' },
    limit: 1,
  });
  const version = versions[0];
  if (!version) return [];
  return db.select('disclosureItems', {
    where: { frameworkVersionId: version.id },
    orderBy: { column: 'sortOrder' },
  });
}
