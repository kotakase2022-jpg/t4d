/**
 * 組織・拠点のタブ（plan §2 S10: ?tab=units|periods|campaigns|metrics|coverage）。
 * キーはタスク動詞・パレットの「設定の項目」が既に指している（src/lib/ui/task-verbs.ts・palette.ts）。
 */
export const ORG_TABS = ['units', 'periods', 'campaigns', 'metrics', 'coverage'] as const;
export type OrgTab = (typeof ORG_TABS)[number];

export const ORG_TAB_LABEL: Record<OrgTab, string> = {
  units: '組織・拠点',
  periods: '報告年度',
  campaigns: '収集キャンペーン',
  metrics: '指標マスター',
  coverage: '基準別の充足',
};

export const ORGANIZATIONS_PATH = '/enterprise/organizations';

export function parseOrgTab(value: string | string[] | undefined): OrgTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return (ORG_TABS as readonly string[]).includes(raw ?? '') ? (raw as OrgTab) : 'units';
}

/** タブの行き先（他のタブの検索・列・ページの条件は持ち越さない） */
export function orgTabHref(tab: OrgTab, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ tab, ...extra });
  return `${ORGANIZATIONS_PATH}?${params.toString()}`;
}
