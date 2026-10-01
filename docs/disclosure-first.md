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

---

## 9. 2026-10-01 追加要望（定性情報メニュー・分析・CSRD の再構成）

発注者要望（2026-10-01）: ① 左メニュー SSBJ の「データ収集」と「開示ドラフト」の間に「定性情報」
（`/enterprise/narratives` への導線）、② 「AI Copilot」と「管理」の間に「分析」（現状診断・各規制への対応度・他社との比較など）、
③ CSRD を SSBJ と同じ画面構成（対応状況／要求事項／対応計画／データ収集／開示ドラフト）にする。ただし CSRD はダブル・マテリアリティ。
対象は D0（架空データで操作がつながる）。§0 の不変条件（RLS・AI は確定しない・架空データのみ）と §2 の決定（権限キー新設なし等）はそのまま。

### 9.1 解釈と決定

| #   | 解釈                                                                                                            | 決定                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 「ホーム／開示対応／ESG データ（GHG以外）」の並びは**従来メニュー**。定性情報は SSBJ 専用でなく全基準共通の資産 | 従来ツリーの SSBJ 配下 `データ収集` と `開示ドラフト` の間に `定性情報`（`/enterprise/narratives`、NotebookPen）を挿入。画面は既存のまま（新規作成しない）。開示優先ツリーは SSBJ を `legacyItem` で共有するため同じ 6 項目になる。開示優先ツリーでは「情報・根拠 → 定性情報」が正規の位置で、SSBJ 配下の方は**別導線（secondary）**として現在地を付けない                                                    |
| ②   | 分析は閲覧専用の横断画面。単一の総合点は作らない                                                                | 最上位 `分析`（href=`/enterprise/analysis/diagnosis`、ChartColumnBig）。子: `現状診断`（/diagnosis）・`規制対応度`（/regulations、permission `enterprise.disclosure.read`）・`他社比較`（/benchmark）。従来ツリーは AI Copilot と 管理 の間。開示優先ツリーは 管理 の直前（タスク・承認 → 分析 → 管理 → AI Copilot）＝両ツリーとも「管理の直上」。追加ページ（データ品質等）は作らず、現状診断の 1 領域にする |
| ③   | SSBJ と同じ 5 画面＋設定（SSBJ 同様メニュー外、対応状況の工程①から入る）。重要性は DMA で決める                 | CSRD を葉からグループへ。子: 対応状況（/csrd）・要求事項・対応計画・データ収集・開示ドラフト。**定性情報は CSRD に入れない**（要望が 5 画面を列挙、定性情報は共通資産。従来ツリーに同じ href が 2 つになり現在地が 2 つ付くのを避ける）。CSRD の開示ドラフト画面の右上に定性情報へのリンクを置く                                                                                                              |

メニュー（変更後）:

```
従来ツリー（ENTERPRISE_NAV）                 開示優先ツリー（ENTERPRISE_NAV_DISCLOSURE_FIRST）
ホーム                                        ホーム
開示対応                                      開示プロジェクト
  SSBJ                                          SSBJ（従来と同じ 6 子。定性情報は secondary）
    対応状況/要求事項/対応計画/データ収集/          CSRD（従来と同じ 5 子）
    定性情報/開示ドラフト                         その他の開示（CDP/MSCI/FTSE）
  CDP                                           レポート出力
  CSRD                                        情報・根拠（定性情報＝正規の位置）
    対応状況/要求事項/対応計画/データ収集/        ESG経営
    開示ドラフト                                タスク・承認
  MSCI / FTSE                                 分析（現状診断/規制対応度/他社比較）
ESG データ（GHG以外） / GHG / 業務管理         管理
AI Copilot                                    AI Copilot
分析（現状診断/規制対応度/他社比較）
管理
```

現在地（aria-current）の規則（B1 が実装）:

- `NavItem.secondary?: true` … 同じ画面への別導線。aria-current・強調表示を付けず、親の `isSubtreeActive` にも数えない。開示優先ツリーは
  `legacyItem(SSBJ)` を直接使わず、`/enterprise/narratives` の子だけ `secondary: true` にした**複製**を使う（従来ツリーの SSBJ は通常の葉で、現在地が付く）。
- `NavItem.alsoCurrentFor?: RegExp[]`（葉のみ）… CSRD「要求事項」に `^/enterprise/disclosures/csrd/[0-9a-f-]{36}$`（既存の回答編集画面）を指定し、回答編集中も「要求事項」が現在地になる。
- 子リスト `<ul>` に `aria-label={親のラベル}` を付ける（E2E が `getByRole('list', { name: 'SSBJ' })` で範囲を絞るため。CSRD と SSBJ で同名リンクが並ぶ）。
- 保証: 開示優先ツリーは**すべての href で aria-current がちょうど 1 つ**。従来ツリーは「最上位＋葉」で 2 つ付く既存仕様（A39 テスト、GHG＋Cat.1）を変えず、
  **2 階層目以下では常に 1 つ以下**（同じ href が別の枝に 2 回出ても重複しない）。設定画面（/ssbj/settings・/csrd/settings/\*）は従来どおり現在地なし。
- 従来メニュー不変（A39・§2-1）は本要望で意図的に更新する。テストは新しい形を厳密に固定し直す（緩めない）。

### 9.2 シングル／ダブル・マテリアリティ

| 基準                                           | 重要性の考え方                                                     | 保存先                                             | 要求事項の適用の決め方                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SSBJ（公表済み、`materialityBasis=financial`） | 財務的重要性（投資家の意思決定に影響する情報）＝シングル           | `materiality_topics`（単一軸）・`ssbj_assessments` | **変更しない**（SSBJ 設定 ③・ドラフト・範囲対応表はそのまま）                                 |
| CSRD／ESRS（サンプル（架空）12 項目）          | ダブル・マテリアリティ（インパクト**または**財務のどちらかで重要） | 新設 `csrd_dma_matters` / `csrd_dma_iros`（§9.3）  | ESRS 2 は常に適用。テーマ別の要求事項は、その事項が重要と人が判断したときだけ適用             |
| ESRS-40a（公開草案、`impact`、要求事項未収録） | インパクト重要性のみ（公開草案 ESRS-40a 1 §3、W0 で一次資料確認）  | —                                                  | 対象外（本要望の CSRD 画面は `csrd` のみを扱う）。DMA の財務側で 40a の重要性を決めない（P1） |

- `CSRD_SAMPLE_VERSION_METADATA.materialityBasis` を `null` → `'double'` に変える（fixture と seed 再生成。テストで固定されていない）。
- 画面の注記（CSRD 設定・要求事項）: 「ダブル・マテリアリティの考え方は 2023 年採択の ESRS（委任規則 (EU) 2023/2772）に基づく。
  2026-07-03 採択の改正（簡素化）ESRS は官報掲載まで未発効で、本サンプルには反映していない。ESRS-40a 公開草案はインパクト重要性のみ」。
  条文番号は本フェーズで再確認していないため画面・コードに書かない。**正式条文・正式らしい新 ID は作らない**（マスターは既存 12 項目のまま。IRO-1 等を追加しない）。
- **ESRS は数値の閾値を定めていない**。閾値・採点方法は会社が決めて開示するものとし、画面に「自社の評価方法（デモ既定）」と明示する。

**サステナビリティ事項（matter）** = ESRS のテーマ別基準 10 個（E1 気候変動／E2 汚染／E3 水・海洋資源／E4 生物多様性と生態系／E5 資源利用と循環経済／
S1 自社の労働力／S2 バリューチェーンの労働者／S3 影響を受けるコミュニティ／S4 消費者・エンドユーザー／G1 企業行動）。
サブトピックは IRO の `sub_topic`（自由記述）で表す（事項単位の判断。サブトピック単位の判断・企業固有の事項は P1）。

**IRO（影響・リスク・機会）と採点**（`src/lib/domain/dma.ts`、方式 `dma-demo-v1`。すべて 1〜5 の整数入力）:

| 種類                      | 入力                                                                                                                                   | 算出（小数 1 桁に丸めた値で閾値と比較＝画面の数字と判定が一致）                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| インパクト（impact）      | 実在/潜在、負/正、規模・範囲、回復困難性（負のみ必須・正は無し）、発生可能性（潜在のみ必須）、人権フラグ、段階（自社/上流/下流）、期間 | 深刻度 = 負: 平均(規模,範囲,回復困難性)、正: 平均(規模,範囲)。スコア = 実在: 深刻度、潜在: √(深刻度×可能性)、**潜在でも人権なら深刻度**（深刻度を可能性より優先） |
| リスク・機会（financial） | 発生可能性、財務影響の大きさ、期間（短期=報告期間／中期=〜5年／長期=5年超。必須）、段階、関連するインパクト IRO（任意）                | スコア = √(可能性×大きさ)                                                                                                                                         |

事項ごとの算定結果: インパクト側 = いずれかのインパクト IRO のスコア ≥ インパクト閾値、財務側 = いずれかのリスク・機会のスコア ≥ 財務閾値（IRO が無い側は「評価材料なし」）。
**算定結果は提案にすぎず、確定は人**: 事項ごとに各軸を「重要／重要でない／未評価」で判断し、評価済みの軸には根拠（必須）を書く。

| インパクトの判断 | 財務の判断 | 結果（DmaOutcome）                       | 適用への寄与             |
| ---------------- | ---------- | ---------------------------------------- | ------------------------ |
| 重要             | 重要       | `both` 両面で重要（Scale）               | 適用（インパクト・財務） |
| 重要             | 重要でない | `impact_only` インパクトのみ（Globe）    | 適用（インパクト）       |
| 重要でない       | 重要       | `financial_only` 財務のみ（Banknote）    | 適用（財務）             |
| 重要でない       | 重要でない | `not_material` 重要でない（CircleMinus） | 対象外（重要でない）     |
| どちらかが未評価 | —          | `not_assessed` 未評価（CircleHelp）      | 未判定                   |

要求事項の適用（`deriveCsrdApplicability`、保存せず毎回導出）: 要求事項コードから節を決める（`ESRS2-` → ESRS2、`ESRS-(E[1-5]|S[1-4]|G1)-` → その事項、それ以外 → 未判定）。
ESRS2 → `always`「ESRS 2（常に適用）」（Lock）。それ以外 → 事項の結果から `material`（どの観点で適用になったかを `perspectives: ('impact'|'financial')[]` で持ち、行ごとにバッジ表示）／`not_material`／`undetermined`。
DMA 全体が未確定（または確定後に変更あり）の間は `provisional: true` とし「暫定（DMA 確定前）」（Clock）を併記する。対象外の要求事項の任意開示は P1。

**DMA の確定**: `csrd_analysis_settings.dma_confirmed_at/by` を人が入れる（条件: 報告範囲の決定・ステークホルダー関与の記載・10 事項すべてが `not_assessed` 以外）。
DMA に関わる書込（閾値・IRO・事項の判断）は同じ処理で確定を解除する（読むだけでは書かない）。AI は DMA の判断・確定に一切書き込まない（D0 では DMA の AI 候補は作らない。P1）。

### 9.3 データモデル（マイグレーション 0044〜0046、すべて追加のみ）

共通: `organization_id`・`reporting_period_id`・`created_at/updated_at/created_by/updated_by`。RLS 有効。参照 `t4d.is_org_member(organization_id)`、
書込（for all）`t4d.has_permission(organization_id, 'enterprise.disclosure.write')`（0028/0030 と同じ）。追記専用の表は無い。**権限キーは新設しない**。
ステータス値は既存 enum を再利用（3 観点の 5 値 `SsbjCoverageStatus`、対応計画の `gap_kind`・`action_type` 7 値・`priority`・`status` は 0025 と同じ）。

**0044_csrd_double_materiality.sql**

- `csrd_analysis_settings`: `consolidation_scope`・`consolidation_note`・`included_unit_ids uuid[]`・`value_chain_scope`・`value_chain_note`（値と CHECK は 0028 と同じ）、
  `scoring_method text not null default 'dma-demo-v1' check in ('dma-demo-v1')`、`impact_threshold numeric(2,1) not null default 3.0`・`financial_threshold`（同、`between 1.0 and 5.0`）、
  `method_note text not null default ''`、`stakeholder_engagement_note text not null default ''`、`dma_confirmed_at timestamptz`、`dma_confirmed_by uuid references profiles`。
  UNIQUE (org, period)。CHECK `(dma_confirmed_at is null) = (dma_confirmed_by is null)`。
- `csrd_dma_matters`: `esrs_topic text not null check in ('E1','E2','E3','E4','E5','S1','S2','S3','S4','G1')`、
  `impact_assessment`・`financial_assessment text not null default 'not_assessed' check in ('material','not_material','not_assessed')`、
  `impact_rationale`・`financial_rationale`・`stakeholder_note text not null default ''`、`decided_at`・`decided_by`。
  UNIQUE (org, period, esrs_topic)、UNIQUE (id, organization_id)（複合 FK 用）。CHECK: 評価済みの軸は `btrim(根拠) <> ''`、`(decided_at is null) = (decided_by is null)`。結果（DmaOutcome）は列にしない（2 軸から導出）。
- `csrd_dma_iros`: `matter_id uuid not null`、`FOREIGN KEY (matter_id, organization_id) REFERENCES csrd_dma_matters (id, organization_id) ON DELETE CASCADE`、
  `iro_type check in ('impact','risk','opportunity')`、`sub_topic text not null default ''`、`description text not null check (btrim(description) <> '')`、
  `value_chain_stage check in ('own_operations','upstream','downstream')`、`time_horizon check in ('short','medium','long')`（null 可）、
  `impact_occurrence check in ('actual','potential')`、`impact_direction check in ('negative','positive')`、`impact_scale`・`impact_scope`・`impact_irremediability`・`impact_likelihood`・
  `financial_likelihood`・`financial_magnitude smallint check between 1 and 5`（null 可）、`human_rights boolean not null default false`、`affected_stakeholders text not null default ''`、
  `related_impact_iro_id uuid references csrd_dma_iros (id)`、`deleted_at`。形の CHECK: impact ⇒ 発生・方向・規模・範囲あり／財務 2 列 null、負 ⇔ 回復困難性あり、潜在 ⇔ 可能性あり。
  risk/opportunity ⇒ インパクト系 6 列 null・`human_rights=false`・財務 2 列と期間あり。

**0045_csrd_assessments_plans.sql**

- `csrd_assessments`: `item_id uuid not null references disclosure_items`、`disclosure_status`・`data_status`・`process_status`（5 値、既定 `unconfirmed`）、
  AI 候補 `ai_disclosure_status`・`ai_data_status`・`ai_process_status`・`ai_status`（5 値、null 可）・`ai_comment`・`ai_missing_info text[]`・`ai_recommendation`・`ai_run_id references ai_runs`・`ai_evaluated_at`、
  人の確認 `review_decision check in ('approved','modified')`・`reviewed_by`・`reviewed_at`・`review_comment`・`final_status`（5 値）、`owner_department`・`owner_user_id`。
  適用区分・重要性の列は**持たない**（DMA から導出）。UNIQUE (org, period, item_id)・UNIQUE (id, organization_id)。CHECK `(final_status is null) = (reviewed_at is null)`。
  トリガ `t4d.csrd_assessment_item_guard()`（BEFORE INSERT OR UPDATE OF item_id）: item の版のフレームワーク key が `csrd` でなければ例外。
- `csrd_action_plans`: 0025 の `ssbj_action_plans` と同じ列（`gap_kind`・`title`（空不可）・`detail`・`action_type`・`department`・`assignee_user_id`・`due_date`・`priority`・`status`・`linked_metric_code`）。
  `FOREIGN KEY (assessment_id, organization_id) REFERENCES csrd_assessments (id, organization_id) ON DELETE CASCADE`。

**0046_csrd_disclosure_drafts.sql**

- `csrd_disclosure_drafts`: `section text not null check in ('ESRS2','E1','E2','E3','E4','E5','S1','S2','S3','S4','G1')`、`body`・`ai_body text not null default ''`、
  `covered_item_codes text[]`、`gaps jsonb default '[]'`、`ai_run_id`・`ai_confidence numeric(4,3)`・`ai_warnings text[]`・`ai_generated_at`、`confirmed_at`・`confirmed_by`。
  UNIQUE (org, period, section)。CHECK: `confirmed_at is null or btrim(body) <> ''`。

SSBJ の表（`ssbj_*`）は再利用しない: 設定は SSBJ 専用列と org×期間一意、ドラフトは area と行 ID が衝突、評価・計画は SSBJ の 4 つの読み取り経路（ssbj-gap.ts:748・1195・1397・1476）が
フレームワークで絞らず SSBJ 画面へ混入するため。開示プロジェクトの要求事項タブ（`ssbj_assessments` を参照）は CSRD サンプルを使っていないので影響なし（統合は P1）。

TS・登録（Stage A）: `src/types/domain.ts`（`ESRS_TOPICS`/`EsrsTopic`、`CSRD_SECTIONS`/`CsrdSection`、`DMA_AXIS_ASSESSMENTS`、`DmaOutcome`、`IroType`、`ImpactOccurrence`、`ImpactDirection`、
`ValueChainStage`、`TimeHorizon`、`CsrdAnalysisSettings`、`CsrdDmaMatter`、`CsrdDmaIro`、`CsrdAssessment`、`CsrdActionPlan`、`CsrdDisclosureDraft`）、
TableName `csrdAnalysisSettings`・`csrdDmaMatters`・`csrdDmaIros`・`csrdAssessments`・`csrdActionPlans`・`csrdDisclosureDrafts`（`table-names.ts`・`repositories/types.ts`・`fixtures/store.ts`・`to-sql.ts`（jsonb 列 `gaps`・投入順）・`supabase/seed.sql` 再生成）。
fid の名前空間: `csrd_analysis_settings`・`csrd_dma_matter`・`csrd_dma_iro`・`csrd_assessment`・`csrd_action_plan`・`csrd_disclosure_draft`（行 ID は org/期間/コード等から決定的に作る）。
監査イベントは既存の `data_created`・`data_updated`・`settings_changed` を使う（0040 の CHECK 変更なし）。

**デモ永続化（Cookie 3×3,800B）**

| 表                                                                                  | PERSISTED_TABLES | DISCLOSURE_DEMO_RESET_TABLES | 理由                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| csrdAnalysisSettings・csrdDmaMatters・csrdDmaIros・csrdAssessments・csrdActionPlans | 入れる           | 入れる                       | 差分のみ記録。FY2026 の評価 12 行は fixture に全部置き、**表示時に行を作らない**（ssbjAssessments の一括作成問題を持ち込まない） |
| csrdDisclosureDrafts                                                                | 入れる           | 入れる                       | Mock 草案は 1 節 600 字以内                                                                                                      |
| metricAssignments（既存）                                                           | 入れる（新規）   | 入れない                     | 収集項目の作成（1 行）が別インスタンスで消えないため。全コードで insert は 1 か所（ssbj-gap.ts:1336）のみ                        |

**Fixture（`src/lib/fixtures/csrd.ts`、`CSRD_IDS` を公開。青海テクノロジー FY2026、作成者・判断者は 海野 みどり。FY2025 は行なし＝画面は未評価表示）**

- 設定: 連結＝財務と同じ、バリューチェーン＝上流・下流、閾値 3.0／3.0、方法メモと「従業員・主要サプライヤー・顧客への聞き取り（架空）」、**DMA 未確定**。
- DMA（スコアは §9.2 の式で再計算できる値。すべて架空）:

| 事項 | インパクト IRO（深刻度→スコア）                                | リスク・機会（可能性×大きさ→スコア）      | 人の判断（インパクト／財務） | 結果                               |
| ---- | -------------------------------------------------------------- | ----------------------------------------- | ---------------------------- | ---------------------------------- |
| E1   | 負・実在・自社「製造拠点の GHG 排出」4/4/4 → 4.0               | リスク・中期「炭素価格」4×4 → 4.0         | 重要／重要                   | 両面                               |
| E2   | 負・潜在・上流「部材の化学物質流出」3/2/3, 可能性2 → 2.3       | リスク・短期 2×2 → 2.0                    | 重要でない／重要でない       | 重要でない                         |
| E3   | 負・実在・自社「水ストレス地域の取水」3/3/4 → 3.3              | リスク・中期「渇水時の操業制限」2×3 → 2.4 | 重要／重要でない             | インパクトのみ                     |
| E4   | 負・潜在・上流 2/2/3, 可能性2 → 2.2                            | リスク・長期 1×3 → 1.7                    | 重要でない／重要でない       | 重要でない                         |
| E5   | 負・実在・自社「製造工程の廃棄物」2/2/2 → 2.0                  | 機会・中期「再生材」2×2 → 2.0             | 重要でない／重要でない       | 重要でない                         |
| S1   | 負・潜在・自社・人権「長時間労働」4/3/3, 可能性3 → 3.3（人権） | リスク・中期「人材確保難」4×3 → 3.5       | 重要／重要                   | 両面                               |
| S2   | 負・潜在・上流・人権「調達先の強制労働」5/3/5 → 4.3            | リスク・短期 2×2 → 2.0                    | 重要／重要でない             | インパクトのみ                     |
| S3   | 負・潜在・自社「拠点周辺の騒音」2/1/1, 可能性2 → 1.6           | リスク・短期 1×2 → 1.4                    | 重要でない／重要でない       | 重要でない                         |
| S4   | 負・潜在・下流「製品不具合」4/2/3, 可能性1 → 1.7               | リスク・中期「リコール費用」2×5 → 3.2     | 重要でない／重要             | 財務のみ                           |
| G1   | 負・潜在・自社「贈収賄への関与」3/2/2, 可能性2 → 2.2           | リスク・中期「制裁金」2×5 → 3.2           | **未評価**                   | 未評価（E2E で「財務のみ」に判断） |

- 要求事項の適用（初期）: ESRS2×2 常に適用、E1×4・S1×2 両面、E3-4 インパクト、E5-5 対象外、G1×2 未判定（すべて暫定）→ 評価対象 9／12。
- 評価（3 観点 開示/データ/プロセス、AI 候補、人の確定）: GOV-1 おおむね/対応済み/おおむね・AI あり・確定済み、SBM-3 一部×3・AI のみ（確認待ち）、E1-1 一部/未対応/一部・人が確定、
  E1-4 未対応/未対応/一部・AI のみ、E1-5 おおむね/対応済み/おおむね・確定済み、S1-6 対応済み/対応済み/おおむね・確定済み、S1-9 一部×3・AI のみ、
  E1-6・E3-4・E5-5・G1-1・G1-4 は未確認（行はあるが AI 未実行）。
- 対応計画 2 件: E1-4「GHG 削減目標を移行計画と整合させる（架空）」開示・経営企画部・高・対応中、
  S1-9「EU・JV 拠点の女性管理職比率を収集する（架空）」データ・人事部・中・未着手・`linked_metric_code='female_manager_ratio'`（収集画面に初期行が出る）。
- 開示ドラフト: ESRS2 は人が確定済み（架空本文 300 字程度）、S1 は AI 草案のみ（本文未採用）、他は未作成。

### 9.4 サービスと画面

**ルート**（表中の `/csrd` は `/enterprise/disclosures/csrd`。静的セグメントは既存の `csrd/[questionId]` より優先される。項目 ID は UUID なので衝突しない）

| ルート                                                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/enterprise/disclosures/csrd`（対応状況）                     | 見出し「CSRD 開示対応（ESRS）」・「初年度対応」・サンプル（架空）とダブル・マテリアリティのバッジを維持。工程（`SsbjFlow` を再利用）①設定（報告範囲・DMA）②要求事項の評価 ③対応計画 ④データ収集 ⑤開示ドラフト。DMA 要約（結果別の事項数 n/10・確定状態）、適用の内訳 n/12、評価対象の 3 観点の件数、確認待ち・優先度「高」の件数、整合チェック（既存）。**表は既存のギャップ分析表 1 つだけ**（`aria-label="ESRS 要求事項とデータの対応"`、12 行）。コードのリンク先は要求事項詳細へ変更 |
| `/csrd/settings`                                               | 3 手順＋確定: ①報告範囲（SSBJ と同じ部品）②評価方法・閾値・ステークホルダー関与 ③DMA（10 事項の表: IRO 数・インパクト/財務の最大スコアと閾値判定・算定結果・人の結果・判断者/日時、5×5 のマトリクス〔ラベル付き、表と同じ内容〕）。SSBJ（単一・財務）との違いの注記                                                                                                                                                                                                                      |
| `/csrd/settings/matters/[topic]`                               | 1 事項の IRO 一覧・追加・編集・削除（論理削除）と、軸ごとの判断フォーム（重要／重要でない／未評価＋根拠）。算定結果は「提案（自社の方法・閾値）」と表示。`[topic]` は ESRS_TOPICS 以外 404                                                                                                                                                                                                                                                                                               |
| `/csrd/requirements`                                           | 12 行: コード・節・適用（常に適用／適用＋観点バッジ／対象外／未判定、暫定表示）・3 観点・総合・優先度・AI 候補・担当者確認。URL 絞込 `?applicability=&perspective=&coverage=&priority=&review=awaiting`。AI ギャップ分析（一括は不要、詳細で 1 件ずつ）                                                                                                                                                                                                                                  |
| `/csrd/requirements/[itemId]`                                  | 適用の根拠（事項・観点・判断根拠の抜粋・事項ページへのリンク／ESRS2 は「重要性に関わらず適用」）、3 観点の人の入力、AI ギャップ分析（候補）＋「候補を採用」「修正して確定」、対応付いた指標の当期データ、対応計画の一覧と追加、**回答（版・承認）**の状態と「回答を編集（版・承認）」→ `/csrd/{itemId}`                                                                                                                                                                                  |
| `/csrd/[questionId]`（既存）                                   | 回答・版・承認・AI 回答ドラフト（`question-view.tsx`）をそのまま残す。`backLink` 任意 prop を追加し「要求事項の評価へ戻る」→ 要求事項詳細（CDP は prop 無しで不変）                                                                                                                                                                                                                                                                                                                      |
| `/csrd/plans`                                                  | CSRD の計画だけ: 対応内容・関連する要求事項（詳細へ）・観点・対応区分・担当・期限（残日数）・対応状況・優先度、状態の更新。対象外になった要求事項の計画には「対象外の要求事項」バッジ                                                                                                                                                                                                                                                                                                    |
| `/csrd/collection`                                             | 評価対象の要求事項 × 対応指標 × 拠点の当期状況（承認済み／レビュー中／提出待ち／未入力、値は承認済みのみ）と、計画から作成した収集項目。計画から収集項目を作成。右上「CSRD 開示ドラフト」                                                                                                                                                                                                                                                                                                |
| `/csrd/draft`                                                  | マスターに要求事項がある節（ESRS2・E1・E3・E5・S1・G1）ごとのカード: 適用状況と観点、AI 草案（デモ生成）→「本文に採用」（人）→ 本文編集・保存 → 確定（人）。対象外・未判定の節は生成不可と理由を表示。右上に「定性情報」へのリンク                                                                                                                                                                                                                                                       |
| `/enterprise/analysis`                                         | `/enterprise/analysis/diagnosis` へ redirect                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/enterprise/analysis/diagnosis`・`/regulations`・`/benchmark` | §9.5・§9.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**CSRD サービス**（Stage A。`import 'server-only'`。読込は `enterprise.disclosure.read`（write でも可、narrative と同じ）、書込は `enterprise.disclosure.write`、AI は加えて `enterprise.ai.run`、
収集項目は加えて `enterprise.metric.manage`。**読込関数は一切書かない**。行が無ければ既定値の仮想行として返し、最初の保存で作る）

| ファイル                                | 関数                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/domain/csrd.ts`（純関数）      | `ESRS_TOPIC_LABEL`・`CSRD_SECTION_LABEL`・`DMA_OUTCOME_LABEL`・`csrdSectionOfItem(item)`・`dmaOutcome(impact, financial)`・`perspectivesOf(outcome)`・`deriveCsrdApplicability(section, matter, dmaConfirmed)`                                                                                                        |
| `src/lib/domain/dma.ts`（純関数）       | `iroSeverity`・`iroImpactScore`・`iroFinancialScore`・`calcMatterAxes(iros, thresholds)`・`validateIroShape(input)`・期間/段階のラベル                                                                                                                                                                                |
| `src/lib/services/csrd/core.ts`         | `loadCsrdContext(db, ctx, period)`（版・12 項目・対応指標・設定・事項＋IRO・評価・計画をまとめて読む。マスター無しは null）                                                                                                                                                                                           |
| `src/lib/services/csrd/settings.ts`     | `loadCsrdSettings`・`saveCsrdBoundary`・`saveCsrdMethod`・`upsertCsrdDmaIro`・`deleteCsrdDmaIro`・`decideCsrdDmaMatter`・`confirmCsrdDma`（書込はすべて確定を解除。確定は条件不足なら ValidationError）                                                                                                               |
| `src/lib/services/csrd/requirements.ts` | `loadCsrdOverview`・`loadCsrdRequirementViews`・`filterCsrdRequirements`・`loadCsrdRequirementDetail`・`saveCsrdAssessment`（人の 3 観点。final_status=combineCoverage、reviewed_\*）・`runCsrdGapAnalysis`（ai_\* だけ書く）・`reviewCsrdAssessment`（approved=AI 候補 3 観点を写す／modified=人の値＋コメント必須） |
| `src/lib/services/csrd/plans.ts`        | `createCsrdActionPlan`（評価対象の要求事項のみ。評価行が無ければ作る）・`updateCsrdActionPlan`・`loadCsrdActionPlans`・`createCsrdCollectionItem`・`loadCsrdDataCollection`                                                                                                                                           |
| `src/lib/services/csrd/draft.ts`        | `loadCsrdDrafts`・`generateCsrdDraft`（評価対象の節のみ。`ai_body` だけ書く。確定済みの節は不可）・`adoptCsrdDraft`（ai_body→body、人）・`saveCsrdDraftBody`（確定を解除）・`confirmCsrdDraft`（DMA 確定済み・本文あり）                                                                                              |
| `src/lib/services/collection-item.ts`   | `ensureMetricAssignment(db, ctx, { framework, description, ... })` を ssbj-gap.ts の `createDataCollectionItem` から**挙動を変えずに**抽出（SSBJ は `['ssbj']`・既存文言、CSRD は `['csrd']`・「CSRD 対応計画「…」から作成したデータ項目」）                                                                          |

`CsrdRequirementView = { item, section, applicability: { kind: 'always'|'material'|'not_material'|'undetermined', perspectives, provisional, reason }, assessment | null, combined, priority | null（評価対象のみ。evaluatePriority を materiality=always/material→material 等に写して再利用）, awaitingReview, plans, metrics, dataCoverage, missingMetrics, response: { id, status } | null }`。
純関数 `combineCoverage`・`coverageRate`・`evaluatePriority`・ラベル類は `src/lib/domain/ssbj.ts` を再利用し、SSBJ の文言（「SSBJ」「一般/気候」）は使わない。
共通部品 `src/app/enterprise/disclosures/csrd/_components/csrd-badges.tsx`（Stage A）: `ApplicabilityBadge`・`PerspectiveBadges`・`DmaOutcomeBadge`・`ProvisionalBadge`・`SampleMasterBadge`（すべてラベル＋アイコン）。

Server Action は画面ごとの `actions.ts`（`settings/`・`requirements/`・`plans/`・`collection/`・`draft/`）に置き、入力の取り出しと
`revalidatePath('/enterprise/disclosures/csrd', 'layout')`・`revalidatePath('/enterprise/analysis', 'layout')` だけを行う。
既存 `src/app/enterprise/actions.ts` の `revalidateDisclosure`（CSRD 回答）にも同じ 2 つを足す（Stage A）。フラッシュのキー（`csrdBoundarySaved`・`csrdMethodSaved`・`csrdIroSaved`・
`csrdIroDeleted`・`csrdMatterDecided`・`csrdDmaConfirmed`・`csrdAssessmentSaved`・`csrdGapAnalyzed`・`csrdReviewSaved`・`csrdPlanCreated`・`csrdPlanUpdated`・`csrdCollectionCreated`・
`csrdDraftGenerated`・`csrdDraftAdopted`・`csrdDraftSaved`・`csrdDraftConfirmed`）は Stage A が `flash.tsx` に登録する。

**AI（2 Use Case を追加。Mock は「デモ生成」と表示。AI の出力は候補列にだけ入り、人の操作で確定値になる）**

| Use Case              | 出力                                                                                                                                                     | 書く先                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `csrdGapAnalysis`     | `ssbjGapAnalysisSchema` と同形（3 観点・comment・missingInformation・recommendation・資料位置・confidence/warnings/sources）                             | `csrd_assessments.ai_*` のみ            |
| `csrdDisclosureDraft` | `{ section: CSRD_SECTIONS, perspectives: ('impact' \| 'financial')[], body, coveredItemCodes, gaps[{itemCode, reason}], confidence, warnings, sources }` | `csrd_disclosure_drafts.ai_body` 等のみ |

登録（CLAUDE.md §6、Stage A）: `AI_FEATURE_TYPES`（domain.ts）、`schemas.ts`（スキーマ・対応表・`PROMPT_VERSIONS` = `csrd-gap-analysis@2026-10-01.1`・`csrd-disclosure-draft@2026-10-01.1`、
`aiSourceSchema.kind` に `dma_matter`・`dma_iro` を追加）、`prompt.ts`（ESRS・ダブル・マテリアリティ。入力は許可された要求事項・承認済み値・DMA 結果のみ。Secret なし）、
`mock-provider.ts`（決定論的。草案は観点を明示〔例: 両面の事項は「インパクトと財務の両面で重要と判断（架空）」〕・600 字以内・「（架空）」付き）、
`src/app/enterprise/ai/page.tsx` の表示名（CSRD ギャップ分析／CSRD 開示ドラフト）、`tests/unit/ai-schema.test.ts` の入力。

出力: 新規なし（CSRD 回答の DOCX は既存のレポート経路のまま）。節ドラフトの DOCX 出力は P1。

### 9.5 他社比較（誠実さの規則）

- データ: `src/lib/benchmarks/demo-peers.ts`（静的・DB 表なし・`organization_id` なし）。**Demo Mode のときだけ**使う（ページで `isDemoMode()` を判定し、サービスに `source: 'demo' | 'none'` を渡す）。
  Supabase モードは「比較データが登録されていません」の空状態。**他テナント（蒼天マテリアル等）の値は決して使わない**。
- 画面の先頭（バナー）と表の caption に必ず「**架空の比較データ（デモ用）。実在企業の数値ではありません**」（FlaskConical＋文言）。
- 形: `DemoPeer { id, name: 'ピアA社（架空）'…'ピアE社（架空）', industry: '電子部品（架空・同業想定）', sizeBand }`、
  `DemoPeerValue { peerId, metricKey, fiscalYear: 'FY2025', fiscalYearEndMonth: 3 | 12, value | null, unit, boundary: '連結' | '単体', method | null, assured, note? }`。
- 自社の値: kpi.ts と同じ「最新の確定年度」（FY2025）の `computeConsolidatedAggregation`（承認済み・持分調整後）。比率は `weightedAverage` のみ（`consolidated` の単純合計は使わない）。
  無い・算定できない値は「未算定」「全社値は算定不可」と表示（Scope2 ロケーション基準・Scope3 合計〔Cat.1 を全量として扱わない〕・賃金・LTIFR・離職率）。
- 比較の可否 `peerComparability(own, peer)`（`src/lib/domain/benchmark.ts`、kpi.ts の `targetComparability` を手本）: 単位・境界・算定方法/定義・年度・決算月のどれかが違えば**比較対象外**とし理由を表示。
  換算しない（比率↔格差率、マーケット↔ロケーション、LTIFR の 100 万時間↔20 万時間）。第三者保証の有無は注記（可否には使わない）。
- 集計は比較可能な社だけ: 社数 n を必ず表示、中央値は n≥3 のときだけ、範囲（最小〜最大）。**順位・総合スコアは出さない**。色で良し悪しを示さない。原単位（売上高・従業員当たり）は出さない
  （売上高の指標が無く、従業員数の集計方法が揃っていることを確認できないため）。

| 指標（単位）                  | A（連結・3月・保証あり） | B（連結・**12月**） | C（**単体**） | D（連結・3月）        | E（連結・3月・保証なし） |
| ----------------------------- | ------------------------ | ------------------- | ------------- | --------------------- | ------------------------ |
| Scope1（t-CO2e）              | 12,400                   | 6,850               | 3,920         | 9,760                 | 15,300                   |
| Scope2 マーケット（t-CO2e）   | 25,100                   | 18,300              | 9,880         | 未開示                | 31,200                   |
| Scope2 ロケーション（t-CO2e） | 27,900                   | 20,050              | 10,400        | 24,600                | 未開示                   |
| エネルギー（MWh）             | 61,500                   | 39,800              | 18,200        | 52,300                | 70,100                   |
| 取水量（m3）                  | 310,000                  | 198,000             | 95,000        | 260,000               | 未開示                   |
| 廃棄物（t）                   | 3,850                    | 2,100               | 880           | 3,300                 | 4,420                    |
| 女性管理職比率（%）           | 12.4                     | 18.9                | 9.7           | 14.2                  | 11.0                     |
| 女性役員比率（%）             | 18.2                     | 25.0                | 10.0          | 16.7                  | 12.5                     |
| 男女の賃金（%、女性÷男性）    | 74.1                     | 71.5                | 77.0          | 26.3（**格差率**）    | 72.8                     |
| LTIFR                         | 0.62（100 万時間）       | 0.35                | 0.80          | 0.18（**20 万時間**） | 0.71                     |
| 離職率（%）                   | 5.9                      | 7.2                 | 4.1           | 6.5                   | 8.0                      |

（Scope3 合計は全社とも「未開示」とし、自社も未算定のため比較しない。）

### 9.6 現状診断・規制対応度の規則

共通: 閲覧専用（書かない。`loadSsbjOverview`/`loadSsbjRequirementViews` は表示時に行を作るため**使わない**）。`assertEnterpriseWorkspace` と権限を新サービス側で必ず検査
（既存の `loadEnterpriseDashboard`・`computeConsolidatedAggregation` は検査しないため）。**単一の総合点・「準拠率」は出さない**。割合を出すときは必ず「n / 分母 件」を併記。
未入力・未収録を 0 として扱わない。各領域・各行に直すための画面へのリンクを置く。

**現状診断**（`src/lib/services/analysis/diagnosis.ts` `loadDiagnosis(db, ctx, { period, periods, units, metrics, referenceDate? })`、`enterprise.data.read`）。
領域の状態は「不足あり（TriangleAlert）／確認待ちあり（Clock）／不足なし（CircleCheck）／算定対象外（CircleMinus＋理由）」で、点数にしない。

| 領域               | 出所                                                | 示す事実（分母付き）と状態の規則                                                                                                              | リンク                           |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| データ収集・承認   | `loadEnterpriseDashboard`                           | 承認済み n/Data Point 総数、未提出・レビュー待ち・検証エラー件数、拠点別 承認 n/N。未提出か検証エラー>0 → 不足あり、レビュー待ち>0 → 確認待ち | /enterprise/data・/workflows     |
| 証跡・承認の健全性 | 同上                                                | 証跡不足・承認済み要再確認・承認後変更・期限超過タスク。いずれか>0 → 不足あり                                                                 | /enterprise/alerts・/evidence    |
| GHG 算定の網羅性   | `computeConsolidatedAggregation`・`summarizeScope3` | Scope1・Scope2（マーケット）・Scope2（ロケーション）の承認済み拠点 n/N、Scope3 カテゴリ n/15・合計は未算定（Cat.1 を全量にしない）            | /enterprise/ghg・/ghg/suppliers  |
| 定性情報           | `listNarratives`（disclosure.read のときだけ）      | 確認済み n/全件、不足項目のある下書き件数、要再確認件数                                                                                       | /enterprise/narratives           |
| 開示対応（基準別） | 規制対応度サービス（disclosure.read のときだけ）    | 基準ごとの 1 行要約（下表の数値）                                                                                                             | /enterprise/analysis/regulations |

権限の無い領域は出さず、「閲覧権限が無い領域は表示していません」と 1 行示す。

**各規制への対応度**（`src/lib/services/analysis/regulations.ts` `loadRegulatoryCoverage(db, ctx, period)`、`enterprise.disclosure.read`。行の順 SSBJ・CSRD・ESRS-40a・CDP・MSCI・FTSE）:

| 列             | 内容                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置付け       | 公表済み／公開草案に基づく準備／サンプル（架空）／**今後対応予定**（マスター無し）。`frameworkLegalLabel` を使い、ラベル＋アイコン                                                    |
| 重要性の考え方 | `MATERIALITY_BASIS_LABELS`（SSBJ 財務的重要性／CSRD ダブル・マテリアリティ／40a インパクト重要性／未登録）                                                                            |
| 収録状況       | `FRAMEWORK_COVERAGE_STATUS_LABELS` と件数（SSBJ 133・CSRD 12・40a 0・CDP 2026 12）                                                                                                    |
| 評価対象       | SSBJ: 設定の基準で絞った要求事項のうち適用かつ重要性なし以外。CSRD: 常に適用＋重要（暫定の有無を併記）。CDP: 全項目                                                                   |
| 状況の内訳     | 評価対象のうち 対応済み/おおむね/一部/未対応/未確認 の件数、**人が確認済み n**、**AI 判定のみ n**（SSBJ は ssbj_assessments を読むだけ。重み付きの「対応度%」は出さない）             |
| 回答           | CDP・CSRD: 承認済み n/全項目（基準ごとの回答だけを数える。`cdpReadiness` は CDP と CSRD を混ぜ下書きを準備済みと数えるため使わない）                                                  |
| 算定しない理由 | ESRS-40a「要求事項が未収録（公開草案）のため算定しない」、MSCI・FTSE「評価項目マスター未収録のため算定しない」（0% と出さない）、CSRD「改正 ESRS（2026-07-03 採択・未発効）は未収録」 |

### 9.7 テスト

先に書く（CLAUDE.md §3）。期待値は緩めない。既存テストの更新は**意図した形を厳密に固定**する。

- unit: `nav-config.test.tsx`（従来ツリーの形に 定性情報・CSRD 5 子・分析 3 子〔規制対応度の permission〕を追加、開示優先の最上位順
  `…タスク・承認, 分析, 管理, AI Copilot`、開示優先の全 href で aria-current がちょうど 1 つのループ、`/enterprise/narratives` は「情報・根拠」側だけ、
  `/csrd/{uuid}` は「要求事項」、従来ツリーの `/enterprise/narratives`→['定性情報']・`/csrd/plans`→['対応計画']・`/analysis/regulations`→['規制対応度']、GHG＋Cat.1 の既存テストは不変）、
  `csrd-domain.test.ts`（12 コードの節判定・結果表・適用と観点・暫定）、`dma-scoring.test.ts`（式・丸め・閾値ちょうど＝重要・人権優先・不正な形の拒否）、
  `benchmark-comparability.test.ts`（理由ごとに対象外、換算しない、n<3 で中央値なし）、`ai-schema.test.ts`（2 Use Case）。schema-parity は自動で効く。
- integration: `csrd-settings.test.ts`（根拠必須・書込で確定解除・確定条件・他組織と権限なしは拒否）、`csrd-requirements.test.ts`（fixture の適用導出、G1 判断で 2 件が「適用（財務）」へ、
  AI は `ai_*` 以外を変えない、採用/修正）、`csrd-plans-draft.test.ts`（計画・収集項目〔新規指標の frameworks=['csrd']〕・草案は評価対象の節だけ・`ai_body` のみ・採用・確定条件）、
  `csrd-isolation-from-ssbj.test.ts`（CSRD の書込前後で SSBJ の対応状況・計画・収集・ドラフトの出力が同一）、`csrd-demo-persistence.test.ts`（CSRD の編集が Fixture 作り直し後も Cookie から戻る）、
  `analysis-*.test.ts`（分母、MSCI/FTSE は未収録、CDP と CSRD を混ぜない、比率は weightedAverage のみ、Supabase 相当は空、他テナントの値なし）、
  **書込検知ラッパー**（insert/update/delete で例外を投げる DbClient）で CSRD と分析の全読込関数が書かないこと。既存 `csrd.test.ts`・`ssbj-*.test.ts`・`disclosure-demo-reset.test.ts`（リセット対象に CSRD 6 表）を通す。
- RLS（`tests/rls/tenant-isolation.test.ts`）: 6 表それぞれ 他組織メンバーは読めない・書けない、`enterprise.disclosure.write` の無い役割は書けない、同組織の書込者は書ける、
  `csrd_assessments` に SSBJ の item_id は入らない（ガードトリガ）、他組織の matter_id／assessment_id は複合 FK で拒否。`pnpm check:rls` で 106 表。
- E2E:
  - `nav-structure.spec.ts`: 最上位に「分析」、SSBJ・CSRD・分析の子は `getByRole('list', { name })` で範囲を絞って厳密名で確認、
    SSBJ の順は `slice(ssbjIndex+1, ssbjIndex+7)` = 対応状況/要求事項/対応計画/データ収集/定性情報/開示ドラフト、CSRD は 5 項目、データ収集の href は SSBJ・CSRD それぞれ。
  - `disclosure-first-nav.spec.ts`: 従来メニューの最上位に「分析」を追加、「開示ドラフト」は SSBJ のリストに絞る、従来メニューの SSBJ に 定性情報（/enterprise/narratives）。
  - `csrd.spec.ts`: 行数はギャップ分析表（名前付き）に絞って 12 のまま、ESRS-E1-5 → 要求事項詳細 →「回答を編集（版・承認）」→ 回答画面で AI ドラフト（以降は現行どおり）。
  - `analysis.spec.ts`: メニューから 3 画面、分母の表示、MSCI/FTSE「今後対応予定」、架空バナー、比較対象外の理由、どの画面にも「準拠率」が無い、axe（serious/critical なし）。
  - `zzz-csrd-chain.spec.ts`（serial、通常 E2E と `playwright.stateless.config.ts` の両方）: 開始時に持ち回し Cookie を捨てる（`resetCarriedDemoState()` を helpers に追加）→
    対応状況（DMA 未確定・暫定）→ 設定 G1 で インパクト=重要でない・財務=重要＋根拠 → DMA 確定 → 要求事項で G1-1/G1-4 が「適用（財務）」・暫定が消える →
    E1-6 詳細で AI 分析（デモ生成）→ 候補を採用 → 対応計画を追加 → 計画画面で対応中へ → 収集画面で scope2_location の収集項目を作成 →
    開示ドラフト E1 を生成 → 本文に採用 → 保存 → 確定（「両面」の文言、E5 は対象外表示）→ 要求事項詳細から回答画面へ。各テスト後 `carryDemoState`（押し出し 0）。
  - `full-audit.spec.ts` のルート一覧に CSRD 6 画面と分析 3 画面を追加。
- 本番スモーク（`production-smoke.spec.ts`）: ナビの厳密名ループを SSBJ のリストに絞る、CSRD 6 画面・分析 3 画面が開く、他社比較に架空バナー、CSRD 設定に「ダブル・マテリアリティ」。

### 9.8 並行実装計画

**Stage A（1 エージェントで順に。B の前提）**: 0044〜0046・domain.ts 型・table-names/types/store/to-sql/seed・RLS テストと `check:rls`、
`domain/csrd.ts`・`domain/dma.ts`、fixture `fixtures/csrd.ts`（＋`CSRD_SAMPLE_VERSION_METADATA.materialityBasis='double'`）、`services/csrd/*`・`services/collection-item.ts`（SSBJ からの抽出）、
AI 2 Use Case の登録一式、`PERSISTED_TABLES`・`DISCLOSURE_DEMO_RESET_TABLES`、`flash.tsx` のキー、`enterprise/actions.ts` の revalidate、`csrd/_components/csrd-badges.tsx`、
§9.7 の Stage A 分（unit・integration・RLS）。完了条件: lint・typecheck・`pnpm test`・`pnpm test:rls`・`pnpm check:rls` 合格。

**Stage B（並行。他スライスの所有ファイルは編集しない。A の所有ファイルに変更が要るときは編集せず差分案を残し C で適用）**

| スライス                         | 所有ファイル                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 ナビ                          | `src/components/shared/nav-config.ts`・`sidebar.tsx`（・必要なら `command-palette.tsx`）、`tests/unit/nav-config.test.tsx`、`tests/e2e/nav-structure.spec.ts`、`tests/e2e/disclosure-first-nav.spec.ts`                                     |
| B2 分析                          | `src/app/enterprise/analysis/**`、`src/lib/services/analysis/**`、`src/lib/domain/benchmark.ts`、`src/lib/benchmarks/demo-peers.ts`、`tests/unit/benchmark-*.test.ts`、`tests/integration/analysis-*.test.ts`、`tests/e2e/analysis.spec.ts` |
| B3 CSRD 対応状況・設定・要求事項 | `src/app/enterprise/disclosures/csrd/page.tsx`・`settings/**`・`requirements/**`・`[questionId]/page.tsx`、`src/app/enterprise/disclosures/question-view.tsx`（`backLink` 任意 prop のみ）、`tests/e2e/csrd.spec.ts`                        |
| B4 CSRD 対応計画・収集・ドラフト | `src/app/enterprise/disclosures/csrd/plans/**`・`collection/**`・`draft/**`                                                                                                                                                                 |

共有ファイルの所有: Stage A = 上記 A の全ファイル（`types/domain.ts`・migrations・fixtures・repositories・`ai/*`・`flash.tsx`・`enterprise/actions.ts`・`services/csrd/*`・`services/ssbj-gap.ts`〔抽出のみ〕・
`csrd/_components/*`・`ai/page.tsx`）。Stage C = `tests/e2e/helpers.ts`・`zzz-csrd-chain.spec.ts`・`playwright.stateless.config.ts`・`full-audit.spec.ts`・`tests/e2e-production/**`・docs・`AI_HANDOFF.md`。
B2 の規制対応度は B3 の画面を待たず、A の `loadCsrdRequirementViews` だけを使う。B1 のリンク先が B2〜B4 完了まで 404 でも B1 の単体テストは通る（E2E は C で通す）。

**Stage C（統合）**: A からの差分案の適用、`zzz-csrd-chain.spec.ts`・stateless 構成・full-audit・本番スモークの更新、7 コマンド（E2E は単独実行、ポート衝突時は `E2E_PORT`）と
`pnpm test:e2e:stateless`（Cookie ヘッダー最大値と押し出し 0 を記録）、`docs/known-limitations.md`（0044〜0046 のロールバック方針: 追加のみのため逆順に DROP。CSRD の編集が Cookie 依存である旨は D-3 に追記）、
本節の「実施結果」と `AI_HANDOFF.md` の追記。デプロイは依頼があるときだけ（Demo Mode、環境変数なし）。

P1 に残すもの: DMA の AI 候補、サブトピック単位・企業固有の事項、対象外の要求事項の任意開示、40a への DMA インパクト側の反映、節ドラフトの DOCX、DMA 確定の承認権限（approve）への引き上げ、
`ssbj_assessments` と `csrd_assessments` の汎用化（開示プロジェクトの要求事項タブとの統合）、改正 ESRS の収録。
