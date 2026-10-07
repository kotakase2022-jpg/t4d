import type { ConsolidationMethod, UnitType } from '@/types/domain';

/** 組織の種別・連結方法の表示名（一覧とフォームで同じ語を使う） */
export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  headquarters: '本社',
  division: '事業部',
  site: '事業所・工場',
  subsidiary: 'グループ会社',
  supplier: 'サプライヤー',
};

export const CONSOLIDATION_LABEL: Record<ConsolidationMethod, string> = {
  full: '全部連結',
  proportionate: '比例連結',
  equity: '持分法',
  excluded: '連結対象外',
};

/** 収集キャンペーンの状態（登録簿に無い小さな enum。生の値を出さない） */
export const CAMPAIGN_STATUS_LABEL: Record<'draft' | 'open' | 'closed', string> = {
  draft: '下書き',
  open: '収集中',
  closed: '終了',
};
