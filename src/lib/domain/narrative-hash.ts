/**
 * 定性情報の版の内容ハッシュ（narrative_versions.content_hash）。
 *
 * Service（narrative.ts）と Demo Mode の Cookie の再適用（demo-compact.ts）が同じ規則を使う。
 * Cookie ではハッシュを持ち回さず、戻すときに本文から計算し直す（偽の Cookie で本文と
 * 食い違うハッシュを名乗らせない。持ち回す量も減る）。Fixture と同じ正規化で、同じ内容なら同じ値。
 */

import { canonicalJson } from '@/lib/domain/disclosure-block';
import { contentHash } from '@/lib/fixtures/ids';
import type { Uuid } from '@/types/domain';

export function narrativeContentHash(v: {
  reportingPeriodId: Uuid;
  scopeNote: string;
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: Uuid[];
}): string {
  return contentHash(
    canonicalJson({
      reportingPeriodId: v.reportingPeriodId,
      scopeNote: v.scopeNote,
      fields: v.fields,
      body: v.body,
      sourceAnchorIds: v.sourceAnchorIds,
    }),
  );
}
