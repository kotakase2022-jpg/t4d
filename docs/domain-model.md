# ドメインモデル

`src/types/domain.ts`（TypeScript）と `supabase/migrations/*.sql`（Postgres）が 1:1 で対応します。
全 75 テーブル。UUID 主キー、`created_at` / `updated_at` / `created_by` / `updated_by`、
テナントデータは `organization_id`、Soft Delete 対象は `deleted_at` を持ちます。

---

## 1. 主要な集約

```
organizations (enterprise | assurance_firm | platform_admin)
 ├ organization_memberships ─ membership_roles ─ roles ─ role_permissions ─ permissions
 ├ organization_units（階層・連結範囲・持分）
 ├ reporting_periods
 ├ metric_definitions ─ metric_assignments
 │   └ frameworks[]（ssbj / cdp / csrd。その指標を求めている開示基準）
 ├ approval_routes ─ approval_route_stages（最大 5 階層の承認の道筋）
 ├ ssbj_analysis_settings（①マテリアリティ・分析条件の設定）
 ├ ssbj_disclosure_drafts（節ごとの開示ドラフトの草案）
 └ data_points ─ data_point_versions
                ├ data_point_approval_steps（道筋の写し。承認・差し戻しの記録）
                └ data_point_calculations / data_point_validation_results / evidence_links

engagements（監査法人所有）
 ├ engagement_members
 ├ client_access_grants（企業が付与）
 ├ engagement_scopes
 ├ data_room_items
 ├ assurance_snapshots ─ assurance_snapshot_items ─ snapshot_changes
 ├ populations ─ population_items
 ├ samples ─ sample_items
 ├ assurance_procedures / assurance_tests ─ assurance_test_results
 ├ pbc_requests ─ pbc_request_responses
 ├ assurance_issues ─ management_responses
 ├ review_notes
 └ signoffs
```

Scope1・2 の算定と照合（2026-10-16。マイグレーション 0060〜0065。企業テナントだけ・監査法人のポリシーは無い）:

```
organizations（企業）
 ├ emission_factor_sets（出所 customer_specified / public_reference / fixture。draft → active → retired）
 │   └ emission_factors（セット付きの行は draft のときだけ追加・変更。Cat.1 のセット無しの行は従来どおり）
 ├ emission_factor_assignments（期間 × 拠点／国／全社 × 活動 × 基準 → 係数。active のセットの係数だけ）
 ├ ghg_calculation_policies（期間ごとの版。丸め・換算・改良トンキロ法の組織の設定。追記専用）
 ├ ghg_classification_rules（既定区分 → 報告区分。proposed → approved（提案者以外）／withdrawn）
 ├ ghg_activity_batches ─ ghg_activity_lines（draft → confirmed → superseded／discarded。行は追記専用）
 ├ ghg_calculation_runs ─ ghg_calculation_lines（算定の記録と各段の値。追記専用。入力ハッシュ・エンジンの版）
 └ ghg_baseline_results ─ ghg_reconciliations ─ ghg_reconciliation_notes（既存の算定結果・照合・原因の確認の記録。追記専用）
```

---

## 2. 業務キーと一意制約

| テーブル                   | 一意制約                                                                                                                                   | 意図                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `organization_memberships` | `(organization_id, user_id)`                                                                                                               | 同一組織に重複所属しない                             |
| `data_points`              | `(organization_id, metric_id, unit_id, reporting_period_id, boundary)`                                                                     | Data Point の業務キー                                |
| `data_point_versions`      | `(data_point_id, version_no)`                                                                                                              | 版番号の重複防止                                     |
| `evidence_links`           | `(target_type, target_id, file_version_id, page, cell_ref)`                                                                                | 同一箇所の重複 Link 防止                             |
| `engagement_members`       | `(engagement_id, user_id)`                                                                                                                 | 重複アサイン防止                                     |
| `client_access_grants`     | `(engagement_id, subject_type, subject_id)`                                                                                                | 許諾の重複防止                                       |
| `assurance_snapshot_items` | `(snapshot_id, source_type, source_id, source_version_id)`                                                                                 | Snapshot 項目の重複防止                              |
| `sample_items`             | `(sample_id, population_item_id)`                                                                                                          | 同一項目の二重抽出防止                               |
| `signoffs`                 | `(engagement_id, signoff_stage, user_id, version)`                                                                                         | Sign-off の重複防止                                  |
| `ingestion_jobs`           | `(organization_id, idempotency_key)`                                                                                                       | ジョブの重複実行防止                                 |
| `disclosure_responses`     | `(organization_id, item_id, reporting_period_id)`                                                                                          | 回答の重複防止                                       |
| `emission_factors`         | セット無し: `(organization_id, code, factor_year)`／セット有り: `(organization_id, factor_set_id, code, factor_year)`（部分一意索引 2 本） | 年度・版の取り違え防止（同じコードの複数年度を区別） |

## 3. CHECK 制約（業務ルールの DB 化）

| テーブル                   | 制約                                                                            | 意味                               |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `data_points`              | `status <> 'approved' or (approved_by is not null and approved_at is not null)` | 承認には実行者と時刻が必須         |
| `assurance_tests`          | `reviewed_by is null or prepared_by is not null`                                | レビューには作成が先行する         |
| `assurance_tests`          | `reviewed_by is null or reviewed_by <> prepared_by`                             | **自己レビュー禁止**               |
| `assurance_issues`         | `status <> 'resolved' or resolution is not null`                                | 解消には解消内容が必須             |
| `engagements`              | `assurance_firm_id <> client_organization_id`                                   | 自社監査の禁止                     |
| `file_versions`            | `storage_key !~ '\.\.'` ほか                                                    | Path Traversal 防止                |
| `audit_events`             | `length(before_summary) <= 500` ほか                                            | ログ肥大と PII 混入の抑止          |
| `reporting_periods`        | `end_date > start_date`                                                         | 期間の整合                         |
| `ghg_classification_rules` | `approved_by is distinct from proposed_by`（ほかにトリガ・RLS・サービス）       | **提案者は承認できない**           |
| `ghg_reconciliation_notes` | 原因が「その他」・残差の項目はコメント必須（1,000 字以内）                      | 原因の確認の根拠を残す             |
| `trial_feedback_items`     | `scope_kind is null or cost_class = 'separate_estimate'`                        | 別途協議の区分は別途協議のときだけ |
| `organization_data_terms`  | `backup_residual_days` は 0〜400                                                | バックアップの残存期間             |

## 4. Version 管理

値を上書きせず、必ず新しい行を追記します。

```
data_points.current_version_id ──▶ data_point_versions（追記専用）
                                     version_no / value / unit_of_measure
                                     source_type / source_reference / change_reason
                                     content_hash
```

`content_hash` が Snapshot 固定値との突合に使われます。
`disclosure_responses` / `files` も同じ構造（`current_version_id` ＋ 追記専用の版テーブル）です。

## 5. Snapshot と変更検知

```
assurance_snapshot_items.value_snapshot（jsonb）  ← 固定時点のコピー（不変）
assurance_snapshot_items.hash                    ← 固定時点の content_hash
                    ↕ 突合
data_points.current_version_id → data_point_versions.content_hash（現在）
```

ハッシュが一致しなければ変更として検出します（`detectSnapshotChanges`）。
Supabase Mode では `data_point_versions` への INSERT トリガでも `snapshot_changes` へ記録します。

影響評価（`no_impact` / `retest_required` / `issue_raised`）は**人が確定**します。
未評価の変更があると最終 Sign-off が抑止されます。

## 6. 状態機械

### Data Point

```
not_started → draft → submitted → in_review → approved
                          ↘ returned ↗
                                     approved → in_review（再検証）
```

### Disclosure Response

```
not_started → draft → in_review → approved
                   ↘ returned ↗
```

AI 由来の版はこの `approved` に到達できません。

### PBC Request

```
draft → sent → acknowledged → submitted → under_review → accepted → closed
                                                        ↘ rejected → sent
                            overdue（期限超過は表示上の派生状態）
```

### Sign-off

```
prepared → reviewed → partner_approved
```

各段階に抑止条件があり、前段が無いと次に進めません。

### 係数のセット・区分規則・活動量（Scope1・2 の算定）

```
係数のセット: draft → active（以後、係数は変更できない） → retired
区分規則:     proposed → approved（提案者以外の enterprise.data.approve） / proposed・approved → withdrawn
活動量:       draft → confirmed（差し替える元は superseded） / draft → discarded
```

算定の記録・照合・原因の確認の記録は追記専用で、状態を持たない（入力が変わると「入力が変わった」と導く）。

## 7. Fixture（架空データ）

| 項目       | 内容                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 企業 A     | 青海テクノロジー株式会社（本社 / 東日本工場 / 西日本工場 / 欧州販売子会社 / サプライヤー 5 社）                                                                                                          |
| 企業 B     | 蒼天マテリアル株式会社（越権テスト用）                                                                                                                                                                   |
| 監査法人 A | あおば保証監査法人                                                                                                                                                                                       |
| 監査法人 B | くろべ監査法人（越権テスト用）                                                                                                                                                                           |
| 報告期間   | FY2025（closed） / FY2026（collecting）                                                                                                                                                                  |
| 指標       | 14 種（Scope1/2/3Cat1、エネルギー、水、廃棄物、従業員数、管理職数、女性管理職数・比率、役員総数、女性役員数・比率、取締役数）                                                                            |
| Data Point | 64 件（FY2025 32 / FY2026 32）                                                                                                                                                                           |
| 保証案件   | ENG-2026-001（FY2026 限定的保証）                                                                                                                                                                        |
| GHG の検証 | 検証拠点 5（東日本工場＋架空の海外 4 拠点〔TH・VN・MX・US〕）・期間 CY2025・係数セット 2 版（架空）・活動量・算定の記録 R-1・既存結果 BL-1（6 種の原因を仕込む）・照合 R-1・区分規則 LOGI-01（承認待ち） |
| Sample     | 10 件 / PBC 5 件 / Issue 3 件 / Review Note 2 件 / Snapshot 後変更 2 件                                                                                                                                  |

### 意図的な異常データ

| 異常                  | 対象                                      | 検出ルール                                          |
| --------------------- | ----------------------------------------- | --------------------------------------------------- |
| 女性役員数 > 役員総数 | 本社 FY2026                               | `ratio_numerator_exceeds_denominator`（error）      |
| 前年比 10 倍          | 西日本工場 水使用量                       | `yoy_deviation`（error）                            |
| 単位 t と kg の混在   | 東日本工場 廃棄物                         | `unit_mismatch` ＋ `unit_inconsistent_across_units` |
| Evidence なし         | 欧州販売子会社 Scope1                     | `missing_evidence`                                  |
| 承認後変更            | 本社 Scope2                               | `changed_after_approval`（warning）                 |
| Snapshot 後変更       | 東日本工場 Scope1 / 西日本工場 エネルギー | Change Alert 2 件                                   |
