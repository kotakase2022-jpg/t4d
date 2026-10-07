import type { DangerousOp } from './types';

/** Stage B1（データ・取込・資料・業務キュー・ホーム） */
export const B1_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F019',
    label: '一括提出・レビューへ・差戻し・一括承認',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#bulkTransitionAction',
    origins: ['src/app/enterprise/data/_components/data-bulk-bar.tsx'],
    status: 'done',
    note:
      '共通の BulkActionBar（行を選んだときだけ）。承認・差戻しは件数と内訳の確認（BulkActionSpec.confirm）。' +
      '一括承認はデータの承認の権限のときだけ（R4）。一括の差戻しは bulkTransitionAction が理由を保存しないため、' +
      '理由欄は付けず、確認の本文で単票の差戻しへ案内する（handoff B1）',
  },
  {
    id: 'F016',
    label: '前年度から複製',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#carryForwardAction',
    origins: ['src/app/enterprise/data/page.tsx'],
    status: 'done',
    note: '「その他」の「前年度から複製…」。範囲（当期の未入力の組み合わせ・前年度の値・入力中で作る）を確認してから実行',
  },
  {
    id: 'F017',
    label: '単票の差戻し（理由必須）',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#transitionDataPointAction',
    origins: ['src/app/enterprise/data/[dataPointId]/page.tsx'],
    status: 'done',
    note: '見出しの「差戻し…」と承認フローの段階の「差し戻す…」はどちらも理由必須の確認ダイアログ',
  },
  {
    id: 'F103',
    label: '開示デモを初期状態に戻す',
    tier: 'irreversible',
    action: 'src/app/enterprise/dashboard/actions.ts#resetDisclosureDemoAction',
    origins: ['src/app/enterprise/dashboard/demo-reset.tsx'],
    status: 'done',
    note: 'Stage A がホームの「その他」＋確認ダイアログ（必須チェック）へ移した',
  },
];
