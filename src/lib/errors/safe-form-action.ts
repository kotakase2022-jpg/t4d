import { unstable_rethrow } from 'next/navigation';

/**
 * 通信そのものが失敗したとき（オフライン・プロキシの 502 など、サーバーに届かない）の説明。
 * 入力は画面に残る
 */
export const NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした。入力内容は画面に残っています。通信を確認して再試行してください。';

/**
 * useActionState へ渡す Server Action を、通信の失敗で壊れないように包む（クライアント用）。
 *
 * Server Action はサーバー側の例外を捕まえて状態として返すが、通信そのものが失敗すると
 * クライアントの呼び出しが reject する。React 19 の useActionState は reject された状態を
 * 描画時に投げ直すため、最寄りのエラー境界（enterprise/error.tsx）が画面を置き換え、
 * 手で写した抜粋・再確認の理由などの入力が消えていた。reject を捕まえて、入力値を持った
 * 失敗の状態として返す。Next のリダイレクト（成功時の遷移）・notFound は投げ直す。
 */
export function withNetworkFallback<S>(
  action: (previous: S, formData: FormData) => Promise<S>,
  onNetworkError: (previous: S, formData: FormData) => S,
): (previous: S, formData: FormData) => Promise<S> {
  return async (previous, formData) => {
    try {
      return await action(previous, formData);
    } catch (error) {
      unstable_rethrow(error);
      return onNetworkError(previous, formData);
    }
  };
}
