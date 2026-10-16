import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GHG_FIXTURE_IDS,
  GHG_FIXTURE_TOLERANCE,
  GHG_VERIFICATION_UNIT_IDS,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  MAX_BYTES_PER_COOKIE,
  demoEditsWereEvicted,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { approveRule } from '@/lib/services/ghg/classification-rules';
import { loadRun, runCalculation } from '@/lib/services/ghg/calculation';
import { recordCause } from '@/lib/services/ghg/reconciliation-notes';
import { loadReconciliation, reconcile } from '@/lib/services/ghg/reconciliation';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import { whatIfForReconciliation } from '@/lib/services/ghg/what-if';
import { loadTrialOverview } from '@/lib/services/trial-program';
import type { Uuid } from '@/types/domain';
import {
  admin,
  approver,
  author,
  playMainDemoFlow,
  reviewer,
  type Fresh,
} from '../support/demo-flows';
import { playTrialChain } from '../support/trial-flow';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * Scope1・2 の算定と照合の流れ（plan §3.3-5・§2.7・K11）を、すべてのリクエストが別インスタンスに届く最悪の場合で
 * Service の層に通す（画面の同じ流れは tests/e2e/zzzzzz-ghg-chain.stateless.ts）。
 *
 * リセット → 本社サステナ担当が概要で承認待ち（N2）を確かめる → 最終承認者が区分規則 LOGI-01 を承認 →
 * 本社サステナ担当が算定を実行（R-2）→ 二重表示で再分類分が Scope1 に出る（移動だけ）→ 既存結果 BL-1 と照合
 * （許容差は人が入れる）→ レビュー担当がベトナム工場の電力に「排出係数」を記録 → 米国工場の仮説の再計算
 * （係数セット 2024 年版）で差が閉じる（書き込み 0）→ 米国工場に原因「排出係数」を記録 → トライアル概要の
 * 拠点別の状態が新しい記録・照合で更新される。
 *
 * 手順ごとに Fixture を作り直し、Cookie の操作だけを適用した DB で次の手順を行う。確かめること:
 *  - 前の手順の結果が別インスタンスに残る（算定行・照合の結果は持ち回さず、読み込み時に同じ純関数で作り直す）
 *  - 押し出し（容量不足で古い操作を捨てること）が 0
 *  - GHG の流れだけで Cookie（操作の記録）は 3,000B 以下
 *  - 実演の流れ → リセット → 試行の流れ → GHG の流れで押し出し 0・9,000B 以下
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

/** GHG の流れ単独の Cookie の上限（plan §2.7） */
const GHG_CHAIN_BUDGET_BYTES = 3_000;
/** 実演 → リセット → 試行 → GHG の上限（plan §2.7） */
const COMBINED_BUDGET_BYTES = 9_000;

const G = GHG_FIXTURE_IDS;
const UNITS = [...GHG_VERIFICATION_UNIT_IDS];
/** 米国工場の Scope1（既存結果は拠点 × 区分の合計だけ。原因不明〔残差〕の項目） */
const US_SCOPE1 = `${G.units.us}|scope1|`;

const fresh: Fresh = async () => {
  const fixture: FixtureDb = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
};

function editsBytes(): number {
  return [...jar.entries()]
    .filter(([name]) => name.startsWith('t4d.demo-edits'))
    .reduce((sum, [, value]) => sum + value.length, 0);
}

const sizes: Array<{ step: string; bytes: number }> = [];
function measure(step: string): void {
  sizes.push({ step, bytes: editsBytes() });
}

interface GhgChainResult {
  runId: Uuid;
  reconciliationId: Uuid;
  vnItemKey: string;
}

/** GHG の流れ（手順ごとに別インスタンス）。reset: false なら前の流れの Cookie に続けて行う */
async function playGhgChain(
  step: (label: string) => void,
  options: { reset?: boolean } = {},
): Promise<GhgChainResult> {
  if (options.reset !== false) {
    await resetDisclosureDemoData((await fresh()).db, author());
    step('リセット');
  }

  // 1. 概要: 区分規則 LOGI-01 は承認待ち（N2）。Fixture の R-1 で全拠点は算定済み
  {
    const { db } = await fresh();
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: UNITS,
    });
    expect(status.attention.pendingRules).toBe(1);
    expect(status.latestRun?.id).toBe(G.run);
    expect(status.units.map((u) => u.status.calculation)).toEqual(UNITS.map(() => 'current'));
  }

  // 2. 最終承認者が区分規則を承認（提案者は本社サステナ担当）
  {
    const { db } = await fresh();
    await approveRule(db, approver(), G.rule);
  }
  step('区分規則の承認');
  {
    // 別インスタンスでも承認済み。入力が変わったので R-1 の拠点は「再算定が必要」
    const { db } = await fresh();
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: UNITS,
    });
    expect(status.attention.pendingRules).toBe(0);
    expect(status.units.map((u) => u.status.calculation)).toEqual(UNITS.map(() => 'stale'));
  }

  // 3. 本社サステナ担当が算定を実行（R-2）
  let runId: Uuid;
  {
    const { db } = await fresh();
    const result = await runCalculation(db, author(), { periodId: G.period, unitIds: UNITS });
    if (!result.ok) throw new Error(`算定できるはず: ${result.errors[0]?.message}`);
    runId = result.run.id;
  }
  step('算定の実行（R-2）');

  // 4. 二重表示（別インスタンスで算定行を作り直す）: 委託物流が Scope3 カテゴリ4 → Scope1 へ移る（合計は不変）
  {
    const { db } = await fresh();
    const loaded = await loadRun(db, author(), runId);
    expect(loaded.inputState).toBe('current');
    expect(loaded.lines.length).toBe(loaded.run.lineCount);
    const dual = loaded.dual!;
    const moved = dual.reclassified.find((r) => r.ruleId === G.rule)!;
    expect(moved).toMatchObject({ from: 'scope3_cat4', to: 'scope1' });
    expect(moved.amount).toBeGreaterThan(0);
    expect(dual.reported.scope1 - dual.protocol.scope1).toBeCloseTo(moved.amount, 9);
    expect(dual.protocol.scope3_cat4 - dual.reported.scope3_cat4).toBeCloseTo(moved.amount, 9);
    expect(dual.reported.scope1 + dual.reported.scope3_cat4).toBeCloseTo(
      dual.protocol.scope1 + dual.protocol.scope3_cat4,
      9,
    );
  }

  // 5. 既存結果 BL-1 と照合（許容差は人が入れる値。Fixture の照合 R-1 と同じ値）
  let reconciliationId: Uuid;
  {
    const { db } = await fresh();
    const recon = await reconcile(db, author(), {
      runId,
      baselineId: G.baseline,
      tolerance: GHG_FIXTURE_TOLERANCE,
    });
    reconciliationId = recon.id;
  }
  step('照合');

  // 6. レビュー担当がベトナム工場の電力の項目に「排出係数」を記録（本人名義）
  let vnItemKey: string;
  {
    const { db } = await fresh();
    const loaded = await loadReconciliation(db, reviewer(), reconciliationId);
    const vn = loaded.items!.find(
      (i) => i.unitId === G.units.vn && i.verdict === 'needs_review' && i.mainCause === 'factor',
    )!;
    expect(vn, 'ベトナム工場の電力に係数の差がある').toBeDefined();
    vnItemKey = vn.key;
    // 区分の差（委託物流）は、規則の承認後の R-2 では出ない（既存の算定も Scope1）
    expect(loaded.items!.some((i) => i.mainCause === 'classification')).toBe(false);
    await recordCause(db, reviewer(), {
      reconciliationId,
      itemKey: vn.key,
      cause: 'factor',
      comment: '（試行）2024 年版の係数',
    });
  }
  step('原因の記録（ベトナム工場）');

  // 7. 米国工場: 仮説の再計算（係数セット 2024 年版）で差が許容差内になる。保存しない（書き込み 0）
  {
    const { db } = await fresh();
    const guard = new WriteDetectingDbClient(db);
    const whatIf = await whatIfForReconciliation(
      guard,
      reviewer(),
      reconciliationId,
      `set:${G.sets.org2024}`,
    );
    expect(guard.writes).toEqual([]);
    const us = whatIf.items.filter((i) => i.unitId === G.units.us);
    expect(us.length).toBeGreaterThan(0);
    expect(us.every((i) => i.closes)).toBe(true);
  }
  step('仮説の再計算（書き込みなし）');

  // 8. 米国工場に原因「排出係数」を記録（残差の項目はコメントが必須）
  {
    const { db } = await fresh();
    await recordCause(db, reviewer(), {
      reconciliationId,
      itemKey: US_SCOPE1,
      cause: 'factor',
      comment: '（試行）仮説で閉じた',
    });
  }
  step('原因の記録（米国工場）');

  return { runId, reconciliationId, vnItemKey };
}

/** GHG の流れの結果が、別のインスタンスでもすべて残っている（トライアル概要の拠点別の状態を含む） */
async function expectGhgResultsPersist(result: GhgChainResult): Promise<void> {
  const { db } = await fresh();
  const loaded = await loadReconciliation(db, reviewer(), result.reconciliationId);
  expect(loaded.run.id).toBe(result.runId);
  expect(loaded.items).not.toBeNull();
  const byKey = new Map(loaded.items!.map((i) => [i.key, i]));
  expect(byKey.get(result.vnItemKey)?.verdict).toBe('cause_confirmed');
  expect(byKey.get(US_SCOPE1)?.verdict).toBe('cause_confirmed');
  expect(byKey.get(US_SCOPE1)?.latestNote?.confirmedCause).toBe('factor');

  // トライアル概要の「算定の検証範囲」は、新しい記録（R-2）と照合で拠点別の状態を出す
  const overview = await loadTrialOverview(db, admin());
  const status = overview.scope?.verification.status;
  expect(status?.latestRun?.id).toBe(result.runId);
  expect(status?.latestReconciliation?.id).toBe(result.reconciliationId);
  expect(status?.units.map((u) => u.status.calculation)).toEqual(UNITS.map(() => 'current'));
  // タイ工場は全項目が許容差内（照合済み）。ほかの拠点は要確認の項目が残る（記録は 2 件だけ）
  const overall = new Map(status!.units.map((u) => [u.unit.id, u.status.overall]));
  expect(overall.get(G.units.th)).toBe('reconciled');
  expect(overall.get(G.units.vn)).toBe('reconciliation_review');
}

beforeEach(() => {
  jar.clear();
  sizes.length = 0;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('Scope1・2 の算定と照合の流れ（plan §3.3-5）は、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('リセット → 承認待ち → 承認 → 算定 → 二重表示 → 照合 → 原因の記録 → 仮説の再計算 → 原因の記録（3,000B 以下・押し出し 0）', async () => {
    const result = await playGhgChain(measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectGhgResultsPersist(result);
    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-ghg-chain] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${GHG_CHAIN_BUDGET_BYTES}B）`,
    );
    expect(peak).toBeLessThanOrEqual(GHG_CHAIN_BUDGET_BYTES);
  });

  it('実演の流れ → 開示デモのリセット → 試行の流れ → GHG の流れでも押し出しが起きず、9,000B 以下', async () => {
    await playMainDemoFlow(fresh, () => undefined);
    expect(await demoEditsWereEvicted()).toBe(false);
    // 試行の流れは開示デモのリセットから始まる。GHG の流れはリセットせずに続ける（Cookie が積み上がる最悪の場合）
    await playTrialChain(fresh, measure);
    const result = await playGhgChain(measure, { reset: false });
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectGhgResultsPersist(result);
    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-main→reset→trial→ghg] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${COMBINED_BUDGET_BYTES}B・Cookie 全体 ${COOKIE_CHUNKS}×${MAX_BYTES_PER_COOKIE}B）`,
    );
    expect(peak).toBeLessThanOrEqual(COMBINED_BUDGET_BYTES);
  });

  it('リハーサルを繰り返しても（リセット → GHG の流れ ×2）、リセット直後に前の GHG の操作は残らない', async () => {
    const afterReset: string[][] = [];
    const capture = async () => {
      afterReset.push((await readDemoEdits()).map((e) => `${e.t}:${e.id}`));
    };
    await playGhgChain(measure);
    await capture();
    await resetDisclosureDemoData((await fresh()).db, author());
    await capture();
    const second = await playGhgChain(measure);
    const [afterFirst, afterSecondReset] = afterReset as [string[], string[]];
    // 1 回目の流れの GHG の操作（承認・算定の記録・照合・確認の記録）は、リセットの後の Cookie に残らない
    const ghg = (keys: string[]) =>
      keys.filter((k) =>
        /^(ghgClassificationRules|ghgCalculationRuns|ghgReconciliations|ghgReconciliationNotes):/.test(
          k,
        ),
      );
    expect(ghg(afterFirst).length).toBeGreaterThan(0);
    expect(ghg(afterSecondReset)).toEqual([]);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectGhgResultsPersist(second);
    // 別インスタンスに前のリハーサルの記録が二重に残らない（算定の記録は Fixture の R-1 と 2 回目の R-2 だけ）
    const { fixture } = await fresh();
    expect(fixture.ghgCalculationRuns.map((r) => r.id).sort()).toEqual(
      [G.run, second.runId].sort(),
    );
    expect(
      fixture.ghgReconciliationNotes.filter((n) => n.reconciliationId === second.reconciliationId),
    ).toHaveLength(2);
  });
});
