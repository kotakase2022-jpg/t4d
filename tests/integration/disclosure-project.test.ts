import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  FieldValidationError,
  attachFrameworkVersion,
  canCreateStatutoryPackage,
  compareFrameworkVersions,
  confirmApplicability,
  createProject,
  getProject,
  listFrameworkVersionOptions,
  listProjects,
  loadProjectRequirements,
  loadStatutoryPackageCheck,
  packageInputOf,
  parseFrameworkConditions,
  saveProjectFramework,
  summarizeProject,
  updateProject,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@/lib/services/disclosure-project';
import { saveSsbjScope } from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, DisclosureProject, RoleKey } from '@/types/domain';

/**
 * 開示プロジェクト（指示書 §6.2・§6.3・§8.2〜§8.4）。
 *
 * 受入: A21（非重要・対象外の判断は理由と判断者が残り、未判定を分母から消さない）、
 *       A22 の一部（ESRS-40a 草案は「公開草案に基づく準備」で、要求事項は未収録と示す）、
 *       A23（基準の新版を登録しても既存プロジェクトの版は変わらない。移行差分を確認できる）、
 *       A29 の一部（別テナントのプロジェクトは存在ごと見えない）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  org: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: org,
      organizationType: 'enterprise',
      organizationName: org === ORG_IDS.aomi ? '青海テクノロジー株式会社' : '蒼天',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const AUTHOR = userId('sustainability@demo.local');
const REVIEWER = userId('reviewer@demo.local');
const APPROVER = userId('approver@demo.local');

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const SSBJ_VERSION = fid('framework_version', 'ssbj/2026');
const CSRD_VERSION = fid('framework_version', 'csrd/2026');

function baseInput(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    name: 'FY2026 テストプロジェクト',
    reportingEntity: '青海テクノロジー株式会社',
    reportingPeriodId: PERIOD_IDS.fy2026,
    periodStart: '',
    periodEnd: '',
    currency: 'JPY',
    ownerUserId: AUTHOR,
    dueDate: '2026-12-15',
    purposes: ['ssbj_statutory'],
    frameworkVersionByPurpose: { ssbj_statutory: SSBJ_VERSION },
    preparationStatus: 'candidate',
    scopeOrgNote: '当社及び連結子会社',
    scopeConsolidationNote: '',
    scopeGhgBoundaryNote: '',
    scopeValueChainNote: '',
    includedUnitIds: [],
    languages: ['ja'],
    reviewerUserId: REVIEWER,
    finalApproverUserId: APPROVER,
    ...overrides,
  };
}

function updateInputOf(project: DisclosureProject, overrides: Partial<UpdateProjectInput> = {}) {
  const input: UpdateProjectInput = {
    name: project.name,
    reportingEntity: project.reportingEntity,
    periodStart: project.periodStart,
    periodEnd: project.periodEnd,
    currency: project.currency,
    dueDate: project.dueDate,
    status: project.status,
    ownerUserId: project.ownerUserId,
    reviewerUserId: project.reviewerUserId,
    finalApproverUserId: project.finalApproverUserId,
    languages: project.languages,
    scopeOrgNote: project.scopeOrgNote,
    scopeConsolidationNote: project.scopeConsolidationNote,
    scopeGhgBoundaryNote: project.scopeGhgBoundaryNote,
    scopeValueChainNote: project.scopeValueChainNote,
    includedUnitIds: project.includedUnitIds,
    ...overrides,
  };
  return input;
}

async function fieldErrorsOf(run: () => Promise<unknown>): Promise<Record<string, string>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof FieldValidationError) return error.fieldErrors;
    throw error;
  }
  throw new Error('FieldValidationError が発生しなかった');
}

describe('一覧と詳細（テナント分離・基準の位置付け）', () => {
  it('自組織のプロジェクトだけが並び、別テナントからは存在ごと見えない', async () => {
    const rows = await listProjects(db, manager());
    expect(rows.map((r) => r.project.id).sort()).toEqual(
      [IDS.projects.fy2025, IDS.projects.fy2026].sort(),
    );
    const fy2026 = rows.find((r) => r.project.id === IDS.projects.fy2026)!;
    expect(fy2026.period?.id).toBe(PERIOD_IDS.fy2026);
    expect(fy2026.blockCount).toBe(4);

    expect(await listProjects(db, otherTenant())).toEqual([]);
    await expect(getProject(db, otherTenant(), IDS.projects.fy2026)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('A22: ESRS-40a は「公開草案に基づく準備」、要求事項は未収録として示す', async () => {
    const detail = await getProject(db, manager(), IDS.projects.fy2026);
    const esrs = detail.frameworks.find(
      (f) => f.projectFramework.id === IDS.projectFrameworks.fy2026Esrs40a,
    )!;
    expect(esrs.legal.label).toBe('公開草案に基づく準備');
    expect(esrs.legal.isPreparationOnly).toBe(true);
    expect(esrs.legal.coverageLabel).toBe('要求事項は未収録');
    expect(esrs.confirmed).toBe(false);
    expect(esrs.applicabilityLabel).toBe('適用候補');

    const ssbj = detail.frameworks.find(
      (f) => f.projectFramework.id === IDS.projectFrameworks.fy2026Ssbj,
    )!;
    expect(ssbj.confirmed).toBe(true);
    expect(ssbj.currentDecision?.id).toBe(IDS.decisions.fy2026Ssbj);
    expect(ssbj.itemCount).toBe(133);

    const requirements = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
    });
    expect(requirements.result?.mode).toBe('not_loaded');
    expect(requirements.result?.rows).toHaveLength(0);
    expect(requirements.result?.summary.readyForCompletion).toBe(false);
  });

  it('フォームの選択肢: 版ごとに法的位置付けを添え、サンプルはサンプルと示す', async () => {
    const options = await listFrameworkVersionOptions(db);
    expect(options.ssbj_statutory.map((o) => o.versionId)).toContain(SSBJ_VERSION);
    expect(options.csrd_40a_prep[0]?.legal.label).toBe('公開草案に基づく準備');
    expect(options.csrd_eu_entity[0]?.legal.label).toBe('サンプル（架空）');
    expect(options.internal_esg).toEqual([]);
  });
});

describe('作成（3 段階・項目別エラー）', () => {
  it('不足・矛盾は項目ごとのエラーで返し、何も保存しない', async () => {
    const before = fixture.disclosureProjects.length;
    const errors = await fieldErrorsOf(() =>
      createProject(
        db,
        manager(),
        baseInput({
          name: ' ',
          purposes: ['ssbj_statutory', 'ssbj_voluntary'],
          frameworkVersionByPurpose: {},
          finalApproverUserId: AUTHOR,
          periodStart: '2026-13-01',
          languages: [],
        }),
      ),
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        'finalApproverUserId',
        'frameworkVersions',
        'languages',
        'name',
        'periodStart',
        'purposes',
      ].sort(),
    );
    expect(errors.finalApproverUserId).toMatch(/職務分離|承認権限/);
    expect(fixture.disclosureProjects.length).toBe(before);
  });

  it('最終承認者に承認権限の無い人は指定できない', async () => {
    const errors = await fieldErrorsOf(() =>
      createProject(
        db,
        manager(),
        baseInput({ finalApproverUserId: userId('enterprise-admin@demo.local') }),
      ),
    );
    expect(errors.finalApproverUserId).toContain('承認権限');
  });

  it('保存して準備を始める: 基準は版を固定して「適用候補」で登録し、判断は確定しない', async () => {
    const { project, frameworks } = await createProject(db, manager(), baseInput());
    expect(project.periodStart).toBe('2026-04-01');
    expect(project.status).toBe('preparing');
    expect(frameworks).toHaveLength(1);
    expect(frameworks[0]).toMatchObject({
      frameworkVersionId: SSBJ_VERSION,
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
      conditions: {},
    });
    expect(
      fixture.projectFrameworkDecisions.filter((d) => d.projectFrameworkId === frameworks[0]!.id),
    ).toHaveLength(0);
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'project_created' && e.resourceId === project.id,
      ),
    ).toBe(true);
  });

  it('開示の編集権限が無い利用者は作成できない', async () => {
    await expect(createProject(db, siteUser(), baseInput())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('適用条件と適用判断（§6.2・§8.4）', () => {
  it('空欄は「不明」としてキーを持たず、0 は 0 として区別する。読めない数値は推測しない', () => {
    const values: Record<string, string> = {
      'condition.euNetTurnoverLatestFy': '',
      'condition.euNetTurnoverPreviousFy': '0',
      'condition.groupEmployees': '1,234',
      'condition.euCountries': ' ドイツ ',
    };
    const conditions = parseFrameworkConditions('esrs_40a', (k) => values[k] ?? '');
    expect(conditions).toEqual({
      euNetTurnoverPreviousFy: 0,
      groupEmployees: 1234,
      euCountries: 'ドイツ',
    });
    expect('euNetTurnoverLatestFy' in conditions).toBe(false);

    expect(() =>
      parseFrameworkConditions('esrs_40a', (k) =>
        k === 'condition.euNetTurnoverLatestFy' ? '4億5千万' : '',
      ),
    ).toThrow(FieldValidationError);
  });

  it('保存しても対象外にはならず、未入力の条件は不明のまま一覧される', async () => {
    const pfId = IDS.projectFrameworks.fy2026Esrs40a;
    await saveProjectFramework(db, manager(), {
      projectFrameworkId: pfId,
      conditions: { groupEmployees: 3200, unknownKey: 'x' },
      preparationStatus: 'awaiting_confirmation',
    });
    const detail = await getProject(db, manager(), IDS.projects.fy2026);
    const esrs = detail.frameworks.find((f) => f.projectFramework.id === pfId)!;
    expect(esrs.projectFramework.applicabilityStatus).toBe('awaiting_confirmation');
    expect(esrs.projectFramework.conditions).toEqual({ groupEmployees: 3200 });
    expect(esrs.unknownConditions.map((f) => f.key)).toContain('euNetTurnoverLatestFy');
    expect(esrs.confirmed).toBe(false);
  });

  it('確定済みの判断がある基準は、条件を保存しても区分を変えず「判断後に条件が変わった」と示す', async () => {
    const pfId = IDS.projectFrameworks.fy2026Ssbj;
    await saveProjectFramework(db, manager(), {
      projectFrameworkId: pfId,
      conditions: { applicationBasisNote: '取締役会で任意適用を決議（架空）' },
      preparationStatus: 'candidate',
    });
    const detail = await getProject(db, manager(), IDS.projects.fy2026);
    const ssbj = detail.frameworks.find((f) => f.projectFramework.id === pfId)!;
    expect(ssbj.projectFramework.applicabilityStatus).toBe('applicable');
    expect(ssbj.conditionsChangedSinceDecision).toBe(true);
  });

  it('適用判断の確定は理由・参照規則・確認日が必須で、判断は追記され判断者は本人になる', async () => {
    const pfId = IDS.projectFrameworks.fy2026Esrs40a;
    const errors = await fieldErrorsOf(() =>
      confirmApplicability(db, admin(), {
        projectFrameworkId: pfId,
        applicabilityStatus: 'not_applicable',
        reason: '',
        ruleRef: ' ',
        confirmedOn: '2026/08/14',
        transitionalNote: null,
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(['confirmedOn', 'reason', 'ruleRef']);

    const first = await confirmApplicability(db, admin(), {
      projectFrameworkId: pfId,
      applicabilityStatus: 'awaiting_confirmation',
      reason: 'EU 域内売上の直近 2 年度の集計を経理部に依頼中のため、確認待ちとする。',
      ruleRef: 'ESRS-40a 公開草案（2026-07）／EU 理事会 2026-02-24 公表',
      confirmedOn: '2026-08-14',
      transitionalNote: null,
    });
    const second = await confirmApplicability(db, admin(), {
      projectFrameworkId: pfId,
      applicabilityStatus: 'applicable',
      reason: '集計の結果、条件を満たす見込みのため適用と判断（架空）。',
      ruleRef: 'ESRS-40a 公開草案（2026-07）',
      confirmedOn: '2026-08-14',
      transitionalNote: '正式版の公表後に再確認する',
    });
    expect(first.decisionNo).toBe(1);
    expect(second.decisionNo).toBe(2);
    expect(second.decidedBy).toBe(userId('enterprise-admin@demo.local'));
    // 追記専用: 1 件目は残る
    expect(
      fixture.projectFrameworkDecisions.filter((d) => d.projectFrameworkId === pfId),
    ).toHaveLength(2);
    const pf = fixture.projectFrameworks.find((p) => p.id === pfId)!;
    expect(pf.currentDecisionId).toBe(second.id);
    expect(pf.applicabilityStatus).toBe('applicable');
    expect(
      fixture.auditEvents.filter((e) => e.eventType === 'framework_decision_confirmed'),
    ).toHaveLength(2);
  });
});

describe('確定パッケージの可否（S-e が使う）', () => {
  it('適用判断が未確定の基準がある間は、法定提出用の確定パッケージを作れない', async () => {
    const check = await loadStatutoryPackageCheck(db, manager(), IDS.projects.fy2026);
    expect(check.ok).toBe(false);
    expect(check.unconfirmed).toContain('ESRS-40a 公開草案（2026年7月）');
    expect(check.preparationOnly).toContain('ESRS-40a 公開草案（2026年7月）');
  });

  it('法定の目的で判断が確定していれば作れる。草案の基準を法定の目的に使うと作れない', async () => {
    const { project } = await createProject(db, manager(), baseInput());
    const detail = await getProject(db, manager(), project.id);
    const pf = detail.frameworks[0]!;
    expect(
      canCreateStatutoryPackage({
        purposes: project.purposes,
        frameworks: detail.frameworks.map(packageInputOf),
      }).ok,
    ).toBe(false);

    await confirmApplicability(db, admin(), {
      projectFrameworkId: pf.projectFramework.id,
      applicabilityStatus: 'applicable',
      reason: '法定開示の対象（架空）',
      ruleRef: 'SSBJ 2026-03-13 改正基準',
      confirmedOn: '2026-08-14',
      transitionalNote: null,
    });
    expect((await loadStatutoryPackageCheck(db, manager(), project.id)).ok).toBe(true);

    expect(
      canCreateStatutoryPackage({
        purposes: ['csrd_eu_entity'],
        frameworks: [
          {
            label: 'ESRS 草案',
            purpose: 'csrd_eu_entity',
            applicabilityStatus: 'applicable',
            currentDecisionId: 'd',
            legalStatus: 'draft',
            coverageStatus: 'not_loaded',
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe('A21: 要求事項の適用判断と分母', () => {
  it('対象外・非重要は理由と判断者が残り、未判定は分母から消えない', async () => {
    const { result } = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {
      projectFrameworkId: IDS.projectFrameworks.fy2026Ssbj,
    });
    const summary = result!.summary;
    expect(summary.total).toBe(133);
    expect(summary.applicableConfirmed + summary.excludedDecided + summary.notAssessed).toBe(133);
    expect(summary.notAssessed).toBeGreaterThan(0);
    expect(summary.excludedDecided).toBeGreaterThan(0);
    // 未判定が残る間は準備完了にしない
    expect(summary.readyForCompletion).toBe(false);
    expect(summary.notReadyReasons.join()).toContain('適用未判定');

    for (const row of result!.rows.filter((r) => r.decision.excluded)) {
      expect(row.decision.reason).toBeTruthy();
      expect(row.decision.decidedBy).toBeTruthy();
      expect(row.decision.decidedByName).toBeTruthy();
    }
    // 既定値（適用・重要性未判定）は判断として扱わない
    const notAssessed = result!.rows.find((r) => r.decision.kind === 'not_assessed')!;
    expect(notAssessed.decision.label).toBe('未判定');
  });

  it('人が対象外と判断すると、理由と判断者つきで分母から外れ、合計は変わらない', async () => {
    const before = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {});
    const target = before.result!.rows.find((r) => r.decision.kind === 'not_assessed')!;
    const assessment = fixture.ssbjAssessments.find(
      (a) => a.itemId === target.item.id && a.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;

    // 理由の無い対象外は受け付けない（既存の SSBJ 評価の規則）
    await expect(
      saveSsbjScope(db, admin(), {
        assessmentId: assessment.id,
        applicability: 'not_applicable',
        applicabilityReason: '',
        materiality: 'not_assessed',
        materialityReason: '',
        ownerDepartment: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await saveSsbjScope(db, admin(), {
      assessmentId: assessment.id,
      applicability: 'not_applicable',
      applicabilityReason: '当社の事業に該当する活動がないため（架空）',
      materiality: 'not_assessed',
      materialityReason: '',
      ownerDepartment: 'サステナビリティ推進部',
    });
    const after = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {});
    const row = after.result!.rows.find((r) => r.item.id === target.item.id)!;
    expect(row.decision).toMatchObject({
      kind: 'not_applicable',
      excluded: true,
      reason: '当社の事業に該当する活動がないため（架空）',
      decidedBy: userId('enterprise-admin@demo.local'),
      decidedByName: '青海 太郎',
    });
    const s0 = before.result!.summary;
    const s1 = after.result!.summary;
    expect(s1.total).toBe(s0.total);
    expect(s1.notAssessed).toBe(s0.notAssessed - 1);
    expect(s1.excludedDecided).toBe(s0.excludedDecided + 1);
  });

  it('内容評価と本文状態は別の列で、原稿・根拠・数値の状態が要求事項ごとに分かる', async () => {
    const { result } = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {});
    const byCode = (code: string) => result!.rows.find((r) => r.item.code === code)!;

    const governance = byCode('気候-10');
    expect(governance.manuscript.label).toBe('承認済み');
    expect(governance.evidence.kind).toBe('current');

    const risk = byCode('気候-19');
    expect(risk.manuscript.label).toBe('下書き');

    // 指標: 承認済みだが、引用した Scope1 に新しい版がある
    const metrics = byCode('気候-47(1)');
    expect(metrics.manuscript.label).toBe('承認済み');
    expect(metrics.metrics.kind).toBe('stale');
    expect(metrics.flags.recheck).toBe(true);

    // 原稿の無い要求事項は「未着手」。内容評価（対応済み等）は別の値を持つ
    const untouched = result!.rows.find(
      (r) => r.blocks.length === 0 && r.contentEvaluation.source === 'human',
    )!;
    expect(untouched.manuscript.label).toBe('未着手');
    expect(['対応済み', 'おおむね対応', '一部対応', '未対応', '未確認']).toContain(
      untouched.contentEvaluation.label,
    );
  });

  it('標準フィルタは URL の値で絞り込み、自分の担当は利用者ごとに変わる', async () => {
    const recheck = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {
      filter: 'recheck',
    });
    expect(recheck.filteredRows.map((r) => r.item.code)).toEqual(['気候-47(1)']);
    expect(recheck.filterCounts.recheck).toBe(1);

    const mineAuthor = await loadProjectRequirements(db, manager(), IDS.projects.fy2026, {
      filter: 'mine',
    });
    const mineReviewer = await loadProjectRequirements(db, reviewer(), IDS.projects.fy2026, {
      filter: 'mine',
    });
    expect(mineAuthor.filteredRows.length).toBeGreaterThan(0);
    expect(mineReviewer.filteredRows).toHaveLength(0);
  });

  it('CSRD の架空 12 項目はサンプルとして並ぶ（全件 未判定）', async () => {
    const { project, frameworks } = await createProject(
      db,
      manager(),
      baseInput({
        purposes: ['csrd_eu_entity'],
        frameworkVersionByPurpose: { csrd_eu_entity: CSRD_VERSION },
      }),
    );
    const { result } = await loadProjectRequirements(db, manager(), project.id, {
      projectFrameworkId: frameworks[0]!.id,
    });
    expect(result!.rows).toHaveLength(12);
    expect(result!.rows.every((r) => r.isSample)).toBe(true);
    expect(result!.summary.notAssessed).toBe(12);
  });

  it('概要の進捗は基準ごとに分母を持つ', async () => {
    const detail = await getProject(db, manager(), IDS.projects.fy2026);
    const summaries = await summarizeProject(db, manager(), detail);
    expect(summaries.map((s) => s.mode).sort()).toEqual(['not_loaded', 'rows']);
  });
});

describe('変更の影響（§6.2）', () => {
  it('報告範囲を変える前に、影響する原稿・数値・承認を示し、確認なしでは保存しない', async () => {
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!;
    const result = await updateProject(
      db,
      manager(),
      project.id,
      updateInputOf(project, { scopeGhgBoundaryNote: '操業支配力基準へ変更（架空）' }),
      { confirmImpact: false },
    );
    expect(result.status).toBe('needs_confirmation');
    if (result.status !== 'needs_confirmation') throw new Error('unreachable');
    expect(result.impact.blocks).toHaveLength(4);
    expect(result.impact.metricRefs.map((m) => m.metricName).join()).toMatch(/Scope1|スコープ1/i);
    expect(result.impact.approvals.filter((a) => a.kind === 'approved_version')).toHaveLength(2);
    // まだ保存していない
    expect(fixture.disclosureProjects.find((p) => p.id === project.id)!.scopeGhgBoundaryNote).toBe(
      project.scopeGhgBoundaryNote,
    );

    const blockVersionsBefore = fixture.disclosureBlocks.map((b) => [b.id, b.currentVersionId]);
    const saved = await updateProject(
      db,
      manager(),
      project.id,
      updateInputOf(project, { scopeGhgBoundaryNote: '操業支配力基準へ変更（架空）' }),
      { confirmImpact: true },
    );
    expect(saved.status).toBe('saved');
    expect(fixture.disclosureProjects.find((p) => p.id === project.id)!.scopeGhgBoundaryNote).toBe(
      '操業支配力基準へ変更（架空）',
    );
    // 原稿は書き換えない
    expect(fixture.disclosureBlocks.map((b) => [b.id, b.currentVersionId])).toEqual(
      blockVersionsBefore,
    );
  });

  it('名前だけの変更は影響なしで保存する', async () => {
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!;
    const result = await updateProject(
      db,
      manager(),
      project.id,
      updateInputOf(project, { name: 'FY2026 統合開示（名称変更）' }),
      { confirmImpact: false },
    );
    expect(result.status).toBe('saved');
  });
});

describe('A23: 基準の新版を登録しても既存プロジェクトは変わらない', () => {
  const NEW_VERSION = fid('framework_version', 'ssbj/2027-test');

  function registerNewSsbjVersion() {
    const old = fixture.frameworkVersions.find((v) => v.id === SSBJ_VERSION)!;
    fixture.frameworkVersions.push({
      ...old,
      id: NEW_VERSION,
      year: 2027,
      label: 'SSBJ 改正基準（テスト用の新版）',
      versionCode: 'ssbj-test-next',
      issuedAt: '2027-03-01',
      createdAt: new Date().toISOString(),
    });
    const items = fixture.disclosureItems.filter((i) => i.frameworkVersionId === SSBJ_VERSION);
    items.forEach((item, index) => {
      fixture.disclosureItems.push({
        ...item,
        id: fid('disclosure_item', `ssbj/2027-test/${item.code}`),
        frameworkVersionId: NEW_VERSION,
        questionText: index === 0 ? `${item.questionText}（改正）` : item.questionText,
      });
    });
    fixture.disclosureItems.push({
      ...items[0]!,
      id: fid('disclosure_item', 'ssbj/2027-test/新設-1'),
      frameworkVersionId: NEW_VERSION,
      code: '新設-1',
      questionText: '新設された要求事項（テスト）',
      sortOrder: 9999,
    });
  }

  it('既存プロジェクトは元の版を指したまま、新しい版と移行差分を確認できる', async () => {
    registerNewSsbjVersion();
    for (const projectId of [IDS.projects.fy2025, IDS.projects.fy2026]) {
      const detail = await getProject(db, manager(), projectId);
      const ssbj = detail.frameworks.find((f) => f.frameworkKey === 'ssbj')!;
      expect(ssbj.version.id).toBe(SSBJ_VERSION);
      expect(ssbj.newerVersions.map((v) => v.version.id)).toEqual([NEW_VERSION]);
    }
    const diff = await compareFrameworkVersions(db, SSBJ_VERSION, NEW_VERSION);
    expect(diff.added.map((a) => a.code)).toEqual(['新設-1']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchangedCount).toBe(132);
  });

  it('新しい版の追加は人が影響を確認したときだけ。旧版・原稿・判断はそのまま残る', async () => {
    registerNewSsbjVersion();
    const pfId = IDS.projectFrameworks.fy2026Ssbj;
    await expect(
      attachFrameworkVersion(db, manager(), {
        projectFrameworkId: pfId,
        newVersionId: NEW_VERSION,
        acknowledgeImpact: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const added = await attachFrameworkVersion(db, manager(), {
      projectFrameworkId: pfId,
      newVersionId: NEW_VERSION,
      acknowledgeImpact: true,
    });
    expect(added.applicabilityStatus).toBe('candidate');
    expect(added.currentDecisionId).toBeNull();
    const old = fixture.projectFrameworks.find((p) => p.id === pfId)!;
    expect(old.frameworkVersionId).toBe(SSBJ_VERSION);
    expect(old.currentDecisionId).toBe(IDS.decisions.fy2026Ssbj);
    expect(
      fixture.disclosureBlocks.filter(
        (b) => b.projectId === IDS.projects.fy2026 && b.frameworkVersionId === SSBJ_VERSION,
      ).length,
    ).toBe(3);
  });
});
