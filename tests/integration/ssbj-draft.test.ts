import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  confirmSsbjDraft,
  generateSsbjDraft,
  loadSsbjDrafts,
  saveSsbjDraftBody,
} from '@/lib/services/ssbj-draft';
import {
  addMaterialityTopic,
  assessMaterialityTopic,
  saveTopicRiskOpportunity,
} from '@/lib/services/materiality';
import {
  loadSsbjRequirementViews,
  runSsbjGapAnalysis,
  saveSsbjReview,
} from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * SSBJ 開示ドラフトの草案生成。
 *
 * 要求事項の判定と承認済みの数値は揃っているのに、文章にする工程だけが
 * 手作業で残っていた。草案に書けるのは確認済みの事項だけであること、
 * 書けなかった箇所が理由つきで残ること、確定は人が行うことを検査する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);

const period = () => fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
const metricsOf = () => fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);

/** ガバナンスの節の要求事項を、確認済み・対応済みの状態にする */
async function reviewGovernanceRequirements(limit = 3): Promise<string[]> {
  const master = await loadSsbjRequirementViews(db, manager(), period());
  const targets = master!.views
    .filter((v) => v.area === 'governance' && v.assessment.applicability === 'applicable')
    .slice(0, limit);

  for (const view of targets) {
    await runSsbjGapAnalysis(db, manager(), view.assessment.id);
    await saveSsbjReview(db, manager(), {
      assessmentId: view.assessment.id,
      decision: 'modify',
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'covered',
      comment: '統合報告書の記載を確認しました。',
    });
  }
  return targets.map((v) => v.item.code);
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('初期状態', () => {
  it('節ごとに草案の有無が分かる', async () => {
    const overview = await loadSsbjDrafts(db, manager(), period());
    expect(overview).not.toBeNull();
    // ガバナンス・戦略・リスク管理・指標及び目標・その他
    expect(overview!.areas).toHaveLength(5);
    for (const area of overview!.areas) {
      expect(area.draft).toBeNull();
      expect(area.requirementCount).toBeGreaterThan(0);
    }
    expect(overview!.confirmedCount).toBe(0);
  });

  it('草案に書けるのは、確認済みかつ対応済みの要求事項だけ', async () => {
    const overview = await loadSsbjDrafts(db, manager(), period());
    const total = overview!.areas.reduce((sum, a) => sum + a.requirementCount, 0);
    const writable = overview!.areas.reduce((sum, a) => sum + a.writableCount, 0);

    // 確認が済んでいない要求事項が大半なので、全体が書ける状態にはならない
    expect(writable).toBeLessThan(total);

    // 書けると数えたものは、必ず確認済みかつ対応済み／おおむね対応
    const master = await loadSsbjRequirementViews(db, manager(), period());
    const reviewedAndCovered = master!.views.filter(
      (v) =>
        v.assessment.applicability === 'applicable' &&
        v.assessment.reviewedAt !== null &&
        (v.assessment.finalStatus === 'covered' || v.assessment.finalStatus === 'mostly_covered'),
    ).length;
    expect(writable).toBe(reviewedAndCovered);
  });
});

describe('草案の生成', () => {
  it('確認済みの要求事項だけを本文に書き、残りは理由つきで外す', async () => {
    const reviewed = await reviewGovernanceRequirements(3);

    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');

    expect(draft.body.length).toBeGreaterThan(20);
    // 確認済みにしたものが根拠として挙がる
    for (const code of reviewed) {
      expect(draft.coveredItemCodes).toContain(code);
    }
    // 残りは「書けなかった箇所」として理由つきで残る
    expect(draft.gaps.length).toBeGreaterThan(0);
    for (const gap of draft.gaps) {
      expect(gap.reason.length).toBeGreaterThan(5);
      expect(draft.coveredItemCodes).not.toContain(gap.itemCode);
    }
  });

  it('未確認の要求事項は「確認が済んでいない」と明示される', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(draft.gaps.some((g) => g.reason.includes('確認が済んでいない'))).toBe(true);
  });

  it('草案には必ず「そのまま開示しない」旨の警告が付く', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(draft.aiWarnings.join(' ')).toContain('草案');
    expect(draft.aiWarnings.join(' ')).toContain('確定');
  });

  it('生成した時点では未確定（AI は確定しない）', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(draft.confirmedAt).toBeNull();
    expect(draft.confirmedBy).toBeNull();
  });

  it('AI が書いた本文と、人が直した本文を分けて持つ', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(draft.body).toBe(draft.aiBody);

    const edited = await saveSsbjDraftBody(db, manager(), draft.id, '担当者が書き直した本文です。');
    expect(edited.body).toBe('担当者が書き直した本文です。');
    // AI が何を書いたかは残る（そのまま開示したのかを後から説明できる）
    expect(edited.aiBody).toBe(draft.aiBody);

    const overview = await loadSsbjDrafts(db, manager(), period());
    expect(overview!.areas.find((a) => a.area === 'governance')?.edited).toBe(true);
  });

  it('AI 実行の証跡（confidence・実行 ID）が残る', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(draft.aiRunId).not.toBeNull();
    expect(draft.aiConfidence).not.toBeNull();
    expect(draft.aiGeneratedAt).not.toBeNull();

    const runs = await db.select('aiRuns', { where: { featureType: 'ssbjDisclosureDraft' } });
    expect(runs.length).toBeGreaterThan(0);
  });

  it('AI 実行権限が無ければ生成できない', async () => {
    await expect(generateSsbjDraft(db, siteUser(), period(), 'governance')).rejects.toThrow();
  });
});

describe('確定', () => {
  it('人の操作で確定でき、誰がいつ確定したかが残る', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');

    const confirmed = await confirmSsbjDraft(db, manager(), draft.id);
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.confirmedBy).toBe(userId('sustainability@demo.local'));

    const overview = await loadSsbjDrafts(db, manager(), period());
    expect(overview!.confirmedCount).toBe(1);
  });

  it('本文を直すと確定が外れる', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    await confirmSsbjDraft(db, manager(), draft.id);

    const edited = await saveSsbjDraftBody(db, manager(), draft.id, '直した本文');
    expect(edited.confirmedAt).toBeNull();
  });

  it('作り直すと確定が外れる', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    await confirmSsbjDraft(db, manager(), draft.id);

    const again = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(again.id).toBe(draft.id);
    expect(again.confirmedAt).toBeNull();
  });

  it('本文が空のままでは確定できない', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    await saveSsbjDraftBody(db, manager(), draft.id, '   ');
    await expect(confirmSsbjDraft(db, manager(), draft.id)).rejects.toThrow(/空/);
  });

  it('確定は監査ログに残る', async () => {
    await reviewGovernanceRequirements(2);
    const draft = await generateSsbjDraft(db, manager(), period(), 'governance');
    await confirmSsbjDraft(db, manager(), draft.id);

    const audit = await db.select('auditEvents', {
      where: { resourceType: 'ssbj_disclosure_draft' },
    });
    expect(audit.map((a) => a.afterSummary ?? '').join(' ')).toContain('確定');
  });
});

describe('決定論', () => {
  it('同じ入力からは同じ草案が出る（Mock は決定論的）', async () => {
    await reviewGovernanceRequirements(2);
    const first = await generateSsbjDraft(db, manager(), period(), 'governance');
    const firstBody = first.aiBody;

    // 同じ状態から作り直しても同じ本文になる
    const second = await generateSsbjDraft(db, manager(), period(), 'governance');
    expect(second.aiBody).toBe(firstBody);
  });
});

describe('マテリアリティのリスク・機会と戦略の草案（SSBJ 一般-12・14）', () => {
  it('重要性ありの課題のリスク・機会が、戦略の草案の起点になる', async () => {
    // 課題を登録し、リスク・機会を書き、重要性ありと評価する
    const topic = await addMaterialityTopic(db, manager(), metricsOf(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      title: '気候変動に伴う炭素価格の上昇',
      description: '',
      category: 'environment',
      metricCodes: ['scope1'],
    });
    await saveTopicRiskOpportunity(db, manager(), metricsOf(), {
      topicId: topic.id,
      risks: '炭素価格の上昇により製造原価が増加する。',
      opportunities: '低炭素製品の需要拡大により受注が増える。',
    });
    await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'high',
      rationale: '規制影響を直接受けるため。',
    });

    // 戦略の節の草案に、識別したリスク及び機会が織り込まれる
    const draft = await generateSsbjDraft(db, manager(), period(), 'strategy');
    expect(draft.aiBody).toContain('識別したサステナビリティ関連のリスク及び機会');
    expect(draft.aiBody).toContain('炭素価格の上昇により製造原価が増加する');
    expect(draft.aiBody).toContain('低炭素製品の需要拡大により受注が増える');
  });

  it('リスク・機会が未記入なら、戦略の草案は記入を促す警告を出す', async () => {
    const draft = await generateSsbjDraft(db, manager(), period(), 'strategy');
    expect(draft.aiWarnings.join(' ')).toContain('リスク・機会が記入されていません');
    expect(draft.aiWarnings.join(' ')).toContain('一般-12');
  });

  it('重要性なしの課題のリスク・機会は草案に混ぜない', async () => {
    const topic = await addMaterialityTopic(db, manager(), metricsOf(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      title: '重要でない課題',
      description: '',
      category: 'environment',
      metricCodes: [],
    });
    await saveTopicRiskOpportunity(db, manager(), metricsOf(), {
      topicId: topic.id,
      risks: '混ざってはいけないリスクの記述。',
      opportunities: '',
    });
    await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'not_material',
      rationale: '影響が限定的なため。',
    });

    const draft = await generateSsbjDraft(db, manager(), period(), 'strategy');
    expect(draft.aiBody).not.toContain('混ざってはいけないリスクの記述');
  });
});
