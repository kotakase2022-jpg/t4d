import { formFailure, type FormActionState } from '@/lib/errors/form-action-state';

/**
 * 既存の Server Action（createMetricAction など。enterprise/actions.ts）を呼ぶ画面のフォームで、
 * 業務エラーを「入力を残したまま」示すための変換（plan §1.13-5・S10）。
 *
 * 既存の Action は業務エラーを withUserFacingError で `/enterprise/organizations?error=…` への
 * リダイレクトに載せる。そのまま送ると、専用ページ・作成パネルの入力が消え、別のタブへ飛ばされる。
 * Action は変えず（多くの画面が使うため Stage B の間は凍結）、ページ側の薄いアダプタが
 * そのリダイレクトを受け止めて理由を取り出し、PreservingForm の失敗の状態として返す。
 * 理由の無いリダイレクト（ログインへの移動など）・内部エラーは受け止めずに投げ直す。
 *
 * サーバーとテストの両方から使う純関数（'server-only' を付けない）。
 */

/** Next の redirect() が投げる例外の digest は `NEXT_REDIRECT;{type};{url};{status};` */
function redirectUrlOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return null;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT;')) return null;
  return digest.split(';').slice(2, -2).join(';');
}

/** withUserFacingError が載せた `?error=` の理由。業務エラーのリダイレクトでなければ null */
export function userFacingRedirectMessage(error: unknown): string | null {
  const url = redirectUrlOf(error);
  if (!url) return null;
  const query = url.split('?')[1];
  if (!query) return null;
  const message = new URLSearchParams(query.split('#')[0]).get('error');
  return message && message.trim() !== '' ? message : null;
}

/** 業務エラーのリダイレクトなら、理由と送った値を持った失敗の状態。それ以外は null（投げ直す） */
export function formFailureFromRedirect(
  error: unknown,
  formData: FormData,
): FormActionState | null {
  const message = userFacingRedirectMessage(error);
  return message === null ? null : formFailure(message, formData);
}

/**
 * 既存の Action を呼び、業務エラーなら失敗の状態を返す（成功なら null）。
 * 呼び出し側（ページの Server Action）が成功時の行き先へ redirect する
 */
export async function runKeepingInput(
  run: () => Promise<void>,
  formData: FormData,
): Promise<FormActionState | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const failure = formFailureFromRedirect(error, formData);
    if (failure) return failure;
    throw error;
  }
}
