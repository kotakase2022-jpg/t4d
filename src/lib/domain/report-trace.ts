/**
 * スナップショットのトレース・追跡率・追跡番号（トライアル対応 NF-14。スライド 10 の評価 #1）。
 *
 * 出力した原稿の本文・数値から、要求事項・承認版（誰がいつ承認したか）・根拠へ遡れるかを、
 * スナップショット（固定した写し）だけから決める。ライブの行を引かない（同じスナップショットなら、
 * いつ・どのインスタンスで計算しても同じ結果になる）。保存しない。
 *
 * 追跡の単位:
 *  - 段落: 本文のある段落（見出し・空の段落は数えない）
 *  - 数値: 数値参照（metric）と手書きの数値（参照でない「数値＋単位」）
 * 段落が追跡できる＝節に要求事項がある・固定した版が承認済みで承認者と日時が写しにある・根拠がある
 *   （出典印・根拠つきの定性情報の引用・数値参照のいずれか）
 * 数値が追跡できる＝版がある・承認済み・値がある・根拠資料が紐付いている（写しにある）
 * 手書きの数値は常に追跡できない（参照が無いため）。追跡できない理由を必ず返す。
 *
 * 追跡番号は T-<節の短縮コード>-<段落番号>（数値は -N<n> を足す）。節の短縮コードは節のキーの頭文字で、
 * 同じスナップショットの中で重なれば番号を足す。段落番号は節の中の本文のある段落の通し番号（1 から）。
 *
 * DB にも画面にも依存しない純粋関数だけを置く。
 */

import { detectHandwrittenNumbers, paragraphText } from '@/lib/domain/disclosure-block';
import type { SnapshotBlock, SnapshotMetricValue } from '@/lib/domain/report-snapshot-content';
import type { BlockParagraph, IsoDateTime, Uuid } from '@/types/domain';

export type TraceUnitKind = 'paragraph' | 'number';

export type TraceReasonCode =
  | 'no_requirement'
  | 'not_approved'
  | 'approval_unknown'
  | 'no_evidence'
  | 'handwritten'
  | 'metric_missing'
  | 'metric_not_approved'
  | 'metric_no_value'
  | 'metric_no_evidence'
  | 'metric_evidence_unknown';

export const TRACE_REASON_LABELS: Readonly<Record<TraceReasonCode, string>> = {
  no_requirement: '節に要求事項が対応付けられていません。',
  not_approved: '固定した版が承認済みの版ではありません。',
  approval_unknown:
    '承認者・承認日時が写しにありません（承認の記録を固定する前に作ったスナップショット）。',
  no_evidence: '根拠（出典印・根拠つきの定性情報・数値参照）がありません。',
  handwritten: '本文に直接書いた数値で、参照がありません（追跡できません）。',
  metric_missing: '引用した数値の版が写しにありません。',
  metric_not_approved: '引用した数値の版が承認済みではありません。',
  metric_no_value: '引用した数値に値がありません。',
  metric_no_evidence: '引用した数値に根拠資料が紐付いていません。',
  metric_evidence_unknown:
    '根拠資料の紐付けが写しにありません（根拠資料を固定する前に作ったスナップショット）。',
};

export interface TraceUnit {
  /** 追跡番号（例: T-G-1、数値は T-MT-1-N1） */
  traceId: string;
  kind: TraceUnitKind;
  blockId: Uuid;
  blockTitle: string;
  sectionKey: string;
  frameworkVersionId: Uuid;
  paragraphId: string;
  /** 節の中の本文のある段落の通し番号（1 から） */
  paragraphNo: number;
  /** 出力と同じ文字列（段落は段落の本文、数値は表示文字列） */
  text: string;
  requirementCodes: string[];
  /** 承認版（節の版）の承認の記録 */
  approvedBy: Uuid | null;
  approvedAt: IsoDateTime | null;
  reviewRequestId: Uuid | null;
  /** 数値の単位のとき: 引用した Data Point の版 */
  dataPointVersionId: Uuid | null;
  traceable: boolean;
  reasons: TraceReasonCode[];
}

export interface TraceCount {
  traceable: number;
  total: number;
}

export interface TraceSummary {
  /** 段落＋数値 */
  all: TraceCount;
  paragraphs: TraceCount;
  numbers: TraceCount;
  /** 追跡率（0〜1）。単位が 0 件なら null（0% と出さない） */
  rate: number | null;
  /** 例: 「12 / 14（段落 8 / 9・数値 4 / 5）」 */
  label: string;
  /** 選定ケース（要求事項コード）で絞ったか */
  selectedCodes: string[] | null;
}

export interface TraceInput {
  blocks: readonly SnapshotBlock[];
  metricValues: readonly SnapshotMetricValue[];
  /**
   * 引用した定性情報の版のうち、根拠（引用位置）を持つもの。写しに定性情報の根拠は無いため、
   * 呼び出し側が追記専用の定性情報の版（固定した版 ID の行）から渡す
   */
  narrativeVersionsWithEvidence: ReadonlySet<Uuid>;
}

/** 節のキーの頭文字（例: governance→G、metrics_targets→MT、esrs40a_governance→EG） */
export function sectionShortCode(sectionKey: string): string {
  const parts = sectionKey
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase());
  return parts.join('') || 'S';
}

/** 節ごとの短縮コード（同じスナップショットで重なれば 2 つ目以降に番号を足す。節の並び順で決まる） */
export function blockShortCodes(blocks: readonly Pick<SnapshotBlock, 'blockId' | 'sectionKey'>[]) {
  const used = new Map<string, number>();
  const out = new Map<Uuid, string>();
  for (const block of blocks) {
    const base = sectionShortCode(block.sectionKey);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    out.set(block.blockId, count === 1 ? base : `${base}${count}`);
  }
  return out;
}

function bodyParagraphs(block: SnapshotBlock): Array<{ paragraph: BlockParagraph; no: number }> {
  const out: Array<{ paragraph: BlockParagraph; no: number }> = [];
  let no = 0;
  for (const paragraph of block.body.paragraphs) {
    if (paragraph.kind !== 'paragraph') continue;
    if (paragraphText(paragraph).trim().length === 0) continue;
    no += 1;
    out.push({ paragraph, no });
  }
  return out;
}

/**
 * スナップショットの写しからトレースの単位を作る。selectedCodes（選定ケース）を渡すと、その要求事項に
 * 対応する節の単位だけを数える（分母が変わる）。null・空は全件
 */
export function buildReportTrace(
  input: TraceInput,
  options: { selectedCodes?: readonly string[] | null; frameworkVersionId?: Uuid | null } = {},
): { units: TraceUnit[]; summary: TraceSummary } {
  const selected =
    options.selectedCodes && options.selectedCodes.length > 0
      ? new Set(options.selectedCodes)
      : null;
  const blocks = input.blocks.filter(
    (b) => !options.frameworkVersionId || b.frameworkVersionId === options.frameworkVersionId,
  );
  const shortCodes = blockShortCodes(input.blocks);
  const metricByVersion = new Map(input.metricValues.map((m) => [m.dataPointVersionId, m]));
  const units: TraceUnit[] = [];

  for (const block of blocks) {
    const codes = block.requirements.map((r) => r.code);
    if (selected && !codes.some((c) => selected.has(c))) continue;
    const shortCode = shortCodes.get(block.blockId) ?? sectionShortCode(block.sectionKey);
    const approval = block.approval ?? null;
    const isV2 = Object.hasOwn(block, 'approval');
    const handwritten = detectHandwrittenNumbers(block.body);

    for (const { paragraph, no } of bodyParagraphs(block)) {
      const traceBase = `T-${shortCode}-${no}`;
      const common = {
        blockId: block.blockId,
        blockTitle: block.title,
        sectionKey: block.sectionKey,
        frameworkVersionId: block.frameworkVersionId,
        paragraphId: paragraph.id,
        paragraphNo: no,
        requirementCodes: codes,
        approvedBy: approval?.approvedBy ?? null,
        approvedAt: approval?.approvedAt ?? null,
        reviewRequestId: approval?.reviewRequestId ?? null,
      };

      // 段落
      const reasons: TraceReasonCode[] = [];
      if (codes.length === 0) reasons.push('no_requirement');
      if (!block.isApprovedVersion) reasons.push('not_approved');
      else if (!approval) reasons.push('approval_unknown');
      const hasEvidence = paragraph.children.some(
        (inline) =>
          inline.t === 'cite' ||
          inline.t === 'metric' ||
          (inline.t === 'narrative' &&
            input.narrativeVersionsWithEvidence.has(inline.narrativeVersionId)),
      );
      if (!hasEvidence) reasons.push('no_evidence');
      units.push({
        ...common,
        traceId: traceBase,
        kind: 'paragraph',
        text: paragraphText(paragraph),
        dataPointVersionId: null,
        traceable: reasons.length === 0,
        reasons,
      });

      // 数値（参照 → 手書きの順。段落の中の出現順で番号を振る）
      let n = 0;
      for (const inline of paragraph.children) {
        if (inline.t !== 'metric') continue;
        n += 1;
        const mv = metricByVersion.get(inline.dataPointVersionId);
        const metricReasons: TraceReasonCode[] = [];
        if (!mv) metricReasons.push('metric_missing');
        else {
          if (!mv.versionApproved) metricReasons.push('metric_not_approved');
          if (mv.availabilityStatus !== 'value_present') metricReasons.push('metric_no_value');
          if (!Object.hasOwn(mv, 'evidenceFileVersionIds') || !isV2) {
            metricReasons.push('metric_evidence_unknown');
          } else if ((mv.evidenceFileVersionIds ?? []).length === 0) {
            metricReasons.push('metric_no_evidence');
          }
        }
        units.push({
          ...common,
          traceId: `${traceBase}-N${n}`,
          kind: 'number',
          text: inline.display,
          dataPointVersionId: inline.dataPointVersionId,
          traceable: metricReasons.length === 0,
          reasons: metricReasons,
        });
      }
      for (const number of handwritten.filter((h) => h.paragraphId === paragraph.id)) {
        n += 1;
        units.push({
          ...common,
          traceId: `${traceBase}-N${n}`,
          kind: 'number',
          text: number.text,
          dataPointVersionId: null,
          traceable: false,
          reasons: ['handwritten'],
        });
      }
    }
  }

  const count = (kind: TraceUnitKind | null): TraceCount => {
    const list = kind ? units.filter((u) => u.kind === kind) : units;
    return { traceable: list.filter((u) => u.traceable).length, total: list.length };
  };
  const all = count(null);
  const paragraphs = count('paragraph');
  const numbers = count('number');
  return {
    units,
    summary: {
      all,
      paragraphs,
      numbers,
      rate: all.total === 0 ? null : all.traceable / all.total,
      label: `${all.traceable} / ${all.total}（段落 ${paragraphs.traceable} / ${paragraphs.total}・数値 ${numbers.traceable} / ${numbers.total}）`,
      selectedCodes: selected ? [...selected] : null,
    },
  };
}

/** 追跡番号から単位を探す（出力物の文・数値・追跡番号からの検索に使う） */
export function findTraceUnits(units: readonly TraceUnit[], query: string): TraceUnit[] {
  const q = query.trim();
  if (q === '') return [];
  return units.filter((u) => u.traceId === q || u.text.includes(q));
}
