'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openCommandPalette } from './command-palette';

/**
 * ヘッダーの「検索」（plan §0.3・§1.10）。Ctrl/Cmd+K を知らない利用者にも、画面・操作・データを
 * 探す入口が見えるようにする（熟練者のショートカットと同じパレットを開く）。
 */
export function PaletteTrigger() {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={openCommandPalette}
      aria-keyshortcuts="Control+K Meta+K"
      data-t4d-palette-trigger=""
      className="text-ink-muted"
    >
      <Search aria-hidden="true" />
      検索
      <kbd className="rounded border border-line bg-surface-muted px-1 text-caption text-ink-muted">
        Ctrl K
      </kbd>
    </Button>
  );
}
