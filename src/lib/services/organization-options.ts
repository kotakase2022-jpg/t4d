import 'server-only';

import { toJstDate } from '@/lib/format/datetime';
import type { CdpOptionState } from '@/lib/ui/status/cdpOption';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  IsoDate,
  OrganizationOption,
  OrganizationOptionKey,
} from '@/types/domain';

/**
 * 契約で開く有償オプション（トライアル対応 NF-38。最初は CDP 対応）。
 *
 *  - 契約は役割の権限ではない（権限キーを足さない）。組織単位で、運営（Service Role）だけが設定する。
 *    顧客の管理者は参照だけ（RLS 0057。書込ポリシーなし）。Demo Mode でも書く関数を置かない
 *  - 行が無い・無効・有効期間外は「契約なし」。期間は日本時間の日付で判定する（DB は UTC）
 *  - 止める場所（メニュー・画面・API・Action・分析）はそれぞれの所有者が hasOption で判定する。
 *    画面は 404 にせず「オプションは契約されていません」を出す
 */

export function isOptionActive(
  option: Pick<OrganizationOption, 'enabled' | 'validFrom' | 'validTo'> | null | undefined,
  today: IsoDate,
): boolean {
  if (!option || !option.enabled) return false;
  if (option.validFrom && today < option.validFrom) return false;
  if (option.validTo && today > option.validTo) return false;
  return true;
}

/** 組織のオプションの行（無ければ null） */
export async function loadOrganizationOption(
  db: DbClient,
  ctx: AuthorizationContext,
  key: OrganizationOptionKey,
): Promise<OrganizationOption | null> {
  const rows = await db.select('organizationOptions', {
    where: { organizationId: ctx.workspace.organizationId, optionKey: key },
    limit: 1,
  });
  return rows[0] ?? null;
}

/**
 * 今の組織でオプションが有効か。企業ワークスペース以外（監査法人）は常に false。
 * today は日本時間の日付（省略時は現在）
 */
export async function hasOption(
  db: DbClient,
  ctx: AuthorizationContext,
  key: OrganizationOptionKey,
  today: IsoDate = toJstDate(new Date().toISOString()),
): Promise<boolean> {
  if (ctx.workspace.organizationType !== 'enterprise') return false;
  return isOptionActive(await loadOrganizationOption(db, ctx, key), today);
}

/** 設定の機能設定タブの読み取り専用の行（契約の状態） */
export async function cdpOptionState(
  db: DbClient,
  ctx: AuthorizationContext,
  today: IsoDate = toJstDate(new Date().toISOString()),
): Promise<{ state: CdpOptionState; option: OrganizationOption | null }> {
  const option =
    ctx.workspace.organizationType === 'enterprise'
      ? await loadOrganizationOption(db, ctx, 'cdp')
      : null;
  return { state: isOptionActive(option, today) ? 'contracted' : 'not_contracted', option };
}

/** オプションが無いときに画面・API が出す文言 */
export const OPTION_NOT_CONTRACTED_MESSAGES: Readonly<Record<OrganizationOptionKey, string>> = {
  cdp: 'CDP 対応オプションは契約されていません。',
};
