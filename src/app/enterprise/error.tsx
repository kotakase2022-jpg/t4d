'use client';

import { ErrorState } from '@/components/shared/states';

export default function EnterpriseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const forbidden = error.message.includes('権限');
  return (
    <div className="p-6">
      <ErrorState
        title={forbidden ? 'この操作を行う権限がありません' : 'データを取得できませんでした'}
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
