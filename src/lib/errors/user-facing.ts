import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import {
  newUserErrorToken,
  USER_ERROR_PARAM,
  USER_ERROR_TOKEN_COOKIE,
  USER_ERROR_TOKEN_MAX_AGE,
  USER_ERROR_TOKEN_PARAM,
} from './user-error-token';

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

/**
 * 入力の誤りなど、**利用者にそのまま見せてよい**エラー。
 *
 * 内部エラー（Error）と区別するために型を分ける。区別しないと、
 * 本番で内部メッセージを露出させるか、逆に必要な指摘まで隠すかの二択になる。
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** URL に載せるメッセージの上限。長い文面は画面側で扱いにくいので切る */
const MAX_MESSAGE_LENGTH = 160;

/** redirect() / notFound() は制御フロー用の例外なので、握らずそのまま投げ直す */
function isControlFlowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return false;
  const digest = String((error as { digest?: unknown }).digest ?? '');
  return digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND';
}

export function isUserFacingError(error: unknown): error is Error {
  return (
    error instanceof AuthorizationError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  );
}

/**
 * 利用者向けの理由を `?error=` に載せて元の画面へ戻す（Server Action の中だけで呼ぶ）。
 *
 * 文と一緒に使い捨ての合言葉を Cookie と URL（`et`）に置く。middleware は合言葉の合わない
 * `?error=` を外す（外から作ったリンクの文を、本物の画面の警告として出さない。./user-error-token.ts）。
 * `?error=` を手で組み立てず、必ずここを通す（通さないと middleware に外されて理由が出ない）。
 *
 * @param backTo 戻す画面のパス（アプリ内のパスのみ）
 */
export async function redirectWithUserError(backTo: string, message: string): Promise<never> {
  const token = newUserErrorToken();
  try {
    (await cookies()).set(USER_ERROR_TOKEN_COOKIE, token, {
      // ブラウザの URL に残る ?error= を、クライアントの GlobalErrorNotice も同じ合言葉で確かめるため
      // JavaScript から読める必要がある（秘密ではない。外のサイトから書けないことだけが要る）
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: USER_ERROR_TOKEN_MAX_AGE,
    });
  } catch {
    // リクエストの外（Server Action を直接呼ぶテスト）では Cookie を書けない。戻り先はそのまま返す
  }
  const separator = backTo.includes('?') ? '&' : '?';
  const text = encodeURIComponent(message.slice(0, MAX_MESSAGE_LENGTH));
  redirect(`${backTo}${separator}${USER_ERROR_PARAM}=${text}&${USER_ERROR_TOKEN_PARAM}=${token}`);
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
    if (error instanceof AuthorizationError) await reportAccessDenied(error, backTo);
    await redirectWithUserError(backTo, error.message);
  }
}

/**
 * 権限で断った操作を監査ログ access_denied に残す（トライアル対応 NF-27）。権限名とルートのパターンだけ。
 * セッション・DB は動的に読む（このモジュールは多くのサービスから読まれるため、静的に読むと循環する）。
 * リクエストの外（テスト）・記録の失敗では何もしない（利用者への応答は変えない）
 */
async function reportAccessDenied(error: AuthorizationError, backTo: string): Promise<void> {
  try {
    const [{ getSession }, { getDb }, { recordAccessDenied }] = await Promise.all([
      import('@/lib/auth/session'),
      import('@/lib/repositories'),
      import('./access-denied'),
    ]);
    const session = await getSession();
    await recordAccessDenied(await getDb(), session?.context ?? null, {
      permission: error.permission ?? null,
      route: backTo,
    });
  } catch {
    // 記録できなくても ?error= で戻す
  }
}
