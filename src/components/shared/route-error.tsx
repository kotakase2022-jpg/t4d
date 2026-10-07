'use client';

import { useEffect } from 'react';
import { ErrorState } from './states';

/**
 * 想定外のエラーの画面（error.tsx が使う。plan §1.18）。何が・なぜ・どうするを書く。
 *
 * 利用者に見せてよいエラー（権限・入力の誤り・対象なし）は Server Action が `?error=` で元の画面へ
 * 戻す（withUserFacingError）。ここに来るのはそれ以外で、本番では例外の文が伏せられ digest しか届かない。
 * そのため「権限」の語で分岐しない（本番では効かない）。開発時だけ例外の文を出す。
 */
export function RouteError({
  error,
  reset,
  homeHref,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref?: string;
}) {
  useEffect(() => {
    // 詳細（Secret / SQL / Stack）は画面に出さない。サーバー側のログに digest が残る
    console.error('[t4d] unhandled error', error.digest ?? error.message);
  }, [error]);

  const production = process.env.NODE_ENV === 'production';
  return (
    <ErrorState
      what="処理を完了できませんでした"
      why={
        production
          ? 'サーバーで予期しないエラーが発生しました（入力の誤りによるものではありません）。'
          : error.message
      }
      how="もう一度お試しください。続く場合は、下の識別子を添えて管理者へ連絡してください。"
      digest={error.digest ?? '（なし）'}
      onRetry={reset}
      homeHref={homeHref}
    />
  );
}
