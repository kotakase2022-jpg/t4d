import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { ORG_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import { readDemoEdits } from '@/lib/repositories/demo-persistence';
import { IDLE_FORM_STATE, type FormActionState } from '@/lib/errors/form-action-state';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 設定「承認ルート」タブの保存（トライアル対応 NF-24・plan int:approval-route-settings）。
 *
 *  - 画面の Server Action から 3 段階の経路を既定として保存すると、次の提出が 3 段階で始まる
 *  - 進行中のデータの経路は変わらない（写しを持つ）
 *  - 組織の管理（enterprise.org.manage）が無い人は保存できない（入力を残したまま理由を返す）
 *  - 新しい経路は、同じ名前の経路を黙って上書きしない（ひな形を 2 回使っても既存の経路を消さない）
 *  - ひな形は既定に入れない。同じ段階のまま保存し直しても段階の行を増やさない
 *  - Demo Mode: 保存した経路は Cookie で持ち回り、別のインスタンスでも同じ経路で提出が始まる
 */

const jar = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({
  ctx: null as AuthorizationContext | null,
  db: null as unknown,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.ctx,
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const settingsActions = await import('@/app/enterprise/settings/actions');
const { loadApprovalProgress, loadDefaultRoute } = await import('@/lib/services/approval-route');
const { transitionDataPoint } = await import('@/lib/services/data-point-workflow');

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

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => enterprise('sustainability@demo.local', ['sustainability_manager']);

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

/** 画面と同じ呼び方（前の状態・送った値）で保存の Action を呼ぶ */
function save(data: FormData): Promise<FormActionState> {
  return settingsActions.saveApprovalRouteAction(IDLE_FORM_STATE, data);
}

/** 断られたときの状態（リダイレクトせず、理由と送った値を返す） */
async function failureOf(data: FormData): Promise<FormActionState> {
  const result = await save(data);
  expect(result.status).toBe('error');
  return result;
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

/** 画面の「3 段階のひな形を入れる」と同じ段階で、「既定の経路にする」を人が選んだ値 */
function threeStageForm(extra: Array<[string, string]> = []): FormData {
  return form([
    ['name', '3 段階の承認（標準）'],
    ['purpose', 'default'],
    ['isDefault', 'on'],
    ['description', ''],
    ['stageName1', '拠点・部署の確認'],
    ['stageRole1', 'reviewer'],
    ['stageDepartment1', ''],
    ['stageName2', '本社サステナビリティ担当の確認'],
    ['stageRole2', 'sustainability_manager'],
    ['stageDepartment2', ''],
    ['stageName3', '最終承認'],
    ['stageRole3', 'approver'],
    ['stageDepartment3', ''],
    // 空の段階名の行は使わない
    ['stageName4', ''],
    ['stageRole4', ''],
    ['stageDepartment4', ''],
    ['stageName5', ''],
    ['stageRole5', ''],
    ['stageDepartment5', ''],
    ...extra,
  ]);
}

/** 下書きのデータ（提出すると既定の経路で始まる）。差し戻し済みの WEST 水使用量は進行中なので使わない */
function draftDataPoint() {
  const dp = fixture.dataPoints.find(
    (d) => d.organizationId === ORG_IDS.aomi && d.status === 'draft' && !d.deletedAt,
  );
  if (!dp) throw new Error('Fixture に下書きのデータが無い');
  return dp;
}

beforeEach(() => {
  jar.clear();
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
});

describe('承認ルートの保存（設定の画面の Action）', () => {
  it('3 段階を既定として保存すると、次の提出が 3 段階で始まる', async () => {
    state.ctx = admin();
    const url = await redirectOf(() => save(threeStageForm()));
    expect(url.pathname).toBe('/enterprise/settings');
    expect(url.searchParams.get('tab')).toBe('approval');
    expect(url.searchParams.get('flash')).toBe('approvalRouteSaved');
    expect(url.searchParams.get('stages')).toBe('3');

    const route = await loadDefaultRoute(db, admin());
    expect(route?.route.name).toBe('3 段階の承認（標準）');
    expect(route?.stages.map((s) => s.name)).toEqual([
      '拠点・部署の確認',
      '本社サステナビリティ担当の確認',
      '最終承認',
    ]);
    // 既定はひとつだけ
    expect(
      fixture.approvalRoutes.filter((r) => r.organizationId === ORG_IDS.aomi && r.isDefault),
    ).toHaveLength(1);

    const target = draftDataPoint();
    await transitionDataPoint(db, manager(), { dataPointId: target.id, to: 'submitted' });
    const progress = await loadApprovalProgress(db, manager(), target.id);
    expect(progress.totalCount).toBe(3);
    expect(progress.currentStep?.stageName).toBe('拠点・部署の確認');
  });

  it('進行中のデータの経路は変わらない（写しを持つ）', async () => {
    const inFlight = dataPointId('EAST', 'water', 'FY2026');
    const before = await loadApprovalProgress(db, admin(), inFlight);
    state.ctx = admin();
    await redirectOf(() => save(threeStageForm()));
    const after = await loadApprovalProgress(db, admin(), inFlight);
    expect(after.totalCount).toBe(before.totalCount);
  });

  it('既にある経路を編集すると同じ経路の段階が入れ替わる（古い段階は論理削除で残る）', async () => {
    state.ctx = admin();
    const current = (await loadDefaultRoute(db, admin()))!;
    const stagesBefore = fixture.approvalRouteStages.filter((s) => s.routeId === current.route.id);
    await redirectOf(() =>
      save(
        form([
          ['routeId', current.route.id],
          ['name', current.route.name],
          ['purpose', 'default'],
          ['isDefault', 'on'],
          ['stageName1', '担当役員の承認'],
          ['stageRole1', 'approver'],
        ]),
      ),
    );
    const edited = (await loadDefaultRoute(db, admin()))!;
    expect(edited.route.id).toBe(current.route.id);
    expect(edited.stages.map((s) => s.name)).toEqual(['担当役員の承認']);
    const all = fixture.approvalRouteStages.filter((s) => s.routeId === current.route.id);
    expect(all.length).toBe(stagesBefore.length + 1);
    expect(all.filter((s) => s.deletedAt).length).toBe(stagesBefore.length);
  });

  it('組織の管理の権限が無い人は保存できず、入力（ひな形の名称・段階）を残したまま理由を返す', async () => {
    state.ctx = manager();
    const before = fixture.approvalRoutes.length;
    const failure = await failureOf(threeStageForm());
    expect(failure.message).toBeTruthy();
    expect(failure.values).toContainEqual(['name', '3 段階の承認（標準）']);
    expect(failure.values).toContainEqual(['stageName2', '本社サステナビリティ担当の確認']);
    expect(fixture.approvalRoutes.length).toBe(before);
  });

  it('新しい経路は、同じ名前の経路を上書きしない（ひな形を 2 回使っても・既定の経路の名前でも）', async () => {
    state.ctx = admin();
    const current = (await loadDefaultRoute(db, admin()))!;
    const stagesBefore = current.stages.map((s) => s.name);
    // 既定の経路と同じ名前で「新しく」作る
    const sameAsDefault = await failureOf(
      form([
        ['name', current.route.name],
        ['purpose', 'default'],
        ['stageName1', '別の段階'],
        ['stageRole1', 'approver'],
      ]),
    );
    expect(sameAsDefault.message).toContain('同じ名前の承認ルート');
    const after = (await loadDefaultRoute(db, admin()))!;
    expect(after.route.id).toBe(current.route.id);
    expect(after.stages.map((s) => s.name)).toEqual(stagesBefore);

    // ひな形を 2 回使う（2 回目は断る。1 回目の経路は残る）
    await redirectOf(() => save(threeStageForm()));
    const routes = () =>
      fixture.approvalRoutes.filter(
        (r) => r.organizationId === ORG_IDS.aomi && r.name === '3 段階の承認（標準）',
      );
    expect(routes()).toHaveLength(1);
    const second = await failureOf(threeStageForm());
    expect(second.message).toContain('同じ名前の承認ルート');
    expect(routes()).toHaveLength(1);
  });

  it('同じ段階のまま保存し直しても段階の行を増やさない（変わった段階だけを作り直す）', async () => {
    state.ctx = admin();
    await redirectOf(() => save(threeStageForm()));
    const route = fixture.approvalRoutes.find(
      (r) => r.organizationId === ORG_IDS.aomi && r.name === '3 段階の承認（標準）',
    )!;
    const stagesOf = () => fixture.approvalRouteStages.filter((s) => s.routeId === route.id);
    expect(stagesOf()).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      await redirectOf(() => save(threeStageForm([['routeId', route.id]])));
    }
    expect(stagesOf()).toHaveLength(3);
    // 2 段目だけを変えると、2 段目だけが論理削除されて新しい行になる
    const changed = threeStageForm([['routeId', route.id]]);
    changed.set('stageName2', '本社の確認（名称を変更）');
    await redirectOf(() => save(changed));
    expect(stagesOf()).toHaveLength(4);
    expect(stagesOf().filter((s) => s.deletedAt)).toHaveLength(1);
    const live = stagesOf()
      .filter((s) => !s.deletedAt)
      .sort((a, b) => a.stageNo - b.stageNo)
      .map((s) => s.name);
    expect(live).toEqual(['拠点・部署の確認', '本社の確認（名称を変更）', '最終承認']);
  });

  it('入力の誤り（承認できる役割に企業の役割でない値・長すぎる名称）は保存しない', async () => {
    state.ctx = admin();
    const badRole = await failureOf(
      form([
        ['name', '誤った経路'],
        ['stageName1', '承認'],
        ['stageRole1', 'assurance_manager'],
      ]),
    );
    expect(badRole.message).toContain('承認できる役割');
    const longName = await failureOf(
      form([
        ['name', 'あ'.repeat(61)],
        ['stageName1', '承認'],
      ]),
    );
    expect(longName.message).toContain('60 文字');
    expect(fixture.approvalRoutes.some((r) => r.name === '誤った経路')).toBe(false);
  });

  it('Demo Mode: 保存した経路は Cookie で持ち回り、別のインスタンスでも 3 段階で提出が始まる', async () => {
    state.ctx = admin();
    await redirectOf(() => save(threeStageForm()));

    // 別のインスタンス（新しい Fixture）に、このブラウザの Cookie だけが届く
    const other = createFixtureDb();
    applyDemoEdits(other, await readDemoEdits());
    const otherDb = new DemoDbClient(other);
    const route = await loadDefaultRoute(otherDb, admin());
    expect(route?.route.name).toBe('3 段階の承認（標準）');
    expect(route?.stages).toHaveLength(3);

    const target = other.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.status === 'draft' && !d.deletedAt,
    )!;
    await transitionDataPoint(otherDb, manager(), { dataPointId: target.id, to: 'submitted' });
    expect((await loadApprovalProgress(otherDb, manager(), target.id)).totalCount).toBe(3);
  });
});
