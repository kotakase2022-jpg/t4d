'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/shared/states';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Production では詳細（Secret / SQL / Stack）を表示しない。
    // サーバー側ログにのみ digest が残る。
    console.error('[t4d] unhandled error', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <ErrorState
        title="画面の表示中にエラーが発生しました"
        description={
          process.env.NODE_ENV === 'production'
            ? `管理者へ連絡する際は次の識別子をお伝えください: ${error.digest ?? '(なし)'}`
            : error.message
        }
        onRetry={reset}
      />
    </div>
  );
}
