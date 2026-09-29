import type { DiffSegment } from '@/lib/domain/disclosure-block';

/**
 * 文字単位の差分の表示。追加・削除は色だけでなく下線・取り消し線と読み上げ用の文言でも示す。
 */
export function DiffText({ segments }: { segments: readonly DiffSegment[] }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((segment, index) => {
        if (segment.op === 'equal') return <span key={index}>{segment.text}</span>;
        if (segment.op === 'insert') {
          return (
            <ins
              key={index}
              className="rounded-sm bg-success-soft text-ink underline decoration-success"
            >
              <span className="sr-only">（追加）</span>
              {segment.text}
            </ins>
          );
        }
        return (
          <del
            key={index}
            className="rounded-sm bg-danger-soft text-ink-muted line-through decoration-danger"
          >
            <span className="sr-only">（削除）</span>
            {segment.text}
          </del>
        );
      })}
    </span>
  );
}
