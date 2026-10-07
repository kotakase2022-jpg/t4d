'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/shared/section';
import { PanelSkeleton } from '@/components/shared/states';
import { loadPreview } from '../preview-store';
import { ImportPreviewTable, type PreviewOption } from '../preview-table';
import type { ImportPreviewPayload } from '../preview-types';

/**
 * サーバーに取込ジョブが無いときの受け皿。
 *
 * Demo Mode ではジョブがそのインスタンスのメモリにしか無いため、
 * 別インスタンスへ振り分けられると 404 相当になる。
 * 投入したブラウザ自身は内容を持っているので、そこから同じ画面を描く。
 *
 * 持っていない場合（別のブラウザ・タブを閉じた後）は、理由を説明する。
 */
export function ImportPreviewFallback({
  jobId,
  metrics,
  units,
}: {
  jobId: string;
  metrics: PreviewOption[];
  units: PreviewOption[];
}) {
  const [payload, setPayload] = React.useState<ImportPreviewPayload | null | undefined>(undefined);

  React.useEffect(() => {
    setPayload(loadPreview(jobId));
  }, [jobId]);

  if (payload === undefined) {
    // 読み込み中は固定の高さの骨組み（読み込み後に画面がずれない。plan §1.18）
    return <PanelSkeleton lines={4} label="取込内容を読み込んでいます" />;
  }

  if (!payload) {
    return (
      <div className="rounded-t4d-lg border border-line bg-surface p-4">
        <p className="text-body text-ink">
          この取込内容は、投入したブラウザのタブでのみ参照できます。
        </p>
        <p className="mt-2 text-small text-ink-muted">
          デモ環境（Demo Mode）は取込結果をサーバーへ保存しません。
          別のブラウザやタブから開いた場合、または投入したタブを閉じた場合は表示できません。
          お手数ですが、もう一度「データ取込」から取り込んでください。
        </p>
        <p className="mt-2 text-small text-ink-muted">
          実 Supabase へ接続した環境ではこの制限はありません。
        </p>
        <div className="mt-3">
          <Button size="sm" variant="secondary" asChild>
            <Link href="/enterprise/imports">データ取込へ戻る</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Section
        title={`取込プレビュー（${payload.rows.length} 行 / ${payload.fileNames.length} ファイル）`}
        summary="このタブが保持している取込内容です（Demo Mode）"
      >
        <ImportPreviewTable
          jobId={payload.jobId}
          reportingPeriodId={payload.reportingPeriodId}
          rows={payload.rows}
          metrics={metrics}
          units={units}
        />
      </Section>

      {payload.failedFiles.length > 0 && (
        <Section title={`解析できなかったファイル（${payload.failedFiles.length}）`}>
          <ul className="divide-y divide-line">
            {payload.failedFiles.map((file) => (
              <li key={file.name} className="py-1.5">
                <span className="text-body text-ink">{file.name}</span>
                <span className="ml-2 text-small text-ink-muted">{file.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
