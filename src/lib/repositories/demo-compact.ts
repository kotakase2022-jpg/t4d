import { canonicalJson, collectRefs, plainTextOf } from '@/lib/domain/disclosure-block';
import { narrativeContentHash } from '@/lib/domain/narrative-hash';
import { contentHash } from '@/lib/fixtures/ids';
import {
  asSnapshotDetail,
  computeSnapshotContentHash,
  isSnapshotV2,
  snapshotAnchorOf,
  snapshotApprovalOf,
  snapshotBlockOf,
  snapshotCommentOf,
  snapshotFrameworkOf,
  snapshotMetricValueOf,
  snapshotRequirementStateOf,
  snapshotRequirementsOf,
  type SnapshotBlock,
  type SnapshotFramework,
  type SnapshotIssue,
  type SnapshotMetricValue,
  type SnapshotRequirementState,
} from '@/lib/domain/report-snapshot-content';
import { RECONCILIATION_CHECKER_VERSION } from '@/lib/domain/export-reconciliation';
import { buildSharedReportCopy, sharedReportCopyHash } from '@/lib/domain/report-copy';
import type { FixtureDb } from '@/lib/fixtures/store';
import {
  ANCHOR_ACQUIRED_BY,
  ANCHOR_KINDS,
  EXPORT_ARTIFACT_FORMATS,
  QUANTITATIVE_IMPORT_DIFF_KINDS,
  type BlockBody,
  type BlockParagraph,
  type DisclosureBlockVersion,
} from '@/types/domain';

/**
 * Demo Mode の Cookie（t4d.demo-edits）に**大きい行を小さくして**載せ、別インスタンスで組み立て直す。
 *
 * 本番（Vercel の Demo Mode）は外部ストアを持たず、リクエストが別のインスタンスへ届くと、そのインスタンスの
 * メモリにだけある行は見えない（docs/known-limitations.md D-3）。以前は本文の版・引用位置・スナップショット・
 * 取込バッチを「1 件で Cookie を使い切る」として持ち回さず、実演の流れが別インスタンスで途切れていた
 * （2026-09-30 本番で標準 CSV の確定が「有効期限切れ」になった）。
 *
 * 行を小さくする方法（表ごと）:
 *  - 追記専用の版・引用位置: 本文から計算できる列（平文・参照の一覧・内容ハッシュ・出所の区分）は載せず、
 *    戻すときに同じ関数で計算し直す。偽の Cookie で本文と食い違うハッシュ・参照を名乗らせない効果もある。
 *  - 原稿の版の本文: 土台の版（base_version）と同じ段落は段落の番号だけにする（差分の符号化）。
 *    版は多くの段落を前の版から引き継ぐため、書き足した段落だけが Cookie を使う。土台の内容ハッシュを添え、
 *    戻すときに土台が作ったときと同じ本文であることを確かめる（違えば番号が別の文を指すため戻さない）。
 *  - スナップショット: 目録（固定した版・数値の版・引用位置・社内コメントの ID と、固定時点にしか分からない
 *    状態・注意）だけを載せ、写しは追記専用の行から組み立て直す。組み立て直した写しの内容ハッシュが
 *    作成時と違えば戻さない（同じハッシュで別の内容を出さない。そのスナップショットは「見つからない」になる）。
 *  - 標準 CSV の取込: 確定の控え（どの行を書いたか・確定キー）だけを載せる。検証結果そのものは載せず、
 *    確定のときにブラウザが元の CSV を送り直し、サーバーが検証し直す（quantitative-import.ts）。
 *
 * ここは形の変換と、形の検査（型・列）だけを行う。組織・権限・職務分離の検査は demo-edit-codec.ts の
 * acceptEdit が組み立て直した行に対して行う。副作用が無く Cookie にも依存しないので単体テストできる。
 */

type Rec = Record<string, unknown>;

/**
 * 小さくした形の目印（形を変えたら数を上げ、古い形は戻さない）。
 * 2: 原稿の版が土台の版の内容ハッシュ（bh）を持つ。1 の差分は土台が変わっても気付けないため戻さない
 */
export const COMPACT_MARK = '$c';
export const COMPACT_VERSION = 2;

/**
 * 1 回の適用（applyDemoEdits）で組み立て直してよい量（文字数）。Cookie は強く圧縮でき、数 KB の偽の Cookie
 * から展開後に数百 MB の本文・写しを作らせることができる（自己監査 第 2 巡 F2）。呼び出し側が 1 回の適用ごとに
 * 作り、原稿の版の本文とスナップショットの写しを組み立てるたびに使った分を引く。尽きたら組み立てない
 */
export interface ReplayBudget {
  remaining: number;
}

/** 呼び出し側が予算を渡さないとき（書き込み時の自己確認・テスト）の上限。1 件ごとの上限は別にある */
function unlimitedBudget(): ReplayBudget {
  return { remaining: Number.POSITIVE_INFINITY };
}

function spend(budget: ReplayBudget, chars: number): boolean {
  if (chars > budget.remaining) return false;
  budget.remaining -= chars;
  return true;
}

/**
 * Cookie から戻す原稿の版 1 件の本文の上限（正規化した JSON の文字数）。1 件で Cookie 1 つ（3,800B）を超える
 * 編集は載せないため、Cookie から戻る版が書き足せる本文は数万字まで。土台から引き継いだ段落を合わせても、
 * 正規の版はこの数分の 1 に収まる
 */
export const MAX_REPLAYED_BODY_CHARS = 200_000;

/**
 * 版の本文の大きさ（正規化した JSON の文字数）と内容ハッシュ。スナップショットの写しを組み立てる前の見積もりと、
 * 差分で持ち回した版の土台の確認に使う。版は追記専用で本文（の物）を書き換えないため、本文ごとに 1 回だけ数える
 */
interface BodyInfo {
  chars: number;
  hash: string;
}

const bodyInfoCache = new WeakMap<BlockBody, BodyInfo>();

function bodyInfoOf(body: BlockBody): BodyInfo {
  const cached = bodyInfoCache.get(body);
  if (cached) return cached;
  const canonical = canonicalJson(body);
  const info = { chars: canonical.length, hash: contentHash(canonical) };
  bodyInfoCache.set(body, info);
  return info;
}

/** 小さくして載せる表（載せる列・組み立て直し方が表ごとに決まっている） */
export const COMPACTED_TABLES: ReadonlySet<string> = new Set([
  'disclosureBlockVersions',
  'narrativeVersions',
  'sourceAnchors',
  'reportSnapshots',
  'exportArtifacts',
  'quantitativeImportBatches',
  'approvals',
  // 保証側へ共有した写し（トライアル対応 NF-20）。目録だけを載せ、写しはスナップショットから作り直す
  'sharedReportCopies',
]);

export function isCompactedTable(table: string): boolean {
  return COMPACTED_TABLES.has(table);
}

// ----------------------------------------------------------------------
// 小道具
// ----------------------------------------------------------------------

/** 既定値と同じ列は載せない（null・空の配列など） */
function withoutDefaults(row: Rec, defaults: Rec): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (key in defaults && canonicalJson(value) === canonicalJson(defaults[key])) continue;
    out[key] = value;
  }
  return out;
}

/** 載せなかった列を既定値で補う */
function withDefaults(v: Rec, defaults: Rec): Rec {
  const out: Rec = { ...v };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in out)) out[key] = structuredClone(value);
  }
  delete out[COMPACT_MARK];
  return out;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

type Shape = Record<string, (v: unknown) => boolean>;

function hasShape(row: Rec, spec: Shape): boolean {
  return Object.entries(spec).every(([key, check]) => check(row[key]));
}

/** 形の検査に通った列だけを取り出す（偽の Cookie が足した列を行に混ぜない） */
function only(row: Rec, spec: Shape): Rec {
  return Object.fromEntries(Object.keys(spec).map((key) => [key, row[key]]));
}

// ----------------------------------------------------------------------
// 原稿の本文（BlockBody）の形の検査
// ----------------------------------------------------------------------

const PARAGRAPH_ID = /^[A-Za-z0-9_-]{1,80}$/;
const INLINE_KEYS: Record<string, readonly string[]> = {
  text: ['t', 'text'],
  metric: ['t', 'dataPointId', 'dataPointVersionId', 'display'],
  narrative: ['t', 'narrativeVersionId', 'quote'],
  cite: ['t', 'sourceAnchorId'],
};

function isInline(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const inline = value as Rec;
  const keys = isStr(inline.t) ? INLINE_KEYS[inline.t] : undefined;
  if (!keys) return false;
  if (Object.keys(inline).some((k) => !keys.includes(k))) return false;
  return keys.every((k) => isStr(inline[k]) && (inline[k] as string).length <= 20_000);
}

/**
 * Service の parseBlockBody（zod）と同じ形か。Cookie から戻す本文は Service が保存した形のままのはずで、
 * 違う形（余計なキー・不正な段落 ID・重複）は偽の Cookie として戻さない
 */
export function isBlockBody(value: unknown): value is BlockBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const paragraphs = (value as Rec).paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length > 500) return false;
  const seen = new Set<string>();
  for (const p of paragraphs) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    const paragraph = p as Rec;
    if (Object.keys(paragraph).some((k) => !['id', 'kind', 'children', 'aiRunId'].includes(k))) {
      return false;
    }
    if (!isStr(paragraph.id) || !PARAGRAPH_ID.test(paragraph.id) || seen.has(paragraph.id)) {
      return false;
    }
    seen.add(paragraph.id);
    if (paragraph.kind !== 'paragraph' && paragraph.kind !== 'heading') return false;
    if (paragraph.aiRunId !== undefined && !(isStr(paragraph.aiRunId) && paragraph.aiRunId)) {
      return false;
    }
    const children = paragraph.children;
    if (!Array.isArray(children) || children.length > 400 || !children.every(isInline)) {
      return false;
    }
  }
  return true;
}

// ----------------------------------------------------------------------
// 原稿の版（disclosure_block_versions）
// ----------------------------------------------------------------------

const BLOCK_VERSION_DEFAULTS: Rec = {
  baseVersionId: null,
  changeReason: null,
  contributorUserIds: [],
};

function compactBlockVersion(row: DisclosureBlockVersion, db: FixtureDb): Rec {
  const base = row.baseVersionId
    ? db.disclosureBlockVersions.find((v) => v.id === row.baseVersionId)
    : undefined;
  const indexOf = new Map<string, number>();
  base?.body.paragraphs.forEach((p, i) => {
    const key = canonicalJson(p);
    if (!indexOf.has(key)) indexOf.set(key, i);
  });
  return withoutDefaults(
    {
      [COMPACT_MARK]: COMPACT_VERSION,
      id: row.id,
      organizationId: row.organizationId,
      blockId: row.blockId,
      versionNo: row.versionNo,
      baseVersionId: row.baseVersionId,
      changeReason: row.changeReason,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      contributorUserIds: row.contributorUserIds ?? [],
      // 土台の版の内容ハッシュ。番号だけで持つ段落は、戻すときに土台が同じ本文であることを確かめる
      ...(base ? { bh: base.contentHash } : {}),
      // 土台の版と同じ段落は番号だけ（版の本文は土台から多くの段落を引き継ぐ）
      b: row.body.paragraphs.map((p) => indexOf.get(canonicalJson(p)) ?? p),
    },
    BLOCK_VERSION_DEFAULTS,
  );
}

function versionAuthors(version: Pick<DisclosureBlockVersion, 'createdBy' | 'contributorUserIds'>) {
  return [version.createdBy, ...(version.contributorUserIds ?? [])];
}

/**
 * 版を書いた人として引き継ぐ人（DB のトリガ t4d.merge_block_version_contributors と同じ規則）。
 * トリガは base_version_id を信用せず、節の**現在の版**の作成者・書いた人を必ず足す。Cookie から戻す版は
 * 土台を名乗らないこと（baseVersionId = null）もできるため、そのときは節の既にある版すべての書いた人を足す
 * （正規の版は節の最初の版だけが土台を持たない）。書いた人を外して自分の本文を承認させない
 */
function inheritedAuthors(
  db: FixtureDb,
  row: { id: string; blockId: string },
  base: DisclosureBlockVersion | undefined,
): string[] {
  const siblings = db.disclosureBlockVersions.filter(
    (x) => x.blockId === row.blockId && x.id !== row.id,
  );
  const currentId = db.disclosureBlocks.find((b) => b.id === row.blockId)?.currentVersionId;
  const current = siblings.find((x) => x.id === currentId);
  const from = base ? [base, ...(current ? [current] : [])] : siblings;
  return from.flatMap(versionAuthors);
}

function expandBlockVersion(v: Rec, db: FixtureDb, budget: ReplayBudget): Rec | null {
  const row = withDefaults(v, BLOCK_VERSION_DEFAULTS);
  if (
    !hasShape(row, {
      id: isStr,
      organizationId: isStr,
      blockId: isStr,
      versionNo: (x) => isInt(x) && x > 0,
      baseVersionId: isStrOrNull,
      changeReason: isStrOrNull,
      createdAt: isStr,
      createdBy: isStr,
      contributorUserIds: isStrArray,
      bh: (x) => x === undefined || isStr(x),
      b: (x) => Array.isArray(x) && x.length <= 500,
    })
  ) {
    return null;
  }
  const base = row.baseVersionId
    ? db.disclosureBlockVersions.find(
        (x) => x.id === row.baseVersionId && x.blockId === row.blockId,
      )
    : undefined;
  // 土台の版がまだ無い（別の Cookie の編集で後から戻る・押し出された）なら、今は組み立てられない
  if (row.baseVersionId && !base) return null;
  const entries = row.b as unknown[];
  const inherits = entries.some((entry) => typeof entry === 'number');
  if (inherits) {
    // 番号だけで持つ段落は、作ったときの土台と同じ本文から引き継ぐ。土台が変わっていれば（再デプロイで
    // Fixture の文を直した等）、番号が別の文を指し、誰も書いていない本文が同じ版として戻ってしまう
    if (!base || !isStr(row.bh) || bodyInfoOf(base.body).hash !== row.bh) return null;
  }
  // 組み立てる前に、組み立てる量を予算から引く（受け付けなかった試みも数える。周回ごとに同じ重い
  // 組み立てを繰り返させない）。段落 ID は重複できないため、引き継ぐ量は土台の本文の大きさまで
  const inlineChars = entries.reduce<number>(
    (sum, entry) => sum + (typeof entry === 'number' ? 0 : JSON.stringify(entry).length),
    0,
  );
  const estimate = inlineChars + (inherits && base ? bodyInfoOf(base.body).chars : 0);
  if (!spend(budget, estimate)) return null;
  // 本文を組み立てる（引き継ぐ段落はまだ写さない。大きさを確かめてから写す）
  const paragraphs: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry === 'number') {
      const inherited = base?.body.paragraphs[entry];
      if (!inherited) return null;
      paragraphs.push(inherited);
    } else {
      paragraphs.push(entry);
    }
  }
  if (!isBlockBody({ paragraphs })) return null;
  const canonical = canonicalJson({ paragraphs });
  // 強く圧縮した偽の Cookie から、展開後に巨大な本文を作らせない
  if (canonical.length > MAX_REPLAYED_BODY_CHARS) return null;
  const body = structuredClone({ paragraphs }) as BlockBody;
  const refs = collectRefs(body);
  const aiRunIds = [
    ...new Set(
      body.paragraphs.map((p: BlockParagraph) => p.aiRunId).filter((id): id is string => !!id),
    ),
  ];
  // 本文を書いた人は、土台の版・節の現在の版の作成者・書いた人を必ず引き継ぐ。正しい Cookie では既に
  // 含まれていて何も変わらず、偽の Cookie で書いた人を外して、その人に自分の本文を承認させることはできない
  const createdBy = row.createdBy as string;
  const contributorUserIds = [
    ...new Set([
      ...(row.contributorUserIds as string[]),
      ...inheritedAuthors(db, { id: row.id as string, blockId: row.blockId as string }, base),
    ]),
  ].filter((id) => id !== createdBy);
  const expanded = {
    id: row.id,
    organizationId: row.organizationId,
    blockId: row.blockId,
    versionNo: row.versionNo,
    baseVersionId: row.baseVersionId,
    body,
    plainText: plainTextOf(body),
    metricRefs: refs.metricVersionIds,
    narrativeRefs: refs.narrativeVersionIds,
    anchorRefs: refs.anchorIds,
    changeReason: row.changeReason,
    // 出所の区分は本文から決まる（disclosure-block.ts の appendBlockVersion と同じ規則）
    origin: aiRunIds.length > 0 ? 'human_adopted_ai' : 'human',
    originatedFromAiRunId: aiRunIds[0] ?? null,
    // contentHashOf(body) と同じ値（正規化した JSON は上で作った）
    contentHash: contentHash(canonical),
    createdAt: row.createdAt,
    createdBy,
    contributorUserIds,
  };
  bodyInfoCache.set(body, { chars: canonical.length, hash: expanded.contentHash });
  return expanded;
}

// ----------------------------------------------------------------------
// 定性情報の版（narrative_versions）
// ----------------------------------------------------------------------

const NARRATIVE_VERSION_DEFAULTS: Rec = {
  scopeNote: '',
  fields: {},
  sourceAnchorIds: [],
  // 関連するインパクト・リスク・機会（0052）。以前の Cookie の行は持たないため空として戻す
  iroRefs: [],
  carriedFromVersionId: null,
  changeReason: null,
  originatedFromAiRunId: null,
  createdBy: null,
};

function compactNarrativeVersion(row: Rec): Rec {
  const { contentHash: _hash, ...rest } = row;
  return withoutDefaults({ [COMPACT_MARK]: COMPACT_VERSION, ...rest }, NARRATIVE_VERSION_DEFAULTS);
}

function expandNarrativeVersion(v: Rec): Rec | null {
  const row = withDefaults(v, NARRATIVE_VERSION_DEFAULTS);
  const isFields = (x: unknown) =>
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    Object.values(x as Rec).every((value) => isStr(value));
  const shape: Shape = {
    id: isStr,
    organizationId: isStr,
    narrativeRecordId: isStr,
    versionNo: (x) => isInt(x) && x > 0,
    reportingPeriodId: isStr,
    scopeNote: isStr,
    fields: isFields,
    body: isStr,
    sourceAnchorIds: isStrArray,
    carriedFromVersionId: isStrOrNull,
    changeReason: isStrOrNull,
    originatedFromAiRunId: isStrOrNull,
    iroRefs: (x) => isStrArray(x) && x.length <= 200,
    createdAt: isStr,
    createdBy: isStrOrNull,
  };
  if (!hasShape(row, shape)) return null;
  return {
    ...only(row, shape),
    // ハッシュは持ち回さず、本文から計算し直す（narrative.ts と同じ規則。IRO の参照はハッシュに含めない）
    contentHash: narrativeContentHash({
      reportingPeriodId: row.reportingPeriodId as string,
      scopeNote: row.scopeNote as string,
      fields: row.fields as Record<string, string>,
      body: row.body as string,
      sourceAnchorIds: row.sourceAnchorIds as string[],
    }),
  };
}

// ----------------------------------------------------------------------
// 引用位置（source_anchors）・出力記録（export_artifacts）・承認の記録（approvals）
// ----------------------------------------------------------------------

const ANCHOR_DEFAULTS: Rec = { fragmentId: null, page: null, locator: null, createdBy: null };

function expandAnchor(v: Rec): Rec | null {
  const row = withDefaults(v, ANCHOR_DEFAULTS);
  const shape: Shape = {
    id: isStr,
    organizationId: isStr,
    fileVersionId: isStr,
    fragmentId: isStrOrNull,
    anchorKind: (x) => (ANCHOR_KINDS as readonly unknown[]).includes(x),
    page: (x) => x === null || isInt(x),
    locator: isStrOrNull,
    quoteText: (x) => isStr(x) && x.trim().length > 0,
    acquiredBy: (x) => (ANCHOR_ACQUIRED_BY as readonly unknown[]).includes(x),
    createdAt: isStr,
    createdBy: isStrOrNull,
  };
  return hasShape(row, shape) ? only(row, shape) : null;
}

/**
 * 出力記録の突合・XBRL の列（0051）の既定値。未突合の出力（この列を足す前の出力・突合しない形式）は
 * null のまま Cookie に載せない（実演の流れの Cookie を増やさない）
 */
const EXPORT_ARTIFACT_DEFAULTS: Rec = {
  reconciledParagraphs: null,
  reconciledNumbers: null,
  reconciledRows: null,
  mismatchCount: null,
  checkerVersion: null,
  taxonomyPackageId: null,
  mappingSetHash: null,
  validationSummary: null,
};

const isCountOrNull = (x: unknown) => x === null || (isInt(x) && x >= 0);

/**
 * 突合で一致した出力記録の件数（段落・数値・行）を 1 つの配列 rc にまとめる鍵。渡した出力は必ず不一致 0
 * （不一致なら記録しない）なので、不一致の件数と照合の版は省いて、戻すときに補う（plan K8 の余裕。
 * 実演＋CSRD の流れの出力 3 件分）
 */
const RECONCILED_KEY = 'rc';

function packReconciliation(rest: Rec): Rec {
  const counts = [rest.reconciledParagraphs, rest.reconciledNumbers, rest.reconciledRows];
  if (
    rest.mismatchCount !== 0 ||
    rest.checkerVersion !== RECONCILIATION_CHECKER_VERSION ||
    !counts.every((n) => isInt(n) && (n as number) >= 0)
  ) {
    return rest;
  }
  const {
    reconciledParagraphs: _p,
    reconciledNumbers: _n,
    reconciledRows: _r,
    mismatchCount: _m,
    checkerVersion: _c,
    ...others
  } = rest;
  return { ...others, [RECONCILED_KEY]: counts };
}

function unpackReconciliation(v: Rec): Rec | null {
  if (!(RECONCILED_KEY in v)) return v;
  const { [RECONCILED_KEY]: packed, ...others } = v;
  if (
    !Array.isArray(packed) ||
    packed.length !== 3 ||
    !packed.every((n) => isInt(n) && (n as number) >= 0)
  ) {
    return null;
  }
  const [reconciledParagraphs, reconciledNumbers, reconciledRows] = packed as number[];
  return {
    ...others,
    reconciledParagraphs,
    reconciledNumbers,
    reconciledRows,
    mismatchCount: 0,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
  };
}

function expandExportArtifact(v: Rec, db: FixtureDb): Rec | null {
  const unpacked = unpackReconciliation(v);
  if (!unpacked) return null;
  const row = withDefaults(unpacked, EXPORT_ARTIFACT_DEFAULTS);
  const shape: Shape = {
    id: isStr,
    organizationId: isStr,
    snapshotId: isStr,
    format: (x) => (EXPORT_ARTIFACT_FORMATS as readonly unknown[]).includes(x),
    audience: (x) => x === 'internal' || x === 'external',
    templateVersion: isStr,
    fileName: isStr,
    byteSize: isInt,
    fileSha256: isStr,
    generatedAt: isStr,
    generatedBy: isStr,
    reconciledParagraphs: isCountOrNull,
    reconciledNumbers: isCountOrNull,
    reconciledRows: isCountOrNull,
    mismatchCount: isCountOrNull,
    checkerVersion: isStrOrNull,
    taxonomyPackageId: isStrOrNull,
    mappingSetHash: isStrOrNull,
    validationSummary: (x) =>
      x === null ||
      (!!x && typeof x === 'object' && !Array.isArray(x) && JSON.stringify(x).length <= 4000),
  };
  if (!hasShape(row, shape)) return null;
  // 内容ハッシュはスナップショットのもの（出力は必ずスナップショットから作る）。先にスナップショットが要る
  const snapshot = db.reportSnapshots.find((s) => s.id === row.snapshotId);
  if (!snapshot) return null;
  return { ...only(row, shape), contentHash: snapshot.contentHash };
}

const APPROVAL_DEFAULTS: Rec = { targetVersionId: null, comment: null };

function expandApproval(v: Rec): Rec | null {
  const row = withDefaults(v, APPROVAL_DEFAULTS);
  const shape: Shape = {
    id: isStr,
    organizationId: isStr,
    targetType: (x) => x === 'data_point',
    targetId: isStr,
    targetVersionId: isStrOrNull,
    stage: (x) => x === 'review' || x === 'final',
    decision: isStr,
    actorUserId: isStr,
    comment: isStrOrNull,
    decidedAt: isStr,
  };
  return hasShape(row, shape) ? only(row, shape) : null;
}

// ----------------------------------------------------------------------
// 標準 CSV の取込（quantitative_import_batches）: 確定の控えだけ
// ----------------------------------------------------------------------

const BATCH_DEFAULTS: Rec = { projectId: null, excludedCount: 0 };

function compactImportBatch(row: Rec): Rec | null {
  // 検証しただけのバッチは載せない（確定のときにブラウザが元の CSV を送り直し、サーバーが検証し直す）
  if (row.status !== 'committed') return null;
  const rows = Array.isArray(row.rows) ? (row.rows as Rec[]) : [];
  return withoutDefaults(
    {
      [COMPACT_MARK]: COMPACT_VERSION,
      id: row.id,
      organizationId: row.organizationId,
      reportingPeriodId: row.reportingPeriodId,
      projectId: row.projectId,
      fileName: row.fileName,
      fileSha256: row.fileSha256,
      commitIdempotencyKey: row.commitIdempotencyKey,
      committedAt: row.committedAt,
      committedBy: row.committedBy,
      excludedCount: row.excludedCount,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      // 行は「確定の結果」を示すのに要る列だけ（行番号・差分区分・対象か・書いた Data Point と版・除外の理由）
      r: rows.map((r) => ({
        n: r.rowNo,
        k: r.diffKind,
        ...(r.included === false ? { x: 1 } : {}),
        ...(isStr(r.writtenDataPointId) ? { d: r.writtenDataPointId } : {}),
        ...(isStr(r.writtenVersionId) ? { w: r.writtenVersionId } : {}),
        ...(r.included === false && isStrArray(r.errors) && r.errors.length > 0
          ? { e: r.errors.slice(0, 2).map((e) => e.slice(0, 200)) }
          : {}),
      })),
    },
    BATCH_DEFAULTS,
  );
}

function expandImportBatch(v: Rec): Rec | null {
  const row = withDefaults(v, BATCH_DEFAULTS);
  const shape: Shape = {
    id: isStr,
    organizationId: isStr,
    reportingPeriodId: isStr,
    projectId: isStrOrNull,
    fileName: isStr,
    fileSha256: isStr,
    commitIdempotencyKey: isStr,
    committedAt: isStr,
    committedBy: isStr,
    excludedCount: isInt,
    createdAt: isStr,
    createdBy: isStr,
  };
  if (!hasShape(row, shape) || !Array.isArray(row.r)) return null;
  const rows: Rec[] = [];
  for (const entry of row.r as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const r = entry as Rec;
    if (!isInt(r.n) || !(QUANTITATIVE_IMPORT_DIFF_KINDS as readonly unknown[]).includes(r.k)) {
      return null;
    }
    rows.push({
      rowNo: r.n,
      raw: {},
      diffKind: r.k,
      included: r.x !== 1,
      metricId: null,
      unitId: null,
      boundary: null,
      dataPointId: isStr(r.d) ? r.d : null,
      currentVersionId: null,
      value: null,
      textValue: null,
      unitOfMeasure: null,
      valueKind: 'actual',
      availabilityStatus: 'value_present',
      absenceReason: null,
      errors: isStrArray(r.e) ? r.e : [],
      warnings: [],
      writtenDataPointId: isStr(r.d) ? r.d : null,
      writtenVersionId: isStr(r.w) ? r.w : null,
    });
  }
  return { ...only(row, shape), status: 'committed', rows, previewHash: '' };
}

// ----------------------------------------------------------------------
// スナップショット（report_snapshots）: 目録だけ
// ----------------------------------------------------------------------

interface SnapshotRowLike {
  id: string;
  organizationId: string;
  projectId: string;
  snapshotKind: string;
  snapshotNo: number;
  label: string;
  frameworkVersions: SnapshotFramework[];
  decisionIds: string[];
  blocks: SnapshotBlock[];
  metricValues: SnapshotMetricValue[];
  narrativeVersionIds: string[];
  anchors: Array<{ sourceAnchorId: string }>;
  policyVersion: string | null;
  contentHash: string;
  createdAt: string;
  createdBy: string;
}

function compactSnapshot(row: SnapshotRowLike, db: FixtureDb): Rec | null {
  const first = row.frameworkVersions[0];
  const project = first
    ? {
        n: first.projectName,
        e: first.reportingEntity,
        s: first.periodStart,
        en: first.periodEnd,
        r: first.scopeRevision,
      }
    : null;
  // 表紙の表示（プロジェクト名など）は全基準で同じ値を固定している（report-snapshot.ts の assemble）
  if (
    row.frameworkVersions.some(
      (f) =>
        f.projectName !== project?.n ||
        f.reportingEntity !== project?.e ||
        f.periodStart !== project?.s ||
        f.periodEnd !== project?.en ||
        f.scopeRevision !== project?.r,
    )
  ) {
    return null;
  }
  const blocks: Rec[] = [];
  for (const b of row.blocks) {
    // 社内コメントは ID で持つ（本文・日時はコメントの行で変わらない）
    const commentIds: string[] = [];
    for (const c of b.internalComments) {
      const found = db.reviewComments.find(
        (rc) =>
          rc.blockId === b.blockId &&
          rc.paragraphId === c.paragraphId &&
          rc.severity === c.severity &&
          rc.body === c.body &&
          rc.createdAt === c.createdAt,
      );
      if (!found) return null;
      commentIds.push(found.id);
    }
    blocks.push({
      i: b.blockId,
      v: b.versionId,
      s: b.status,
      ...(b.approvedVersionId === null
        ? {}
        : { a: b.approvedVersionId === b.versionId ? 1 : b.approvedVersionId }),
      ...(b.isApprovedVersion ? { ok: 1 } : {}),
      ...(b.issues.length > 0 ? { is: b.issues } : {}),
      ...(commentIds.length > 0 ? { c: commentIds } : {}),
      ...(b.maskedFileNames === null
        ? { m: 0 }
        : b.maskedFileNames.length > 0
          ? { m: b.maskedFileNames }
          : {}),
    });
  }
  // v2 の写し（承認の記録・根拠資料・要求事項の状態）。承認の記録と判断・承認の記録の ID は、追記専用の行から
  // 固定時点（作成日時）で同じ規則により組み立て直せるため載せない。可変の評価行のダイジェストと、
  // 根拠資料の版（evidence_links は Cookie に載らず、書き換えもありうる）だけを載せる
  const v2 = isSnapshotV2(row);
  const manifest: Rec = {
    [COMPACT_MARK]: COMPACT_VERSION,
    ...(v2 ? { hv: 2 } : {}),
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    snapshotKind: row.snapshotKind,
    snapshotNo: row.snapshotNo,
    label: row.label,
    decisionIds: row.decisionIds,
    narrativeVersionIds: row.narrativeVersionIds,
    policyVersion: row.policyVersion,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    pj: project,
    fw: row.frameworkVersions.map((f) => ({
      v: f.frameworkVersionId,
      a: f.applicabilityStatus,
      d: f.decisionId,
      p: f.purpose,
      ...(v2 && f.requirementState?.assessmentDigest
        ? { rd: f.requirementState.assessmentDigest }
        : {}),
    })),
    bl: blocks,
    mv: row.metricValues.map((m) => ({
      v: m.dataPointVersionId,
      s: m.status,
      ...(m.versionApproved ? { ok: 1 } : {}),
      ...(v2 && (m.evidenceFileVersionIds ?? []).length > 0 ? { e: m.evidenceFileVersionIds } : {}),
    })),
    an: row.anchors.map((a) => a.sourceAnchorId),
  };
  // 目録から同じ写しを組み立て直せることを、載せる前に確かめる（組み立て直せない目録は載せない）
  return expandSnapshot(manifest, db, unlimitedBudget()) ? manifest : null;
}

/**
 * 目録の件数・長さの上限。正規の目録はこの数分の 1 に収まる（節は数十、引用する数値・引用位置は数百まで）。
 * 偽の目録で同じ節・同じ行を何千回も並べ、大きい本文の写しを大量に作らせない（自己監査 第 2 巡 F2）
 */
const MANIFEST_LIMITS = {
  frameworks: 20,
  blocks: 200,
  refs: 2000,
  perBlock: 200,
  text: 2000,
} as const;

/**
 * スナップショット 1 件の写しの大きさの上限（本文・社内コメント・引用文・注意の文字数の見積もり）。
 * 内容ハッシュの計算（正規化した JSON）はこの大きさに比例する
 */
const MAX_SNAPSHOT_CONTENT_CHARS = 2_000_000;

const isShortStr = (x: unknown): x is string => isStr(x) && x.length <= MANIFEST_LIMITS.text;

function isUniqueStrList(values: unknown[], limit: number): boolean {
  return values.length <= limit && values.every(isStr) && new Set(values).size === values.length;
}

/**
 * 目録から写しを組み立てる（内容ハッシュはまだ確かめない）。テストで偽の目録を作るためにも使う
 */
export function rehydrateSnapshotManifest(v: Rec, db: FixtureDb): Rec | null {
  const ok = hasShape(v, {
    id: isStr,
    organizationId: isStr,
    projectId: isStr,
    snapshotKind: (x) => x === 'approved' || x === 'review_draft',
    snapshotNo: (x) => isInt(x) && x > 0,
    label: isShortStr,
    decisionIds: (x) => isStrArray(x) && x.length <= MANIFEST_LIMITS.refs,
    narrativeVersionIds: (x) => isStrArray(x) && x.length <= MANIFEST_LIMITS.refs,
    policyVersion: isStrOrNull,
    contentHash: isStr,
    createdAt: isStr,
    createdBy: isStr,
    fw: (x) =>
      Array.isArray(x) &&
      isUniqueStrList(
        x.map((f) => (f as Rec | null)?.v),
        MANIFEST_LIMITS.frameworks,
      ),
    // 同じ節・同じ行は 1 回だけ（正規の目録は重複を持たない。report-snapshot.ts の assemble）
    bl: (x) =>
      Array.isArray(x) &&
      isUniqueStrList(
        x.map((b) => (b as Rec | null)?.i),
        MANIFEST_LIMITS.blocks,
      ),
    mv: (x) =>
      Array.isArray(x) &&
      isUniqueStrList(
        x.map((m) => (m as Rec | null)?.v),
        MANIFEST_LIMITS.refs,
      ),
    an: (x) => Array.isArray(x) && isUniqueStrList(x, MANIFEST_LIMITS.refs),
  });
  if (!ok) return null;
  const pj = v.pj as Rec | null;
  if (pj !== null && (!pj || typeof pj !== 'object')) return null;
  // v2 の写し（承認の記録・根拠資料・要求事項の状態を持つ）。知らない版の目録は戻さない
  if (v.hv !== undefined && v.hv !== 2) return null;
  const v2 = v.hv === 2;
  const owner = v2
    ? db.disclosureProjects.find(
        (p) => p.id === v.projectId && p.organizationId === v.organizationId,
      )
    : undefined;
  if (v2 && !owner) return null;
  const frozenRevision = pj && isInt(pj.r) ? pj.r : 0;

  const frameworkVersions: SnapshotFramework[] = [];
  for (const entry of v.fw as Rec[]) {
    if (!entry || !isStr(entry.v) || !isStr(entry.a) || !pj) return null;
    const version = db.frameworkVersions.find((fv) => fv.id === entry.v) ?? null;
    const framework = version
      ? (db.frameworks.find((f) => f.id === version.frameworkId) ?? null)
      : null;
    let requirementState: SnapshotRequirementState | null = null;
    if (v2 && owner) {
      if (entry.rd !== undefined && !(isStr(entry.rd) && /^[0-9a-f]{16}$/.test(entry.rd))) {
        return null;
      }
      // 作成時（report-snapshot.ts の loadRequirementState）と同じ規則で、固定時点までの記録を引き直す
      const pf = db.projectFrameworks.find(
        (p) =>
          p.projectId === owner.id &&
          p.organizationId === owner.organizationId &&
          p.frameworkVersionId === entry.v,
      );
      requirementState = snapshotRequirementStateOf({
        assessmentEvents: pf
          ? db.projectRequirementAssessmentEvents.filter(
              (e) => e.organizationId === owner.organizationId && e.projectFrameworkId === pf.id,
            )
          : [],
        exclusionEvents: db.requirementExclusionEvents.filter(
          (e) =>
            e.organizationId === owner.organizationId &&
            e.reportingPeriodId === owner.reportingPeriodId &&
            e.frameworkVersionId === entry.v &&
            (e.projectFrameworkId === null || e.projectFrameworkId === pf?.id),
        ),
        assessmentDigest: isStr(entry.rd) ? entry.rd : null,
        asOf: v.createdAt as string,
      });
    }
    frameworkVersions.push(
      snapshotFrameworkOf(
        {
          frameworkVersionId: entry.v,
          applicabilityStatus: entry.a as SnapshotFramework['applicabilityStatus'],
          currentDecisionId: isStr(entry.d) ? entry.d : null,
          purpose: (isStr(entry.p) ? entry.p : null) as SnapshotFramework['purpose'],
        },
        version,
        framework,
        {
          name: String(pj.n ?? ''),
          reportingEntity: String(pj.e ?? ''),
          periodStart: String(pj.s ?? ''),
          periodEnd: String(pj.en ?? ''),
          scopeRevision: isInt(pj.r) ? pj.r : 0,
        },
        v2 ? { requirementState } : undefined,
      ),
    );
  }
  const orgRequests = v2
    ? db.reviewRequests.filter((r) => r.organizationId === v.organizationId)
    : [];
  const orgEvents = v2 ? db.reviewEvents.filter((e) => e.organizationId === v.organizationId) : [];

  const itemById = new Map(db.disclosureItems.map((i) => [i.id, i]));
  const blocks: SnapshotBlock[] = [];
  for (const entry of v.bl as Rec[]) {
    if (!entry || !isStr(entry.i) || !isStrOrNull(entry.v) || !isStr(entry.s)) return null;
    const block = db.disclosureBlocks.find((b) => b.id === entry.i);
    // 目録のプロジェクト（と組織）の節だけ
    if (!block || block.projectId !== v.projectId || block.organizationId !== v.organizationId) {
      return null;
    }
    const version = entry.v ? db.disclosureBlockVersions.find((x) => x.id === entry.v) : null;
    if (entry.v && !version) return null;
    const commentIds = (entry.c ?? []) as unknown[];
    if (!Array.isArray(commentIds) || !isUniqueStrList(commentIds, MANIFEST_LIMITS.perBlock)) {
      return null;
    }
    const comments = [];
    for (const id of commentIds) {
      // 社内コメントは、目録の組織の、その節のものだけ（作るとき compactSnapshot も節で探す）。
      // 別の組織のコメントを社内確認用の出力に載せさせない
      const comment = db.reviewComments.find(
        (c) => c.id === id && c.organizationId === v.organizationId && c.blockId === block.id,
      );
      if (!comment) return null;
      comments.push(snapshotCommentOf(comment));
    }
    const issues = (entry.is ?? []) as SnapshotIssue[];
    if (
      !Array.isArray(issues) ||
      issues.length > MANIFEST_LIMITS.perBlock ||
      !issues.every((i) => isShortStr(i?.code) && isShortStr(i?.message))
    ) {
      return null;
    }
    const masked = entry.m === 0 ? null : ((entry.m ?? []) as string[]);
    if (
      masked !== null &&
      !(isStrArray(masked) && masked.length <= MANIFEST_LIMITS.perBlock && masked.every(isShortStr))
    ) {
      return null;
    }
    blocks.push(
      snapshotBlockOf(
        block,
        version ?? null,
        {
          status: entry.s as SnapshotBlock['status'],
          approvedVersionId:
            entry.a === 1 ? (entry.v as string | null) : isStr(entry.a) ? entry.a : null,
          isApprovedVersion: entry.ok === 1,
          requirements: snapshotRequirementsOf(block.requirementItemIds, itemById),
          issues,
          internalComments: comments,
          maskedFileNames: masked,
        },
        v2
          ? {
              // 承認の記録は追記専用の依頼・記録から作成時と同じ規則で選び直す（report-snapshot.ts の assemble）
              approval:
                entry.ok === 1 && version
                  ? snapshotApprovalOf(
                      block.id,
                      version.id,
                      orgRequests,
                      orgEvents,
                      v.snapshotKind === 'approved' ? frozenRevision : 0,
                    )
                  : null,
            }
          : undefined,
      ),
    );
  }

  const metricValues: SnapshotMetricValue[] = [];
  for (const entry of v.mv as Rec[]) {
    if (!entry || !isStr(entry.v) || !isStr(entry.s)) return null;
    const version = db.dataPointVersions.find((x) => x.id === entry.v);
    const dp = version ? db.dataPoints.find((d) => d.id === version.dataPointId) : undefined;
    if (!version || !dp) return null;
    const evidence = entry.e ?? [];
    if (!isStrArray(evidence) || !isUniqueStrList(evidence, MANIFEST_LIMITS.perBlock)) return null;
    metricValues.push(
      snapshotMetricValueOf(
        version,
        dp,
        {
          metric: db.metrics.find((m) => m.id === dp.metricId),
          unit: db.units.find((u) => u.id === dp.unitId),
          period: db.periods.find((p) => p.id === dp.reportingPeriodId),
        },
        { status: entry.s as SnapshotMetricValue['status'], versionApproved: entry.ok === 1 },
        v2 ? { evidenceFileVersionIds: evidence } : undefined,
      ),
    );
  }

  const anchors = [];
  for (const id of v.an as string[]) {
    const anchor = db.sourceAnchors.find((a) => a.id === id);
    if (!anchor) return null;
    const fileVersion = db.fileVersions.find((fv) => fv.id === anchor.fileVersionId);
    const file = fileVersion ? db.files.find((f) => f.id === fileVersion.fileId) : undefined;
    anchors.push(snapshotAnchorOf(anchor, fileVersion, file));
  }

  const row = {
    id: v.id,
    organizationId: v.organizationId,
    projectId: v.projectId,
    snapshotKind: v.snapshotKind,
    snapshotNo: v.snapshotNo,
    label: v.label,
    frameworkVersions,
    decisionIds: v.decisionIds,
    blocks,
    metricValues,
    narrativeVersionIds: v.narrativeVersionIds,
    anchors,
    policyVersion: v.policyVersion,
    contentHash: v.contentHash,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  };
  return row;
}

/**
 * 組み立てた写しの大きさの見積もり（文字数）。写しは版の本文・コメント・引用文を参照するだけで、
 * 内容ハッシュの計算（正規化した JSON）がこの大きさに比例する
 */
function snapshotContentChars(row: {
  blocks: SnapshotBlock[];
  anchors: Array<{ quoteText: string }>;
  metricValues: unknown[];
}): number {
  let chars = row.metricValues.length * 500;
  for (const block of row.blocks) {
    chars += bodyInfoOf(block.body).chars + 1_000;
    for (const comment of block.internalComments) chars += comment.body.length;
    for (const issue of block.issues) chars += issue.message.length;
  }
  for (const anchor of row.anchors) chars += anchor.quoteText.length;
  return chars;
}

/** 目録から写しを組み立て、作成時と同じ内容（ハッシュ）に戻ったときだけ返す */
function expandSnapshot(v: Rec, db: FixtureDb, budget: ReplayBudget): Rec | null {
  const row = rehydrateSnapshotManifest(v, db);
  if (!row) return null;
  const chars = snapshotContentChars(row as unknown as Parameters<typeof snapshotContentChars>[0]);
  if (chars > MAX_SNAPSHOT_CONTENT_CHARS || !spend(budget, chars)) return null;
  // 作成時と同じ内容に戻らなければ戻さない（上流の行が変わった・押し出された）。
  // 同じハッシュで別の内容を出力させない
  const hash = computeSnapshotContentHash(
    row as unknown as Parameters<typeof computeSnapshotContentHash>[0],
  );
  return hash === v.contentHash ? row : null;
}

// ----------------------------------------------------------------------
// 保証側へ共有した写し（shared_report_copies）: 目録だけ
// ----------------------------------------------------------------------

const SHARED_COPY_DEFAULTS: Rec = { withdrawnAt: null, withdrawnBy: null };

const SHARED_COPY_SHAPE: Shape = {
  id: isStr,
  engagementId: isStr,
  assuranceFirmId: isStr,
  clientOrganizationId: isStr,
  snapshotId: isStr,
  snapshotContentHash: isStr,
  copyHash: isStr,
  sharedBy: isStr,
  sharedAt: isStr,
  withdrawnAt: isStrOrNull,
  withdrawnBy: isStrOrNull,
};

/** 写しの本文（copy）は載せない。共有の目録（どの案件へ・どのスナップショットを・誰が・いつ）だけ */
function compactSharedCopy(row: Rec): Rec {
  const { copy: _copy, ...rest } = row;
  return withoutDefaults({ [COMPACT_MARK]: COMPACT_VERSION, ...rest }, SHARED_COPY_DEFAULTS);
}

/**
 * 目録から写しを作り直す。スナップショット（先に戻る）から共有のときと同じ関数で作り、copy_hash が
 * 一致したときだけ使う（同じハッシュで別の写しを保証側に出さない。スナップショットが無ければ戻さない）
 */
function expandSharedCopy(v: Rec, db: FixtureDb, budget: ReplayBudget): Rec | null {
  const row = withDefaults(v, SHARED_COPY_DEFAULTS);
  if (!hasShape(row, SHARED_COPY_SHAPE)) return null;
  const snapshot = db.reportSnapshots.find((s) => s.id === row.snapshotId);
  if (
    !snapshot ||
    snapshot.organizationId !== row.clientOrganizationId ||
    snapshot.contentHash !== row.snapshotContentHash
  ) {
    return null;
  }
  const content = buildSharedReportCopy(asSnapshotDetail(snapshot));
  const chars = JSON.stringify(content).length;
  if (chars > MAX_SNAPSHOT_CONTENT_CHARS || !spend(budget, chars)) return null;
  if (sharedReportCopyHash(content) !== row.copyHash) return null;
  return { ...only(row, SHARED_COPY_SHAPE), copy: content as unknown as Rec };
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

/**
 * Cookie に載せる形。null なら載せない（検証しただけの取込バッチ・組み立て直せない目録・
 * データ以外を対象にした承認の記録）
 */
export function compactRow(table: string, row: Rec, db: FixtureDb): Rec | null {
  switch (table) {
    case 'disclosureBlockVersions':
      return compactBlockVersion(row as unknown as DisclosureBlockVersion, db);
    case 'narrativeVersions':
      return compactNarrativeVersion(row);
    case 'sourceAnchors':
      return withoutDefaults({ [COMPACT_MARK]: COMPACT_VERSION, ...row }, ANCHOR_DEFAULTS);
    case 'reportSnapshots':
      return compactSnapshot(row as unknown as SnapshotRowLike, db);
    case 'exportArtifacts': {
      const { contentHash: _hash, ...rest } = row;
      return withoutDefaults(
        { [COMPACT_MARK]: COMPACT_VERSION, ...packReconciliation(rest) },
        EXPORT_ARTIFACT_DEFAULTS,
      );
    }
    case 'quantitativeImportBatches':
      return compactImportBatch(row);
    case 'approvals':
      // データの承認の記録だけ（引用した数値の版が承認済みだったことを、別インスタンスでも示すため）
      return row.targetType === 'data_point'
        ? withoutDefaults({ [COMPACT_MARK]: COMPACT_VERSION, ...row }, APPROVAL_DEFAULTS)
        : null;
    case 'sharedReportCopies':
      return compactSharedCopy(row);
    default:
      return row;
  }
}

/**
 * Cookie の形から行を組み立て直す。組み立てられない（形が不正・依存する行がまだ無い）なら null。
 * 依存する行（土台の版・スナップショット・引用した行）は、呼び出し側が先に戻しておく
 */
export function expandRow(
  table: string,
  v: Rec,
  db: FixtureDb,
  options: { budget?: ReplayBudget } = {},
): Rec | null {
  if (v[COMPACT_MARK] !== COMPACT_VERSION) return null;
  const budget = options.budget ?? unlimitedBudget();
  switch (table) {
    case 'disclosureBlockVersions':
      return expandBlockVersion(v, db, budget);
    case 'narrativeVersions':
      return expandNarrativeVersion(v);
    case 'sourceAnchors':
      return expandAnchor(v);
    case 'reportSnapshots':
      return expandSnapshot(v, db, budget);
    case 'exportArtifacts':
      return expandExportArtifact(v, db);
    case 'quantitativeImportBatches':
      return expandImportBatch(v);
    case 'approvals':
      return expandApproval(v);
    case 'sharedReportCopies':
      return expandSharedCopy(v, db, budget);
    default:
      return null;
  }
}
