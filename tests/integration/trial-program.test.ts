import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import {
  GHG_FIXTURE_IDS,
  GHG_ROLLOUT_TOTAL_SITES,
  GHG_VERIFICATION_UNIT_IDS,
} from '@/lib/fixtures/ghg-verification';
import { TRIAL_PROGRAM_ID } from '@/lib/fixtures/trial-case';
import { esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { ValidationError } from '@/lib/errors/user-facing';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import {
  loadTrialFormChoices,
  loadTrialOverview,
  loadTrialProgram,
  saveTrialProgram,
} from '@/lib/services/trial-program';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * トライアルの計画・利用枠・選定ケース・終了時の扱いと導入判断（NF-32・NF-37 の概要の合計）。
 *  - 実績は既存の表の件数と一致し、他組織の行を数えない
 *  - 保存は enterprise.org.manage だけ。監査法人のワークスペースからは読めない
 *  - 保存した行は Demo Mode の Cookie から戻せる（demo-trial-checks.ts の検査を通る）
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
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: OrganizationType = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const site = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const firm = () =>
  ctxFor('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba, 'assurance_firm');

function replay(table: string, row: object): FixtureDb {
  const v = compactRow(table, row as Record<string, unknown>, fixture);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  const edit: DemoEdit = { t: table, id: (row as { id: string }).id, v };
  const target = createFixtureDb();
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream([edit])));
  return target;
}

describe('概要: 計画と実績', () => {
  it('Fixture の計画を読み、実績は既存の表の件数と一致する（分母付き）', async () => {
    const overview = await loadTrialOverview(db, admin());
    expect(overview.program?.id).toBe(TRIAL_PROGRAM_ID);
    const row = (key: string) => overview.rows.find((r) => r.key === key)!;

    const activeMembers = fixture.memberships.filter(
      (m) => m.organizationId === ORG_IDS.aomi && m.status === 'active',
    ).length;
    expect(row('members')).toMatchObject({ actual: activeMembers, planned: 10 });

    const program = fixture.trialPrograms[0]!;
    expect(row('sites')).toMatchObject({ actual: 3, planned: 3, over: false });

    const project = fixture.disclosureProjects.find((p) => p.id === program.projectId)!;
    const included = new Set(program.includedUnitIds);
    const metricsWithData = new Set(
      fixture.dataPoints
        .filter(
          (d) =>
            d.organizationId === ORG_IDS.aomi &&
            !d.deletedAt &&
            d.reportingPeriodId === project.reportingPeriodId &&
            included.has(d.unitId) &&
            (d.value !== null || (d.textValue ?? '') !== ''),
        )
        .map((d) => d.metricId),
    );
    expect(row('quantitativeMetrics').actual).toBe(metricsWithData.size);
    expect(row('quantitativeMetrics').planned).toBe(10);

    const blocks = fixture.disclosureBlocks.filter(
      (b) => b.projectId === project.id && !b.deletedAt,
    );
    expect(row('blocks')).toMatchObject({ actual: blocks.length, planned: null, over: false });

    const defaultRoute = fixture.approvalRoutes.find(
      (r) => r.organizationId === ORG_IDS.aomi && r.isDefault,
    )!;
    const stages = fixture.approvalRouteStages.filter(
      (s) => s.routeId === defaultRoute.id && !s.deletedAt,
    ).length;
    expect(row('approvalLevels')).toMatchObject({ actual: stages, planned: 3 });

    // 計画を超えた項目は止めずに一覧で返す（画面は Notice）
    expect(overview.overages.map((r) => r.key)).toContain('approvalLevels');
    for (const over of overview.overages) {
      expect(over.actual!).toBeGreaterThan(over.planned!);
    }
  });

  it('他組織の行を数えない（他組織のメンバー・データを足しても実績は変わらない）', async () => {
    const before = await loadTrialOverview(db, admin());
    const soten = fixture.memberships.find((m) => m.organizationId === ORG_IDS.soten)!;
    fixture.memberships.push({ ...soten, id: 'extra-membership', status: 'active' });
    const anyPoint = fixture.dataPoints.find((d) => d.organizationId === ORG_IDS.soten);
    if (anyPoint) fixture.dataPoints.push({ ...anyPoint, id: 'extra-point' });
    const after = await loadTrialOverview(db, admin());
    expect(after.rows).toEqual(before.rows);
  });

  it('選定ケースは要求事項のコード・基準名で返し、サンプル（架空）の基準に印を付ける', async () => {
    const overview = await loadTrialOverview(db, admin());
    expect(overview.selectedRequirements.map((r) => r.code)).toEqual([
      '気候-10',
      '気候-11',
      '気候-19',
      '気候-47(1)',
      '40A-S01',
      '40A-S05',
    ]);
    const sample = overview.selectedRequirements.find((r) => r.code === '40A-S01')!;
    expect(sample.isSample).toBe(true);
    expect(overview.selectedRequirements.every((r) => !r.outsideProject)).toBe(true);
    expect(overview.selectedMetrics).toHaveLength(10);
  });

  it('直近 30 日に操作した人の合計は監査ログを読める人だけに出す', async () => {
    const forAdmin = (await loadTrialOverview(db, admin())).rows.find((r) => r.key === 'members')!;
    expect(forAdmin.hint).toContain('直近 30 日に操作した人');
    const forAuthor = (await loadTrialOverview(db, author())).rows.find(
      (r) => r.key === 'members',
    )!;
    expect(forAuthor.hint).not.toContain('直近 30 日');
  });

  it('計画の無い組織は program が null。監査法人のワークスペースからは読めない', async () => {
    expect((await loadTrialOverview(db, otherAdmin())).program).toBeNull();
    await expect(loadTrialOverview(db, firm())).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('saveTrialProgram', () => {
  it('enterprise.org.manage 以外は保存できない（作成担当・拠点担当）', async () => {
    await expect(saveTrialProgram(db, author(), { name: '変更' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(saveTrialProgram(db, site(), { phase: 'tuning' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(fixture.trialPrograms[0]!.name).toBe('試行導入（架空）');
  });

  it('管理者は渡した項目だけを変え、監査ログ settings_changed を残す。Cookie から戻せる', async () => {
    const { program, created } = await saveTrialProgram(db, admin(), {
      phase: 'tuning',
      planned: { plannedApprovalLevels: 5 },
      reductionTarget: { minPercent: 15, maxPercent: 25 },
      cdpPlanned: true,
    });
    expect(created).toBe(false);
    expect(program.phase).toBe('tuning');
    expect(program.plannedApprovalLevels).toBe(5);
    expect(program.plannedMembers).toBe(10);
    expect(program.options).toMatchObject({
      reductionTarget: { minPercent: 15, maxPercent: 25 },
      cdp: true,
    });
    expect(program.updatedBy).toBe(userId('enterprise-admin@demo.local'));
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'settings_changed' && e.resourceType === 'trial_program',
      ),
    ).toBe(true);

    const restored = replay('trialPrograms', program).trialPrograms.find(
      (p) => p.id === program.id,
    )!;
    expect(restored.phase).toBe('tuning');
    expect(restored.options).toMatchObject({ cdp: true });

    const overview = await loadTrialOverview(db, admin());
    expect(overview.overages.map((r) => r.key)).not.toContain('approvalLevels');
    expect(overview.reductionTarget).toEqual({ minPercent: 15, maxPercent: 25 });
  });

  it('入力の誤り: 終了日が開始日より前・条件の無い条件付き導入・範囲外の計画値', async () => {
    await expect(
      saveTrialProgram(db, admin(), { startsOn: '2026-12-01', endsOn: '2026-11-01' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveTrialProgram(db, admin(), { decision: 'conditional', decisionConditions: '' }),
    ).rejects.toThrow('条件付き導入では、条件を入力してください。');
    await expect(
      saveTrialProgram(db, admin(), { planned: { plannedMembers: -1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveTrialProgram(db, admin(), { reductionTarget: { minPercent: 40, maxPercent: 30 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(saveTrialProgram(db, admin(), { name: 'x'.repeat(61) })).rejects.toThrow(
      '60 字以内',
    );
  });

  it('選定ケースは対象プロジェクトの基準の要求事項だけ。他組織のプロジェクト・拠点は見つからない', async () => {
    const ok = await saveTrialProgram(db, admin(), {
      selectedRequirementItemIds: [esrs40aSampleItemId('40A-S02')],
    });
    expect(ok.program.selectedRequirementItemIds).toEqual([esrs40aSampleItemId('40A-S02')]);

    const outside = fixture.disclosureItems.find(
      (i) =>
        !fixture.projectFrameworks.some(
          (f) =>
            f.projectId === IDS.projects.fy2026 && f.frameworkVersionId === i.frameworkVersionId,
        ),
    )!;
    await expect(
      saveTrialProgram(db, admin(), { selectedRequirementItemIds: [outside.id] }),
    ).rejects.toThrow('対象プロジェクトの基準に無い要求事項');

    const sotenProject = fixture.disclosureProjects.find((p) => p.organizationId === ORG_IDS.soten);
    if (sotenProject) {
      await expect(
        saveTrialProgram(db, admin(), { projectId: sotenProject.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    await expect(
      saveTrialProgram(db, admin(), { includedUnitIds: [UNIT_IDS.hq, sotenUnit.id] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('開始前の合意・終了時の扱い・導入判断（人が入力）を保存する', async () => {
    const { program } = await saveTrialProgram(db, admin(), {
      agreements: { decider: { agreedOn: '2026-10-01', note: '判断者を合意（架空）' } },
      endDisposition: 'return',
      endAgreedOn: '2026-10-05',
      decision: 'conditional',
      decisionConditions: '残課題 2 件の解消（架空）',
      decidedByLabel: '推進部長（架空）',
    });
    expect(program.agreements.decider).toEqual({
      agreedOn: '2026-10-01',
      note: '判断者を合意（架空）',
    });
    // 渡していない合意は前のまま
    expect(program.agreements.scope?.agreedOn).not.toBeNull();
    expect(program.decision).toBe('conditional');
    const restored = replay('trialPrograms', program).trialPrograms.find(
      (p) => p.id === program.id,
    )!;
    expect(restored.decision).toBe('conditional');
  });

  it('計画の無い組織では作成する（名前が必須）', async () => {
    await expect(saveTrialProgram(db, otherAdmin(), { phase: 'setup' })).rejects.toThrow(
      '計画の名前を入力してください。',
    );
    const { program, created } = await saveTrialProgram(db, otherAdmin(), {
      name: '試行（越権テスト用）',
    });
    expect(created).toBe(true);
    expect(program.organizationId).toBe(ORG_IDS.soten);
    expect((await loadTrialProgram(db, otherAdmin()))?.id).toBe(program.id);
    // 他組織の計画は見えない
    expect((await loadTrialProgram(db, admin()))?.id).toBe(TRIAL_PROGRAM_ID);
  });

  it('編集の選択肢: 拠点はサプライヤーを除き、選定ケースの候補は対象プロジェクトの基準の要求事項', async () => {
    const choices = await loadTrialFormChoices(db, admin(), fixture.trialPrograms[0]!);
    expect(choices.units.length).toBeLessThan(
      fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi).length,
    );
    expect(choices.units.map((u) => u.id)).toContain(UNIT_IDS.hq);
    expect(choices.frameworks.length).toBe(2);
    expect(choices.frameworks.some((f) => f.isSample)).toBe(true);
    expect(choices.projects.every((p) => typeof p.name === 'string')).toBe(true);
    // 算定の検証期間の候補（組織の期間）と、検証拠点の国コード
    expect(choices.periods.map((p) => p.id)).toContain(GHG_FIXTURE_IDS.period);
    expect(choices.units.find((u) => u.id === GHG_FIXTURE_IDS.units.th)?.countryCode).toBe('TH');
  });
});

describe('算定の検証範囲・将来の展開対象（2026-10-16 の要望 ①。CR-20・CR-21）', () => {
  it('Fixture: 算定の検証拠点 5（国内 1・海外 4。国コード付き）・期間 CY2025・拠点別の状況・全 30 拠点', async () => {
    const overview = await loadTrialOverview(db, admin());
    const scope = overview.scope!;
    expect(scope.verification.configured).toBe(true);
    expect(scope.verification.fromIncludedUnits).toBe(false);
    expect(scope.verification.period?.id).toBe(GHG_FIXTURE_IDS.period);
    expect(scope.verification.sites.map((s) => s.id)).toEqual([...GHG_VERIFICATION_UNIT_IDS]);
    expect(scope.verification.sites.map((s) => s.countryCode)).toEqual([
      'JP',
      'TH',
      'VN',
      'MX',
      'US',
    ]);
    expect(scope.verification).toMatchObject({ domestic: 1, overseas: 4 });
    expect(scope.verification.scopes).toEqual(['scope1', 'scope2', 'scope2_location']);
    // 拠点別の状況は算定の概要と同じ関数（status.ts）
    expect(scope.verification.status?.units.map((u) => u.unit.id)).toEqual([
      ...GHG_VERIFICATION_UNIT_IDS,
    ]);
    expect(scope.rollout).toEqual({
      totalSites: GHG_ROLLOUT_TOTAL_SITES,
      note: '（架空）検証の結果を見て海外の生産拠点へ順に広げる',
      verifying: 5,
      remaining: GHG_ROLLOUT_TOTAL_SITES - 5,
    });
    // 対象拠点（計画の includedUnitIds）の意味は変えない。タイルの補足に展開対象の総数を添える
    const sites = overview.rows.find((r) => r.key === 'sites')!;
    expect(sites).toMatchObject({ actual: 3, planned: 3 });
    expect(sites.hint).toContain(`展開対象 全 ${GHG_ROLLOUT_TOTAL_SITES}`);
  });

  it('算定の検証拠点が空なら計画の対象拠点を使う（K9）', async () => {
    const program = fixture.trialPrograms[0]!;
    program.options = {
      ...program.options,
      ghgVerification: { ...(program.options.ghgVerification as object), unitIds: [] },
    };
    const scope = (await loadTrialOverview(db, admin())).scope!;
    expect(scope.verification.fromIncludedUnits).toBe(true);
    expect(scope.verification.sites.map((s) => s.id)).toEqual(program.includedUnitIds);
    expect(scope.rollout.verifying).toBe(program.includedUnitIds.length);
  });

  it('展開対象・検証範囲・PDF の目安を保存する（既存の options は残す）。Cookie から戻せる', async () => {
    const before = fixture.trialPrograms[0]!.options.disposal;
    const { program } = await saveTrialProgram(db, admin(), {
      rollout: { totalSites: 44, note: '  （架空）海外の拠点へ順に  ' },
      ghgVerification: {
        periodId: GHG_FIXTURE_IDS.period,
        unitIds: [UNIT_IDS.east, GHG_FIXTURE_IDS.units.th],
        scopes: ['scope1'],
        activityKinds: ['fuel', 'transport'],
      },
      freeScope: { pdfFiles: 50 },
      cdpPlanned: true,
    });
    expect(program.options).toMatchObject({
      rollout: { totalSites: 44, note: '（架空）海外の拠点へ順に' },
      ghgVerification: {
        unitIds: [UNIT_IDS.east, GHG_FIXTURE_IDS.units.th],
        scopes: ['scope1'],
      },
      freeScope: { pdfFiles: 50 },
      disposal: before,
      cdp: true,
    });
    const restored = replay('trialPrograms', program).trialPrograms.find(
      (p) => p.id === program.id,
    )!;
    expect(restored.options).toMatchObject({
      rollout: { totalSites: 44 },
      freeScope: { pdfFiles: 50 },
    });
    const scope = (await loadTrialOverview(db, admin())).scope!;
    expect(scope.verification).toMatchObject({ domestic: 1, overseas: 1 });
    expect(scope.rollout).toMatchObject({ totalSites: 44, verifying: 2, remaining: 42 });
  });

  it('展開対象の総拠点数が検証対象の拠点数より少ないと保存しない（展開対象は全体の数）', async () => {
    await expect(
      saveTrialProgram(db, admin(), { rollout: { totalSites: 4, note: '' } }),
    ).rejects.toThrow('検証対象の拠点数（5）より少なくなっています');
    // 検証拠点を増やして、保存済みの展開対象の総拠点数を超える場合も断る
    await saveTrialProgram(db, admin(), { rollout: { totalSites: 5, note: '' } });
    await expect(
      saveTrialProgram(db, admin(), {
        ghgVerification: {
          periodId: GHG_FIXTURE_IDS.period,
          unitIds: [...GHG_VERIFICATION_UNIT_IDS, UNIT_IDS.hq],
          scopes: [],
          activityKinds: [],
        },
      }),
    ).rejects.toThrow('将来の展開対象の拠点数（5）');
  });

  it('検証範囲の入力の誤り: 他組織の拠点・知らない Scope・組織に無い期間・PDF の目安の範囲外・長いメモ', async () => {
    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    const base = {
      periodId: GHG_FIXTURE_IDS.period as string | null,
      unitIds: [UNIT_IDS.east as string],
      scopes: ['scope1' as const],
      activityKinds: [],
    };
    await expect(
      saveTrialProgram(db, admin(), { ghgVerification: { ...base, unitIds: [sotenUnit.id] } }),
    ).rejects.toThrow('組織の拠点ではないもの');
    await expect(
      saveTrialProgram(db, admin(), {
        ghgVerification: { ...base, scopes: ['scope9' as never] },
      }),
    ).rejects.toThrow('知らない値');
    const sotenPeriod = fixture.periods.find((p) => p.organizationId === ORG_IDS.soten)!;
    await expect(
      saveTrialProgram(db, admin(), { ghgVerification: { ...base, periodId: sotenPeriod.id } }),
    ).rejects.toThrow('算定の検証期間が見つかりません');
    await expect(
      saveTrialProgram(db, admin(), { freeScope: { pdfFiles: 100_001 } }),
    ).rejects.toThrow('PDF 等の一次データの目安');
    await expect(
      saveTrialProgram(db, admin(), { rollout: { totalSites: 30, note: 'あ'.repeat(101) } }),
    ).rejects.toThrow('100 字まで');
  });

  it('検証範囲を空にすると options から外す。組織の管理以外は保存できない', async () => {
    const { program } = await saveTrialProgram(db, admin(), {
      ghgVerification: { periodId: null, unitIds: [], scopes: [], activityKinds: [] },
      rollout: null,
    });
    expect(program.options).not.toHaveProperty('ghgVerification');
    expect(program.options).not.toHaveProperty('rollout');
    await expect(
      saveTrialProgram(db, author(), { rollout: { totalSites: 30, note: '' } }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('無償の範囲と別途協議（2026-10-16 の要望 ④。CR-23）', () => {
  it('Fixture: 合意を出し、4 区分の信号（拠点の外のデータ・PDF・連携・新規開発）を数える', async () => {
    const scope = (await loadTrialOverview(db, admin())).scope!;
    expect(scope.freeScope.agreement?.agreedOn).not.toBeNull();
    const program = fixture.trialPrograms[0]!;
    const project = fixture.disclosureProjects.find((p) => p.id === program.projectId)!;
    const trialSites = new Set([...program.includedUnitIds, ...GHG_VERIFICATION_UNIT_IDS]);
    const supplier = new Set(
      fixture.units.filter((u) => u.unitType === 'supplier').map((u) => u.id),
    );
    const outside = fixture.dataPoints.filter(
      (d) =>
        d.organizationId === ORG_IDS.aomi &&
        !d.deletedAt &&
        d.reportingPeriodId === project.reportingPeriodId &&
        (d.value !== null || (d.textValue ?? '') !== '') &&
        !trialSites.has(d.unitId) &&
        !supplier.has(d.unitId),
    );
    expect(outside.length).toBeGreaterThan(0);
    const signal = (kind: string) => scope.freeScope.signals.find((s) => s.kind === kind)!;
    expect(signal('site_expansion')).toMatchObject({ count: trialSites.size, threshold: 3 });
    expect(signal('site_expansion').state).toBe('over');
    expect(signal('site_expansion').detail).toContain(
      `${new Set(outside.map((d) => d.unitId)).size} 拠点に対象期間のデータ ${outside.length} 件`,
    );
    expect(signal('bulk_primary_data')).toMatchObject({ threshold: 20, state: 'within' });
    expect(signal('system_integration').state).toBe('not_measured');
    expect(signal('custom_development')).toMatchObject({ count: 1, state: 'over' });
    expect(scope.freeScope.over.map((s) => s.kind)).toEqual([
      'site_expansion',
      'custom_development',
    ]);
  });

  it('他組織のデータ・PDF は数えない', async () => {
    const before = (await loadTrialOverview(db, admin())).scope!.freeScope.signals;
    const sotenPoint = fixture.dataPoints.find((d) => d.organizationId === ORG_IDS.soten);
    if (sotenPoint) fixture.dataPoints.push({ ...sotenPoint, id: 'soten-extra' });
    const template = fixture.ingestionJobFiles[0]!;
    fixture.ingestionJobFiles.push({
      ...template,
      id: 'pdf-other-org',
      organizationId: ORG_IDS.soten,
      mimeType: 'application/pdf',
      parseStatus: 'needs_ocr',
      createdAt: '2026-08-01T03:00:00.000Z',
    });
    const after = (await loadTrialOverview(db, admin())).scope!.freeScope.signals;
    expect(after).toEqual(before);
  });

  it('PDF はトライアルの期間に作られたものだけ。OCR が要るものは 1 件でも標準機能の外', async () => {
    const before = (await loadTrialOverview(db, admin())).scope!.freeScope.signals.find(
      (s) => s.kind === 'bulk_primary_data',
    )!;
    const template = fixture.ingestionJobFiles.find((f) => f.organizationId === ORG_IDS.aomi)!;
    fixture.ingestionJobFiles.push(
      {
        ...template,
        id: 'pdf-in-period',
        mimeType: 'application/pdf',
        originalName: '（架空）請求書.pdf',
        parseStatus: 'needs_ocr',
        createdAt: '2026-08-01T03:00:00.000Z',
      },
      {
        ...template,
        id: 'pdf-before-period',
        mimeType: 'application/pdf',
        originalName: '（架空）古い請求書.pdf',
        parseStatus: 'parsed',
        createdAt: '2026-01-01T03:00:00.000Z',
      },
    );
    const after = (await loadTrialOverview(db, admin())).scope!.freeScope.signals.find(
      (s) => s.kind === 'bulk_primary_data',
    )!;
    expect(after.count).toBe((before.count ?? 0) + 1);
    expect(after.state).toBe('over');
    expect(after.detail).toContain('標準機能の外（OCR）: 文字を取れない PDF 1 件');
  });

  it('全社（対象拠点の指定なし）なら拠点の外は無い。区分の無い別途協議はどの区分にも数えず件数を返す', async () => {
    const program = fixture.trialPrograms[0]!;
    program.includedUnitIds = [];
    const item = fixture.trialFeedbackItems.find(
      (f) => f.organizationId === ORG_IDS.aomi && f.costClass !== 'separate_estimate',
    )!;
    item.costClass = 'separate_estimate';
    item.scopeKind = null;
    const scope = (await loadTrialOverview(db, admin())).scope!;
    const site = scope.freeScope.signals.find((s) => s.kind === 'site_expansion')!;
    expect(site.count).toBeNull();
    expect(site.detail).toContain('全社');
    expect(site.detail).not.toContain('対象期間のデータ');
    expect(scope.freeScope.unclassifiedSeparate).toBe(1);
    expect(scope.freeScope.signals.find((s) => s.kind === 'custom_development')!.count).toBe(1);
  });
});

describe('返却・削除の予定日と消去の見込み日（2026-10-16 の要望 ⑦。CR-26）', () => {
  it('予定日 + データ取扱条件の最新の版の残存期間（Fixture は架空の 35 日）', async () => {
    const { program } = await saveTrialProgram(db, admin(), {
      disposal: { plannedOn: '2027-01-31' },
      endDisposition: 'delete',
    });
    expect(program.options.disposal).toEqual({ plannedOn: '2027-01-31' });
    const scope = (await loadTrialOverview(db, admin())).scope!;
    expect(scope.disposal).toEqual({
      plannedOn: '2027-01-31',
      backupResidualDays: 35,
      purgeDueOn: '2027-03-07',
    });
  });

  it('残存期間が未合意なら見込み日を出さない。予定日の形の誤りは保存しない。空にすると外す', async () => {
    fixture.organizationDataTerms
      .filter((t) => t.organizationId === ORG_IDS.aomi)
      .forEach((t) => (t.backupResidualDays = null));
    const scope = (await loadTrialOverview(db, admin())).scope!;
    expect(scope.disposal.plannedOn).not.toBeNull();
    expect(scope.disposal.purgeDueOn).toBeNull();
    await expect(
      saveTrialProgram(db, admin(), { disposal: { plannedOn: '2027/01/31' } }),
    ).rejects.toThrow('返却・削除の予定日は日付');
    const { program } = await saveTrialProgram(db, admin(), { disposal: { plannedOn: null } });
    expect(program.options).not.toHaveProperty('disposal');
  });
});
