# RLS マトリクス

`supabase/migrations/0012_rls_core.sql` / `0013_rls_assurance.sql`
（＋ `0016_storage_bucket_read.sql` / `0017_rls_counterparty_organization.sql` /
`0025_ssbj_gap_analysis.sql` / `0028_ssbj_analysis_settings.sql` / `0029_approval_routes.sql` /
`0030_ssbj_disclosure_drafts.sql` / 開示優先モードの `0033`〜`0040` / CSRD の `0044`〜`0046`）の要約です。
**106 テーブルすべてで RLS を有効化**しており（ポリシー 240 件）、`pnpm check:rls` が未設定を検出します。

凡例

- `own` = 自組織のメンバー（`t4d.is_org_member`）
- `perm:X` = 自組織で権限 X を持つ（`t4d.has_permission`）
- `member` = その案件の Engagement Member（`t4d.is_engagement_member`）
- `grant` = Client Access Grant が有効かつ企業側で承認済み
- `—` = ポリシーを作っていない（＝その操作は不可）

---

## 1. Identity / Tenant

| テーブル                               | SELECT                  | INSERT                           | UPDATE                     | DELETE |
| -------------------------------------- | ----------------------- | -------------------------------- | -------------------------- | ------ |
| profiles                               | 自分 or 同組織          | —                                | 自分のみ                   | —      |
| organizations                          | own ＋ 保証契約の相手方 | —                                | perm:enterprise.org.manage | —      |
| roles / permissions / role_permissions | 全認証ユーザー          | —                                | —                          | —      |
| organization_memberships               | 自分 or own             | perm:member.manage / firm.manage | 同左                       | —      |
| membership_roles                       | 自分 or own             | 同上                             | 同上                       | —      |
| invitations                            | own                     | perm:member.manage / firm.manage | 同左                       | —      |
| organization_relationships             | 当事者双方              | perm:grant.manage                | 同左                       | —      |
| user_preferences                       | 自分のみ                | 自分のみ                         | 自分のみ                   | —      |

> `organizations` の「保証契約の相手方」は `0017_rls_counterparty_organization.sql` で追加しました。
> 監査法人はアサインされた案件のクライアント企業名を、企業は自社が結んだ案件の監査法人名を
> 表示する必要があるためです。開示するのは `organizations` 行のメタデータ（名称・コード・国）のみで、
> 接続の根拠は `engagements`（＋ `engagement_members`）に限定しており、
> **相手方テナントの業務データへのアクセスは一切増えません**。
> 実 Supabase に対する E2E で「相手方名が空になる」ことから発見しました。

## 2. Organization / Master

| テーブル                                | SELECT                       | 更新系                |
| --------------------------------------- | ---------------------------- | --------------------- |
| organization_units                      | own ＋ **監査法人（grant）** | perm:org.manage       |
| reporting_periods                       | own ＋ **監査法人（grant）** | perm:period.manage    |
| metric_definitions                      | own ＋ **監査法人（grant）** | perm:metric.manage    |
| collection_campaigns / campaign_scopes  | own                          | perm:period.manage    |
| metric_assignments                      | own                          | perm:period.manage    |
| emission_factors                        | own                          | perm:metric.manage    |
| approval_routes / approval_route_stages | own                          | perm:org.manage       |
| ssbj_analysis_settings                  | own                          | perm:disclosure.write |
| ssbj_disclosure_drafts                  | own                          | perm:disclosure.write |
| organization_feature_settings（0033）   | own                          | perm:org.manage       |

## 3. Data（企業原本）

| テーブル                      | SELECT                       | INSERT                          | UPDATE                                                                                                | DELETE |
| ----------------------------- | ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| data_points                   | own ＋ **監査法人（grant）** | perm:data.write ＋ unit scope   | perm:{write,review,approve} ＋ unit scope。`approved` への遷移は perm:data.approve                    | —      |
| data_point_versions           | own ＋ 監査法人（grant）     | perm:{write,review,approve}     | **—（追記専用＋トリガ）**                                                                             | —      |
| data_point_calculations       | own ＋ 監査法人（grant）     | perm:data.write                 | —                                                                                                     | —      |
| data_point_validation_results | own                          | perm:data.write                 | perm:data.write                                                                                       | —      |
| aggregation_rules / runs      | own                          | perm:metric.manage / data.write | 同左                                                                                                  | —      |
| data_point_approval_steps     | own                          | perm:data.review                | perm:data.review。誰の段階かはアプリ層で判定する（役割・個人指定の組み合わせは SQL だけでは表せない） | —      |
| quantitative_import_batches   | own                          | perm:import.run                 | perm:import.run。**確定・却下後はトリガで変更不可**（`quantitative_import_batch_guard`）              | —      |

> `data_points` / `data_point_versions` に 0039 で足した `value_kind` / `availability_status` /
> `absence_reason` は既存のポリシーに従う（列の追加のみで、ポリシーは変えていない）。

> **監査法人に UPDATE ポリシーが存在しない**ことが「Read-only by Default」の実装です。

## 4. File / Evidence

| テーブル              | SELECT                           | INSERT              | UPDATE              |
| --------------------- | -------------------------------- | ------------------- | ------------------- |
| files                 | own ＋ 監査法人（Evidence 許諾） | perm:evidence.write | perm:evidence.write |
| file_versions         | own ＋ 監査法人（Evidence 許諾） | perm:evidence.write | **—（版追加のみ）** |
| extracted_fragments   | own ＋ 監査法人（Evidence 許諾） | perm:evidence.write | —                   |
| evidence_links        | own ＋ 監査法人（Evidence 許諾） | perm:evidence.write | perm:evidence.write |
| storage_access_events | own ＋ perm:common.audit.read    | 本人のみ            | —                   |

## 5. Workflow

| テーブル             | SELECT   | 更新系                                                                                                                |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| workflow_definitions | own      | perm:org.manage                                                                                                       |
| workflow_instances   | own      | perm:{write,review,approve}                                                                                           |
| workflow_steps       | own      | **step ごとに対応権限**（input=write / review=review / approval=approve）                                             |
| tasks                | own      | own                                                                                                                   |
| approvals            | own      | INSERT のみ。`stage='final'` は perm:data.approve、`stage='review'` は perm:data.review。`actor_user_id = auth.uid()` |
| comments             | own      | 本人が INSERT / 本人のみ UPDATE                                                                                       |
| notifications        | 本人のみ | 本人 UPDATE / own INSERT                                                                                              |
| alerts               | own      | own                                                                                                                   |

## 6. Disclosure

| テーブル                                              | SELECT                     | 更新系                                                                    |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| disclosure_frameworks / versions / items / conditions | 全認証ユーザー（マスター） | —                                                                         |
| applicability_results                                 | own                        | perm:disclosure.write                                                     |
| disclosure_responses                                  | own                        | perm:disclosure.write。`approved` は perm:disclosure.approve              |
| disclosure_response_versions                          | own                        | INSERT のみ（追記専用＋トリガ）。**AI 由来の `approved` は トリガで拒否** |
| disclosure_mappings                                   | own                        | perm:disclosure.write                                                     |
| response_evidence_links                               | own                        | perm:disclosure.write                                                     |

### 6.1 開示優先モード（0035〜0038）

権限キーは新設していない（docs/disclosure-first.md §2-2）。`self` = 行の実行者列が `auth.uid()` と一致（本人名義のみ・代理禁止）。
子の `organization_id` は親と一致しなければならず、複合外部キーで固定している（Service Role でも他社の名義で書けない）。

| テーブル                    | SELECT | INSERT                                                                                                                                                       | UPDATE                                                                                                                                           | DELETE |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| disclosure_projects         | own    | perm:disclosure.write                                                                                                                                        | perm:disclosure.write                                                                                                                            | —      |
| project_frameworks          | own    | perm:disclosure.write                                                                                                                                        | perm:disclosure.write                                                                                                                            | —      |
| project_framework_decisions | own    | perm:disclosure.write ＋ self（`decided_by`）。`not_assessed` は CHECK で拒否                                                                                | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| narrative_records           | own    | perm:disclosure.write                                                                                                                                        | perm:disclosure.write                                                                                                                            | —      |
| narrative_versions          | own    | perm:disclosure.write ＋ self（`created_by`）                                                                                                                | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| source_anchors              | own    | perm:disclosure.write ＋ self（`created_by`）                                                                                                                | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| disclosure_blocks           | own    | perm:disclosure.write                                                                                                                                        | perm:disclosure.{write,approve}。`approved` への遷移・承認版の変更は approve。approve だけの人は状態・提出版・承認版以外を変えられない（トリガ） | —      |
| disclosure_block_versions   | own    | perm:disclosure.write ＋ self（`created_by`）                                                                                                                | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| review_requests             | own    | perm:disclosure.write ＋ self（`requested_by`）                                                                                                              | perm:disclosure.{write,approve}。依頼時点の内容（対象版・依頼者・規則）は不変、`approved` は approve、終了した依頼は再開不可（トリガ）           | —      |
| review_events               | own    | self（`actor_user_id`）＋ 種類別: requested / withdrawn / review_completed は write、returned は write か approve、approved は approve。**職務分離はトリガ** | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| review_comments             | own    | perm:disclosure.{write,approve} ＋ self（`created_by`）                                                                                                      | perm:disclosure.{write,approve}。解決の記録（`resolved_*`）以外は不変（トリガ）                                                                  | —      |
| recheck_decisions           | own    | perm:disclosure.write ＋ self（`decided_by`）                                                                                                                | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| report_snapshots            | own    | self（`created_by`）＋ `review_draft` は perm:disclosure.write か export.run、`approved` は perm:disclosure.approve                                          | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| export_artifacts            | own    | perm:export.run ＋ self（`generated_by`）                                                                                                                    | **—（追記専用＋トリガ）**                                                                                                                        | —      |
| kpi_targets                 | own    | perm:metric.manage ＋ self（`created_by`）                                                                                                                   | **—（追記専用の版＋トリガ）**                                                                                                                    | —      |

`review_events` の職務分離（`t4d.enforce_review_event`、Service Role にも効く）:

- `review_completed` / `approved` … 実行者 ≠ 依頼者（`review_requests.requested_by`）かつ ≠ 対象版の作成者
- `approved` … さらに ≠ 同じ依頼の `review_completed` の実行者
- `returned` … `reason` と `paragraph_id` が必須
- すべて … `target_version_id` は依頼で固定した版と一致（別の版を名乗って作成者の判定をすり抜けさせない）

### 6.2 CSRD のダブル・マテリアリティと要求事項の評価（0044〜0046）

権限キーは新設していない（docs/disclosure-first.md §9.3）。参照は組織メンバー、書込（for all）は `enterprise.disclosure.write`（0028 / 0030 と同じ）。
追記専用の表は無い（判断・閾値は書き換えられ、DMA の確定は同じ処理で外れる）。子の `organization_id` は親と一致しなければならず、
報告期間・事項・評価・AI の実行・関連するインパクト IRO を `(id, organization_id)` の複合外部キーで固定している（Service Role でも他社の行を指せない）。

| テーブル               | SELECT | INSERT / UPDATE                                                                                                                  | DELETE |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| csrd_analysis_settings | own    | perm:disclosure.write。閾値 1.0〜5.0・DMA の確定は確定者と日時が対（CHECK）                                                      | —      |
| csrd_dma_matters       | own    | perm:disclosure.write。評価済みの軸は根拠必須・判断者と日時が対（CHECK）                                                         | —      |
| csrd_dma_iros          | own    | perm:disclosure.write。インパクト／リスク・機会の形（CHECK）。事項・関連するインパクトは同じ組織（複合外部キー）。削除は論理削除 | —      |
| csrd_assessments       | own    | perm:disclosure.write。**CSRD の版の要求事項だけ**（トリガ）。最終判定は人の確認と対・AI の候補は一式でそろう（CHECK）           | —      |
| csrd_action_plans      | own    | perm:disclosure.write。評価は同じ組織（複合外部キー）                                                                            | —      |
| csrd_disclosure_drafts | own    | perm:disclosure.write。本文の無い節は確定できない・確定者と日時が対（CHECK）                                                     | —      |

`t4d.csrd_assessment_item_guard`（`csrd_assessments` の BEFORE INSERT OR UPDATE OF item_id、Service Role にも効く）:
要求事項の版の基準（`disclosure_frameworks.key`）が `csrd` でなければ `T4D_CSRD_ITEM_ONLY` で拒否する
（SSBJ・CDP の要求事項を CSRD の評価として登録させない。読むのは全利用者が読めるマスターだけ）。

## 7. Import / AI

| テーブル                          | SELECT | 更新系                                        |
| --------------------------------- | ------ | --------------------------------------------- |
| ingestion_jobs / job_files / rows | own    | perm:import.run                               |
| ai_jobs                           | own    | perm:{enterprise.ai.run, assurance.ai.run}    |
| ai_runs                           | own    | INSERT: perm:ai.run / UPDATE: own（採否記録） |
| ai_sources / ai_feedback          | own    | own（feedback は本人のみ）                    |

## 8. Assurance

| テーブル                       | SELECT                                                         | INSERT                                                                     | UPDATE                                       | DELETE |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | ------ |
| engagements                    | member ＋ **クライアント企業**                                 | perm:engagement.manage                                                     | member ＋ perm:engagement.manage             | —      |
| engagement_members             | 本人 or member                                                 | perm:engagement.manage                                                     | 同左                                         | —      |
| client_access_grants           | クライアント企業 or member                                     | **クライアント企業のみ**（perm:grant.manage ＋ `granted_by = auth.uid()`） | クライアント企業のみ                         | —      |
| engagement_scopes              | member or クライアント                                         | member ＋ perm:scope.manage                                                | 同左                                         | —      |
| data_room_items                | member or クライアント                                         | **クライアント企業のみ**                                                   | クライアント企業のみ                         | —      |
| assurance_snapshots            | member                                                         | member ＋ perm:snapshot.create ＋ `frozen_by = auth.uid()`                 | **—（Immutable ＋ トリガ）**                 | —      |
| assurance_snapshot_items       | member                                                         | member ＋ perm:snapshot.create                                             | **—（Immutable ＋ トリガ）**                 | —      |
| snapshot_changes               | member                                                         | member                                                                     | member ＋ perm:testing.write（影響評価のみ） | —      |
| populations / population_items | member                                                         | member ＋ perm:population.manage                                           | 同左                                         | —      |
| samples                        | member                                                         | member ＋ perm:sampling.run ＋ `created_by = auth.uid()`                   | **—（再抽出は新 Sample）**                   | —      |
| sample_items                   | member                                                         | member ＋ perm:sampling.run                                                | —                                            | —      |
| assurance_procedures           | member                                                         | member ＋ perm:engagement.manage                                           | 同左                                         | —      |
| assurance_tests                | member                                                         | member ＋ perm:testing.write                                               | 同左                                         | —      |
| assurance_test_results         | member                                                         | member ＋ perm:testing.write ＋ `completed_by = auth.uid()`                | 同左                                         | —      |
| pbc_requests                   | member ＋ **クライアント（draft を除く）**                     | member ＋ perm:pbc.manage                                                  | 同左                                         | —      |
| pbc_request_responses          | member or クライアント                                         | **クライアント**（perm:pbc.respond ＋ `submitted_by = auth.uid()`）        | member（受領判定）                           | —      |
| assurance_issues               | member or クライアント                                         | member ＋ perm:issue.manage                                                | 同左                                         | —      |
| management_responses           | member or クライアント                                         | **クライアントのみ**（`responded_by = auth.uid()`）                        | —                                            | —      |
| review_notes                   | member ＋ **クライアント（`shared_with_client = true` のみ）** | member ＋ perm:review.write                                                | 同左                                         | —      |
| signoffs                       | member or クライアント                                         | member ＋ 段階別権限 ＋ **`user_id = auth.uid()`**                         | **—（Immutable ＋ トリガ）**                 | —      |
| workpaper_references           | member                                                         | member ＋ perm:testing.write                                               | —                                            | —      |

## 9. Audit

| テーブル     | SELECT                                            | INSERT                       | UPDATE                       | DELETE |
| ------------ | ------------------------------------------------- | ---------------------------- | ---------------------------- | ------ |
| audit_events | perm:common.audit.read（自組織）or member（案件） | `actor_user_id = auth.uid()` | **—（Immutable ＋ トリガ）** | —      |

`event_type` の CHECK は `0040_audit_event_types_disclosure.sql` で開示業務の 17 種類を追加した
（`src/types/domain.ts` の `AUDIT_EVENT_TYPES` と一致することを `tests/unit/disclosure-enum-parity.test.ts` が検査する）。

`DELETE` は `0014_immutability_and_grants.sql` で `authenticated` から REVOKE しています
（Soft Delete と監査証跡を優先）。

---

## 10. Immutability（RLS ＋ トリガの二重化）

RLS は「通常ユーザー」に対する防御です。Service Role は RLS をバイパスするため、
追記専用テーブルには `t4d.forbid_mutation()` トリガも付けています。

| テーブル                                                                       | トリガ                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| assurance_snapshots / assurance_snapshot_items                                 | UPDATE/DELETE 禁止                                       |
| audit_events                                                                   | UPDATE/DELETE 禁止                                       |
| signoffs                                                                       | UPDATE/DELETE 禁止 ＋ `enforce_self_signoff`（代理禁止） |
| data_point_versions / disclosure_response_versions / file_versions / approvals | UPDATE/DELETE 禁止                                       |
| disclosure_response_versions                                                   | `forbid_ai_auto_approval`（AI 由来 ＋ approved を拒否）  |
| data_points                                                                    | `enforce_data_point_transition`（状態遷移権限）          |
| project_framework_decisions / narrative_versions / source_anchors              | UPDATE/DELETE 禁止                                       |
| disclosure_block_versions / review_events / recheck_decisions                  | UPDATE/DELETE 禁止                                       |
| report_snapshots / export_artifacts / kpi_targets                              | UPDATE/DELETE 禁止                                       |
| review_events                                                                  | `enforce_review_event`（職務分離・差戻しの必須項目）     |
| review_requests                                                                | `review_request_guard`（依頼時点の内容は不変・承認権限） |
| disclosure_blocks                                                              | `enforce_disclosure_block_update`（承認の遷移権限）      |
| review_comments                                                                | `review_comment_guard`（解決の記録のみ更新可）           |
| quantitative_import_batches                                                    | `quantitative_import_batch_guard`（確定・却下後は不変）  |
| csrd_assessments                                                               | `csrd_assessments_item_guard`（CSRD の要求事項だけ）     |

---

## 11. Storage

`0015_storage.sql`。Object Path の 2 番目のセグメント（所有組織 ID）が
ユーザーの所属組織と一致することを要求します。

| Bucket                       | public | SELECT       | INSERT                              |
| ---------------------------- | ------ | ------------ | ----------------------------------- |
| brand-public                 | true   | 全員         | —                                   |
| enterprise-originals-private | false  | 所属組織のみ | 所属組織のみ ＋ Path Traversal 禁止 |
| evidence-private             | false  | 同上         | 同上                                |
| assurance-workpapers-private | false  | 同上         | 同上                                |
| exports-private              | false  | 同上         | 同上                                |

`file_versions.storage_key` にも CHECK 制約（`..` を含まない / `/` 始まりでない /
`enterprise|assurance|exports` で始まる）を課し、DB 側でも二重に検証しています。

`0016_storage_bucket_read.sql` で `storage.buckets` に SELECT ポリシーを追加しています
（`authenticated` がバケットの**存在と public フラグ**を読めるようにするためだけのもので、
オブジェクトの中身は上表のポリシーどおり所属組織に限定されます）。
これが無いと `storage.from(...).list()` が空を返し、
「Evidence バケットが private であること」をクライアントから検証できませんでした。

---

## 12. 検証（`pnpm test:rls`）

PGlite（インプロセス Postgres）へ `supabase/migrations/*.sql` をそのまま適用し、
`SET LOCAL ROLE authenticated` ＋ `request.jwt.claims` を切り替えて **304 件**（2026-10-01 時点。
開示優先モードの 17 表の越権・追記専用・職務分離・更新ガード、0039 の backfill、CSRD の 6 表の越権・
書込権限・ガードトリガ・複合外部キー・CHECK を含む）を検証します。

指示書 11 章「RLS Test に必ず含める」10 項目はすべて含まれています。

1. Enterprise A から Enterprise B を見られない
2. Assurance Firm A から Assurance Firm B を見られない
3. 未アサイン監査法人 User が案件を見られない
4. アサイン済みでも Grant 外の指標・Evidence を見られない
5. 監査法人 User が Client Data Point を更新できない
6. Site Contributor が他拠点 Data Point を更新できない
7. Snapshot を更新・削除できない
8. Audit Event を更新・削除できない
9. Signed URL 取得も権限外では失敗（`file_versions` が 0 行）
10. URL 直打ちでも 404 相当（ID 指定でも 0 行）

追加で検証している項目: 承認は Approver のみ / 承認済みデータの編集制限 /
代理 Sign-off 禁止 / 段階別 Sign-off 権限 / AI 自動承認の禁止 /
許諾の付与・取消は企業側のみ / 許諾取消の即時反映。
