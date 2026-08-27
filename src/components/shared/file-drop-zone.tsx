'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ファイルのドロップ受け口。
 *
 * 落とされたファイルは、中にある `<input type="file">` へそのまま移す。
 * こうするとフォームの送信経路（Server Action）は今までと同じで済み、
 * クリックで選ぶ人の動きも変わらない。
 *
 * ドロップしたのに画面が何も変わらないと、受け付けられたのか分からない。
 * 呼び出し側が「受け取った」ことを画面に出せるよう `onFilesDropped` を渡す。
 */
export function FileDropZone({
  inputId,
  className,
  children,
  onFilesDropped,
}: {
  /** 受け取り先の file input の id */
  inputId: string;
  className?: string;
  children: React.ReactNode;
  /** ドロップされたファイルを input へ移したあとに呼ばれる */
  onFilesDropped?: (files: FileList) => void;
}) {
  const [dragging, setDragging] = React.useState(false);
  /**
   * dragenter / dragleave は**子要素をまたぐたびに発火する**。
   * 単純に dragleave で false にすると、枠の中を動かしただけで強調が消える。
   * 出入りの回数を数えて、本当に外へ出たときだけ解除する。
   */
  const depth = React.useRef(0);

  const assign = (files: FileList) => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input || files.length === 0) return;
    // DataTransfer 経由でしか input.files は差し替えられない
    const transfer = new DataTransfer();
    for (const file of Array.from(files)) transfer.items.add(file);
    input.files = transfer.files;
    // 選択状態の表示（件数など）を更新させる
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onFilesDropped?.(input.files);
  };

  return (
    <label
      htmlFor={inputId}
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        // これを止めないとブラウザがファイルを開こうとしてドロップを受け付けない
        event.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
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
