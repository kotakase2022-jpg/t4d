import 'server-only';

import { unstable_rethrow } from 'next/navigation';
import { formFailure, type FormActionState } from './form-action-state';
import { isUserFacingError } from './user-facing';

/**
 * PreservingForm の Server Action の本体を包む。利用者向けのエラー（権限・入力の誤り・対象なし・
 * 別の操作による更新）は、リダイレクトせずに理由と送った値を返す（画面は入力を残して理由を示す）。
 * 成功したら null を返すので、呼び出し側が再検証してリダイレクトする（redirect は try の外で呼ぶ）。
 * 内部エラーは投げ直す（画面は「処理に失敗しました」と示し、入力は残る。withNetworkFallback）
 */
export async function runPreservingAction(
  formData: FormData,
  run: () => Promise<void>,
): Promise<FormActionState | null> {
  try {
    await run();
    return null;
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は Next.js へ返す
    unstable_rethrow(error);
    if (isUserFacingError(error)) return formFailure(error.message, formData);
    throw error;
  }
}
