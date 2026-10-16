import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { toCsv, toXlsx } from '@/lib/exports';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { buildGhgDemoFile } from '@/lib/fixtures/ghg-demo-files';
import { GHG_FIXTURE_IDS, GHG_VERIFICATION_UNIT_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { runCalculation } from '@/lib/services/ghg/calculation';
import {
  activateFactorSet,
  confirmFactorSetImport,
  listFactorSets,
  loadFactorSet,
  previewFactorSetImport,
  retireFactorSet,
  type FactorSetMetaInput,
} from '@/lib/services/ghg/factor-sets';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 係数のセットの取込・有効化・取り下げ（plan §2.3 factor-sets.ts・CR-01・int:ghg-factor-sets）。
 *  - 取込はプレビュー → 確定。確定は同じファイル・同じ列の対応だけ（指紋が違えば書かない）
 *  - 取り込んだセットは下書き。有効にすると係数は変えられない（Demo の Cookie から戻すときも同じ規則）
 *  - 取り下げたセットの係数は算定に使わない（割当は残り、算定は「セットが有効ではありません」で止まる）
 *  - 書けるのは enterprise.metric.manage。他社のセットは見えない
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
  unitScopeIds: Uuid[] = [],
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
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const site = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

function sampleCsv(): { fileName: string; bytes: Uint8Array } {
  const file = buildGhgDemoFile('factor-set', createFixtureDb());
  return { fileName: 'factors.csv', bytes: new TextEncoder().encode(toCsv(file.sheet)) };
}

const META: FactorSetMetaInput = {
  code: 'ORG-2025R',
  name: '組織指定（架空）2025 年版 改訂',
  origin: 'customer_specified',
  sourceLabel: '（架空）組織指定 2025 年版 改訂',
  versionLabel: '2025 年版 改訂',
  publishedOn: '2025-06-30',
  referenceYear: '2025',
  notes: '',
};

async function previewSample(ctx = manager()) {
  const file = sampleCsv();
  return previewFactorSetImport(db, ctx, {
    ...file,
    mapping: null,
    decimalSeparator: 'dot',
    referenceYear: 2025,
    sourceLabel: META.sourceLabel,
  });
}

async function importSample(meta: Partial<FactorSetMetaInput> = {}) {
  const preview = await previewSample();
  return confirmFactorSetImport(db, manager(), {
    ...sampleCsv(),
    mapping: preview.mapping,
    decimalSeparator: 'dot',
    referenceYear: 2025,
    sourceLabel: META.sourceLabel,
    meta: { ...META, ...meta },
    previewToken: preview.previewToken,
  });
}

function replay(edits: Array<{ table: string; row: object }>): FixtureDb {
  const target = createFixtureDb();
  const encoded: DemoEdit[] = edits.map(({ table, row }) => {
    const v = compactRow(table, row as Record<string, unknown>, fixture);
    if (!v) throw new Error(`${table} は Cookie に載らない形です`);
    return { t: table, id: (row as { id: string }).id, v };
  });
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream(encoded)));
  return target;
}

describe('listFactorSets・loadFactorSet', () => {
  it('Fixture の 2 つのセット（架空・有効）と係数の数・期間の割当の数', async () => {
    const sets = await listFactorSets(db, reviewer(), { periodId: GHG_FIXTURE_IDS.period });
    expect(sets.map((s) => [s.set.code, s.set.status, s.set.origin])).toEqual([
      ['ORG-2024', 'active', 'fixture'],
      ['ORG-2025', 'active', 'fixture'],
    ]);
    const org2025 = sets.find((s) => s.set.code === 'ORG-2025')!;
    expect(org2025.factorCount).toBe(12);
    expect(org2025.kindCounts).toMatchObject({
      electricity: 7,
      fuel: 2,
      gas: 1,
      transport_formula: 1,
      transport_default: 1,
    });
    expect(org2025.assignmentCount).toBe(
      fixture.emissionFactorAssignments.filter(
        (a) => a.reportingPeriodId === GHG_FIXTURE_IDS.period,
      ).length,
    );
    expect(sets.find((s) => s.set.code === 'ORG-2024')!.assignmentCount).toBe(0);
    const detail = await loadFactorSet(db, reviewer(), GHG_FIXTURE_IDS.sets.org2025);
    expect(detail.factors).toHaveLength(12);
    expect(detail.names.get(userId('sustainability@demo.local'))).toBe('海野 みどり');
  });

  it('他社のセットは見つからない', async () => {
    await expect(loadFactorSet(db, other(), GHG_FIXTURE_IDS.sets.org2025)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await listFactorSets(db, other())).toEqual([]);
  });
});

describe('取込（プレビュー → 確定）', () => {
  it('初回は見出しから列の対応の候補を作り、8 行を検証する（書き込みなし）', async () => {
    const before = fixture.emissionFactors.length;
    const preview = await previewSample();
    expect(preview.mappingSuggested).toBe(true);
    expect(preview.mapping.code).toBe('係数コード');
    expect(preview.result.errors).toEqual([]);
    expect(preview.result.factors).toHaveLength(8);
    expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.emissionFactors).toHaveLength(before);
  });

  it('Excel のサンプルも同じ列で読める', async () => {
    const file = buildGhgDemoFile('factor-set', createFixtureDb());
    const bytes = await toXlsx([file.sheet], 'factors');
    const preview = await previewFactorSetImport(db, manager(), {
      fileName: 'factors.xlsx',
      bytes,
      mapping: null,
      decimalSeparator: 'dot',
      referenceYear: null,
      sourceLabel: '（架空）',
    });
    expect(preview.result.errors).toEqual([]);
    expect(preview.result.factors).toHaveLength(8);
  });

  it('確定すると下書きのセットと係数を書く（監査ログは settings_changed）', async () => {
    const { set, factors } = await importSample();
    expect(set).toMatchObject({
      code: 'ORG-2025R',
      origin: 'customer_specified',
      status: 'draft',
      activatedAt: null,
      referenceYear: 2025,
      publishedOn: '2025-06-30',
      createdBy: userId('sustainability@demo.local'),
    });
    expect(factors).toHaveLength(8);
    expect(fixture.emissionFactors.filter((f) => f.factorSetId === set.id)).toHaveLength(8);
    expect(factors.every((f) => f.organizationId === ORG_IDS.aomi)).toBe(true);
    const audit = fixture.auditEvents.find((e) => e.resourceId === set.id)!;
    expect(audit).toMatchObject({
      eventType: 'settings_changed',
      resourceType: 'emission_factor_set',
    });
  });

  it('検証した内容と違う（列の対応・ファイル）ときは確定しない', async () => {
    const preview = await previewSample();
    const before = fixture.emissionFactorSets.length;
    await expect(
      confirmFactorSetImport(db, manager(), {
        ...sampleCsv(),
        mapping: { ...preview.mapping, name: '出典' },
        decimalSeparator: 'dot',
        referenceYear: 2025,
        sourceLabel: META.sourceLabel,
        meta: META,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/検証した内容/);
    const changed = new TextEncoder().encode(
      toCsv(buildGhgDemoFile('factor-set', createFixtureDb()).sheet).replace('0.671', '0.672'),
    );
    await expect(
      confirmFactorSetImport(db, manager(), {
        fileName: 'factors.csv',
        bytes: changed,
        mapping: preview.mapping,
        decimalSeparator: 'dot',
        referenceYear: 2025,
        sourceLabel: META.sourceLabel,
        meta: META,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/検証した内容/);
    expect(fixture.emissionFactorSets).toHaveLength(before);
  });

  it('検証のエラーがあれば確定しない（小数点の記号を選ばない）', async () => {
    const file = sampleCsv();
    const preview = await previewFactorSetImport(db, manager(), {
      ...file,
      mapping: null,
      decimalSeparator: null,
      referenceYear: 2025,
      sourceLabel: META.sourceLabel,
    });
    expect(preview.result.errors.length).toBeGreaterThan(0);
    await expect(
      confirmFactorSetImport(db, manager(), {
        ...file,
        mapping: preview.mapping,
        decimalSeparator: null,
        referenceYear: 2025,
        sourceLabel: META.sourceLabel,
        meta: META,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/検証のエラーが/);
  });

  it('見出しの検査: コード・出典・版は必須、架空（デモ）は選べない、同じコードは作らない', async () => {
    await expect(importSample({ sourceLabel: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(importSample({ origin: 'fixture' })).rejects.toThrow(/組織指定」か「公的参照/);
    await expect(importSample({ code: 'ORG-2025' })).rejects.toThrow(/既にあります/);
    await expect(importSample({ versionLabel: '' })).rejects.toThrow(/版を入力/);
  });

  it('デモでは取り込めるセットは 2 つまで', async () => {
    await importSample({ code: 'U-1' });
    await importSample({ code: 'U-2' });
    await expect(importSample({ code: 'U-3' })).rejects.toThrow(/2 つまで/);
  });

  it('係数の管理の権限が無い人は検証も確定もできない', async () => {
    await expect(previewSample(reviewer())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(previewSample(site())).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('有効化・取り下げ', () => {
  it('有効にすると本人名義で記録し、2 回目は断る。係数の無いセット・他社は有効にできない', async () => {
    const { set } = await importSample();
    await expect(activateFactorSet(db, reviewer(), set.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(activateFactorSet(db, other(), set.id)).rejects.toBeInstanceOf(NotFoundError);
    const active = await activateFactorSet(db, manager(), set.id);
    expect(active).toMatchObject({
      status: 'active',
      activatedBy: userId('sustainability@demo.local'),
    });
    await expect(activateFactorSet(db, manager(), set.id)).rejects.toThrow(/下書きのセットだけ/);
  });

  it('Cookie から戻すとき、有効にしたセットの係数は有効化の前に作ったものだけ・書き換えは戻さない', async () => {
    const { set, factors } = await importSample();
    const active = await activateFactorSet(db, manager(), set.id);
    const restored = replay([
      { table: 'emissionFactorSets', row: active },
      ...factors.map((row) => ({ table: 'emissionFactors', row })),
    ]);
    expect(restored.emissionFactorSets.find((s) => s.id === set.id)?.status).toBe('active');
    expect(restored.emissionFactors.filter((f) => f.factorSetId === set.id)).toHaveLength(8);
    // 有効にした後の係数の書き換え（偽の Cookie）は戻さない
    const target = factors.find((f) => f.code === 'ORG-2025R-ELEC-LOC-VN')!;
    const forged = replay([
      { table: 'emissionFactorSets', row: active },
      ...factors.map((row) => ({
        table: 'emissionFactors',
        row: row.id === target.id ? { ...row, factorValue: 9.99 } : row,
      })),
      { table: 'emissionFactors', row: { ...target, factorValue: 0.001 } },
    ]);
    expect(forged.emissionFactors.find((f) => f.id === target.id)?.factorValue).toBe(9.99);
    // 有効化より後に作った係数（偽の Cookie で足した行）は戻さない
    const late = replay([
      { table: 'emissionFactorSets', row: active },
      {
        table: 'emissionFactors',
        row: {
          ...target,
          id: '00000000-0000-4000-8000-00000000abcd',
          code: 'LATE',
          createdAt: new Date(Date.parse(active.activatedAt!) + 1000).toISOString(),
        },
      },
    ]);
    expect(late.emissionFactors.some((f) => f.code === 'LATE')).toBe(false);
  });

  it('取り下げたセットの係数は算定に使わない（代わりを使わずエラー）', async () => {
    await expect(
      retireFactorSet(db, manager(), GHG_FIXTURE_IDS.sets.org2024, { reason: '' }),
    ).resolves.toMatchObject({ status: 'retired' });
    const { set } = await importSample();
    await expect(retireFactorSet(db, manager(), set.id, { reason: '' })).rejects.toThrow(
      /有効なセットだけ/,
    );
    const retired = await retireFactorSet(db, manager(), GHG_FIXTURE_IDS.sets.org2025, {
      reason: '改訂版へ移るため',
    });
    expect(retired).toMatchObject({
      status: 'retired',
      retiredBy: userId('sustainability@demo.local'),
    });
    const result = await runCalculation(db, manager(), {
      periodId: GHG_FIXTURE_IDS.period,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('割り当てた係数のセットが有効ではありません');
  });
});
