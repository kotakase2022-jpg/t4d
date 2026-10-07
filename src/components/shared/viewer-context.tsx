'use client';

import * as React from 'react';
import type { HomeProfile } from '@/lib/ui/home-profile';
import type { TaskVerbContext } from '@/lib/ui/task-verbs';
import type { PermissionKey } from '@/types/domain';
import type { NavVariant } from './nav-config';

/**
 * AppShell がクライアントの部品（サイドバー・パレット・パンくず・最近使った画面・一覧の保存ビュー）
 * へ配る文脈（plan §1.9 ViewerContext・NavContext）。
 *
 * viewerKey は `${userId}:${organizationId}`。端末に保存する利便（最近使った画面・保存ビュー・
 * ナビの開閉）を利用者とワークスペースごとに分ける: デモの役割切替で利用者が替わっても混ざらない。
 */
export interface ShellContextValue {
  viewerKey: string;
  variant: NavVariant;
  workspace: 'enterprise' | 'assurance';
  /** 権限で隠すメニュー項目の href（従来の仕組み。Command Palette も使う） */
  hiddenHrefs: string[];
  /** 権限で隠すメニュー項目の権限キー（案件の画面のように URL に ID を含む項目も隠せる） */
  hiddenPermissions: PermissionKey[];
  /** 利用者が持つ権限（パレットの候補を権限で絞る。サーバー側の検査はそのまま） */
  permissions: PermissionKey[];
  /** 企業のみ: 役割ごとの初期表示 */
  profile?: HomeProfile;
  /** 役割で既定を閉じるメニューのグループ */
  defaultCollapsedGroups: string[];
  /** タスク動詞の文脈（担当範囲・Demo Mode） */
  verbContext: TaskVerbContext;
  /** ワークスペースのホーム（パンくずの先頭・g h） */
  homeHref: string;
  /** 監査法人で案件を選んでいるとき（ヘッダーの案件） */
  engagementId?: string | null;
}

const ShellContext = React.createContext<ShellContextValue | null>(null);

export function ShellProvider({
  value,
  children,
}: {
  value: ShellContextValue;
  children: React.ReactNode;
}) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** AppShell の外（単体テスト・認証画面）では null */
export function useShell(): ShellContextValue | null {
  return React.useContext(ShellContext);
}

/** 端末の保存に使う利用者の鍵。AppShell の外では 'anonymous' */
export function useViewerKey(): string {
  return useShell()?.viewerKey ?? 'anonymous';
}

/** 利用者が権限を持つか（AppShell の外では常に false。表示の出し分けだけに使い、検査はサーバーで行う） */
export function useCan(): (permission: PermissionKey) => boolean {
  const shell = useShell();
  return React.useCallback(
    (permission: PermissionKey) => shell?.permissions.includes(permission) ?? false,
    [shell],
  );
}
