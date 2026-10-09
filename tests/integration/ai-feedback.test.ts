import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ValidationError } from '@/lib/errors/user-facing';
import { recordAiFeedback, rejectionReasonOf, REJECTION_REASON_FIELD } from '@/lib/ai/feedback';
import { fid } from '@/lib/fixtures/ids';
import type { AiRun, AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * AI の候補の不採用の理由（トライアル対応 NF-34・GT-25）。ai_feedback に 1 行追記する（本人名義・自組織だけ）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function enterprise(email: string, roleKeys: RoleKey[], organizationId: string = ORG_IDS.aomi) {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  } satisfies AuthorizationContext;
}

const author = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const viewer = () => enterprise('enterprise-admin@demo.local', ['viewer']);
const otherTenant = () =>
  enterprise('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

/** 自組織の AI 実行（Mock の候補）を 1 件置く */
function aomiRun(): AiRun {
  const run: AiRun = {
    id: fid('ai_run', 'ai-feedback-test'),
    organizationId: ORG_IDS.aomi,
    jobId: null,
    featureType: 'ssbjDisclosureDraft',
    provider: 'mock',
    model: 'mock',
    promptVersion: 'test',
    inputReferenceIds: [],
    outputJson: {},
    sourceReferences: [],
    confidence: 0.5,
    warnings: [],
    latencyMs: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    estimatedCostUsd: 0,
    status: 'succeeded',
    errorMessage: null,
    engagementId: null,
    reviewedBy: null,
    acceptedAt: null,
    rejectedAt: null,
    createdAt: new Date().toISOString(),
    createdBy: author().userId,
  };
  fixture.aiRuns.push(run);
  return run;
}

describe('recordAiFeedback', () => {
  it('不採用の理由を本人名義で 1 行追記する。理由が空なら行を作らない', async () => {
    const run = aomiRun();
    const before = fixture.aiFeedback.length;
    expect(
      await recordAiFeedback(db, author(), {
        aiRunId: run.id,
        decision: 'rejected',
        comment: '  ',
      }),
    ).toBeNull();
    expect(fixture.aiFeedback).toHaveLength(before);
    const row = await recordAiFeedback(db, author(), {
      aiRunId: run.id,
      decision: 'rejected',
      comment: '根拠の引用位置が違う（架空）',
    });
    expect(row?.userId).toBe(author().userId);
    expect(row?.organizationId).toBe(ORG_IDS.aomi);
    expect(fixture.aiFeedback).toHaveLength(before + 1);
  });

  it('他組織の AI 実行は見つからない。生成の権限が無い役割は記録できない。Demo は 300 字まで', async () => {
    const run = aomiRun();
    await expect(
      recordAiFeedback(db, otherTenant(), {
        aiRunId: run.id,
        decision: 'rejected',
        comment: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordAiFeedback(db, viewer(), { aiRunId: run.id, decision: 'rejected', comment: 'x' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      recordAiFeedback(db, author(), {
        aiRunId: run.id,
        decision: 'rejected',
        comment: 'あ'.repeat(301),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('フォームの理由欄（rejectionReason）を読む', () => {
    const form = new FormData();
    expect(rejectionReasonOf(form)).toBeNull();
    form.set(REJECTION_REASON_FIELD, '  採用しない  ');
    expect(rejectionReasonOf(form)).toBe('採用しない');
  });
});
