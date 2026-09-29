# 開示優先モード（disclosure_first）設計・W0 記録

顧客候補向けの要望（指示書「T4D 開示業務拡張 Codex実装指示書 v1.0」2026-09-29）に基づく拡張の設計と、
W0（既存棚卸し）の記録。**本書の対象は D0（選考デモ：架空データで一連の操作がつながる）**であり、
P1（実データ永続化・本番認可・AI 実接続の検証済み状態）は完了条件に含めない。

- 実装した範囲・未実装の範囲・検証結果は末尾「実施結果」に書く（実行していない検証を完了と書かない）。
- すべて架空企業・架空資料。実在の顧客候補の実績・組織・監督体制として見せない。

---

## 1. W0 棚卸し（2026-09-29、ソースコードで確認）

### 1.1 指示書の記述とコードの差異（指示書側の訂正）

| 指示書の記述                                   | コードで確認した事実                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.3「ホームの優先度『高』8件」                | ホーム（/enterprise/dashboard）には優先度の件数は無い。8 件は SSBJ 対応状況（/enterprise/disclosures/ssbj）の表示で、上位 8 件に切り詰めた一覧（`ssbj-gap.ts` の `.slice(0, 8)`）から数えていたため 8 を超えない**不具合**。要求事項画面の 67 件は全 133 件（対象外 1 件を含む）から数えた値 |
| §2.3 相対期限は「デモ表示」の問題              | `FIXTURE_TODAY='2026-08-14'` を**Supabase モードでも**使っていた（本番でも誤る不具合）                                                                                                                                                                                                       |
| §2.3 証跡不足の承認済み（原因未確認）          | 承認時の証跡必須チェックは既にある。Fixture の証跡キーが ltifr に無く、FY2025 の承認済み 5 件が証跡なしになっていた（Fixture 生成の漏れ）                                                                                                                                                    |
| §2.2 SSBJ ドラフト「Word 出力」                | 「Word で書き出す」は要求事項ごとの回答（SSBJ には無い）を出力しており、節別ドラフト本文は一度も出力されていなかった                                                                                                                                                                         |
| §2.2 レポート「台帳/SSBJ/CSRD」                | CDP の出力カードが SSBJ カードの links 配列に誤って入れ子になり表示されていなかった。CSRD の DOCX は経路が既にあり、画面のリンクだけが無かった                                                                                                                                               |
| §6.3 既存 SSBJ 評価は 4 値                     | 5 値（未確認を含む）。開示・データ・業務プロセスの 3 観点それぞれに付く                                                                                                                                                                                                                      |
| §6.4「既存 OCR へ誘導」                        | OCR は無い（`needs_ocr` フラグのみ）。手動抜粋で代替する                                                                                                                                                                                                                                     |
| §6.9「既存の最大 5 階層機構の再利用」          | Data Point 専用（`data_point_approval_steps.data_point_id NOT NULL`）。開示本文には汎用のレビュー依頼を新設した                                                                                                                                                                              |
| §2.2 Evidence「機密区分」                      | 表示ラベルのみ（アップロード時に常に confidential、閲覧制御に未使用）                                                                                                                                                                                                                        |
| §11 MetricVersion は既存 Data Point 版で代替可 | 版は値・単位・状態・出所のみ。期間・境界・算定方法は可変の data_points 側にある                                                                                                                                                                                                              |
| §7.2「Scope3 他カテゴリの登録は新規」          | scope3_cat2〜15・scope3_total・scope2_location の指標定義は既にある。不足は状態・理由・照合・対応付け                                                                                                                                                                                        |
| （指示書に記載なし）                           | SSBJ 気候-47(3)「スコープ3 絶対総量」が scope3_cat1 に対応付けられていた                                                                                                                                                                                                                     |

制度情報（§8.1・§8.2）は一次資料で全件確認した（SSBJ 2026-03-13 改正・2026-06-11 実務対応基準第1号、
EU 理事会 2026-02-24、EFRAG ESRS-40a 公開草案 2026-07-23・意見募集 10-31、EC 委任規則 2026-07-03 採択・官報掲載まで未発効）。
補足: 40a の EU 域内売上 4.5 億ユーロ超は「直近 2 連続年度」、EU 子会社・支店 2 億ユーロ超は「前年度」の条件。
ESRS-40a 草案の重要性はインパクト重要性。

### 1.2 既存機能と再利用

| 概念（指示書 §11）              | 既存の実体                                                                           | 本拡張での扱い                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| FrameworkRequirement            | `disclosure_framework_versions` / `disclosure_items`（SSBJ 133 件・CSRD 架空 12 件） | 版メタデータ列を追加。ESRS-40a は別フレームワーク `esrs_40a` として登録（要求事項は未収録） |
| RequirementAssessment           | `ssbj_assessments`（SSBJ のみ、org×期間×要求事項）                                   | そのまま参照（内容評価）。原稿状態とは別列・別 enum                                         |
| MetricVersion                   | `data_point_versions`（追記専用）                                                    | 原稿の数値参照は `dataPointVersionId` を保持                                                |
| EvidenceVersion / SourceAnchor  | `files` / `file_versions` / `extracted_fragments`                                    | files に利用目的・版・発行日を追加。引用位置は新設 `source_anchors`                         |
| ReviewRequest / ApprovalEvent   | Data Point 専用の承認経路、回答の単段承認                                            | 汎用 `review_requests` / `review_events` を新設                                             |
| ReportSnapshot / ExportArtifact | なし（出力は常にライブ再構築）                                                       | `report_snapshots` / `export_artifacts` を新設                                              |
| KPI / TargetVersion             | なし                                                                                 | `kpi_targets`（追記専用の版）                                                               |
| GenerationRun                   | `ai_runs`                                                                            | 新 Use Case `disclosureBlockDraft` を追加                                                   |

---

## 2. 設計の前提（決定事項）

1. **機能設定は組織単位**。`organization_feature_settings.disclosure_first`。既定 false。
   false の組織は従来ナビ・従来ホームのまま（A01・A39）。新画面は URL で常に到達可能。
2. **権限キーは新設しない**（parity テストが 0002 しか読まないため）。
   - 下書き編集・レビュー依頼: `enterprise.disclosure.write`
   - レビュー（第 1 段）: `enterprise.disclosure.write` かつ 依頼者・版作成者ではない
   - 最終承認: `enterprise.disclosure.approve` かつ 依頼者・版作成者・同じ依頼のレビュー完了者ではない
   - 出力: `enterprise.export.run`（草稿）／承認済み版の出力も同じ
   - 機能設定の変更: `enterprise.org.manage`
   - AI 下書き: `enterprise.ai.run` かつ `enterprise.disclosure.write`
3. **AI は確定しない**。AI の候補は ai_runs に保存し、人が段落単位で採用して初めて作業中本文に入る。
   AI 由来の段落を含む版は、人が保存した版としてのみ存在し、人のレビューを経て承認できる。
4. **版は追記専用**。承認済みの版・スナップショットは更新しない。上流変更は「再確認が必要」を付けるだけ。
5. **時計は 1 か所**（`src/lib/clock.ts`）。デモ・テストは `FIXTURE_TODAY`、Supabase モードは実時計（組織 TZ）。
   デモでは画面に「デモ基準日」を表示する。
6. **デモ永続化**: 当初は小さい行だけを Cookie に持ち回し、長文の版・スナップショットはインスタンスメモリに置いた。
   2026-09-30 に本番（Vercel）で実演の流れを通したところ、要求が別インスタンスに届いて標準 CSV の確定が止まったため、
   **どのインスタンスに届いても流れが続く**方式へ改めた（§8.4）。

---

## 3. データモデル（マイグレーション 0033〜0043）

0033〜0040 は本節の設計。0041〜0043 は自己監査（3 巡）の指摘に対する追加で、表・列の削除は無い
（0041: 自動保存本文の寄稿者・承認とイベントの整合・スナップショット挿入時の検証・範囲改訂番号、
0042: 指名されたレビュアー／承認者と依頼状態の一致・書いた人の引き継ぎ・再確認の前提、
0043: トリガが別組織の行を読まない）。ロールバック方針は docs/known-limitations.md §6。

命名: SQL は snake_case、TS は camelCase（`src/types/domain.ts`）。全テーブルに `organization_id`、
作成・更新時刻と実行者を持たせる。RLS は有効化し、参照は `t4d.is_org_member(organization_id)`、
書込は `t4d.has_permission(organization_id, '<key>')`。追記専用テーブルは UPDATE/DELETE ポリシーを作らず
`t4d.forbid_mutation()` トリガを付ける。

### 0033_organization_feature_settings

`organization_feature_settings(id, organization_id UNIQUE, disclosure_first bool default false, audit cols)`
TS: `OrganizationFeatureSettings`、TableName `organizationFeatureSettings`。書込 `enterprise.org.manage`。

### 0034_framework_metadata_and_files

- `disclosure_frameworks.key` の CHECK に `esrs_40a` を追加（0018 と同じ差し替え方式）。
- `disclosure_framework_versions` に列追加（すべて NULL 可）:
  `version_code text, legal_status text check in ('draft','adopted','promulgated','effective','superseded','sample'),
issued_at date, effective_at date, jurisdiction text, materiality_basis text check in ('financial','impact','double','not_specified'),
source_url text, verified_at date, verified_by text, coverage_status text check in ('full_for_scope','partial','not_loaded','sample'), coverage_note text`。
  TS: `FrameworkLegalStatus`, `FrameworkCoverageStatus`, `MaterialityBasis`。
- `files` に列追加: `usage_purpose text check in ('current_fact','prior_year_text','style_reference')`,
  `edition_label text`, `issued_on date`。TS: `EvidenceUsagePurpose`。

### 0035_disclosure_projects

- `disclosure_projects`: `id, organization_id, reporting_period_id, name, reporting_entity text, period_start date, period_end date,
currency text default 'JPY', purposes text[] (DISCLOSURE_PURPOSES), languages text[] default '{ja}',
owner_user_id, reviewer_user_id, final_approver_user_id, due_date date,
scope_org_note text, scope_consolidation_note text, scope_ghg_boundary_note text, scope_value_chain_note text,
included_unit_ids uuid[] default '{}', status text check in ('preparing','active','closed') default 'preparing',
audit cols, deleted_at`。書込 `enterprise.disclosure.write`。
  `DISCLOSURE_PURPOSES = ['ssbj_statutory','ssbj_voluntary','csrd_40a_prep','csrd_eu_entity','internal_esg']`
  ラベル: SSBJ（法定）/ SSBJ（任意）/ CSRD 域外（40a）準備 / CSRD（EU 法人）/ 社内 ESG 管理。
- `project_frameworks`: `id, organization_id, project_id, framework_version_id, purpose, applicability_status
(APPLICABILITY_STATUSES = ['not_assessed','candidate','applicable','not_applicable','voluntary','awaiting_confirmation'] default 'not_assessed'),
current_decision_id uuid null, conditions jsonb default '{}' (§8.4 の入力。未入力を 0 扱いしない), audit cols`。
  ラベル: 未判定 / 適用候補 / 適用と判断 / 対象外と判断 / 任意適用 / 確認待ち。
- `project_framework_decisions`（追記専用）: `id, organization_id, project_framework_id, decision_no int,
applicability_status, reason text not null, rule_ref text not null（参照規則・版）, confirmed_on date not null（確認日）,
transitional_note text, conditions_snapshot jsonb, decided_by uuid not null, decided_at`。
  「保存して準備を始める」は project_frameworks の保存のみ。「適用判断を確定」で decisions を 1 行追記し current_decision_id を更新。

### 0036_narratives

- `narrative_records`: `id, organization_id, theme (NARRATIVE_THEMES = ['risk_opportunity','financial_impact','governance','strategy','policy_other']),
title, owner_user_id, owner_department text, tags text[], status (NARRATIVE_STATUSES = ['draft','confirmed','needs_recheck']),
current_version_id, confirmed_version_id, confirmed_by, confirmed_at, audit cols, deleted_at`。
  ラベル: リスク・機会 / 財務的影響 / ガバナンス / 戦略・対応策 / 方針・その他。状態: 下書き / 確認済み / 要再確認。
- `narrative_versions`（追記専用）: `id, organization_id, narrative_record_id, version_no, reporting_period_id,
scope_note text, fields jsonb（テンプレート項目。値が無い項目はキー自体を持たない）, body text,
source_anchor_ids uuid[], carried_from_version_id uuid null, change_reason text, originated_from_ai_run_id uuid null,
content_hash text, created_at, created_by`。
- `source_anchors`（追記専用）: `id, organization_id, file_version_id, fragment_id uuid null,
anchor_kind (ANCHOR_KINDS = ['pdf_page','heading_paragraph','sheet_cell','text_range','manual_excerpt']),
page int null, locator text null（見出し・段落番号・シート!セル）, quote_text text not null,
acquired_by (ANCHOR_ACQUIRED_BY = ['manual','extracted']), created_at, created_by`。
  利用目的は file 側（`files.usage_purpose`）で判定する。

### 0037_disclosure_blocks_reviews

- `disclosure_blocks`: `id, organization_id, project_id, framework_version_id, section_key text, title, sort_order int,
language text check in ('ja','en') default 'ja', translation_of_block_id uuid null, requirement_item_ids uuid[],
owner_user_id, due_date date, status (BLOCK_STATUSES = ['draft','review_requested','returned','approval_pending','approved']),
current_version_id, submitted_version_id, approved_version_id,
working_body jsonb null, working_base_version_id uuid null, working_saved_at timestamptz null（自動保存。業務版ではない）,
audit cols, deleted_at`。
  ラベル: 下書き / レビュー依頼中 / 差戻し / 承認待ち / 承認済み。
- `disclosure_block_versions`（追記専用）: `id, organization_id, block_id, version_no, base_version_id uuid null,
body jsonb（BlockBody AST）, plain_text text, metric_refs uuid[]（data_point_version id）, narrative_refs uuid[]（narrative_version id）,
anchor_refs uuid[], change_reason text, origin text check in ('human','human_adopted_ai'),
originated_from_ai_run_id uuid null, content_hash text, created_at, created_by uuid not null`。
- `review_requests`: `id, organization_id, project_id, target_type text check in ('disclosure_block'),
target_id, target_version_id not null, requested_by not null, reviewer_user_id, approver_user_id,
policy_version text not null（例 'sod-3role-v1'）, policy jsonb not null（依頼時点の規則のコピー）,
decision_ids uuid[]（依頼時点の適用判断版）, referenced_versions jsonb（依頼時点の metric/narrative/anchor 参照）,
status (REVIEW_REQUEST_STATUSES = ['open','returned','reviewed','approved','withdrawn']), created_at, updated_at, created_by, updated_by`。
- `review_events`（追記専用）: `id, organization_id, review_request_id, event_type
(REVIEW_EVENT_TYPES = ['requested','returned','review_completed','approved','withdrawn']),
stage text check in ('request','review','final'), actor_user_id not null, target_version_id not null,
reason text, paragraph_id text null, idempotency_key text UNIQUE, created_at`。
  **DB トリガ**: `approved` は actor ≠ requested_by かつ actor ≠ 対象版の created_by かつ actor ≠ 同じ依頼の review_completed の actor。
  `returned` は reason と paragraph_id が必須。
- `review_comments`: `id, organization_id, block_id, block_version_id, paragraph_id text null, body, severity text check in ('info','major'),
created_at, created_by, resolved_at, resolved_by, resolution_note`。未解決の major はレビュー完了・承認の阻害条件。
- `recheck_decisions`（追記専用）: `id, organization_id, block_id, block_version_id, ref_kind text check in ('metric','narrative'),
old_ref_id, new_ref_id, decision text check in ('adopt_new','keep_old','return_to_owner'), reason text not null, decided_by, decided_at`。

### 0038_report_snapshots_kpi

- `report_snapshots`（追記専用）: `id, organization_id, project_id, snapshot_kind text check in ('review_draft','approved'),
snapshot_no int, label text, framework_versions jsonb, decision_ids uuid[], blocks jsonb（節ごとの blockId・versionId・本文 AST・状態）,
metric_values jsonb（参照した data_point_version の値・単位・期間・境界・承認状態）, narrative_version_ids uuid[], anchors jsonb,
policy_version text, content_hash text not null, created_at, created_by`。approved は全必須節が承認済みで阻害条件なしの時だけ作成。
- `export_artifacts`（追記専用）: `id, organization_id, snapshot_id, format text check in ('docx','xlsx','csv'),
audience text check in ('internal','external'), template_version text, file_name, byte_size int, file_sha256 text,
content_hash text（スナップショットの正規化内容。再出力で一致する）, generated_at, generated_by`。
- `kpi_targets`（追記専用の版）: `id, organization_id, target_key text, version_no, metric_id, boundary text,
scope_note text, base_year int, base_value numeric, target_year int, target_value numeric,
target_type text check in ('absolute','intensity'), direction text check in ('reduce','increase'),
methodology_note text, owner_user_id, revision_reason text, created_at, created_by`。

### 0039_data_point_availability

- `data_points` / `data_point_versions` に列追加:
  `value_kind text not null default 'actual' check in ('actual','estimate','target')`,
  `availability_status text not null default 'value_present' check in ('value_present','not_entered','not_obtained','not_applicable','not_calculated')`,
  `absence_reason text null`。
  既存行の backfill: value と text_value がともに NULL の行は `not_entered`（**not_applicable にはしない**）。
  ラベル: 値あり / 未入力 / 未取得 / 対象外 / 未算定。区分: 実績 / 推計 / 目標。
  業務キー（org+metric+unit+period+boundary）は変えない。value_kind は「現在値の区分」。
- `quantitative_import_batches`: `id, organization_id, reporting_period_id, project_id uuid null, file_name, file_sha256,
status text check in ('validated','committed','rejected'), rows jsonb（行ごとの解析結果と差分区分）,
preview_hash text, commit_idempotency_key text UNIQUE null, committed_at, committed_by, excluded_count int default 0,
created_at, created_by`。

### 0040_audit_event_types_disclosure

audit_events の CHECK を差し替え、次を追加: `settings_changed, project_created, project_updated,
framework_decision_confirmed, narrative_version_created, narrative_confirmed, block_version_created,
review_requested, review_returned, review_completed, review_approved, review_withdrawn,
comment_created, comment_resolved, recheck_decided, report_snapshot_created, import_committed`。

---

## 4. 本文 AST（BlockBody）

```ts
type BlockInline =
  | { t: 'text'; text: string }
  | { t: 'metric'; dataPointId: Uuid; dataPointVersionId: Uuid; display: string } // 表示用文字列は挿入時の値
  | { t: 'narrative'; narrativeVersionId: Uuid; quote: string } // 採用時の本文を保持
  | { t: 'cite'; sourceAnchorId: Uuid }; // 出典印
interface BlockParagraph {
  id: string;
  kind: 'paragraph' | 'heading';
  children: BlockInline[];
  aiRunId?: Uuid;
}
interface BlockBody {
  paragraphs: BlockParagraph[];
}
```

- 段落 id は安定（差戻し・コメントの紐付け先）。
- 手書き数値（text 内の数値＋単位）は許可するが、同じ単位の参照可能な指標値があれば警告し、参照化か対象外説明を求める。

---

## 5. 状態遷移（§10.2 の実装）

| 操作         | 事前条件（サーバーで検証）                                         | 結果                                                                             |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 自動保存     | 編集権限、ブロックが draft/returned                                | working_body 更新（版は作らない）                                                |
| 版として保存 | 編集権限、base_version = current_version（不一致は競合）           | 版追記、current_version 更新                                                     |
| レビュー依頼 | 担当・本文あり、未採用 AI 候補なし、阻害エラーなし                 | 提出版固定（submitted_version）、review_request + event、status=review_requested |
| 差戻し       | 第 1 段レビュアー又は最終承認者、理由と段落必須                    | event、request=returned、block=returned                                          |
| レビュー完了 | 依頼者・版作成者ではない、未解決 major なし                        | event、request=reviewed、block=approval_pending                                  |
| 最終承認     | approve 権限、依頼者・版作成者・レビュー完了者ではない、参照の整合 | event、request=approved、block=approved、approved_version 固定                   |
| 承認後に修正 | 編集権限、変更理由                                                 | 新しい版（承認済み版は残る）、block=draft                                        |
| レポート確定 | 全必須節が承認済み、適用未判定なし（草案区分は可）、阻害条件なし   | approved スナップショット                                                        |
| 出力         | export 権限                                                        | 同じスナップショットから生成し export_artifacts 記録                             |

二重押下: `idempotency_key`（依頼 id＋段階＋対象版）で同じ判断を 2 回記録しない。

---

## 6. 画面

| ルート                                                         | 内容                                                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/enterprise/dashboard`                                        | disclosure_first の組織は「開示業務 / ESG経営」タブ（?tab=）。開示業務: 4 カード・自分の作業 5 件・分母付き進捗。従来ホームは ESG 経営側ではなく従来のまま残す |
| `/enterprise/disclosure-projects`                              | プロジェクト一覧・新規作成（3 段階）                                                                                                                           |
| `/enterprise/disclosure-projects/[projectId]`                  | タブ: 概要 / 要求事項 / 原稿 / レビュー・承認 / 出力 / 設定（?tab=）                                                                                           |
| `/enterprise/disclosure-projects/[projectId]/blocks/[blockId]` | 原稿編集（左目次・中央本文・右根拠タブ〔要求事項/根拠資料/関連数値/前年/コメント〕・下部状態）                                                                 |
| `/enterprise/narratives` / `[narrativeId]`                     | 定性情報一覧・編集（テンプレート項目、右に資料の該当箇所）                                                                                                     |
| `/enterprise/esg`                                              | ESG 経営 KPI（最新承認値モード・スナップショット照合モード）                                                                                                   |
| `/enterprise/imports/standard`                                 | 数値を登録（標準 CSV）：選択→検証→差分→確定                                                                                                                    |

---

## 7. デモ Fixture（架空）

- 架空企業（既存デモテナント）に FY2026 プロジェクト「FY2026 統合開示（SSBJ・CSRD 域外準備）」と FY2025 の承認済みプロジェクト（前年比較用）。
- 節: ガバナンス（根拠付き・承認済み）、リスク・機会（財務影響が未確定で不足情報あり・下書き）、指標（承認済みだが引用した Scope1 に承認後の新版があり「再確認が必要」）。
- 資料（架空テキスト）: 過年度有報抜粋、当年度サステナビリティ委員会資料、気候リスク・機会評価資料（財務影響の未確定箇所あり）。
- ESRS-40a は `legal_status=draft`・`coverage_status=not_loaded`（要求事項は未収録）と表示。既存 CSRD 12 項目は「サンプル（架空）」。

実装（W1-F2）: `src/lib/fixtures/disclosure-first.ts`（ID は `DISCLOSURE_FIRST_IDS` で公開）と
`src/lib/fixtures/disclosure-documents.ts`（資料本文。Demo Mode のストレージが本文を返す）。

- 機能設定は主役の企業に 1 行（`disclosure_first=false`）。切替は発表者・E2E が行う（A01）。
- 引用した Scope1 は本社 FY2026 のデータ。**節の承認後に同じ値の訂正版（v2・変更理由「集計範囲の訂正（架空）」）を足し、
  再承認まで済ませてある**。値を変えないのは既存の GHG 集計・画面の数値を保つため、再承認まで済ませるのは
  Data Room・監査法人 SNAP-1・検証結果（承認後変更の警告）を既存のデモから変えないため。訂正は SNAP-1 の固定より前。
- ガバナンスの定性情報 v2（確認済み）を SSBJ の節と ESRS-40a 準備の節が別々に引用する（A20）。
- リスク・機会の節は下書き・コメントは解決済みの「参考」1 件のみ（E2E が依頼 → レビュー → 承認を通せるよう阻害条件を置かない）。
- KPI 目標は Scope1（実績と同じ境界「連結」）と Scope2 マーケット基準（境界「単体（国内拠点）」＝比較条件の確認が必要）。
- 定性情報のテンプレート項目は `src/lib/domain/narrative-template.ts` に定義した（財務的影響の「影響額」はキーを持たない）。
- 監査ログの行は作らない（既存の監査ログ一覧の件数・並びを変えないため）。

---

## 8. 実施結果（2026-09-29〜30）

指示書 §1.8 に合わせ、「実装した」「デモで動く」「本番（Demo Mode）で確認した」「未接続・未検証」を分けて書く。
対象は D0（選考デモ）。P1（実データ永続化・本番認可・AI 実接続が検証済みの状態）は完了と扱わない。

### 8.1 区分

| 区分                    | 範囲                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装した                | 機能設定（組織単位の開示優先モード）と新メニュー・開示業務ホーム、開示プロジェクト（3 段階作成・基準の法的状態・適用判断の確定と履歴）、定性情報（テーマ別テンプレート・引用位置・前年引継ぎ・資料から候補・競合検知）、原稿編集（3 ペイン・指標版参照・定性情報の引用・手書き数値警告・前年差分・AI 下書き候補の段落採用）、レビュー依頼・差戻し・レビュー完了・最終承認（職務分離をサービスと DB トリガの両方で強制）、上流変更の再確認、レポートスナップショットと DOCX/XLSX/CSV 出力、ESG 経営 KPI と目標、数値を登録（標準 CSV・手入力）、値の区分（実績・推計・目標）と値の有無（未入力・未取得・対象外・未算定）、デモ役割切替・デモ基準日・開示デモのリセット、§2.3 の 7 論点の修正、レポート画面と SSBJ Word 出力の不具合修正 |
| デモで動く（E2E）       | 上記を 1 プロジェクトで連結した実演の流れ（`tests/e2e/zz-disclosure-project.spec.ts` 8 手順）、従来モードの不変・キーボード操作・1366px（`tests/e2e/disclosure-first-nav.spec.ts`）、リクエストごとに Fixture を作り直す最悪条件でも同じ流れが通ること（`pnpm test:e2e:stateless`）                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 本番（Demo Mode）で確認 | https://terrast-t4d.vercel.app （2026-09-30 デプロイ）で本番スモーク 31/31（開示優先モードの 2 件を追加）、実演の流れ 8/8（`playwright.production-chain.config.ts`、1 ブラウザで Cookie を持ち回し、最大 Cookie ヘッダー 8,868B）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 未接続・未検証          | 実 Supabase（0033〜0043 は PGlite 上の RLS テストのみ。本番 Supabase へは未適用・環境変数も未設定）、実 AI モデル（Mock のみ）、A36（再読込・再ログイン後の本番データ保持）、A26 の真の同時実行、DOCX/XLSX の Word/Excel での目視（テキスト抽出での照合のみ）、1280px 未満の画面                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 8.2 検証コマンドと結果（最終）

| コマンド                                                    | 結果（作業前 → 作業後）                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`        | 合格                                                       |
| `pnpm test`（unit + integration）                           | 677 → 1,259 件（109 ファイル）合格                         |
| `pnpm test:rls` / `pnpm check:rls`                          | 101 → 248 件合格 / 83 → 100 表・RLS 有効 100・ポリシー 228 |
| `pnpm build`                                                | 合格                                                       |
| `pnpm test:e2e`（単独実行）                                 | 269 → 282 件合格（再試行 0）                               |
| `pnpm test:e2e:stateless`                                   | 16 件合格（Cookie ヘッダー最大 8.8KB・押し出し 0）         |
| `pnpm test:e2e:prod`（本番）                                | 29 → 31 件合格                                             |
| 実演の流れ（本番、`playwright.production-chain.config.ts`） | 8/8 合格                                                   |

自己監査は 3 巡（観点: 業務不変条件・セキュリティ・回帰と誠実さ・UX/アクセシビリティ・永続化と Supabase）。
指摘 53 → 38 → 38 件（反証後）をすべて修正し、各修正に落ちるテストを付けた。永続化の改修にも 2 観点のレビューを行い 11 件を修正した。

### 8.3 受入テスト A01〜A40

| ID                 | 検証                                                              | 結果                                                                                                     |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A01                | E2E（zz-disclosure-project・disclosure-first-nav）、unit          | 合格（既定 OFF・ON で新導線・既存 URL と従来モードは不変）                                               |
| A02                | integration（dashboard-period-scope）、画面の過年度バナー         | 合格                                                                                                     |
| A03〜A07           | integration（quantitative-import）、E2E（改名した同一 CSV・訂正） | 合格                                                                                                     |
| A08〜A10           | integration（ghg-null-handling・csrd）、ESG KPI                   | 合格（Scope2 両方式は合算しない・Cat.1 を Scope3 全量にしない・総量とカテゴリは照合のみ）                |
| A11                | integration                                                       | 合格（推計は推計のまま。KPI は推計・目標を確定実績に含めない）                                           |
| A12                | ESG KPI の定義表示                                                | 一部（比率と格差を同一視せず式を表示。格差率の指標・式 ID の分離は未実装）                               |
| A13                | ESG KPI                                                           | 一部（拠点率の単純平均はしない。分子・分母の指標は未整備のため全社率は出さない）                         |
| A14                | ESG KPI                                                           | 合格（件数と LTIFR は別行）                                                                              |
| A15〜A19           | integration（Mock・故障注入スタブ）                               | 合格（D0 の Mock のみ。実モデルは未検証）                                                                |
| A20                | fixture + integration                                             | 合格（同じ定性情報版を SSBJ と ESRS-40a 準備の節が引用、承認は独立）                                     |
| A21                | integration                                                       | 合格                                                                                                     |
| A22                | integration・画面                                                 | 合格（公開草案に基づく準備・要求事項未収録と表示し、法定準拠確定へ進めない）                             |
| A23                | integration                                                       | 合格                                                                                                     |
| A24・A25・A27・A28 | integration・RLS・E2E                                             | 合格                                                                                                     |
| A26                | integration（直前の再検証）＋ DB トリガ                           | 一部（DbClient に取引が無く、真の同時実行は未検証）                                                      |
| A29                | integration・RLS・出力ルート                                      | 合格                                                                                                     |
| A30                | —                                                                 | 未対応（資料単位の ACL は無い。閲覧は evidence.read 権限単位で、RLS の files_select は組織メンバー全員） |
| A31・A32           | integration（parseDocx で照合）・E2E                              | 合格                                                                                                     |
| A33・A34           | integration                                                       | 合格                                                                                                     |
| A35                | integration・画面（保存失敗・再試行・入力保持）                   | 合格（E2E での通信断の注入は未実施）                                                                     |
| A36                | —                                                                 | 未検証（Supabase モードの E2E が必要。Demo Mode は設計上 Fixture に戻る）                                |
| A37                | E2E（キーボードのみ・axe）                                        | 合格（主要経路）                                                                                         |
| A38                | E2E（1366×768・1280）                                             | 合格（1280px 未満は製品の対象外）                                                                        |
| A39                | E2E 全件                                                          | 合格（Scope3・人事取込・SSBJ ドラフトの既存 E2E が回帰なし）                                             |
| A40                | 表示文言・unit                                                    | 合格（「社内承認済み版」。保証済み・提出済みとは表示しない。保証側への自動共有なし）                     |

### 8.4 本番（Vercel）で流れが途切れない仕組み

本番は外部ストアも環境変数も持たない Demo Mode で、要求ごとに別のインスタンスへ届き得る。
Vercel のヘッダー上限（1 ヘッダー 16KB）の中で、次のように持ち回す。

- 標準 CSV の確定: 元ファイルを再送し、サーバーが解析・検証をやり直してプレビューのハッシュ（行と既存の版を含む）が一致した時だけ登録。クライアントが送る解析結果は使わない。確定の控えだけを Cookie に残し、再試行で二重登録しない。
- 原稿・定性情報の版と引用位置: 前の版との差分だけを Cookie に持つ。スナップショットは目録（版 ID・値の版 ID など）だけを持ち、別インスタンスで同じ関数で組み立て直し、内容ハッシュが一致しなければ使わない。
- Cookie は Brotli で一括圧縮（3 × 3,800B）。実演の流れで最大 8.7KB、押し出し 0。偽造 Cookie は組織・権限・職務分離・計算量の上限で拒否する。
- 最悪条件の再現: `T4D_DEMO_FRESH_FIXTURE_PER_REQUEST=1`（テスト専用。Vercel には設定しない）で要求ごとに Fixture を作り直し、`pnpm test:e2e:stateless` で流れを確かめる。
- 状態はブラウザの Cookie にある。**実演は 1 つのブラウザで行う**（別のブラウザ・端末には操作が見えない。8 時間で失効）。詳細は docs/known-limitations.md D-3。

### 8.5 指示書の妥当性検証で判断を変えた点

- §2.3 の 7 論点は原因を特定して修正した（§1.1 の訂正を含む）。
- 取込画面のデモ信頼度（80〜97% への表示調整）は、村田向けデモで発注者から明示指示を受けた既存仕様のため維持した。指示書 §9.3「過度に高い認識率を fixture から表示しない」と緊張関係にあるため、**扱いの判断をお願いしたい**。新機能（開示優先モード）には適用していない。
- §6.4「既存 OCR へ誘導」: OCR は無いため手動抜粋に置き換えた。
- §6.9「既存の最大 5 階層の再利用」: Data Point 専用のため、開示本文には汎用のレビュー依頼（作成・レビュー・最終承認の 3 役割）を新設した。
- ESRS-40a: 公開草案の要求事項は収録していない（架空条文を作らない）。基準パックは草案・未収録と表示する。
- 権限キーは新設しない（既存の disclosure.write / approve 等で表現）。Data Point の業務キーは変えず、値の区分は現在値の区分とした。内訳キー付きの行は未対応。
- 「学習」はモデルの再学習にせず、許可された資料の参照に限定した（指示書 §2.4 のとおり）。過年度資料を当年度の事実へ昇格させない。

### 8.6 実演手順（約 12〜15 分）

0. 管理者（青海 太郎）で「管理 → 設定 → 機能設定（開示優先モード）」を有効にする。以降は同じブラウザで操作する。
1. ホーム「開示業務」: 4 カード・自分の作業・分母付き進捗。プロジェクトは SSBJ（任意）と CSRD 域外（40a）準備（公開草案・要求事項未収録）。
2. Scope3 Cat.1: 「情報・根拠 → Scope3データ取込 → Cat.1」（既存デモ）。
3. 数値: 「情報・根拠 → 数値を登録（標準CSV）」で検証 → 差分 → 確定（人事集計の例は既存の「取込」も可）。
4. 定性情報: 「情報・根拠 → 定性情報」で資料の一部を根拠に登録・確認。
5. 原稿: 「開示プロジェクト → 原稿 → リスク及び機会」で数値参照・引用を挿入、AI（デモ生成）の段落を採用して版を保存 → レビュー依頼。
6. ヘッダーの「役割切替（デモ）」で 検見川（差戻し）→ 海野（修正・再提出）→ 検見川（レビュー完了）→ 承（最終承認）。海野には最終承認が出ない。
7. 「出力」タブでレポートを確定し DOCX（対外・社内）・XLSX 対応表・CSV を出力。「ESG経営」で同じ確定値の KPI。
8. 数値を訂正すると、原稿に「再確認が必要」が付き、承認済みスナップショットと出力は変わらない。
9. 終了時: ホーム下部「開示デモを初期状態に戻す」、設定で開示優先モードを無効に戻す。

画面: `docs/assets/disclosure-first/01〜11-*.png`（2026-09-30 本番で撮影）。

### 8.7 未実装・残課題（P1 以降）

- A30 資料単位の ACL、A36（Supabase モードの E2E）、実 AI モデルでの A15〜A19、AI の取消・ジョブ化（現状は同期実行・タイムアウトは失敗扱い）。
- Supabase モードの書込は取引で束ねていない（DbClient に transaction が無い。DB トリガで職務分離・整合は強制）。
- 格差率・LTIFR の分子分母の指標化（A12・A13）、内訳キー付き行、列対応テンプレートの保存、翻訳元版の列（翻訳の要確認は版の日時で判定）。
- 従来画面の一部バッジはアイコン未付与（新画面は対応済み）。
- 顧客確認事項（指示書 §17）は未確認のまま、確認前の既定で実装した。
