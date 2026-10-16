import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  can,
  NotFoundError,
} from '@/lib/authorization/can';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import {
  doubleCountWarnings,
  protocolScopeOf,
  ruleEffectiveIn,
  type DoubleCountWarning,
} from '@/lib/domain/ghg/classification';
import { ValidationError } from '@/lib/errors/user-facing';
import { isUuid } from '@/lib/validation/uuid';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import { loadScope3SupplierBreakdown } from '@/lib/services/scope3-suppliers';
import {
  CARRIER_KINDS,
  GHG_ACTIVITY_KINDS,
  type AuthorizationContext,
  type CarrierKind,
  type ClassificationMatch,
  type GhgActivityKind,
  type GhgClassificationRule,
  type GhgScope,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';

/**
 * 区分規則（plan §2.3 classification-rules.ts・CR-07。S1）。
 *
 * 既定区分（GHG プロトコル）と異なる報告区分にする組織の算定ルール（例: 委託物流を自社便と同様に Scope1 とする）。
 * 製品は方針の当否を判断しない。根拠・承認者・二重表示で透明にする（plan §5・N1）。
 *  - 提案は enterprise.metric.manage（本人名義・根拠は必須）。承認は enterprise.data.approve で、提案者本人は
 *    承認できない（サービス・RLS・トリガ・CHECK の 4 重。Demo の Cookie の検査も同じ）
 *  - 内容は変えない（取り下げて新しく提案する）。取り下げは metric.manage か data.approve
 *  - 再分類は Scope1 と Scope3 カテゴリ4 の間の移動だけ（二重表示の不変条件「報告の Scope1＋Scope3 ＝
 *    既定の Scope1＋Scope3」を保つ。Scope2 の 2 基準は動かさない）
 *  - 条件は既定区分が 1 つに決まるものにする（活動と輸送の担い手で絞る。例: 輸送 × 委託 → Scope3 カテゴリ4）
 *  - 同じ行に当てはまる承認済みの規則が 2 つあると算定は区分を変えない（どちらかを黙って選ばない）。
 *    承認のときに重なる承認済みの規則があれば断る
 * 監査ログは既存の種類（提案・取り下げ＝settings_changed、承認＝data_approved）。AI は使わない。
 */

/** 再分類で動かせる区分（二重表示の不変条件を保つ） */
export const RECLASSIFIABLE_SCOPES = [
  'scope1',
  'scope3_cat4',
] as const satisfies readonly GhgScope[];

/** 貨物の区分の表示名（取込の語「主要製品」と同じ） */
export const CARGO_KIND_LABELS: Readonly<Record<string, string>> = {
  main_product: '主要製品',
};

export function cargoKindLabel(kind: string): string {
  return CARGO_KIND_LABELS[kind] ?? kind;
}

/** 入力の語 → 貨物の区分のコード（「主要製品」は main_product。それ以外はそのまま） */
export function parseCargoKind(raw: string): string {
  const text = raw.normalize('NFKC').trim();
  const hit = Object.entries(CARGO_KIND_LABELS).find(([, label]) => label === text);
  return hit ? hit[0] : text;
}

export const CARRIER_KIND_LABELS: Record<CarrierKind, string> = {
  own_fleet: '自社便',
  contracted: '委託（自社が荷主の外部業者）',
};

export interface RuleView {
  rule: GhgClassificationRule;
  proposerName: string | null;
  approverName: string | null;
  withdrawerName: string | null;
  fromPeriod: ReportingPeriod | null;
  toPeriod: ReportingPeriod | null;
  /** 条件の文（例「輸送 × 委託 × 主要製品」） */
  matchText: string;
}

function matchText(match: ClassificationMatch, unitNames: Map<Uuid, string>): string {
  const parts: string[] = [];
  const kinds: Record<GhgActivityKind, string> = {
    fuel: '燃料',
    electricity: '電力',
    gas: 'ガス',
    heat: '熱',
    transport: '輸送',
  };
  if (match.activityKinds?.length) parts.push(match.activityKinds.map((k) => kinds[k]).join('・'));
  if (match.carrierKinds?.length) {
    parts.push(match.carrierKinds.map((k) => CARRIER_KIND_LABELS[k]).join('・'));
  }
  if (match.cargoKinds?.length)
    parts.push(`貨物 ${match.cargoKinds.map(cargoKindLabel).join('・')}`);
  if (match.unitIds?.length) {
    parts.push(`拠点 ${match.unitIds.map((id) => unitNames.get(id) ?? '（不明）').join('・')}`);
  }
  return parts.length > 0 ? parts.join(' × ') : 'すべての活動';
}

export async function listClassificationRules(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<RuleView[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const [rules, periods, units] = await Promise.all([
    db.select('ghgClassificationRules', { where: { organizationId } }),
    db.select('periods', { where: { organizationId } }),
    db.select('units', { where: { organizationId } }),
  ]);
  const ids = [
    ...new Set(
      rules
        .flatMap((r) => [r.proposedBy, r.approvedBy, r.withdrawnBy])
        .filter((id): id is Uuid => !!id),
    ),
  ];
  const profiles =
    ids.length > 0 ? await db.select('profiles', { where: { id: { in: ids } } }) : [];
  const names = new Map(profiles.map((p) => [p.id, p.displayName]));
  const unitNames = new Map(units.map((u) => [u.id, u.name]));
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const order: Record<GhgClassificationRule['status'], number> = {
    proposed: 0,
    approved: 1,
    withdrawn: 2,
  };
  return rules
    .map((rule) => ({
      rule,
      proposerName: names.get(rule.proposedBy) ?? null,
      approverName: rule.approvedBy ? (names.get(rule.approvedBy) ?? null) : null,
      withdrawerName: rule.withdrawnBy ? (names.get(rule.withdrawnBy) ?? null) : null,
      fromPeriod: rule.effectiveFromPeriodId
        ? (periodById.get(rule.effectiveFromPeriodId) ?? null)
        : null,
      toPeriod: rule.effectiveToPeriodId
        ? (periodById.get(rule.effectiveToPeriodId) ?? null)
        : null,
      matchText: matchText(rule.match, unitNames),
    }))
    .sort(
      (a, b) =>
        order[a.rule.status] - order[b.rule.status] ||
        b.rule.createdAt.localeCompare(a.rule.createdAt),
    );
}

/** 条件から決まる既定区分（1 つに決まらなければ null） */
export function protocolScopesOfMatch(match: ClassificationMatch): GhgScope[] {
  const kinds = match.activityKinds?.length ? match.activityKinds : [...GHG_ACTIVITY_KINDS];
  const carriers: Array<CarrierKind | null> = match.carrierKinds?.length
    ? match.carrierKinds
    : [...CARRIER_KINDS, null];
  const scopes = new Set<GhgScope>();
  for (const kind of kinds) {
    const methods =
      kind === 'electricity'
        ? (['electricity_location', 'electricity_market'] as const)
        : kind === 'heat'
          ? (['heat_location', 'heat_market'] as const)
          : (['fuel_combustion'] as const);
    for (const method of methods) {
      for (const carrierKind of kind === 'transport' ? carriers : [null]) {
        scopes.add(
          protocolScopeOf({ unitId: '', activityKind: kind, method, carrierKind, cargoKind: null }),
        );
      }
    }
  }
  return [...scopes];
}

/** 2 つの条件が同じ行に当てはまりうるか（どの項目も重なる。空はすべて） */
function matchesOverlap(a: ClassificationMatch, b: ClassificationMatch): boolean {
  const overlap = (x?: readonly string[], y?: readonly string[]) =>
    !x?.length || !y?.length || x.some((v) => y.includes(v));
  return (
    overlap(a.activityKinds, b.activityKinds) &&
    overlap(a.carrierKinds, b.carrierKinds) &&
    overlap(a.cargoKinds, b.cargoKinds) &&
    overlap(a.unitIds, b.unitIds)
  );
}

/** 2 つの規則の適用期間が重なるか（期間の開始・終了日で比べる。端が無い側は無限） */
function periodsOverlap(
  a: GhgClassificationRule,
  b: GhgClassificationRule,
  periods: readonly ReportingPeriod[],
): boolean {
  const start = (r: GhgClassificationRule) =>
    periods.find((p) => p.id === r.effectiveFromPeriodId)?.startDate ?? '0000-01-01';
  const end = (r: GhgClassificationRule) =>
    periods.find((p) => p.id === r.effectiveToPeriodId)?.endDate ?? '9999-12-31';
  return start(a) <= end(b) && start(b) <= end(a);
}

export interface ProposeRuleInput {
  code: string;
  name: string;
  match: ClassificationMatch;
  reportedScope: string;
  rationale: string;
  disclosureNote: string;
  effectiveFromPeriodId: Uuid | null;
  effectiveToPeriodId: Uuid | null;
}

/** 区分規則を提案する（本人名義・状態は承認待ち） */
export async function proposeRule(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ProposeRuleInput,
): Promise<GhgClassificationRule> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
  const organizationId = ctx.workspace.organizationId;
  const demo = db.mode === 'demo';
  const textMax = demo ? DEMO_GHG_LIMITS.ruleText : 2000;

  const code = input.code.normalize('NFKC').trim();
  const name = input.name.trim();
  const rationale = input.rationale.trim();
  const disclosureNote = input.disclosureNote.trim();
  if (code === '' || /\s/.test(code) || code.length > 40) {
    throw new ValidationError('規則のコードは空白なしの 40 文字までで入力してください。');
  }
  if (name === '' || name.length > 200) {
    throw new ValidationError('規則の名称は 200 文字までで入力してください。');
  }
  if (rationale === '') {
    throw new ValidationError('根拠を入力してください（なぜ既定区分と違う区分にするのか）。');
  }
  if (rationale.length > textMax) throw new ValidationError(`根拠は ${textMax} 文字までです。`);
  if (disclosureNote.length > textMax) {
    throw new ValidationError(`開示の注記は ${textMax} 文字までです。`);
  }

  const [units, periods, rules] = await Promise.all([
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('periods', { where: { organizationId } }),
    db.select('ghgClassificationRules', { where: { organizationId } }),
  ]);
  const match: ClassificationMatch = {};
  const activityKinds = [...new Set(input.match.activityKinds ?? [])];
  if (activityKinds.some((k) => !(GHG_ACTIVITY_KINDS as readonly string[]).includes(k))) {
    throw new ValidationError('条件の活動を読めません。');
  }
  if (activityKinds.length > 0) match.activityKinds = activityKinds;
  const carrierKinds = [...new Set(input.match.carrierKinds ?? [])];
  if (carrierKinds.some((k) => !(CARRIER_KINDS as readonly string[]).includes(k))) {
    throw new ValidationError('条件の輸送の担い手を読めません。');
  }
  if (carrierKinds.length > 0) match.carrierKinds = carrierKinds;
  const cargoKinds = [
    ...new Set((input.match.cargoKinds ?? []).map(parseCargoKind).filter((k) => k !== '')),
  ];
  if (cargoKinds.length > 20 || cargoKinds.some((k) => k.length > 40)) {
    throw new ValidationError('貨物の区分は 20 件まで・各 40 文字までです。');
  }
  if (cargoKinds.length > 0) match.cargoKinds = cargoKinds;
  const unitIds = [...new Set(input.match.unitIds ?? [])];
  if (unitIds.some((id) => !units.some((u) => u.id === id))) {
    throw new ValidationError('条件の拠点が見つかりません。');
  }
  if (unitIds.length > 0) match.unitIds = unitIds;

  const scopes = protocolScopesOfMatch(match);
  if (scopes.length !== 1) {
    throw new ValidationError(
      '条件を、既定区分が 1 つに決まるよう活動と輸送の担い手で絞ってください（例: 輸送 × 委託 → Scope3 カテゴリ4）。',
    );
  }
  const protocolScope = scopes[0]!;
  const reportedScope = input.reportedScope as GhgScope;
  const movable = RECLASSIFIABLE_SCOPES as readonly string[];
  if (!movable.includes(protocolScope)) {
    throw new ValidationError(
      `既定区分が ${GHG_SCOPE_LABELS[protocolScope]} の活動は再分類できません（再分類は Scope1 と Scope3 カテゴリ4 の間だけ）。`,
    );
  }
  if (!movable.includes(reportedScope)) {
    throw new ValidationError('報告区分は Scope1 か Scope3 カテゴリ4 を選んでください。');
  }
  if (reportedScope === protocolScope) {
    throw new ValidationError('報告区分が既定区分と同じです（区分を変えない規則は作りません）。');
  }

  const from = input.effectiveFromPeriodId
    ? periods.find((p) => p.id === input.effectiveFromPeriodId)
    : null;
  const to = input.effectiveToPeriodId
    ? periods.find((p) => p.id === input.effectiveToPeriodId)
    : null;
  if (input.effectiveFromPeriodId && !from)
    throw new NotFoundError('適用開始の期間が見つかりません。');
  if (input.effectiveToPeriodId && !to) throw new NotFoundError('適用終了の期間が見つかりません。');
  if (from && to && from.startDate > to.endDate) {
    throw new ValidationError('適用開始の期間が適用終了の期間より後です。');
  }
  if (rules.some((r) => r.code === code && r.status !== 'withdrawn')) {
    throw new ValidationError(
      `規則のコード「${code}」は既にあります（取り下げた規則のコードだけ使い直せます）。`,
    );
  }
  if (demo && rules.length >= DEMO_GHG_LIMITS.rules) {
    throw new ValidationError(
      `デモでは区分規則は ${DEMO_GHG_LIMITS.rules} 件までです。開示デモを初期状態に戻してから提案してください。`,
    );
  }

  const now = new Date().toISOString();
  const rule: GhgClassificationRule = {
    id: randomUUID(),
    organizationId,
    code,
    name,
    match,
    protocolScope,
    reportedScope,
    rationale,
    disclosureNote,
    effectiveFromPeriodId: from?.id ?? null,
    effectiveToPeriodId: to?.id ?? null,
    status: 'proposed',
    proposedBy: ctx.userId,
    approvedBy: null,
    approvedAt: null,
    withdrawnBy: null,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const [inserted] = await db.insert('ghgClassificationRules', [rule]);
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'ghg_classification_rule',
    resourceId: rule.id,
    afterSummary: `区分規則「${rule.name}」（${rule.code}）を提案（${GHG_SCOPE_LABELS[protocolScope]} → ${GHG_SCOPE_LABELS[reportedScope]}。承認待ち）`,
    metadata: { protocolScope, reportedScope, match },
  });
  return inserted ?? rule;
}

async function loadOwnRule(
  db: DbClient,
  ctx: AuthorizationContext,
  ruleId: Uuid,
): Promise<GhgClassificationRule> {
  // UUID でない ID は DB に問い合わせない（Supabase Mode では 22P02 の例外＝500 になるため。見つからない扱い）
  if (!isUuid(ruleId)) throw new NotFoundError('区分規則が見つかりません。');
  const rule = await db.findById('ghgClassificationRules', ruleId);
  if (!rule || rule.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('区分規則が見つかりません。');
  }
  return rule;
}

/** 承認の可否の理由（画面の disabledReason。承認できるなら null） */
export function approvalBlockedReason(
  ctx: AuthorizationContext,
  rule: Pick<GhgClassificationRule, 'status' | 'proposedBy'>,
): string | null {
  if (!can(ctx, 'enterprise.data.approve')) return 'データの承認権限が必要です。';
  if (rule.status !== 'proposed') return '承認待ちの規則だけ承認できます。';
  if (rule.proposedBy === ctx.userId) return '提案者は承認できません（職務分離）。';
  return null;
}

/** 承認する（提案者以外の enterprise.data.approve。本人名義） */
export async function approveRule(
  db: DbClient,
  ctx: AuthorizationContext,
  ruleId: Uuid,
): Promise<GhgClassificationRule> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.approve');
  const rule = await loadOwnRule(db, ctx, ruleId);
  if (rule.proposedBy === ctx.userId) {
    throw new AuthorizationError('提案者は承認できません。', 'enterprise.data.approve');
  }
  if (rule.status !== 'proposed') {
    throw new ValidationError('承認できるのは承認待ちの規則だけです。');
  }
  const organizationId = ctx.workspace.organizationId;
  const [rules, periods] = await Promise.all([
    db.select('ghgClassificationRules', { where: { organizationId } }),
    db.select('periods', { where: { organizationId } }),
  ]);
  const conflict = rules.find(
    (r) =>
      r.id !== rule.id &&
      r.status === 'approved' &&
      r.protocolScope === rule.protocolScope &&
      matchesOverlap(r.match, rule.match) &&
      periodsOverlap(r, rule, periods),
  );
  if (conflict) {
    throw new ValidationError(
      `同じ活動に当てはまる承認済みの規則「${conflict.name}」（${conflict.code}）があります。先にそちらを取り下げてください（2 つ当てはまると区分は変わりません）。`,
    );
  }
  const now = new Date().toISOString();
  const updated = await db.update('ghgClassificationRules', rule.id, {
    status: 'approved',
    approvedBy: ctx.userId,
    approvedAt: now,
    updatedAt: now,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_approved',
    resourceType: 'ghg_classification_rule',
    resourceId: rule.id,
    beforeSummary: '承認待ち',
    afterSummary: `区分規則「${rule.name}」（${rule.code}）を承認（${GHG_SCOPE_LABELS[rule.protocolScope]} → ${GHG_SCOPE_LABELS[rule.reportedScope]}）`,
    metadata: { proposedBy: rule.proposedBy },
  });
  return updated;
}

/** 取り下げる（承認待ち・承認済み。metric.manage か data.approve。本人名義） */
export async function withdrawRule(
  db: DbClient,
  ctx: AuthorizationContext,
  ruleId: Uuid,
  options: { reason: string },
): Promise<GhgClassificationRule> {
  assertEnterpriseWorkspace(ctx);
  if (!can(ctx, 'enterprise.metric.manage') && !can(ctx, 'enterprise.data.approve')) {
    assertCan(ctx, 'enterprise.metric.manage');
  }
  const rule = await loadOwnRule(db, ctx, ruleId);
  if (rule.status === 'withdrawn') throw new ValidationError('この規則は取り下げ済みです。');
  const reason = options.reason.trim();
  if (reason.length > 300) throw new ValidationError('取り下げの理由は 300 文字までです。');
  const now = new Date().toISOString();
  const updated = await db.update('ghgClassificationRules', rule.id, {
    status: 'withdrawn',
    withdrawnBy: ctx.userId,
    withdrawnAt: now,
    updatedAt: now,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'ghg_classification_rule',
    resourceId: rule.id,
    beforeSummary: rule.status === 'approved' ? '承認済み' : '承認待ち',
    afterSummary: `区分規則「${rule.name}」（${rule.code}）を取り下げた${reason ? `（理由: ${reason}）` : ''}`,
    metadata: { reason: reason || null },
  });
  return updated;
}

export interface DoubleCountCheck {
  rule: GhgClassificationRule;
  warnings: DoubleCountWarning[];
}

/**
 * 二重計上の確認（plan CR-07。規則ベース・AI なし）。期間に効く（承認済み）か承認を待つ区分規則のうち、委託物流を
 * Scope3 カテゴリ4 から動かす規則について、同じ期間の Scope3 Cat.1 の算定内訳に物流の購入を数えた行が無いかを
 * 調べる（同じ輸送を Scope1 と Scope3 の両方に計上していないかを人が確かめるための知らせ。止めない）
 */
export async function listDoubleCountChecks(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<DoubleCountCheck[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const [rules, periods] = await Promise.all([
    db.select('ghgClassificationRules', { where: { organizationId } }),
    db.select('periods', { where: { organizationId } }),
  ]);
  const period = periods.find((p) => p.id === periodId);
  if (!period) throw new NotFoundError('報告期間が見つかりません。');
  const moving = rules.filter(
    (r) =>
      r.status !== 'withdrawn' &&
      r.protocolScope === 'scope3_cat4' &&
      r.reportedScope !== 'scope3_cat4' &&
      ruleEffectiveIn(r, period, periods),
  );
  if (moving.length === 0) return [];
  const breakdown = await loadScope3SupplierBreakdown(db, ctx, periodId);
  const inputs = breakdown.calculation?.inputs ?? [];
  if (inputs.length === 0) return [];
  return moving
    .map((rule) => ({
      rule,
      warnings: doubleCountWarnings(
        [
          {
            activityKind: 'transport' as const,
            protocolScope: rule.protocolScope,
            reportedScope: rule.reportedScope,
            classificationRuleId: rule.id,
          },
        ],
        inputs,
      ),
    }))
    .filter((check) => check.warnings.length > 0);
}

/** 期間に効く承認済みの規則か（画面の「この期間に効く」表示） */
export function ruleAppliesTo(
  rule: GhgClassificationRule,
  period: ReportingPeriod,
  periods: readonly ReportingPeriod[],
): boolean {
  return rule.status === 'approved' && ruleEffectiveIn(rule, period, periods);
}
