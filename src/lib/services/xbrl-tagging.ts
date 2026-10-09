import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { runAi, type XbrlTagSuggestionOutput } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError, assertCan, assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import type { ReportSnapshotDetail } from '@/lib/domain/report-snapshot-content';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { asSnapshotDetail, loadOwnedProject } from '@/lib/services/report-snapshot';
import { isUuid } from '@/lib/validation/uuid';
import type { XbrlMappingState } from '@/lib/ui/status/xbrlMapping';
import { periodRelation, type XbrlEntity } from '@/lib/xbrl/context';
import { mappingsInScope } from '@/lib/xbrl/facts';
import type { XbrlFinding, XbrlSeverity } from '@/lib/xbrl/rules';
import {
  axesOf,
  conceptQName,
  conceptValueClass,
  findConceptById,
  isNumericConcept,
  valueConceptsOf,
  type TaxonomyConcept,
  type TaxonomyPackage,
} from '@/lib/xbrl/taxonomy';
import { mapUnit } from '@/lib/xbrl/unit-map';
import { mappingValidationState } from '@/lib/xbrl/validate';
import {
  evaluateXbrl,
  loadTaxonomyPackage,
  loadXbrlInputs,
  type XbrlEvaluation,
} from '@/lib/services/xbrl-export';
import {
  FILING_IDENTIFIER_SCHEMES,
  XBRL_PERIOD_ROLES,
  type AuthorizationContext,
  type FilingIdentifierScheme,
  type IsoDateTime,
  type OrganizationFilingIdentifier,
  type ReportSnapshotKind,
  type Uuid,
  type XbrlMappingEventType,
  type XbrlMappingOrigin,
  type XbrlPeriodRole,
  type XbrlTagMapping,
  type XbrlTargetKind,
} from '@/types/domain';
import { verifySnapshotIntegrity } from '@/lib/services/report-snapshot';

/**
 * XBRL のタグの対応付け（トライアル対応 NF-42 Stage 1。plan §3.4 xbrl-tagging.ts）。
 *
 * - 読む: enterprise.disclosure.read。書く（作成・変更・対象外・削除・AI の候補）: enterprise.disclosure.write。
 *   確定: enterprise.disclosure.approve かつ、対応付けを作った人・最後に内容を変えた人と別の人
 *   （DB のトリガ・CHECK と Demo の Cookie の検査と同じ規則。サービスでも先に断る）
 * - AI の候補は「候補」の行として入り、人の確定でだけ「確定」になる（AI は確定しない）
 * - 内容を変えた確定済み・対象外の対応付けは候補に戻る（確定し直す）
 * - 変更・確定・対象外は追記専用の履歴（xbrl_tag_mapping_events）と監査ログに残す
 * - 提出者の識別子は企業の管理者（enterprise.org.manage）。デモは架空の sample だけ
 * - 権限は ID の検索より先に確かめる。他テナントの行は「見つからない」
 */

// ----------------------------------------------------------------------
// 対象（T4D の数値・節）の鍵
// ----------------------------------------------------------------------

export type MappingTarget =
  | { kind: 'metric'; metricId: Uuid; unitId: Uuid | null; boundary: string | null }
  | { kind: 'block'; frameworkVersionId: Uuid; sectionKey: string };

export function targetKeyOf(target: MappingTarget): string {
  return target.kind === 'metric'
    ? `metric|${target.metricId}|${target.unitId ?? ''}|${encodeURIComponent(target.boundary ?? '')}`
    : `block|${target.frameworkVersionId}|${encodeURIComponent(target.sectionKey)}`;
}

export function parseTargetKey(key: string): MappingTarget | null {
  const [kind, a = '', b = '', c = ''] = key.split('|');
  try {
    if (kind === 'metric' && isUuid(a) && (b === '' || isUuid(b))) {
      const boundary = decodeURIComponent(c);
      return { kind: 'metric', metricId: a, unitId: b || null, boundary: boundary || null };
    }
    if (kind === 'block' && isUuid(a) && b !== '') {
      return { kind: 'block', frameworkVersionId: a, sectionKey: decodeURIComponent(b) };
    }
  } catch {
    return null;
  }
  return null;
}

function targetOfMapping(m: XbrlTagMapping): MappingTarget | null {
  if (m.targetKind === 'metric' && m.metricId) {
    return { kind: 'metric', metricId: m.metricId, unitId: m.unitId, boundary: m.boundary };
  }
  if (m.targetKind === 'block' && m.frameworkVersionId && m.sectionKey) {
    return { kind: 'block', frameworkVersionId: m.frameworkVersionId, sectionKey: m.sectionKey };
  }
  return null;
}

export const XBRL_PERIOD_ROLE_LABELS: Record<XbrlPeriodRole, string> = {
  current: '当年度',
  prior1: '前年度',
  base_year: '基準年',
  target: '目標',
};

export function parsePeriodRole(value: unknown): XbrlPeriodRole {
  return XBRL_PERIOD_ROLES.includes(value as XbrlPeriodRole)
    ? (value as XbrlPeriodRole)
    : 'current';
}

// ----------------------------------------------------------------------
// タブの表示モデル
// ----------------------------------------------------------------------

export interface XbrlTargetOption {
  key: string;
  kind: 'metric' | 'block';
  label: string;
  /** 本文の数値の期間から推した期間の役割（作成フォームの既定） */
  periodRole: XbrlPeriodRole;
  requirementItemIds: Uuid[];
}

export interface XbrlMappingRow {
  /** 行の ID（対応付けの ID、未対応付けは対象の鍵と期間の役割） */
  id: string;
  mapping: XbrlTagMapping | null;
  state: XbrlMappingState;
  targetKind: XbrlTargetKind;
  targetKey: string | null;
  targetLabel: string;
  targetDetail: string;
  periodRole: XbrlPeriodRole;
  concept: TaxonomyConcept | null;
  conceptQName: string | null;
  measure: string | null;
  decimals: number | null;
  dimensionLabels: string[];
  requirements: Array<{ itemId: Uuid; code: string }>;
  validation: XbrlSeverity | 'passed' | null;
  findings: XbrlFinding[];
  createdByName: string | null;
  confirmedByName: string | null;
  confirmedAt: IsoDateTime | null;
  origin: XbrlMappingOrigin | null;
  aiProvider: 'openai' | 'mock' | null;
  /** 閲覧者が確定できるか。できなければ理由（承認権限のある人にだけ意味がある） */
  confirmBlockedReason: string | null;
}

export interface XbrlFrameworkOption {
  projectFrameworkId: Uuid;
  frameworkVersionId: Uuid;
  frameworkKey: string;
  label: string;
  packageId: Uuid | null;
  packageName: string | null;
  packageOptions: Array<{ id: Uuid; label: string; isSample: boolean }>;
  inSnapshot: boolean;
}

export interface XbrlSnapshotOption {
  id: Uuid;
  snapshotNo: number;
  kind: ReportSnapshotKind;
  label: string;
  createdAt: IsoDateTime;
}

export interface XbrlTabModel {
  project: { id: Uuid; name: string; reportingPeriodId: Uuid };
  snapshots: XbrlSnapshotOption[];
  snapshot: ReportSnapshotDetail | null;
  integrityOk: boolean;
  frameworks: XbrlFrameworkOption[];
  frameworkVersionId: Uuid | null;
  pkg: TaxonomyPackage | null;
  evaluation: XbrlEvaluation | null;
  rows: XbrlMappingRow[];
  counts: {
    confirmed: number;
    candidate: number;
    excluded: number;
    mappings: number;
    unmapped: number;
    targets: number;
  };
  targetOptions: XbrlTargetOption[];
  requirementOptions: Array<{ itemId: Uuid; code: string; title: string }>;
  identifiers: OrganizationFilingIdentifier[];
  entity: XbrlEntity | null;
  permissions: {
    canWrite: boolean;
    canApprove: boolean;
    canExport: boolean;
    canRunAi: boolean;
    canManageOrg: boolean;
  };
  demoMode: boolean;
}

function roleOfValue(
  mv: { periodStart: string; periodEnd: string; valueKind: string },
  report: { start: string; end: string },
): XbrlPeriodRole {
  if (mv.valueKind === 'target') return 'target';
  const relation = periodRelation({ start: mv.periodStart, end: mv.periodEnd }, report);
  return relation === 'current' ? 'current' : relation === 'prior1' ? 'prior1' : 'base_year';
}

function covers(mapping: XbrlTagMapping, target: MappingTarget, role: XbrlPeriodRole): boolean {
  if (mapping.deletedAt !== null) return false;
  if (target.kind === 'block') {
    return (
      mapping.targetKind === 'block' &&
      mapping.frameworkVersionId === target.frameworkVersionId &&
      mapping.sectionKey === target.sectionKey
    );
  }
  return (
    mapping.targetKind === 'metric' &&
    mapping.metricId === target.metricId &&
    (mapping.unitId === null || mapping.unitId === target.unitId) &&
    (mapping.boundary === null || mapping.boundary === target.boundary) &&
    mapping.periodRole === role
  );
}

/** 確定できない理由（承認権限のある閲覧者向け。null なら確定できる） */
export function confirmBlockedReason(
  ctx: Pick<AuthorizationContext, 'userId'>,
  mapping: XbrlTagMapping,
  pkg: Pick<TaxonomyPackage, 'concepts'>,
): string | null {
  if (mapping.status !== 'candidate') return '候補の対応付けだけを確定できます。';
  if (mapping.createdBy === ctx.userId) {
    return '対応付けを作った人は確定できません（職務分離）。別の承認者に依頼してください。';
  }
  if (mapping.updatedBy === ctx.userId) {
    return '最後に内容を変えた人は確定できません（職務分離）。別の承認者に依頼してください。';
  }
  const concept = findConceptById(pkg, mapping.conceptId);
  if (mapping.targetKind === 'metric' && concept && isNumericConcept(concept)) {
    if (mapping.decimals === null) return '精度（decimals）を設定してから確定してください。';
    if (axesOf(pkg).length > 0 && Object.keys(mapping.dimensions ?? {}).length === 0) {
      return '境界を表す軸メンバーを設定してから確定してください。';
    }
  }
  return null;
}

async function profileNames(
  db: DbClient,
  ids: readonly (Uuid | null)[],
): Promise<Map<Uuid, string>> {
  const unique = [...new Set(ids.filter((id): id is Uuid => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db.select('profiles', { where: { id: { in: unique } } });
  return new Map(rows.map((p) => [p.id, p.displayName]));
}

export async function loadXbrlTab(
  db: DbClient,
  ctx: AuthorizationContext,
  request: { projectId: Uuid; snapshotId?: string | null; frameworkVersionId?: string | null },
): Promise<XbrlTabModel> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const project = await loadOwnedProject(db, ctx, request.projectId);
  const organizationId = ctx.workspace.organizationId;

  const [snapshotRows, projectFrameworks, packages, identifiers] = await Promise.all([
    db.select('reportSnapshots', {
      where: { organizationId, projectId: project.id },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'desc' },
      ],
    }),
    db.select('projectFrameworks', { where: { organizationId, projectId: project.id } }),
    db.select('xbrlTaxonomyPackages'),
    db.select('organizationFilingIdentifiers', { where: { organizationId } }),
  ]);
  const versions =
    projectFrameworks.length === 0
      ? []
      : await db.select('frameworkVersions', {
          where: { id: { in: projectFrameworks.map((pf) => pf.frameworkVersionId) } },
        });
  const frameworks =
    versions.length === 0
      ? []
      : await db.select('frameworks', {
          where: { id: { in: [...new Set(versions.map((v) => v.frameworkId))] } },
        });

  const snapshots: XbrlSnapshotOption[] = snapshotRows.map((s) => ({
    id: s.id,
    snapshotNo: s.snapshotNo,
    kind: s.snapshotKind,
    label: s.label,
    createdAt: s.createdAt,
  }));
  const pickedRow =
    snapshotRows.find((s) => s.id === request.snapshotId) ??
    snapshotRows.find((s) => s.snapshotKind === 'approved') ??
    snapshotRows[0] ??
    null;
  const snapshot = pickedRow ? asSnapshotDetail(pickedRow) : null;
  const integrityOk = snapshot ? verifySnapshotIntegrity(snapshot) : true;
  const snapshotVersionIds = new Set(snapshot?.frameworkVersions.map((f) => f.frameworkVersionId));

  const frameworkOptions: XbrlFrameworkOption[] = projectFrameworks.map((pf) => {
    const version = versions.find((v) => v.id === pf.frameworkVersionId);
    const framework = frameworks.find((f) => f.id === version?.frameworkId);
    const pkg = packages.find((p) => p.id === pf.taxonomyPackageId) ?? null;
    return {
      projectFrameworkId: pf.id,
      frameworkVersionId: pf.frameworkVersionId,
      frameworkKey: framework?.key ?? '',
      label: `${framework?.name ?? '基準'}（${version?.label ?? '版不明'}）`,
      packageId: pkg?.id ?? null,
      packageName: pkg ? `${pkg.name}（${pkg.versionLabel}）` : null,
      packageOptions: packages
        .filter((p) => p.frameworkKey === framework?.key)
        .map((p) => ({
          id: p.id,
          label: `${p.name}（${p.versionLabel}）`,
          isSample: p.profile === 'sample' || p.legalStatus === 'sample',
        })),
      inSnapshot: snapshotVersionIds.has(pf.frameworkVersionId),
    };
  });

  const permissions = {
    canWrite: can(ctx, 'enterprise.disclosure.write'),
    canApprove: can(ctx, 'enterprise.disclosure.approve'),
    canExport: can(ctx, 'enterprise.export.run'),
    canRunAi: can(ctx, 'enterprise.ai.run') && can(ctx, 'enterprise.disclosure.write'),
    canManageOrg: can(ctx, 'enterprise.org.manage'),
  };
  const base: XbrlTabModel = {
    project: { id: project.id, name: project.name, reportingPeriodId: project.reportingPeriodId },
    snapshots,
    snapshot,
    integrityOk,
    frameworks: frameworkOptions,
    frameworkVersionId: null,
    pkg: null,
    evaluation: null,
    rows: [],
    counts: { confirmed: 0, candidate: 0, excluded: 0, mappings: 0, unmapped: 0, targets: 0 },
    targetOptions: [],
    requirementOptions: [],
    identifiers,
    entity: null,
    permissions,
    demoMode: db.mode === 'demo',
  };
  if (!snapshot) return base;

  const requested =
    request.frameworkVersionId && snapshotVersionIds.has(request.frameworkVersionId)
      ? request.frameworkVersionId
      : null;
  const inputs = await loadXbrlInputs(db, ctx, snapshot, requested);
  const evaluation = integrityOk ? evaluateXbrl(inputs) : null;
  const pkg = inputs.pkg;
  const framework = snapshot.frameworkVersions.find(
    (f) => f.frameworkVersionId === inputs.frameworkVersionId,
  );
  const report = framework
    ? { start: framework.periodStart, end: framework.periodEnd }
    : { start: '', end: '' };
  const blocks = snapshot.blocks
    .filter((b) => b.frameworkVersionId === inputs.frameworkVersionId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 対象（本文の節と、本文が引用した数値）
  const cited = new Set<string>();
  for (const block of blocks) {
    for (const p of block.body.paragraphs) {
      for (const c of p.children) if (c.t === 'metric') cited.add(c.dataPointVersionId);
    }
  }
  const targetOptions: XbrlTargetOption[] = [];
  const unmapped: XbrlMappingRow[] = [];
  const seen = new Set<string>();
  const scopedMappings = pkg ? inputs.mappings : [];
  for (const block of blocks) {
    const target: MappingTarget = {
      kind: 'block',
      frameworkVersionId: block.frameworkVersionId,
      sectionKey: block.sectionKey,
    };
    const key = targetKeyOf(target);
    const requirementItemIds = block.requirements.map((r) => r.itemId);
    targetOptions.push({
      key,
      kind: 'block',
      label: `節: ${block.title}`,
      periodRole: 'current',
      requirementItemIds,
    });
    if (!scopedMappings.some((m) => covers(m, target, 'current'))) {
      unmapped.push(
        unmappedRow(
          key,
          'current',
          'block',
          block.title,
          '節（テキストブロック）',
          block.requirements,
        ),
      );
    }
  }
  for (const mv of snapshot.metricValues.filter((v) => cited.has(v.dataPointVersionId))) {
    const target: MappingTarget = {
      kind: 'metric',
      metricId: mv.metricId,
      unitId: mv.unitId,
      boundary: mv.boundary,
    };
    const role = roleOfValue(mv, report);
    const key = targetKeyOf(target);
    if (seen.has(`${key}#${role}`)) continue;
    seen.add(`${key}#${role}`);
    const citing = blocks.filter((b) =>
      b.body.paragraphs.some((p) =>
        p.children.some((c) => c.t === 'metric' && c.dataPointVersionId === mv.dataPointVersionId),
      ),
    );
    const requirements = citing.flatMap((b) => b.requirements);
    if (!targetOptions.some((o) => o.key === key)) {
      targetOptions.push({
        key,
        kind: 'metric',
        label: `数値: ${mv.metricName}（${mv.unitName}・${mv.boundary}）`,
        periodRole: role,
        requirementItemIds: [...new Set(requirements.map((r) => r.itemId))],
      });
    }
    if (!scopedMappings.some((m) => covers(m, target, role))) {
      unmapped.push(
        unmappedRow(
          `${key}#${role}`,
          role,
          'metric',
          mv.metricName,
          `${mv.unitName}・${mv.boundary}・${mv.periodCode}（${mv.unitOfMeasure}）`,
          requirements,
          key,
        ),
      );
    }
  }

  // 対応付けの行
  const names = await profileNames(
    db,
    scopedMappings.flatMap((m) => [m.createdBy, m.confirmedBy]),
  );
  const aiRunIds = [...new Set(scopedMappings.flatMap((m) => (m.aiRunId ? [m.aiRunId] : [])))];
  const aiRuns =
    aiRunIds.length === 0 ? [] : await db.select('aiRuns', { where: { id: { in: aiRunIds } } });
  const metricIds = [...new Set(scopedMappings.flatMap((m) => (m.metricId ? [m.metricId] : [])))];
  const unitIds = [...new Set(scopedMappings.flatMap((m) => (m.unitId ? [m.unitId] : [])))];
  const [metricRows, unitRows] = await Promise.all([
    metricIds.length === 0
      ? Promise.resolve([])
      : db.select('metrics', { where: { organizationId, id: { in: metricIds } } }),
    unitIds.length === 0
      ? Promise.resolve([])
      : db.select('units', { where: { organizationId, id: { in: unitIds } } }),
  ]);
  const itemIds = [
    ...new Set(scopedMappings.flatMap((m) => (m.disclosureItemId ? [m.disclosureItemId] : []))),
  ];
  const requirementOptionsRows = await db.select('disclosureItems', {
    where: { frameworkVersionId: inputs.frameworkVersionId },
    orderBy: [{ column: 'sortOrder' }, { column: 'code' }],
  });
  const extraItems = itemIds.filter((id) => !requirementOptionsRows.some((i) => i.id === id));
  const itemRows = [
    ...requirementOptionsRows,
    ...(extraItems.length === 0
      ? []
      : await db.select('disclosureItems', { where: { id: { in: extraItems } } })),
  ];

  const mappingRows: XbrlMappingRow[] = scopedMappings
    .filter((m) => m.deletedAt === null)
    .map((m) => {
      const concept = pkg ? findConceptById(pkg, m.conceptId) : null;
      const metric = metricRows.find((x) => x.id === m.metricId);
      const unit = unitRows.find((x) => x.id === m.unitId);
      const block = blocks.find((b) => m.targetKind === 'block' && b.sectionKey === m.sectionKey);
      const target = targetOfMapping(m);
      const mv =
        m.targetKind === 'metric'
          ? snapshot.metricValues.find(
              (v) => v.metricId === m.metricId && cited.has(v.dataPointVersionId),
            )
          : undefined;
      const measure =
        m.targetKind === 'metric'
          ? (mapUnit(mv?.unitOfMeasure ?? metric?.unit)?.measure ?? null)
          : null;
      const item = itemRows.find((i) => i.id === m.disclosureItemId);
      const requirements = item
        ? [{ itemId: item.id, code: item.code }]
        : (block?.requirements ?? []).map((r) => ({ itemId: r.itemId, code: r.code }));
      const findings = evaluation
        ? evaluation.validation.findings.filter((f) => f.mappingId === m.id)
        : [];
      const run = aiRuns.find((r) => r.id === m.aiRunId);
      return {
        id: m.id,
        mapping: m,
        state: m.status,
        targetKind: m.targetKind,
        targetKey: target ? targetKeyOf(target) : null,
        targetLabel:
          m.targetKind === 'block'
            ? (block?.title ?? `節（${m.sectionKey ?? '不明'}）`)
            : m.targetKind === 'metric'
              ? (metric?.name ?? '（指標不明）')
              : '定数',
        targetDetail:
          m.targetKind === 'block'
            ? '節（テキストブロック）'
            : m.targetKind === 'metric'
              ? `${unit?.name ?? 'すべての組織単位'}・${m.boundary ?? 'すべての境界'}`
              : '—',
        periodRole: m.periodRole,
        concept,
        conceptQName: concept ? conceptQName(concept) : null,
        measure,
        decimals: m.decimals,
        dimensionLabels: Object.entries(m.dimensions ?? {}).map(([axis, member]) => {
          const a = pkg?.concepts.find((c) => c.localName === axis);
          const mem = pkg?.concepts.find((c) => c.localName === member);
          return `${a?.labelJa ?? axis}: ${mem?.labelJa ?? member}`;
        }),
        requirements,
        validation:
          m.status === 'confirmed' && evaluation
            ? mappingValidationState(evaluation.validation, m)
            : m.status === 'excluded'
              ? null
              : findings.length > 0
                ? mappingValidationState({ findings }, m)
                : null,
        findings,
        createdByName: m.createdBy ? (names.get(m.createdBy) ?? '—') : null,
        confirmedByName: m.confirmedBy ? (names.get(m.confirmedBy) ?? '—') : null,
        confirmedAt: m.confirmedAt,
        origin: m.origin,
        aiProvider: run ? run.provider : null,
        confirmBlockedReason: pkg
          ? confirmBlockedReason(ctx, m, pkg)
          : '対応付けのパッケージがありません。',
      };
    });

  const rows = [...mappingRows, ...unmapped];
  const counts = {
    confirmed: mappingRows.filter((r) => r.state === 'confirmed').length,
    candidate: mappingRows.filter((r) => r.state === 'candidate').length,
    excluded: mappingRows.filter((r) => r.state === 'excluded').length,
    mappings: mappingRows.length,
    unmapped: unmapped.length,
    // 対象の数は「節＋本文が引用した数値（期間の役割ごと）」
    targets: blocks.length + seen.size,
  };

  return {
    ...base,
    frameworkVersionId: inputs.frameworkVersionId,
    pkg,
    evaluation,
    rows,
    counts,
    targetOptions,
    requirementOptions: requirementOptionsRows.map((i) => ({
      itemId: i.id,
      code: i.code,
      title: i.questionText,
    })),
    entity: inputs.entity,
  };
}

function unmappedRow(
  id: string,
  role: XbrlPeriodRole,
  kind: 'metric' | 'block',
  label: string,
  detail: string,
  requirements: ReadonlyArray<{ itemId: Uuid; code: string }>,
  targetKey?: string,
): XbrlMappingRow {
  const unique = new Map(requirements.map((r) => [r.itemId, { itemId: r.itemId, code: r.code }]));
  return {
    id: `target:${id}`,
    mapping: null,
    state: 'unmapped',
    targetKind: kind,
    targetKey: targetKey ?? id,
    targetLabel: label,
    targetDetail: detail,
    periodRole: role,
    concept: null,
    conceptQName: null,
    measure: null,
    decimals: null,
    dimensionLabels: [],
    requirements: [...unique.values()],
    validation: null,
    findings: [],
    createdByName: null,
    confirmedByName: null,
    confirmedAt: null,
    origin: null,
    aiProvider: null,
    confirmBlockedReason: null,
  };
}

// ----------------------------------------------------------------------
// 書き込み
// ----------------------------------------------------------------------

/** 対象外の理由の上限（Demo は Cookie の容量に合わせる） */
export function excludedReasonLimit(db: Pick<DbClient, 'mode'>): number {
  return db.mode === 'demo' ? DEMO_TEXT_LIMITS.trialText : 1000;
}

async function loadOwnedMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  mappingId: string,
): Promise<XbrlTagMapping> {
  const row = isUuid(mappingId) ? await db.findById('xbrlTagMappings', mappingId) : null;
  if (!row || row.organizationId !== ctx.workspace.organizationId || row.deletedAt !== null) {
    throw new NotFoundError('対応付けが見つかりません。');
  }
  return row;
}

async function recordMappingEvent(
  db: DbClient,
  ctx: AuthorizationContext,
  mapping: XbrlTagMapping,
  event: XbrlMappingEventType,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason = '',
  at: IsoDateTime = new Date().toISOString(),
): Promise<void> {
  await db.insert('xbrlTagMappingEvents', [
    {
      id: randomUUID(),
      organizationId: mapping.organizationId,
      mappingId: mapping.id,
      event,
      before,
      after,
      reason,
      actorUserId: ctx.userId,
      createdAt: at,
    },
  ]);
}

async function auditMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  mapping: XbrlTagMapping,
  eventType: 'xbrl_mapping_changed' | 'xbrl_mapping_confirmed',
  summary: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordAuditEvent(db, ctx, {
    eventType,
    resourceType: 'xbrl_tag_mapping',
    resourceId: mapping.id,
    afterSummary: summary,
    metadata: { projectId: mapping.projectId, packageId: mapping.packageId, ...metadata },
  });
}

/** プロジェクトの基準に設定したパッケージ（設定していないパッケージには対応付けない） */
async function projectPackage(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  packageId: string,
): Promise<{ pkg: TaxonomyPackage; frameworkVersionIds: Uuid[] }> {
  const pfs = await db.select('projectFrameworks', {
    where: { organizationId: ctx.workspace.organizationId, projectId },
  });
  if (!isUuid(packageId) || !pfs.some((pf) => pf.taxonomyPackageId === packageId)) {
    throw new ValidationError('このプロジェクトの基準に設定したタクソノミを選んでください。');
  }
  const pkg = await loadTaxonomyPackage(db, packageId);
  if (!pkg) throw new ValidationError('タクソノミが見つかりません。');
  return { pkg, frameworkVersionIds: pfs.map((pf) => pf.frameworkVersionId) };
}

export interface SaveMappingInput {
  projectId: Uuid;
  /** 省略・空なら新しく作る */
  mappingId?: string | null;
  packageId: string;
  conceptId: string;
  targetKey: string;
  disclosureItemId?: string | null;
  periodRole: XbrlPeriodRole;
  decimals: number | null;
  /** 軸の local_name → メンバーの local_name（空のメンバーは指定なし） */
  dimensions: Record<string, string>;
}

const CONTENT_KEYS = [
  'conceptId',
  'targetKind',
  'metricId',
  'unitId',
  'boundary',
  'frameworkVersionId',
  'sectionKey',
  'disclosureItemId',
  'dimensions',
  'periodRole',
  'decimals',
] as const;

export async function saveMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveMappingInput,
): Promise<XbrlTagMapping> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const project = await loadOwnedProject(db, ctx, input.projectId);
  const organizationId = ctx.workspace.organizationId;
  const existing = input.mappingId ? await loadOwnedMapping(db, ctx, input.mappingId) : null;
  if (existing && existing.projectId !== null && existing.projectId !== project.id) {
    throw new NotFoundError('対応付けが見つかりません。');
  }
  const { pkg, frameworkVersionIds } = await projectPackage(db, ctx, project.id, input.packageId);
  if (existing && existing.packageId !== pkg.id) {
    throw new ValidationError(
      '対応付けのタクソノミは変更できません。新しい対応付けを作ってください。',
    );
  }

  const concept = isUuid(input.conceptId) ? findConceptById(pkg, input.conceptId) : null;
  if (!concept || (concept.kind !== 'item' && concept.kind !== 'text_block')) {
    throw new ValidationError('値を付けられる概念（数値・文章の概念）を選んでください。');
  }
  const target = parseTargetKey(input.targetKey);
  if (!target) throw new ValidationError('対応付ける対象（数値・節）を選んでください。');
  const valueClass = conceptValueClass(concept);

  let metricId: Uuid | null = null;
  let unitId: Uuid | null = null;
  let boundary: string | null = null;
  let frameworkVersionId: Uuid | null = null;
  let sectionKey: string | null = null;
  if (target.kind === 'metric') {
    if (!isNumericConcept(concept)) {
      throw new ValidationError(
        '数値は数値の概念に対応付けてください（文章の概念は節に使います）。',
      );
    }
    const metric = await db.findById('metrics', target.metricId);
    if (!metric || metric.organizationId !== organizationId) {
      throw new ValidationError('指標が見つかりません。');
    }
    if (target.unitId) {
      const unit = await db.findById('units', target.unitId);
      if (!unit || unit.organizationId !== organizationId) {
        throw new ValidationError('組織単位が見つかりません。');
      }
    }
    metricId = metric.id;
    unitId = target.unitId;
    boundary = target.boundary ? target.boundary.slice(0, 200) : null;
  } else {
    if (valueClass !== 'text_block') {
      throw new ValidationError('節は文章の概念（テキストブロック）に対応付けてください。');
    }
    if (!frameworkVersionIds.includes(target.frameworkVersionId)) {
      throw new ValidationError('節の基準がこのプロジェクトにありません。');
    }
    if (target.sectionKey.trim() === '' || target.sectionKey.length > 60) {
      throw new ValidationError('節のキーが正しくありません。');
    }
    frameworkVersionId = target.frameworkVersionId;
    sectionKey = target.sectionKey;
  }

  let disclosureItemId: Uuid | null = null;
  if (input.disclosureItemId) {
    const item = isUuid(input.disclosureItemId)
      ? await db.findById('disclosureItems', input.disclosureItemId)
      : null;
    if (!item || !frameworkVersionIds.includes(item.frameworkVersionId)) {
      throw new ValidationError('要求事項はこのプロジェクトの基準の版から選んでください。');
    }
    if (frameworkVersionId && item.frameworkVersionId !== frameworkVersionId) {
      throw new ValidationError('要求事項は節と同じ基準の版から選んでください。');
    }
    disclosureItemId = item.id;
    // 要求事項の版と対応付けの版をそろえる（DB のトリガが同じ組を確かめる）
    frameworkVersionId = item.frameworkVersionId;
  }

  const axes = axesOf(pkg);
  const dimensions: Record<string, string> = {};
  for (const [axisName, memberName] of Object.entries(input.dimensions)) {
    if (!memberName) continue;
    const axis = axes.find((a) => a.axis.localName === axisName);
    if (!axis || !axis.members.some((m) => m.localName === memberName)) {
      throw new ValidationError('軸とメンバーはタクソノミの一覧から選んでください。');
    }
    dimensions[axisName] = memberName;
  }

  let decimals: number | null = null;
  if (target.kind === 'metric' && input.decimals !== null) {
    if (!Number.isInteger(input.decimals) || Math.abs(input.decimals) > 12) {
      throw new ValidationError('精度（decimals）は -12〜12 の整数で入力してください。');
    }
    decimals = input.decimals;
  }
  const periodRole: XbrlPeriodRole = target.kind === 'block' ? 'current' : input.periodRole;

  const next = {
    conceptId: concept.id,
    targetKind: target.kind as XbrlTargetKind,
    metricId,
    unitId,
    boundary,
    frameworkVersionId,
    sectionKey,
    disclosureItemId,
    dimensions,
    periodRole,
    decimals,
  };

  // 同じ対象・同じ概念・同じ期間の対応付けを重ねない
  const siblings = await db.select('xbrlTagMappings', {
    where: { organizationId, packageId: pkg.id },
  });
  const duplicate = siblings.find(
    (m) =>
      m.id !== existing?.id &&
      m.deletedAt === null &&
      (m.projectId === null || m.projectId === project.id) &&
      m.conceptId === next.conceptId &&
      m.targetKind === next.targetKind &&
      m.metricId === next.metricId &&
      m.unitId === next.unitId &&
      m.boundary === next.boundary &&
      m.sectionKey === next.sectionKey &&
      // 節は基準の版ごと（同じキーの節が別の基準にもある）
      (next.targetKind !== 'block' || m.frameworkVersionId === next.frameworkVersionId) &&
      m.periodRole === next.periodRole &&
      canonicalJson(m.dimensions) === canonicalJson(next.dimensions),
  );
  if (duplicate) {
    throw new ValidationError(
      '同じ対象・概念・期間の対応付けが既にあります。一覧の行を編集してください。',
    );
  }

  const now = new Date().toISOString();
  if (!existing) {
    const row: XbrlTagMapping = {
      id: randomUUID(),
      organizationId,
      projectId: project.id,
      packageId: pkg.id,
      ...next,
      scale: 0,
      status: 'candidate',
      excludedReason: '',
      origin: 'human',
      aiRunId: null,
      confirmedBy: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      deletedAt: null,
    };
    await db.insert('xbrlTagMappings', [row]);
    await recordMappingEvent(
      db,
      ctx,
      row,
      'created',
      null,
      { conceptId: row.conceptId, status: 'candidate' },
      '',
      now,
    );
    await auditMapping(
      db,
      ctx,
      row,
      'xbrl_mapping_changed',
      `XBRL の対応付けを作成（${concept.labelJa}）`,
    );
    return row;
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) {
    if (canonicalJson(existing[key]) !== canonicalJson(next[key])) {
      before[key] = existing[key];
      after[key] = next[key];
    }
  }
  if (Object.keys(after).length === 0) return existing;
  // 内容を変えたら候補に戻す（確定・対象外は付け直す）
  const patch: Partial<XbrlTagMapping> = {
    ...next,
    status: 'candidate',
    excludedReason: '',
    confirmedBy: null,
    confirmedAt: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  };
  if (existing.status !== 'candidate') {
    before.status = existing.status;
    after.status = 'candidate';
  }
  const updated = await db.update('xbrlTagMappings', existing.id, patch);
  await recordMappingEvent(db, ctx, updated, 'updated', before, after, '', now);
  await auditMapping(
    db,
    ctx,
    updated,
    'xbrl_mapping_changed',
    `XBRL の対応付けを変更（${concept.labelJa}）`,
    {
      changed: Object.keys(after),
    },
  );
  return updated;
}

export async function excludeMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mappingId: string; reason: string },
): Promise<XbrlTagMapping> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const mapping = await loadOwnedMapping(db, ctx, input.mappingId);
  const reason = input.reason.trim();
  if (reason === '') throw new ValidationError('対象外にする理由を入力してください。');
  const limit = excludedReasonLimit(db);
  if (reason.length > limit) {
    throw new ValidationError(`理由は ${limit} 字以内で入力してください。`);
  }
  if (mapping.status === 'excluded') throw new ValidationError('この対応付けは既に対象外です。');
  const now = new Date().toISOString();
  const updated = await db.update('xbrlTagMappings', mapping.id, {
    status: 'excluded',
    excludedReason: reason,
    confirmedBy: null,
    confirmedAt: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordMappingEvent(
    db,
    ctx,
    updated,
    'excluded',
    { status: mapping.status },
    { status: 'excluded' },
    reason,
    now,
  );
  await auditMapping(
    db,
    ctx,
    updated,
    'xbrl_mapping_changed',
    'XBRL の対応付けを対象外にしました（理由あり）',
  );
  return updated;
}

export async function restoreMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mappingId: string },
): Promise<XbrlTagMapping> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const mapping = await loadOwnedMapping(db, ctx, input.mappingId);
  if (mapping.status !== 'excluded') throw new ValidationError('対象外の対応付けだけを戻せます。');
  const now = new Date().toISOString();
  const updated = await db.update('xbrlTagMappings', mapping.id, {
    status: 'candidate',
    excludedReason: '',
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordMappingEvent(
    db,
    ctx,
    updated,
    'restored',
    { status: 'excluded' },
    { status: 'candidate' },
    '',
    now,
  );
  await auditMapping(
    db,
    ctx,
    updated,
    'xbrl_mapping_changed',
    'XBRL の対応付けの対象外を取り消しました（候補へ）',
  );
  return updated;
}

export async function deleteMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mappingId: string },
): Promise<void> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const mapping = await loadOwnedMapping(db, ctx, input.mappingId);
  const now = new Date().toISOString();
  // 論理削除（名義の列も更新する。Demo の Cookie から戻すとき、書き手の権限で確かめるため）
  const updated = await db.update('xbrlTagMappings', mapping.id, {
    deletedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordMappingEvent(db, ctx, updated, 'deleted', { status: mapping.status }, null, '', now);
  await auditMapping(db, ctx, updated, 'xbrl_mapping_changed', 'XBRL の対応付けを削除しました');
}

export interface ConfirmMappingsResult {
  confirmed: XbrlTagMapping[];
  skipped: Array<{ mappingId: string; reason: string }>;
}

/**
 * 選んだ候補を確定する（承認権限・作成者と最後の変更者以外）。1 件ずつ検査し、確定できないものは理由を返す。
 * 1 件も確定できなければ最初の理由で断る
 */
export async function confirmMappings(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mappingIds: readonly string[] },
): Promise<ConfirmMappingsResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.approve');
  const ids = [...new Set(input.mappingIds)].slice(0, 200);
  if (ids.length === 0) throw new ValidationError('確定する対応付けを選んでください。');
  const result: ConfirmMappingsResult = { confirmed: [], skipped: [] };
  const packages = new Map<string, TaxonomyPackage | null>();
  for (const id of ids) {
    let mapping: XbrlTagMapping;
    try {
      mapping = await loadOwnedMapping(db, ctx, id);
    } catch {
      result.skipped.push({ mappingId: id, reason: '対応付けが見つかりません。' });
      continue;
    }
    if (!packages.has(mapping.packageId)) {
      packages.set(mapping.packageId, await loadTaxonomyPackage(db, mapping.packageId));
    }
    const pkg = packages.get(mapping.packageId);
    const reason = pkg ? confirmBlockedReason(ctx, mapping, pkg) : 'タクソノミが見つかりません。';
    if (reason) {
      result.skipped.push({ mappingId: id, reason });
      continue;
    }
    const now = new Date().toISOString();
    const updated = await db.update('xbrlTagMappings', mapping.id, {
      status: 'confirmed',
      confirmedBy: ctx.userId,
      confirmedAt: now,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    await recordMappingEvent(
      db,
      ctx,
      updated,
      'confirmed',
      { status: 'candidate' },
      { status: 'confirmed' },
      '',
      now,
    );
    await auditMapping(
      db,
      ctx,
      updated,
      'xbrl_mapping_confirmed',
      'XBRL の対応付けを確定しました',
      {
        origin: mapping.origin,
      },
    );
    result.confirmed.push(updated);
  }
  if (result.confirmed.length === 0) {
    throw new ValidationError(result.skipped[0]?.reason ?? '確定できる対応付けがありません。');
  }
  return result;
}

// ----------------------------------------------------------------------
// AI の候補（P1。Use Case xbrlTagSuggestion。候補の行として入り、人の確定でだけ確定）
// ----------------------------------------------------------------------

export interface SuggestMappingsResult {
  runId: Uuid;
  provider: 'openai' | 'mock';
  created: XbrlTagMapping[];
  warnings: string[];
  discarded: number;
}

export async function suggestMappings(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; snapshotId?: string | null; frameworkVersionId?: string | null },
): Promise<SuggestMappingsResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.ai.run');
  assertCan(ctx, 'enterprise.disclosure.write');
  const model = await loadXbrlTab(db, ctx, input);
  if (!model.snapshot) {
    throw new ValidationError(
      'スナップショットが無いため候補を出せません（出力タブで作成してください）。',
    );
  }
  const pkg = model.pkg;
  if (!pkg) throw new ValidationError('この基準に XBRL のタクソノミが設定されていません。');
  const targets = model.rows
    .filter((r) => r.state === 'unmapped' && r.targetKey)
    .map((r) => ({
      targetKind: r.targetKind as 'metric' | 'block',
      targetRef: r.targetKey!,
      label: r.targetKind === 'metric' ? `${r.targetLabel}（${r.targetDetail}）` : r.targetLabel,
      periodRole: r.periodRole,
    }));
  if (targets.length === 0) {
    throw new ValidationError('未対応付けの対象がありません（候補を出す対象がありません）。');
  }
  const { numeric, textBlocks } = valueConceptsOf(pkg);
  const concepts = [...numeric, ...textBlocks].map((c) => ({
    localName: c.localName,
    kind: conceptValueClass(c) === 'text_block' ? 'text_block' : 'item',
    labelJa: c.labelJa,
  }));
  const aiInput = {
    targets: targets.map(({ targetKind, targetRef, label }) => ({ targetKind, targetRef, label })),
    concepts,
  };
  const digest = createHash('sha256').update(canonicalJson(aiInput)).digest('hex').slice(0, 16);
  const { run, output } = await runAi({
    db,
    ctx,
    invocation: {
      feature: 'xbrlTagSuggestion',
      context: { organizationName: ctx.workspace.organizationName, reportingPeriodLabel: '' },
      inputReferenceIds: [model.snapshot.id, pkg.id],
      input: aiInput,
    },
    sources: [],
    idempotencyKey: `xbrlTagSuggestion|${ctx.workspace.organizationId}|${input.projectId}|${model.snapshot.id}|${digest}`,
  });
  const result = output as XbrlTagSuggestionOutput;
  const created: XbrlTagMapping[] = [];
  let discarded = 0;
  const now = new Date().toISOString();
  const existing = await db.select('xbrlTagMappings', {
    where: { organizationId: ctx.workspace.organizationId, packageId: pkg.id },
  });
  for (const candidate of result.candidates) {
    const target = targets.find(
      (t) => t.targetRef === candidate.targetRef && t.targetKind === candidate.targetKind,
    );
    const concept = pkg.concepts.find((c) => c.localName === candidate.conceptLocalName);
    const parsed = target ? parseTargetKey(target.targetRef) : null;
    const fits =
      concept &&
      parsed &&
      (parsed.kind === 'metric'
        ? isNumericConcept(concept)
        : conceptValueClass(concept) === 'text_block');
    if (!target || !concept || !parsed || !fits) {
      discarded += 1;
      continue;
    }
    const periodRole: XbrlPeriodRole = parsed.kind === 'block' ? 'current' : target.periodRole;
    const scoped = mappingsInScope([...existing, ...created], {
      packageId: pkg.id,
      projectId: input.projectId,
      frameworkVersionId: model.frameworkVersionId ?? '',
    });
    if (
      scoped.some(
        (m) => m.deletedAt === null && covers(m, parsed, periodRole) && m.conceptId === concept.id,
      )
    ) {
      continue;
    }
    const row: XbrlTagMapping = {
      id: randomUUID(),
      organizationId: ctx.workspace.organizationId,
      projectId: input.projectId,
      packageId: pkg.id,
      conceptId: concept.id,
      targetKind: parsed.kind,
      metricId: parsed.kind === 'metric' ? parsed.metricId : null,
      unitId: parsed.kind === 'metric' ? parsed.unitId : null,
      boundary: parsed.kind === 'metric' ? parsed.boundary : null,
      frameworkVersionId: parsed.kind === 'block' ? parsed.frameworkVersionId : null,
      sectionKey: parsed.kind === 'block' ? parsed.sectionKey : null,
      disclosureItemId: null,
      // 軸・精度は推測しない（人が設定してから確定する）
      dimensions: {},
      periodRole,
      decimals: null,
      scale: 0,
      status: 'candidate',
      excludedReason: '',
      origin: 'ai_adopted',
      aiRunId: run.id,
      confirmedBy: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      deletedAt: null,
    };
    await db.insert('xbrlTagMappings', [row]);
    await recordMappingEvent(
      db,
      ctx,
      row,
      'created',
      null,
      { conceptId: row.conceptId, status: 'candidate', origin: 'ai_adopted' },
      'AI の候補',
      now,
    );
    created.push(row);
  }
  if (created.length > 0) {
    await recordAuditEvent(db, ctx, {
      eventType: 'xbrl_mapping_changed',
      resourceType: 'ai_run',
      resourceId: run.id,
      afterSummary: `AI の候補から XBRL の対応付けの候補を ${created.length} 件作成（確定は承認権限者）`,
      metadata: { projectId: input.projectId, packageId: pkg.id, created: created.length },
    });
  }
  return {
    runId: run.id,
    provider: run.provider,
    created,
    warnings: [...result.warnings],
    discarded,
  };
}

// ----------------------------------------------------------------------
// 基準のタクソノミ・提出者の識別子
// ----------------------------------------------------------------------

export async function setFrameworkTaxonomy(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; projectFrameworkId: string; packageId: string | null },
): Promise<void> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const project = await loadOwnedProject(db, ctx, input.projectId);
  const pf = isUuid(input.projectFrameworkId)
    ? await db.findById('projectFrameworks', input.projectFrameworkId)
    : null;
  if (!pf || pf.organizationId !== ctx.workspace.organizationId || pf.projectId !== project.id) {
    throw new NotFoundError('プロジェクトの基準が見つかりません。');
  }
  let packageId: Uuid | null = null;
  if (input.packageId) {
    const pkg = isUuid(input.packageId)
      ? await db.findById('xbrlTaxonomyPackages', input.packageId)
      : null;
    const version = await db.findById('frameworkVersions', pf.frameworkVersionId);
    const framework = version ? await db.findById('frameworks', version.frameworkId) : null;
    if (!pkg || !framework || pkg.frameworkKey !== framework.key) {
      throw new ValidationError('この基準に使えるタクソノミを選んでください。');
    }
    packageId = pkg.id;
  }
  if (pf.taxonomyPackageId === packageId) return;
  const now = new Date().toISOString();
  await db.update('projectFrameworks', pf.id, {
    taxonomyPackageId: packageId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'project_framework',
    resourceId: pf.id,
    afterSummary: packageId
      ? 'XBRL のタクソノミを設定しました'
      : 'XBRL のタクソノミの設定を外しました',
    metadata: { projectId: project.id, before: pf.taxonomyPackageId, after: packageId },
  });
}

/** 識別子の形式（scheme ごと）。SAMPLE は架空の「SAMPLE-…」だけ */
export const FILING_IDENTIFIER_PATTERNS: Record<FilingIdentifierScheme, RegExp> = {
  edinet_code: /^E\d{5}$/,
  lei: /^[A-Z0-9]{18}\d{2}$/,
  corporate_number: /^\d{13}$/,
  sample: /^SAMPLE-[A-Z0-9-]{1,40}$/,
};

export async function saveFilingIdentifier(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { scheme: string; value: string },
): Promise<OrganizationFilingIdentifier> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
  const scheme = FILING_IDENTIFIER_SCHEMES.includes(input.scheme as FilingIdentifierScheme)
    ? (input.scheme as FilingIdentifierScheme)
    : null;
  if (!scheme) throw new ValidationError('識別子の種類を選んでください。');
  // デモは架空の識別子だけ（実在の EDINET コード・LEI・法人番号をデモ環境に置かない）
  if (db.mode === 'demo' && scheme !== 'sample') {
    throw new ValidationError('デモでは架空（サンプル）の識別子だけを使えます。');
  }
  const value = input.value.trim().toUpperCase();
  if (!FILING_IDENTIFIER_PATTERNS[scheme].test(value)) {
    throw new ValidationError(
      '識別子の形式が正しくありません（種類ごとの形式を確認してください）。',
    );
  }
  const organizationId = ctx.workspace.organizationId;
  const existing = (
    await db.select('organizationFilingIdentifiers', { where: { organizationId, scheme } })
  )[0];
  const now = new Date().toISOString();
  let saved: OrganizationFilingIdentifier;
  if (existing) {
    if (existing.value === value) return existing;
    // 値を変えたら確認の記録は外す（確認した値ではなくなるため）
    saved = await db.update('organizationFilingIdentifiers', existing.id, {
      value,
      verifiedAt: null,
      verifiedBy: null,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    saved = {
      id: randomUUID(),
      organizationId,
      scheme,
      value,
      verifiedAt: null,
      verifiedBy: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    await db.insert('organizationFilingIdentifiers', [saved]);
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'organization_filing_identifier',
    resourceId: saved.id,
    afterSummary: '提出者の識別子を保存しました（XBRL）',
    metadata: { scheme },
  });
  return saved;
}
