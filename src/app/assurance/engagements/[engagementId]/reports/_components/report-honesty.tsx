import { FileCheck2 } from 'lucide-react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';

/**
 * 開示レポート（企業が共有した承認済みレポートの写し）の誠実さの注記（NF-20）。
 * 一覧と内容の両方で常に出す（折りたたまない）。社内承認は第三者保証ではなく、ファイルの作成は提出ではない
 */
export function SharedReportHonesty() {
  return (
    <Notice tone="info">
      <span className="flex flex-wrap items-center gap-1.5" data-shared-report-honesty="">
        <HonestyBadge kind="internal-approval" />
        <HonestyBadge kind="read-only" />
        <span>
          社内承認済み版（第三者保証ではありません）の写しです。ファイル作成は提出ではありません。
        </span>
      </span>
      <span className="mt-0.5 flex items-start gap-1 text-caption text-ink-muted">
        <FileCheck2 className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        写しは企業の共有の時点で固定され、変更されません。社内コメント・非公開資料の名前と引用文は含みません。企業が共有を取り下げると、この案件から見えなくなります。
      </span>
    </Notice>
  );
}
