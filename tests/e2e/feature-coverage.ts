/**
 * 機能（Server Action）→ その機能を通す E2E の対応表（docs/ui-redesign/plan.md §5.1-1・IF §7.4）。
 *
 * 初期値は docs/ui-redesign/inventory-features.md §3 の E2E 列（棚卸し 2026-10-07）。
 * tests/unit/feature-coverage.test.ts が (a) §3 の全機能が表にあること、(b) 参照先の spec が実在すること、
 * (c) Action の名前が実在することを検査する。操作を L2 へ移して spec を直したら、ここも合わせて直す。
 * NO_E2E_YET は棚卸しの時点で E2E が無かった機能（再設計で壊しても E2E では気づけない。Stage C が足す）。
 */

export const NO_E2E_YET = 'NO_E2E_YET' as const;

export interface FeatureCoverage {
  /** 機能の名前（業務の言葉） */
  name: string;
  /** Server Action の名前（null は Action を持たない機能） */
  action: string | null;
  /** その機能を通す spec（リポジトリからの相対パス） */
  specs: readonly string[] | typeof NO_E2E_YET;
}

export const FEATURE_COVERAGE: Record<string, FeatureCoverage> = {
  F001: {
    name: 'デモ利用者でログイン',
    action: 'demoLoginAction',
    specs: ['tests/e2e/helpers.ts'],
  },
  F002: {
    name: 'メールでログイン',
    action: 'supabaseLoginAction',
    specs: ['tests/e2e-supabase/auth-security.spec.ts', 'tests/e2e-supabase/supabase-mode.spec.ts'],
  },
  F003: {
    name: 'ログアウト',
    action: 'logoutAction',
    specs: ['tests/e2e/interaction-audit.spec.ts', 'tests/e2e-supabase/auth-security.spec.ts'],
  },
  F004: {
    name: 'ワークスペース切替',
    action: 'selectWorkspaceAction',
    specs: ['tests/e2e/helpers.ts', 'tests/e2e/screen-audit.spec.ts'],
  },
  F005: {
    name: '招待を受諾して参加',
    action: 'acceptInvitationAction',
    specs: ['tests/e2e/auth-copilot.spec.ts', 'tests/e2e-supabase/auth-security.spec.ts'],
  },
  F006: {
    name: '役割切替（デモ）',
    action: 'switchDemoRoleAction',
    specs: [
      'tests/e2e/disclosure-first-nav.spec.ts',
      'tests/e2e/vertical-slices.spec.ts',
      'tests/e2e/zz-disclosure-project.spec.ts',
    ],
  },
  F007: {
    name: '報告期間の切替',
    action: 'selectPeriodAction',
    specs: ['tests/e2e/reporting-period.spec.ts', 'tests/e2e/interaction-audit.spec.ts'],
  },
  F008: { name: '通知を既読にする', action: null, specs: ['tests/e2e/notifications.spec.ts'] },
  F009: { name: '通知をすべて既読', action: null, specs: ['tests/e2e/notifications.spec.ts'] },
  F010: {
    name: 'コメント（@メンション）',
    action: 'addCommentAction',
    specs: [
      'tests/e2e/crud-persistence.spec.ts',
      'tests/e2e/mentions-evidence.spec.ts',
      'tests/e2e-supabase/write-paths.spec.ts',
    ],
  },
  F011: {
    name: 'ファイル取込（事前加工なし・異種形式）',
    action: 'uploadFilesAction',
    specs: [
      'tests/e2e/business-flow-audit.spec.ts',
      'tests/e2e/hetero-import.spec.ts',
      'tests/e2e/zz-bulk-50-import.spec.ts',
      'tests/e2e-supabase/bulk-import.spec.ts',
    ],
  },
  F012: {
    name: '貼り付け取込',
    action: 'pasteImportAction',
    specs: ['tests/e2e/data-entry-aggregation.spec.ts'],
  },
  F013: {
    name: '取込プレビューの行確定',
    action: 'confirmImportAction',
    specs: ['tests/e2e/vertical-slices.spec.ts', 'tests/e2e/zz-bulk-50-import.spec.ts'],
  },
  F014: {
    name: '標準CSV の検証',
    action: 'validateStandardImportAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F015: {
    name: '標準CSV の登録確定（訂正行は変更理由付き）',
    action: 'commitStandardImportAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F016: {
    name: '前年度から複製',
    action: 'carryForwardAction',
    specs: ['tests/e2e/data-entry-aggregation.spec.ts', 'tests/e2e/flash-and-clearing.spec.ts'],
  },
  F017: {
    name: '状態遷移（提出・レビュー開始・差戻し・承認）',
    action: 'transitionDataPointAction',
    specs: [
      'tests/e2e/vertical-slices.spec.ts',
      'tests/e2e/business-flow-audit.spec.ts',
      'tests/e2e/ssbj-gap.spec.ts',
    ],
  },
  F018: {
    name: '承認ルートの段階承認',
    action: 'decideApprovalStepAction',
    specs: [
      'tests/e2e/business-flow-audit.spec.ts',
      'tests/e2e/ssbj-settings-approval-draft.spec.ts',
      'tests/e2e/zz-disclosure-project.spec.ts',
    ],
  },
  F019: {
    name: '一括操作（一括提出／レビューへ／差戻し／一括承認）',
    action: 'bulkTransitionAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F020: {
    name: '値の修正（履歴付き）',
    action: 'updateDataPointAction',
    specs: [
      'tests/e2e/action-audit.spec.ts',
      'tests/e2e/crud-persistence.spec.ts',
      'tests/e2e/edge-cases-audit.spec.ts',
      'tests/e2e-supabase/write-paths.spec.ts',
    ],
  },
  F021: {
    name: 'Evidence の紐付け',
    action: 'linkEvidenceAction',
    specs: ['tests/e2e/action-audit.spec.ts', 'tests/e2e/evidence-link.spec.ts'],
  },
  F022: {
    name: 'AI に異常の原因を説明させる（候補）',
    action: 'explainAnomaliesAction',
    specs: ['tests/e2e/ai-use-cases.spec.ts'],
  },
  F023: {
    name: 'AI に Evidence 候補を探させる',
    action: 'suggestEvidenceAction',
    specs: ['tests/e2e/ai-use-cases.spec.ts'],
  },
  F024: {
    name: '資料の登録（証跡／定性情報の資料 `?purpose=qualitative`）',
    action: 'uploadEvidenceDocumentFormAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F025: {
    name: '抜粋の手入力（抽出できない資料）',
    action: 'addManualExcerptFormAction',
    specs: NO_E2E_YET,
  },
  F026: {
    name: 'サプライヤーデータの解析',
    action: 'previewSupplierImportAction',
    specs: ['tests/e2e/ghg-suppliers.spec.ts', 'tests/e2e/zz-murata-demo.spec.ts'],
  },
  F027: {
    name: 'サプライヤーデータの確定（原単位の選択含む）',
    action: 'confirmSupplierImportAction',
    specs: ['tests/e2e/ghg-suppliers.spec.ts', 'tests/e2e/zz-murata-demo.spec.ts'],
  },
  F028: {
    name: '取込済み算定版のリセット（デモ）',
    action: 'resetSupplierDemoAction',
    specs: ['tests/e2e/zz-murata-demo.spec.ts'],
  },
  F029: {
    name: '排出原単位の変更',
    action: 'relinkSupplierFactorAction',
    specs: ['tests/e2e/ghg-suppliers.spec.ts', 'tests/e2e/zz-murata-demo.spec.ts'],
  },
  F030: {
    name: '分析条件・連結範囲の保存',
    action: 'saveSsbjSettingsAction',
    specs: ['tests/e2e/new-features-audit.spec.ts'],
  },
  F031: {
    name: '有価証券報告書の範囲を反映',
    action: 'applySecuritiesReportAction',
    specs: ['tests/e2e/new-features-audit.spec.ts'],
  },
  F032: {
    name: '設定の確定',
    action: 'confirmSsbjSettingsAction',
    specs: [
      'tests/e2e/new-features-audit.spec.ts',
      'tests/e2e/ssbj-settings-approval-draft.spec.ts',
    ],
  },
  F033: {
    name: 'マテリアリティの追加',
    action: 'addMaterialityTopicAction',
    specs: [
      'tests/e2e/crud-persistence.spec.ts',
      'tests/e2e/six-features.spec.ts',
      'tests/e2e/ui-affordances.spec.ts',
    ],
  },
  F034: {
    name: 'マテリアリティの編集',
    action: 'updateMaterialityTopicAction',
    specs: ['tests/e2e/crud-persistence.spec.ts'],
  },
  F035: {
    name: 'マテリアリティの削除（2 段階確認）',
    action: 'deleteMaterialityTopicAction',
    specs: ['tests/e2e/crud-persistence.spec.ts'],
  },
  F036: {
    name: 'リスク・機会の保存',
    action: 'saveMaterialityRiskOppAction',
    specs: ['tests/e2e/crud-persistence.spec.ts'],
  },
  F037: {
    name: '重要度の評価',
    action: 'assessMaterialityTopicAction',
    specs: ['tests/e2e/crud-persistence.spec.ts', 'tests/e2e/six-features.spec.ts'],
  },
  F038: {
    name: '要求事項の適用判定',
    action: 'saveSsbjScopeAction',
    specs: ['tests/e2e/ssbj-gap.spec.ts'],
  },
  F039: {
    name: 'AI ギャップ分析（1 件・候補）',
    action: 'runSsbjGapAnalysisAction',
    specs: ['tests/e2e/ssbj-gap.spec.ts'],
  },
  F040: {
    name: 'AI ギャップ分析（未分析を最大 20 件）',
    action: 'runSsbjGapAnalysisBulkAction',
    specs: ['tests/e2e/ssbj-gap.spec.ts'],
  },
  F041: {
    name: '担当者の最終判定',
    action: 'saveSsbjReviewAction',
    specs: ['tests/e2e/ssbj-gap.spec.ts'],
  },
  F042: {
    name: '対応計画の作成',
    action: 'createSsbjActionPlanAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F043: {
    name: '対応計画の更新（担当・期限・状態）',
    action: 'updateSsbjActionPlanAction',
    specs: ['tests/e2e/ssbj-gap.spec.ts'],
  },
  F044: {
    name: 'データ収集項目の作成（計画から指標・収集を起こす）',
    action: 'createSsbjDataCollectionAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F045: {
    name: 'AI に草案を作らせる（候補）',
    action: 'generateSsbjDraftAction',
    specs: [
      'tests/e2e/new-features-audit.spec.ts',
      'tests/e2e/ssbj-settings-approval-draft.spec.ts',
      'tests/e2e/crud-persistence.spec.ts',
    ],
  },
  F046: {
    name: 'ドラフト本文の保存',
    action: 'saveSsbjDraftAction',
    specs: [
      'tests/e2e/new-features-audit.spec.ts',
      'tests/e2e/ssbj-settings-approval-draft.spec.ts',
    ],
  },
  F047: {
    name: 'ドラフトの確定',
    action: 'confirmSsbjDraftAction',
    specs: [
      'tests/e2e/new-features-audit.spec.ts',
      'tests/e2e/ssbj-settings-approval-draft.spec.ts',
    ],
  },
  F048: {
    name: '前年度評価の引継ぎ',
    action: 'carryOverSsbjAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F049: {
    name: '報告範囲の保存',
    action: 'saveCsrdBoundaryAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F050: {
    name: 'DMA 評価方法の保存',
    action: 'saveCsrdMethodAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F051: {
    name: 'DMA の確定',
    action: 'confirmCsrdDmaAction',
    specs: ['tests/e2e/csrd.spec.ts', 'tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F052: {
    name: 'IRO の追加・更新',
    action: 'upsertCsrdDmaIroAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  // crud-persistence が消すのは SSBJ のマテリアリティ（F035）で、CSRD の IRO ではない（handoff B3）
  F053: {
    name: 'IRO の削除',
    action: 'deleteCsrdDmaIroAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F054: {
    name: '事項の重要性判断',
    action: 'decideCsrdDmaMatterAction',
    specs: ['tests/e2e/csrd-screens.spec.ts', 'tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F055: { name: '担当者の入力として確定', action: 'saveCsrdAssessmentAction', specs: NO_E2E_YET },
  F056: {
    name: 'AI ギャップ分析（候補）',
    action: 'runCsrdGapAnalysisAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F057: {
    name: '候補を採用',
    action: 'reviewCsrdAssessmentAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F058: { name: '候補を修正して確定', action: 'reviewCsrdAssessmentFormAction', specs: NO_E2E_YET },
  F059: {
    name: '対応計画の作成',
    action: 'createCsrdActionPlanAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F060: { name: '対応計画の更新', action: 'updateCsrdActionPlanAction', specs: NO_E2E_YET },
  F061: {
    name: '収集項目の作成',
    action: 'createCsrdCollectionItemAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F062: {
    name: 'AI 草案を作成（候補）',
    action: 'generateCsrdDraftAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts', 'tests/e2e/csrd-screens.spec.ts'],
  },
  F063: {
    name: '草案を本文に採用',
    action: 'adoptCsrdDraftAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F064: {
    name: '本文の保存',
    action: 'saveCsrdDraftBodyAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts', 'tests/e2e/csrd-screens.spec.ts'],
  },
  F065: {
    name: '保存済み本文で確定',
    action: 'confirmCsrdDraftAction',
    specs: ['tests/e2e/zzz-csrd-chain.spec.ts'],
  },
  F066: {
    name: '適用判定を実行',
    action: 'evaluateApplicabilityAction',
    specs: ['tests/e2e/disclosure-check.spec.ts'],
  },
  F067: {
    name: '質問マッピング（AI 候補）',
    action: 'runQuestionMappingAction',
    specs: ['tests/e2e/ai-use-cases.spec.ts'],
  },
  F068: {
    name: '整合チェック（AI）',
    action: 'runConsistencyCheckAction',
    specs: ['tests/e2e/csrd.spec.ts', 'tests/e2e/disclosure-check.spec.ts'],
  },
  F069: {
    name: '過去回答ファイルの解析',
    action: 'previewDisclosureImportAction',
    specs: ['tests/e2e/disclosure-import.spec.ts'],
  },
  F070: {
    name: '過去回答の取込確定',
    action: 'confirmDisclosureImportAction',
    specs: ['tests/e2e/disclosure-import.spec.ts'],
  },
  F071: {
    name: 'AI ドラフトを生成（候補）',
    action: 'generateCdpDraftAction',
    specs: [
      'tests/e2e/action-audit.spec.ts',
      'tests/e2e/csrd.spec.ts',
      'tests/e2e/vertical-slices.spec.ts',
    ],
  },
  F072: {
    name: 'AI 下書きを不採用',
    action: 'rejectAiDraftAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F073: {
    name: '回答の保存（下書き）',
    action: 'saveCdpResponseAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F074: {
    name: '回答のレビュー依頼・差戻し・承認',
    action: 'transitionCdpResponseAction',
    specs: ['tests/e2e/vertical-slices.spec.ts', 'tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F075: {
    name: '定性情報の新規登録（手入力）',
    action: 'createNarrativeAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F076: {
    name: '定性情報の版として保存',
    action: 'saveNarrativeAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F077: {
    name: '内容を確認済みにする（人の確認）',
    action: 'confirmNarrativeAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F078: {
    name: '根拠資料の断片を読み込む',
    action: 'loadFragmentsAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F079: {
    name: '資料の箇所を根拠として引用',
    action: 'createAnchorAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F080: { name: '前年から引継ぎ', action: 'carryForwardNarrativeAction', specs: NO_E2E_YET },
  F081: {
    name: '資料から候補（下書き）を作成',
    action: 'createNarrativeCandidateAction',
    specs: NO_E2E_YET,
  },
  F082: {
    name: 'プロジェクトの作成（3 段階）',
    action: 'createProjectAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F083: { name: 'プロジェクト設定の変更', action: 'updateProjectAction', specs: NO_E2E_YET },
  F084: {
    name: '基準ごとの適用条件と準備区分',
    action: 'saveProjectFrameworkFormAction',
    specs: NO_E2E_YET,
  },
  F085: { name: '適用判断の確定', action: 'confirmApplicabilityFormAction', specs: NO_E2E_YET },
  F086: { name: '基準の新しい版を追加', action: 'attachFrameworkVersionAction', specs: NO_E2E_YET },
  F087: {
    name: '節（原稿）の追加',
    action: 'createBlockFormAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F088: {
    name: '本文の自動保存',
    action: 'autosaveBlockAction',
    specs: ['tests/e2e/editor-draft-restore.stateless.ts'],
  },
  F089: {
    name: '版として保存',
    action: 'saveBlockVersionAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F090: {
    name: 'レビュー依頼（本文ごと提出）',
    action: 'requestReviewWithBodyAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts', 'tests/e2e/disclosure-first-nav.spec.ts'],
  },
  F091: {
    name: 'AI 下書き候補の生成',
    action: 'generateBlockDraftAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F092: {
    name: 'AI 候補の段落を採用',
    action: 'adoptDraftAction',
    specs: [
      'tests/e2e/zz-disclosure-project.spec.ts',
      'tests/e2e/editor-draft-restore.stateless.ts',
    ],
  },
  F093: {
    name: '候補の確認を終える／破棄',
    action: 'closeDraftRunAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F094: {
    name: 'レビューコメント',
    action: 'addReviewCommentAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F095: {
    name: 'コメントを解決済みにする',
    action: 'resolveReviewCommentAction',
    specs: NO_E2E_YET,
  },
  F096: {
    name: '差し戻す',
    action: 'returnReviewFormAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts', 'tests/e2e/new-features-audit.spec.ts'],
  },
  F097: { name: '依頼を取り下げる', action: 'withdrawReviewFormAction', specs: NO_E2E_YET },
  F098: {
    name: 'レビューを完了する',
    action: 'completeReviewAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F099: {
    name: '最終承認（社内承認）',
    action: 'finalApproveAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F100: {
    name: '引用先の再確認の判断',
    action: 'decideRecheckFormAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F101: {
    name: 'レビュー用草稿のスナップショット',
    action: 'createReviewDraftSnapshotAction',
    specs: NO_E2E_YET,
  },
  F102: {
    name: 'レポートを確定（承認済み版）',
    action: 'confirmReportAction',
    specs: ['tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F103: {
    name: '開示デモを初期状態に戻す',
    action: 'resetDisclosureDemoAction',
    specs: [
      'tests/e2e/zz-disclosure-project.spec.ts',
      'tests/e2e/editor-draft-restore.stateless.ts',
    ],
  },
  F104: {
    name: 'KPI 目標の登録・改訂',
    action: 'registerKpiTargetAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F105: {
    name: 'Copilot に質問',
    action: 'askCopilotAction',
    specs: [
      'tests/e2e/auth-copilot.spec.ts',
      'tests/e2e/insights.spec.ts',
      'tests/e2e/edge-cases-audit.spec.ts',
    ],
  },
  F106: {
    name: 'インサイトを発見',
    action: 'runInsightDiscoveryAction',
    specs: ['tests/e2e/insights.spec.ts'],
  },
  F107: {
    name: '指標の追加',
    action: 'createMetricAction',
    specs: [
      'tests/e2e/master-data.spec.ts',
      'tests/e2e/metric-master.spec.ts',
      'tests/e2e/crud-persistence.spec.ts',
    ],
  },
  F108: {
    name: '指標の編集',
    action: 'updateMetricAction',
    specs: ['tests/e2e/metric-master.spec.ts', 'tests/e2e/crud-persistence.spec.ts'],
  },
  F109: {
    name: '組織・拠点の追加',
    action: 'createUnitAction',
    specs: ['tests/e2e/master-data.spec.ts'],
  },
  F110: {
    name: '組織・拠点の編集',
    action: 'updateUnitAction',
    specs: ['tests/e2e/master-data.spec.ts'],
  },
  F111: {
    name: '報告年度の追加',
    action: 'createReportingPeriodAction',
    specs: ['tests/e2e/reporting-period.spec.ts'],
  },
  F112: {
    name: '収集キャンペーンの作成',
    action: 'createCampaignAction',
    specs: ['tests/e2e/master-data.spec.ts', 'tests/e2e/reporting-period.spec.ts'],
  },
  F113: {
    name: '開示優先モードの切替',
    action: 'setDisclosureFirstAction',
    specs: ['tests/e2e/disclosure-first-nav.spec.ts', 'tests/e2e/zz-disclosure-project.spec.ts'],
  },
  F114: {
    name: '招待リンクの発行',
    action: 'createInvitationAction',
    specs: ['tests/e2e/auth-copilot.spec.ts', 'tests/e2e-supabase/auth-security.spec.ts'],
  },
  F115: {
    name: '招待の失効',
    action: 'revokeInvitationAction',
    specs: ['tests/e2e/auth-copilot.spec.ts'],
  },
  F116: {
    name: 'パスワード再設定リンクの発行',
    action: 'issueResetLinkAction',
    specs: ['tests/e2e-supabase/auth-security.spec.ts'],
  },
  F117: {
    name: '監査法人へのアクセス許諾',
    action: 'createGrantAction',
    specs: ['tests/e2e/grant-lifecycle.spec.ts'],
  },
  F118: {
    name: '許諾の取消・再付与',
    action: 'toggleGrantAction',
    specs: [
      'tests/e2e/action-audit.spec.ts',
      'tests/e2e/tenant-isolation-audit.spec.ts',
      'tests/e2e/zzzz-relocated-features.spec.ts',
    ],
  },
  F119: {
    name: 'PBC への回答',
    action: 'respondPbcAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F120: {
    name: '案件の起票',
    action: 'createEngagementAction',
    specs: ['tests/e2e/engagement-management.spec.ts'],
  },
  F121: {
    name: '案件チームの変更（追加・解除）',
    action: 'assignEngagementMemberAction',
    specs: ['tests/e2e/zzzz-relocated-features.spec.ts'],
  },
  F122: {
    name: 'Snapshot を固定',
    action: 'createSnapshotAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F123: {
    name: 'Snapshot 後変更の影響評価',
    action: 'assessSnapshotChangeAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F124: {
    name: 'AI で差分を要約（候補）',
    action: 'summarizeChangesAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F125: {
    name: 'サンプルを抽出',
    action: 'createSampleAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F126: {
    name: '手続結果の記録',
    action: 'recordTestResultAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F127: {
    name: '調書の更新・作成完了・レビュー完了',
    action: 'updateTestAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F128: {
    name: 'Evidence を AI に要約させる',
    action: 'summarizeEvidenceAction',
    specs: ['tests/e2e/ai-use-cases.spec.ts'],
  },
  F129: {
    name: 'PBC（資料依頼）の送付',
    action: 'createPbcAction',
    specs: ['tests/e2e/pbc-and-audit-trail.spec.ts', 'tests/e2e/vertical-slices.spec.ts'],
  },
  F130: {
    name: 'PBC 回答の受理・差戻し',
    action: 'decidePbcAction',
    specs: ['tests/e2e/action-audit.spec.ts', 'tests/e2e/pbc-and-audit-trail.spec.ts'],
  },
  F131: {
    name: '指摘・例外の起票',
    action: 'createIssueAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F132: {
    name: '指摘の解消',
    action: 'resolveIssueAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F133: {
    name: 'レビュー Note の追加',
    action: 'createReviewNoteAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F134: {
    name: 'レビュー Note のクリア',
    action: 'clearReviewNoteAction',
    specs: ['tests/e2e/action-audit.spec.ts'],
  },
  F135: {
    name: 'Sign-off（prepared → reviewed → partner）',
    action: 'createSignoffAction',
    specs: ['tests/e2e/vertical-slices.spec.ts'],
  },
  F136: {
    name: 'disclosure-projects/actions.ts:265 saveProjectFrameworkAction',
    action: 'saveProjectFrameworkAction',
    specs: NO_E2E_YET,
  },
  F137: {
    name: 'disclosure-projects/actions.ts:431 confirmApplicabilityAction',
    action: 'confirmApplicabilityAction',
    specs: NO_E2E_YET,
  },
  F138: {
    name: 'blocks/actions.ts:360 requestReviewAction',
    action: 'requestReviewAction',
    specs: NO_E2E_YET,
  },
  F139: {
    name: 'blocks/actions.ts:375 returnReviewAction',
    action: 'returnReviewAction',
    specs: NO_E2E_YET,
  },
  F140: {
    name: 'blocks/actions.ts:499 withdrawReviewAction',
    action: 'withdrawReviewAction',
    specs: NO_E2E_YET,
  },
  F141: {
    name: 'blocks/actions.ts:519 decideRecheckAction',
    action: 'decideRecheckAction',
    specs: NO_E2E_YET,
  },
  F142: {
    name: 'blocks/actions.ts:644 createBlockAction',
    action: 'createBlockAction',
    specs: NO_E2E_YET,
  },
  F143: {
    name: 'evidence/actions.ts:26 uploadEvidenceDocumentAction',
    action: 'uploadEvidenceDocumentAction',
    specs: NO_E2E_YET,
  },
  F144: {
    name: 'evidence/actions.ts:200 addManualExcerptAction',
    action: 'addManualExcerptAction',
    specs: NO_E2E_YET,
  },
};
