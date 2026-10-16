import 'server-only';

import {
  GHG_FIXED_NOTICES,
  companyRuleNoticeText,
  loadFactorNoticeText,
} from '@/components/shared/ghg-notices';
import {
  GHG_METHOD_LABELS,
  GHG_SCOPE_LABELS,
  LINE_WARNING_LABELS,
  activityLabel,
} from '@/lib/domain/ghg/calculate';
import { cleanFloat } from '@/lib/domain/ghg/rounding';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { toCsv, type ExportColumn, type ExportSheet } from '@/lib/exports';
import type { DbClient } from '@/lib/repositories/types';
import { loadRun } from '@/lib/services/ghg/calculation';
import type {
  AuthorizationContext,
  GhgCalculationLine,
  GhgCalculationRun,
  IsoDate,
  IsoDateTime,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 算定明細 CSV（plan E18・CR-15。P96 の副操作）。
 *
 *  - 1 算定行 1 行。列は画面の算定行と同じ値（記録に残した値をそのまま。表示で丸め直さない。2 進の誤差だけ落とす）
 *  - 表の後に空行を 1 つ置き、注記の行（1 列目「注記」・2 列目に文）を続ける。注記は画面と同じ固定文
 *    （N1 区分規則・N5 海外拠点の輸送・N7 積載率・N9 架空）を ghg-notices の関数から作る（文言を変えない）
 *  - 企業が入力した文字列の数式の無害化は toCsv が行う
 */

export const GHG_CALCULATION_EXPORT_VERSION = 'ghg-calculation-csv/1';

export interface GhgCalculationExportContext {
  run: Pick<GhgCalculationRun, 'id' | 'createdAt' | 'engineVersion' | 'inputHash'>;
  period: Pick<ReportingPeriod, 'code' | 'label'>;
  units: ReadonlyMap<Uuid, Pick<OrganizationUnit, 'code' | 'name' | 'countryCode'>>;
  /** 区分規則の ID → 「コード 名前」 */
  ruleNames: ReadonlyMap<Uuid, string>;
  /** 報告区分を変えた承認済みの区分規則（N1） */
  appliedRules: ReadonlyArray<{
    ruleName: string;
    approvedAt: IsoDateTime | IsoDate;
    approverName: string;
  }>;
  /** 積載率の下限（%。算定方針。N7 に差し込む） */
  minLoadPct: number | null;
  /** Demo Mode（架空のデータ。N9） */
  demo: boolean;
}

export type GhgCalculationCsvRow =
  { kind: 'line'; line: GhgCalculationLine } | { kind: 'blank' } | { kind: 'note'; text: string };

function n(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? cleanFloat(value) : null;
}

function detailNumber(line: GhgCalculationLine, key: string): number | null {
  const value = line.methodDetail[key];
  return typeof value === 'number' ? n(value) : null;
}

function detailText(line: GhgCalculationLine, key: string): string {
  const value = line.methodDetail[key];
  return typeof value === 'string' ? value : '';
}

const LOAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  measured: '実測',
  default: '見なし（原単位表）',
  floored: '下限を適用',
};

/** 1 列目と 2 列目に注記を置く行・空行では、各列の値を空にする */
function lineColumn(
  key: string,
  header: string,
  value: (line: GhgCalculationLine) => string | number | null,
  options: { numeric?: boolean; noteSlot?: 'label' | 'text' } = {},
): ExportColumn<GhgCalculationCsvRow> {
  return {
    key,
    header,
    numeric: options.numeric,
    value: (row) => {
      if (row.kind === 'line') return value(row.line);
      if (row.kind === 'note') {
        if (options.noteSlot === 'label') return '注記';
        if (options.noteSlot === 'text') return row.text;
      }
      return '';
    },
  };
}

export function ghgCalculationColumns(
  context: GhgCalculationExportContext,
): ExportColumn<GhgCalculationCsvRow>[] {
  const short = context.run.id.slice(0, 8);
  const unit = (line: GhgCalculationLine) => context.units.get(line.unitId);
  return [
    lineColumn('run', '算定の記録', () => `#${short}`, { noteSlot: 'label' }),
    lineColumn('period', '期間', () => context.period.code, { noteSlot: 'text' }),
    lineColumn('unitCode', '拠点コード', (l) => unit(l)?.code ?? ''),
    lineColumn('unitName', '拠点', (l) => unit(l)?.name ?? ''),
    lineColumn('country', '国', (l) => unit(l)?.countryCode ?? ''),
    lineColumn('month', '月', (l) => l.month.slice(0, 7)),
    lineColumn('activity', '活動', (l) => activityLabel(l.activityKind, l.activityCode)),
    lineColumn('method', '算定方法', (l) => GHG_METHOD_LABELS[l.method]),
    lineColumn('activityAmount', '活動量', (l) => n(l.activityAmount), { numeric: true }),
    lineColumn('activityUnit', '活動量の単位', (l) => l.activityUnit),
    lineColumn('convertedAmount', '換算後の量', (l) => n(l.convertedAmount), { numeric: true }),
    lineColumn('convertedUnit', '換算後の単位', (l) => l.convertedUnit),
    lineColumn('conversion', '換算の段', (l) =>
      l.conversionSteps
        .map(
          (s) =>
            `${s.from}→${s.to}×${n(s.factor)}（${s.source === 'builtin' ? '内蔵' : s.source}）`,
        )
        .join(' ／ '),
    ),
    lineColumn('tonKm', '輸送トンキロ（t·km）', (l) => detailNumber(l, 'tonKm'), {
      numeric: true,
    }),
    lineColumn('intensityRaw', '燃料使用原単位（未丸め）', (l) => detailNumber(l, 'intensityRaw'), {
      numeric: true,
    }),
    lineColumn('intensity', '燃料使用原単位（L/t·km）', (l) => detailNumber(l, 'intensity'), {
      numeric: true,
    }),
    lineColumn('loadFactor', '積載率（%）', (l) => detailNumber(l, 'loadFactorUsed'), {
      numeric: true,
    }),
    lineColumn(
      'loadFactorSource',
      '積載率の出所',
      (l) => LOAD_SOURCE_LABELS[detailText(l, 'loadFactorSource')] ?? '',
    ),
    lineColumn('fuelLiters', '燃料（L）', (l) => detailNumber(l, 'fuelLiters'), { numeric: true }),
    lineColumn('factorValue', '排出係数', (l) => n(l.factorValue), { numeric: true }),
    lineColumn('factorUnit', '排出係数の単位', (l) => l.factorUnit),
    lineColumn('calorific', '単位発熱量', (l) => detailNumber(l, 'calorificValue'), {
      numeric: true,
    }),
    lineColumn('carbon', '炭素排出係数', (l) => detailNumber(l, 'carbonFactor'), {
      numeric: true,
    }),
    lineColumn('factorYear', '係数の年度', (l) => l.factorYear, { numeric: true }),
    lineColumn('factorSet', '係数セット', (l) => l.factorSetCode),
    lineColumn('factorSetVersion', '係数セットの版', (l) => l.factorSetVersion),
    lineColumn('resolutionPath', '係数の解決経路', (l) => l.resolutionPath),
    lineColumn('emissionsUnrounded', '排出量（未丸め・t-CO2e）', (l) => n(l.emissionsUnrounded), {
      numeric: true,
    }),
    lineColumn(
      'emissionsRounded',
      '排出量（行の丸め後・t-CO2e）',
      (l) => (l.roundingApplied ? n(l.emissionsRounded) : null),
      { numeric: true },
    ),
    lineColumn(
      'protocolScope',
      '既定区分（GHG プロトコル）',
      (l) => GHG_SCOPE_LABELS[l.protocolScope],
    ),
    lineColumn(
      'reportedScope',
      '報告区分（組織の算定ルール）',
      (l) => GHG_SCOPE_LABELS[l.reportedScope],
    ),
    lineColumn('rule', '区分規則', (l) =>
      l.classificationRuleId ? (context.ruleNames.get(l.classificationRuleId) ?? '') : '',
    ),
    lineColumn('warnings', '警告', (l) =>
      l.warnings.map((w) => LINE_WARNING_LABELS[w] ?? w).join('・'),
    ),
  ];
}

/** 注記（画面と同じ固定文。該当するものだけ） */
export function ghgCalculationNotes(
  lines: readonly GhgCalculationLine[],
  context: GhgCalculationExportContext,
): string[] {
  const notes: string[] = [];
  if (context.demo) notes.push(GHG_FIXED_NOTICES.N9);
  for (const rule of context.appliedRules) notes.push(companyRuleNoticeText(rule));
  if (lines.some((l) => l.method === 'tonkm_improved' && l.methodDetail.overseas === true)) {
    notes.push(GHG_FIXED_NOTICES.N5);
  }
  const defaultRows = lines.filter((l) => l.warnings.includes('default_load_factor')).length;
  const flooredRows = lines.filter((l) => l.warnings.includes('load_floored')).length;
  if ((defaultRows > 0 || flooredRows > 0) && context.minLoadPct !== null) {
    notes.push(loadFactorNoticeText({ defaultRows, minLoadPct: context.minLoadPct, flooredRows }));
  }
  notes.push(
    '値は算定の記録に残した値です（表示のために丸め直していません。2 進の誤差だけ落としています）。既定区分（GHG プロトコル）は参考の値です。Scope2 のロケーション基準とマーケット基準は足しません。',
    `記録 #${context.run.id.slice(0, 8)}・入力ハッシュ ${context.run.inputHash.slice(0, 12)}・エンジン ${context.run.engineVersion}・出力の版 ${GHG_CALCULATION_EXPORT_VERSION}`,
  );
  return notes;
}

export function buildGhgCalculationSheet(
  lines: readonly GhgCalculationLine[],
  context: GhgCalculationExportContext,
): ExportSheet<GhgCalculationCsvRow> {
  const notes = ghgCalculationNotes(lines, context);
  return {
    name: '算定明細',
    columns: ghgCalculationColumns(context),
    rows: [
      ...lines.map((line) => ({ kind: 'line' as const, line })),
      { kind: 'blank' as const },
      ...notes.map((text) => ({ kind: 'note' as const, text })),
    ],
  };
}

export function ghgCalculationFileName(
  period: Pick<ReportingPeriod, 'code'>,
  run: Pick<GhgCalculationRun, 'id'>,
): string {
  return `算定明細_${period.code}_${run.id.slice(0, 8)}.csv`;
}

export type GhgCalculationExportResult =
  | { ok: true; csv: string; fileName: string; rowCount: number }
  /** 入力が変わったため、記録の数値を作り直せない（画面も数値を出さない。plan K11） */
  | { ok: false; reason: 'input_changed' };

/**
 * 算定明細 CSV を作る（E18）。権限: 出力（enterprise.export.run）＋閲覧。他社・存在しない記録は NotFoundError。
 * 出したら監査ログ export_created
 */
export async function exportGhgCalculationCsv(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<GhgCalculationExportResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.export.run');
  const { run, lines } = await loadRun(db, ctx, runId);
  if (!run.summary) return { ok: false, reason: 'input_changed' };
  const organizationId = ctx.workspace.organizationId;
  const [period, units, rules, policy] = await Promise.all([
    db.findById('periods', run.reportingPeriodId),
    db.select('units', { where: { organizationId, id: { in: run.unitIds } } }),
    db.select('ghgClassificationRules', { where: { organizationId } }),
    db.findById('ghgCalculationPolicies', run.policyId),
  ]);
  if (!period || period.organizationId !== organizationId) {
    throw new NotFoundError('算定の記録が見つかりません。');
  }
  // 報告区分を変えた（再分類があった）承認済みの規則と承認者（N1）
  const movedRuleIds = new Set(run.summary.reclassified.map((r) => r.ruleId));
  const applied = rules.filter((r) => movedRuleIds.has(r.id));
  const approverIds = applied.flatMap((r) => (r.approvedBy ? [r.approvedBy] : []));
  const profiles =
    approverIds.length > 0
      ? await db.select('profiles', { where: { id: { in: approverIds } } })
      : [];
  const sheet = buildGhgCalculationSheet(lines, {
    run,
    period,
    units: new Map(units.map((u) => [u.id, u])),
    ruleNames: new Map(rules.map((r) => [r.id, `${r.code} ${r.name}`])),
    appliedRules: applied.map((rule) => ({
      ruleName: rule.name,
      approvedAt: rule.approvedAt ?? rule.updatedAt,
      approverName: profiles.find((p) => p.id === rule.approvedBy)?.displayName ?? '—',
    })),
    minLoadPct: policy && policy.organizationId === organizationId ? policy.tonkm.minLoadPct : null,
    demo: ctx.demo,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'ghg_calculation_run',
    resourceId: run.id,
    afterSummary: `算定明細 CSV を出力（${period.label}・記録 #${run.id.slice(0, 8)}・算定行 ${lines.length} 行）`,
    metadata: { runId: run.id, rows: lines.length, version: GHG_CALCULATION_EXPORT_VERSION },
  });
  return {
    ok: true,
    csv: toCsv(sheet),
    fileName: ghgCalculationFileName(period, run),
    rowCount: lines.length,
  };
}
