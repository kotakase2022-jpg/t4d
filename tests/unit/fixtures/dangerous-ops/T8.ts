import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T8 本文・インパクト・基準版（ドラフトの原稿への取り込み〔一括〕 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F194〜F201（T8 の機能）
 */
export const T8_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F198',
    label: '定性情報と要求事項の直接の対応付けを外す',
    tier: 'reversible',
    action: 'src/app/enterprise/narratives/actions.ts#removeNarrativeLinkAction',
    origins: ['src/app/enterprise/narratives/[narrativeId]/page.tsx'],
    status: 'done',
    note: '外した後の通知に「元に戻す」（同じ要求事項を対応付け直す addNarrativeLinkAction）。外すのは deleted_at で、記録は監査ログに残る',
  },
  {
    id: 'F195',
    label: 'SSBJ・CSRD のドラフトの確定本文を開示プロジェクトの原稿へ取り込む（節の新しい版）',
    tier: 'bulk',
    action: 'src/app/enterprise/disclosures/ssbj/draft/actions.ts#importSsbjDraftToProjectAction',
    origins: ['src/app/enterprise/disclosures/ssbj/draft/import-menu.ts'],
    status: 'done',
    note: '「その他 ▾」の kind: confirm（tier bulk）。範囲に置き換わる節と版（新しい節／版 n・状態）を出す',
  },
  {
    id: 'F194',
    label: 'CSRD 節ドラフトの確定本文を開示プロジェクトの原稿へ取り込む（節の新しい版）',
    tier: 'bulk',
    action: 'src/app/enterprise/disclosures/csrd/draft/actions.ts#importCsrdDraftToProjectAction',
    origins: ['src/app/enterprise/disclosures/ssbj/draft/import-menu.ts'],
    status: 'done',
    note: 'SSBJ と同じ部品（import-menu.ts）。CSRD を基準に持つ同じ年度のプロジェクトだけ（40a には入れない）',
  },
  {
    id: 'F196',
    label: 'この年度の SSBJ の基準の版を切り替える（設定の確定を取り消す）',
    tier: 'bulk',
    action: 'src/app/enterprise/disclosures/ssbj/settings/actions.ts#pinSsbjVersionAction',
    origins: ['src/app/enterprise/disclosures/ssbj/settings/page.tsx'],
    status: 'done',
    note: 'ConfirmDialog（tier bulk）。範囲に「年度: 旧版 → 新版」、結果に評価対象の要求事項が変わること・確定の取り消し',
  },
];
