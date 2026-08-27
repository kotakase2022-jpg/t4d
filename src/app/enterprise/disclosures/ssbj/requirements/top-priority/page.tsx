import { redirect } from 'next/navigation';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';

/**
 * 最も優先度の高いギャップの詳細へ飛ばす。
 *
 * 一覧を目で追わずに「いま一番先に手を付けるべき要求事項」へ直行するための入口。
 * 対応状況画面とデモ案内から使う。
 *
 * `[itemId]` と同じ階層に置いているが、Next.js は静的セグメントを
 * 動的セグメントより優先するため、この URL が `[itemId]` に食われることはない。
 */
export default async function SsbjTopPriorityPage() {
  const shell = await loadEnterpriseShell();
  const loaded = await loadSsbjRequirementViews(shell.db, shell.ctx, shell.currentPeriod);

  const target = (loaded?.views ?? [])
    .filter(
      (v) =>
        v.assessment.applicability === 'applicable' &&
        v.assessment.materiality !== 'not_material' &&
        v.combined !== 'covered',
    )
    .sort((a, b) => b.priority.score - a.priority.score || a.item.sortOrder - b.item.sortOrder)[0];

  // 対応すべきギャップが無ければ一覧へ戻す（空の詳細画面を見せない）
  redirect(
    target
      ? `/enterprise/disclosures/ssbj/requirements/${target.item.id}`
      : '/enterprise/disclosures/ssbj/requirements',
  );
}
