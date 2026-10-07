import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Collapsible } from '@/components/ui/collapsible';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import type { ConfirmSpec, MenuActionSpec } from '@/lib/ui/actions';
import { resetDisclosureDemoAction } from './actions';

/**
 * 開示デモのリセット（F103。plan §1.16 区分 1・S2）。
 *
 * 毎日開くホームの本文に破壊的な操作を置かない: 見出しの「その他」の末尾から確認ダイアログを開く
 * （Command Palette の「デモを初期状態に戻す」も ?confirm=reset-demo で同じダイアログを開く）。
 * 確認のチェックが指す「上記の範囲」は 1 行で常に見せ（ダイアログの本文）、戻す表・戻さない表の
 * 一覧だけを閉じる（docs/disclosure-first.md §10.4。リセットの確認とその範囲は閉じない）。
 * 範囲と Demo Mode の判定は Service（resetDisclosureDemoData）が改めて行う。
 */

export const DEMO_RESET_ID = 'reset-demo';

export const DEMO_RESET_SCOPE =
  '戻す範囲: 開示業務（プロジェクト・原稿・レビュー・定性情報・KPI 目標など）と CSRD の設定・評価・計画・草案。資料・SSBJ の評価・Scope3 の算定には触れず、数値データは下で選んだときだけ戻します。';

function DemoResetDetails() {
  return (
    <div className="space-y-2">
      <Collapsible variant="plain" summary="戻す範囲・戻さないものの一覧">
        <p className="text-ink-muted">
          開示プロジェクト・原稿・レビュー・定性情報・引用位置・スナップショット・出力記録・KPI
          目標と、CSRD
          の設定（報告範囲・評価方法）・ダブル・マテリアリティ評価（DMA）・要求事項の評価・対応計画・開示ドラフト・CSRD
          の計画から作った収集項目・CSRD の AI
          実行記録を、デモ開始時の状態へ戻します。デモ中に作った行は削除し、変更した行は元の値へ戻します。
          資料・SSBJ の評価・Scope3
          の算定・通知・監査ログ・開示優先モードの設定には触れません。数値データは、下で選んだときだけ戻します。
        </p>
      </Collapsible>
      <label className="flex items-start gap-1.5 text-small text-ink">
        <NativeCheckbox name="includeDataPoints" className="mt-0.5" />
        <span>
          数値データも初期値へ戻す（Data Point と版・承認の記録・承認の道筋・標準 CSV
          の取込。デモ中に取り込んだ値・訂正した値を消し、次のリハーサルを同じ数値から始める）
        </span>
      </label>
    </div>
  );
}

export const DEMO_RESET_CONFIRM: ConfirmSpec = {
  tier: 'irreversible',
  title: '開示デモを初期状態に戻しますか',
  scope: DEMO_RESET_SCOPE,
  consequences: ['デモ中に作った行は削除し、変更した行は元の値へ戻します（取り消せません）。'],
  extraFields: <DemoResetDetails />,
  acknowledge: {
    name: 'confirmScope',
    label: '上記の範囲だけを初期状態へ戻すことを確認しました',
  },
  confirmLabel: '開示デモを初期状態に戻す',
};

/** 見出しの「その他」の項目（Demo Mode かつ開示の編集権限があるときだけ出す。呼び出し側で判定） */
export function demoResetMenuItem(): MenuActionSpec {
  return {
    kind: 'confirm',
    id: DEMO_RESET_ID,
    label: '開示デモを初期状態に戻す',
    icon: <RotateCcw className="size-3.5" aria-hidden="true" />,
    action: resetDisclosureDemoAction,
    confirm: DEMO_RESET_CONFIRM,
    destructive: true,
    group: 'advanced',
  };
}

/** ダイアログだけを開いて描く（テスト・確認用） */
export function DemoResetConfirm({ open = true }: { open?: boolean }) {
  return <ConfirmDialog {...DEMO_RESET_CONFIRM} action={resetDisclosureDemoAction} open={open} />;
}
