import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import {
  TRIAL_FICTIONAL_MEMBERS,
  trialMemberUserId,
  trialScenarioId,
} from '@/lib/fixtures/trial-case';
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
  businessCompletion,
  checkedEvidenceUrl,
  judgeScenario,
  measuredValueCandidates,
  recordScenarioRun,
  summarizeScenarios,
} from '@/lib/services/trial-evaluation';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 検証シナリオ・実施記録・評価者の判定（NF-33）と、検証結果・改善管理表の XLSX。
 *  - 実施は本人名義（追記専用・訂正は自分の記録だけ）。判定は enterprise.org.manage・取り消せない
 *  - 率は n と一緒に返し、n < 3 では出さない。測定値の候補は出すが、判定は人
 *  - XLSX のシートと注記（Demo は架空の注記）。権限なしは 403
 */

const state: { ctx: AuthorizationContext | null; db: DemoDbClient | null } = {
  ctx: null,
  db: null,
};

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));

const { GET } = await import('@/app/api/exports/trial-report/route');

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
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

describe('summarizeScenarios', () => {
  it('Fixture の 8 シナリオと実施 6 件を集計し、n < 3 の率は出さない', async () => {
    const summary = await summarizeScenarios(db, author());
    expect(summary.rows.map((r) => r.scenario.code)).toEqual([
      'TS-01',
      'TS-02',
      'TS-03',
      'TS-04',
      'TS-05',
      'TS-06',
      'TS-07',
      'S-CALC-01',
    ]);
    expect(summary.runCount).toBe(6);
    // 自力で完了 4（TS-01・TS-04・TS-05 のレビュー担当・TS-03）/ 6
    expect(summary.completion).toMatchObject({ numerator: 4, n: 6, label: '66.7%（4 / 6）' });
    const ts05 = summary.rows.find((r) => r.scenario.code === 'TS-05')!;
    expect(ts05.effectiveRunCount).toBe(2);
    expect(ts05.completion.label).toBe('件数不足（n=2）');
    // 判定は TS-01 合格・TS-04 保留の 2 件 → 合格率は件数不足、未判定 6 件（S-CALC-01 を含む）は分母に入れない
    expect(summary.pass).toMatchObject({ rate: null, n: 2, notJudged: 6 });
    expect(summary.rows.find((r) => r.scenario.code === 'TS-01')!.state).toBe('pass');
    expect(summary.rows.find((r) => r.scenario.code === 'TS-02')!.state).toBe('not_judged');
  });

  it('監査法人のワークスペース・他組織からは見えない', async () => {
    await expect(summarizeScenarios(db, firm())).rejects.toBeInstanceOf(AuthorizationError);
    expect((await summarizeScenarios(db, otherAdmin())).rows).toEqual([]);
  });
});

describe('recordScenarioRun（本人名義・追記専用）', () => {
  it('拠点担当も記録できる。名義・役割・環境の版はサーバーが入れ、Cookie から戻せる', async () => {
    const run = await recordScenarioRun(db, site(), {
      scenarioId: trialScenarioId('TS-02'),
      completion: 'self',
      minutes: 12.5,
      helpCount: 0,
      easeRating: 4,
      comment: '（架空）迷わず区分で絞り込めた。',
      evidenceUrl: '/enterprise/disclosure-projects',
    });
    expect(run.performedBy).toBe(userId('site-user@demo.local'));
    expect(run.performedRole).not.toBe('');
    expect(run.environmentVersion).not.toBe('');
    expect(run.evidence).toEqual({ url: '/enterprise/disclosure-projects' });
    expect(run.startedAt! < run.endedAt!).toBe(true);
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'data_created' && e.resourceType === 'trial_scenario_run',
      ),
    ).toBe(true);
    const restored = replay('trialScenarioRuns', run).trialScenarioRuns.find(
      (r) => r.id === run.id,
    );
    expect(restored?.performedBy).toBe(run.performedBy);

    const ts02 = (await summarizeScenarios(db, site())).rows.find(
      (r) => r.scenario.code === 'TS-02',
    )!;
    expect(ts02.effectiveRunCount).toBe(2);
  });

  it('訂正は自分の記録だけ。訂正された記録は数えない', async () => {
    const own = await recordScenarioRun(db, author(), {
      scenarioId: trialScenarioId('TS-06'),
      completion: 'not_completed',
      minutes: 30,
      helpCount: 3,
      easeRating: null,
      comment: '',
      evidenceUrl: '',
    });
    const corrected = await recordScenarioRun(db, author(), {
      scenarioId: trialScenarioId('TS-06'),
      completion: 'self',
      minutes: 20,
      helpCount: 0,
      easeRating: null,
      comment: '（架空）記録の訂正',
      evidenceUrl: '',
      supersedesRunId: own.id,
    });
    expect(corrected.supersedesRunId).toBe(own.id);
    const ts06 = (await summarizeScenarios(db, author())).rows.find(
      (r) => r.scenario.code === 'TS-06',
    )!;
    expect(ts06.effectiveRunCount).toBe(1);
    expect(ts06.runs.find((r) => r.id === own.id)?.superseded).toBe(true);

    await expect(
      recordScenarioRun(db, site(), {
        scenarioId: trialScenarioId('TS-06'),
        completion: 'self',
        minutes: null,
        helpCount: null,
        easeRating: null,
        comment: '',
        evidenceUrl: '',
        supersedesRunId: corrected.id,
      }),
    ).rejects.toThrow('訂正できるのは自分の記録だけです。');
  });

  it('入力の誤り・他組織のシナリオ・停止中のメンバーは記録できない', async () => {
    const base = {
      scenarioId: trialScenarioId('TS-01'),
      completion: 'self',
      minutes: 10,
      helpCount: 0,
      easeRating: null,
      comment: '',
      evidenceUrl: '',
    };
    await expect(
      recordScenarioRun(db, author(), { ...base, completion: 'done' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordScenarioRun(db, author(), { ...base, comment: 'あ'.repeat(301) }),
    ).rejects.toThrow('300 字以内');
    await expect(
      recordScenarioRun(db, author(), { ...base, evidenceUrl: 'https://example.com/x' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(recordScenarioRun(db, otherAdmin(), base)).rejects.toBeInstanceOf(NotFoundError);

    const suspended = TRIAL_FICTIONAL_MEMBERS[0]!;
    const memberId = trialMemberUserId(suspended.email);
    const membership = fixture.memberships.find(
      (m) => m.userId === memberId && m.organizationId === ORG_IDS.aomi,
    )!;
    membership.status = 'suspended';
    const ctx = { ...author(), userId: memberId, email: suspended.email };
    await expect(recordScenarioRun(db, ctx, base)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('証跡はアプリ内のパスだけ', () => {
    expect(checkedEvidenceUrl('/enterprise/data?status=draft')).toBe(
      '/enterprise/data?status=draft',
    );
    expect(() => checkedEvidenceUrl('//evil.example')).toThrow(ValidationError);
    expect(() => checkedEvidenceUrl('javascript:alert(1)')).toThrow(ValidationError);
  });
});

describe('judgeScenario（enterprise.org.manage・取り消せない）', () => {
  it('管理者だけが判定でき、最新の判定が表示に使われる。理由は必須', async () => {
    await expect(
      judgeScenario(db, author(), {
        scenarioId: trialScenarioId('TS-04'),
        judgement: 'pass',
        reason: '不一致 0 件',
        measuredValue: '',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      judgeScenario(db, admin(), {
        scenarioId: trialScenarioId('TS-04'),
        judgement: 'pass',
        reason: '  ',
        measuredValue: '',
      }),
    ).rejects.toThrow('判定の理由を入力してください。');

    const judgement = await judgeScenario(db, admin(), {
      scenarioId: trialScenarioId('TS-04'),
      judgement: 'pass',
      reason: '（架空）外部で編集したファイルも照合し、不一致 0 件を確認した。',
      measuredValue: '不一致 0 件',
    });
    expect(judgement.judgedBy).toBe(userId('enterprise-admin@demo.local'));
    const ts04 = (await summarizeScenarios(db, admin())).rows.find(
      (r) => r.scenario.code === 'TS-04',
    )!;
    expect(ts04.state).toBe('pass');
    // 前の判定（保留）も履歴に残る
    expect(ts04.judgements.map((j) => j.judgement).sort()).toEqual(['hold', 'pass']);

    const restored = replay('trialScenarioJudgements', judgement).trialScenarioJudgements.find(
      (j) => j.id === judgement.id,
    );
    expect(restored?.judgement).toBe('pass');
  });

  it('既にある判定を書き換えた Cookie は戻さない（追記専用）', () => {
    const existing = fixture.trialScenarioJudgements[0]!;
    const tampered = { ...existing, judgement: 'fail' as const, reason: '書き換え' };
    const restored = replay('trialScenarioJudgements', tampered).trialScenarioJudgements.find(
      (j) => j.id === existing.id,
    )!;
    expect(restored.judgement).toBe(existing.judgement);
    expect(restored.reason).toBe(existing.reason);
  });
});

describe('測定値の候補と業務の完遂状況', () => {
  it('候補: 追跡率（承認済みスナップショット・選定ケース）・突合なし・未判定の件数。判定はしない', async () => {
    const before = fixture.trialScenarioJudgements.length;
    const candidates = await measuredValueCandidates(db, admin());
    expect(candidates.traceability?.value).toMatch(/^追跡率 \d+(\.\d)?%（\d+ \/ \d+）$/);
    expect(candidates.traceability?.source).toContain('選定ケース 6 件');
    expect(candidates.output_reuse).toEqual({
      value: null,
      source: '出力の突合の記録がありません',
    });
    expect(candidates.gap_distinction?.value).toMatch(/^未判定 \d+ 件 \/ \d+ 件$/);
    for (const candidate of Object.values(candidates)) {
      if (candidate?.value) expect(candidate.value.length).toBeLessThanOrEqual(60);
    }
    expect(fixture.trialScenarioJudgements.length).toBe(before);
    await expect(measuredValueCandidates(db, author())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('業務の完遂状況は既存の業務記録から数える（取込・レビュー・承認段階）', async () => {
    const result = await businessCompletion(db, author());
    const jobs = fixture.ingestionJobs.filter(
      (j) => j.organizationId === ORG_IDS.aomi && j.status !== 'cancelled',
    );
    expect(result.ingestion.n).toBe(jobs.length);
    expect(result.ingestion.numerator).toBe(jobs.filter((j) => j.status === 'completed').length);
    const steps = fixture.dataPointApprovalSteps.filter(
      (s) =>
        s.organizationId === ORG_IDS.aomi && (s.status === 'approved' || s.status === 'returned'),
    );
    expect(result.dataReturn.n).toBe(steps.length);
    const batches = fixture.quantitativeImportBatches.filter(
      (b) => b.organizationId === ORG_IDS.aomi,
    );
    expect(result.standardImport.n).toBe(batches.length);
    if (batches.length === 0) expect(result.standardImport.label).toBe('記録なし');
    const events = fixture.reviewEvents.filter((e) => e.organizationId === ORG_IDS.aomi);
    expect(result.review.returned).toBe(events.filter((e) => e.eventType === 'returned').length);
    expect(result.review.requests).toBe(
      new Set(events.filter((e) => e.eventType === 'requested').map((e) => e.reviewRequestId)).size,
    );
    expect(result.review.requests).toBeGreaterThan(0);
  });
});

describe('GET /api/exports/trial-report（検証結果・改善管理表の XLSX）', () => {
  it('管理者は 7 シートの XLSX を受け取り、Demo の架空の注記が入る。監査ログ export_created', async () => {
    state.ctx = admin();
    const response = await GET(new Request('http://localhost/api/exports/trial-report'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'シナリオ結果',
      '操作と工数',
      '改善管理表',
      '作業時間',
      '作業時間（作業ごと）',
      '集計',
      '注記',
    ]);
    const notes = workbook.getWorksheet('注記')!;
    const noteTexts: string[] = [];
    notes.eachRow((row) => noteTexts.push(String(row.getCell(1).value ?? '')));
    expect(noteTexts.some((t) => t.includes('架空のトライアル記録です'))).toBe(true);
    const scenarios = workbook.getWorksheet('シナリオ結果')!;
    // 見出し 1 行 ＋ シナリオ 8 件（算定の再現と整合性の確認 S-CALC-01 を含む）
    expect(scenarios.rowCount).toBe(9);
    // 実施者の氏名は出さない（役割名だけ）
    const runs = workbook.getWorksheet('操作と工数')!;
    const header = (runs.getRow(1).values as unknown[]).map(String);
    expect(header.join(',')).not.toContain('氏名');
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'export_created' && e.resourceType === 'trial_report',
      ),
    ).toBe(true);
  });

  it('管理者以外・監査法人は 403（JSON）で、access_denied を記録する。未ログインは 401', async () => {
    state.ctx = author();
    const denied = await GET(new Request('http://localhost/api/exports/trial-report'));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Content-Type')).toContain('application/json');
    expect(fixture.auditEvents.some((e) => e.eventType === 'access_denied')).toBe(true);
    state.ctx = firm();
    expect((await GET(new Request('http://localhost/api/exports/trial-report'))).status).toBe(403);
    state.ctx = null;
    expect((await GET(new Request('http://localhost/api/exports/trial-report'))).status).toBe(401);
  });
});
