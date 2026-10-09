/**
 * 保証側へ共有する承認済みレポートの写し（トライアル対応 NF-20）。
 *
 * 企業と監査法人の接続は engagements と client_access_grants だけ（CLAUDE.md §0.2）。report_snapshots に
 * 監査法人の SELECT を足さず、共有の行為（企業側）で「保証側用の写し」を作る。写しはスナップショットの
 * 写しから、社内向けのもの（社内コメント・社内向けの確認事項）を除き、対外用の出力と同じ伏せ字を当てたもの
 * （判断事項 D3 の既定。非公開資料の名前は「社内資料」とし、引用文は載せない）。
 *
 * 同じスナップショットからは、いつ・どのインスタンスで作っても同じ写し（同じ copy_hash）になる
 * （Demo Mode では写しを Cookie に載せず、目録から作り直して copy_hash が一致した時だけ使う）。
 *
 * DB にも画面にも依存しない純粋関数だけを置く（社内確認用の出力の関数は使わない）。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import type {
  ReportSnapshotDetail,
  SnapshotAnchor,
  SnapshotBlock,
} from '@/lib/domain/report-snapshot-content';
import type { BlockBody, BlockInline, Uuid } from '@/types/domain';

/** 写しの規則の版。規則を変えたら上げる（過去の写しのハッシュと混同しない） */
export const REPORT_COPY_VERSION = 'report-copy-v1';

/** 非公開資料の名前の置き換え（対外用の出力と同じ語） */
export const MASKED_FILE_LABEL = '社内資料';

/** 写しの内容（shared_report_copies.copy）。スナップショットの写しと同じ形で、保証側の画面も同じ描画を使う */
export interface SharedReportCopyContent extends Pick<
  ReportSnapshotDetail,
  | 'projectId'
  | 'snapshotKind'
  | 'snapshotNo'
  | 'label'
  | 'frameworkVersions'
  | 'decisionIds'
  | 'metricValues'
  | 'narrativeVersionIds'
  | 'policyVersion'
  | 'contentHash'
  | 'createdAt'
> {
  copyVersion: string;
  snapshotId: Uuid;
  blocks: SnapshotBlock[];
  anchors: SnapshotAnchor[];
}

function isPublic(anchor: Pick<SnapshotAnchor, 'confidentiality'>): boolean {
  return anchor.confidentiality === 'public';
}

/**
 * 伏せる資料名。スナップショットに固定した非公開資料の名前（v1 の写しで固定していなければ引用位置の
 * 非公開資料の名前だけ）。短すぎる名前は普通の語を伏せないよう除き、長い名前から置き換える
 */
export function copyMaskedNames(
  snapshot: Pick<ReportSnapshotDetail, 'anchors' | 'blocks'>,
): string[] {
  const frozen = snapshot.blocks.flatMap((b) => b.maskedFileNames ?? []);
  const names = [...snapshot.anchors.filter((a) => !isPublic(a)).map((a) => a.fileName), ...frozen]
    .map((n) => n.trim())
    .filter((n) => n.length >= 3);
  return [...new Set(names)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

function maskText(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) out = out.split(name).join(MASKED_FILE_LABEL);
  return out;
}

function maskInline(inline: BlockInline, names: readonly string[]): BlockInline {
  if (inline.t === 'text') return { ...inline, text: maskText(inline.text, names) };
  if (inline.t === 'narrative') return { ...inline, quote: maskText(inline.quote, names) };
  return inline;
}

function maskBody(body: BlockBody, names: readonly string[]): BlockBody {
  return {
    paragraphs: body.paragraphs.map((p) => ({
      ...p,
      children: p.children.map((inline) => maskInline(inline, names)),
    })),
  };
}

function maskAnchor(anchor: SnapshotAnchor): SnapshotAnchor {
  if (isPublic(anchor)) return anchor;
  return {
    ...anchor,
    fileName: MASKED_FILE_LABEL,
    fileId: null,
    editionLabel: null,
    // 非公開資料の引用文は写しに載せない（資料の実体は許諾が Evidence を含むときだけ別に読める）
    quoteText: '',
  };
}

/** 承認済みスナップショットから保証側用の写しを作る（社内コメント・社内向けの確認事項を除く） */
export function buildSharedReportCopy(snapshot: ReportSnapshotDetail): SharedReportCopyContent {
  const names = copyMaskedNames(snapshot);
  return {
    copyVersion: REPORT_COPY_VERSION,
    snapshotId: snapshot.id,
    projectId: snapshot.projectId,
    snapshotKind: snapshot.snapshotKind,
    snapshotNo: snapshot.snapshotNo,
    label: snapshot.label,
    frameworkVersions: snapshot.frameworkVersions,
    decisionIds: snapshot.decisionIds,
    blocks: snapshot.blocks.map((block) => ({
      ...block,
      body: maskBody(block.body, names),
      // 社内向けのもの（未解決の社内コメント・社内向けの確認事項）は写さない
      issues: [],
      internalComments: [],
      // 伏せ字は写しに当て済み
      maskedFileNames: [],
    })),
    metricValues: snapshot.metricValues,
    narrativeVersionIds: snapshot.narrativeVersionIds,
    anchors: snapshot.anchors.map(maskAnchor),
    policyVersion: snapshot.policyVersion,
    contentHash: snapshot.contentHash,
    createdAt: snapshot.createdAt,
  };
}

/** 写しのハッシュ（shared_report_copies.copy_hash） */
export function sharedReportCopyHash(copy: SharedReportCopyContent): string {
  return createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
}

/** 写しが社内向けのもの（社内コメント・確認事項）を含んでいないか（共有の前後の検査に使う） */
export function copyHasInternalContent(copy: SharedReportCopyContent): boolean {
  return copy.blocks.some((b) => b.internalComments.length > 0 || b.issues.length > 0);
}

/**
 * 写しの段落・数値がコメントの対象として実在するか（保証側のコメントの起票で使う。NF-21）
 */
export function copyHasParagraph(
  copy: Pick<SharedReportCopyContent, 'blocks'>,
  blockId: Uuid,
  paragraphId: string,
): boolean {
  return copy.blocks.some(
    (b) => b.blockId === blockId && b.body.paragraphs.some((p) => p.id === paragraphId),
  );
}

export function copyHasMetric(
  copy: Pick<SharedReportCopyContent, 'metricValues'>,
  dataPointVersionId: Uuid,
): boolean {
  return copy.metricValues.some((m) => m.dataPointVersionId === dataPointVersionId);
}

/** 写しの JSON を読む（形が崩れていれば null。保証側の画面は null を「読み込めない」として扱う） */
export function parseSharedReportCopy(value: unknown): SharedReportCopyContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<SharedReportCopyContent>;
  if (
    v.copyVersion !== REPORT_COPY_VERSION ||
    typeof v.snapshotId !== 'string' ||
    !Array.isArray(v.blocks) ||
    !Array.isArray(v.metricValues) ||
    !Array.isArray(v.anchors) ||
    !Array.isArray(v.frameworkVersions)
  ) {
    return null;
  }
  return v as SharedReportCopyContent;
}
