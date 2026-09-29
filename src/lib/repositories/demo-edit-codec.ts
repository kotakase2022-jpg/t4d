import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { permissionsFor } from '@/lib/authorization/can';
import { availabilityFromValue } from '@/lib/domain/disclosure-status';
import type { FixtureDb } from '@/lib/fixtures/store';
import type {
  DisclosureBlock,
  PermissionKey,
  ReviewEvent,
  ReviewRequest,
  Uuid,
} from '@/types/domain';
import type { TableName } from './types';

/**
 * Demo Mode の変更差分を Cookie へ収めるための符号化。
 *
 * Cookie は 4KB 程度が上限で、取込 1 行は UUID を 7 個持つ。
 * そのうち jobId・jobFileId・organizationId・reportingPeriodId・aiRunId は
 * 同じジョブの全行で同じ値になる。deflate だけでは 2 倍程度にしか縮まないため、
 * **2 回以上現れる文字列を辞書へ移して参照に置き換えてから** deflate する。
 * 実測で 8〜10 倍になり、20〜30 行の取込結果が 1 つの Cookie に収まる。
 *
 * 副作用が無く Cookie にも依存しないので、この層だけ単体テストできる
 * （`demo-persistence.ts` は `server-only` のため直接はテストできない）。
 */

/** 1 件の変更（upsert）。v は「変更のあった列」だけを持つ */
export interface DemoEdit {
  /** テーブル名 */
  t: string;
  /** 主キー */
  id: string;
  /** 変更後の列（部分） */
  v: Record<string, unknown>;
}

/**
 * 圧縮形式の目印。
 * 旧形式は必ず `JSON.stringify([...])` の base64url なので先頭は 'W' になる。
 * '2' と衝突しないため、この 1 文字で新旧を判別できる。
 */
const VERSION_2 = '2';

/**
 * 辞書参照の目印。制御文字なので実データにはまず現れないが、
 * 万一含まれていても壊れないよう、二重化して退避する。
 */
const REF = String.fromCharCode(1);

/** 辞書に載せる最小長。短い文字列は参照にしても得しない */
const MIN_DICT_LENGTH = 8;

function countStrings(value: unknown, counts: Map<string, number>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_DICT_LENGTH) counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) countStrings(v, counts);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) countStrings(v, counts);
  }
}

function replaceStrings(value: unknown, index: Map<string, number>): unknown {
  if (typeof value === 'string') {
    const ref = index.get(value);
    if (ref !== undefined) return REF + ref;
    // 実データが目印で始まっていたら二重化しておき、復号時に区別できるようにする
    return value.startsWith(REF) ? REF + value : value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, index));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, index)]));
  }
  return value;
}

function restoreStrings(value: unknown, table: string[]): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(REF)) return value;
    if (value.startsWith(REF + REF)) return value.slice(1);
    return table[Number(value.slice(1))] ?? '';
  }
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, table));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, table)]));
  }
  return value;
}

function pack(edits: DemoEdit[]): [string[], unknown] {
  const counts = new Map<string, number>();
  countStrings(edits, counts);
  const table = [...counts.entries()].filter(([, n]) => n >= 2).map(([s]) => s);
  const index = new Map(table.map((s, i) => [s, i]));
  return [table, replaceStrings(edits, index)];
}

function unpack(packed: unknown): unknown {
  if (!Array.isArray(packed) || packed.length !== 2) return packed;
  const [table, body] = packed as [string[], unknown];
  return restoreStrings(body, Array.isArray(table) ? table : []);
}

export function encodeDemoEdits(edits: DemoEdit[]): string {
  return (
    VERSION_2 +
    deflateRawSync(Buffer.from(JSON.stringify(pack(edits)), 'utf8')).toString('base64url')
  );
}

/**
 * 展開後の上限。Cookie は 4KB 弱でも、圧縮を効かせれば展開後は数百 MB になりうる。
 * 偽造 Cookie 1 つでプロセスのメモリを枯渇させられないよう、展開時点で打ち切る。
 * 正規の Cookie は 40KB 程度（取込 45 行）に収まる。
 */
const MAX_INFLATED_BYTES = 512 * 1024;

export function decodeDemoEdits(raw: string): DemoEdit[] {
  try {
    if (raw.startsWith(VERSION_2)) {
      const json = inflateRawSync(Buffer.from(raw.slice(1), 'base64url'), {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString('utf8');
      const parsed = unpack(JSON.parse(json));
      return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
    }
    // 旧形式（無圧縮）の Cookie も読めるようにしておく
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
  } catch {
    // 壊れた Cookie で画面が落ちないよう、空として扱う
    return [];
  }
}

/**
 * Cookie に記録する対象テーブル（画面から人が編集するもの）。
 *
 * この一覧は書き込み時と読み取り時の**両方**で使う。
 * ここに無い表は Cookie 経由で一切触れないので、なりすましや証跡の改ざんに
 * 使える表（organizationMemberships / membershipRoles / auditEvents / signoffs）は
 * 意図的に外している。
 *
 * 逆に、ここへ入れた表は「偽の Cookie で作られた行」が混ざりうる。
 * Demo Mode のデータはすべて架空で、デモアカウントは誰でも使える前提
 * （docs/known-limitations.md D-4）なので、デモとして見せたい操作を優先している。
 */
const PERSISTED_TABLES = new Set<TableName>([
  // 取込系。1 ファイル数行程度のデモ操作なら Cookie に収まる。
  // 大量ファイルの取込は収まらないため、その場合は同一インスタンス内でのみ参照できる
  // （docs/known-limitations.md D-3 に記載）。
  'ingestionJobs',
  'ingestionJobFiles',
  'ingestionRows',
  // サプライヤーデータ取込が追記する Scope3 の算定版。
  // 1 回の取込で 1 行（inputs は十数行の JSON）なので Cookie に収まる。
  // 持ち回さないと、取込直後の GHG 画面で内訳が元に戻って見える。
  'calculations',
  'materialityTopics',
  'comments',
  'dataPoints',
  'dataPointVersions',
  'disclosureResponses',
  'metrics',
  'units',
  'notifications',
  // 起票した案件・付与した許諾も持ち回す。
  // 入れないと「作った直後に開くと 404」になる（本番スモークで再現した）。
  'engagements',
  'engagementMembers',
  'grants',
  // AI の実行結果。?run=<id> で読み直す画面が多く、
  // 持ち回さないと「実行したのに何も出ない」になる。
  'aiRuns',
  // SSBJ の設定と開示ドラフト。どちらも「操作した直後に結果を見せる」画面なので、
  // 持ち回さないと本番 Demo Mode で操作が消えたように見える（本番スモークで再現した）。
  //
  // ssbjAssessments は**入れない**。要求事項 133 件の評価行を初回表示で一括作成するため、
  // Cookie の容量を使い切って他の操作（コメント・値編集）を押し出してしまう。
  'ssbjAnalysisSettings',
  'ssbjDisclosureDrafts',
  // 承認の道筋。段階を承認した結果が消えると、進み具合が巻き戻って見える。
  // 1 回の提出で作るのは 5 行なので容量に収まる
  'dataPointApprovalSteps',
  // 開示優先モード（docs/disclosure-first.md §2-6）。状態・ポインタ・短文だけの小さい行に限る。
  // 依頼・差戻し・承認の結果が消えると、レビューの流れが巻き戻って見えるため持ち回す。
  // 節（disclosureBlocks）の自動保存本文（workingBody）は大きくなりうるため、
  // DemoDbClient が Cookie へ書く前に外す（demo-client.ts の persistedColumns）。
  //
  // 次の表は**入れない**。本文 AST・定性情報の本文・引用文・スナップショット・取込行を持ち、
  // Cookie の容量（2 チャンクで約 7.6KB）を 1 件で使い切って他のデモ操作を押し出すため。
  //   narrativeVersions / disclosureBlockVersions / sourceAnchors /
  //   reportSnapshots / quantitativeImportBatches
  // これらは同一インスタンスのメモリにだけ残る（docs/known-limitations.md D-3 と同じ扱い）。
  // 別インスタンスでは参照先の版が見つからないため、画面は「見つからない」として安全に失敗させる。
  'organizationFeatureSettings',
  'disclosureProjects',
  'projectFrameworks',
  'projectFrameworkDecisions',
  'narrativeRecords',
  'disclosureBlocks',
  'reviewRequests',
  'reviewEvents',
  'reviewComments',
  'recheckDecisions',
  // exportArtifacts は入れない。出力の記録はスナップショット（メモリのみ）と組でしか表示されず、
  // 別インスタンスでは使われないまま Cookie の容量だけを使い、他のデモ操作を押し出していた
  'kpiTargets',
]);

/**
 * 追記専用の表。Cookie から既存の行を書き換えさせない（新しい行の追加だけを受け付ける）。
 * DB では UPDATE ポリシーが無く t4d.forbid_mutation() が止める。Demo Mode でも同じにする
 */
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  'reviewEvents',
  'recheckDecisions',
  'kpiTargets',
]);

/**
 * Cookie の容量が足りないときも押し出さない表。機能設定（開示優先モードの ON/OFF）が押し出されると、
 * 新しいインスタンスでメニューとホームが従来の構成へ戻り、実演の途中で画面が変わってしまう
 */
const PINNED_TABLES: ReadonlySet<string> = new Set(['organizationFeatureSettings']);

export function isPinnedEdit(edit: Pick<DemoEdit, 't'>): boolean {
  return PINNED_TABLES.has(edit.t);
}

/**
 * 容量を超えたときに落とす順: 押し出さない表以外の、いちばん古い編集から。
 * 落とせる編集が無ければ null
 */
export function dropOldestUnpinned(edits: readonly DemoEdit[]): DemoEdit[] | null {
  const index = edits.findIndex((e) => !isPinnedEdit(e));
  if (index === -1) return null;
  return [...edits.slice(0, index), ...edits.slice(index + 1)];
}

export function isPersistedTable(table: TableName): boolean {
  return PERSISTED_TABLES.has(table);
}

/**
 * Fixture へ変更を再適用する。
 * 対象行が見つからない場合（別インスタンスで作られた新規行など）は無視する。
 *
 * **Cookie の中身は信用しない。** httpOnly は JavaScript から読めなくするだけで、
 * 攻撃者が自分で Cookie ヘッダーを組み立てて送るのは防げない。
 * Fixture DB はプロセス全体で共有されるため、検証せずに適用すると
 * 「1 リクエストで全利用者のデータを書き換える」ことができてしまう。
 *
 * そこで、書き込み時と**同じ許可リスト**をここでも通す。
 * これにより organizationMemberships（ロール注入）・membershipRoles・auditEvents・signoffs
 * といった、なりすましや証跡の改ざんに使える表には一切届かない。
 */
/** 互いを参照して検証する表（依頼 ⇔ 記録 ⇔ 節）。受け付けられる順に適用する */
const REVIEW_TABLES: ReadonlySet<string> = new Set([
  'reviewRequests',
  'reviewEvents',
  'disclosureBlocks',
]);

export function applyDemoEdits(db: FixtureDb, edits: DemoEdit[]): void {
  const deferred: DemoEdit[] = [];
  for (const edit of edits) {
    // 書き込み側の許可リスト（isPersistedTable）と対にする。
    // 片側だけの防御は、Cookie を偽造されると意味を持たない。
    if (!isPersistedTable(edit.t as TableName)) continue;
    if (!edit.v || typeof edit.v !== 'object' || Array.isArray(edit.v)) continue;
    if (REVIEW_TABLES.has(edit.t)) {
      deferred.push(edit);
      continue;
    }
    applyOne(db, edit, []);
  }
  // 承認・レビューの記録は、DB のトリガと同じ規則を満たすときだけ受け付ける
  // （Fixture DB はインスタンスの全利用者で共有される。偽の Cookie 1 つで、職務分離を通らない
  // 承認を全員の画面に出させない）。記録は依頼を、依頼の状態は記録を参照し、Cookie の中の順番は
  // 更新のたびに入れ替わるため、受け付けられるものから適用し、進まなくなるまで繰り返す
  let pending = deferred;
  for (;;) {
    const requests = pending.filter((e) => e.t === 'reviewRequests');
    const rest = pending.filter((edit) => !applyOne(db, edit, requests));
    if (rest.length === pending.length) break;
    pending = rest;
  }
}

/** 1 件を適用する。規則に合わず受け付けなかったら false */
function applyOne(db: FixtureDb, edit: DemoEdit, pendingRequests: readonly DemoEdit[]): boolean {
  const rows = db[edit.t as TableName] as unknown as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rows)) return true;
  const index = rows.findIndex((r) => r.id === edit.id);
  const row = index === -1 ? undefined : rows[index];
  if (!row && !('id' in edit.v)) return true;
  const next = normalizeLegacyRow(edit.t, row ? { ...row, ...edit.v } : { ...edit.v });
  if (!acceptEdit(db, edit.t, row, next, pendingRequests)) return false;
  if (row) {
    rows[index] = next;
  } else {
    // 新規作成された行（コメントなど）は、そのまま足す
    rows.push(next);
  }
  return true;
}

/**
 * 以前のデプロイの Cookie に残った行を、今の列の形へそろえる。
 * 0039 より前に作られた Data Point・版の行は、値の区分・値の有無・理由の列を持たない。
 * そのまま戻すと、それらの列を読む画面（一覧のバッジ・詳細の履歴）が落ちる
 */
export function normalizeLegacyRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (table !== 'dataPoints' && table !== 'dataPointVersions') return row;
  const out = { ...row };
  if (out.valueKind === undefined) out.valueKind = 'actual';
  if (out.availabilityStatus === undefined) {
    out.availabilityStatus = availabilityFromValue(
      out.value as number | null | undefined,
      out.textValue as string | null | undefined,
    );
  }
  if (out.absenceReason === undefined) out.absenceReason = null;
  return out;
}

// ----------------------------------------------------------------------
// 承認・レビューの記録の検証（0037 / 0041 のトリガと同じ規則を Demo Mode でも通す）
// ----------------------------------------------------------------------

function memberPermissions(db: FixtureDb, organizationId: Uuid, userId: Uuid): Set<PermissionKey> {
  const memberships = db.memberships.filter(
    (m) => m.organizationId === organizationId && m.userId === userId && m.status === 'active',
  );
  const roleKeys = db.membershipRoles
    .filter((r) => memberships.some((m) => m.id === r.membershipId))
    .map((r) => r.roleKey);
  return permissionsFor(roleKeys);
}

function hasEvent(
  db: FixtureDb,
  request: Pick<ReviewRequest, 'id' | 'targetVersionId'>,
  eventType: ReviewEvent['eventType'],
): boolean {
  return db.reviewEvents.some(
    (e) =>
      e.reviewRequestId === request.id &&
      e.eventType === eventType &&
      e.targetVersionId === request.targetVersionId,
  );
}

function acceptReviewEvent(
  db: FixtureDb,
  event: ReviewEvent,
  pendingRequests: readonly DemoEdit[],
): boolean {
  // 依頼の行がまだ適用されていなければ、同じ Cookie の依頼の編集（依頼時点の内容は変わらない）を見る
  const pending = pendingRequests.find((e) => e.id === event.reviewRequestId);
  const request =
    db.reviewRequests.find((r) => r.id === event.reviewRequestId) ??
    (pending ? (pending.v as unknown as ReviewRequest) : undefined);
  if (!request || request.organizationId !== event.organizationId) return false;
  if (event.targetVersionId !== request.targetVersionId) return false;
  const permissions = memberPermissions(db, event.organizationId, event.actorUserId);
  if (event.eventType === 'returned') {
    if (!event.reason?.trim() || !event.paragraphId?.trim()) return false;
    return (
      permissions.has('enterprise.disclosure.write') ||
      permissions.has('enterprise.disclosure.approve')
    );
  }
  if (event.eventType === 'requested' || event.eventType === 'withdrawn') {
    return permissions.has('enterprise.disclosure.write');
  }
  // レビュー完了・最終承認: 依頼者・版の作成者・本文を書いた人ではないこと
  if (event.actorUserId === request.requestedBy) return false;
  const version = db.disclosureBlockVersions.find((v) => v.id === request.targetVersionId);
  if (
    version &&
    (version.createdBy === event.actorUserId ||
      (version.contributorUserIds ?? []).includes(event.actorUserId))
  ) {
    return false;
  }
  if (event.eventType === 'review_completed') {
    return permissions.has('enterprise.disclosure.write');
  }
  // 最終承認: 別の人のレビュー完了の記録があり、自分はレビューを完了していないこと
  const reviewers = db.reviewEvents
    .filter(
      (e) =>
        e.reviewRequestId === request.id &&
        e.eventType === 'review_completed' &&
        e.targetVersionId === request.targetVersionId,
    )
    .map((e) => e.actorUserId);
  if (reviewers.length === 0 || reviewers.includes(event.actorUserId)) return false;
  return permissions.has('enterprise.disclosure.approve');
}

const REQUEST_IMMUTABLE_KEYS = [
  'organizationId',
  'projectId',
  'targetType',
  'targetId',
  'targetVersionId',
  'requestedBy',
  'reviewerUserId',
  'approverUserId',
  'policyVersion',
  'policy',
  'decisionIds',
  'referencedVersions',
  'projectScopeRevision',
  'createdAt',
  'createdBy',
] as const;

const TERMINAL_REQUEST_STATUSES: ReadonlyArray<ReviewRequest['status']> = [
  'returned',
  'approved',
  'withdrawn',
];

function acceptReviewRequest(
  db: FixtureDb,
  existing: ReviewRequest | undefined,
  next: ReviewRequest,
): boolean {
  if (existing) {
    for (const key of REQUEST_IMMUTABLE_KEYS) {
      if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
    }
    if (existing.status === next.status) return true;
    if (TERMINAL_REQUEST_STATUSES.includes(existing.status)) return false;
  } else {
    // 新しい依頼: 依頼者は書込権限を持つ組織の利用者で、指名は依頼者と別の人（0037 の検査制約と同じ）
    if (
      !memberPermissions(db, next.organizationId, next.requestedBy).has(
        'enterprise.disclosure.write',
      )
    ) {
      return false;
    }
    if (next.reviewerUserId && next.reviewerUserId === next.requestedBy) return false;
    if (
      next.approverUserId &&
      (next.approverUserId === next.requestedBy || next.approverUserId === next.reviewerUserId)
    ) {
      return false;
    }
  }
  switch (next.status) {
    case 'open':
      return !existing;
    case 'reviewed':
      return (!existing || existing.status === 'open') && hasEvent(db, next, 'review_completed');
    case 'approved':
      return (!existing || existing.status === 'reviewed') && hasEvent(db, next, 'approved');
    case 'returned':
      return hasEvent(db, next, 'returned');
    case 'withdrawn':
      return hasEvent(db, next, 'withdrawn');
    default:
      return false;
  }
}

function acceptBlock(
  db: FixtureDb,
  existing: DisclosureBlock | undefined,
  next: DisclosureBlock,
): boolean {
  const before = existing ?? { status: 'draft', approvedVersionId: null };
  const approvalChanged =
    (next.approvedVersionId !== null && next.approvedVersionId !== before.approvedVersionId) ||
    (next.status === 'approved' && before.status !== 'approved');
  if (approvalChanged) {
    const approvedVersionId = next.approvedVersionId;
    if (!approvedVersionId) return false;
    const recorded = db.reviewRequests.some(
      (r) =>
        r.targetId === next.id &&
        r.targetVersionId === approvedVersionId &&
        hasEvent(db, r, 'approved'),
    );
    if (!recorded) return false;
  }
  if (next.status === 'approval_pending' && before.status !== 'approval_pending') {
    const recorded = db.reviewRequests.some(
      (r) =>
        r.targetId === next.id &&
        r.targetVersionId === next.submittedVersionId &&
        hasEvent(db, r, 'review_completed'),
    );
    if (!recorded) return false;
  }
  return true;
}

function acceptEdit(
  db: FixtureDb,
  table: string,
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  pendingRequests: readonly DemoEdit[],
): boolean {
  if (existing && APPEND_ONLY_TABLES.has(table)) return false;
  switch (table) {
    case 'reviewEvents':
      return acceptReviewEvent(db, next as unknown as ReviewEvent, pendingRequests);
    case 'reviewRequests':
      return acceptReviewRequest(
        db,
        existing as unknown as ReviewRequest | undefined,
        next as unknown as ReviewRequest,
      );
    case 'disclosureBlocks':
      return acceptBlock(
        db,
        existing as unknown as DisclosureBlock | undefined,
        next as unknown as DisclosureBlock,
      );
    default:
      return true;
  }
}
