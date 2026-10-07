import { ANALYSIS_MASTER_FLASH } from './analysis-master';
import { ASSURANCE_SETTINGS_FLASH } from './assurance-settings';
import { CSRD_FLASH } from './csrd';
import { DATA_FLASH } from './data';
import { PROJECTS_FLASH } from './projects';
import { SSBJ_CDP_FLASH } from './ssbj-cdp';
import type { FlashRegistry } from './types';

export type { FlashBuilder, FlashRegistry } from './types';

const PARTS: readonly FlashRegistry[] = [
  DATA_FLASH,
  SSBJ_CDP_FLASH,
  CSRD_FLASH,
  PROJECTS_FLASH,
  ANALYSIS_MASTER_FLASH,
  ASSURANCE_SETTINGS_FLASH,
];

/** 同じキーを 2 つのファイルに書くと、後のものが黙って勝つ。読み込み時に止める */
function merge(parts: readonly FlashRegistry[]): FlashRegistry {
  const out: FlashRegistry = {};
  for (const part of parts) {
    for (const [key, builder] of Object.entries(part)) {
      if (key in out) throw new Error(`結果の通知のキー ${key} が重複しています`);
      out[key] = builder;
    }
  }
  return out;
}

export const FLASH_MESSAGES: Readonly<FlashRegistry> = merge(PARTS);
