import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * 文字サイズのトークン（globals.css の --text-*）を tailwind-merge に教える。
 * 教えないと `text-caption` を文字色のクラスとみなし、`cn('text-caption', 'text-ink')` で
 * 文字サイズが消える（置き換え前の任意値の文字サイズは、長さとして文字サイズに分類されていた）。
 * 置き換え（scripts/codemod-tokens.mjs）の前後で cn の結果を同じにするため。
 */
export const FONT_SIZE_TOKENS = [
  'caption',
  'small',
  'body',
  'title-sm',
  'title',
  'title-lg',
  'figure-sm',
  'figure',
  'figure-lg',
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZE_TOKENS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
