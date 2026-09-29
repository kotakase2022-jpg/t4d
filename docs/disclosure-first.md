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
6. **デモ永続化**: 小さい行（状態・ポインタ・短文）のみ Cookie に持ち回す。長文の版・スナップショットは
   インスタンスメモリ（known-limitations D-3 と同じ扱い）。消えた場合は「見つからない」として安全に失敗させる。

---

## 3. データモデル（マイグレーション 0033〜0040）

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
