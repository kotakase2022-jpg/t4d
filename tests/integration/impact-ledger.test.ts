import { beforeEach, describe, expect, it } from 'vitest';
import { FieldValidationError } from '@/lib/services/disclosure-project';
import { ValidationError } from '@/lib/errors/user-facing';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { upsertCsrdDmaIro } from '@/lib/services/csrd/settings';
import {
  ESRS40A_REFERENCE_NOTE,
  listIroOptions,
  loadImpactLedger,
} from '@/lib/services/impact-ledger';
import { getNarrativeEditor, saveNarrative } from '@/lib/services/narrative';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * インパクト・リスク・機会の台帳（トライアル対応 NF-10。int:impact-ledger）。
 *
 *  - 定性情報（リスク・機会／財務的影響）の版が IRO を参照 → 台帳の SSBJ 列に出る
 *  - ESRS-40a の列は事項のインパクト軸の判断を参考として出すだけ（DMA を書き換えない・書かない）
 *  - 選べる IRO は版の年度・同じ組織・削除していないもの。選べないテーマは断る
 *  - 方針・取組のメモは既存の IRO の保存（upsertCsrdDmaIro）で書く（DMA の確定を外す規則は保つ）
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
  organizationId: string = ORG_IDS.aomi,
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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

const E1 = CSRD_IDS.iros.E1;

describe('台帳の列', () => {
  it('定性情報が参照する IRO は SSBJ 列に出る。根拠の件数と方針のメモも並ぶ', async () => {
    const ledger = (await loadImpactLedger(db, author(), { periodId: PERIOD_IDS.fy2026 }))!;
    expect(ledger.total).toBeGreaterThan(0);
    const financial = ledger.rows.find((r) => r.iro.id === E1.financial)!;
    expect(financial.ssbj.map((n) => n.recordId).sort()).toEqual(
      [IDS.narratives.riskPhysical, IDS.narratives.riskTransition].sort(),
    );
    expect(financial.evidenceCount).toBe(2);
    expect(financial.iro.policyActionNote).toContain('止水板');
    // リスク・機会は 40a の列の対象外（インパクトだけを参考に出す）
    expect(financial.esrs40a).toBeNull();
    const impact = ledger.rows.find((r) => r.iro.id === E1.impact)!;
    expect(impact.esrs40a?.assessment).toBe(
      fixture.csrdDmaMatters.find((m) => m.id === CSRD_IDS.matters.E1)!.impactAssessment,
    );
    // CSRD 列は DMA の結果。DMA を確定していなければ暫定
    expect(impact.csrd.provisional).toBe(!ledger.dmaConfirmed);
    expect(ESRS40A_REFERENCE_NOTE).toContain('重要性の判断ではありません');
  });

  it('絞り込み（種類・事項・語）', async () => {
    const impactsOnly = (await loadImpactLedger(db, author(), {
      periodId: PERIOD_IDS.fy2026,
      filter: { type: 'impact' },
    }))!;
    expect(impactsOnly.rows.every((r) => r.iro.iroType === 'impact')).toBe(true);
    expect(impactsOnly.rows.length).toBe(impactsOnly.countsByType.impact);
    const e1 = (await loadImpactLedger(db, author(), {
      periodId: PERIOD_IDS.fy2026,
      filter: { topic: 'E1', q: 'GHG' },
    }))!;
    expect(e1.rows.map((r) => r.iro.id)).toContain(E1.impact);
    expect(e1.rows.every((r) => r.topic === 'E1')).toBe(true);
  });

  it('読込は書かない（40a の参考は DMA を書き換えない）', async () => {
    const matters = JSON.stringify(fixture.csrdDmaMatters);
    const settings = JSON.stringify(fixture.csrdAnalysisSettings);
    const guarded = new WriteDetectingDbClient(db);
    await loadImpactLedger(guarded, author(), { periodId: PERIOD_IDS.fy2026 });
    await listIroOptions(guarded, author(), PERIOD_IDS.fy2026);
    expect(guarded.writes).toEqual([]);
    expect(JSON.stringify(fixture.csrdDmaMatters)).toBe(matters);
    expect(JSON.stringify(fixture.csrdAnalysisSettings)).toBe(settings);
  });
});

describe('定性情報の「関連するインパクト・リスク・機会」', () => {
  it('選んだ IRO を版に残し、台帳の SSBJ 列に出る。本文が同じでも参照が変われば新しい版', async () => {
    const editor = await getNarrativeEditor(db, author(), IDS.narratives.financialImpact);
    expect(editor.iroOptions.map((o) => o.id)).toContain(E1.impact);
    const current = editor.currentVersion!;
    const result = await saveNarrative(db, author(), {
      narrativeId: IDS.narratives.financialImpact,
      baseVersionId: current.id,
      reportingPeriodId: current.reportingPeriodId,
      scopeNote: current.scopeNote,
      fields: current.fields,
      body: current.body,
      sourceAnchorIds: current.sourceAnchorIds,
      changeReason: '関連する IRO を選んだ（テスト）',
      acknowledgeImpact: true,
      iroRefs: [E1.impact],
    });
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.version.iroRefs).toEqual([E1.impact]);
    const ledger = (await loadImpactLedger(db, author(), { periodId: PERIOD_IDS.fy2026 }))!;
    expect(ledger.rows.find((r) => r.iro.id === E1.impact)!.ssbj.map((n) => n.recordId)).toContain(
      IDS.narratives.financialImpact,
    );

    // 省略は直前の版のまま（内容が同じなら版を作らない）
    const again = await saveNarrative(db, author(), {
      narrativeId: IDS.narratives.financialImpact,
      baseVersionId: result.version.id,
      reportingPeriodId: current.reportingPeriodId,
      scopeNote: current.scopeNote,
      fields: current.fields,
      body: current.body,
      sourceAnchorIds: current.sourceAnchorIds,
      changeReason: '',
      acknowledgeImpact: true,
    });
    expect(again.status).toBe('unchanged');
  });

  it('別の年度・別の組織の IRO、選べないテーマは断る', async () => {
    const editor = await getNarrativeEditor(db, author(), IDS.narratives.governance);
    expect(editor.iroOptions).toEqual([]);
    const current = editor.currentVersion!;
    await expect(
      saveNarrative(db, author(), {
        narrativeId: IDS.narratives.governance,
        baseVersionId: current.id,
        reportingPeriodId: current.reportingPeriodId,
        scopeNote: current.scopeNote,
        fields: current.fields,
        body: current.body,
        sourceAnchorIds: current.sourceAnchorIds,
        changeReason: 'テスト',
        acknowledgeImpact: true,
        iroRefs: [E1.impact],
      }),
    ).rejects.toBeInstanceOf(FieldValidationError);

    const risk = await getNarrativeEditor(db, author(), IDS.narratives.riskPhysical);
    const rv = risk.currentVersion!;
    const otherOrgIro = fixture.csrdDmaIros.find((i) => i.organizationId !== ORG_IDS.aomi);
    const otherPeriodIro = fixture.csrdDmaIros.find(
      (i) => i.organizationId === ORG_IDS.aomi && i.reportingPeriodId !== rv.reportingPeriodId,
    );
    for (const bad of [
      otherOrgIro?.id,
      otherPeriodIro?.id,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      if (!bad) continue;
      await expect(
        saveNarrative(db, author(), {
          narrativeId: IDS.narratives.riskPhysical,
          baseVersionId: rv.id,
          reportingPeriodId: rv.reportingPeriodId,
          scopeNote: rv.scopeNote,
          fields: rv.fields,
          body: rv.body,
          sourceAnchorIds: rv.sourceAnchorIds,
          changeReason: 'テスト',
          acknowledgeImpact: true,
          iroRefs: [bad],
        }),
      ).rejects.toBeInstanceOf(FieldValidationError);
    }
  });
});

describe('IRO の方針・取組のメモ', () => {
  it('既存の IRO の保存で書く。上限は 400 字。省略は今の値のまま', async () => {
    const iro = fixture.csrdDmaIros.find((i) => i.id === E1.impact)!;
    const base = {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
      iroId: iro.id,
      iroType: iro.iroType,
      subTopic: iro.subTopic,
      description: iro.description,
      valueChainStage: iro.valueChainStage,
      timeHorizon: iro.timeHorizon,
      impactOccurrence: iro.impactOccurrence,
      impactDirection: iro.impactDirection,
      impactScale: iro.impactScale,
      impactScope: iro.impactScope,
      impactIrremediability: iro.impactIrremediability,
      impactLikelihood: iro.impactLikelihood,
      financialLikelihood: iro.financialLikelihood,
      financialMagnitude: iro.financialMagnitude,
      humanRights: iro.humanRights,
      affectedStakeholders: iro.affectedStakeholders,
      relatedImpactIroId: iro.relatedImpactIroId,
    };
    const saved = await upsertCsrdDmaIro(db, author(), {
      ...base,
      policyActionNote: '（テスト）再生可能エネルギーの調達を拡大する。',
    });
    expect(saved.policyActionNote).toBe('（テスト）再生可能エネルギーの調達を拡大する。');
    const kept = await upsertCsrdDmaIro(db, author(), base);
    expect(kept.policyActionNote).toBe('（テスト）再生可能エネルギーの調達を拡大する。');
    await expect(
      upsertCsrdDmaIro(db, author(), { ...base, policyActionNote: 'あ'.repeat(401) }),
    ).rejects.toBeInstanceOf(ValidationError);
    // 根拠の引用位置は保存で消えない
    expect(fixture.csrdDmaIros.find((i) => i.id === E1.impact)!.sourceAnchorIds).toEqual(
      iro.sourceAnchorIds,
    );
  });
});
