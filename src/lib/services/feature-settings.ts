import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, OrganizationFeatureSettings } from '@/types/domain';

/**
 * 組織単位の機能設定（organization_feature_settings。docs/disclosure-first.md §2-1・§3 0033）。
 *
 * 行が無い組織は既定値（disclosureFirst = false）として扱う。既定を「行が無い」で表すのは、
 * 既存の組織へ行を一括投入しなくても従来ナビ・従来ホームのまま動くようにするため（A39）。
 */

export interface FeatureSettingsView {
  disclosureFirst: boolean;
  /** 行が無い（既定値で動いている）場合は null */
  row: OrganizationFeatureSettings | null;
}

export const DEFAULT_FEATURE_SETTINGS = { disclosureFirst: false } as const;

/** 現在の組織の機能設定。参照は組織メンバーなら誰でもできる（RLS も is_org_member） */
export async function getFeatureSettings(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<FeatureSettingsView> {
  // 監査法人ワークスペースは企業の機能設定を持たない（テナントを混ぜない。CLAUDE.md §0.2）
  if (ctx.workspace.organizationType !== 'enterprise') {
    return { ...DEFAULT_FEATURE_SETTINGS, row: null };
  }
  const rows = await db.select('organizationFeatureSettings', {
    where: { organizationId: ctx.workspace.organizationId },
    limit: 1,
  });
  const row = rows[0] ?? null;
  return { disclosureFirst: row?.disclosureFirst ?? DEFAULT_FEATURE_SETTINGS.disclosureFirst, row };
}

/** 開示優先モードが有効か（画面の分岐用の短縮形） */
export async function isDisclosureFirstEnabled(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<boolean> {
  return (await getFeatureSettings(db, ctx)).disclosureFirst;
}

/**
 * 開示優先モードを切り替える。企業管理者（enterprise.org.manage）のみ。
 * 行が無い組織は初回の変更で作る（ID は組織から決定論的に作り、UNIQUE(organization_id) と二重に防ぐ）。
 */
export async function setDisclosureFirst(
  db: DbClient,
  ctx: AuthorizationContext,
  value: boolean,
): Promise<OrganizationFeatureSettings> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');

  const organizationId = ctx.workspace.organizationId;
  const now = new Date().toISOString();
  const { row: current } = await getFeatureSettings(db, ctx);
  const before = current?.disclosureFirst ?? DEFAULT_FEATURE_SETTINGS.disclosureFirst;

  let saved: OrganizationFeatureSettings;
  if (current) {
    saved = await db.update('organizationFeatureSettings', current.id, {
      disclosureFirst: value,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    const row: OrganizationFeatureSettings = {
      id: fid('organization_feature_settings', organizationId),
      organizationId,
      disclosureFirst: value,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    const inserted = await db.insert('organizationFeatureSettings', [row]);
    saved = inserted[0] ?? row;
  }

  const label = (on: boolean) => (on ? '有効' : '無効');
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'organization_feature_settings',
    resourceId: saved.id,
    beforeSummary: `開示優先モード: ${label(before)}`,
    afterSummary: `開示優先モード: ${label(value)}`,
    metadata: { setting: 'disclosure_first', before, after: value },
  });

  return saved;
}
