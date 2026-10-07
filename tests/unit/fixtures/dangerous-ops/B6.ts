import type { DangerousOp } from './types';

/** Stage B6（監査法人・設定・認証・共通） */
export const B6_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F115',
    label: '招待の失効',
    tier: 'irreversible',
    action: 'src/app/enterprise/actions.ts#revokeInvitationAction',
    origins: ['src/app/enterprise/settings/page.tsx'],
    status: 'done',
    note: '設定の「招待」タブ。行の「失効…」→ 確認ダイアログ（範囲＝招待先のメールアドレス）',
  },
  {
    id: 'F118',
    label: 'アクセス許諾の取消（元に戻す＝再付与）',
    tier: 'reversible',
    action: 'src/app/enterprise/actions.ts#toggleGrantAction',
    origins: ['src/app/enterprise/settings/page.tsx'],
    status: 'done',
    note: '設定の「アクセス許諾」タブ。行の「取消…」→ 確認ダイアログ（範囲と戻し方）。元に戻すは同じ行の「再付与」。結果の通知に「元に戻す」を置くには toggleGrantAction が ?flash= を返す必要がある（Stage C・handoff/B6.md）',
  },
  {
    id: 'F113',
    label: '開示優先モードの切替（組織の全員のメニューが変わる）',
    tier: 'irreversible',
    action: 'src/app/enterprise/settings/actions.ts#setDisclosureFirstAction',
    origins: ['src/app/enterprise/settings/page.tsx'],
    status: 'done',
    note: '設定の「機能設定」タブ。「保存」→ 確認ダイアログ（組織の全員のメニューとホームが変わる）→「切り替える」',
  },
  {
    id: 'F122',
    label: 'Snapshot を固定',
    tier: 'irreversible',
    action: 'src/app/assurance/actions.ts#createSnapshotAction',
    origins: ['src/app/assurance/engagements/[engagementId]/data-room/page.tsx'],
    status: 'done',
    note: 'Data Room の見出しの「Snapshot を固定」→ 確認ダイアログ（範囲＝共有データの件数。ラベルはダイアログで入力）',
  },
  {
    id: 'F130',
    label: 'PBC 回答の差戻し（理由必須）',
    tier: 'bulk',
    action: 'src/app/assurance/actions.ts#decidePbcAction',
    origins: ['src/app/assurance/engagements/[engagementId]/requests/page.tsx'],
    status: 'done',
    note: '回答の「差戻し…」→ 確認ダイアログ（差戻し理由は必須。サービスは任意のまま）',
  },
  {
    id: 'F135',
    label: 'Sign-off',
    tier: 'irreversible',
    action: 'src/app/assurance/actions.ts#createSignoffAction',
    origins: ['src/app/assurance/engagements/[engagementId]/signoffs/page.tsx'],
    status: 'done',
    note: '段階ごとの「{段階} として Sign-off」→ 確認ダイアログ（本人・案件・段階。コメントはダイアログで入力）',
  },
];
