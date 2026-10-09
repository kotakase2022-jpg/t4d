import { readFileSync } from 'node:fs';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { buildReportExportCards } from '@/lib/exports';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { listFiles } from '../support/static-analysis';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CDP 対応オプションの組織単位の有効化（トライアル対応 NF-38。int:cdp-option）。
 *
 * 契約の無い組織では、CDP の画面（一覧・質問・取込）・出力 API・Action（AI 草案・対応付け・整合チェック・
 * 取込・保存・担当）・分析（規制対応度）・レポートのカードが止まる。画面は 404 にせず理由を出す。
 * CSRD の回答（同じ回答画面・同じ関数）は止めない（項目の基準で判定する）。
 * 契約は運営が設定し、アプリのコードに organization_options を書く経路は無い（顧客は書けない）。
 */

const jar = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({
  ctx: null as AuthorizationContext | null,
  db: null as unknown,
  shell: null as unknown,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.ctx,
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({ getDb: async () => state.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/services/shell', () => ({ loadEnterpriseShell: async () => state.shell }));

// integration の設定は JSX を React.createElement へ変換する（react プラグインは unit だけ）。画面の関数を
// 呼んで返す要素の種類を確かめるため、React を大域に置く（描画はしない）
(globalThis as { React?: typeof React }).React = React;

const { GET } = await import('@/app/api/exports/cdp/route');
const enterpriseActions = await import('@/app/enterprise/actions');
const cdpActions = await import('@/app/enterprise/disclosures/cdp/actions');
const { default: CdpWorkspacePage } = await import('@/app/enterprise/disclosures/cdp/page');
const { default: DisclosureImportPage } =
  await import('@/app/enterprise/disclosures/cdp/import/page');
const { QuestionDetailView } = await import('@/app/enterprise/disclosures/question-view');
const { CdpNotContracted } =
  await import('@/app/enterprise/disclosures/cdp/_components/cdp-not-contracted');
const { loadDisclosureWorkspace, FrameworkOptionNotContractedError } =
  await import('@/lib/services/disclosure');
const { generateDisclosureDraft, saveDisclosureResponse, transitionDisclosureResponse } =
  await import('@/lib/services/disclosure-write');
const { runDisclosureConsistencyCheck } = await import('@/lib/services/disclosure-check');
const { confirmDisclosureImport } = await import('@/lib/services/disclosure-import');
const { loadRegulatoryCoverage, CDP_OPTION_NOT_CONTRACTED_REASON } =
  await import('@/lib/services/analysis/regulations');
const { collectOrgSnapshot } = await import('@/lib/services/org-snapshot');
const { evaluateApplicability } = await import('@/lib/services/disclosure-applicability');
const { runQuestionMapping } = await import('@/lib/services/ai-assist');
const { searchPalette } = await import('@/lib/services/palette-search');

let fixture: FixtureDb;
let db: DemoDbClient;

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const approver = () => enterprise('approver@demo.local', ['approver', 'reviewer']);
const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);

function shellFor(ctx: AuthorizationContext): EnterpriseShell {
  return {
    db,
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi),
    currentPeriod: fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    units: fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi),
    metrics: fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
    unreadNotifications: 0,
  };
}

/** AOMI（実演の組織）の CDP 対応オプションを無効にする（契約なしの状態を作る） */
function withoutCdpOption(): void {
  for (const option of fixture.organizationOptions) {
    if (option.organizationId === ORG_IDS.aomi && option.optionKey === 'cdp') {
      option.enabled = false;
    }
  }
}

const cdpItemId = (code: string) => fid('disclosure_item', `cdp/2026/${code}`);
const cdpResponse = (code: string) =>
  fixture.disclosureResponses.find(
    (r) => r.itemId === cdpItemId(code) && r.reportingPeriodId === PERIOD_IDS.fy2026,
  )!;
function csrdResponse() {
  const framework = fixture.frameworks.find((f) => f.key === 'csrd')!;
  const version = fixture.frameworkVersions.find((v) => v.frameworkId === framework.id)!;
  const itemIds = new Set(
    fixture.disclosureItems.filter((i) => i.frameworkVersionId === version.id).map((i) => i.id),
  );
  return fixture.disclosureResponses.find(
    (r) => itemIds.has(r.itemId) && r.reportingPeriodId === PERIOD_IDS.fy2026,
  )!;
}

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) return new URL(getURLFromRedirectError(error), 'http://localhost');
    throw error;
  }
  throw new Error('リダイレクトしなかった');
}

const CDP_URL = (query = 'format=csv') => `http://localhost/api/exports/cdp?${query}`;

beforeEach(() => {
  jar.clear();
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = manager();
  state.shell = shellFor(manager());
});

describe('画面（契約が無ければ理由を出す。404 にしない）', () => {
  it('契約ありの組織（実演の組織）は CDP の一覧を描く', async () => {
    const element = await CdpWorkspacePage({ searchParams: Promise.resolve({}) });
    expect(element.type).not.toBe(CdpNotContracted);
  });

  it('契約なしの組織では、一覧・質問・取込のどれも「契約されていません」の画面になる', async () => {
    withoutCdpOption();
    const list = await CdpWorkspacePage({ searchParams: Promise.resolve({}) });
    expect(list.type).toBe(CdpNotContracted);

    const question = await QuestionDetailView({
      frameworkKey: 'cdp',
      frameworkLabel: 'CDP',
      basePath: '/enterprise/disclosures/cdp',
      questionId: cdpItemId('C6.1'),
    });
    expect(question.type).toBe(CdpNotContracted);

    const importPage = await DisclosureImportPage({ searchParams: Promise.resolve({}) });
    expect(importPage.type).toBe(CdpNotContracted);
  });

  it('契約なしでも CSRD の回答画面（同じ部品）は止めない', async () => {
    withoutCdpOption();
    const item = fixture.disclosureItems.find((i) => i.id === csrdResponse().itemId)!;
    const view = await QuestionDetailView({
      frameworkKey: 'csrd',
      frameworkLabel: 'CSRD',
      basePath: '/enterprise/disclosures/csrd',
      questionId: item.id,
    });
    expect(view.type).not.toBe(CdpNotContracted);
  });
});

describe('出力 API', () => {
  it('契約ありは出力できる。契約なしは CDP だけ 403（JSON）で、CSRD・SSBJ は出力できる', async () => {
    expect((await GET(new Request(CDP_URL()))).status).toBe(200);

    withoutCdpOption();
    const denied = await GET(new Request(CDP_URL()));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'option_not_contracted',
      message: 'CDP 対応オプションは契約されていません。',
    });
    expect((await GET(new Request(CDP_URL('framework=csrd&format=csv')))).status).toBe(200);
    expect((await GET(new Request(CDP_URL('framework=ssbj&format=csv')))).status).toBe(200);
    // 出力の記録（export_created）を残さない（出していない）
    expect(
      fixture.auditEvents.filter(
        (e) => e.eventType === 'export_created' && e.metadata?.framework === 'cdp',
      ),
    ).toHaveLength(1);
  });

  it('出力の権限が無ければ契約に関わらず従来どおり 403（権限の拒否）', async () => {
    state.ctx = enterprise('reviewer@demo.local', ['reviewer']);
    const response = await GET(new Request(CDP_URL()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });
});

describe('Action（項目の基準で判定する）', () => {
  it('契約なしでは CDP の AI 草案・保存・状態遷移・整合チェック・取込・担当・回答の開始を断る', async () => {
    withoutCdpOption();
    const response = cdpResponse('C6.1');
    const aiRunsBefore = fixture.aiRuns.length;

    await expect(generateDisclosureDraft(db, manager(), response.id)).rejects.toBeInstanceOf(
      FrameworkOptionNotContractedError,
    );
    await expect(
      saveDisclosureResponse(db, manager(), {
        responseId: response.id,
        answerText: '保存しない',
        answerNumeric: null,
        answerChoice: [],
        aiRunId: null,
        editedFromAi: false,
      }),
    ).rejects.toBeInstanceOf(FrameworkOptionNotContractedError);
    await expect(
      transitionDisclosureResponse(db, manager(), response.id, 'in_review'),
    ).rejects.toBeInstanceOf(FrameworkOptionNotContractedError);
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const fy2026 = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    await expect(
      runDisclosureConsistencyCheck(db, manager(), 'cdp', fy2026, periods),
    ).rejects.toBeInstanceOf(FrameworkOptionNotContractedError);
    await expect(
      confirmDisclosureImport(db, manager(), {
        targetPeriodId: PERIOD_IDS.fy2025,
        currentPeriodId: PERIOD_IDS.fy2026,
        selections: [{ itemId: cdpItemId('C0.1'), answerText: '取り込まない' }],
      }),
    ).rejects.toBeInstanceOf(FrameworkOptionNotContractedError);
    // AI を呼んでいない・回答を書いていない
    expect(fixture.aiRuns.length).toBe(aiRunsBefore);
    expect(cdpResponse('C6.1').status).toBe(response.status);
  });

  it('画面の Action も理由（?error=）を付けて戻す（AI 草案・質問マッピング・担当の割当・回答の開始）', async () => {
    withoutCdpOption();
    const message = 'CDP 対応オプションは契約されていません。';
    const draft = await redirectOf(() =>
      enterpriseActions.generateCdpDraftAction(form([['responseId', cdpResponse('C6.1').id]])),
    );
    expect(draft.searchParams.get('error')).toBe(message);

    const mapping = await redirectOf(() =>
      enterpriseActions.runQuestionMappingAction(form([['frameworkKey', 'cdp']])),
    );
    expect(mapping.pathname).toBe('/enterprise/disclosures/cdp');
    expect(mapping.searchParams.get('error')).toBeTruthy();
    expect(mapping.searchParams.get('mapping')).toBeNull();

    const assign = await redirectOf(() =>
      cdpActions.assignResponseAction(
        form([
          ['itemId', cdpItemId('C6.1')],
          ['periodId', PERIOD_IDS.fy2026],
          ['ownerUserId', userId('sustainability@demo.local')],
        ]),
      ),
    );
    expect(assign.searchParams.get('error')).toBe(message);

    const start = await redirectOf(() =>
      cdpActions.startResponseDraftAction(
        form([
          ['itemId', cdpItemId('C12.1')],
          ['periodId', PERIOD_IDS.fy2026],
        ]),
      ),
    );
    expect(start.searchParams.get('error')).toBe(message);
    // 契約の不足は権限の拒否ではない（access_denied を記録しない）
    expect(fixture.auditEvents.filter((e) => e.eventType === 'access_denied')).toHaveLength(0);
  });

  it('契約なしでも CSRD の回答は保存・承認できる（同じ関数）', async () => {
    withoutCdpOption();
    const response = csrdResponse();
    await saveDisclosureResponse(db, manager(), {
      responseId: response.id,
      answerText: 'CSRD の回答は止めない',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    const approved = await transitionDisclosureResponse(db, approver(), response.id, 'approved');
    expect(approved.status).toBe('approved');
  });
});

describe('分析・レポート・ほかの読込', () => {
  it('規制対応度の CDP 行は「オプション未契約」で算定しない（0 件と出さない）', async () => {
    const fy2026 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const contracted = await loadRegulatoryCoverage(db, manager(), fy2026);
    expect(contracted.rows.find((r) => r.key === 'cdp')!.responses).not.toBeNull();

    withoutCdpOption();
    const coverage = await loadRegulatoryCoverage(db, manager(), fy2026);
    const cdp = coverage.rows.find((r) => r.key === 'cdp')!;
    expect(cdp.notCalculatedReason).toBe(CDP_OPTION_NOT_CONTRACTED_REASON);
    expect(cdp.notCalculatedReason).toContain('オプション未契約');
    expect(cdp.inScope).toBeNull();
    expect(cdp.responses).toBeNull();
    expect(cdp.links).toEqual([]);
    expect(cdp.notes).toContain('CDP 対応オプションは契約されていません。');
  });

  it('レポートの CDP のカードは契約があるときだけ（契約の有無を渡す）', () => {
    expect(buildReportExportCards('p', { cdpOption: true }).map((c) => c.title)).toContain(
      'CDP 回答一覧',
    );
    expect(buildReportExportCards('p', { cdpOption: false }).map((c) => c.title)).not.toContain(
      'CDP 回答一覧',
    );
  });

  it('一覧の読込は契約なしで null。AI Copilot のスナップショットにも CDP を入れない', async () => {
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const fy2026 = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const before = await collectOrgSnapshot(db, admin(), fy2026, periods);
    expect(before.disclosures.map((d) => d.framework)).toContain('CDP');

    withoutCdpOption();
    expect(await loadDisclosureWorkspace(db, manager(), 'cdp', fy2026, periods, [])).toBeNull();
    expect(
      await loadDisclosureWorkspace(db, manager(), 'csrd', fy2026, periods, []),
    ).not.toBeNull();
    const after = await collectOrgSnapshot(db, admin(), fy2026, periods);
    expect(after.disclosures.map((d) => d.framework)).not.toContain('CDP');
  });
});

describe('統合で足した止め所（適用判定・質問マッピング・取込の資料保存・パレットの検索）', () => {
  const periodsOf = () => fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
  const fy2026Of = () => periodsOf().find((p) => p.id === PERIOD_IDS.fy2026)!;

  it('適用判定は契約なしの CDP で結果を書かずに断る（CSRD は止めない）', async () => {
    withoutCdpOption();
    const responsesBefore = fixture.disclosureResponses.length;
    await expect(evaluateApplicability(db, manager(), 'cdp', fy2026Of())).rejects.toBeInstanceOf(
      FrameworkOptionNotContractedError,
    );
    expect(fixture.disclosureResponses.length).toBe(responsesBefore);
    await expect(evaluateApplicability(db, manager(), 'csrd', fy2026Of())).resolves.toBeDefined();
  });

  it('質問マッピングは契約の理由で止まり、AI を呼ばない（「見つかりません」にしない）', async () => {
    withoutCdpOption();
    const aiRunsBefore = fixture.aiRuns.length;
    await expect(
      runQuestionMapping(db, manager(), 'cdp', fy2026Of(), periodsOf()),
    ).rejects.toBeInstanceOf(FrameworkOptionNotContractedError);
    expect(fixture.aiRuns.length).toBe(aiRunsBefore);
  });

  it('過去回答の取込は、資料を保存する前に契約の理由で戻す', async () => {
    withoutCdpOption();
    const filesBefore = fixture.files.length;
    const data = form([['targetPeriodId', PERIOD_IDS.fy2025]]);
    data.append('file', new File(['C0.1,回答'], 'past.csv', { type: 'text/csv' }));
    const url = await redirectOf(() => enterpriseActions.previewDisclosureImportAction(data));
    expect(url.pathname).toBe('/enterprise/disclosures/cdp/import');
    expect(url.searchParams.get('error')).toBe('CDP 対応オプションは契約されていません。');
    expect(fixture.files.length).toBe(filesBefore);
  });

  it('パレットのデータ検索は、契約なしの組織に CDP の質問を出さない', async () => {
    const before = await searchPalette(db, manager(), 'Scope1 総排出量');
    expect(before.entries.some((e) => e.href.startsWith('/enterprise/disclosures/cdp/'))).toBe(
      true,
    );
    withoutCdpOption();
    const after = await searchPalette(db, manager(), 'Scope1 総排出量');
    expect(after.entries.some((e) => e.href.startsWith('/enterprise/disclosures/cdp/'))).toBe(
      false,
    );
  });
});

describe('顧客は契約を書けない', () => {
  it('アプリのコード（src）に organization_options を書く経路が無い（運営が Service Role で設定する）', () => {
    const writers = listFiles('src').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\b(insert|update|softDelete)\(\s*'organizationOptions'/.test(text);
    });
    expect(writers).toEqual([]);
  });
});
