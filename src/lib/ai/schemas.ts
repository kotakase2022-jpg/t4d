import { z } from 'zod';

/**
 * AI の構造化出力スキーマ（指示書 14 章）。
 *
 * 原則:
 *  - すべての Use Case を Zod スキーマで検証する。Free Text をそのまま業務確定値へ入れない。
 *  - 出力には必ず「参照元（sources）」「確信度（confidence）」「不足・推測（warnings）」を含める。
 *  - AI は候補を出すだけで、確定は人が行う。
 */

export const aiSourceSchema = z.object({
  kind: z.enum([
    'data_point',
    'evidence',
    'previous_response',
    'disclosure_response',
    'metric_definition',
    'snapshot_item',
  ]),
  id: z.string().nullable(),
  label: z.string(),
  locator: z.string().nullable(),
  periodLabel: z.string().nullable(),
});

const base = {
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  sources: z.array(aiSourceSchema),
};

// 1. importMapping — 取込行の項目マッピング
export const importMappingSchema = z.object({
  rows: z.array(
    z.object({
      rowIndex: z.number().int(),
      metricCode: z.string().nullable(),
      unitCode: z.string().nullable(),
      periodCode: z.string().nullable(),
      value: z.number().nullable(),
      unitOfMeasure: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      warnings: z.array(z.string()),
      sourceLocator: z.string().nullable(),
    }),
  ),
  ...base,
});
export type ImportMappingOutput = z.infer<typeof importMappingSchema>;

// 2. anomalyExplanation — 異常値の説明
export const anomalyExplanationSchema = z.object({
  findings: z.array(
    z.object({
      dataPointId: z.string(),
      likelyCause: z.string(),
      suggestedAction: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
    }),
  ),
  ...base,
});
export type AnomalyExplanationOutput = z.infer<typeof anomalyExplanationSchema>;

// 3. cdpQuestionMapping — 質問と指標の対応候補
export const cdpQuestionMappingSchema = z.object({
  mappings: z.array(
    z.object({
      itemCode: z.string(),
      metricCode: z.string().nullable(),
      rationale: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  ...base,
});
export type CdpQuestionMappingOutput = z.infer<typeof cdpQuestionMappingSchema>;

// 4. cdpDraftGeneration — 回答ドラフト
export const cdpDraftGenerationSchema = z.object({
  itemCode: z.string(),
  draftText: z.string(),
  draftNumeric: z.number().nullable(),
  draftChoice: z.array(z.string()),
  /** 前年からの変更点と理由 */
  changeSummary: z.string(),
  /** 埋められなかった情報 */
  missingInformation: z.array(z.string()),
  ...base,
});
export type CdpDraftGenerationOutput = z.infer<typeof cdpDraftGenerationSchema>;

// 4.5 ssbjGapAnalysis — SSBJ 要求事項と現在の開示内容の比較
//
// 「対応済み／未対応」を返すだけでは、担当者は次に何をすればよいか分からない。
// 何が不足しているのかを列挙し、どの資料の何ページを根拠にそう判定したのかを返す。
// これは候補であって最終判定ではない（担当者の確認を経て finalStatus になる）。
export const ssbjGapAnalysisSchema = z.object({
  itemCode: z.string(),
  /** 開示・データ・業務プロセスの 3 観点それぞれの判定 */
  disclosureStatus: z.enum(['covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed']),
  dataStatus: z.enum(['covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed']),
  processStatus: z.enum(['covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed']),
  /** 評価コメント（なぜその判定になったか） */
  comment: z.string(),
  /** 不足している情報の列挙 */
  missingInformation: z.array(z.string()),
  /** 推奨される対応 */
  recommendation: z.string(),
  /** 既存資料のどこを根拠にしたか */
  sourceDocument: z.string().nullable(),
  sourcePage: z.string().nullable(),
  sourceExcerpt: z.string().nullable(),
  ...base,
});
export type SsbjGapAnalysisOutput = z.infer<typeof ssbjGapAnalysisSchema>;

// 5. evidenceMapping — Evidence 該当箇所の候補
export const evidenceMappingSchema = z.object({
  candidates: z.array(
    z.object({
      fileVersionId: z.string(),
      page: z.number().int().nullable(),
      locator: z.string().nullable(),
      excerpt: z.string(),
      targetKind: z.enum(['metric', 'disclosure_item']),
      targetCode: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  ...base,
});
export type EvidenceMappingOutput = z.infer<typeof evidenceMappingSchema>;

// 6. inconsistencyCheck — 矛盾・陳腐化の検出
export const inconsistencyCheckSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.enum([
        'missing_information',
        'stale_content',
        'period_mismatch',
        'contradiction',
        'evidence_gap',
      ]),
      subject: z.string(),
      detail: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
    }),
  ),
  ...base,
});
export type InconsistencyCheckOutput = z.infer<typeof inconsistencyCheckSchema>;

// 7. assuranceEvidenceSummary — Evidence の要約（保証結論は出さない）
export const assuranceEvidenceSummarySchema = z.object({
  summary: z.string(),
  keyFigures: z.array(
    z.object({ label: z.string(), value: z.string(), locator: z.string().nullable() }),
  ),
  /** 監査人が確認すべき論点。結論ではない。 */
  pointsToVerify: z.array(z.string()),
  ...base,
});
export type AssuranceEvidenceSummaryOutput = z.infer<typeof assuranceEvidenceSummarySchema>;

// 8. assuranceChangeSummary — Snapshot 後変更の要約
export const assuranceChangeSummarySchema = z.object({
  changes: z.array(
    z.object({
      subject: z.string(),
      before: z.string(),
      after: z.string(),
      /** 影響の「候補」。評価（assessment）は人が確定する。 */
      possibleImpact: z.string(),
      suggestsRetest: z.boolean(),
    }),
  ),
  ...base,
});
export type AssuranceChangeSummaryOutput = z.infer<typeof assuranceChangeSummarySchema>;

// 9. insightDiscovery — ユーザーが気づいていない・到達できない洞察の発見
export const insightDiscoverySchema = z.object({
  insights: z.array(
    z.object({
      title: z.string(),
      /** なぜそう言えるのか（根拠となる数値・事実） */
      finding: z.string(),
      /** 放置するとどうなるか・何を意味するか */
      implication: z.string(),
      /** 人が取るべき次の一手（AI は実行しない） */
      recommendedAction: z.string(),
      category: z.enum([
        'data_quality',
        'deadline_risk',
        'disclosure_gap',
        'trend_anomaly',
        'assurance_readiness',
        'efficiency',
      ]),
      impact: z.enum(['high', 'medium', 'low']),
      /** アプリ内の確認先（相対パス）。無ければ null */
      link: z.string().nullable(),
    }),
  ),
  ...base,
});
export type InsightDiscoveryOutput = z.infer<typeof insightDiscoverySchema>;

// 10. copilotChat — 権限内情報に限定した対話支援
export const copilotChatSchema = z.object({
  /** 回答本文。数値には必ず根拠（どの集計か）を添える */
  answer: z.string(),
  /** 回答の根拠となった画面への参照（アプリ内パスのみ） */
  references: z.array(z.object({ label: z.string(), link: z.string().nullable() })),
  /** 続けて聞くと有用な質問の候補 */
  suggestedQuestions: z.array(z.string()),
  ...base,
});
export type CopilotChatOutput = z.infer<typeof copilotChatSchema>;

export const AI_SCHEMAS = {
  importMapping: importMappingSchema,
  anomalyExplanation: anomalyExplanationSchema,
  cdpQuestionMapping: cdpQuestionMappingSchema,
  cdpDraftGeneration: cdpDraftGenerationSchema,
  ssbjGapAnalysis: ssbjGapAnalysisSchema,
  evidenceMapping: evidenceMappingSchema,
  inconsistencyCheck: inconsistencyCheckSchema,
  insightDiscovery: insightDiscoverySchema,
  copilotChat: copilotChatSchema,
  assuranceEvidenceSummary: assuranceEvidenceSummarySchema,
  assuranceChangeSummary: assuranceChangeSummarySchema,
} as const;

export type AiFeature = keyof typeof AI_SCHEMAS;
export type AiOutputOf<F extends AiFeature> = z.infer<(typeof AI_SCHEMAS)[F]>;

/** Prompt の版管理（AI 出力の再現性・監査証跡のため必ず記録する）。 */
export const PROMPT_VERSIONS: Record<AiFeature, string> = {
  importMapping: 'import-mapping@2026-08-14.1',
  anomalyExplanation: 'anomaly-explanation@2026-08-14.1',
  cdpQuestionMapping: 'cdp-question-mapping@2026-08-14.1',
  cdpDraftGeneration: 'cdp-draft-generation@2026-08-14.1',
  ssbjGapAnalysis: 'ssbj-gap-analysis@2026-08-26.1',
  evidenceMapping: 'evidence-mapping@2026-08-14.1',
  inconsistencyCheck: 'inconsistency-check@2026-08-17.1',
  insightDiscovery: 'insight-discovery@2026-08-17.1',
  copilotChat: 'copilot-chat@2026-08-18.1',
  assuranceEvidenceSummary: 'assurance-evidence-summary@2026-08-14.1',
  assuranceChangeSummary: 'assurance-change-summary@2026-08-14.1',
};
