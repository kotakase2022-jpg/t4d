# API 契約

Phase 1 では公開 API を提供しません（P3）。ここでは内部の Route Handler と
Server Action の契約を記載します。**すべて認証必須で、権限外は 404 / 403 を返します。**

---

## 1. Route Handlers

### `GET /api/jobs/[jobId]`

取込ジョブの状態取得 ＋ ワーカー起動（pull 型）。`queued` ならこのリクエストが処理を進めます。

|       |                                                                                     |
| ----- | ----------------------------------------------------------------------------------- |
| 認可  | ログイン済み ＋ 企業ワークスペース ＋ 自組織のジョブ                                |
| 200   | `{ id, status, progressPercent, totalRows, mappedRows, warningRows, errorMessage }` |
| 401   | 未ログイン                                                                          |
| 403   | 企業ワークスペースでない                                                            |
| 404   | 他組織のジョブ（存在を秘匿）                                                        |
| Cache | `no-store`                                                                          |

### `GET /api/files/signed-url?fileVersionId=&engagementId=`

Evidence の短時間 Signed URL を発行し、リダイレクトします。

|        |                                                                      |
| ------ | -------------------------------------------------------------------- |
| 認可   | `db.findById('fileVersions', id)` が取得できること（RLS / アプリ層） |
| 302    | Signed URL（既定 120 秒）                                            |
| 404    | 権限外・不存在                                                       |
| 副作用 | `storage_access_events`（signed_url_created）＋ `audit_events`       |

### `GET /api/files/download?bucket=&key=`

**Demo Mode 専用**の Signed URL 実体。Supabase Mode では 404。
Storage Key から DB を引き直して権限を再検証します。

|        |                                                                              |
| ------ | ---------------------------------------------------------------------------- |
| 200    | ファイル本体（`Content-Disposition: attachment`）                            |
| 404    | Supabase Mode / 権限外 / 不存在                                              |
| 410    | Demo Mode でアップロード実体が失われている（Fixture 由来 or サーバー再起動） |
| 副作用 | `storage_access_events`（downloaded）＋ `audit_events`（file_downloaded）    |

### `GET /api/exports/data-points?period=&format=csv|xlsx`

非財務データ台帳の Export。

|        |                                               |
| ------ | --------------------------------------------- |
| 認可   | 企業ワークスペース ＋ `enterprise.export.run` |
| 200    | CSV（UTF-8 BOM 付き）または XLSX              |
| 403    | 権限なし                                      |
| 副作用 | `audit_events`（export_created）              |

### `GET /api/exports/cdp?period=&format=csv|xlsx|docx`

CDP 回答の Export。DOCX はセクション別の開示ドラフト（一問一答の転記用）。

|        |                                               |
| ------ | --------------------------------------------- |
| 認可   | 企業ワークスペース ＋ `enterprise.export.run` |
| 副作用 | `audit_events`（export_created）              |

### `GET /api/exports/engagement?engagementId=&format=xlsx|csv`

案件パッケージ Export（13 シート: スコープ / Snapshot 項目 / Snapshot 後変更 / 母集団 /
サンプル / テスト / テスト結果 / PBC / 指摘 / レビューNote / Sign-off / 監査ログ）。

|        |                                                                       |
| ------ | --------------------------------------------------------------------- |
| 認可   | 監査法人ワークスペース ＋ `assurance.export.run` ＋ Engagement Member |
| 404    | 未アサイン案件                                                        |
| 副作用 | `audit_events`（export_created）                                      |

---

## 2. Server Actions

すべて `requireEnterpriseContext()` / `requireAssuranceContext()` で認可コンテキストを取得してから
Service を呼びます。Action 自体は業務ロジックを持ちません。

### 企業（`src/app/enterprise/actions.ts`）

| Action                        | 入力（FormData）                                             | 主な副作用                                         |
| ----------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `uploadFilesAction`           | reportingPeriodId, unitId, files[]                           | ファイル保存 ＋ ジョブ作成 → ジョブ画面へ redirect |
| `confirmImportAction`         | jobId, rowId[], include/metricId/unitId/value/unitOfMeasure  | Data Point の作成・版追加                          |
| `transitionDataPointAction`   | dataPointId, to, comment                                     | 状態遷移 ＋ approvals ＋ comments ＋ 監査ログ      |
| `bulkTransitionAction`        | selected[], to                                               | 一括遷移（失敗行はスキップ）                       |
| `updateDataPointAction`       | dataPointId, value, unitOfMeasure, methodology, changeReason | 版追加 ＋ 承認後変更フラグ                         |
| `linkEvidenceAction`          | dataPointId, fileVersionId, page, cellRef, note              | evidence_links                                     |
| `uploadEvidenceAction`        | file, documentType, reportingPeriodId                        | files / file_versions                              |
| `generateCdpDraftAction`      | responseId                                                   | AI 実行 ＋ draft 版追加（承認しない）              |
| `saveCdpResponseAction`       | responseId, answerText/Numeric/Choice, aiRunId, editedFromAi | 版追加（AI 由来フラグを外す）＋ AI 採否記録        |
| `rejectAiDraftAction`         | aiRunId, comment                                             | ai_runs.status = rejected                          |
| `transitionCdpResponseAction` | responseId, to                                               | 状態遷移（AI 由来の approved は拒否）              |
| `toggleGrantAction`           | grantId, revoke                                              | 許諾の取消・再付与 ＋ 監査ログ                     |
| `respondPbcAction`            | requestId, body, file                                        | pbc_request_responses ＋ 監査ログ                  |

### 監査法人（`src/app/assurance/actions.ts`）

| Action                       | 入力                                                               | 主な副作用                                 |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `createSnapshotAction`       | engagementId, label                                                | Snapshot ＋ Snapshot Items（Immutable）    |
| `assessSnapshotChangeAction` | engagementId, snapshotItemId, assessment                           | 影響評価の記録                             |
| `createSampleAction`         | populationId, method, seed, targetSize, rationale ほか             | Sample ＋ Sample Items ＋ 調書の自動生成   |
| `recordTestResultAction`     | testId, procedureId, result, recalculation…, note                  | assurance_test_results                     |
| `updateTestAction`           | testId, action(save/prepare/review), conclusionDraft, workpaperRef | 調書更新（自己レビュー禁止）               |
| `createPbcAction`            | title, dueDate, priority, description, internalNote                | pbc_requests（status=sent）                |
| `decidePbcAction`            | responseId, decision, rejectReason                                 | 受領判定                                   |
| `createIssueAction`          | title, severity, description, 影響指標/サンプル, 定量的影響        | assurance_issues                           |
| `resolveIssueAction`         | issueId, resolution                                                | 解消記録                                   |
| `createReviewNoteAction`     | body, assignedTo, sharedWithClient                                 | review_notes（既定は内部限定）             |
| `clearReviewNoteAction`      | noteId, resolutionComment                                          | クリア                                     |
| `createSignoffAction`        | engagementId, stage, comment                                       | **抑止条件を満たす場合のみ** Sign-off 追記 |
| `summarizeChangesAction`     | engagementId                                                       | AI による差分要約（評価は確定しない）      |

---

## 3. エラーの扱い

| 状況                       | 挙動                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| 未ログイン                 | middleware が `/login` へリダイレクト                             |
| ワークスペース種別違い     | `/workspace` へリダイレクト                                       |
| 権限なし（アプリ層）       | `AuthorizationError` → 画面はエラー境界で「権限がありません」     |
| 権限なし（存在秘匿すべき） | `NotFoundError` → `notFound()` → 404 ページ                       |
| RLS で 0 行                | 「見つかりません」として扱う                                      |
| Production の例外          | 詳細を出さず digest のみ表示（Secret / SQL / Stack を露出しない） |
