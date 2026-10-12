import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { IDLE_FORM_STATE } from '@/lib/errors/form-action-state';
import type { AuthorizationContext, RoleKey, SharedReportCopy } from '@/types/domain';

/**
 * 保証側のコメント・企業の回答のフォーム（レビュー指摘 UX-08）。サーバーに断られたとき（共有の取り下げ・
 * コメントのクリアなど）は、書いた本文を残したまま理由を返す（?error= のリダイレクトで本文を消さない）。
 */

const state = vi.hoisted(() => ({
  enterprise: null as AuthorizationContext | null,
  assurance: null as AuthorizationContext | null,
  db: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.enterprise,
  requireAssuranceContext: async () => state.assurance,
}));
vi.mock('@/lib/repositories', () => ({ getDb: async () => state.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { createReportNoteAction } = await import('@/app/assurance/actions');
const { respondToAssuranceNoteAction } =
  await import('@/app/enterprise/assurance-comments/actions');
const { shareReportSnapshot, withdrawSharedReport } = await import('@/lib/services/report-share');
const { createReportNote } = await import('@/lib/services/assurance-notes');

const ENG = ENGAGEMENT_IDS.main;
let fixture: FixtureDb;
let db: DemoDbClient;
let copy: SharedReportCopy;

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

function firm(): AuthorizationContext {
  return {
    userId: userId('assurance-manager@demo.local'),
    email: 'assurance-manager@demo.local',
    displayName: 'assurance-manager@demo.local',
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'テスト法人',
      roleKeys: ['assurance_manager'],
      unitScopeIds: [],
    },
    engagementIds: [ENG],
    demo: true,
  };
}

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function metricTarget(): string {
  const content = parseSharedReportCopy(copy.copy)!;
  return `metric:${content.metricValues[0]!.dataPointVersionId}`;
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.enterprise = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
  state.assurance = firm();
  copy = await shareReportSnapshot(db, state.enterprise, {
    snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    engagementId: ENG,
  });
});

describe('保証側のコメントの起票（共有が取り下げられた後）', () => {
  it('書いた本文を残したまま理由を返す（リダイレクトしない）', async () => {
    await withdrawSharedReport(db, state.enterprise!, { copyId: copy.id });
    const body = '根拠資料の版を確認させてください（テスト）。';
    const result = await createReportNoteAction(
      IDLE_FORM_STATE,
      form([
        ['engagementId', ENG],
        ['copyId', copy.id],
        ['target', metricTarget()],
        ['body', body],
      ]),
    );
    expect(result.status).toBe('error');
    expect(result.message).toBeTruthy();
    expect(result.values).toContainEqual(['body', body]);
    expect(fixture.reviewNotes.some((n) => n.body === body)).toBe(false);
  });
});

describe('企業の回答（コメントがクリアされた後・権限なし）', () => {
  it('書いた回答を残したまま理由を返す', async () => {
    const note = await createReportNote(db, firm(), {
      engagementId: ENG,
      copyId: copy.id,
      target: {
        kind: 'report_metric',
        dataPointVersionId: parseSharedReportCopy(copy.copy)!.metricValues[0]!.dataPointVersionId,
      },
      body: '算定方法の説明をお願いします（テスト）。',
      sharedWithClient: true,
    });
    // 閲覧だけの役割は回答できない
    state.enterprise = enterprise('enterprise-admin@demo.local', ['viewer']);
    const reply = '算定方法は排出係数の版を固定して計算しています（テスト）。';
    const result = await respondToAssuranceNoteAction(
      IDLE_FORM_STATE,
      form([
        ['noteId', note.id],
        ['body', reply],
      ]),
    );
    expect(result.status).toBe('error');
    expect(result.values).toContainEqual(['body', reply]);
    expect(fixture.reviewNoteResponses.some((r) => r.body === reply)).toBe(false);
  });
});
