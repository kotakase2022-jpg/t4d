# RLS マトリクス

`supabase/migrations/0012_rls_core.sql` / `0013_rls_assurance.sql`
（＋ `0016_storage_bucket_read.sql` / `0017_rls_counterparty_organization.sql`）の要約です。
**75 テーブルすべてで RLS を有効化**しており、`pnpm check:rls` が未設定を検出します。

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

| テーブル                               | SELECT                       | 更新系             |
| -------------------------------------- | ---------------------------- | ------------------ |
| organization_units                     | own ＋ **監査法人（grant）** | perm:org.manage    |
| reporting_periods                      | own ＋ **監査法人（grant）** | perm:period.manage |
| metric_definitions                     | own ＋ **監査法人（grant）** | perm:metric.manage |
| collection_campaigns / campaign_scopes | own                          | perm:period.manage |
| metric_assignments                     | own                          | perm:period.manage |
| emission_factors                       | own                          | perm:metric.manage |

## 3. Data（企業原本）

| テーブル                      | SELECT                       | INSERT                          | UPDATE                                                                             | DELETE |
| ----------------------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| data_points                   | own ＋ **監査法人（grant）** | perm:data.write ＋ unit scope   | perm:{write,review,approve} ＋ unit scope。`approved` への遷移は perm:data.approve | —      |
| data_point_versions           | own ＋ 監査法人（grant）     | perm:{write,review,approve}     | **—（追記専用＋トリガ）**                                                          | —      |
| data_point_calculations       | own ＋ 監査法人（grant）     | perm:data.write                 | —                                                                                  | —      |
| data_point_validation_results | own                          | perm:data.write                 | perm:data.write                                                                    | —      |
| aggregation_rules / runs      | own                          | perm:metric.manage / data.write | 同左                                                                               | —      |

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
`SET LOCAL ROLE authenticated` ＋ `request.jwt.claims` を切り替えて **56 件**を検証します。

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
