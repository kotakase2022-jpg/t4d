import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { trialScenarioId } from '@/lib/fixtures/trial-case';
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
  feedbackRouteOf,
  listFeedback,
  recordReverification,
  submitFeedback,
  summarizeOpenIssues,
  triageFeedback,
} from '@/lib/services/trial-feedback';
import type {
  AuthorizationContext,
  OrganizationType,
  RoleKey,
  TrialFeedbackItem,
  Uuid,
} from '@/types/domain';

/**
 * フィードバックと改善管理表（NF-34）。
 *  - 全役割（組織の有効なメンバー）が投稿でき、画面はルートのパターンだけを記録する
 *  - トリアージ・再検証・定例会の論点は enterprise.org.manage だけ。投稿の内容は書き換えない
 *  - 見出しの「必須要件 × 重大 × 未解決」と、AI に関する意見（不採用の理由）の件数を集計する
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
const ENTERPRISE_USERS: Array<[string, () => AuthorizationContext]> = [
  ['企業管理者', admin],
  ['作成担当', () => ctxFor('sustainability@demo.local', ['sustainability_manager'])],
  ['拠点担当', () => ctxFor('site-user@demo.local', ['site_contributor'])],
  ['レビュー担当', () => ctxFor('reviewer@demo.local', ['reviewer'])],
  ['最終承認者', () => ctxFor('approver@demo.local', ['approver', 'reviewer'])],
];
const author = ENTERPRISE_USERS[1]![1];
const firm = () =>
  ctxFor('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba, 'assurance_firm');
const otherAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

function replayRow(table: string, row: object, existing?: FixtureDb): FixtureDb {
  const v = compactRow(table, row as Record<string, unknown>, fixture);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  const edit: DemoEdit = { t: table, id: (row as { id: string }).id, v };
  const target = existing ?? createFixtureDb();
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream([edit])));
  return target;
}

describe('submitFeedback（全役割）', () => {
  it.each(ENTERPRISE_USERS)(
    '%s が投稿でき、本人名義・未着手・環境の版つきで改善管理表に出る',
    async (_label, ctx) => {
      const item = await submitFeedback(db, ctx(), {
        kind: 'defect',
        title: '（架空）保存ボタンが見つけにくい',
        body: '（架空）画面の下までスクロールしないと見えない。',
        severity: 'minor',
        route: `/enterprise/disclosure-projects/${trialScenarioId('TS-01')}?tab=requirements&q=秘密`,
      });
      expect(item.createdBy).toBe(ctx().userId);
      expect(item.status).toBe('open');
      expect(item.channel).toBe('in_app');
      expect(item.environmentVersion).not.toBe('');
      // ルートのパターンだけ（ID・検索条件は記録しない）
      expect(item.routePattern).toBe('/enterprise/disclosure-projects/[id]');
      expect((await listFeedback(db, ctx())).some((row) => row.id === item.id)).toBe(true);
      const restored = replayRow('trialFeedbackItems', item).trialFeedbackItems.find(
        (row) => row.id === item.id,
      );
      expect(restored?.title).toBe(item.title);
    },
  );

  it('重大度は不具合のときだけ。件名は必須・Demo は 60 字まで。関連シナリオは自組織のもの', async () => {
    const request = await submitFeedback(db, author(), {
      kind: 'request',
      title: '（架空）一括で担当を変えたい',
      body: '',
      severity: 'critical',
      scenarioId: trialScenarioId('TS-05'),
    });
    expect(request.severity).toBeNull();
    expect(request.scenarioId).toBe(trialScenarioId('TS-05'));
    await expect(
      submitFeedback(db, author(), { kind: 'request', title: ' ', body: '' }),
    ).rejects.toThrow('件名を入力してください。');
    await expect(
      submitFeedback(db, author(), { kind: 'request', title: 'あ'.repeat(61), body: '' }),
    ).rejects.toThrow('60 字以内');
    await expect(
      submitFeedback(db, author(), { kind: 'praise', title: 'x', body: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      submitFeedback(db, otherAdmin(), {
        kind: 'request',
        title: 'x',
        body: '',
        scenarioId: trialScenarioId('TS-01'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('定例会などの経路・必須要件の印は管理者だけ。監査法人は投稿できない', async () => {
    await expect(
      submitFeedback(db, author(), {
        kind: 'request',
        title: '定例会の論点',
        body: '',
        channel: 'meeting',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const meeting = await submitFeedback(db, admin(), {
      kind: 'defect',
      title: '（架空）定例会: 共有レポートの版が分かりにくい',
      body: '（架空）次回までに表示を見直す。',
      severity: 'critical',
      channel: 'meeting',
      mandatoryRequirement: true,
    });
    expect(meeting).toMatchObject({ channel: 'meeting', mandatoryRequirement: true });
    await expect(
      submitFeedback(db, firm(), { kind: 'request', title: 'x', body: '' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('画面のパターン: アプリ外の値は記録しない', () => {
    expect(feedbackRouteOf('https://example.com/enterprise/data?q=1')).toBe('/enterprise/data');
    expect(feedbackRouteOf('not-a-path')).toBe('');
    expect(feedbackRouteOf(null)).toBe('');
  });
});

describe('トリアージと再検証（enterprise.org.manage）', () => {
  function fixtureItem(key: string): TrialFeedbackItem {
    return fixture.trialFeedbackItems.find((item) => item.title.includes(key))!;
  }

  it('管理者以外は更新できない。管理者は改善の列だけを変え、監査ログ data_updated を残す', async () => {
    const item = fixtureItem('対応表の出力で列名');
    const input = {
      itemId: item.id,
      status: 'in_progress',
      costClass: 'maintenance',
      responsePolicy: '（架空）列名に補足を付ける。',
      ownerLabel: '開発担当（架空）',
      dueOn: '2026-11-30',
      mandatoryRequirement: false,
      resolvedInVersion: '',
      agreed: true,
    };
    await expect(triageFeedback(db, author(), input)).rejects.toBeInstanceOf(AuthorizationError);
    const updated = await triageFeedback(db, admin(), input);
    expect(updated).toMatchObject({
      status: 'in_progress',
      agreed: true,
      dueOn: '2026-11-30',
      title: item.title,
      createdBy: item.createdBy,
    });
    expect(
      fixture.auditEvents.some(
        (e) =>
          e.eventType === 'data_updated' &&
          e.resourceType === 'trial_feedback' &&
          e.resourceId === item.id,
      ),
    ).toBe(true);
    // Cookie から戻すとき、改善の列の変更は受け付ける
    const restored = replayRow('trialFeedbackItems', updated).trialFeedbackItems.find(
      (row) => row.id === item.id,
    )!;
    expect(restored.status).toBe('in_progress');
  });

  it('再検証済みは、再検証の結果（解消を確認）を記録してから', async () => {
    const item = fixtureItem('対応表の出力で列名');
    await expect(
      triageFeedback(db, admin(), {
        itemId: item.id,
        status: 'verified',
        costClass: 'maintenance',
        responsePolicy: '',
        ownerLabel: '',
        dueOn: null,
        mandatoryRequirement: false,
        resolvedInVersion: '',
        agreed: false,
      }),
    ).rejects.toThrow('再検証の結果');
    const failed = await recordReverification(db, admin(), { itemId: item.id, result: 'fail' });
    expect(failed).toMatchObject({ status: 'in_progress', verificationResult: 'fail' });
    const passed = await recordReverification(db, admin(), {
      itemId: item.id,
      result: 'pass',
      version: 'abc1234',
    });
    expect(passed).toMatchObject({
      status: 'verified',
      verificationResult: 'pass',
      resolvedInVersion: 'abc1234',
      verifiedBy: userId('enterprise-admin@demo.local'),
    });
    await expect(
      recordReverification(db, author(), { itemId: item.id, result: 'pass' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('他組織の項目は見つからない', async () => {
    const item = fixtureItem('対応表の出力で列名');
    await expect(
      recordReverification(db, otherAdmin(), { itemId: item.id, result: 'pass' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('別途協議の区分（2026-10-16 の要望 ④。0060 の scope_kind）', () => {
  function triageInput(itemId: string, costClass: string, scopeKind?: string | null) {
    return {
      itemId,
      status: 'triaged',
      costClass,
      responsePolicy: '',
      ownerLabel: '',
      dueOn: null,
      mandatoryRequirement: false,
      resolvedInVersion: '',
      agreed: false,
      scopeKind,
    };
  }

  it('費用区分が別途協議なら区分を記録する。監査ログに区分を書く。Cookie から戻せる', async () => {
    const item = fixture.trialFeedbackItems.find(
      (f) => f.organizationId === ORG_IDS.aomi && f.costClass !== 'separate_estimate',
    )!;
    const updated = await triageFeedback(
      db,
      admin(),
      triageInput(item.id, 'separate_estimate', 'system_integration'),
    );
    expect(updated).toMatchObject({
      costClass: 'separate_estimate',
      scopeKind: 'system_integration',
    });
    const event = fixture.auditEvents.filter((e) => e.resourceId === item.id).at(-1)!;
    expect(event.afterSummary).toContain('別途協議（外部システムとの個別連携）');
    const restored = replayRow('trialFeedbackItems', updated).trialFeedbackItems.find(
      (row) => row.id === item.id,
    )!;
    expect(restored.scopeKind).toBe('system_integration');
    const summary = (await summarizeOpenIssues(db, admin())).summary;
    expect(summary.separateByScopeKind.system_integration).toBe(1);
  });

  it('費用区分が別途協議なのに区分が空なら断る。知らない区分も断る', async () => {
    const item = fixture.trialFeedbackItems.find((f) => f.organizationId === ORG_IDS.aomi)!;
    await expect(
      triageFeedback(db, admin(), triageInput(item.id, 'separate_estimate', '')),
    ).rejects.toThrow('別途協議の区分（拠点の追加');
    await expect(
      triageFeedback(db, admin(), triageInput(item.id, 'separate_estimate', 'other_kind')),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('別途協議以外で区分を入れると断る（0060 の CHECK と同じ）。費用区分を変えると区分を外す', async () => {
    const separate = fixture.trialFeedbackItems.find(
      (f) => f.organizationId === ORG_IDS.aomi && f.scopeKind === 'custom_development',
    )!;
    await expect(
      triageFeedback(db, admin(), triageInput(separate.id, 'maintenance', 'custom_development')),
    ).rejects.toThrow('費用区分が「別途協議」のときだけ選べます');
    const cleared = await triageFeedback(db, admin(), triageInput(separate.id, 'maintenance', ''));
    expect(cleared).toMatchObject({ costClass: 'maintenance', scopeKind: null });
  });

  it('区分を渡さない（以前の呼び方）なら、別途協議のままの項目の区分を保つ', async () => {
    const separate = fixture.trialFeedbackItems.find(
      (f) => f.organizationId === ORG_IDS.aomi && f.scopeKind === 'custom_development',
    )!;
    const kept = await triageFeedback(db, admin(), triageInput(separate.id, 'separate_estimate'));
    expect(kept.scopeKind).toBe('custom_development');
  });

  it('組織の管理の権限が無い人は区分を変えられない', async () => {
    const item = fixture.trialFeedbackItems.find((f) => f.organizationId === ORG_IDS.aomi)!;
    await expect(
      triageFeedback(db, author(), triageInput(item.id, 'separate_estimate', 'site_expansion')),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('summarizeOpenIssues', () => {
  it('Fixture: 必須要件 × 重大 × 未解決 1 件。解消を確認すると 0 件になる', async () => {
    const before = await summarizeOpenIssues(db, author());
    expect(before.summary.mandatoryCriticalOpen).toBe(1);
    expect(before.summary.total).toBe(5);
    expect(before.summary.positive).toBe(1);
    const critical = before.items.find((i) => i.mandatoryRequirement && i.severity === 'critical')!;
    await recordReverification(db, admin(), { itemId: critical.id, result: 'pass' });
    const after = await summarizeOpenIssues(db, author());
    expect(after.summary.mandatoryCriticalOpen).toBe(0);
  });

  it('AI に関する意見は、不採用の理由が書かれた行だけを数える', async () => {
    // 集計は ai_feedback の行だけを読む（AI の実行の行は見ない）
    const run = { id: 'ai-run-for-feedback' };
    fixture.aiFeedback.push(
      {
        id: 'ai-fb-1',
        aiRunId: run.id,
        organizationId: ORG_IDS.aomi,
        userId: userId('sustainability@demo.local'),
        decision: 'rejected',
        comment: '（架空）根拠の資料が当年度ではない',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'ai-fb-2',
        aiRunId: run.id,
        organizationId: ORG_IDS.aomi,
        userId: userId('sustainability@demo.local'),
        decision: 'rejected',
        comment: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'ai-fb-3',
        aiRunId: run.id,
        organizationId: ORG_IDS.soten,
        userId: userId('other-enterprise-admin@demo.local'),
        decision: 'rejected',
        comment: '他組織の意見',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    );
    const overview = await summarizeOpenIssues(db, author());
    expect(overview.aiOpinions.map((o) => o.comment)).toEqual([
      '（架空）根拠の資料が当年度ではない',
    ]);
  });
});
