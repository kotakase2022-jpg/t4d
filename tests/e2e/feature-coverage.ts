/**
 * 機能（Server Action）→ その機能を通す E2E の対応表（docs/ui-redesign/plan.md §5.1-1・IF §7.4）。
 *
 * 初期値は docs/ui-redesign/inventory-features.md §3 の E2E 列（棚卸し 2026-10-07）。F145〜F201 はトライアル対応
 * （2026-10。§3.14）で足した機能。
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
    name: 'blocks/actions.ts:371 requestReviewAction',
    action: 'requestReviewAction',
    specs: NO_E2E_YET,
  },
  F139: {
    name: 'blocks/actions.ts:386 returnReviewAction',
    action: 'returnReviewAction',
    specs: NO_E2E_YET,
  },
  F140: {
    name: 'blocks/actions.ts:510 withdrawReviewAction',
    action: 'withdrawReviewAction',
    specs: NO_E2E_YET,
  },
  F141: {
    name: 'blocks/actions.ts:530 decideRecheckAction',
    action: 'decideRecheckAction',
    specs: NO_E2E_YET,
  },
  F142: {
    name: 'blocks/actions.ts:661 createBlockAction',
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
  // ---- トライアル対応（2026-10。inventory-features.md §3.14。F145〜F201）
  F145: {
    name: '要求事項の判断を記録（40a 等。3 観点・理由・担当・期限）',
    action: 'saveRequirementAssessmentAction',
    specs: ['tests/e2e/trial-requirements.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F146: {
    name: '対象外・非重要として申請',
    action: 'requestExclusionAction',
    specs: ['tests/e2e/trial-requirements.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F147: {
    name: '対象外・非重要の判断を承認（別の人・取り消せない）',
    action: 'approveExclusionAction',
    specs: ['tests/e2e/trial-requirements.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F148: {
    name: '対象外・非重要の申請を差し戻す（理由必須）',
    action: 'returnExclusionAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F149: {
    name: '対象外・非重要の申請を取り下げる',
    action: 'withdrawExclusionAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F150: {
    name: '横断対応の AI 候補を出させる（表示だけ）',
    action: 'suggestCrosswalkCandidatesAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F151: {
    name: '横断対応の AI 候補を採用しない（理由）',
    action: 'rejectCrosswalkCandidatesAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F152: {
    name: '節の要求事項の選択肢を読む（節の追加・開いたときだけ）',
    action: 'listBlockRequirementOptionsAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F153: {
    name: '節と要求事項の対応付けを変更（承認済みは理由必須）',
    action: 'updateBlockRequirementsFormAction',
    specs: ['tests/e2e/trial-requirements.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F154: {
    name: '節の要求事項の AI 候補を出させる',
    action: 'suggestBlockRequirementsAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F155: {
    name: '節の要求事項の AI 候補を採用（選んだ候補だけ）',
    action: 'adoptBlockRequirementCandidatesAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F156: {
    name: '節の要求事項の AI 候補を採用しない（理由）',
    action: 'rejectBlockRequirementCandidatesAction',
    specs: ['tests/e2e/trial-requirements.spec.ts'],
  },
  F157: {
    name: '承認済みレポートを保証側へ共有（写し・取り消せない）',
    action: 'shareReportAction',
    specs: ['tests/e2e/trial-assurance.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F158: {
    name: '保証側への共有を取り下げる',
    action: 'withdrawSharedReportAction',
    specs: ['tests/e2e/trial-assurance.spec.ts'],
  },
  F159: {
    name: '外部で編集したファイルを承認版と照合（保存しない）',
    action: 'reconcileUploadedFileAction',
    specs: ['tests/e2e/trial-trace-outputs.spec.ts'],
  },
  F160: {
    name: '保証側: 開示レポートの段落・数値にコメント',
    action: 'createReportNoteAction',
    specs: ['tests/e2e/trial-assurance.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F161: {
    name: '企業: 保証側のコメントへ回答（追記）',
    action: 'respondToAssuranceNoteAction',
    specs: ['tests/e2e/trial-assurance.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F162: {
    name: 'Sign-off に共有した開示レポートを結び付けて記録',
    action: 'createSignoffAction',
    specs: NO_E2E_YET,
  },
  F163: {
    name: 'トライアル計画を編集',
    action: 'saveTrialPlanAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F164: {
    name: '選定ケースを編集',
    action: 'saveTrialCasesAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F165: {
    name: '開始前の合意・終了時の扱い・導入判断を記録',
    action: 'saveTrialDecisionAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F166: {
    name: '検証シナリオの実施を記録（本人）',
    action: 'recordScenarioRunAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F167: {
    name: '評価者の判定を記録（取り消せない）',
    action: 'judgeScenarioAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F168: {
    name: 'ご意見・不具合を送る（ヘッダー・改善管理表）',
    action: 'submitFeedbackAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F169: {
    name: '定例会などの論点を記録（管理者）',
    action: 'recordMeetingFeedbackAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F170: {
    name: '改善管理表の対応を記録（状態・方針・担当・期限・費用区分）',
    action: 'triageFeedbackAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F171: {
    name: '再検証の結果を記録',
    action: 'recordReverificationAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts'],
  },
  F172: {
    name: '作業時間を記録（現行・T4D）',
    action: 'recordTaskTimingAction',
    specs: ['tests/e2e/trial-evaluation.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F173: {
    name: '承認ルートを保存（3 段階のひな形・過年度確定値）',
    action: 'saveApprovalRouteAction',
    specs: ['tests/e2e/trial-admin.spec.ts', 'tests/e2e/zzzzz-trial-chain.stateless.ts'],
  },
  F174: {
    name: 'メンバーの役割・担当拠点を変更',
    action: 'updateMembershipAction',
    specs: ['tests/e2e/trial-admin.spec.ts'],
  },
  F175: {
    name: 'メンバーの利用を停止・再開',
    action: 'setMembershipStatusAction',
    specs: ['tests/e2e/trial-admin.spec.ts'],
  },
  F176: {
    name: 'データ取扱条件の版を記録',
    action: 'recordDataTermsAction',
    specs: ['tests/e2e/trial-admin.spec.ts'],
  },
  F177: {
    name: 'XBRL の対応付けを追加・編集（候補）',
    action: 'saveXbrlMappingAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F178: {
    name: 'XBRL の対応付けを確定（作成者以外・行・一括）',
    action: 'confirmXbrlMappingsAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F179: {
    name: 'XBRL の対応付けを対象外にする（理由）',
    action: 'excludeXbrlMappingAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F180: {
    name: 'XBRL の対応付けの対象外を取り消す',
    action: 'restoreXbrlMappingAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F181: {
    name: 'XBRL の対応付けを削除',
    action: 'deleteXbrlMappingAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F182: {
    name: 'XBRL の対応付けの AI 候補を出させる（候補のまま）',
    action: 'suggestXbrlMappingsAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F183: {
    name: '基準のタクソノミ（SAMPLE）を設定',
    action: 'setXbrlTaxonomyAction',
    specs: ['tests/e2e/trial-xbrl.spec.ts'],
  },
  F184: {
    name: '提出者の識別子を保存（Supabase Mode。Demo は読み取り専用）',
    action: 'saveFilingIdentifierAction',
    specs: NO_E2E_YET,
  },
  F185: {
    name: 'CDP の回答を始める',
    action: 'startResponseAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F186: {
    name: 'CDP の回答を始めて AI 草案を作る',
    action: 'startResponseDraftAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F187: {
    name: 'CDP の回答の担当・レビュー担当を割り当てる',
    action: 'assignResponseAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F188: {
    name: 'CDP の質問の担当を一括で割り当てる',
    action: 'bulkAssignResponsesAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F189: {
    name: 'CDP の AI の対応付けの候補を確定',
    action: 'confirmMappingCandidateAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F190: {
    name: 'CDP の回答に T4D の情報（定性情報・原稿・要求事項・指標）を対応付ける',
    action: 'addResponseLinkAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F191: {
    name: 'CDP の回答の指標の対応付けを外す',
    action: 'removeMetricMappingAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F192: {
    name: 'CDP の回答と T4D の情報の対応付けを外す',
    action: 'removeResponseLinkAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F193: {
    name: 'CDP の回答に根拠を紐付ける（再利用）',
    action: 'linkResponseEvidenceAction',
    specs: ['tests/e2e/trial-cdp-option.spec.ts'],
  },
  F194: {
    name: 'CSRD 節ドラフトの確定本文を開示プロジェクトの原稿へ取り込む',
    action: 'importCsrdDraftToProjectAction',
    specs: NO_E2E_YET,
  },
  F195: {
    name: 'SSBJ 開示ドラフトの確定本文を開示プロジェクトの原稿へ取り込む',
    action: 'importSsbjDraftToProjectAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
  F196: {
    name: 'SSBJ の基準の版をこの年度に固定し直す（設定の確定を外す）',
    action: 'pinSsbjVersionAction',
    specs: NO_E2E_YET,
  },
  F197: {
    name: '定性情報と要求事項を直接対応付ける',
    action: 'addNarrativeLinkAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
  F198: {
    name: '定性情報と要求事項の直接の対応付けを外す（元に戻す）',
    action: 'removeNarrativeLinkAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
  F199: {
    name: '定性情報の要求事項の AI 候補を出させる',
    action: 'suggestNarrativeLinksAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
  F200: {
    name: '定性情報の要求事項の AI 候補を採用',
    action: 'adoptNarrativeLinksAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
  F201: {
    name: '定性情報の要求事項の AI 候補を採用しない（理由）',
    action: 'rejectNarrativeLinksAction',
    specs: ['tests/e2e/trial-content-impact.spec.ts'],
  },
};
