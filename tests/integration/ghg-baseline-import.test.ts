import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { toXlsx } from '@/lib/exports';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { buildGhgDemoFile } from '@/lib/fixtures/ghg-demo-files';
import { GHG_FIXTURE_IDS, GHG_FIXTURE_TOLERANCE } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
} from '@/lib/repositories/demo-edit-codec';
import {
  BASELINE_SITE_EXCLUDED,
  confirmBaselineImport,
  previewBaselineImport,
  type BaselineImportSettings,
} from '@/lib/services/ghg/baseline-import';
import { reconcile } from '@/lib/services/ghg/reconciliation';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 既存の算定結果の取込（plan §2.3 baseline-import.ts・CR-11・int:ghg-baseline-import）。
 *  - 流れ: ファイル → 列の対応と拠点の対応付け → 検証 → 確定（検証はサーバーに持たない。確定で読み直す）
 *  - 拠点コードの対応付けは利用者が選ぶ（選ばれていない拠点コードがあれば確定しない。推測しない）
 *  - 小数点の記号を選ばなければ「3.741」のような数は読まない
 *  - 検証したファイルと同じかを sha256 で確かめる
 *  - 権限は enterprise.import.run ＋ enterprise.data.write、対応付けた拠点は担当拠点
 *  - 追記専用（差し替えは supersedesId）。監査ログは import_committed
 *  - Demo の上限（既存結果 2 件・80 行）。確定した行は Cookie から戻せる
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let file: { name: string; buffer: Uint8Array };

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  const demo = buildGhgDemoFile('baseline', createFixtureDb());
  file = {
    name: demo.fileName,
    buffer: await toXlsx([demo.sheet], 'baseline'),
  };
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  options: { organizationId?: Uuid; unitScopeIds?: Uuid[] } = {},
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: options.organizationId ?? ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: options.unitScopeIds ?? [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const G = GHG_FIXTURE_IDS;

const ALL_SITES: Record<string, string> = {
  EAST: UNIT_IDS.east,
  TH1: G.units.th,
  VN1: G.units.vn,
  MX1: G.units.mx,
};

async function settingsFor(
  overrides: Partial<BaselineImportSettings> = {},
): Promise<BaselineImportSettings> {
  const first = await previewBaselineImport(db, author(), {
    periodId: G.period,
    fileName: file.name,
    buffer: file.buffer,
  });
  return {
    ...first.settings,
    decimalSeparator: 'dot',
    sites: ALL_SITES,
    ...overrides,
  };
}

describe('previewBaselineImport', () => {
  it('最初は見出しから列の対応の既定値を出し、拠点コードの対応付けは選ばない（推測しない）', async () => {
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
    });
    expect(preview.settings.mapping).toEqual({
      siteCode: '拠点コード',
      scope: '区分',
      emissions: '排出量',
      emissionsUnit: '排出量の単位',
      activity: '活動',
      rounding: '丸め',
    });
    expect(preview.settings.sites).toEqual({});
    expect(preview.settings.decimalSeparator).toBeNull();
    expect(preview.siteCodes.map((s) => s.code)).toEqual(['EAST', 'MX1', 'TH1', 'VN1']);
    expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.totalRows).toBe(19);
    const v = preview.validation!;
    expect(v.blockers.join(' ')).toMatch(/拠点の対応付けを選んでいない拠点コードがあります/);
    // 小数点の記号を選んでいないので「132.639」のような数は読まない（1/1000 の誤読を防ぐ）
    expect(v.errorCount).toBeGreaterThan(0);
    expect(v.errors[0]!.message).toMatch(/小数点の記号を選ぶと読める場合があります/);
    // 何も書かない
    expect(fixture.ghgBaselineResults).toHaveLength(1);
  });

  it('小数点の記号と拠点を選ぶと確定できる（粒度は拠点×活動・丸めの記述を読める）', async () => {
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings: await settingsFor(),
    });
    const v = preview.validation!;
    expect(v.blockers).toEqual([]);
    expect(v.errorCount).toBe(0);
    expect(v.rowCount).toBe(19);
    expect(v.granularity).toBe('site_activity');
    expect(v.rounding).toEqual({ parsed: 19, unreadable: 0, empty: 0 });
    expect(v.scopes.sort()).toEqual(['scope1', 'scope2', 'scope2_location']);
  });

  it('拠点・区分・排出量の列が無ければ検証しない。同じ列を 2 つに選ぶと確定できない', async () => {
    const base = await settingsFor();
    const { scope: _scope, ...withoutScope } = base.mapping;
    const missing = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings: { ...base, mapping: withoutScope },
    });
    expect(missing.validation).toBeNull();
    const dup = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings: { ...base, mapping: { ...base.mapping, activity: '拠点コード' } },
    });
    expect(dup.validation!.blockers.join(' ')).toMatch(/同じ列を 2 つの項目に選んでいます/);
  });

  it('取込の権限が無い人（レビュー担当）は検証もできない。形式の違うファイルは断る', async () => {
    await expect(
      previewBaselineImport(db, reviewer(), {
        periodId: G.period,
        fileName: file.name,
        buffer: file.buffer,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      previewBaselineImport(db, author(), {
        periodId: G.period,
        fileName: 'result.pdf',
        buffer: file.buffer,
      }),
    ).rejects.toThrow(/取り込めない形式/);
    await expect(
      previewBaselineImport(db, author(), {
        periodId: 'not-a-uuid',
        fileName: file.name,
        buffer: file.buffer,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('confirmBaselineImport', () => {
  it('確定すると追記し（行・対応付け・sha256）、監査ログは import_committed', async () => {
    const settings = await settingsFor();
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    const row = await confirmBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）既存算定結果 拠点×活動',
      expectedSha256: preview.sha256,
    });
    expect(row).toMatchObject({
      organizationId: ORG_IDS.aomi,
      reportingPeriodId: G.period,
      granularity: 'site_activity',
      rowCount: 19,
      fileSha256: preview.sha256,
      supersedesId: null,
      createdBy: userId('sustainability@demo.local'),
      unitMapping: ALL_SITES,
    });
    expect(row.rows.every((r) => r.unitId !== null && r.rounding?.stage === 'site_activity')).toBe(
      true,
    );
    expect(fixture.ghgBaselineResults.map((b) => b.id)).toContain(row.id);
    const audit = fixture.auditEvents.find((e) => e.resourceId === row.id)!;
    expect(audit).toMatchObject({
      eventType: 'import_committed',
      resourceType: 'ghg_baseline_result',
    });

    // 取り込んだ既存結果と算定の記録 R-1 を照合できる（Σ寄与＋残差＝既存−T4D）
    const recon = await reconcile(db, author(), {
      runId: G.run,
      baselineId: row.id,
      tolerance: GHG_FIXTURE_TOLERANCE,
    });
    expect(recon.result!.items.length).toBeGreaterThan(0);
    for (const item of recon.result!.items) {
      const sum = item.steps.reduce((a, s) => a + s.delta, 0) + item.residual;
      expect(sum, item.key).toBeCloseTo(item.diff, 9);
    }
  });

  it('「照合に使わない」を選んだ拠点コードの行は拠点を持たないまま残す', async () => {
    const settings = await settingsFor({ sites: { ...ALL_SITES, MX1: BASELINE_SITE_EXCLUDED } });
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    expect(preview.validation!.excludedRows).toBe(4);
    const row = await confirmBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）MX1 を除く',
      expectedSha256: preview.sha256,
    });
    expect(row.unitMapping).not.toHaveProperty('MX1');
    expect(row.rows.filter((r) => r.siteCode === 'MX1').every((r) => r.unitId === null)).toBe(true);
  });

  it('検証したファイルと違う・拠点の対応付けが足りない・名前が空なら確定しない', async () => {
    const settings = await settingsFor();
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    const input = {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）',
      expectedSha256: preview.sha256,
    };
    await expect(
      confirmBaselineImport(db, author(), { ...input, expectedSha256: '0'.repeat(64) }),
    ).rejects.toThrow(/検証したファイルと内容が違います/);
    const { VN1: _vn, ...partial } = ALL_SITES;
    await expect(
      confirmBaselineImport(db, author(), { ...input, settings: { ...settings, sites: partial } }),
    ).rejects.toThrow(/拠点の対応付けを選んでいない拠点コードがあります（VN1）/);
    await expect(
      confirmBaselineImport(db, author(), { ...input, label: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      confirmBaselineImport(db, author(), {
        ...input,
        settings: { ...settings, decimalSeparator: null },
      }),
    ).rejects.toThrow(/読めない行が/);
    expect(fixture.ghgBaselineResults).toHaveLength(1);
  });

  it('担当拠点の外の拠点には対応付けられない（拠点スコープ）。取込の権限が無い人は確定できない', async () => {
    const siteUser = ctxFor('site-user@demo.local', ['site_contributor'], {
      unitScopeIds: [UNIT_IDS.east],
    });
    const settings = await settingsFor();
    const { sha256 } = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    await expect(
      previewBaselineImport(db, siteUser, {
        periodId: G.period,
        fileName: file.name,
        buffer: file.buffer,
        settings,
      }),
    ).rejects.toThrow(/担当外の組織・拠点/);
    await expect(
      confirmBaselineImport(db, siteUser, {
        periodId: G.period,
        fileName: file.name,
        buffer: file.buffer,
        settings,
        label: '（テスト）',
        expectedSha256: sha256,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // 担当拠点（東日本工場）だけを対応付け、ほかを照合に使わないなら取り込める
    const own = {
      ...settings,
      sites: {
        EAST: UNIT_IDS.east,
        TH1: BASELINE_SITE_EXCLUDED,
        VN1: BASELINE_SITE_EXCLUDED,
        MX1: BASELINE_SITE_EXCLUDED,
      },
    };
    const row = await confirmBaselineImport(db, siteUser, {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings: own,
      label: '（テスト）東日本工場だけ',
      expectedSha256: sha256,
    });
    expect(row.unitMapping).toEqual({ EAST: UNIT_IDS.east });
    await expect(
      confirmBaselineImport(db, reviewer(), {
        periodId: G.period,
        fileName: file.name,
        buffer: file.buffer,
        settings,
        label: '（テスト）',
        expectedSha256: sha256,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('差し替えは同じ期間の既存結果だけ。別の期間・他社の既存結果は差し替えられない', async () => {
    const settings = await settingsFor();
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    const input = {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）差し替え',
      expectedSha256: preview.sha256,
    };
    const replaced = await confirmBaselineImport(db, author(), {
      ...input,
      supersedesId: G.baseline,
    });
    expect(replaced.supersedesId).toBe(G.baseline);
    fixture.ghgBaselineResults.push({
      ...fixture.ghgBaselineResults[0]!,
      id: '55555555-5555-4555-8555-555555555555',
      reportingPeriodId: PERIOD_IDS.fy2026,
    });
    await expect(
      confirmBaselineImport(db, author(), {
        ...input,
        supersedesId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrow(/同じ期間/);
    await expect(
      confirmBaselineImport(db, author(), { ...input, supersedesId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Demo の上限: 利用者が取り込む既存結果は 2 件まで（Fixture の BL-1 は数えない）', async () => {
    const settings = await settingsFor();
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    const input = {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）',
      expectedSha256: preview.sha256,
    };
    await confirmBaselineImport(db, author(), input);
    await confirmBaselineImport(db, author(), input);
    await expect(confirmBaselineImport(db, author(), input)).rejects.toThrow(/2 件まで/);
  });

  it('確定した既存結果は Cookie から戻せる（Demo の持ち回しの検査を通る形で書く）', async () => {
    const settings = await settingsFor();
    const preview = await previewBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
    });
    const row = await confirmBaselineImport(db, author(), {
      periodId: G.period,
      fileName: file.name,
      buffer: file.buffer,
      settings,
      label: '（テスト）持ち回し',
      expectedSha256: preview.sha256,
    });
    const target = createFixtureDb();
    applyDemoEdits(
      target,
      decodeDemoEdits(
        encodeDemoEditStream([
          {
            t: 'ghgBaselineResults',
            id: row.id,
            v: compactRow(
              'ghgBaselineResults',
              row as unknown as Record<string, unknown>,
              fixture,
            )!,
          },
        ]),
      ),
    );
    expect(target.ghgBaselineResults.find((b) => b.id === row.id)).toEqual(row);
  });
});
