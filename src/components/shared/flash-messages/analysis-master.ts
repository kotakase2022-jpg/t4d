import type { FlashRegistry } from './types';

/** 結果の通知の文言（GHG・サプライヤー・マスター）。所有: Stage B5。flash.tsx から機械的に分けた（文言は変えていない） */
export const ANALYSIS_MASTER_FLASH: FlashRegistry = {
  supplierImported: (params) => {
    const added = params.get('added') ?? '0';
    const replaced = params.get('replaced') ?? '0';
    const total = params.get('total');
    return (
      `サプライヤーデータを取り込み、Scope3 Cat.1 の算定根拠へ新しい版を追記しました` +
      `（新規 ${added} 社 ／ 置き換え ${replaced} 社${total ? ` ／ 一次データ合計 ${total} t-CO2e` : ''}）。`
    );
  },
  supplierDemoReset: (params) => {
    const removed = params.get('removed') ?? '0';
    return (
      `サプライヤーデモの算定版をリセットしました（削除した版 ${removed} 件）。` +
      `初期の算定内訳（版 1）は残っています。同じファイルを再投入すると同じ結果になります。`
    );
  },
  // 組織・拠点のマスター（plan §2 S10）。作った・直した対象の名前を出し、一覧はその対象で絞って見せる
  masterUnitCreated: (params) => `組織「${params.get('name') ?? ''}」を追加しました。`,
  masterUnitUpdated: (params) => `組織「${params.get('name') ?? ''}」を更新しました。`,
  masterPeriodCreated: (params) => `報告年度「${params.get('name') ?? ''}」を追加しました。`,
  masterCampaignCreated: (params) =>
    `収集キャンペーン「${params.get('name') ?? ''}」を作成しました。対象の組織ごとに提出のタスクを作りました。`,
  masterMetricCreated: (params) => `指標「${params.get('name') ?? ''}」を追加しました。`,
  masterMetricUpdated: (params) => `指標「${params.get('name') ?? ''}」を更新しました。`,
  factorRelinked: (params) => {
    const rows = params.get('rows') ?? '1';
    const value = params.get('value');
    const total = params.get('total');
    return (
      `排出量原単位を紐づけ直し、新しい算定版を追記しました` +
      `（対象 ${rows} 行 ／ 行の排出量 ${value ?? '—'} t-CO2e ／ 一次データ合計 ${total ?? '—'} t-CO2e）。`
    );
  },
};
