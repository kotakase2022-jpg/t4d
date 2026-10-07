'use client';

import * as React from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * ヘルプ（plan §1.11 Beginner／Expert）。ショートカットの一覧と用語集。
 * `?` でも開ける（入力中・他のダイアログを開いている間は無効）。
 */

export const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: 'Ctrl / Cmd + K', description: 'コマンドパレット（画面・操作・データの検索）を開く' },
  { keys: '?', description: 'このヘルプを開く' },
  { keys: '/', description: '一覧の検索ボックスへフォーカス' },
  { keys: 'g → h', description: 'ホームへ移動' },
  { keys: 'g → d', description: '非財務データへ移動' },
  { keys: 'g → w', description: 'ワークフローへ移動' },
  { keys: 'g → i', description: 'データ取込へ移動' },
  { keys: 'g → s', description: 'SSBJ 対応状況へ移動' },
  { keys: 'g → c', description: 'CSRD 対応状況へ移動' },
  { keys: 'j / k', description: '一覧の次 / 前のレコードへ移動' },
  { keys: 'x', description: '一覧で選んでいる行の選択を切り替える（一括操作）' },
  { keys: 'Enter', description: '一覧で選んでいる行を開く' },
  { keys: 'n', description: 'その画面の新規作成を開く' },
  { keys: 'e', description: 'Evidence セクションへ移動' },
  { keys: 'c', description: 'コメント入力へフォーカス' },
  { keys: 's', description: '下書きを保存（提出・承認には割り当てていません）' },
  { keys: 'Esc', description: 'Drawer / ダイアログを閉じる' },
];

/**
 * 用語集（CLAUDE.md §8 の用語を業務の言葉で）。画面に出る英語の用語（Data Room・Snapshot・
 * PBC・Sign-off）は、意味を知らなくても読めるようにここで説明する
 */
export const GLOSSARY: Array<{ term: string; meaning: string }> = [
  {
    term: 'Data Point（データ）',
    meaning:
      '組織 × 期間 × 指標 × 境界で 1 件に決まる非財務データ。入力 → 提出 → レビュー → 承認と進みます。',
  },
  {
    term: '保証契約（Engagement）・案件',
    meaning: '監査法人が持つ保証の契約。クライアント企業と紐付きます。',
  },
  {
    term: 'アクセス許諾（Grant）',
    meaning: '企業が監査法人へ与える閲覧の許可（指標・組織・期間・資料の範囲）。',
  },
  {
    term: 'Data Room',
    meaning:
      '許諾済みで承認済みのクライアントデータを、監査法人が読むだけの画面。原本は変更できません。',
  },
  {
    term: 'Snapshot',
    meaning: '保証の対象を固定した変更できないコピー。以後の変更は差分として検知されます。',
  },
  { term: '母集団（Population）', meaning: 'Snapshot から作る、サンプリングの元になる集合。' },
  {
    term: '資料依頼（PBC）',
    meaning: 'Prepared By Client。監査法人から企業への資料の依頼です。企業は回答を提出します。',
  },
  {
    term: 'Sign-off',
    meaning:
      '作成（Prepared）→ レビュー（Reviewed）→ 契約責任者承認（Partner Approved）の 3 段階。代理はできません。',
  },
  {
    term: 'AI の候補',
    meaning: 'AI の出力は候補です。採用・確定・承認は必ず人が行います。',
  },
  {
    term: 'デモデータ・デモ生成（Mock）',
    meaning:
      'デモ環境の表示は架空のデータです。AI 未接続のときは決定論的な Mock の出力を出します。',
  },
];

export function HelpDialog() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;
      if (typing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ヘルプとキーボードショートカット"
          aria-keyshortcuts="Shift+?"
        >
          <HelpCircle aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>ヘルプ</DialogTitle>
          <DialogDescription>
            キーボードショートカットと用語の説明です。ショートカットは入力欄にフォーカスがある間は無効になります。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="shortcuts" className="p-4 pt-2">
          <TabsList>
            <TabsTrigger value="shortcuts">キーボードショートカット</TabsTrigger>
            <TabsTrigger value="glossary">用語集</TabsTrigger>
          </TabsList>
          <TabsContent value="shortcuts">
            <dl className="divide-y divide-line">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between gap-4 py-1.5">
                  <dt className="text-body text-ink">{s.description}</dt>
                  <dd>
                    <kbd className="rounded border border-line bg-surface-muted px-1.5 py-0.5 text-caption text-ink-muted">
                      {s.keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </TabsContent>
          <TabsContent value="glossary">
            <dl className="divide-y divide-line">
              {GLOSSARY.map((g) => (
                <div key={g.term} className="py-1.5">
                  <dt className="text-body font-medium text-ink">{g.term}</dt>
                  <dd className="text-small text-ink-muted">{g.meaning}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
