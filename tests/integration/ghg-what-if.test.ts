import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  listWhatIfAlternatives,
  whatIfForItem,
  whatIfForReconciliation,
} from '@/lib/services/ghg/what-if';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 仮説の再計算（plan §2.3 what-if.ts・CR-14・int:ghg-what-if）。
 *  - 書き込み 0（WriteDetectingDbClient）。照合の記録も変わらない
 *  - 候補は「この照合で違いが出うる置き換え」だけ（記録に使っていない係数セット・丸めの候補・式の形・換算なし）
 *  - US1（既存は拠点×区分の合計だけ）の差は「係数セット 2024 年版」で許容差内になる（原因の確定にはしない）
 *  - 候補に無い置き換えは受け付けない。判定の語・候補の名前に「一致」を使わない
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
): AuthorizationContext {
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
  };
}

const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const G = GHG_FIXTURE_IDS;
const SET_2024 = `set:${G.sets.org2024}`;

describe('listWhatIfAlternatives', () => {
  it('記録に使っていない係数セット・丸めの候補（既存の記述から）・式の形・換算なしを出す', async () => {
    const alternatives = await listWhatIfAlternatives(db, reviewer(), G.reconciliation);
    const keys = alternatives.map((a) => a.key);
    expect(keys).toContain(SET_2024);
    expect(keys).not.toContain(`set:${G.sets.org2025}`);
    expect(keys).toContain('rounding:none');
    // TH1 の既存の算定は「月ごと・kg・切り捨て」
    expect(keys).toContain('rounding:month:kg:0:truncate');
    expect(keys).toContain('shape:log');
    expect(keys).toContain('no-conversions');
    // R-1 は区分規則が承認前（効いた規則が無い）なので「区分規則なし」は違いが出ない
    expect(keys).not.toContain('no-rules');
    for (const a of alternatives) expect(a.label).not.toContain('一致');
  });
});

describe('whatIfForReconciliation', () => {
  it('係数セット 2024 年版で US1 と VN1 の電力の差が許容差内になる。書き込みは 0', async () => {
    const spy = new WriteDetectingDbClient(db);
    const before = structuredClone(
      fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)!,
    );
    const result = await whatIfForReconciliation(spy, reviewer(), G.reconciliation, SET_2024);
    expect(spy.writes).toEqual([]);
    expect(fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)).toEqual(before);

    const us = result.items.filter((i) => i.unitId === G.units.us);
    expect(us.length).toBeGreaterThan(0);
    for (const item of us) {
      expect(item.before.withinTolerance, item.key).toBe(false);
      expect(item.after?.withinTolerance, item.key).toBe(true);
      expect(item.closes).toBe(true);
    }
    const vnElectricity = result.items.filter(
      (i) => i.unitId === G.units.vn && i.activityKind === 'electricity',
    );
    expect(vnElectricity.every((i) => i.closes)).toBe(true);
    expect(result.closedCount).toBe(result.items.filter((i) => i.closes).length);
    expect(result.changedCount).toBeGreaterThanOrEqual(result.closedCount);
    expect(result.alternative.key).toBe(SET_2024);
  });

  it('組織の換算を使わないと、東日本工場の都市ガスの差（m3 を Nm3 として換算なし）が許容差内になる', async () => {
    const result = await whatIfForReconciliation(
      db,
      reviewer(),
      G.reconciliation,
      'no-conversions',
    );
    const gas = result.items.filter(
      (i) => i.unitId === UNIT_IDS.east && i.activityCode === 'city_gas',
    );
    expect(gas.length).toBe(12);
    expect(gas.every((i) => i.closes)).toBe(true);
  });

  it('候補に無い置き換え・他社の照合は受け付けない', async () => {
    await expect(
      whatIfForReconciliation(db, reviewer(), G.reconciliation, 'set:not-a-set'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      whatIfForReconciliation(db, reviewer(), G.reconciliation, `set:${G.sets.org2025}`),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      whatIfForReconciliation(db, other(), G.reconciliation, SET_2024),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      whatIfForReconciliation(db, reviewer(), 'not-a-uuid', SET_2024),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('whatIfForItem', () => {
  it('1 項目の仮説の再計算（保存しない）', async () => {
    const recon = fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)!;
    const item = recon.result!.items.find((i) => i.unitId === G.units.us)!;
    const spy = new WriteDetectingDbClient(db);
    const result = await whatIfForItem(spy, reviewer(), G.reconciliation, item.key, SET_2024);
    expect(spy.writes).toEqual([]);
    expect(result.items[0]!.key).toBe(item.key);
    expect(result.items[0]!.closes).toBe(true);
    await expect(
      whatIfForItem(db, reviewer(), G.reconciliation, 'no-such-item', SET_2024),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
