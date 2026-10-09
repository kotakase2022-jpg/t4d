import { z } from 'zod';
import { CSRD_SECTIONS, DMA_PERSPECTIVES, XBRL_PERIOD_ROLES } from '@/types/domain';

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
    // 開示本文の下書き（disclosureBlockDraft）が引用する版・位置
    'narrative_version',
    'source_anchor',
    'metric_version',
    'prior_block',
    'requirement',
    // CSRD のギャップ分析・草案が根拠にした DMA の事項・IRO（docs/disclosure-first.md §9.4）
    'dma_matter',
    'dma_iro',
    // トライアル対応（2026-10）: XBRL のタグの候補が根拠にした概念（SAMPLE の架空の概念）
    'xbrl_concept',
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

// 4.6 ssbjDisclosureDraft — SSBJ 開示ドラフトの草案生成
//
// 要求事項ごとの短い回答ではなく、開示書類に載せる節（ガバナンス・戦略・
// リスク管理・指標及び目標）単位の文章を書かせる。SSBJ の開示は
// 項目を並べた表ではなく地の文で書くため、節ごとに一貫した文章が要る。
//
// 生成されるのは**草案**であり、そのまま開示にはしない。
// 人が読んで直し、確定する（CLAUDE.md §0.4）。
export const ssbjDisclosureDraftSchema = z.object({
  /** 節（governance / strategy / risk / metrics） */
  area: z.enum(['governance', 'strategy', 'risk', 'metrics', 'other']),
  /** 開示書類に載せる文章の草案 */
  body: z.string(),
  /** 草案が根拠にした要求事項のコード */
  coveredItemCodes: z.array(z.string()),
  /**
   * 書けなかった箇所。データが無い・判定が未確認などで、
   * 人が埋めないと開示にできない部分を明示する
   */
  gaps: z.array(
    z.object({
      itemCode: z.string(),
      reason: z.string(),
    }),
  ),
  ...base,
});
export type SsbjDisclosureDraftOutput = z.infer<typeof ssbjDisclosureDraftSchema>;

// 4.7 csrdGapAnalysis — CSRD（ESRS サンプル）要求事項のギャップ分析（docs/disclosure-first.md §9.4）
//
// 形は ssbjGapAnalysis と同じ（3 観点・コメント・不足情報・推奨・資料位置）。
// 書く先は csrd_assessments.ai_* だけで、人が「候補を採用」「修正して確定」するまで確定値にならない。
// 入力は許可された要求事項・承認済みの値・DMA の結果だけ（Secret・権限外の資料を含めない）。
export const csrdGapAnalysisSchema = ssbjGapAnalysisSchema.extend({});
export type CsrdGapAnalysisOutput = z.infer<typeof csrdGapAnalysisSchema>;

// 4.8 csrdDisclosureDraft — CSRD 開示ドラフトの節の草案（docs/disclosure-first.md §9.4）
//
// どの観点（インパクト／財務）で重要と判断した節かを perspectives で返し、本文にも明示させる。
// 書く先は csrd_disclosure_drafts.ai_body 等だけ。本文への採用・確定は人が行う（CLAUDE.md §0.4）。
export const csrdDisclosureDraftSchema = z.object({
  section: z.enum(CSRD_SECTIONS),
  perspectives: z.array(z.enum(DMA_PERSPECTIVES)),
  /** 開示書類に載せる文章の草案（候補） */
  body: z.string(),
  /** 草案が根拠にした要求事項のコード */
  coveredItemCodes: z.array(z.string()),
  /** 書けなかった箇所（人が埋めないと開示にできない部分） */
  gaps: z.array(
    z.object({
      itemCode: z.string(),
      reason: z.string(),
    }),
  ),
  ...base,
});
export type CsrdDisclosureDraftOutput = z.infer<typeof csrdDisclosureDraftSchema>;

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

// 11. disclosureBlockDraft — 開示本文（節）の下書き候補（docs/disclosure-first.md §2-3、指示書 §9）
//
// 操作は 3 つに絞る（選択した根拠から下書き／前年からの変更案／文章を整える）。
// 返すのは段落ごとの「候補」と、その段落が根拠にした入力の ID だけ。
// サーバーは sourceRefs を入力の許可リストと突き合わせ、入力に無い ID を引いた段落は
// 採用させずに不足情報へ回す（disclosure-ai-draft.ts の validateDraftOutput）。
// 実行 ID・モデル・開始終了などの生成メタデータはモデルに書かせず、ai_runs の行から組み立てる。
export const DISCLOSURE_DRAFT_OPERATIONS = [
  'draft_from_sources',
  'update_from_prior_year',
  'polish',
] as const;
export type DisclosureDraftOperation = (typeof DISCLOSURE_DRAFT_OPERATIONS)[number];

export const DISCLOSURE_DRAFT_SOURCE_KINDS = [
  'narrative_version',
  'source_anchor',
  'metric_version',
  'prior_block',
  'requirement',
  'block_paragraph',
] as const;
export type DisclosureDraftSourceKind = (typeof DISCLOSURE_DRAFT_SOURCE_KINDS)[number];

export const disclosureDraftSourceRefSchema = z.object({
  kind: z.enum(DISCLOSURE_DRAFT_SOURCE_KINDS),
  id: z.string(),
  /** 資料内の位置・段落 ID など。表示用（検証は kind と id で行う） */
  locator: z.string().nullable(),
});
export type DisclosureDraftSourceRef = z.infer<typeof disclosureDraftSourceRefSchema>;

export const disclosureBlockDraftSchema = z.object({
  operation: z.enum(DISCLOSURE_DRAFT_OPERATIONS),
  /** 段落ごとの本文候補。既存段落の置き換え候補なら paragraphId に段落 ID、新しい段落は null */
  draftBlocks: z.array(
    z.object({
      paragraphId: z.string().nullable(),
      kind: z.enum(['paragraph', 'heading']),
      text: z.string(),
      sourceRefs: z.array(disclosureDraftSourceRefSchema),
    }),
  ),
  /** 書けない内容・足りない情報・次に確認する対象（事実らしい文章で埋めない） */
  missingInformation: z.array(
    z.object({
      item: z.string(),
      reason: z.string(),
      nextCheck: z.string().nullable(),
    }),
  ),
  /** 相反する根拠。人が判断するまで本文へ書かない */
  conflicts: z.array(
    z.object({
      subject: z.string(),
      detail: z.string(),
      sourceRefs: z.array(disclosureDraftSourceRefSchema),
    }),
  ),
  /** 対象にした要求事項と基準の版 */
  usedRequirementVersions: z.array(
    z.object({
      requirementId: z.string(),
      code: z.string(),
      frameworkVersionId: z.string(),
    }),
  ),
  ...base,
});
export type DisclosureBlockDraftOutput = z.infer<typeof disclosureBlockDraftSchema>;

// 4.9 requirementMappingSuggestion — 要求事項の対応付けの候補（トライアル対応 NF-11）
//
// 定性情報の版・原稿の節・SSBJ の要求事項に対して、対応しうる要求事項（権限内・同じ組織の基準の版）の候補を返す。
// 結果は ai_runs にだけ残す。採用は人の操作（節の対応付け・定性情報の直接対応）で行い、横断対応のマスターには書かない。
// itemId は入力の候補一覧にある ID だけ（入力に無い ID を作らない。サービスが入力の一覧と照らして落とす）
export const REQUIREMENT_MAPPING_TARGET_KINDS = [
  'narrative_version',
  'disclosure_block',
  'requirement_item',
] as const;
export type RequirementMappingTargetKind = (typeof REQUIREMENT_MAPPING_TARGET_KINDS)[number];

export const requirementMappingSuggestionSchema = z.object({
  targetKind: z.enum(REQUIREMENT_MAPPING_TARGET_KINDS),
  candidates: z.array(
    z.object({
      itemId: z.string(),
      itemCode: z.string(),
      /** 横断の対応（要求事項どうし）のときの関係。節・定性情報への対応付けでは null */
      relation: z.enum(['equivalent', 'partial', 'related']).nullable(),
      rationale: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  ...base,
});
export type RequirementMappingSuggestionOutput = z.infer<typeof requirementMappingSuggestionSchema>;

// 4.10 xbrlTagSuggestion — XBRL の概念の対応付けの候補（トライアル対応 NF-44 の P1）
//
// 指標・節に対して、SAMPLE（架空）タクソノミの概念の候補を返す。候補は xbrl_tag_mappings に candidate として
// 入り、確定は承認権限者が人の操作で行う（AI は確定しない）。概念は入力の concepts にある local_name だけ
export const xbrlTagSuggestionSchema = z.object({
  candidates: z.array(
    z.object({
      targetKind: z.enum(['metric', 'block']),
      /** 指標の ID か、節の基準の版の ID と節のキー（"<frameworkVersionId>:<sectionKey>"） */
      targetRef: z.string(),
      conceptLocalName: z.string(),
      periodRole: z.enum(XBRL_PERIOD_ROLES),
      rationale: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  ...base,
});
export type XbrlTagSuggestionOutput = z.infer<typeof xbrlTagSuggestionSchema>;

export const AI_SCHEMAS = {
  importMapping: importMappingSchema,
  anomalyExplanation: anomalyExplanationSchema,
  cdpQuestionMapping: cdpQuestionMappingSchema,
  cdpDraftGeneration: cdpDraftGenerationSchema,
  ssbjGapAnalysis: ssbjGapAnalysisSchema,
  ssbjDisclosureDraft: ssbjDisclosureDraftSchema,
  csrdGapAnalysis: csrdGapAnalysisSchema,
  csrdDisclosureDraft: csrdDisclosureDraftSchema,
  evidenceMapping: evidenceMappingSchema,
  inconsistencyCheck: inconsistencyCheckSchema,
  insightDiscovery: insightDiscoverySchema,
  copilotChat: copilotChatSchema,
  assuranceEvidenceSummary: assuranceEvidenceSummarySchema,
  assuranceChangeSummary: assuranceChangeSummarySchema,
  disclosureBlockDraft: disclosureBlockDraftSchema,
  requirementMappingSuggestion: requirementMappingSuggestionSchema,
  xbrlTagSuggestion: xbrlTagSuggestionSchema,
} as const;

export type AiFeature = keyof typeof AI_SCHEMAS;
export type AiOutputOf<F extends AiFeature> = z.infer<(typeof AI_SCHEMAS)[F]>;

/** Prompt の版管理（AI 出力の再現性・監査証跡のため必ず記録する）。 */
export const PROMPT_VERSIONS: Record<AiFeature, string> = {
  importMapping: 'import-mapping@2026-08-14.1',
  anomalyExplanation: 'anomaly-explanation@2026-08-14.1',
  cdpQuestionMapping: 'cdp-question-mapping@2026-08-14.1',
  // 2026-10-09: 確認済みの定性情報・承認済みの原稿の版・根拠の引用位置を入力に足す（トライアル対応 NF-41）
  cdpDraftGeneration: 'cdp-draft-generation@2026-10-09.1',
  ssbjGapAnalysis: 'ssbj-gap-analysis@2026-08-26.1',
  ssbjDisclosureDraft: 'ssbj-disclosure-draft@2026-08-27.1',
  csrdGapAnalysis: 'csrd-gap-analysis@2026-10-01.2',
  // 2026-10-09: ESRS2（SBM-3）の節に重要と判断した事項の IRO を入力・出典として渡す（トライアル対応 NF-10 の P1）
  csrdDisclosureDraft: 'csrd-disclosure-draft@2026-10-09.1',
  evidenceMapping: 'evidence-mapping@2026-08-14.1',
  inconsistencyCheck: 'inconsistency-check@2026-08-17.1',
  insightDiscovery: 'insight-discovery@2026-08-17.1',
  copilotChat: 'copilot-chat@2026-08-18.1',
  assuranceEvidenceSummary: 'assurance-evidence-summary@2026-08-14.1',
  assuranceChangeSummary: 'assurance-change-summary@2026-08-14.1',
  disclosureBlockDraft: 'disclosure-block-draft@2026-09-29.1',
  requirementMappingSuggestion: 'requirement-mapping-suggestion@2026-10-09.1',
  xbrlTagSuggestion: 'xbrl-tag-suggestion@2026-10-09.1',
};
