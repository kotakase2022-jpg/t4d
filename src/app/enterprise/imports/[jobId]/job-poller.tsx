'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

/**
 * 取込ジョブの進捗ポーリング（指示書 13 章 7. Realtime または Polling）。
 *
 * `GET /api/jobs/[jobId]` はワーカーとしても動作し、queued のジョブを処理する。
 * これにより Upload リクエスト自体はブロックされない。
 * Realtime へ差し替える場合の接続点は本コンポーネントに閉じている。
 */
export function JobPoller({
  jobId,
  initialStatus,
  initialProgress,
}: {
  jobId: string;
  initialStatus: string;
  initialProgress: number;
}) {
  const router = useRouter();
  const [status, setStatus] = React.useState(initialStatus);
  const [progress, setProgress] = React.useState(initialProgress);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (status !== 'queued' && status !== 'processing') return;

    let cancelled = false;
    let attempt = 0;

    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data = (await response.json()) as { status: string; progressPercent: number };
        if (cancelled) return;
        setStatus(data.status);
        setProgress(data.progressPercent);
        if (data.status !== 'queued' && data.status !== 'processing') {
          router.refresh();
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '進捗の取得に失敗しました');
      }
      attempt += 1;
      // 指数バックオフ（最大 8 秒）
      const delay = Math.min(8000, 800 * 2 ** Math.min(attempt, 4));
      timer = window.setTimeout(tick, delay);
    };

    let timer = window.setTimeout(tick, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, status, router]);

  const running = status === 'queued' || status === 'processing';

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[12px] text-ink-muted">
        {running && <Loader2 className="size-3.5 animate-spin text-brand-600" aria-hidden="true" />}
        <span>
          {running ? '解析中です。この画面のまま少しお待ちください。' : '解析が完了しました。'}
        </span>
        <span className="tnum ml-auto">{progress}%</span>
      </div>
      <Progress value={progress} label="取込ジョブの進捗" tone={running ? 'brand' : 'success'} />
      {error && <p className="text-[11px] text-danger">進捗取得エラー: {error}（再試行します）</p>}
    </div>
  );
}
