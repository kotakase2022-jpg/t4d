import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { ANCHOR_KIND_LABELS, EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { MANUAL_EXCERPT_MAX_LENGTH } from '@/lib/domain/evidence-limits';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import {
  MAX_UPLOAD_BYTES,
  decodeText,
  looksTabular,
  parseDocx,
  parsePdf,
} from '@/lib/imports/parsers';
import { storeNewFile } from '@/lib/storage';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import {
  CONFIDENTIALITY_LEVELS,
  EVIDENCE_USAGE_PURPOSES,
  type AnchorKind,
  type AuthorizationContext,
  type ConfidentialityLevel,
  type EvidenceUsagePurpose,
  type ExtractedFragment,
  type FileObject,
  type FileVersion,
  type SourceAnchor,
  type Uuid,
} from '@/types/domain';

/**
 * 根拠資料の登録と引用位置（docs/disclosure-first.md §3 0034・0036、指示書 §6.4・§6.6）。
 *
 *  - 定性情報の資料は、資料名・対象年度・版・発行日・文書種別・機密区分・利用目的を持って登録する。
 *    利用目的（当年度の根拠／過年度の記載／文体の参考）で、当年度の事実の根拠になるかを分ける。
 *  - テキストを抽出できた資料は段落・ページ単位の抽出結果（extracted_fragments）を残す。
 *    抽出できないページは成功に見せかけず、手動抜粋で補う（OCR は無い。W0 §1.1）。
 *  - 引用位置（source_anchors）は追記専用。引用した文言そのものを写して持ち、
 *    抽出結果から取った引用は、その抽出結果に文言が実在することを確かめる。
 */

// ======================================================================
// 表示ラベル
// ======================================================================

export const CONFIDENTIALITY_LABELS: Readonly<Record<ConfidentialityLevel, string>> = {
  public: '公開',
  internal: '社内',
  confidential: '機密',
  restricted: '極秘',
};

/** 手動抜粋の抽出結果に付ける位置の接頭辞（抽出結果と区別して表示・引用するため） */
export const MANUAL_EXCERPT_LOCATOR_PREFIX = '手動抜粋';

export function isManualExcerpt(fragment: Pick<ExtractedFragment, 'locator'>): boolean {
  return (fragment.locator ?? '').startsWith(MANUAL_EXCERPT_LOCATOR_PREFIX);
}

export function usagePurposeLabel(purpose: EvidenceUsagePurpose | null): string {
  return purpose ? EVIDENCE_USAGE_PURPOSE_LABELS[purpose] : '未設定';
}

/** 引用位置の人向けの表記（例: p.3 ／ 第2章 2.1 第1段落 ／ 手動抜粋｜p.4） */
export function describeAnchorLocation(
  anchor: Pick<SourceAnchor, 'anchorKind' | 'page' | 'locator'>,
): string {
  const parts: string[] = [];
  if (anchor.page !== null && anchor.anchorKind === 'pdf_page') parts.push(`p.${anchor.page}`);
  if (anchor.locator) parts.push(anchor.locator);
  if (parts.length === 0) parts.push(ANCHOR_KIND_LABELS[anchor.anchorKind]);
  return parts.join(' ');
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isPdf(file: Pick<FileObject, 'mimeType' | 'originalName'>): boolean {
  return file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.originalName);
}

// ======================================================================
// 資料の登録（§6.4 の 2 つ目の入口「定性情報の資料を登録」）
// ======================================================================

/** 資料・証跡として受け付ける拡張子（取込の表形式に加え、画像の証憑も受ける） */
export const EVIDENCE_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.csv',
  '.tsv',
  '.xlsx',
  '.xlsm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
] as const;

export interface RegisterDocumentInput {
  /** qualitative = 定性情報の資料（利用目的が必須）／ evidence = 証憑 */
  kind: 'qualitative' | 'evidence';
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  /** 資料名（空なら元のファイル名） */
  title: string;
  reportingPeriodId: Uuid | null;
  editionLabel: string | null;
  issuedOn: string | null;
  documentType: string | null;
  confidentiality: string | null;
  usagePurpose: string | null;
}

export interface ExtractionOutcome {
  /** extracted = 抽出結果あり／needs_manual = テキストを抽出できない（手動抜粋へ）／not_text = 抽出の対象外 */
  status: 'extracted' | 'needs_manual' | 'not_text';
  fragmentCount: number;
  message: string | null;
}

function safeFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\p{Cc}/gu, '');
  return base.replace(/[^\p{L}\p{N}._\- ()（）・]/gu, '_').slice(0, 200);
}

/**
 * 表示用の名前（一覧・紐付けの選択肢に出す）。パスと制御文字を除き、記号は基本的に変えない
 * （【】や # を _ に置き換えると、利用者が付けた名前と一覧の表示が食い違う）。
 * 半角の引用符（"）だけは全角（＂）にする。ダウンロードの Content-Disposition で引用を閉じ、
 * 別のファイル名・拡張子を注入する手口に使えるため（contentDisposition でも無害化する）。
 * 保存キーは storeNewFile（buildStorageKey）が別に安全な形へ変える
 */
export function displayFileName(fileName: string): string {
  return fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/"/g, '＂')
    .trim()
    .slice(0, 200);
}

/** 資料名を保存名にする。拡張子は元のファイルのものを保つ（保存キー・表示形式の判定に使う） */
function storedName(title: string, originalName: string, extension: string): string {
  const cleaned = displayFileName(title);
  if (!cleaned) return originalName;
  return cleaned.toLowerCase().endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}

/**
 * 資料を登録し、テキストを抽出できる形式なら抽出結果を残す。
 * 機密区分は選べる（既定は機密）。定性情報の資料は利用目的が必須。
 */
export async function registerEvidenceDocument(
  db: DbClient,
  ctx: AuthorizationContext,
  input: RegisterDocumentInput,
): Promise<{ file: FileObject; version: FileVersion; extraction: ExtractionOutcome }> {
  assertCan(ctx, 'enterprise.evidence.write');
  const organizationId = ctx.workspace.organizationId;

  const safeName = safeFileName(input.fileName);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new ValidationError('ファイル名が不正です。');
  }
  if (input.bytes.byteLength === 0) throw new ValidationError('ファイルを選択してください。');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `ファイルサイズが上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）を超えています。`,
    );
  }
  const extension = safeName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  // 形式を限るのは定性情報の資料だけ（本文を抽出して引用に使うため）。証憑は従来どおり形式を問わない
  // （請求書の .xls・議事録の .doc・写真の .heic なども証跡として保管できる）
  if (
    input.kind === 'qualitative' &&
    !(EVIDENCE_EXTENSIONS as readonly string[]).includes(extension)
  ) {
    throw new ValidationError(
      `拡張子 ${extension || '(なし)'} は登録できません（${EVIDENCE_EXTENSIONS.join(', ')}）。`,
    );
  }

  const confidentiality = (input.confidentiality || 'confidential') as ConfidentialityLevel;
  if (!CONFIDENTIALITY_LEVELS.includes(confidentiality)) {
    throw new ValidationError('機密区分を選んでください。');
  }
  const purposeRaw = (input.usagePurpose ?? '').trim();
  const usagePurpose = purposeRaw === '' ? null : (purposeRaw as EvidenceUsagePurpose);
  if (usagePurpose !== null && !EVIDENCE_USAGE_PURPOSES.includes(usagePurpose)) {
    throw new ValidationError('利用目的を選び直してください。');
  }
  if (input.kind === 'qualitative' && usagePurpose === null) {
    throw new ValidationError(
      '定性情報の資料は利用目的（当年度の根拠／過年度の記載／文体の参考）を選んでください。',
    );
  }
  const issuedOn = (input.issuedOn ?? '').trim() || null;
  if (issuedOn && !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) {
    throw new ValidationError('発行日は YYYY-MM-DD で入力してください。');
  }
  let reportingPeriodId: Uuid | null = input.reportingPeriodId || null;
  if (reportingPeriodId) {
    const period = await db.findById('periods', reportingPeriodId);
    if (!period || period.organizationId !== organizationId) reportingPeriodId = null;
  }

  const originalName = storedName(
    input.title,
    displayFileName(input.fileName) || safeName,
    extension,
  );
  const stored = await storeNewFile(db, ctx, {
    bucket: 'evidence-private',
    scope: 'evidence',
    originalName,
    mimeType: input.mimeType || 'application/octet-stream',
    bytes: input.bytes,
    reportingPeriodId,
    documentType: (input.documentType ?? '').trim().slice(0, 100) || null,
    usagePurpose,
    editionLabel: (input.editionLabel ?? '').trim().slice(0, 200) || null,
    issuedOn,
  });

  // storeNewFile は機密区分を常に「機密」で作るため、選んだ区分へ直す
  let file = stored.file;
  if (confidentiality !== file.confidentiality) {
    file = await db.update('files', file.id, {
      confidentiality,
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.userId,
    });
  }

  const extraction = await extractFragments(db, file, stored.version, input.bytes);
  return { file, version: stored.version, extraction };
}

/** 段落の区切り（空行）で分ける。見出しだけの短い行も 1 つの断片として残す */
function splitParagraphs(text: string): string[] {
  return text
    .replace(/^\u{FEFF}/u, '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 文書から引用できる断片を取り出す。取り出せない（画像 PDF 等）ときは
 * 抽出結果を作らず、手動抜粋へ誘導する（抽出成功に見せかけない）。
 */
async function extractFragments(
  db: DbClient,
  file: FileObject,
  version: FileVersion,
  bytes: Uint8Array,
): Promise<ExtractionOutcome> {
  const lower = file.originalName.toLowerCase();
  let pieces: Array<{ page: number; text: string; locator: string }>;
  let failure: string | null = null;

  if (lower.endsWith('.txt')) {
    const { text } = decodeText(bytes);
    if (looksTabular(text)) {
      return {
        status: 'not_text',
        fragmentCount: 0,
        message: '表形式のため段落として抽出していません。',
      };
    }
    pieces = splitParagraphs(text).map((p, i) => ({
      page: i + 1,
      text: p,
      locator: `段落 ${i + 1}`,
    }));
    if (pieces.length === 0) failure = '本文が空でした。';
  } else if (lower.endsWith('.docx')) {
    const docx = await parseDocx(bytes);
    pieces = docx.paragraphs.map((p, i) => ({ page: i + 1, text: p, locator: `段落 ${i + 1}` }));
    if (pieces.length === 0) failure = docx.message ?? '本文を取り出せませんでした。';
  } else if (isPdf(file)) {
    const pdf = await parsePdf(bytes);
    pieces = pdf.pages.map((p) => ({ page: p.page, text: p.text, locator: `p.${p.page}` }));
    if (pdf.status !== 'parsed' || pieces.length === 0) {
      failure = 'テキストを抽出できませんでした（画像 PDF の可能性）。';
    }
  } else {
    return { status: 'not_text', fragmentCount: 0, message: null };
  }

  if (failure || pieces.length === 0) {
    return {
      status: 'needs_manual',
      fragmentCount: 0,
      message: `${failure ?? '本文を取り出せませんでした。'}必要な箇所は手動抜粋で登録してください。`,
    };
  }

  const now = new Date().toISOString();
  await db.insert(
    'fragments',
    pieces.map((p) => ({
      id: fid('fragment', `${version.id}/p${p.page}`),
      fileVersionId: version.id,
      organizationId: file.organizationId,
      page: p.page,
      kind: 'text' as const,
      text: p.text.slice(0, 4000),
      locator: p.locator,
      createdAt: now,
    })),
  );
  return { status: 'extracted', fragmentCount: pieces.length, message: null };
}

// ======================================================================
// 手動抜粋（テキスト抽出できないページの代替）
// ======================================================================

export async function addManualExcerpt(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { fileId: Uuid; page: number | null; locator: string; text: string },
): Promise<ExtractedFragment> {
  assertCan(ctx, 'enterprise.evidence.write');
  const file = await db.findById('files', input.fileId);
  if (!file || file.deletedAt || file.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('資料が見つかりません。');
  }
  if (!file.currentVersionId) throw new NotFoundError('資料の版が見つかりません。');
  const text = input.text.trim();
  if (!text) throw new ValidationError('抜粋する文言を入力してください。');
  if (text.length > MANUAL_EXCERPT_MAX_LENGTH) {
    throw new ValidationError(`抜粋は ${MANUAL_EXCERPT_MAX_LENGTH} 文字以内にしてください。`);
  }
  if (input.page !== null && (!Number.isInteger(input.page) || input.page < 1)) {
    throw new ValidationError('ページは 1 以上の整数で入力してください。');
  }

  const existing = await db.select('fragments', {
    where: { fileVersionId: file.currentVersionId },
  });
  // 既存の抽出結果とページ番号が重なると紙面のページ送りが崩れるため、重なるときは末尾の番号にする
  const maxPage = existing.reduce((max, f) => Math.max(max, f.page), 0);
  const page =
    input.page !== null && !existing.some((f) => f.page === input.page) ? input.page : maxPage + 1;
  const place = input.locator.trim() || (input.page !== null ? `p.${input.page}` : '位置未指定');
  const fragment: ExtractedFragment = {
    id: fid('fragment', `${file.currentVersionId}/manual/${existing.length + 1}/${Date.now()}`),
    fileVersionId: file.currentVersionId,
    organizationId: file.organizationId,
    page,
    kind: 'text',
    text,
    locator: `${MANUAL_EXCERPT_LOCATOR_PREFIX}｜${place.slice(0, 200)}`,
    createdAt: new Date().toISOString(),
  };
  await db.insert('fragments', [fragment]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'extracted_fragment',
    resourceId: fragment.id,
    afterSummary: `手動抜粋を登録（${file.originalName}／${place}）`,
  });
  return fragment;
}

// ======================================================================
// 引用位置
// ======================================================================

export interface FragmentView {
  fragment: ExtractedFragment;
  manual: boolean;
  locationLabel: string;
}

export interface DocumentForCitation {
  file: FileObject;
  version: FileVersion | null;
  usagePurposeLabel: string;
  confidentialityLabel: string;
  fragmentCount: number;
  periodId: Uuid | null;
}

/** 引用できる資料の一覧（抽出結果か手動抜粋を持つもの） */
export async function listDocumentsForCitation(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<DocumentForCitation[]> {
  const organizationId = ctx.workspace.organizationId;
  const files = await db.select('files', {
    where: { organizationId, deletedAt: { isNull: true } },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const versionIds = files.map((f) => f.currentVersionId).filter((v): v is Uuid => v !== null);
  if (versionIds.length === 0) return [];
  const [versions, fragments] = await Promise.all([
    db.select('fileVersions', { where: { id: { in: versionIds } } }),
    db.select('fragments', { where: { fileVersionId: { in: versionIds } } }),
  ]);
  return files
    .map((file) => ({
      file,
      version: versions.find((v) => v.id === file.currentVersionId) ?? null,
      usagePurposeLabel: usagePurposeLabel(file.usagePurpose),
      confidentialityLabel: CONFIDENTIALITY_LABELS[file.confidentiality],
      fragmentCount: fragments.filter((f) => f.fileVersionId === file.currentVersionId).length,
      periodId: file.reportingPeriodId,
    }))
    .filter((d) => d.fragmentCount > 0)
    .sort((a, b) => Number(b.file.usagePurpose !== null) - Number(a.file.usagePurpose !== null));
}

/**
 * 資料の現在の版の抽出結果（手動抜粋を含む）。
 * 資料の閲覧権限（enterprise.evidence.read）が無い人には、資料の有無も含めて返さない
 * （抽出結果は資料の本文そのものであり、機密区分の高い資料も含む）
 */
export async function loadDocumentFragments(
  db: DbClient,
  ctx: AuthorizationContext,
  fileId: Uuid,
): Promise<{ file: FileObject; version: FileVersion; fragments: FragmentView[] } | null> {
  if (!can(ctx, 'enterprise.evidence.read')) return null;
  const file = isUuid(fileId) ? await db.findById('files', fileId) : null;
  if (!file || file.deletedAt || file.organizationId !== ctx.workspace.organizationId) return null;
  if (!file.currentVersionId) return null;
  const version = await db.findById('fileVersions', file.currentVersionId);
  if (!version || version.organizationId !== ctx.workspace.organizationId) return null;
  const fragments = await db.select('fragments', {
    where: { fileVersionId: version.id },
    orderBy: [{ column: 'page' }, { column: 'id' }],
  });
  return {
    file,
    version,
    fragments: fragments.map((fragment) => ({
      fragment,
      manual: isManualExcerpt(fragment),
      locationLabel: fragment.locator ?? `p.${fragment.page}`,
    })),
  };
}

/**
 * 抽出結果（または手動抜粋）の一部を引用位置として登録する。
 * 引用文は抽出結果に実在する文言に限る（抽出結果から取ったと名乗って別の文言を持ち込ませない）。
 * 同じ箇所・同じ文言の引用は作り直さず既存のものを返す（二重押下でも増えない）。
 */
export async function createAnchorFromFragment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { fragmentId: Uuid; quoteText: string },
): Promise<SourceAnchor> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const fragment = await db.findById('fragments', input.fragmentId);
  if (!fragment || fragment.organizationId !== organizationId) {
    throw new NotFoundError('資料の該当箇所が見つかりません。');
  }
  const version = await db.findById('fileVersions', fragment.fileVersionId);
  const file = version ? await db.findById('files', version.fileId) : null;
  if (!version || !file || file.deletedAt || file.organizationId !== organizationId) {
    throw new NotFoundError('資料が見つかりません。');
  }

  const quote = input.quoteText.trim();
  if (!quote)
    throw new ValidationError('引用する文言を入力してください（空の引用は登録できません）。');
  if (!normalizeSpace(fragment.text).includes(normalizeSpace(quote))) {
    throw new ValidationError(
      '引用する文言が資料の該当箇所に見つかりません。該当箇所の文言から選んでください。',
    );
  }

  const manual = isManualExcerpt(fragment);
  let anchorKind: AnchorKind;
  if (manual) anchorKind = 'manual_excerpt';
  else if (isPdf(file)) anchorKind = 'pdf_page';
  else if (fragment.kind === 'cell' || fragment.kind === 'table') anchorKind = 'sheet_cell';
  else anchorKind = fragment.locator ? 'heading_paragraph' : 'text_range';

  const existing = await db.select('sourceAnchors', {
    where: { organizationId, fileVersionId: version.id, fragmentId: fragment.id },
  });
  const same = existing.find((a) => a.quoteText === quote);
  if (same) return same;

  const anchor: SourceAnchor = {
    id: fid('source_anchor', `${fragment.id}/${ctx.userId}/${quote}/${existing.length}`),
    organizationId,
    fileVersionId: version.id,
    fragmentId: fragment.id,
    anchorKind,
    page: anchorKind === 'pdf_page' || (manual && isPdf(file)) ? fragment.page : null,
    locator: fragment.locator,
    quoteText: quote,
    acquiredBy: manual ? 'manual' : 'extracted',
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  await db.insert('sourceAnchors', [anchor]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'source_anchor',
    resourceId: anchor.id,
    afterSummary: `引用位置を登録（${file.originalName}／${describeAnchorLocation(anchor)}）`,
  });
  return anchor;
}

export interface AnchorView {
  anchor: SourceAnchor;
  fileId: Uuid | null;
  fileName: string;
  usagePurpose: EvidenceUsagePurpose | null;
  usagePurposeLabel: string;
  confidentialityLabel: string | null;
  locationLabel: string;
  /** 資料が削除された・見つからない（引用の写しだけが残る） */
  missing: boolean;
}

export async function loadAnchorViews(
  db: DbClient,
  ctx: AuthorizationContext,
  anchorIds: readonly Uuid[],
): Promise<AnchorView[]> {
  if (anchorIds.length === 0) return [];
  const anchors = (
    await db.select('sourceAnchors', { where: { id: { in: [...anchorIds] } } })
  ).filter((a) => a.organizationId === ctx.workspace.organizationId);
  const versionIds = [...new Set(anchors.map((a) => a.fileVersionId))];
  const versions =
    versionIds.length > 0
      ? await db.select('fileVersions', { where: { id: { in: versionIds } } })
      : [];
  const fileIds = [...new Set(versions.map((v) => v.fileId))];
  const files =
    fileIds.length > 0 ? await db.select('files', { where: { id: { in: fileIds } } }) : [];
  const byId = new Map(anchors.map((a) => [a.id, a]));
  return anchorIds
    .map((id) => byId.get(id))
    .filter((a): a is SourceAnchor => a !== undefined)
    .map((anchor) => {
      const version = versions.find((v) => v.id === anchor.fileVersionId);
      const file = version ? files.find((f) => f.id === version.fileId) : undefined;
      const live = file && !file.deletedAt ? file : undefined;
      return {
        anchor,
        fileId: live?.id ?? null,
        fileName: live?.originalName ?? '（資料が見つかりません）',
        usagePurpose: live?.usagePurpose ?? null,
        usagePurposeLabel: usagePurposeLabel(live?.usagePurpose ?? null),
        confidentialityLabel: live ? CONFIDENTIALITY_LABELS[live.confidentiality] : null,
        locationLabel: describeAnchorLocation(anchor),
        missing: !live,
      };
    });
}

// ======================================================================
// 引用の利用先の逆引き（§6.6「引用の利用先を逆引きできるようにする」）
// ======================================================================

export interface AnchorUsage {
  anchorId: Uuid;
  locationLabel: string;
  quoteText: string;
  narratives: Array<{ recordId: Uuid; title: string; versionNos: number[] }>;
  blocks: Array<{ blockId: Uuid; projectId: Uuid; title: string; versionNos: number[] }>;
}

/**
 * 資料の引用位置が、どの定性情報・原稿の節で使われているか。
 * 定性情報の題名・原稿の節の題名とリンクは開示の内容なので、開示の閲覧権限が無い人には返さない
 * （資料の閲覧権限だけを持つ拠点担当者などに、原稿・定性情報の題名を見せない）
 */
export async function listAnchorUsagesForFile(
  db: DbClient,
  ctx: AuthorizationContext,
  fileId: Uuid,
): Promise<AnchorUsage[]> {
  if (!can(ctx, 'enterprise.disclosure.read')) return [];
  const organizationId = ctx.workspace.organizationId;
  const file = await db.findById('files', fileId);
  if (!file || file.organizationId !== organizationId) return [];
  const versions = await db.select('fileVersions', { where: { fileId } });
  if (versions.length === 0) return [];
  const anchors = await db.select('sourceAnchors', {
    where: { organizationId, fileVersionId: { in: versions.map((v) => v.id) } },
  });
  if (anchors.length === 0) return [];

  const [narrativeVersions, blockVersions] = await Promise.all([
    db.select('narrativeVersions', { where: { organizationId } }),
    db.select('disclosureBlockVersions', { where: { organizationId } }),
  ]);
  const recordIds = [...new Set(narrativeVersions.map((v) => v.narrativeRecordId))];
  const blockIds = [...new Set(blockVersions.map((v) => v.blockId))];
  const [records, blocks] = await Promise.all([
    recordIds.length > 0
      ? db.select('narrativeRecords', { where: { id: { in: recordIds } } })
      : Promise.resolve([]),
    blockIds.length > 0
      ? db.select('disclosureBlocks', { where: { id: { in: blockIds } } })
      : Promise.resolve([]),
  ]);

  return anchors
    .map((anchor) => {
      const narratives = new Map<Uuid, { recordId: Uuid; title: string; versionNos: number[] }>();
      for (const v of narrativeVersions.filter((nv) => nv.sourceAnchorIds.includes(anchor.id))) {
        const record = records.find((r) => r.id === v.narrativeRecordId && !r.deletedAt);
        if (!record) continue;
        const entry = narratives.get(record.id) ?? {
          recordId: record.id,
          title: record.title,
          versionNos: [],
        };
        entry.versionNos.push(v.versionNo);
        narratives.set(record.id, entry);
      }
      const usedBlocks = new Map<
        Uuid,
        { blockId: Uuid; projectId: Uuid; title: string; versionNos: number[] }
      >();
      for (const v of blockVersions.filter((bv) => bv.anchorRefs.includes(anchor.id))) {
        const block = blocks.find((b) => b.id === v.blockId && !b.deletedAt);
        if (!block) continue;
        const entry = usedBlocks.get(block.id) ?? {
          blockId: block.id,
          projectId: block.projectId,
          title: block.title,
          versionNos: [],
        };
        entry.versionNos.push(v.versionNo);
        usedBlocks.set(block.id, entry);
      }
      return {
        anchorId: anchor.id,
        locationLabel: describeAnchorLocation(anchor),
        quoteText: anchor.quoteText,
        narratives: [...narratives.values()].map((n) => ({
          ...n,
          versionNos: n.versionNos.sort((a, b) => a - b),
        })),
        blocks: [...usedBlocks.values()].map((b) => ({
          ...b,
          versionNos: b.versionNos.sort((a, b2) => a - b2),
        })),
      };
    })
    .filter((u) => u.narratives.length > 0 || u.blocks.length > 0);
}
