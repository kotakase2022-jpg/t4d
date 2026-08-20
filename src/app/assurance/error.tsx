'use client';

import { ErrorState } from '@/components/shared/states';

export default function AssuranceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6">
      <ErrorState
        title="案件データを取得できませんでした"
        description={
          process.env.NODE_ENV === 'production'
            ? `識別子: ${error.digest ?? '(なし)'}`
            : error.message
        }
        onRetry={reset}
      />
    </div>
  );
}
