import 'server-only';

import { redirect } from 'next/navigation';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';

/**
 * 利用者に見せてよいエラーを、画面へ届ける。
 *
 * Next.js は本番ビルドで Server Component / Server Action の例外メッセージを
 * 伏せる（error.tsx には digest しか届かない）。内部情報の漏洩を防ぐ既定として
 * 正しいが、そのままだと「数値を入力してください」のような**利用者に必要な指摘**まで
 * 「識別子: 1786379458」に化けてしまい、何を直せばよいか分からなくなる。
 *
 * そこで、利用者起因と分かっているエラー（権限・入力の誤り・対象なし）だけを
 * 元の画面へのリダイレクトに載せ替える。内部エラーはこれまでどおり
 * error.tsx へ投げて digest だけを見せる。
 */

/** URL に載せるメッセージの上限。長い文面は画面側で扱いにくいので切る */
const MAX_MESSAGE_LENGTH = 160;

/** redirect() / notFound() は制御フロー用の例外なので、握らずそのまま投げ直す */
function isControlFlowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return false;
  const digest = String((error as { digest?: unknown }).digest ?? '');
  return digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND';
}

export function isUserFacingError(error: unknown): error is Error {
  return error instanceof AuthorizationError || error instanceof NotFoundError;
}

/**
 * Server Action を包み、利用者向けエラーを `?error=` として戻す。
 *
 * @param backTo エラー時に戻す画面のパス（アプリ内のパスのみ）
 */
export async function withUserFacingError(backTo: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isControlFlowError(error) || !isUserFacingError(error)) throw error;
    const message = error.message.slice(0, MAX_MESSAGE_LENGTH);
    const separator = backTo.includes('?') ? '&' : '?';
    redirect(`${backTo}${separator}error=${encodeURIComponent(message)}`);
  }
}
