import { AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * 操作の完了を伝える一行メッセージ。
 *
 * 完了後は `?flash=...` を付けてリダイレクトしているが、読み取る側が無いと
 * 「取込を確定した」「前年度から複製した」といった結果が画面に一切出ず、
 * 成功したのかどうか分からないまま一覧へ戻ることになる。
 *
 * 色だけで状態を表さない（ラベルとアイコンを併記する）。
 */
const MESSAGES: Record<string, (params: URLSearchParams) => string> = {
  imported: () => '取込内容を確定し、非財務データへ反映しました。',
  carried: (params) => {
    const count = params.get('count');
    return count ? `前年度から ${count} 件を複製しました。` : '前年度から複製しました。';
  },
};

export function FlashMessage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // 利用者向けのエラー（権限・入力の誤り）は ?error= に載って戻ってくる。
  // 本番ビルドでは例外メッセージが伏せられるため、この経路が唯一の伝達手段になる。
  const error = typeof searchParams.error === 'string' ? searchParams.error : null;
  if (error) {
    return (
      <p
        role="alert"
        className="mb-2 flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
      >
        <AlertTriangle className="size-3.5 text-danger" aria-hidden="true" />
        {error}
      </p>
    );
  }

  const flash = typeof searchParams.flash === 'string' ? searchParams.flash : null;
  if (!flash) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const build = MESSAGES[flash];
  if (!build) return null;

  return (
    <p
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-[12px] text-ink"
    >
      <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
      {build(params)}
    </p>
  );
}
