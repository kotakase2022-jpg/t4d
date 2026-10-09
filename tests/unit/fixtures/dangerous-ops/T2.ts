import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T2 トレース・出力・突合・影響の表示（保証側への共有〔不可逆〕・共有の取り下げ など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F157〜F159（T2 の機能）。承認済みの値の修正は既存の
 * 機能 F020（値の修正）に確認を足したもの
 */
export const T2_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F157',
    label: '承認済みレポートを保証側へ共有（写しは変更されない）',
    tier: 'irreversible',
    action:
      'src/app/enterprise/disclosure-projects/[projectId]/outputs/actions.ts#shareReportAction',
    origins: ['src/app/enterprise/disclosure-projects/[projectId]/_tabs/outputs.tsx'],
    status: 'done',
    note: '出力タブのスナップショットの行「操作 ▾ → 保証側へ共有（案件）…」（kind: confirm）。範囲＝案件名・スナップショット No.・内容ハッシュの先頭 12 桁',
  },
  {
    id: 'F158',
    label: '保証側への共有を取り下げる（元に戻せない。再共有は新しい写し）',
    tier: 'irreversible',
    action:
      'src/app/enterprise/disclosure-projects/[projectId]/outputs/actions.ts#withdrawSharedReportAction',
    origins: ['src/app/enterprise/disclosure-projects/[projectId]/_tabs/outputs.tsx'],
    status: 'done',
    note: '出力タブのスナップショットの行「操作 ▾ → 共有を取り下げる（案件）…」（kind: confirm・destructive）',
  },
  {
    id: 'F020',
    label: '承認済みの値の修正（新しい版で上書き。影響先を示してから保存）',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#updateDataPointAction',
    origins: [
      'src/app/enterprise/data/[dataPointId]/page.tsx',
      'src/app/enterprise/data/[dataPointId]/approved-value-confirm.tsx',
    ],
    status: 'done',
    note: '承認済みの Data Point の値の編集の「保存…」→ ConfirmDialog（影響する節・承認済みレポート・保証側へ共有中の件数）',
  },
];
