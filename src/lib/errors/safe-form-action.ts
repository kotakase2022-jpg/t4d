import { unstable_rethrow } from 'next/navigation';

/**
 * 通信そのものが失敗したとき（オフライン・接続の切断など、サーバーに届かない）の説明。
 * 入力は画面に残る
 */
export const NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした。入力内容は画面に残っています。通信を確認して再試行してください。';

/**
 * サーバーには届いたが、処理が失敗したとき（サーバー側の例外・大きすぎる要求の拒否など）の説明。
 * 「通信を確認して」と言うと、利用者は原因の無い通信を疑い、同じ操作を繰り返して同じ失敗を重ねる
 */
export const SERVER_ERROR_MESSAGE =
  '処理に失敗しました（サーバー側のエラー）。入力内容は画面に残っています。時間をおいて再試行し、続く場合は管理者へ連絡してください。';

/**
 * 呼び出しの失敗が通信そのものの失敗か。fetch は通信の失敗を TypeError で返す（Failed to fetch 等）。
 * オフラインと分かっているときも通信の失敗とする。それ以外（サーバーが返したエラー）は処理の失敗
 */
export function isTransportFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return error instanceof TypeError;
}

/** 失敗の説明（通信の失敗とサーバーの失敗で文言を分ける） */
export function failureMessageOf(error: unknown): string {
  return isTransportFailure(error) ? NETWORK_ERROR_MESSAGE : SERVER_ERROR_MESSAGE;
}

/**
 * useActionState へ渡す Server Action を、呼び出しの失敗で壊れないように包む（クライアント用）。
 *
 * Server Action はサーバー側の例外を捕まえて状態として返すが、通信そのものが失敗したり、
 * サーバーが例外を投げ直したりすると、クライアントの呼び出しが reject する。React 19 の
 * useActionState は reject された状態を描画時に投げ直すため、最寄りのエラー境界
 * （enterprise/error.tsx）が画面を置き換え、手で写した抜粋・再確認の理由などの入力が消えていた。
 * reject を捕まえて、入力値を持った失敗の状態として返す。説明は失敗の種類ごとに変える
 * （サーバーのエラーを「通信を確認して」と言わない）。Next のリダイレクト（成功時の遷移）・notFound は投げ直す。
 */
export function withNetworkFallback<S>(
  action: (previous: S, formData: FormData) => Promise<S>,
  onFailure: (previous: S, formData: FormData, message: string) => S,
): (previous: S, formData: FormData) => Promise<S> {
  return async (previous, formData) => {
    try {
      return await action(previous, formData);
    } catch (error) {
      unstable_rethrow(error);
      return onFailure(previous, formData, failureMessageOf(error));
    }
  };
}
