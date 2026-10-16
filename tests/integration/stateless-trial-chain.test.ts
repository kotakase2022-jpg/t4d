import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { trialScenarioId } from '@/lib/fixtures/trial-case';
import { ESRS_40A_SAMPLE_VERSION_ID } from '@/lib/fixtures/trial-ids';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { RECONCILIATION_CHECKER_VERSION } from '@/lib/domain/export-reconciliation';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  MAX_BYTES_PER_COOKIE,
  demoEditsWereEvicted,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import { loadApprovalRoutes } from '@/lib/services/approval-route';
import { listNotesForClient } from '@/lib/services/assurance-notes';
import { loadExclusionStatus } from '@/lib/services/requirement-exclusion';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import { suggestMappings } from '@/lib/services/xbrl-tagging';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import { admin, author, playMainDemoFlow } from '../support/demo-flows';
import {
  PF_40A,
  S02,
  S07,
  S07_TARGET,
  playTrialChain,
  type TrialChainResult,
} from '../support/trial-flow';

/**
 * トライアル対応の「試行の流れ」（plan §4.3-6・K8）を、すべてのリクエストが別インスタンスに届く最悪の場合で
 * Service の層に通す（E2E は tests/e2e/zzzzz-trial-chain.stateless.ts が同じ流れを画面で通す）。
 *
 * 開示デモのリセット → 40a の判断と対象外の申請・承認 → 節の対応付け → 対応表 XLSX → FY2025 の承認済み
 * レポートを案件へ共有 → 保証側が段落にコメント → 企業が回答 → Data Room に開示レポート → DOCX 出力で突合 0 →
 * 追跡率 → XBRL プレビュー（書込なし）→ ご意見・シナリオの実施・判定・作業時間 → 3 段階の承認ルートの保存。
 *
 * 手順ごとに Fixture を作り直し、Cookie の操作だけを適用した DB で次の手順を行う。確かめること:
 *  - 前の手順の結果が別インスタンスに残る（Cookie だけで戻る）
 *  - 押し出し（容量不足で古い操作を捨てること）が 0
 *  - 試行の流れだけで Cookie（操作の記録）は 9,000B 以下（K8）
 *  - 実演の流れ → リセット → 試行の流れでも押し出し 0
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

/** 試行の流れの Cookie の上限（plan K8） */
const TRIAL_CHAIN_BUDGET_BYTES = 9_000;

async function fresh(): Promise<{ db: DemoDbClient; fixture: FixtureDb }> {
  const fixture = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
}

function editsBytes(): number {
  return [...jar.entries()]
    .filter(([name]) => name.startsWith('t4d.demo-edits'))
    .reduce((sum, [, value]) => sum + value.length, 0);
}

const sizes: Array<{ step: string; bytes: number }> = [];
function measure(step: string): void {
  sizes.push({ step, bytes: editsBytes() });
}

/** 試行の流れの結果が、別のインスタンスでもすべて残っている */
async function expectTrialResultsPersist(result: TrialChainResult): Promise<void> {
  const { db, fixture } = await fresh();
  // 判断と対象外の承認
  expect(
    fixture.projectRequirementAssessments.filter(
      (a) => a.projectFrameworkId === PF_40A && [S02, S07].includes(a.itemId),
    ),
  ).toHaveLength(2);
  expect((await loadExclusionStatus(db, author(), S07_TARGET)).state.state).toBe('approved');
  const matrix = await loadRequirementMatrix(db, author(), {
    projectId: IDS.projects.fy2026,
    frameworkVersionIds: [ESRS_40A_SAMPLE_VERSION_ID],
  });
  expect(matrix.rows.find((r) => r.itemId === S07)?.category).toBe('excluded');
  // 節の対応付け
  expect(
    fixture.disclosureBlocks.find((b) => b.id === result.blockId)?.requirementItemIds,
  ).toContain(S02);
  // 共有した写し（目録から作り直して内容ハッシュが一致）・コメント・回答
  const copy = fixture.sharedReportCopies.find((c) => c.id === result.copyId);
  expect(copy?.withdrawnAt ?? null).toBeNull();
  expect(parseSharedReportCopy(copy!.copy)).not.toBeNull();
  const notes = await listNotesForClient(db, author(), { copyId: result.copyId });
  const entry = notes.find((n) => n.note.id === result.noteId);
  expect(entry?.state).toBe('answered');
  // 出力の記録（突合 0 件）
  expect(fixture.exportArtifacts.find((a) => a.id === result.artifactId)).toMatchObject({
    mismatchCount: 0,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
  });
  // トライアルの記録
  expect(fixture.trialFeedbackItems.some((f) => f.title === '（試行）対応表の列を選びたい')).toBe(
    true,
  );
  expect(
    fixture.trialScenarioRuns.some(
      (r) =>
        r.scenarioId === trialScenarioId('TS-01') &&
        r.comment === '（試行）トレースから承認版へ遡れた。',
    ),
  ).toBe(true);
  expect(
    fixture.trialScenarioJudgements.some((j) => j.reason === '（試行）選定ケースの追跡を確認。'),
  ).toBe(true);
  expect(fixture.trialTaskTimings.some((t) => t.note === '（試行）' && t.minutes === 30)).toBe(
    true,
  );
  // 3 段階の承認ルート
  const routes = await loadApprovalRoutes(db, admin());
  const route = routes.find((r) => r.route.name === result.routeName);
  expect(route?.stages.map((s) => s.name)).toEqual([
    '拠点・部署の確認',
    '本社サステナビリティ担当の確認',
    '最終承認',
  ]);
}

beforeEach(() => {
  jar.clear();
  sizes.length = 0;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('試行の流れ（plan §4.3-6）は、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('リセット → 判断・対象外 → 対応付け → 対応表 → 共有 → コメント・回答 → 突合 → 追跡率 → XBRL → 評価の記録 → 承認ルート', async () => {
    const result = await playTrialChain(fresh, measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectTrialResultsPersist(result);

    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-trial-chain] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${TRIAL_CHAIN_BUDGET_BYTES}B）`,
    );
    expect(peak).toBeLessThanOrEqual(TRIAL_CHAIN_BUDGET_BYTES);
  });

  it('実演の流れ → 開示デモのリセット → 試行の流れでも押し出しが起きず、試行の結果が別インスタンスに残る', async () => {
    await playMainDemoFlow(fresh, () => undefined);
    expect(await demoEditsWereEvicted()).toBe(false);
    const result = await playTrialChain(fresh, measure);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectTrialResultsPersist(result);
    const peak = Math.max(...sizes.map((s) => s.bytes));
    console.warn(
      `[stateless-main→reset→trial] Cookie（操作の記録）: ${sizes.map((s) => `${s.step}=${s.bytes}B`).join(' / ')}（最大 ${peak}B・上限 ${COOKIE_CHUNKS}×${MAX_BYTES_PER_COOKIE}B）`,
    );
    expect(peak).toBeLessThanOrEqual(COOKIE_CHUNKS * MAX_BYTES_PER_COOKIE);
  });

  it('実演の流れの後に XBRL の候補・要求事項の候補を出しても押し出しが起きず、AI の実行は読み直す列だけを持ち回す', async () => {
    await playMainDemoFlow(fresh, () => undefined);
    const base = editsBytes();
    {
      const { db } = await fresh();
      await suggestMappings(db, author(), { projectId: IDS.projects.fy2026 });
    }
    const afterXbrl = editsBytes();
    {
      const { db } = await fresh();
      await suggestRequirementMappings(db, author(), {
        target: { kind: 'disclosure_block', id: IDS.blocks.fy2026RiskOpportunity.block },
      });
    }
    const afterMapping = editsBytes();
    expect(await demoEditsWereEvicted()).toBe(false);
    console.warn(
      `[stateless-main→ai] Cookie（操作の記録）: 実演の流れ=${base}B / XBRL の候補=${afterXbrl}B / 要求事項の候補=${afterMapping}B`,
    );

    const edits = await readDemoEdits();
    const runs = edits.filter((e) => e.t === 'aiRuns').map((e) => e.v as Record<string, unknown>);
    const xbrl = runs.find((r) => r.featureType === 'xbrlTagSuggestion')!;
    // XBRL の候補の出力は候補の行へ写したので持ち回さない（提供元・状態は残す）
    expect(xbrl.outputJson).toEqual({});
    expect(xbrl.inputReferenceIds).toEqual([]);
    expect(xbrl.provider).toBe('mock');
    const mapping = runs.find((r) => r.featureType === 'requirementMappingSuggestion')!;
    // 要求事項の候補は対象（先頭）と候補だけ。探した要求事項の一覧（最大 49 件）は持ち回さない
    expect(mapping.inputReferenceIds).toEqual([IDS.blocks.fy2026RiskOpportunity.block]);
    expect(Array.isArray((mapping.outputJson as { candidates?: unknown }).candidates)).toBe(true);

    // 別のインスタンスでも、節の候補を読めて、XBRL の候補の行は AI 由来として残る
    const { db, fixture } = await fresh();
    expect(
      fixture.xbrlTagMappings.some((m) => m.origin === 'ai_adopted' && m.status === 'candidate'),
    ).toBe(true);
    const { loadBlockMappingSuggestion } = await import('@/lib/services/block-requirements');
    expect(
      await loadBlockMappingSuggestion(db, author(), IDS.blocks.fy2026RiskOpportunity.block),
    ).not.toBeNull();
  });

  it('リハーサルを繰り返しても（リセット → 試行の流れ ×2）、リセット直後に前の試行の流れの操作は残らない', async () => {
    await playMainDemoFlow(fresh, () => undefined);
    const afterReset: string[][] = [];
    const capture = async () => {
      afterReset.push((await readDemoEdits()).map((e) => `${e.t}:${e.id}`));
    };
    await playTrialChain(fresh, measure, { afterReset: capture });
    const second = await playTrialChain(fresh, measure, { afterReset: capture });
    const [first, again] = afterReset as [string[], string[]];
    // 前の試行の流れ（判断・対象外・共有・回答・突合・評価の記録・承認ルート）は Cookie に残らない。
    // 残るのは監査法人が書いたコメント（企業のリセットでは消さない保証側の記録）だけ
    const extra = again.filter((key) => !first.includes(key));
    expect(extra.every((key) => key.startsWith('reviewNotes:'))).toBe(true);
    expect(extra).toHaveLength(1);
    expect(first.filter((key) => !again.includes(key))).toEqual([]);
    expect(await demoEditsWereEvicted()).toBe(false);
    await expectTrialResultsPersist(second);
    // 前のリハーサルの記録が別インスタンスに二重に残らない
    const { fixture } = await fresh();
    expect(
      fixture.trialFeedbackItems.filter((f) => f.title === '（試行）対応表の列を選びたい'),
    ).toHaveLength(1);
    expect(
      fixture.trialScenarioJudgements.filter(
        (j) => j.reason === '（試行）選定ケースの追跡を確認。',
      ),
    ).toHaveLength(1);
    expect(fixture.approvalRoutes.filter((r) => r.name === second.routeName)).toHaveLength(1);
    expect(
      fixture.approvalRouteStages.filter(
        (s) => fixture.approvalRoutes.find((r) => r.name === second.routeName)?.id === s.routeId,
      ),
    ).toHaveLength(3);
  });
});
