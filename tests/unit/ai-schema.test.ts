import { describe, expect, it } from 'vitest';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { AI_SCHEMAS, PROMPT_VERSIONS, type AiFeature } from '@/lib/ai/schemas';

/**
 * AI 出力の構造化（指示書 14 章）。
 * Mock / OpenAI いずれの Provider も同じ Zod スキーマを満たす契約。
 */

const provider = new MockAIProvider();

const INVOCATION_INPUTS: Record<AiFeature, Record<string, unknown>> = {
  importMapping: {
    rows: [
      { rowIndex: 0, raw: { 拠点: '東日本工場', 項目: 'Scope1', 値: '1234.5', 単位: 't-CO2e' } },
      { rowIndex: 1, raw: { 拠点: '本社', 項目: '謎の項目', 値: '', 単位: '' } },
    ],
    periodCode: 'FY2026',
    defaultUnitCode: 'HQ',
  },
  anomalyExplanation: {
    anomalies: [{ dataPointId: 'dp-1', ruleKey: 'unit_mismatch', severity: 'error' }],
    sources: [],
  },
  cdpQuestionMapping: {
    items: [{ code: 'C6.1', text: 'Scope1 総排出量（t-CO2e）を記載してください。' }],
  },
  cdpDraftGeneration: {
    itemCode: 'C6.1',
    questionText: 'Scope1 総排出量を記載してください。',
    answerType: 'numeric',
    previousAnswer: null,
    metricValues: [{ label: 'Scope1', value: 8500, unit: 't-CO2e', periodLabel: 'FY2026' }],
    sources: [],
  },
  ssbjGapAnalysis: {
    itemCode: '気候-10',
    title: '監督に責任を負うガバナンス機関・個人の開示',
    requirementText:
      '10. 第9項の目的を達成するため、気候関連のリスク及び機会の監督に責任を負うガバナンス機関又は個人に関して、次の事項を開示しなければならない。',
    required: true,
    documents: [
      {
        name: '統合報告書2026',
        page: '42 ページ',
        excerpt: 'サステナビリティ委員会が気候関連の課題を審議し、取締役会へ報告しています。',
      },
    ],
    metricValues: [{ label: 'Scope1 排出量', value: 7859.8, unit: 't-CO2e' }],
    hasApprovalWorkflow: true,
    sources: [],
  },
  evidenceMapping: {
    targetCode: 'scope1',
    fragments: [
      { fileVersionId: 'fv-1', page: 2, text: '燃料使用量 合計 1,234 L', locator: 'p.2' },
    ],
  },
  inconsistencyCheck: {
    responses: [
      { code: 'C1.1b', text: '2019年の取り組みについて記載', periodLabel: 'FY2026' },
      { code: 'C12.1', text: '', periodLabel: 'FY2026' },
    ],
  },
  insightDiscovery: {
    periodLabel: 'FY2026（架空）',
    previousPeriodLabel: 'FY2025（架空）',
    submissionDueDate: '2026-06-30',
    metricYoY: [
      { metricName: 'Scope1 排出量', unit: 't-CO2e', current: 9800, previous: 9052 },
      { metricName: '用水使用量', unit: 'm3', current: 118000, previous: 124000 },
    ],
    unitYoY: [
      { metricName: '用水使用量', unitName: '東日本工場', current: 70000, previous: 60000 },
      { metricName: '用水使用量', unitName: '西日本工場', current: 48000, previous: 64000 },
    ],
    collection: { total: 40, approved: 22, draft: 10, submitted: 8, returned: 0 },
    quality: { openValidationErrors: 2, approvedWithoutEvidence: 3 },
    disclosures: [{ framework: 'CDP', total: 12, requiredUnanswered: 4, approved: 3 }],
    assurance: { openPbcRequests: 2 },
  },
  copilotChat: {
    question: 'Scope1 の当年値と前年比は？',
    history: [],
    snapshot: {
      periodLabel: 'FY2026（架空）',
      submissionDueDate: '2026-06-30',
      metricYoY: [
        {
          metricName: 'Scope1 直接排出',
          metricCode: 'scope1',
          unit: 't-CO2e',
          current: 9800,
          previous: 9052,
        },
      ],
      unitYoY: [],
      collection: { total: 40, approved: 22, draft: 10, submitted: 8 },
      disclosures: [{ framework: 'CDP', total: 12, requiredUnanswered: 4, approved: 3 }],
      assurance: { openPbcRequests: 2 },
    },
  },

  assuranceEvidenceSummary: {
    subjectLabel: '東日本工場 Scope2',
    fragments: [{ text: '4月分 電力使用量 120,000 kWh', locator: 'p.1' }],
    sources: [],
  },
  assuranceChangeSummary: {
    changes: [{ subject: 'dp-1', before: '100 t (v1)', after: '120 t (v2)' }],
    sources: [],
  },
};

const FEATURES = Object.keys(AI_SCHEMAS) as AiFeature[];

describe('MockAIProvider', () => {
  it.each(FEATURES)('%s の出力がスキーマを満たす', async (feature) => {
    const result = await provider.run({
      feature,
      context: { organizationName: 'テスト企業', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: ['ref-1'],
      input: INVOCATION_INPUTS[feature],
    });

    expect(AI_SCHEMAS[feature].safeParse(result.output).success).toBe(true);
    expect(result.provider).toBe('mock');
    expect(result.promptVersion).toBe(PROMPT_VERSIONS[feature]);
    expect(result.tokenUsage.total).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  it('同じ入力からは同じ出力を返す（決定論的）', async () => {
    const invocation = {
      feature: 'cdpDraftGeneration' as const,
      context: { organizationName: 'テスト企業', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: ['ref-1'],
      input: INVOCATION_INPUTS.cdpDraftGeneration,
    };
    const a = await provider.run(invocation);
    const b = await provider.run(invocation);
    expect(a.output).toEqual(b.output);
  });

  it('取込マッピングで指標を特定できない行に警告を付ける', async () => {
    const result = await provider.run({
      feature: 'importMapping',
      context: { organizationName: 'テスト企業', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: [],
      input: INVOCATION_INPUTS.importMapping,
    });
    const unknownRow = result.output.rows.find((r) => r.rowIndex === 1);
    expect(unknownRow?.metricCode).toBeNull();
    expect(unknownRow?.warnings.length).toBeGreaterThan(0);
    expect(unknownRow?.confidence).toBeLessThan(0.5);
  });

  it('CDP ドラフトは常に「人の確認が必要」である旨を警告に含む', async () => {
    const result = await provider.run({
      feature: 'cdpDraftGeneration',
      context: { organizationName: 'テスト企業', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: [],
      input: INVOCATION_INPUTS.cdpDraftGeneration,
    });
    expect(result.output.warnings.join(' ')).toContain('人が内容を確認');
  });

  it('監査 AI は保証結論を出さず、確認すべき論点だけを返す', async () => {
    const result = await provider.run({
      feature: 'assuranceEvidenceSummary',
      context: { organizationName: 'あおば保証監査法人', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: [],
      input: INVOCATION_INPUTS.assuranceEvidenceSummary,
    });
    expect(result.output.pointsToVerify.length).toBeGreaterThan(0);
    expect(result.output.warnings.join(' ')).toContain('保証結論ではありません');
  });

  it('Snapshot 後変更の要約は影響評価を確定しない', async () => {
    const result = await provider.run({
      feature: 'assuranceChangeSummary',
      context: { organizationName: 'あおば保証監査法人', reportingPeriodLabel: 'FY2026' },
      inputReferenceIds: [],
      input: INVOCATION_INPUTS.assuranceChangeSummary,
    });
    expect(result.output.warnings.join(' ')).toContain('監査人が確定');
  });
});

describe('スキーマの必須項目', () => {
  it.each(FEATURES)('%s は confidence / warnings / sources を必須にしている', (feature) => {
    const parsed = AI_SCHEMAS[feature].safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const missing = parsed.error.issues.map((i) => i.path.join('.'));
    expect(missing).toContain('confidence');
    expect(missing).toContain('warnings');
    expect(missing).toContain('sources');
  });

  it('confidence は 0..1 の範囲', () => {
    const result = AI_SCHEMAS.cdpQuestionMapping.safeParse({
      mappings: [],
      confidence: 1.5,
      warnings: [],
      sources: [],
    });
    expect(result.success).toBe(false);
  });
});
