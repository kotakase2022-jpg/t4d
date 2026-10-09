import 'server-only';

import { diffParagraphs, type ParagraphDiff } from '@/lib/domain/disclosure-block';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, DisclosureBlockVersion, Uuid } from '@/types/domain';

/**
 * 再承認のレビューで見せる差分の比較元（トライアル対応 NF-17。FA-13）。
 *
 * 承認後に直した節を再承認するとき、審査で知りたいのは「前回承認した内容から何が変わったか」。
 * 直前の版（下書きの途中の版）との差分だけでは、承認後に積み重ねた変更の全体が見えない。
 *  - 既定: 前回承認した版（block.approvedVersionId）。承認済みの版が無い・審査中の版そのものなら直前の版
 *  - 「直前の版と比べる」（?diff=previous）で、審査中の版の土台の版に切り替えられる
 * 読むだけ（書き込まない）。別の組織の版は比較元にしない。
 */

export type ReviewDiffMode = 'approved' | 'previous';

export interface ReviewDiffResult {
  mode: ReviewDiffMode;
  /** 比較元の版の番号（比較元が無ければ null＝最初の版） */
  baseVersionNo: number | null;
  /** 表示の名前（例: 前回承認した版（版 2）） */
  baseLabel: string;
  diff: ParagraphDiff[];
  /** 「前回承認した版」と「直前の版」の両方があり、切り替える意味がある */
  canSwitch: boolean;
}

export function parseReviewDiffMode(value: unknown): ReviewDiffMode | null {
  return value === 'previous' || value === 'approved' ? value : null;
}

export async function loadReviewDiff(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    target: DisclosureBlockVersion;
    approvedVersionId: Uuid | null;
    requested: ReviewDiffMode | null;
  },
): Promise<ReviewDiffResult> {
  const organizationId = ctx.workspace.organizationId;
  const own = (version: DisclosureBlockVersion | null) =>
    version && version.organizationId === organizationId && version.blockId === input.target.blockId
      ? version
      : null;
  const approved =
    input.approvedVersionId && input.approvedVersionId !== input.target.id
      ? own(await db.findById('disclosureBlockVersions', input.approvedVersionId))
      : null;
  const previous = input.target.baseVersionId
    ? own(await db.findById('disclosureBlockVersions', input.target.baseVersionId))
    : null;
  const canSwitch = approved !== null && approved.id !== previous?.id;
  const mode: ReviewDiffMode =
    approved !== null && input.requested !== 'previous' ? 'approved' : 'previous';
  const base = mode === 'approved' ? approved : previous;
  const baseLabel =
    mode === 'approved'
      ? `前回承認した版（版 ${approved!.versionNo}）`
      : previous
        ? `直前の版（版 ${previous.versionNo}）`
        : '前の版（なし。最初の版）';
  return {
    mode,
    baseVersionNo: base?.versionNo ?? null,
    baseLabel,
    diff: diffParagraphs(base?.body ?? null, input.target.body),
    canSwitch,
  };
}
