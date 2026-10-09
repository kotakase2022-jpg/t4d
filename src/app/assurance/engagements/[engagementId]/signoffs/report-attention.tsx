import Link from 'next/link';
import { formatJst } from '@/lib/format/datetime';
import type { SignoffReportAttention } from '@/lib/services/assurance';

/**
 * Sign-off と共有レポートの注意の文（NF-23）。Sign-off の後に別の承認版が共有された、または結び付けた写しが
 * 取り下げられたことを、Sign-off の画面と案件の概要で同じ言葉で出す
 */
export function SignoffReportAttentionText({
  attention,
  labelOf,
  reportsHref,
}: {
  attention: SignoffReportAttention;
  labelOf: (copyId: string) => string;
  reportsHref: string;
}) {
  const linked = attention.signoff.sharedReportCopyId;
  return (
    <span className="block space-y-0.5" data-signoff-report-attention="">
      <span className="block">
        {formatJst(attention.signoff.createdAt)} の Sign-off は開示レポート
        {linked ? `「${labelOf(linked)}」` : ''}を対象にしています。
        {attention.newerCopies.length > 0 &&
          ` その後、別の承認版が ${attention.newerCopies.length} 件共有されました（${attention.newerCopies
            .map((c) => labelOf(c.id))
            .join('・')}）。`}
        {attention.linkedWithdrawn && ' 対象の写しは企業が共有を取り下げました。'}
      </span>
      <span className="block text-caption text-ink-muted">
        新しい承認版の内容を確かめ、必要なら Sign-off を記録し直してください（記録済みの Sign-off
        は変わりません）。
        <Link href={reportsHref} className="ml-1 text-brand-700 hover:underline">
          開示レポートを開く
        </Link>
      </span>
    </span>
  );
}
