import type { StatusEntry } from './types';

/** CDP 対応オプションの契約の状態（トライアル対応 NF-38。組織の管理者が自分で開けない） */
export const CDP_OPTION_STATES = ['contracted', 'not_contracted'] as const;
export type CdpOptionState = (typeof CDP_OPTION_STATES)[number];

export const cdpOption: Record<CdpOptionState, StatusEntry> = {
  contracted: { label: '契約あり', semantic: 'done' },
  not_contracted: { label: '契約なし', semantic: 'excluded' },
};
