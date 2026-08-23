'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ファイルのドロップ受け口。
 *
 * 画面が「ここへドロップしてください」と案内していたのに、
 * 実際にはドラッグ&ドロップを受け付けていなかった。案内と挙動を合わせる。
 *
 * 落とされたファイルは、中にある `<input type="file">` へそのまま移す。
 * こうするとフォームの送信経路（Server Action）は今までと同じで済み、
 * クリックで選ぶ人の動きも変わらない。
 */
export function FileDropZone({
  inputId,
  className,
  children,
}: {
  /** 受け取り先の file input の id */
  inputId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = React.useState(false);

  const assign = (files: FileList) => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input || files.length === 0) return;
    // DataTransfer 経由でしか input.files は差し替えられない
    const transfer = new DataTransfer();
    for (const file of Array.from(files)) transfer.items.add(file);
    input.files = transfer.files;
    // 選択状態の表示（件数など）を更新させる
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  return (
    <label
      htmlFor={inputId}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        assign(event.dataTransfer.files);
      }}
      data-dragging={dragging ? 'true' : undefined}
      className={cn(
        className,
        // 色だけでなく枠線の濃さでも状態が分かるようにする
        dragging && 'border-brand-600 bg-brand-50',
      )}
    >
      {children}
    </label>
  );
}
