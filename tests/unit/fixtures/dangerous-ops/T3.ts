import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T3 保証連携（コメントの起票・Sign-off の結び付け など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F160〜F162（T3 の機能）
 */
export const T3_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F162',
    label: 'Sign-off に開示レポートの写しを結び付けて記録',
    tier: 'irreversible',
    action: 'src/app/assurance/actions.ts#createSignoffAction',
    origins: ['src/app/assurance/engagements/[engagementId]/signoffs/page.tsx'],
    status: 'done',
    note: 'Sign-off（F135）の確認ダイアログで「対象の開示レポート（任意）」を選ぶ。写しの ID と内容ハッシュが追記専用の Sign-off に残り、取り消せない（範囲＝本人・案件・段階。結果に「写しと内容ハッシュを記録」）',
  },
];
