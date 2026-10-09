import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
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
import { saveTrialProgram } from '@/lib/services/trial-program';
import { recordTaskTiming, summarizeTimings, type TimingInput } from '@/lib/services/trial-timing';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 作業時間（現行 vs T4D。NF-35）。両方 n ≥ 3 のときだけ短縮率を出し、目標は結果と別に返す。
 * 記録は本人名義（追記専用・訂正は自分の記録だけ）。
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
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const firm = () =>
  ctxFor('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba, 'assurance_firm');

const base: TimingInput = {
  taskKey: 'check_reconcile',
  mode: 't4d',
  method: 'observed',
  minutes: 45,
  quantity: 1,
  unitLabel: '表',
  department: 'サステナビリティ推進部',
  measuredOn: '2026-10-08',
  note: '（架空）',
};

function replayRow(table: string, row: object): FixtureDb {
  const v = compactRow(table, row as Record<string, unknown>, fixture);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  const edit: DemoEdit = { t: table, id: (row as { id: string }).id, v };
  const target = createFixtureDb();
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream([edit])));
  return target;
}

describe('summarizeTimings', () => {
  it('Fixture: 転記は両方 3 件で短縮率を出し、確認・突合は T4D が 1 件で件数不足', async () => {
    const summary = await summarizeTimings(db, reviewer());
    const transcription = summary.tasks.find((t) => t.taskKey === 'transcription')!;
    expect(transcription.baseline).toMatchObject({ median: 120, n: 3, methods: ['self_report'] });
    expect(transcription.t4d).toMatchObject({ median: 85, n: 3, methods: ['observed'] });
    expect(transcription.rate).toBeCloseTo(35 / 120);
    expect(transcription.label).toBe('29.2% 短縮');
    const check = summary.tasks.find((t) => t.taskKey === 'check_reconcile')!;
    expect(check.rate).toBeNull();
    expect(check.label).toBe('件数不足（現行 n=2・T4D n=1）');
    expect(summary.tasks).toHaveLength(6);
    expect(summary.records).toHaveLength(9);
    // 目標は計画で設定するまで無い（製品に目標値を埋め込まない）
    expect(summary.target).toBeNull();
  });

  it('目標は計画の値を別に返す（結果と混ぜない）', async () => {
    await saveTrialProgram(db, admin(), { reductionTarget: { minPercent: 15, maxPercent: 25 } });
    const summary = await summarizeTimings(db, reviewer());
    expect(summary.target).toEqual({ minPercent: 15, maxPercent: 25 });
    expect(summary.tasks.find((t) => t.taskKey === 'transcription')!.label).toBe('29.2% 短縮');
  });

  it('監査法人のワークスペースからは読めない', async () => {
    await expect(summarizeTimings(db, firm())).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('recordTaskTiming（本人名義・追記専用）', () => {
  it('記録すると集計に入り、件数がそろうと短縮率を出す。Cookie から戻せる', async () => {
    const first = await recordTaskTiming(db, reviewer(), base);
    expect(first.recordedBy).toBe(userId('reviewer@demo.local'));
    await recordTaskTiming(db, reviewer(), { ...base, minutes: 40 });
    const summary = await summarizeTimings(db, reviewer());
    const check = summary.tasks.find((t) => t.taskKey === 'check_reconcile')!;
    expect(check.t4d.n).toBe(3);
    // 現行は 2 件のまま → まだ出さない
    expect(check.rate).toBeNull();
    await recordTaskTiming(db, author(), { ...base, mode: 'baseline', minutes: 65 });
    const after = (await summarizeTimings(db, reviewer())).tasks.find(
      (t) => t.taskKey === 'check_reconcile',
    )!;
    expect(after.baseline).toMatchObject({ n: 3, median: 65 });
    expect(after.t4d.median).toBe(40);
    expect(after.rate).toBeCloseTo(25 / 65);
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'data_created' && e.resourceType === 'trial_task_timing',
      ),
    ).toBe(true);
    const restored = replayRow('trialTaskTimings', first).trialTaskTimings.find(
      (r) => r.id === first.id,
    );
    expect(restored?.minutes).toBe(45);
  });

  it('訂正は自分の記録だけ。訂正された記録は数えない', async () => {
    const wrong = await recordTaskTiming(db, author(), { ...base, minutes: 999 });
    const fixed = await recordTaskTiming(db, author(), {
      ...base,
      minutes: 42,
      supersedesId: wrong.id,
    });
    const summary = await summarizeTimings(db, author());
    expect(summary.records.find((r) => r.id === wrong.id)?.superseded).toBe(true);
    expect(summary.records.find((r) => r.id === fixed.id)?.superseded).toBe(false);
    const check = summary.tasks.find((t) => t.taskKey === 'check_reconcile')!;
    expect(check.t4d.n).toBe(2);
    await expect(
      recordTaskTiming(db, reviewer(), { ...base, supersedesId: fixed.id }),
    ).rejects.toThrow('訂正できるのは自分の記録だけです。');
  });

  it('入力の誤り: 作業・区分・測り方・所要時間・数量・測定日・メモの長さ', async () => {
    await expect(
      recordTaskTiming(db, author(), { ...base, taskKey: 'coffee' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordTaskTiming(db, author(), { ...base, mode: 'manual' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordTaskTiming(db, author(), { ...base, method: 'guess' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(recordTaskTiming(db, author(), { ...base, minutes: -1 })).rejects.toThrow(
      '所要時間',
    );
    await expect(recordTaskTiming(db, author(), { ...base, minutes: null })).rejects.toThrow(
      '所要時間',
    );
    await expect(recordTaskTiming(db, author(), { ...base, quantity: 0 })).rejects.toThrow('数量');
    await expect(recordTaskTiming(db, author(), { ...base, measuredOn: '' })).rejects.toThrow(
      '測定日を入力してください。',
    );
    await expect(
      recordTaskTiming(db, author(), { ...base, note: 'あ'.repeat(301) }),
    ).rejects.toThrow('300 字以内');
  });

  it('他組織の記録の訂正・監査法人からの記録はできない', async () => {
    const own = await recordTaskTiming(db, author(), base);
    const otherAdmin = ctxFor(
      'other-enterprise-admin@demo.local',
      ['enterprise_admin'],
      ORG_IDS.soten,
    );
    await expect(
      recordTaskTiming(db, otherAdmin, { ...base, supersedesId: own.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordTaskTiming(db, firm(), base)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
