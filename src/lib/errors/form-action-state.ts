/**
 * 入力を残したまま理由を示すフォーム（PreservingForm）と、その Server Action が受け渡す状態。
 *
 * これまでの Server Action は、利用者向けのエラーを `?error=` 付きのリダイレクトで返していた
 * （withUserFacingError）。リダイレクトで画面が組み直されると、フォームは表示時の値に戻り、
 * 選んだ判断・書いた根拠・選んだ計画などの入力が消えていた（自己監査 F2・F8）。
 * エラーのときはリダイレクトせず、この状態（理由と送った値）を返し、画面が入力を戻す。
 *
 * サーバーとクライアントの両方から使うため、'server-only' を付けない（型と純関数だけ）。
 */

export interface FormActionState {
  status: 'idle' | 'error';
  /** 利用者に見せる理由（エラーのとき） */
  message: string | null;
  /** 送った値（名前と値の組。同じ名前が複数あれば複数）。ファイルは含めない */
  values: Array<[string, string]> | null;
}

export const IDLE_FORM_STATE: FormActionState = { status: 'idle', message: null, values: null };

/** 送った値を、文字列の組として取り出す（ファイルは戻せないため含めない） */
export function formValuesOf(formData: FormData): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') values.push([name, value]);
  }
  return values;
}

/** 失敗の状態（理由と送った値） */
export function formFailure(message: string, formData: FormData): FormActionState {
  return { status: 'error', message, values: formValuesOf(formData) };
}
