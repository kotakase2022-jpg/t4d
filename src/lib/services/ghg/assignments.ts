import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { isIsoCountryCode, normalizeCountryCode } from '@/lib/domain/country-code';
import { ACTIVITY_CODE_LABELS } from '@/lib/domain/ghg/calculate';
import {
  RESOLUTION_ERROR_LABELS,
  resolveFactor,
  type ResolutionError,
  type ResolutionPath,
} from '@/lib/domain/ghg/factor-resolution';
import { EMISSION_BASIS_LABELS, FACTOR_KIND_LABELS } from '@/lib/domain/ghg/factor-import';
import { ValidationError } from '@/lib/errors/user-facing';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import {
  EMISSION_BASES,
  FACTOR_ACTIVITY_KINDS,
  type AuthorizationContext,
  type EmissionBasis,
  type EmissionFactor,
  type EmissionFactorAssignment,
  type EmissionFactorSet,
  type FactorActivityKind,
  type GhgActivityLine,
  type OrganizationUnit,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';
import { loadGhgSource } from './inputs';

/**
 * 係数の割当（plan §2.3 assignments.ts・CR-02。S1）。
 *
 *  - 必要な割当は活動量（確定済みのバッチの行）から導く。拠点 × 活動 × 基準ごとに、いまの割当で
 *    係数が解決できるか（拠点 ＞ 国 ＞ 全社既定。代わりを使わない）を src/lib/domain/ghg/factor-resolution.ts で調べる
 *    （算定・概要の要対応の件数〔status.ts〕と同じ関数・同じ数え方）
 *  - 割り当てられるのは有効なセットの係数で、種類・活動・基準が合うものだけ（DB のトリガと同じ規則に、
 *    活動のコードと基準の一致を足す。軽油の割当に揮発油の係数を当てない）
 *  - 書けるのは enterprise.metric.manage。期間が締められていれば拒否
 *  - 外す: Supabase Mode は利用者の JWT で DELETE（RLS が metric.manage を確かめる）。Demo Mode は利用者が
 *    作った割当だけ（Fixture の割当を外しても、別のインスタンスでは Cookie から戻せず元に戻って見えるため、
 *    割り当て直す操作だけにする）
 * 監査ログは既存の種類（割当の保存・外す＝settings_changed）。
 */

export type AssignmentLevel = 'unit' | 'country' | 'org_default';

export const ASSIGNMENT_LEVEL_LABELS: Record<AssignmentLevel, string> = {
  unit: '拠点',
  country: '国',
  org_default: '全社既定',
};

export interface NeedResolution {
  factor: EmissionFactor;
  set: EmissionFactorSet;
  assignmentId: Uuid;
  path: ResolutionPath;
  description: string;
}

export interface AssignmentNeed {
  /** 拠点|種類|活動|基準（行の識別と ?assign= の値） */
  key: string;
  unit: Pick<OrganizationUnit, 'id' | 'code' | 'name' | 'countryCode'>;
  activityKind: FactorActivityKind;
  activityCode: string;
  basis: EmissionBasis | null;
  /** 画面の活動の名前（例「電力（ロケーション基準）」） */
  label: string;
  /** この割当を使う活動量の行の数 */
  lineCount: number;
  resolution: NeedResolution | null;
  error: ResolutionError | null;
  errorLabel: string | null;
}

export interface AssignmentRow {
  assignment: EmissionFactorAssignment;
  level: AssignmentLevel;
  /** 拠点名・国コード・「全社既定」 */
  targetLabel: string;
  factor: EmissionFactor | null;
  set: EmissionFactorSet | null;
  /** 外せるか（Demo Mode は利用者が作った割当だけ。締めた期間は外せない） */
  removable: boolean;
  /** 外せない理由（画面の disabledReason） */
  removeBlockedReason: string | null;
}

export interface CandidateFactor {
  factor: EmissionFactor;
  set: EmissionFactorSet;
}

export interface AssignmentOverview {
  period: ReportingPeriod;
  needs: AssignmentNeed[];
  assignments: AssignmentRow[];
  /** 割り当てられる係数（有効なセットの係数） */
  candidates: CandidateFactor[];
  /** 確定していない（下書きの）活動量のバッチ（確定すると必要な割当に出る） */
  draftBatches: number;
  units: Array<Pick<OrganizationUnit, 'id' | 'code' | 'name' | 'countryCode'>>;
}

function fuelLabel(code: string): string {
  return ACTIVITY_CODE_LABELS[code] ?? code;
}

/** 必要な割当の名前（種類・活動・基準） */
export function needLabel(
  kind: FactorActivityKind,
  code: string,
  basis: EmissionBasis | null,
): string {
  switch (kind) {
    case 'electricity':
      return basis === 'market'
        ? `電力（${EMISSION_BASIS_LABELS.market}${code !== 'grid' ? `・契約 ${code}` : ''}）`
        : `電力（${EMISSION_BASIS_LABELS[basis ?? 'location']}）`;
    case 'transport_formula':
    case 'transport_default':
      return `${FACTOR_KIND_LABELS[kind]}（${fuelLabel(code)}）`;
    case 'heat':
      return code === 'heat' ? '熱' : `熱（${code}）`;
    default:
      return fuelLabel(code);
  }
}

/** 活動量の 1 行に要る割当（算定のエンジンが係数を解決する組と同じ） */
export function needsOfLine(
  line: GhgActivityLine,
): Array<{ kind: FactorActivityKind; code: string; basis: EmissionBasis | null }> {
  switch (line.activityKind) {
    case 'electricity':
      return [
        { kind: 'electricity', code: 'grid', basis: 'location' },
        { kind: 'electricity', code: line.contractCode ?? 'grid', basis: 'market' },
      ];
    case 'transport': {
      const fuel = line.fuelCode ?? line.activityCode;
      const tonKm = line.tonKm !== null || (line.cargoWeightT !== null && line.distanceKm !== null);
      if (!tonKm) return [{ kind: 'fuel', code: fuel, basis: null }];
      return [
        {
          kind: line.loadFactorPct === null ? 'transport_default' : 'transport_formula',
          code: fuel,
          basis: null,
        },
        { kind: 'fuel', code: fuel, basis: null },
      ];
    }
    default:
      return [{ kind: line.activityKind, code: line.activityCode, basis: null }];
  }
}

export function needKey(
  unitId: string,
  kind: FactorActivityKind,
  code: string,
  basis: EmissionBasis | null,
): string {
  return [unitId, kind, code, basis ?? ''].join('|');
}

/** 係数がこの割当（種類・活動・基準）に使えるか。電力のマーケット基準は契約の係数か組織の代替値（grid） */
export function factorFits(
  factor: Pick<EmissionFactor, 'activityKind' | 'activityCode' | 'basis'>,
  kind: FactorActivityKind,
  code: string,
  basis: EmissionBasis | null,
): boolean {
  if (factor.activityKind !== kind) return false;
  if ((factor.basis ?? null) !== (basis ?? null)) return false;
  if (kind === 'electricity' && basis === 'market') {
    return factor.activityCode === code || factor.activityCode === 'grid';
  }
  return factor.activityCode === code;
}

function levelOf(a: Pick<EmissionFactorAssignment, 'unitId' | 'countryCode'>): AssignmentLevel {
  if (a.unitId) return 'unit';
  if (a.countryCode) return 'country';
  return 'org_default';
}

function assertReader(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
}

function assertManager(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
}

/** Fixture の初期値の割当の ID（Demo Mode で「利用者が作った割当か」を見分ける。書き換えない） */
function pristineAssignmentIds(): ReadonlySet<string> {
  // リセットの反映と同じ「Fixture の初期値」を使う（repositories/index.ts の pristineFixture と同じ置き場所）
  const g = globalThis as unknown as { __t4dPristineFixture?: FixtureDb };
  g.__t4dPristineFixture ??= createFixtureDb();
  return new Set(g.__t4dPristineFixture.emissionFactorAssignments.map((a) => a.id));
}

const DEMO_FIXTURE_ASSIGNMENT_REASON =
  'デモの初期データの割当は外せません（別の係数に割り当て直すことはできます）。';

/** 期間の必要な割当・いまの割当・割り当てられる係数 */
export async function listAssignmentNeeds(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid },
): Promise<AssignmentOverview> {
  assertReader(ctx);
  const source = await loadGhgSource(db, ctx, options.periodId);
  const confirmed = new Map(
    source.batches.filter((b) => b.status === 'confirmed').map((b) => [b.id, b.unitId]),
  );
  const unitById = new Map(source.units.map((u) => [u.id, u]));
  const groups = new Map<
    string,
    {
      unitId: string;
      kind: FactorActivityKind;
      code: string;
      basis: EmissionBasis | null;
      count: number;
    }
  >();
  for (const line of source.lines) {
    const unitId = confirmed.get(line.batchId);
    if (!unitId || !unitById.has(unitId)) continue;
    for (const need of needsOfLine(line)) {
      const key = needKey(unitId, need.kind, need.code, need.basis);
      const entry = groups.get(key) ?? { unitId, ...need, count: 0 };
      entry.count += 1;
      groups.set(key, entry);
    }
  }
  const needs: AssignmentNeed[] = [...groups.entries()].map(([key, g]) => {
    const unit = unitById.get(g.unitId)!;
    const label = needLabel(g.kind, g.code, g.basis);
    const r = resolveFactor(
      {
        reportingPeriodId: source.period.id,
        unitId: unit.id,
        unitName: unit.name,
        countryCode: unit.countryCode,
        activityKind: g.kind,
        activityCode: g.code,
        activityLabel: label,
        basis: g.basis,
      },
      source.assignments,
      source.factors,
      source.sets,
    );
    return {
      key,
      unit: { id: unit.id, code: unit.code, name: unit.name, countryCode: unit.countryCode },
      activityKind: g.kind,
      activityCode: g.code,
      basis: g.basis,
      label,
      lineCount: g.count,
      resolution: 'error' in r ? null : r,
      error: 'error' in r ? r.error : null,
      errorLabel: 'error' in r ? RESOLUTION_ERROR_LABELS[r.error] : null,
    };
  });
  needs.sort(
    (a, b) =>
      a.unit.code.localeCompare(b.unit.code) ||
      FACTOR_ACTIVITY_KINDS.indexOf(a.activityKind) -
        FACTOR_ACTIVITY_KINDS.indexOf(b.activityKind) ||
      a.activityCode.localeCompare(b.activityCode) ||
      (a.basis ?? '').localeCompare(b.basis ?? ''),
  );

  const factorById = new Map(source.factors.map((f) => [f.id, f]));
  const setById = new Map(source.sets.map((s) => [s.id, s]));
  const pristine = db.mode === 'demo' ? pristineAssignmentIds() : null;
  const closed = source.period.status === 'closed';
  const assignments: AssignmentRow[] = source.assignments
    .filter((a) => a.reportingPeriodId === source.period.id)
    .map((assignment) => {
      const factor = factorById.get(assignment.factorId) ?? null;
      const level = levelOf(assignment);
      const fromFixture = pristine?.has(assignment.id) ?? false;
      return {
        assignment,
        level,
        targetLabel:
          level === 'unit'
            ? (unitById.get(assignment.unitId!)?.name ?? '（拠点が見つかりません）')
            : level === 'country'
              ? assignment.countryCode!
              : ASSIGNMENT_LEVEL_LABELS.org_default,
        factor,
        set: factor?.factorSetId ? (setById.get(factor.factorSetId) ?? null) : null,
        removable: !closed && !fromFixture,
        removeBlockedReason: closed
          ? '締めた期間の割当は外せません。'
          : fromFixture
            ? DEMO_FIXTURE_ASSIGNMENT_REASON
            : null,
      };
    })
    .sort(
      (a, b) =>
        a.assignment.activityKind.localeCompare(b.assignment.activityKind) ||
        a.assignment.activityCode.localeCompare(b.assignment.activityCode) ||
        a.level.localeCompare(b.level) ||
        a.targetLabel.localeCompare(b.targetLabel),
    );

  const candidates = source.factors
    .filter((f) => f.factorSetId && setById.get(f.factorSetId)?.status === 'active')
    .map((factor) => ({ factor, set: setById.get(factor.factorSetId!)! }))
    .sort(
      (a, b) =>
        a.set.code.localeCompare(b.set.code) ||
        a.factor.code.localeCompare(b.factor.code) ||
        a.factor.factorYear - b.factor.factorYear,
    );

  return {
    period: source.period,
    needs,
    assignments,
    candidates,
    draftBatches: source.batches.filter((b) => b.status === 'draft').length,
    units: source.units.map((u) => ({
      id: u.id,
      code: u.code,
      name: u.name,
      countryCode: u.countryCode,
    })),
  };
}

export interface SaveAssignmentInput {
  periodId: Uuid;
  level: AssignmentLevel;
  unitId: Uuid | null;
  countryCode: string | null;
  activityKind: FactorActivityKind;
  activityCode: string;
  basis: EmissionBasis | null;
  factorId: Uuid;
  reason: string;
}

async function loadOpenPeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<ReportingPeriod> {
  const period = await db.findById('periods', periodId);
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  if (period.status === 'closed') {
    throw new ValidationError('締めた期間の係数の割当は変更できません。');
  }
  return period;
}

/**
 * 割り当てる（同じ 期間 × 拠点／国／全社 × 活動 × 基準 の割当があれば係数と理由を差し替える）
 */
export async function saveAssignment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveAssignmentInput,
): Promise<EmissionFactorAssignment> {
  assertManager(ctx);
  const organizationId = ctx.workspace.organizationId;
  const period = await loadOpenPeriod(db, ctx, input.periodId);
  if (!(FACTOR_ACTIVITY_KINDS as readonly string[]).includes(input.activityKind)) {
    throw new ValidationError('係数の種類を読めません。');
  }
  const activityCode = input.activityCode.trim();
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(activityCode)) {
    throw new ValidationError('活動のコードを読めません。');
  }
  const basis = input.basis;
  if (input.activityKind === 'electricity') {
    if (!basis || !(EMISSION_BASES as readonly string[]).includes(basis)) {
      throw new ValidationError('電力の割当には基準（ロケーション・マーケット）が要ります。');
    }
  } else if (basis !== null) {
    throw new ValidationError('基準は電力の割当にだけ付けます。');
  }
  const reason = input.reason.trim();
  const reasonMax = db.mode === 'demo' ? 300 : 500;
  if (reason.length > reasonMax) throw new ValidationError(`理由は ${reasonMax} 文字までです。`);

  let unitId: Uuid | null = null;
  let countryCode: string | null = null;
  let targetCountry: string | null = null;
  let targetLabel: string = ASSIGNMENT_LEVEL_LABELS.org_default;
  if (input.level === 'unit') {
    const unit = input.unitId ? await db.findById('units', input.unitId) : null;
    if (!unit || unit.organizationId !== organizationId || unit.deletedAt) {
      throw new NotFoundError('拠点が見つかりません。');
    }
    unitId = unit.id;
    targetCountry = unit.countryCode;
    targetLabel = unit.name;
  } else if (input.level === 'country') {
    const raw = input.countryCode ?? '';
    if (!isIsoCountryCode(raw)) {
      throw new ValidationError('国は ISO 3166-1 の 2 文字のコードで選んでください（例 JP）。');
    }
    countryCode = normalizeCountryCode(raw);
    targetCountry = countryCode;
    targetLabel = countryCode;
  } else if (input.level !== 'org_default') {
    throw new ValidationError('割り当てる範囲（拠点・国・全社既定）を選んでください。');
  }

  const factor = await db.findById('emissionFactors', input.factorId);
  if (!factor || factor.organizationId !== organizationId || !factor.factorSetId) {
    throw new ValidationError('割り当てられるのは係数のセットの係数だけです。');
  }
  const set = await db.findById('emissionFactorSets', factor.factorSetId);
  if (!set || set.status !== 'active') {
    throw new ValidationError('割り当てられるのは有効なセットの係数だけです。');
  }
  if (!factorFits(factor, input.activityKind, activityCode, basis)) {
    throw new ValidationError(
      `係数「${factor.code}」は ${needLabel(input.activityKind, activityCode, basis)} に使えません（種類・活動・基準が違います）。`,
    );
  }
  if (factor.countryCode && targetCountry && factor.countryCode !== targetCountry) {
    throw new ValidationError(
      `係数「${factor.code}」は ${factor.countryCode} の係数です。${targetLabel}（${targetCountry}）には使えません。`,
    );
  }

  const existing = (
    await db.select('emissionFactorAssignments', {
      where: { organizationId, reportingPeriodId: period.id },
    })
  ).find(
    (a) =>
      (a.unitId ?? null) === unitId &&
      (a.countryCode ?? null) === countryCode &&
      a.activityKind === input.activityKind &&
      a.activityCode === activityCode &&
      (a.basis ?? null) === basis,
  );
  const now = new Date().toISOString();
  const label = needLabel(input.activityKind, activityCode, basis);
  let saved: EmissionFactorAssignment;
  if (existing) {
    if (existing.factorId === factor.id && existing.reason === reason) {
      throw new ValidationError('いまの割当と同じです（変更はありません）。');
    }
    saved = await db.update('emissionFactorAssignments', existing.id, {
      factorId: factor.id,
      reason,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    if (db.mode === 'demo') {
      const count = await db.count('emissionFactorAssignments', { where: { organizationId } });
      if (count >= DEMO_GHG_LIMITS.assignments) {
        throw new ValidationError(
          `デモでは係数の割当は ${DEMO_GHG_LIMITS.assignments} 件までです。開示デモを初期状態に戻してから割り当ててください。`,
        );
      }
    }
    const row: EmissionFactorAssignment = {
      id: randomUUID(),
      organizationId,
      reportingPeriodId: period.id,
      unitId,
      countryCode,
      activityKind: input.activityKind,
      activityCode,
      basis,
      factorId: factor.id,
      reason,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    const [inserted] = await db.insert('emissionFactorAssignments', [row]);
    saved = inserted ?? row;
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'emission_factor_assignment',
    resourceId: saved.id,
    beforeSummary: existing ? `係数 ${existing.factorId}` : null,
    afterSummary: `${period.label} の ${targetLabel}・${label} に係数「${factor.code}」（${set.versionLabel}・${factor.factorYear} 年度）を割り当てた`,
    metadata: { factorId: factor.id, setId: set.id, level: input.level },
  });
  return saved;
}

/** 割当を外す（締めた期間は外せない。Demo Mode は利用者が作った割当だけ） */
export async function clearAssignment(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { assignmentId: Uuid },
): Promise<void> {
  assertManager(ctx);
  const organizationId = ctx.workspace.organizationId;
  const assignment = await db.findById('emissionFactorAssignments', options.assignmentId);
  if (!assignment || assignment.organizationId !== organizationId) {
    throw new NotFoundError('割当が見つかりません。');
  }
  const period = await loadOpenPeriod(db, ctx, assignment.reportingPeriodId);
  const label = needLabel(assignment.activityKind, assignment.activityCode, assignment.basis);
  if (db.mode === 'supabase') {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const client = await createSupabaseServerClient();
    const { error } = await client
      .from('emission_factor_assignments')
      .delete()
      .eq('id', assignment.id)
      .eq('organization_id', organizationId);
    if (error) throw new Error(`delete emission_factor_assignments: ${error.message}`);
  } else {
    if (pristineAssignmentIds().has(assignment.id)) {
      throw new ValidationError(DEMO_FIXTURE_ASSIGNMENT_REASON);
    }
    if (!(db instanceof DemoDbClient)) throw new Error('Demo Mode の DbClient ではありません。');
    await db.hardDeleteDemoRows('emissionFactorAssignments', new Set([assignment.id]));
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'emission_factor_assignment',
    resourceId: assignment.id,
    beforeSummary: `${period.label} の ${label}（係数 ${assignment.factorId}）`,
    afterSummary: `${period.label} の ${label} の割当を外した`,
    metadata: { factorId: assignment.factorId },
  });
}
