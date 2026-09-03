import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  OrganizationUnit,
  SsbjAnalysisSettings,
  Uuid,
} from '@/types/domain';

/**
 * 有価証券報告書から、SSBJ の報告対象に含める組織・拠点を自動で選ぶ。
 *
 * SSBJ の報告範囲は連結財務諸表と同一が基本（分析条件の「連結範囲」）。
 * その連結範囲を機械的に確かめられる一次資料が有価証券報告書で、
 * 「関係会社の状況」に連結子会社・持分法適用会社が、「設備の状況」に
 * 自社拠点が載る。取り込み済みの有価証券報告書の本文から組織マスターの
 * 名称を探し、見つかった拠点へ自動でチェックを入れる。
 *
 * 判定は規則ベース（名称の一致）。AI にしないのは、どの拠点をなぜ
 * チェックしたのかを本文の記載ごと説明できるようにするため。
 * 持分法適用会社は**見つけても自動チェックしない**——連結範囲の外であり、
 * 含めるかどうかは人が決める（結果には「見つけたが外した」と明示する）。
 */

export interface SecuritiesReportScopeResult {
  /** 読み込んだ有価証券報告書のファイル名 */
  fileName: string;
  /** 本文に載っており、自動チェックした拠点 */
  checked: string[];
  /** 本文に載っていたが、持分法適用のため自動チェックしなかった拠点 */
  equityMentioned: string[];
  /** 組織マスターにあるが、本文に見つからなかった拠点（サプライヤーを除く） */
  notFound: string[];
}

/** 組織マスターの拠点名が本文に載っているか（名称の完全包含で見る） */
function mentionedIn(text: string, unit: OrganizationUnit): boolean {
  return text.includes(unit.name);
}

export async function applySecuritiesReportScope(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
): Promise<SecuritiesReportScopeResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const period = await db.findById('periods', reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new ValidationError('報告期間が見つかりません。');
  }

  // 最新の有価証券報告書を探す（名前か書類種別で判定）
  const files = await db.select('files', {
    where: { organizationId, deletedAt: { isNull: true } },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const report = files.find(
    (f) => f.originalName.includes('有価証券報告書') || f.documentType === '有価証券報告書',
  );
  if (!report || !report.currentVersionId) {
    throw new ValidationError(
      '有価証券報告書が見つかりません。「データ収集」の取込画面から、ファイル名に「有価証券報告書」を含む PDF を取り込んでください。',
    );
  }

  const fragments = await db.select('fragments', {
    where: { organizationId, fileVersionId: report.currentVersionId },
  });
  if (fragments.length === 0) {
    throw new ValidationError(
      `「${report.originalName}」から本文を抽出できていません。取り込み直してください。`,
    );
  }
  const text = fragments.map((f) => f.text).join('\n');

  const units = await db.select('units', {
    where: { organizationId, deletedAt: { isNull: true } },
  });

  const checked: OrganizationUnit[] = [];
  const equityMentioned: string[] = [];
  const notFound: string[] = [];
  for (const unit of units) {
    // サプライヤーは有価証券報告書の範囲外（バリューチェーンの扱いで決める）
    if (unit.unitType === 'supplier') continue;
    if (!mentionedIn(text, unit)) {
      notFound.push(unit.name);
      continue;
    }
    if (unit.consolidationMethod === 'equity' || unit.consolidationMethod === 'excluded') {
      // 連結範囲の外。含めるかどうかは人が決める
      equityMentioned.push(unit.name);
      continue;
    }
    checked.push(unit);
  }

  if (checked.length === 0) {
    throw new ValidationError(
      `「${report.originalName}」の本文から、組織マスターの拠点名を見つけられませんでした。組織マスターの名称と本文の表記が一致しているか確認してください。`,
    );
  }

  // 設定へ保存する（無ければ既定値で作る）。内容が変わるので確定は外れる
  const now = new Date().toISOString();
  const existing = await db.select('ssbjAnalysisSettings', {
    where: { organizationId, reportingPeriodId },
    limit: 1,
  });
  const includedUnitIds = checked.map((u) => u.id);

  if (existing[0]) {
    await db.update('ssbjAnalysisSettings', existing[0].id, {
      includedUnitIds,
      confirmedAt: null,
      confirmedBy: null,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    const row: SsbjAnalysisSettings = {
      id: crypto.randomUUID(),
      organizationId,
      reportingPeriodId,
      applyGeneral: true,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds,
      valueChainScope: 'not_decided',
      valueChainNote: '',
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    await db.insert('ssbjAnalysisSettings', [row]);
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_analysis_settings',
    resourceId: reportingPeriodId,
    afterSummary:
      `有価証券報告書「${report.originalName}」から報告対象を自動選択: ` +
      `${checked.map((u) => u.name).join('・')}` +
      (equityMentioned.length > 0 ? `（持分法のため対象外: ${equityMentioned.join('・')}）` : ''),
  });

  return {
    fileName: report.originalName,
    checked: checked.map((u) => u.name),
    equityMentioned,
    notFound,
  };
}
