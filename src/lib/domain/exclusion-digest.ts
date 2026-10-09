import { createHash } from 'node:crypto';
import type { ExclusionDecision } from '@/types/domain';

/**
 * 対象外・非重要の理由のダイジェスト（トライアル対応 NF-02）。DB の t4d.exclusion_reason_digest と同じ規則
 * （区分 || 改行 || 理由 を UTF-8 で sha256、16 進）。理由・区分を変えると別の値になり、承認は無効になる。
 *
 * node:crypto を使うため、クライアントの部品からも読む domain/requirement-coverage.ts とは分けている。
 */
export function exclusionReasonDigest(decision: ExclusionDecision, reason: string): string {
  return createHash('sha256').update(`${decision}\n${reason}`, 'utf8').digest('hex');
}
