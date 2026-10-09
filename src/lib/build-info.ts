import { formatJst } from '@/lib/format/datetime';

/**
 * この環境の版（トライアル対応 NF-31）。
 *
 * ビルドのときに next.config.ts が env（T4D_BUILD_COMMIT・T4D_BUILD_TIME）へコミットの短縮形とビルド日時を
 * 入れる。取得できなければ「不明」。ヘルプの「この環境の版」と、ご意見・不具合・評価の記録に自動で添える。
 * 秘密ではない（クライアントの部品からも読める）。
 */

export const UNKNOWN_BUILD_VALUE = '不明';

export interface BuildInfo {
  /** コミットの短縮形（7 文字）。不明なら「不明」 */
  commit: string;
  /** ビルド日時（UTC の ISO 文字列）。不明なら null */
  builtAt: string | null;
  /** 表示用（例: 「abc1234（2026-10-09 17:00 ビルド）」） */
  label: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** 環境変数の値から版を作る（純粋関数。テストと next.config.ts の値の検査に使う） */
export function buildInfoFrom(values: {
  commit?: string | null;
  builtAt?: string | null;
}): BuildInfo {
  const rawCommit = (values.commit ?? '').trim();
  const commit = COMMIT_PATTERN.test(rawCommit)
    ? rawCommit.slice(0, 7).toLowerCase()
    : UNKNOWN_BUILD_VALUE;
  const rawTime = (values.builtAt ?? '').trim();
  const builtAt =
    rawTime !== '' && !Number.isNaN(Date.parse(rawTime)) ? new Date(rawTime).toISOString() : null;
  const label = `${commit}（${builtAt ? `${formatJst(builtAt)} ビルド` : `ビルド日時 ${UNKNOWN_BUILD_VALUE}`}）`;
  return { commit, builtAt, label };
}

/** この環境の版。process.env の参照は Next がビルド時に値へ置き換える（next.config.ts の env） */
export function getBuildInfo(): BuildInfo {
  return buildInfoFrom({
    commit: process.env.T4D_BUILD_COMMIT ?? null,
    builtAt: process.env.T4D_BUILD_TIME ?? null,
  });
}

/** 記録に添える形（ご意見・評価の記録の metadata に入れる。版とビルド日時だけ） */
export function buildStamp(info: BuildInfo = getBuildInfo()): {
  build: string;
  builtAt: string | null;
} {
  return { build: info.commit, builtAt: info.builtAt };
}
