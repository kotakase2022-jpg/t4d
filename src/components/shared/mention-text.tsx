/**
 * コメント本文の `@メンション` を強調表示する（Server Component）。
 * 色だけに頼らず、フォントウェイトと背景で区別する。
 */
export function MentionText({ body }: { body: string }) {
  const parts = body.split(/(@[^\s@,、。]+)/g);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <mark key={i} className="rounded bg-brand-100 px-0.5 font-medium text-brand-900">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}
