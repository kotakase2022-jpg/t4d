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

### 9.9 実施結果（2026-10-01）

| 要望 | 実装（D0・架空データ）                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | 従来メニューの SSBJ 配下を 対応状況／要求事項／対応計画／データ収集／**定性情報**／開示ドラフト に（`/enterprise/narratives`）。開示優先メニューでは「情報・根拠 → 定性情報」を正規の位置とし、SSBJ 配下は別導線（現在地は 1 つだけ）                                                                                                                                                                                                       |
| ②    | 「AI Copilot」と「管理」の間に **分析**（現状診断／規制対応度／他社比較）。単一の総合点・準拠率は出さず、すべて分母付き。未収録の基準（ESRS-40a・MSCI・FTSE）は算定しない。他社比較は**架空の比較データ（デモ用）**で、比較条件（単位・境界・定義・年度・決算月）が違えば比較対象外と理由を出す。他テナントの値は使わない                                                                                                                   |
| ③    | CSRD を SSBJ と同じ 5 画面（対応状況／要求事項／対応計画／データ収集／開示ドラフト）＋設定に再構成。設定で**ダブル・マテリアリティ評価**（10 事項 × インパクト／財務の 2 軸、IRO・自社の閾値・算定は提案、判断と確定は人）。要求事項の適用は DMA から導出し、どの観点で適用になったかを行ごとに表示（ESRS 2 は常に適用、DMA 確定前は暫定）。SSBJ（シングル・財務）との違いを設定・要求事項画面に明示。CSRD の表は SSBJ と分離（0044〜0047） |

検証（最終）:

| コマンド                                                   | 結果                                            |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `pnpm lint` / `format:check` / `typecheck` / `build`       | 合格                                            |
| `pnpm test`                                                | 1,688 件合格（135 ファイル）                    |
| `pnpm test:rls` / `check:rls`                              | 311 件合格 / 106 表・RLS 有効 106・ポリシー 240 |
| `pnpm test:e2e`（単独）                                    | 308 件合格                                      |
| `pnpm test:e2e:stateless`                                  | 25 件合格（押し出し 0）                         |
| 本番スモーク `pnpm test:e2e:prod`                          | 32 件合格                                       |
| 本番で実演の流れ（主デモ 8 手順＋CSRD 9 手順、1 ブラウザ） | 17/17 合格（Cookie ヘッダー最大 8.9KB）         |

自己監査 1 巡（5 観点）で 35 件を指摘・反証し、36 件（指定 1 件を含む）を修正した（主なもの: CSRD の AI 候補が値のある指標数ではなく行数でデータ観点を「対応済み」にしていた、DMA の変更後も節ドラフトが確定のまま残った、
見ていない AI 候補・本文を採用・確定できた、確定者・判断者の列を偽装できた〔0047〕、主デモと CSRD デモを同じブラウザで続けると Cookie から押し出された）。

CSRD・分析の実演（約 5 分）: 開示対応 → CSRD → 対応状況（DMA 未確定・暫定）→ 設定で G1 を判断して DMA を確定 → 要求事項で G1 が「適用（財務）」に →
E1-6 の AI ギャップ分析（デモ生成）→ 候補を採用 → 対応計画 → データ収集 → 開示ドラフト（E1 を生成・採用・確定、E5 は対象外）。分析 → 現状診断／規制対応度／他社比較。
終了時はホームの「開示デモを初期状態に戻す」（CSRD の DMA・評価・計画・草案も戻る）。画面: `docs/assets/csrd-analysis/`。

残課題: 節ドラフトの Word 出力（C-1）、他社比較の年度付きリンク（C-4）、実在企業の比較データ（C-6）、DMA の AI 候補・サブトピック単位・企業固有の事項、改正 ESRS の収録、
主デモと CSRD デモを続けた場合の Cookie 余裕が小さい（約 11KB / 11.4KB。押し出し時はヘッダーに表示）。0044〜0047 は本番 Supabase 未適用。

---

## 10. 2026-10-02 追加要望（CSRD 定性情報・自社経年比較・財務影響分析・UI の簡潔化）

発注者要望（2026-10-02）: ① 従来メニュー CSRD の「データ収集」と「開示ドラフト」の間に「定性情報」（`/enterprise/narratives`）、
② 分析の「規制対応度」と「他社比較」の間に「自社経年比較」（直近 3 年の各指標の経年変化を一覧で見る）、
③ 「他社比較」の下に「財務影響分析」（システム内の定量・定性の非財務情報が、どの経路で・どの時間差で・財務のどこに影響するかを推定・可視化・シミュレーションする。外部の専門企業が提供してきた種類の分析）、
④ プロダクト全体の文字量を減らす（既定で閉じた折りたたみ・グラフ）。Vercel 本番（Demo Mode・環境変数なし、CLAUDE.md §0-7）まで反映する。

共通の決定: D0。**DB 表・マイグレーション・RLS・権限キー・npm 依存・AI Use Case を追加しない**（`check:rls` は 106 表のまま）。§0・§9 の不変条件
（架空データのみ・AI は確定しない・単一の総合点を出さない・未入力を 0 にしない・色だけで示さない・他テナントの値を使わない）はそのまま。
外部企業の名前は UI・コード・テストに書かない。

### 10.1 メニューの決定

| #   | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 従来ツリーの CSRD の子を 対応状況／要求事項／対応計画／データ収集／**定性情報**／開示ドラフト の 6 項目にする（`NARRATIVES_ITEM` を再利用。href は `/enterprise/narratives` 完全一致、権限 `enterprise.disclosure.read`）。§9.1 ③「定性情報は CSRD に入れない」は本要望で置き換える。開示優先ツリーは CSRD も `legacyItemWithSecondaryChild` で複製し、SSBJ・CSRD 配下の定性情報はどちらも secondary（正規の位置は「情報・根拠」のまま） |
| ②   | 分析の子を 現状診断／規制対応度／**自社経年比較**（`/enterprise/analysis/trends`、History）／他社比較／**財務影響分析**（`/enterprise/analysis/financial-impact`、Waypoints）の順にする。両ツリー共通（開示優先は `legacyItem` で共有）。2 画面とも nav の permission なし（`enterprise.data.read` は全 enterprise 役割が持つ）                                                                                                          |
| ③   | 財務影響分析は他社比較の**次の兄弟**（子ではない）。h1 はメニュー名と同じ（「自社経年比較」「財務影響分析」）、パンくずは 企業ワークスペース／分析／画面名。keywords: 経年比較 `経年・推移・前年比・年度比較`、財務影響 `財務・影響・シミュレーション・経路・炭素価格・シナリオ`                                                                                                                                                         |

```
従来ツリー                                   開示優先ツリー
開示対応 > CSRD                               開示プロジェクト > CSRD（同じ 6 子。定性情報は secondary）
  対応状況/要求事項/対応計画/                 情報・根拠 > 定性情報（正規の位置。唯一の現在地）
  データ収集/定性情報/開示ドラフト             分析（左と同じ 5 子）
分析
  現状診断/規制対応度/自社経年比較/他社比較/財務影響分析
```

**現在地の規則（従来ツリーで同じ href が SSBJ と CSRD の 2 か所に出る）**

- 2 階層目以下の現在地は木全体で 1 つ（§9.1 の保証を維持）。同点（同じ href の完全一致）は「優先枝」に一致する候補を選び、無ければ木の順（＝SSBJ）。
- 枝の識別子は祖先ラベルの経路（例 `開示対応 / CSRD`）。位置キーは権限で項目が隠れるとずれるため保存に使わない。
- `resolveNavCurrent(items, pathname, { mode, collapsed, preferredBranch?: string | null })`: 並びは rank 降順 → depth 降順 → 優先枝に一致 → 木の順。優先枝は同点の解消にだけ効く。
- 優先枝の保存: 新規 `src/components/shared/nav-branch.ts`。sessionStorage キー `t4d.sidebar.branch`。`readNavBranch()`・`rememberNavBranch(branch | null)`・
  `useNavBranch()`（`useSyncExternalStore`、**サーバースナップショットは null**）。読み書きはすべて try/catch（使えなければ null）。
- 書く時機: (a) サイドバーの 2 階層目以下のリンクを押したとき → そのリンクの親の経路。最上位のリンク → null（削除）。
  (b) 遷移後、現在地が「木に 1 回しか出ない href」の項目で、その親に重複 href の子があるとき → その親の経路
  （例: `/csrd/draft` を開いてから画面右上のリンクで定性情報へ → CSRD 側）。純関数 `branchToRemember(items, currentKeys): string | null | undefined`
  （undefined = 変えない）。Command Palette は書かない（(b) と既定に従う）。
- SSR と初回描画は null（＝SSBJ）で決定的。マウント後に保存値を当てる（サイドバーの折りたたみ状態と同じ扱い。表示が 1 回切り替わりうる）。
- 強調表示（グループ行の太字・最上位の背景）は現在地キーの祖先から決める（純関数 `isNavAncestorOfCurrent(key, currentKeys)`）。2 階層目以下に現在地が無い画面
  （設定・折りたたみ中）は従来の `isNavSubtreeActive(pathname)` に戻す。SSBJ と CSRD が同時に強調されない。
- 開示優先ツリー: 定性情報は「情報・根拠」だけが現在地（優先枝は無関係）。Command Palette: 従来は `開示対応 / SSBJ / 定性情報`・`開示対応 / CSRD / 定性情報` の 2 件、
  開示優先は `情報・根拠 / 定性情報` の 1 件。

テスト（Stage A。既存は新しい形を厳密に固定し直す。緩めない）:

- unit `nav-config.test.tsx`: 形（CSRD_CHILDREN に定性情報、ANALYSIS 5 子）、secondary は開示優先の SSBJ・CSRD 配下の定性情報 2 件、従来 `/enterprise/narratives` は
  優先枝なし → `['SSBJ / 定性情報']`・`開示対応 / CSRD` → `['CSRD / 定性情報']`・該当しない枝 → SSBJ、全 href ループ（従来 ≤1・開示優先 =1）、強調表示は片方だけ、
  `branchToRemember`（/csrd/draft → `開示対応 / CSRD`、/enterprise/narratives → undefined、/enterprise/ghg → undefined）、折りたたみ時は分析 5 画面とも「分析」、Command Palette の候補。
  新規 `nav-branch.test.ts`（storage 不可で null、書いた値が購読者に届く）。
- E2E `nav-structure.spec.ts`: CSRD リスト 6 リンク厳密・定性情報の href、分析リスト 5 リンク厳密（拠点担当は 現状診断／自社経年比較／他社比較／財務影響分析）、
  同名リンクの現在地（直接開く → SSBJ 側 1 つ、CSRD の定性情報を押す → CSRD 側だけ 1 つ、再読込しても CSRD、SSBJ の定性情報を押す → SSBJ）。
  `disclosure-first-nav.spec.ts`（CSRD 配下にも定性情報、現在地は情報・根拠だけ）。`analysis.spec.ts` のメニュー試験（:27-47）を 5 画面に。

### 10.2 自社経年比較（`/enterprise/analysis/trends`）

**値の源（ESG経営・他社比較と食い違わない）**: Stage A が `src/lib/services/kpi.ts` を一般化する（**挙動不変**。`esg-kpi`・`self-audit-values` の期待値は変えない）。

- `loadMetricYearStates(db, ctx, { metricCodes, periodIds })` → `{ periods（startDate 昇順）, rows: { metric, years: { period, state: MetricPeriodState, display: KpiDataState }[], changes: YoyResult[] }[] }`。
  `changes` は隣接年（古 → 新）。中身は既存の `loadKpiData`（指標コードを引数化、既定 `ALL_KPI_METRIC_CODES`）・`metricPeriodState`・`describeState`・
  `comparisonConditionChanges`・`retroactiveNotes`。`loadKpiDetail` の前年比も同じ補助関数を使うよう置き換える。`assertEnterpriseWorkspace`＋`enterprise.data.read`。読むだけ。
- 全社値: 合計 ＝ 承認済みの連結値（持分調整・内部取引控除後）、比率 ＝ 分子・分母の weightedAverage、それ以外
  （turnover_rate・ltifr・gender_pay_gap・avg_tenure・training_hours・directors_count）＝「全社値は算定不可」（拠点値は内訳に出す）。
  推計・前年値補完・目標・途中合計は**値の欄と前年比に使わない**。

**年度の窓**: ヘッダー年度（Cookie）を終点に、startDate がそれ以前の組織の期間を新しい順に最大 3 つ（コードで並べない）。データの無い年度も列に出す。
3 未満なら「比較できる年度は n 年分（それ以前の報告期間なし）」。既定（FY2026）は FY2024／FY2025／FY2026。

**セルの状態**（純関数 `trendCellOf(state)`。バッジはラベル＋アイコン）:

| 状態                | 条件                                 | 表示                                              |
| ------------------- | ------------------------------------ | ------------------------------------------------- |
| `confirmed`         | complete かつ値あり                  | 数値（右寄せ）＋ sr-only「確定」                  |
| `incomplete`        | 未承認・未入力の拠点あり             | 「集計中（承認済み n/N 拠点）」Clock              |
| `estimate_included` | 推計の拠点だけが残る                 | 「推計を含む（実績 n/N 拠点）」FlaskConical       |
| `not_entered`       | 行なし                               | 「未入力」CircleDashed（0 と書かない）            |
| `not_computable`    | 集計方法が合計できない               | 「全社値は算定不可」CircleMinus                   |
| `not_applicable`    | 全拠点が対象外と判断                 | 「対象外と判断」                                  |
| `no_actual`         | 承認済みだが実績値なし（目標のみ等） | 「承認済みの実績なし」                            |
| `unit_mismatch`     | 承認済みの寄与行の単位 ≠ 指標の単位  | 「単位の確認が必要」TriangleAlert（値を出さない） |

**前年比（隣接年ごと）**: `changes[i]` が ok かつ `basisChangeReasons(prev, cur)` が空のときだけ数値を出す。単位が % の指標は「±x.xx pt」（相対 % を出さない）、
それ以外は「±x.x%（±差 単位）」、前年 0 は差だけ。ArrowUp／ArrowDown／Minus（aria-hidden）＋符号＋数値、**中立色**（良し悪しは指標で逆になるため赤緑にしない）。
`large`（|差|/|前年| > `metric.yoyWarningRatio`。閾値の無い指標は常に false。data-point-rules.ts:175 と同じ）は「大きな変化」バッジ。
needs_check は既存の NeedsCheckBadge（理由は内訳）。unavailable は「—」＋ sr-only の理由。

`basisChangeReasons(prev, cur)`（純関数。経年比較だけで使い、ESG経営への適用は P1）: (a) 承認済みの内部取引行（boundary「内部取引」・factor>0）が片方の年度だけにある
（scope3_cat1 FY2025→FY2026 が該当。素の比較は −0.2%、控除を揃えると約 +5% で逆の印象になる）、(b) 寄与行の単位 ≠ 指標の単位、(c) 期間の月数か決算月が違う。

**画面**（§10.4 の部品で文字を減らす）:

1. PageHeader: 説明「直近 3 年度の確定値を指標ごとに並べます」、help に窓の決め方・年度はヘッダーで切り替えること。
2. 要約チップ（絞込リンクを兼ねる。分母付き、総合点なし）: 比較できた指標 n / N（データのある指標）・大きな変化 n・比較条件の確認が必要 n・最新年度が集計中 n。
3. Collapsible「比較の決まり」（既定で閉じる）: 確定値のみ／合計＝連結値／比率＝加重平均／推計・目標・途中合計は比べない／Scope2 マーケットとロケーションは合算しない／Cat.1 は Scope3 全体ではない。
4. FilterBar（URL: `group`=ghg・environment・social・governance、`change`=compared・large・needs_check、`q`、`empty=1`）。
5. 表 1 つ（`t4d-scroll-x`、先頭列 sticky、群見出し行 GHG／環境／社会／ガバナンス。`trendGroupOf(category)`: ghg → GHG、energy・water・waste・climate_transition → 環境、
   human_capital → 社会、governance → ガバナンス）。列: 指標（単位）｜年度 ×3｜推移（`MiniBars`、decorative）｜前年比 ×2。
   指標セルに Collapsible「内訳」: 定義と集計方法、年度ごとの承認済み n/N と未承認の拠点、参考値（「承認済み分のみの途中集計（比較に使いません）」「参考: 推計込み」）、
   比較できない理由、算定不可の指標の拠点値、リンク（KPI 指標 `/enterprise/esg/{kpiKey}`、GHG `/enterprise/ghg`、全指標 `/enterprise/data?metric={id}`。一覧の年度は Cookie のためリンク文言に年度を書く）。
6. どの年度にもデータが無い数値指標は既定で隠し、「データが 1 年もない指標 n 件（0 ではありません）」＋「表示」リンク（`empty=1`）。text・boolean 指標は対象外。

デモで見えるもの（青海、既定 FY2026）: FY2024 は scope1・scope2・scope3_cat1 だけ（他は未入力）、FY2025 は 21 指標が確定、FY2026 は集計中が多い。
**fixture は拡張しない**（ghg-trend.test.ts:119-135・seed・保証件数への波及が大きい。薄いが誠実）。承認済みの異常値（officers_total 12→3 等）もそのまま出し、内訳から検証結果へリンク。

**ファイル（B1）**: `src/lib/domain/metric-trend.ts`（`TREND_GROUPS`・ラベル・`trendGroupOf`・`trendCellOf`・`basisChangeReasons`・`changeViewOf`・`filterMetricTrendRows`・`summarizeTrends`。
入力は構造型で受け、services を import しない）、`src/lib/services/analysis/trends.ts`（`loadMetricTrends(db, ctx, { period, periods })` → `{ periods, windowNote, rows, summary }`。
数値指標すべて〔deletedAt null〕を `loadMetricYearStates` で 1 回に読む。書かない）、`src/app/enterprise/analysis/trends/page.tsx`＋`_components/`（バッジは自分の `_components` に置く）。

**テスト（先に書く）**: unit `metric-trend.test.ts`（群の対応・各状態・pt と %・前年 0・large・basisChangeReasons 3 種・絞込）。
integration `analysis-trends.test.ts`（DemoDbClient＋WriteDetectingDbClient）: 窓 FY2024→FY2026（startDate 順）、scope1 9,735.4 → 8,931.6（−8.3%）・FY2026 は集計中 3/4・値 null・前年比なし、
scope3_cat1 FY2025→FY2026 は比較条件の確認（内部取引）、female_manager_ratio FY2026 18.25（加重）・+3.25 pt・FY2024 未入力（null）、turnover_rate・directors_count は算定不可、
JV を数えない、ヘッダー FY2025 で 2 年窓、蒼天の値が混ざらない、監査法人 ctx は AuthorizationError、書込なし。
E2E `analysis-trends.spec.ts`: メニューから開く、年度見出し 3 つ、未入力のセルに「0」が無い、内訳を開くと理由、群の絞込、axe（serious/critical 0）、「準拠率」が無い。

### 10.3 財務影響分析（`/enterprise/analysis/financial-impact`）

**位置付け**: 承認済みの非財務データ × 画面に示した仮定（URL で変えられる）による**決定論的な試算**。システムに財務データ（売上・費用・資産・価格）は 1 件も無く、
確定データは GHG 2 年・他 1 年しかないため、統計的な推定（回帰・弾性値・因果推定）は**行わない**と明示する。DB 表・Cookie・AI は使わない。

**常に見える注記（文言固定。E2E で確かめる）**

- バナー（FlaskConical）: 「試算（仮定に基づく）。予測・保証ではありません。経路と係数は画面に示した仮定で、相関から因果を推定していません」
- Demo Mode: 「架空の財務ベースライン・単価（デモ用）。実在企業の数値ではありません」
- データの厚み（動的）: 「確定データは最長 n 年分のため、統計的な推定は行いません」
- Supabase モード（source `'none'`）: 「財務データ・単価の前提が登録されていません。仮定を入力すると試算します」（既定値・ベースラインなし。入力欄は空で、入力が揃った経路だけ計算）

**基準年度と起点**: 基準年度 B ＝ ヘッダー年度以前で status `closed` の最新の期間（デモは FY2025）。無ければ空状態。起点は `loadMetricYearStates` の B 年度で
complete かつ値ありのものだけ（FY2026 の途中値・前年値補完・推計は使わない）。無い起点の経路は「未算定（基準年度の確定値なし）」。
試算期間は B+1〜B+10（デモ FY2026〜FY2035）。年度番号は期間の開始年、目標年 N は FY N として扱う。

**符号と表示**: すべて「基準年度の費用構造からの営業利益の増減（円/年）」。＋＝増益、−＝減益。表示は百万円・小数 1 桁（丸めは表示だけ）、矢印＋符号＋文字で示し、
色で良し悪しを示さない。未定量は `null`（0 にしない）。合計は必ず「定量化できた経路のみ（n / N 経路）」と書く。制度開始前の年は実際に 0（制度が無い）なので 0 とし、表に「制度開始前」と注記。

**経路（`PATHWAYS`、`src/lib/domain/financial-impact.ts`。L は時間差〔年〕。起点 D(y−L) は y−L ≤ B なら D(B)）**

| ID  | 起点 → 仕組み → 財務項目                                            | 式（年 y）                                                                   | 時間差（既定）                                                      | 関連する定性情報                                                          |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P1  | Scope1（t）→ 化石燃料賦課金の転嫁 → 売上原価                        | −S1(y−L) × 燃料由来割合 × P(y−L) × 転嫁率                                    | 開始 FY2028、L=0                                                    | IRO E1 炭素価格（4×4・中期）、定性「移行リスク：炭素価格」                |
| P2  | Scope2 マーケット（t）→ 発電事業者の負担金の電気料金転嫁 → 売上原価 | −S2(y−L) × P(y−L) × 転嫁率                                                   | 開始 FY2033、L=1                                                    | 同上                                                                      |
| P3  | エネルギー（MWh）→ 電力・燃料費 → 売上原価                          | −(E(y) − E(B)) × 単価                                                        | L=0                                                                 | —                                                                         |
| P4  | 取水量（m3）→ 水道料金 → 売上原価                                   | −(W(y) − W(B)) × 単価                                                        | L=0                                                                 | IRO E3 渇水（未定量として表示）                                           |
| P5  | 廃棄物（t）→ 処理費 → 売上原価                                      | −(T(y) − T(B)) × 単価                                                        | L=0                                                                 | IRO E5 再生材（機会）、SSBJ 資源循環の根拠文                              |
| P6  | 新規採用者数（人）→ 採用難による採用単価の上昇 → 販管費             | −H(y−L) × 補充割合 × 採用単価 × ((1+上昇率)^(y−L−B) − 1)                     | L=1                                                                 | IRO S1 人材確保難（4×3）                                                  |
| P7  | 労働災害 → 休業・補償 → 売上原価                                    | −件数 × 1 件当たり費用（**入力があるときだけ**）                             | L=0                                                                 | SSBJ 労働安全の根拠文。work_related_injuries は未収集、LTIFR は全社値なし |
| P8  | 浸水（物理的リスク）→ 復旧・操業停止 → 特別損失                     | −年発生確率 × (復旧費用 + 停止日数 × 日次限界利益)（**4 つとも入力時だけ**） | L=0                                                                 | 定性「物理的リスク：西日本工場の浸水」                                    |
| P9  | 低消費電力型製品 → 売上増 → 売上高                                  | +追加売上 × 限界利益率 × 立上り係数（入力時だけ）                            | 開始年・立上り年数を入力                                            | 定性「低消費電力型製品の拡大」                                            |
| P10 | Scope3 Cat.1（t）→ 調達先の炭素コスト転嫁 → 売上原価                | −C1(y−L) × P(y−L) × 転嫁率                                                   | 開始 FY2028、L=3、**既定で無効**（Cat.1 のみ・Scope3 全体ではない） | —                                                                         |

- 炭素価格 P(y)（仮定）: 開始年に 1,000 円/t、以後 +500 円/t・年。開始年より前は 0。
- 別枠（営業利益に足さない）: 削減費用 = max(0, S1_bau(y) − S1_scn(y)) × 5 万円/t（仮定）。資本コストは「未定量（根拠データなし）」のノードとして図にだけ出す。
- 円にしない IRO（1〜5 の点数と期間のまま表示）: E2・E4・S2・S3・S4（リコール 2×5）・G1（制裁金 2×5）。定性「気候関連リスクの財務的影響」は金額が無く、記録された理由をそのまま表示。
- 経路間の相互作用（省エネで Scope1/2 が減る等）はモデル化しない（起点ごとに独立。二重計上に注意と明記）。

**既定の仮定**（`src/lib/financial-impact/demo-assumptions.ts`。静的・organization_id なし・Demo Mode だけ。画面ではすべて「仮定・デモ既定」と表示。範囲外・数値でない値は既定に戻して通知）

| キー                                                                 | 既定                      | 範囲                             |
| -------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| `carbonPriceStart`（円/t）・`carbonPriceStep`（円/t・年）            | 1,000・500                | 0〜50,000・0〜10,000             |
| `fuelShare`（Scope1 のうち燃料由来）                                 | 100%                      | 0〜100                           |
| `passThroughFuel`・`passThroughPower`・`passThroughSupplier`         | 100%・50%・0%             | 0〜100                           |
| `energyPrice`（円/MWh）・`waterPrice`（円/m3）・`wastePrice`（円/t） | 25,000・300・50,000       | 0〜200,000・0〜5,000・0〜500,000 |
| `refillShare`・`hiringCost`（円/人）・`hiringCostGrowth`（%/年）     | 60%・1,000,000・3%        | 0〜100・0〜10,000,000・−10〜30   |
| `abatementCost`（円/t）・`discountRate`（%）                         | 50,000・5                 | 0〜1,000,000・0〜20              |
| `lag_P1`〜`lag_P10`（年）                                            | 上表の既定                | 0〜10                            |
| P7〜P9 の入力                                                        | 空（未定量）              | —                                |
| 財務ベースライン（売上高・営業利益）                                 | 600 億円・50 億円（架空） | 営業利益比の参考表示だけ         |

**シナリオ（`sc`）**: `bau` 現状維持 ＝ 起点を B 年度で固定。`target` 目標達成 ＝ 登録済み KPI 目標のうち `targetComparability` が比較可の指標だけ、B 年度の実績から目標年まで直線、以後一定
（デモ: Scope1 8,931.6 → 7,840 t〔FY2030〕）。比較不可の目標（Scope2: 境界が単体）は一定のまま理由を表示。目標の無い起点は一定と明示。
`custom` カスタム ＝ 起点ごとの年率 `r_<driver>`（%/年、−30〜30、複利）。

出力: 経路 × 年の影響、年合計（定量化できた経路のみ）、10 年累計、参考の現在価値（割引率）、回避コスト（target − bau の累計）と削減費用の累計、営業利益比（デモのみ）。
感度: 数値の仮定を 1 つずつ ±20%（他は固定）にしたときの 10 年累計の幅。幅の大きい順に上位 8（トルネード図）。

**URL**: `sc`、`a_<key>`、`r_<driver>`、`p_<ID>=1|0`（経路の有効・無効）。`<form method="get">`（数値欄はラベルと単位付き、「再計算」ボタン、「既定に戻す」リンク）。
JS なしで動き、URL で共有できる。Cookie に保存しない。parse／serialize は純関数（範囲・丸め・往復一致）。

**画面**

- 既定で見える: 注記群、シナリオ切替（3 リンク、aria-current）、要約タイル 3 つ（FY2030 の年間影響／10 年累計／回避コスト対削減費用。各「定量化 n / N 経路」付き）、経路図、年次の図、累計の線。
- 経路図 `PathwayFlow`（B2 のページ部品、SVG）: 4 列 起点（指標・定性・IRO）→ 仕組み → 財務項目（売上高／売上原価／販管費／特別損失）→ 時間帯。
  時間帯は「初めて効く年 − (B+1)」が 0 → 短期（報告期間）、1〜5 → 中期（〜5 年）、6 以上 → 長期（5 年超）（dma.ts の `TIME_HORIZON_LABEL`・`TIME_HORIZON_MEANING`）。
  帯の太さ ∝ |FY2030 の影響|、帯に「開始 FY2028・減益」等の文字。未定量は細い破線＋「未定量」の文字。
- 年次の図: 共通 `BarChart`（縦・積み上げ・負値は 0 軸の下、FY2026〜FY2035、系列 ＝ 定量化できた経路の上位 6＋「その他」）。累計: 共通 `LineChart`（現状維持 ＝ 実線、目標達成 ＝ 破線＋別の点形。二軸にしない）。
- 既定で閉じる: 「仮定を変える」（`a_`・`r_`・`p_` がある、または `sc=custom` なら開く）、経路ごとの試算表（起点の値と出所リンク `/enterprise/data?metric=…`・`/enterprise/narratives/{id}`・
  `/enterprise/disclosures/csrd/settings/matters/{topic}`・`/enterprise/esg`、値を埋めた式、結果、根拠の種類）、感度（トルネード）、定性情報（IRO の 5×5 格子〔可能性 × 大きさ〕と定性情報・理由。
  `enterprise.disclosure.read` が無ければ「閲覧権限が無い領域は表示していません」の 1 行）、制度の前提と出典、方法と限界。
- 根拠の種類バッジ（ラベル＋アイコン）: Database「データに基づく」・FlaskConical「仮定に依存」・CircleDashed「未定量」・CircleMinus「算定対象外」。

**制度の前提**（日付付きの参考情報。価格水準は法定でないため常に「炭素価格（仮定）」。2026-10-02 に Scout が政府資料で確認。**デプロイ前に再確認**）

| 事実                                                                            | 扱い                                                                                                             | 出典                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 地球温暖化対策税 289 円/t-CO2 は既に燃料価格に含まれる                          | 上乗せしない                                                                                                     | https://www.env.go.jp/policy/tax/about.html                                                   |
| GX-ETS: 直近 3 年度平均の直接 CO2 が 10 万 t 以上の事業者は FY2026 から参加義務 | 「参考: 直接の義務対象外」（デモの Scope1 は約 0.9 万 t。CO2e であり、FY2026 は収集中のため 3 年平均も出さない） | https://www.meti.go.jp/shingikai/sankoshin/sangyo_gijutsu/emissions_trading/pdf/001_03_00.pdf |
| 化石燃料賦課金は FY2028 から（化石燃料の輸入事業者等）                          | P1 の開始年。転嫁率は仮定                                                                                        | https://www.meti.go.jp/press/2022/02/20230210004/20230210004.html                             |
| 特定事業者負担金（発電事業者）は FY2033 から                                    | P2 の開始年                                                                                                      | https://www.cas.go.jp/jp/seisaku/gx_jikkou_kaigi/dai15/siryou1.pdf                            |

**ファイル（B2）**: `src/lib/domain/financial-impact.ts`（型・`PATHWAYS`・`ASSUMPTION_SPECS`・`simulateFinancialImpact(input)`・`lagBandOf`・`parseImpactParams`／`serializeImpactParams`・
`sensitivity`。純関数・client 可）、`src/lib/financial-impact/demo-assumptions.ts`、`src/lib/charts/flow-layout.ts`（経路図のレイアウト純関数）、
`src/lib/services/analysis/financial-impact.ts`（server-only。`assertEnterpriseWorkspace`＋`enterprise.data.read`。定性・IRO は `enterprise.disclosure.read` のときだけ
`listNarratives`・`loadCsrdSettings`・SSBJ マテリアリティを読む。source は `isDemoMode()`、目標は `listKpiTargets`＋`targetComparability`。書かない）、
`src/app/enterprise/analysis/financial-impact/page.tsx`＋`_components/`（pathway-flow・tornado・iro-grid・assumption-form・estimate-table・impact-badges）。

**テスト（先に書く。浮動小数は `toBeCloseTo(x, 0)`）**: unit `financial-impact-model.test.ts`: P1 bau FY2027 = 0（制度開始前）・FY2028 = −8,931,600 円・FY2030 = −17,863,200 円、
target の Scope1 FY2028 = 8,276.64 t・P1 FY2030 = −15,680,000 円、P2 bau FY2033 = 0・FY2034 = −40,070,450 円（L=1）、L を変えると効き始めがずれる、P3〜P5 は bau で 0、custom の複利、
未定量は null で合計から除き n/N が減る（0 にしない）、符号、URL の範囲外 → 既定＋通知、往復一致、累計・現在価値、感度の並び。unit `flow-layout.test.ts`（列・帯の太さ・未定量の破線）。
integration `analysis-financial-impact.test.ts`: 起点が FY2025 の確定連結値（scope1 8,931.6 等）と一致、FY2026 の途中値を使わない、ltifr・turnover_rate を起点にしない、
disclosure.read なしで定性・IRO なし、source `'none'` は既定値・ベースラインなし、書込検知ラッパーで書かない、他テナントの値なし、監査法人 ctx は拒否。
E2E `analysis-financial-impact.spec.ts`: メニューから開く、注記 3 種、シナリオ切替で URL と数値が変わる、仮定を変えて再計算、未定量の理由が見える、図に role=img と名前、axe、「準拠率」が無い。

P1 以降: 財務ベースラインの表（RLS・承認付き）、シナリオの保存、経路の相互作用、統計的推定（確定データが十分な年数になってから）、AI による経路候補（候補のみ・金額は書かない）、CSV 出力。

### 10.4 UI の簡潔化（④）

**共通部品（Stage A。Server Component で動く。新しい npm 依存なし）**

| 部品                 | パス                                         | props（要点）                                                                                                                                                   | 規則                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Collapsible`        | `src/components/ui/collapsible.tsx`          | `summary`（1 行。要点の数値を含める）、`meta?`、`defaultOpen?`（既定 false）、`open?`（強制）、`id?`、`variant?`（card・plain）、`className?`、`bodyClassName?` | ネイティブ `<details>`／`<summary>`。summary は `list-none [&::-webkit-details-marker]:hidden`＋ChevronRight（aria-hidden、開くと 90°）＋「開く／閉じる」の文字（disclosure-home-view.tsx:523-535 の形）。入れ子でずれないよう `group-open:` ではなく任意バリアント `[details[open]>summary_&]:` を使う。summary にリンク・ボタン・見出し・入力を置かない。globals.css の :focus-visible を消さない |
| `CollapsibleSection` | 同上                                         | `id`、`title`（h2。details の外）、`summary`、`actions?`（外）、`defaultOpen?`、`open?`                                                                         | `<section aria-labelledby>`。見出しと主操作は常に見える（`getByRole('heading')` が通る）                                                                                                                                                                                                                                                                                                            |
| `MoreInfo`           | `src/components/ui/more-info.tsx`            | `label`（必須。何の説明か。例「件数の数え方」）                                                                                                                 | Info アイコン＋label の小さな details。脚注・規則一覧用                                                                                                                                                                                                                                                                                                                                             |
| `PageHeader.help`    | `src/components/shared/page-header.tsx`      | `help?`                                                                                                                                                         | description の下に `<MoreInfo label="この画面について">`。description は 40 字程度まで                                                                                                                                                                                                                                                                                                              |
| `FractionBar`        | `src/components/charts/fraction-bar.tsx`     | `label`、`numerator`、`denominator`、`unit?`（既定「件」）、`showPercent?`（既定 false）                                                                        | 「n / N 件」を独立した要素で必ず表示。バーは role=img・aria-label「label: n / N 件」。分母 0 は「対象なし」                                                                                                                                                                                                                                                                                         |
| `StatusBreakdown`    | `src/components/charts/status-breakdown.tsx` | `label`、`items`（key・label・count・icon?・href?）、`unit?`、`showPercent?`（既定 false）                                                                      | StackedBar＋凡例 `<ul aria-label={label}>`。各項目は チップ・アイコン・**ラベル（独立要素。既存の文言そのまま）**・件数。分析系では % を出さない                                                                                                                                                                                                                                                    |
| `BarChart`           | `src/components/charts/bar-chart.tsx`        | `title`、`categories`、`series`（label・values〔数値か null〕）、`unit`、`orientation?`、`stacked?`、`valueFormat?`、`showValues?`、`table?`                    | 負値は 0 軸の下。null は空き＋「未入力」                                                                                                                                                                                                                                                                                                                                                            |
| `LineChart`          | `src/components/charts/line-chart.tsx`       | `title`、`xLabels`、`series`（label・values・dashed?）、`unit`、`table?`                                                                                        | null で線を切る（補間しない）。2 系列以上は線種と点の形も変える                                                                                                                                                                                                                                                                                                                                     |
| `MiniBars`           | `src/components/charts/mini-bars.tsx`        | `values`、`labels`、`label?`、`decorative?`                                                                                                                     | 表の中の小さな年次バー（0 起点）。null は破線の空枠。decorative なら aria-hidden（値は隣のセル）                                                                                                                                                                                                                                                                                                    |
| `CategoryGrid`       | `src/components/charts/category-grid.tsx`    | `label`、`items`（key・label・stateLabel・icon・filled・value?・href?）、`columns?`                                                                             | Scope3 15 カテゴリ等。状態は文字＋アイコン                                                                                                                                                                                                                                                                                                                                                          |
| `FunnelSteps`        | `src/components/charts/funnel-steps.tsx`     | `label`、`steps`（label・count・unit?・href?）                                                                                                                  | 件数が絞られる流れ（文字の件数＋相対幅）                                                                                                                                                                                                                                                                                                                                                            |
| `ChartFrame`         | `src/components/charts/chart-frame.tsx`      | `title`、`summary`（aria-label）、`legend?`、`table?`（caption・columns・rows）                                                                                 | `<figure>`＋`<figcaption>`。SVG は `role="img"`＋aria-label。表は Collapsible「数値を表で見る」                                                                                                                                                                                                                                                                                                     |

レイアウトは純関数 `src/lib/charts/{scale,bar-layout,line-layout,breakdown}.ts`（dma-view.ts と同じ作り。unit: 目盛り・0 軸・負値の積み上げ・null・最小幅）。

**図の規則**: SVG は viewBox＋`w-full`（横はみ出し禁止。ui-integrity-audit の 1280/1440/1920 を通す）。系列色は `stackedBarSegmentClass` の順、明るい色（brand-100〜300）には brand-700 の 1px 枠、
隣接区分は 1px の隙間。文字は `fill-ink`／`fill-ink-muted`・11px 以上。success・warning・danger はアイコン＋ラベルと一緒のときだけ、`#f5a800` を文字に使わない。
数値は印の隣に書く。aria-label は要点（12 個までなら全数値）、それ以上は「数値を表で見る」に全数値。凡例は正確なラベル＋数値。null は空き（0 にしない）。分析系は良し悪しを色で示さない。

**折りたたみの規則**

- 既定で閉じる: 説明文・注記・算定方法・規則一覧・長い凡例、主表と重複する補助表・参照マスター・履歴・監査タイムライン、行ごとの根拠の詳細（1 行の要約は残す）、図と同じ内容の数値表。
- 閉じない（少なくとも 1 行は details の外に見せる）: 誠実さ・安全の注記（架空／サンプル／デモ生成／未発効・公開草案／暫定／AI は候補・確定は人／権限なし／転載許可・出典／提出ではない／試算・仮定に基づく）、
  エラー・検証結果・フラッシュ・空状態、主操作とフォーム、リセットの確認とその範囲（「上記の範囲」が指す内容を 1 行で）、h1・h2・分母付きの主要数値・主表。
- 開いて描く: URL の絞込・フラッシュ・入力エラー・ハッシュが中身を指すとき（ハッシュは閉じた details を開かない）。開閉状態は保存しない。
- E2E: 閉じた中は `toBeVisible`・`getByRole`・`fill` が失敗する。`toContainText`・`toHaveCount`・`not.toContainText` は隠れた文字も数えるため、新しい凡例・要約が既存の
  「件数ちょうど」「禁止語」の検査（ssbj-gap.spec.ts:59-60、zzz-csrd-chain.spec.ts の「確認待ち」の数、analysis.spec.ts の「準拠率」）に触れないこと。
  テストは開いてから確かめる（`openCollapsible`）。**誠実さの検査は消さない・緩めない**。
- 単体テスト（happy-dom）は閉じた details の中身を隠れたものとして扱うか未確認。中身は getByText／within で確かめ、可視性に頼らない（Stage A の `collapsible.test.tsx` で挙動を固定）。

**ページ別チェックリスト**（行番号は 2026-10-02 時点。「残す」は可視のまま）

B3 ホーム・SSBJ:

| 画面                                                | 閉じる                                                                                                 | 残す                                                                                                                                            | 図                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ホーム開示業務 `dashboard/disclosure-home-view.tsx` | 分母の決め方 :399-420、直近のアクティビティ :317-331                                                   | 4 カード、自分の作業表、「適用確定済み n 項目中、承認済み n 項目」:395-396、適用未判定 :422-442、リセットのチェック・ボタン・範囲 1 行 :577-595 | FractionBar（承認済み／適用確定済み）、基準別ミニバー :459-510                                |
| ホーム ESG タブ `legacy-home.tsx`・`page.tsx`       | 注記 :109-111                                                                                          | —                                                                                                                                               | 拠点別 StatusBreakdown（承認済み／レビュー中／未提出／エラー）:174-213                        |
| SSBJ 対応状況 `ssbj/page.tsx`                       | 母集団 :262-272、ReadinessCard の説明 :80、工程の説明、行の理由 :458-460                               | 3 つの準備状況、架空／正式バッジ :182-191、領域別・優先ギャップの見出し、マテリアリティ充足度 :406、転載許可 :517-519                           | 8 カード :242-261 → StatusBreakdown（各ラベルは独立要素。「ステータス」等の禁止語を足さない） |
| `src/components/shared/ssbj-flow.tsx`               | step.description を帯の下の Collapsible「各工程の説明」1 つへ                                          | 工程名・状態                                                                                                                                    | —                                                                                             |
| 要求事項 `requirements/page.tsx`                    | 段階の説明 :292-294、マテリアリティ × 基準の表 :373-421＋凡例（ssbj-gap.spec.ts:130-136 は開いてから） | 段階名と件数、適用基準 :344-357、連携ラベル                                                                                                     | 件数の流れ :322-342 → FunnelSteps、連携 → StatusBreakdown                                     |
| 設定・ドラフト・計画・収集                          | 設定の補助段落 :124,246-247,299,313、ドラフト :89-95（「生成されるのは草案」1 行は残す）               | materiality-manager の行・欄                                                                                                                    | 計画・収集に状態の StackedBar                                                                 |

B4 CSRD:

| 画面                                                     | 閉じる                                                                                                      | 残す                                                                                                                                            | 図                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対応状況 `csrd/page.tsx`・`_overview/overview-cards.tsx` | SSBJ との違い :55-57、表のヒント :303-305                                                                   | SampleMasterBadge＋「架空の縮小マスター」、DMA 未確定の文 :75、「評価対象（常に適用・重要） n / N 件」、暫定 :131-136、ギャップ表               | DMA 結果 :58-70・適用の内訳 → StatusBreakdown（`ul aria-label`「事項の結果（人の判断）」「適用の内訳」と「n / N 件」を保つ）、4×5 の dl :168-190 → 積み上げ 4 本 |
| 設定 `settings/page.tsx`・`materiality-note.tsx`         | 本文 :39-42,62-66、式 :320-327、閾値のヒント :355-358、マトリクスの案内と事項一覧 :490-506、保存の注記      | h2「SSBJ: シングル…」「CSRD: ダブル…」（未発効の文は summary に）、不足一覧 :186-193、AI の 1 行 :195-198、DMA 表、マトリクス、フォーム①②       | —                                                                                                                                                                |
| 要求事項 `requirements/page.tsx`・`[itemId]`             | DoubleMaterialityNote は 1 行（未発効）＋details、脚注 :383-388、回答画面の説明 :869-871、優先度の説明 :648 | DMA 未確定 :211-222、表、「架空の縮小サンプル」、適用の根拠、「この判定は候補です」:420。詳細画面に「確認待ち」と完全一致するラベルを新設しない | ファネル :228-246 → FunnelSteps                                                                                                                                  |
| 収集・ドラフト・計画                                     | 収集のヘルプ :684、ドラフトの説明 :139-152（「AI 草案は候補・採用と確定は担当者」1 行は残す）               | 両表、権限の行 :542、DMA の注記 :123-137                                                                                                        | 5 カード :282-308 → リンク付き StatusBreakdown、ドラフト 3 カード :154-188 → FractionBar、計画に状態の StackedBar                                                |

B5 分析 3 画面・GHG:

| 画面                                                            | 閉じる                                                                                                                                                                         | 残す                                                                                                                                                  | 図                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 現状診断 `diagnosis/page.tsx`・`_components/diagnosis-area.tsx` | 見方 :48-55 → MoreInfo、出所 :88、拠点表 :92-132                                                                                                                               | hiddenNote :56-64、題・状態・stateReason :87、事実の「n / N 件」（独立要素。`^…$`）と「分母:」、GHG 表の「n / 4 拠点」、「n / 15 カテゴリ」「未算定」 | 事実 → FractionBar、Scope3 :178-194 → CategoryGrid                                                                                                            |
| 規制対応度 `regulations/page.tsx`                               | 説明 :106-119 → MoreInfo                                                                                                                                                       | 6 行、「人が確認済み」「AI 判定のみ」、算定しない理由 :179-181                                                                                        | BreakdownCell :37-63 → 行ごとの StatusBreakdown（% なし。セルに表を入れない）                                                                                 |
| 他社比較 `benchmark/page.tsx`                                   | 比較の決まり :191-222（summary「同条件の会社だけ・換算しない・順位なし」）、指標の注記 :252-261、ピア表 :278-302                                                               | バナー :189、caption :227、12 行                                                                                                                      | （任意）中立色の範囲帯（最小〜最大・中央値・自社。並べ替えない）                                                                                              |
| GHG `ghg/page.tsx`                                              | 脚注 :224-238,320-323,381-385,444-446,727-735、排出係数マスター :744-780（架空値バッジは見出しに）                                                                             | 連結集計表、推移の見出しと 9,735.4・−8.3%、Cat.1 の見出し、比率の定義 :574                                                                            | 推移 :242-324 → 小さな LineChart（null で切る。前年比は矢印＋符号、赤緑だけにしない）、Scope3 表 :449-496 → CategoryGrid（表は閉じる）、:548-565 → StackedBar |
| サプライヤー `ghg/suppliers/page.tsx`                           | 見本一覧 :167-185（h2 は残す）、データセットの説明 :196-200,215-217（ZIP リンクは残す）、係数マスター :413-451（題は残す）、再リンク表 :305-411（flash=factorRelinked で開く） | DemoSimulationNotice :94、リセットの題・チェック・ボタン・範囲 1 行 :230-243                                                                          | カード :96-139 → FractionBar                                                                                                                                  |

B6 ESG・データ・定性・プロジェクト・その他:

| 画面                                                       | 閉じる                                                                                                                                                             | 残す                                                                                                                                           | 図                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ESG `esg/page.tsx`・`kpi-card.tsx`・`[kpiKey]/page.tsx`    | info :280-284、スナップショットの注記 :83-85、spec.note :202-205、式 :69、dataState.details :251-257、前年比の注記 :95-101、SubRows :152-190、年次の推移表 :80-110 | 実績・目標・進捗率、NeedsCheckBadge と最初の理由、集計中 :143-146、「全社値は算定できません」                                                  | 進捗 → FractionBar（基準 → 目標）、詳細の推移 → LineChart、Scope3 副行 → CategoryGrid |
| 取込 `imports/page.tsx`・`imports/standard/page.tsx`       | 貼り付け :125-151（data-entry-aggregation.spec.ts:47-48 は開いてから）、標準 CSV の技術説明 :118-127                                                               | DemoSimulationNotice :103、「デモデータ｜組織・指標・値はすべて架空です」                                                                      | 履歴 → StackedBar（新規／変更／変更なし／エラー／除外）                               |
| データ `data/page.tsx`・`data/[dataPointId]/page.tsx`      | Version 履歴 :517、Audit Timeline :915、開示マッピング :716                                                                                                        | 承認フロー :737                                                                                                                                | 一覧に状態の StackedBar                                                               |
| 定性情報 `narratives/page.tsx`                             | 説明 :78 → 1 行＋help、脚注 :293-296 → MoreInfo                                                                                                                    | :216-218、:259-263                                                                                                                             | 状態別・テーマ別の StatusBreakdown                                                    |
| 開示プロジェクト `disclosure-projects/page.tsx`・`_tabs/*` | 一覧の説明 :58、outputs :254,270,453,478、requirements :314                                                                                                        | 公開草案 overview :71-76、outputs :245（提出ではない）・:310（草案基準）、requirements :105-112、block-editor の警告 :1003-1030,1063,1103-1107 | 承認済みの節 → FractionBar、overview :54-126 → 基準別 FractionBar                     |
| 通知・保証側                                               | 説明を 1 行＋help（「未アサイン案件は閲覧不可」の意味を残す）                                                                                                      | data-room :83（Read-only）、testing :349（自己レビュー禁止）                                                                                   | —                                                                                     |

**テストの更新（開いてから確かめる。期待を緩めない）**: Stage A が `tests/e2e/helpers.ts` に `openCollapsible(scope, summary)`（scope は Page か Locator、summary は文字列か正規表現。
閉じていれば summary を押す。何度呼んでもよい）を足す。B3: ssbj-gap.spec.ts:130-136。B4: csrd.spec.ts・csrd-screens.spec.ts・zzz-csrd-chain.spec.ts・
unit csrd-overview-settings-requirements-pages.test.tsx（:199-205・232・246）。B5: ghg-suppliers.spec.ts:180-190、zz-murata-demo.spec.ts（ZIP・リセットは残すので原則不変）、
analysis.spec.ts（メニュー試験以外）、benchmark-analysis-ui.test.tsx:157。B6: data-entry-aggregation.spec.ts:47-48、crud-persistence.spec.ts:107（`getByText(reason).first()` の DOM 順を確認）。
Stage C: production-smoke.spec.ts、six-features.spec.ts、zz-disclosure-project.spec.ts（変更不要の見込み）、`src/components/shared/demo-tour.tsx` の文言（:41-42,49-50,72-73「冒頭のマッピング表」等）。

### 10.5 デモ永続化

新しいサーバー状態は無い。経年比較の絞込と財務影響分析の仮定・シナリオは URL、折りたたみの開閉は保存しない、メニューの優先枝はタブ内の sessionStorage（表示の便宜だけ。サーバーへ送らない）。
`PERSISTED_TABLES`・`DISCLOSURE_DEMO_RESET_TABLES`・Cookie の容量（§9.9 約 11KB / 11.4KB）は変えない。年度はこれまでどおり Cookie のヘッダー年度。
stateless 構成の spec は増やさないが、対象 spec（disclosure-first-nav・zz-disclosure-project・zzz-csrd-chain）の画面が変わるため Stage C で `pnpm test:e2e:stateless` を流す（押し出し 0）。

### 10.6 並行実装計画

**Stage A（1 エージェントで順に。B の前提）**

1. ナビ: `nav-config.ts`（§10.1）・`sidebar.tsx`・新規 `nav-branch.ts`（`command-palette.tsx` は変更が要るときだけ）、unit `nav-config.test.tsx`・`nav-branch.test.ts`、
   E2E `nav-structure.spec.ts`・`disclosure-first-nav.spec.ts`・`analysis.spec.ts` のメニュー試験（:27-47）。
2. 部品: §10.4 の表（`ui/collapsible.tsx`・`ui/more-info.tsx`・`page-header.tsx` の help・`components/charts/*`・`lib/charts/*`）、unit `collapsible.test.tsx`・`chart-layout.test.ts`・
   `chart-components.test.tsx`（ラベル＋数値・role=img・null は「未入力」・n / N 件）、`tests/e2e/helpers.ts` の `openCollapsible`。
3. `kpi.ts` の一般化（§10.2 `loadMetricYearStates`。挙動不変）と integration `metric-year-states.test.ts`（scope1 の 3 年、female_manager_ratio の加重、監査法人 ctx 拒否、書かない）。
4. B1・B2 の画面は作らない（メニューのリンクは B 完了まで 404 でよい。E2E は C で通す）。

完了条件: lint・format:check・typecheck・`pnpm test` 合格。E2E は流さない。

**Stage B（並行。所有ファイル以外は編集しない）**

| スライス                           | 所有ファイル                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 自社経年比較                    | `src/app/enterprise/analysis/trends/**`、`src/lib/domain/metric-trend.ts`、`src/lib/services/analysis/trends.ts`、`tests/unit/metric-trend.test.ts`、`tests/integration/analysis-trends.test.ts`、`tests/e2e/analysis-trends.spec.ts`                                                                                                                                              |
| B2 財務影響分析                    | `src/app/enterprise/analysis/financial-impact/**`、`src/lib/domain/financial-impact.ts`、`src/lib/financial-impact/**`、`src/lib/charts/flow-layout.ts`、`src/lib/services/analysis/financial-impact.ts`、`tests/unit/financial-impact-model.test.ts`・`flow-layout.test.ts`、`tests/integration/analysis-financial-impact.test.ts`、`tests/e2e/analysis-financial-impact.spec.ts` |
| B3 ホーム・SSBJ                    | `src/app/enterprise/dashboard/**`、`src/app/enterprise/disclosures/ssbj/**`、`src/components/shared/ssbj-flow.tsx`、`tests/unit/ssbj-flow.test.tsx`、`tests/e2e/ssbj-gap.spec.ts`                                                                                                                                                                                                  |
| B4 CSRD                            | `src/app/enterprise/disclosures/csrd/**`、CSRD 画面の unit（`tests/unit/csrd-*.test.tsx`）、`tests/e2e/csrd.spec.ts`・`csrd-screens.spec.ts`・`zzz-csrd-chain.spec.ts`                                                                                                                                                                                                             |
| B5 分析 3 画面・GHG                | `src/app/enterprise/analysis/{diagnosis,regulations,benchmark}/**`・`analysis/_components/**`、`src/app/enterprise/ghg/**`、`tests/unit/benchmark-analysis-ui.test.tsx`、`tests/e2e/analysis.spec.ts`（メニュー試験以外）・`ghg-suppliers.spec.ts`・`zz-murata-demo.spec.ts`                                                                                                       |
| B6 ESG・データ・定性・プロジェクト | `src/app/enterprise/{esg,imports,data,narratives,disclosure-projects}/**`、`src/app/(common)/notifications/page.tsx`、`src/app/assurance/**/page.tsx`（説明文と help だけ）、`tests/e2e/data-entry-aggregation.spec.ts`・`crud-persistence.spec.ts`・`business-flow-audit.spec.ts`                                                                                                 |

- Stage A の所有物（部品・`kpi.ts`・nav・`helpers.ts`・`page-header.tsx`・`globals.css`）に変更が要るときは編集せず、差分案を最終報告に書く（C で適用）。
- B1・B2 は `analysis-badges.tsx` を使ってよいが編集しない（バッジは自分の `_components`）。B3〜B6 はサービス・ドメイン・fixture を変えない（表示だけ）。
- どのスライスも `src/components/ui`・`src/components/charts` に部品を足さない（ページ固有の部品は自分のルートの `_components`）。
- E2E は流さない（並走すると資源枯渇でフレークする。C で単独実行）。各自 lint・typecheck・自分の unit／integration を通す。

**Stage C（統合、1 エージェント）**: 差分案の適用、`demo-tour.tsx`、`full-audit.spec.ts`（ルート一覧と拠点担当の許可一覧に trends・financial-impact）、`six-features.spec.ts`・`zz-disclosure-project.spec.ts`（要るときだけ）、
`tests/e2e-production/production-smoke.spec.ts`（CSRD リスト 6・分析リスト 5、2 画面が開く、経年比較の年度見出し、財務影響分析の注記 3 種、閉じた中を確かめている箇所は開いてから）、
7 コマンド（E2E は単独。3100 が埋まっていれば `E2E_PORT`）、`pnpm test:e2e:stateless`、`pnpm check:rls`（106 表のまま）。
docs: 本節に「10.7 実施結果」、`docs/known-limitations.md`（経年比較の基準チェックは ESG経営に未適用、指標マスターに定義の履歴が無く単位・集計方法の変更は検知しない、
財務影響分析は仮定による試算で相互作用・統計推定なし）、`AI_HANDOFF.md`。
デプロイ（発注者の依頼。Demo Mode・環境変数なし）: feature ブランチでコミット（`git -c user.name=… -c user.email=…`。main へ push しない）→ `pnpm exec vercel deploy --prod --yes` →
`pnpm exec vercel alias set <デプロイ URL> terrast-t4d.vercel.app`（手動エイリアス）→ `pnpm test:e2e:prod`。本番でメニュー（CSRD の定性情報・分析 5 画面）と新しい 2 画面を目視確認。

### 10.7 実施結果（2026-10-02〜05）

| 要望 | 実装（D0・架空データ）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | CSRD 配下を 対応状況／要求事項／対応計画／データ収集／**定性情報**／開示ドラフト に（`/enterprise/narratives`）。SSBJ と CSRD の両方に同じリンクがあるため、最後にクリックした側だけを現在地にする（初回・再読込の既定は SSBJ）                                                                                                                                                                                                                                                                                                          |
| ②    | 分析 → **自社経年比較**（`/enterprise/analysis/trends`）。全指標 × 直近 3 年度の確定値・前年差・ミニ棒グラフ・状態（確定／集計中／未入力／推計）。比率は加重平均、欠損は 0 にせず、内部取引控除や単位・期間の違いがあれば前年差を出さず理由を表示。デモの FY2024 は全指標を架空で補完（T-5）                                                                                                                                                                                                                                             |
| ③    | 分析 → **財務影響分析**（`/enterprise/analysis/financial-impact`）。承認済みの非財務データ × 画面に示した仮定（架空・調整可）から、10 経路（起点 → 仕組み → 財務項目 → 時間差）を FY2026〜FY2035 で試算。経路図・年度別の積み上げ・累計・感応度。シナリオは 現状維持／目標達成（達成済みの目標は動かさない）／カスタム、状態は URL に保持。基準年度に既に含まれる額は差し引く。定性情報・IRO は円換算せず「未定量」と理由を表示。「試算・因果を示さない・架空の財務データ・統計推定は行わない」の注記は常に表示。Supabase モードは空状態 |
| ④    | 共通部品（折りたたみ・グラフ 8 種、依存ライブラリ追加なし）を作り、ホーム・SSBJ・CSRD・分析・GHG・取込・データ・定性情報・開示プロジェクト・ESG経営等の説明文を既定で折りたたみ、件数・内訳・推移をグラフ化。誠実さの注記（デモデータ・架空・サンプル・デモ生成・公開草案・AI は候補・権限なし・エラー）、主操作、主要な数値は折りたたまない。グラフは欠損を 0 で描かず、表で読める代替を付ける                                                                                                                                          |

検証（最終）:

| コマンド                                                   | 結果                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `format:check` / `typecheck` / `build`       | 合格                                                                                                                   |
| `pnpm test`                                                | 2,028 件合格（155 ファイル）                                                                                           |
| `pnpm test:rls` / `check:rls`                              | 311 件合格 / 106 表・RLS 有効 106・ポリシー 240                                                                        |
| `pnpm test:e2e`（単独）                                    | 324 件合格（折りたたみを全部開いた 30 画面の axe を含む）                                                              |
| `pnpm test:e2e:stateless`                                  | 25 件合格（押し出し 0）                                                                                                |
| 本番スモーク `pnpm test:e2e:prod`                          | 32 件合格（1 件はエイリアス切替直後に 1 回だけ描画のずれ〔React #418〕。再試行なしの 3 回・40 回の読み込みで再現せず） |
| 本番で実演の流れ（主デモ 8 手順＋CSRD 9 手順、1 ブラウザ） | 17/17 合格（Cookie ヘッダー最大 8.9KB）                                                                                |

自己監査 1 巡（5 観点）で 19 件を確定し、すべて修正した（主なもの: 目標達成シナリオが達成済みの目標へ実績を戻して損失を出していた、
GX-ETS の行が Scope1 の大きさにかかわらず「義務対象外」と表示した、基準年度に既に含まれる額を新たな影響として数えていた、取込履歴の内訳がエラー行を二重に数えていた、
欠損年度を線でつないでいた、折りたたみの見出しでフォーカスリングが切れていた、URL の値をそのまま通知に表示していた）。
制度の前提 4 件（地球温暖化対策税 289 円/t-CO2、GX-ETS の参加義務 FY2026〜、化石燃料賦課金 FY2028〜、特定事業者負担金 FY2033〜）は 2026-10-04 に再確認した。

経緯: 2026-10-02 は顧客デモのため、統合テスト・レビュー前の版（d5fb982）を先行して本番へ反映した。2026-10-04〜05 に統合・レビュー・修正を行い、b4e8777 を本番へ反映した。

画面: `docs/assets/analysis-2026-10/`。残課題: P9（追加売上）の入力欄に「開始年が基準年度以前なら影響 0」の説明が無い、診断の Scope3 グリッドで対象外カテゴリを区別できない（P1）、
データ詳細の版履歴が値の編集後に閉じたまま、他社比較・財務影響分析の数値は架空（実データ・ライセンスは P1）。

## 11. 2026-10 トライアル対応（試行導入の受入確認に向けた機能の追加）

試行導入（トライアル）の受入確認の観点（要求事項→定量・定性→保証レビュー→報告書の 4 工程を 1 つの流れでつなぐ・
対象外と未対応の区別・出力の突合・保証側の閲覧とコメント・評価の記録）に沿って、既存の開示優先モードに機能を足した。
実在の顧客名・価格は製品のコード・Fixture・画面・この文書に書かない（デモは架空の「青海テクノロジー（AOMI）」と架空の監査法人）。
権限キーは足していない（`roles.ts`・`0002_identity.sql` は不変）。設定の画面は企業管理者だけのまま。

### 11.1 横断の決定

- **メニュー木は変えない**。新しい画面は ROUTE_CATALOG（`menu: 'none'`・ユーザーメニューは `'header'`）に載せ、Command Palette・画面内リンクから届かせる。
  例外は 2 つ: 監査法人ツリーの「実施」に「開示レポート」の 1 葉（Data Room の次）、CDP 対応オプションの無い組織で CDP の葉を出さない
  （`NavItem.option`。契約のある組織の木は不変）。
- **導出を優先し、書き込みを増やさない**: 5 区分・対応表・横断対応表・トレースと追跡率・Data Room・影響先・「要再確認」の通知・XBRL の事実は
  読み取りのたびに同じ純関数で導く。書くのは人の判断・コメント・共有・評価の記録だけ（Demo の Cookie には小さくした形で載せる）。
- **AI は確定しない**: 要求事項の対応付け・XBRL のタグ・CDP の草案は候補（`ai_runs`）として出し、人の操作でだけ業務の値にする。
- **ESRS-40a**: 公開草案の条文・要約は作らない。デモは「試行用サンプル（架空・条文ではない）」8 項目。公開草案の版は「公開草案（未収録）」。
  草案・サンプルの基準は「充足確認済み」にしない（上限は「追加確認が必要」）。

### 11.2 追加した主な機能（スキーマ 0048〜0058）

| 領域                     | 機能                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 要求事項・対応表         | 基準ごとの判断の読み分け（SSBJ の評価・CSRD の DMA・プロジェクトの判断）、40a の判断と 3 観点の評価、対象外・非重要の申請と承認（二者）、5 区分、全基準・全件の対応表（XLSX・CSV）、節と要求事項の対応付け、SSBJ↔ESRS/40a 横断対応表、転記・再利用の点検、再承認の差分の比較元 |
| トレース・出力           | スナップショット v2（承認者・日時・根拠・判断の状態を固定）、内容とトレース（追跡率・追跡番号）、出力の自動突合（不一致なら渡さない）、外部で編集したファイルの照合、承認版どうしの差分、影響先の一覧と保存しない「要再確認」                                                  |
| 保証連携                 | 承認済みレポートの保証側への共有（追記専用の写し）、保証側の開示レポートの閲覧とコメント、企業の回答、Data Room の導出（許諾×承認）、Sign-off と写しの結び付け                                                                                                                 |
| 管理・権限・ログ         | 承認ルート（3 段階のひな形・過年度確定値）、担当拠点つき招待・役割変更・利用停止・引継ぎ一覧、企業の監査ログ、役割と権限の一覧、権限で断った操作の記録、データ取扱条件の版、全データの返却書き出し、テナントの払い出し・終了の手順                                             |
| トライアルの評価         | 計画と実績・選定ケース・検証シナリオの実施と判定・改善管理表（ヘッダーの「ご意見・不具合」）・作業時間・費用対効果の試算・検証結果の XLSX（Demo は架空の記録と明示）                                                                                                           |
| CDP 対応オプション       | 組織単位の有効化（運営が設定）、担当・不足・対応付け・根拠の再利用・作成者の承認不可・版の選択                                                                                                                                                                                 |
| XBRL（Stage 1）          | SAMPLE タクソノミ、対応付けと確定（作成者以外）、簡易検査 V01〜V16、xBRL-JSON・インライン XBRL のプレビュー（社内確認用・提出用ではない）                                                                                                                                      |
| 本文・インパクト・基準版 | 定性情報の基準別の対応状況と直接の対応付け、インパクト・リスク・機会の台帳、SSBJ の基準版の年度固定、CSRD の画面の位置付けの注記、SSBJ・CSRD のドラフトから原稿への取り込み、基準マスターの登録スクリプト（運営側）                                                            |

画面 8・API 5（＋既存の出力 API に 2 形式）・タブ 5 を足した（`docs/ui-redesign/inventory-features.md` §2.3・§3.14・§4。回帰は `docs/ui-redesign/regression.md` §6）。

### 11.3 統合（Stage C）で足した入口

- ヘッダーに「ご意見・不具合」（どの画面からでも送れる。主操作ではない）、ユーザーメニューに「トライアルの評価」、ヘルプに用語（区分・対象外の承認・横断対応表・追跡率・選定ケース・突合など）と「この環境の版」。
- Command Palette の操作: フィードバックを送る・対応表を出力する・トレースを開く・保証側のコメントに回答する・XBRL の対応付けを確認する・監査ログを見る（移った先の画面で人が操作する）。設定の項目に承認ルート・役割と権限・データの取扱い。
- ホームの Attention: 上流の変更で再確認が必要な節（自分の担当・最終承認）・承認待ちの対象外の申請（最終承認者）・未回答の保証側のコメント（作成担当）・トライアルの必須要件 × 重大 × 未解決（管理者）。開示ホームの進み具合に 5 区分の件数。通知センターに「要再確認（上流の変更）」。

### 11.4 試行の流れ（Demo の別インスタンスでも通す）

開示デモのリセット → 40a の判断と対象外の申請・承認 → 節の対応付け → 対応表 XLSX → 承認済みレポートの共有 → 保証側のコメント →
企業の回答 → Data Room の開示レポート → DOCX の突合 0 件 → 追跡率 → XBRL プレビュー（書き込みなし）→ ご意見・シナリオ・判定・作業時間 →
3 段階の承認ルート。Service の層は `tests/integration/stateless-trial-chain.test.ts`（Cookie 9,000B 以下・押し出し 0）、画面は
`tests/e2e/zzzzz-trial-chain.stateless.ts`（`pnpm test:e2e:stateless`）。既存の実演の流れ＋CSRD の流れは 11,200B 以下を回帰の上限にした。
