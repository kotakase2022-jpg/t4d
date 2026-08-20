# 認可設計（Authorization）

指示書 6 章・11 章に対応。**アプリ層と DB 層の二重防御**が基本方針です。

---

## 1. 二重防御

```
ブラウザ
  │
  ▼
Server Component / Server Action
  │  ① アプリ層: src/lib/authorization/can.ts
  │     can() / assertCan() / assertUnitInScope() / assertEngagementMember()
  ▼
Repository（DbClient）
  │
  ▼
Postgres
     ② DB 層: Row Level Security（169 ポリシー / 75 テーブル）
```

- アプリ層だけに依存しない（指示書 11 章冒頭）。
- Demo Mode では ② が無いため、① を必ず通す設計にしている。Demo でも越権できない。
- **権限定義は 2 か所に置き、テストで一致を保証する**
  （`src/lib/authorization/roles.ts` ↔ `supabase/migrations/0002_identity.sql` の `role_permissions`。
  `tests/unit/authorization.test.ts` が検査）。

---

## 2. 組織種別とロール

| Organization Type | ロール                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enterprise`      | enterprise_admin / sustainability_manager / site_contributor / supplier_contributor / reviewer / approver / external_advisor / viewer |
| `assurance_firm`  | assurance_admin / engagement_partner / assurance_manager / assurance_staff / specialist / assurance_viewer                            |
| `platform_admin`  | platform_admin                                                                                                                        |

### 意図的に厳しくしている点

| 論点               | 設計                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `enterprise_admin` | 組織・ユーザー・マスターは管理できるが、**データの最終承認権限は持たない**（職務分離） |
| `assurance_admin`  | 法人テナントとユーザーの管理のみ。**未アサイン案件のクライアントデータは一切見えない** |
| `platform_admin`   | Phase 1 ではクライアントデータへのアクセス権を持たない（`common.audit.read` のみ）     |
| 自己レビュー       | `assurance_tests` に `reviewed_by <> prepared_by` の CHECK 制約                        |
| 代理 Sign-off      | `signoffs.user_id = auth.uid()` を RLS の WITH CHECK ＋ トリガで強制                   |

---

## 3. 権限（PermissionKey）

37 個の権限キーで制御します。ロール名ではなく**権限で判定する**のが原則です
（ロールは組織ごとに増えうるため）。

```ts
can(ctx, 'enterprise.data.approve'); // 承認できるか
assertUnitInScope(ctx, unitId); // 担当拠点か
assertEngagementMember(ctx, engagementId); // アサインされた案件か（未アサインは NotFound）
```

主なグループ:

- `enterprise.*` — 組織 / 期間 / 指標 / メンバー / データ / Evidence / 取込 / 開示 / Export / AI / 許諾 / PBC 回答
- `assurance.*` — 法人管理 / 案件 / スコープ / Snapshot / 母集団 / サンプリング / 調書 / PBC / 指摘 / レビュー / Sign-off 3 段階 / Export / AI
- `common.audit.read` — 監査ログ閲覧

---

## 4. Unit スコープ（企業側）

`organization_memberships.unit_scope_ids` が空配列なら全社スコープ、値があればその Unit のみ。

- 画面: 担当外の行は表示するが編集 UI を出さない
- アプリ層: `assertUnitInScope()`
- DB 層: `t4d.unit_in_scope(organization_id, unit_id)` を UPDATE ポリシーの条件に含める

例）`site-user@demo.local`（東日本工場のみ担当）は西日本工場の Data Point を
**閲覧はできるが更新できない**（RLS テスト「6. Site Contributor は担当外拠点の Data Point を更新できない」）。

---

## 5. 状態遷移の権限

| 遷移先                   | 必要な権限                |
| ------------------------ | ------------------------- |
| `draft` / `submitted`    | `enterprise.data.write`   |
| `in_review` / `returned` | `enterprise.data.review`  |
| `approved`               | `enterprise.data.approve` |

RLS の `WITH CHECK` は **新しい行**しか見られないため、`approved` への遷移だけを RLS で判定し、
「どの状態からどの状態へ移ったか」はトリガ `t4d.enforce_data_point_transition()` で判定しています。
同トリガは「承認済みの値をレビュー権限なしに書き換えること」も禁止します。

さらに、承認には **Evidence 必須指標の Evidence が揃っていること**をアプリ層で要求します
（`transitionDataPoint()`）。

---

## 6. 企業 ↔ 監査法人の接続

```
enterprise                         assurance_firm
   │                                     │
   └──── organization_relationships ─────┘   （契約関係）
   └──── engagements ────────────────────┘   （案件）
              │
              └── client_access_grants        （企業が決める共有範囲）
                    subject_type: metric | organization_unit | reporting_period
                                | evidence_category | disclosure_item
```

監査法人が Data Point を読める条件（`t4d.assurance_can_read_data_point`）:

1. その案件の `engagement_members` である（`removed_at IS NULL`）
2. **指標**の Grant が有効
3. **組織**の Grant が有効
4. **期間**の Grant が有効
5. Data Point が企業側で `approved`

1 つでも欠けると 0 行。`revoked_at` を立てた瞬間から不可視になります
（RLS テスト「許諾を取り消すと即座に不可視になる」）。

Evidence（`file_versions`）はさらに `includes_evidence = true` の Grant を要求します。

---

## 7. Read-only by Default

監査法人向けの **SELECT ポリシーだけ**を追加し、UPDATE / DELETE ポリシーを作らないことで
「クライアント原本を書き換えられない」を構造的に保証しています。

| テーブル              | 監査法人 SELECT      | 監査法人 UPDATE         |
| --------------------- | -------------------- | ----------------------- |
| `data_points`         | ○（Grant 範囲）      | **ポリシーなし = 不可** |
| `data_point_versions` | ○                    | 不可（追記専用）        |
| `evidence_links`      | ○（Evidence 許諾時） | 不可                    |
| `file_versions`       | ○（Evidence 許諾時） | 不可                    |

監査法人の作業成果は `assurance_*` / `pbc_*` / `review_notes` / `signoffs` など
**別テーブル・別所有（`assurance_firm_id`）**で保存します。

---

## 8. 情報の非対称性

| データ                                         | 企業から                                   | 監査法人から |
| ---------------------------------------------- | ------------------------------------------ | ------------ |
| `review_notes`（`shared_with_client = false`） | 不可視                                     | 可視         |
| `pbc_requests.internal_note`                   | 不可視（`pbc_requests_client` ビュー経由） | 可視         |
| `pbc_requests`（`status = 'draft'`）           | 不可視                                     | 可視         |
| 監査法人の調書（`assurance_tests` 等）         | 不可視                                     | 可視         |
| 企業の未承認 Data Point                        | 可視                                       | 不可視       |

---

## 9. 存在の秘匿

権限外の対象は「アクセス拒否」ではなく **404 相当**として扱います。

- RLS: 該当行が 0 件で返る
- アプリ層: `NotFoundError` → 画面では `notFound()`（`loadEngagementOr404`）
- E2E: 未アサインの法人管理者が URL を直打ちしても「ページが見つかりません」

---

## 10. 監査記録

以下は必ず `audit_events` へ追記します（追記専用・PII 不保存）。

`login_success` / `login_failure` / `logout` / `workspace_selected` / `record_viewed` /
`file_uploaded` / `file_downloaded` / `signed_url_created` /
`data_created` / `data_updated` / `data_submitted` / `data_returned` / `data_approved` /
`permission_changed` / `access_grant_created` / `access_grant_revoked` /
`snapshot_created` / `snapshot_change_detected` / `sample_created` / `procedure_completed` /
`pbc_created` / `pbc_submitted` / `issue_created` / `issue_resolved` / `review_note_created` /
`signoff_created` / `ai_run_started` / `ai_run_completed` / `ai_output_accepted` / `export_created`
