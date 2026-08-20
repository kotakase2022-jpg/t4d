# TEST_CASES — T4D

要求仕様トレーサビリティ（`REQUIREMENTS_TRACEABILITY.csv`）の TC-xxx に対応するテストケース定義です。
**自動化されているものは実行コマンドと spec 名を、手動確認のものは手順を記載しています。**

## 0. 実行方法

```bash
pnpm test              # unit + integration（130 件）
pnpm test:rls          # PGlite 上の実 Postgres で越権検証（56 件）
pnpm test:e2e          # Demo Mode の実ブラウザ（73 件）
pnpm test:e2e:supabase # 実 Supabase 接続の実ブラウザ（9 件）
pnpm verify:supabase   # 実 Supabase へ直接 33 項目
pnpm verify:openai:all # 実 OpenAI へ 8 Use Case
```

実行ログは `qa/evidence/logs/`、画面証拠は `qa/evidence/screenshots/`（22 枚）にあります。

---

## 1. 正常系（業務フロー）

| TC     | 内容                                                              | 自動化 | 実装                                                      |
| ------ | ----------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| TC-144 | 企業: 取込 → プレビュー修正 → 確定 → 提出 → レビュー → 承認       | 済     | `vertical-slices.spec.ts` 3-6                             |
| TC-145 | 企業: CDP へマッピング → AI ドラフト → 人が編集 → 承認            | 済     | `vertical-slices.spec.ts` 7                               |
| TC-146 | 監査法人: 案件表示 → Data Room → Snapshot 固定                    | 済     | `vertical-slices.spec.ts` 9-10                            |
| TC-147 | 監査法人: 母集団 → サンプリング → Testing 三ペイン                | 済     | `vertical-slices.spec.ts` 11-12                           |
| TC-148 | 監査法人: PBC → 企業回答 → 受理／Issue → レビュー Note → Sign-off | 済     | `vertical-slices.spec.ts` 13-14 ＋ `action-audit.spec.ts` |
| TC-149 | Snapshot 後の企業側変更を検知                                     | 済     | `vertical-slices.spec.ts`                                 |
| TC-150 | 抑止条件がある間は Sign-off できない／解消後に可能                | 済     | `vertical-slices.spec.ts` 15-16                           |
| TC-152 | CSV／XLSX／DOCX Export                                            | 済     | `vertical-slices.spec.ts` ＋ `robustness-audit.spec.ts`   |

### ログイン（全ロール）

| TC     | ロール                                                   | 自動化                                                   |
| ------ | -------------------------------------------------------- | -------------------------------------------------------- |
| TC-008 | 企業管理者・拠点担当・サステナ担当・レビュー担当・承認者 | 済（`screen-audit.spec.ts` のロールマトリクス 6 ロール） |
| TC-008 | 監査法人マネージャー・契約責任者・担当者・法人管理者     | 済（同上）                                               |
| TC-008 | 別テナント 2 ロール（越権確認用）                        | 済（`robustness-audit.spec.ts`）                         |
| TC-008 | 実 Supabase Auth でのログイン／誤パスワード拒否          | 済（`supabase-mode.spec.ts`）                            |

### 一覧操作（UX-P0-004）

| TC      | 内容                                                            | 自動化                            |
| ------- | --------------------------------------------------------------- | --------------------------------- |
| TC-004a | 値の昇順・降順で並べ替え（**DB 側**で全体を並べ替えていること） | 済（`table-controls.spec.ts`）    |
| TC-004b | 並べ替えると 1 ページ目へ戻る                                   | 済                                |
| TC-004c | 列表示切替が URL に保持され、リロードでも維持                   | 済                                |
| TC-004d | 指標列は常に表示（外せない）                                    | 済                                |
| TC-004e | 検索の Debounce → URL 反映 → 結果反映                           | 済（`interaction-audit.spec.ts`） |
| TC-004f | フィルターのトグルと解除                                        | 済                                |
| TC-004g | 保存ビューの適用                                                | 済                                |
| TC-004h | ページング（次へ・前へ）                                        | 済                                |
| TC-004i | 一括選択 → 一括提出                                             | 済（`action-audit.spec.ts`）      |
| TC-004j | CSV／XLSX ダウンロード                                          | 済                                |

---

## 2. 画面遷移

| TC          | 内容                                                                    | 自動化                                |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------- |
| TC-119〜121 | 必須 Route 34 本すべてが存在し描画される                                | 済（`screen-audit.spec.ts` クロール） |
| TC-166      | 到達可能な全画面（企業 83／監査法人 17）の描画・Console エラー 0        | 済（同上）                            |
| TC-167      | サイドバー全項目（企業 15／監査法人 14）の **Client 遷移で URL が確定** | 済（同上）                            |
| TC-168      | 本文リンク（ダッシュボード 21／案件ホーム 8）の Client 遷移             | 済（同上）                            |
| TC-169      | 案件セレクタでサブページを保ったまま遷移                                | 済（`interaction-audit.spec.ts`）     |
| TC-170      | コマンドパレット（Ctrl+K）から選択して遷移                              | 済（同上）                            |
| TC-171      | ブラウザリロード後も列設定・フィルターが維持（URL State）               | 済（`table-controls.spec.ts`）        |
| TC-172      | 未ログインで保護ルートへ直接アクセス → `/login` へ                      | 済（`vertical-slices.spec.ts`）       |
| TC-173      | ログアウト後は保護ルートへ入れない                                      | 済（`interaction-audit.spec.ts`）     |

> **Client 遷移の確定を必ず検証しています。** `page.goto` はサーバー側しか見ません。
> Next.js #86151（Suspense 境界があると RSC 受信済みでも遷移が確定しない）を実際に踏んだため、
> クリック後に URL が変わることを全リンクで確認しています。

---

## 3. 異常系・境界値

| TC     | 内容                                                         | 期待                             | 自動化                           |
| ------ | ------------------------------------------------------------ | -------------------------------- | -------------------------------- |
| TC-174 | 存在しない ID（Data Point／CDP 質問／取込ジョブ／framework） | 404（500 でない）                | 済（`robustness-audit.spec.ts`） |
| TC-175 | 存在しない案件 ID                                            | 404（**存在を秘匿**）            | 済                               |
| TC-176 | `?page=-1` `?page=abc` `?page=99999`                         | 500 にならない                   | 済                               |
| TC-177 | `?status=not_a_status` `?flag=nonsense` `?unit=<不正UUID>`   | 500 にならない                   | 済                               |
| TC-178 | 検索に `<script>alert(1)</script>`                           | エスケープされ 500 にならない    | 済                               |
| TC-179 | `?sort=not_a_column` `?dir=sideways` `?cols=`（空）          | 既定値へフォールバック           | 済（`table-controls.spec.ts`）   |
| TC-180 | 必須項目未入力での保存（変更理由なし）                       | ブラウザ検証でブロック           | 済（`action-audit.spec.ts`）     |
| TC-181 | Evidence 紐付けで placeholder を選択                         | `required` によりブロック        | 済                               |
| TC-182 | 同一 Evidence の二重紐付け                                   | 冪等（増えない）                 | 済                               |
| TC-183 | 取込ジョブの重複実行                                         | 冪等キーで防止                   | 済（integration）                |
| TC-184 | データ 0 件の一覧                                            | Empty State を表示               | 済（クロール）                   |
| TC-185 | 許可されない状態遷移                                         | 拒否                             | 済（integration）                |
| TC-186 | AI 生成のままの承認                                          | アプリ層と DB トリガの双方で拒否 | 済（integration ＋ RLS）         |

---

## 4. 権限マトリクス

`pnpm test:rls`（56 件）と `pnpm verify:supabase`（33 件）で検証。**UI で隠すだけでなく DB 層で拒否**していることを確認しています。

| 観点                                               | TC     | 検証                                               |
| -------------------------------------------------- | ------ | -------------------------------------------------- |
| 企業 A → 企業 B のデータ                           | TC-141 | RLS で不可。URL 直打ちでも 404                     |
| 監査法人 A → 監査法人 B                            | TC-142 | RLS で不可                                         |
| 未アサイン監査法人管理者 → 案件                    | TC-010 | 404（存在秘匿）。**API 直実行も拒否**              |
| アサイン済みでも Grant 外の指標・Evidence          | TC-048 | 不可視。許諾付与直後から可視                       |
| 監査法人 → クライアント原本の更新                  | TC-011 | UPDATE ポリシー不在により不可能                    |
| 拠点担当 → 他拠点の Data Point 更新                | TC-009 | Unit スコープで拒否                                |
| Snapshot／Audit Event の更新・削除                 | TC-131 | 追記専用（トリガ＋ポリシー）                       |
| 代理 Sign-off                                      | TC-057 | `user_id = auth.uid()` を強制                      |
| Signed URL の権限外取得                            | TC-125 | 拒否                                               |
| API 直接実行（未ログイン／他テナント／未アサイン） | TC-187 | `robustness-audit.spec.ts` で 6 エンドポイント検証 |

> **API はページ内 `fetch` で検証しています。** Playwright の `page.request` は
> BrowserContext の httpOnly Cookie を送らず、ログイン済みでも 401 になるためです。

---

## 5. Server Action の実動作（TC-188〜199）

`action-audit.spec.ts` が、シナリオテストで通らない Server Action を UI から実際に叩き、
**結果が画面へ反映されること**まで確認します（revalidate 漏れの検出）。

bulkTransition / updateDataPoint / linkEvidence / uploadEvidence / rejectAiDraft /
toggleGrant / respondPbc / decidePbc / assessSnapshotChange / createReviewNote /
clearReviewNote / summarizeChanges の 12 種。

---

## 5b. QA フェーズ 6C〜6E で追加（2026-08-18・P0 解消分）

| TC     | 要件        | 内容                                                                                                | 自動化                                                                                |
| ------ | ----------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| TC-210 | WF-P0-002   | @メンション解決（最長一致・正規化完全一致・自己通知なし・2000字上限・他組織拒否）                   | 済（`comments-mentions.test.ts` 11 件）                                               |
| TC-211 | WF-P0-002   | データ詳細・CDP/CSRD 回答・差戻しコメントでメンション→ハイライト表示→通知作成                       | 済（`mentions-evidence.spec.ts`）                                                     |
| TC-212 | EVID-P0-002 | Evidence Viewer: 画像/PDF 画面内表示・セル参照/断片ハイライト・メタデータ/関連データ/版の同時表示   | 済（`mentions-evidence.spec.ts` 6 件）                                                |
| TC-213 | EVID-P0-002 | `/api/files/inline` は許可 MIME（png/jpeg/gif/webp/pdf）のみ・他組織ファイル拒否                    | 済（同上・API 直叩き）                                                                |
| TC-214 | DATA-P0-004 | 前年度から複製（承認済み→draft・既存/対象外/内部取引スキップ・sourceType=carry_forward）            | 済（`data-entry-aggregation.test.ts` 11 件）                                          |
| TC-215 | DATA-P0-004 | Excel テンプレート出力（拠点×項目・hqOnly 制御）・コピペ表入力→取込パイプライン                     | 済（`data-entry-aggregation.spec.ts` 5 件）                                           |
| TC-216 | DATA-P0-006 | 連結集計: 単純合計/持分調整/内部取引控除(2,490.5t)/連結値/前年推計/加重平均(Σ分子÷Σ分母)/除外拠点   | 済（integration＋GHG 画面 E2E）                                                       |
| TC-217 | AUTH-P0-001 | 招待ライフサイクル（作成→受諾→ロール付与／重複・形式・失効・期限切れ・権限・他組織の負ケース）      | 済（`identity.test.ts` 7 件）                                                         |
| TC-218 | AUTH-P0-001 | 実ブラウザ: 招待リンク発行→未ログインで受諾→参加、失効リンクは使用不可                              | 済（`auth-copilot.spec.ts`）                                                          |
| TC-219 | AUTH-P0-001 | 実 Supabase: 管理者が再設定リンク発行（Cookie 受け渡し）→本人が新 PW 設定→旧 PW 拒否→新 PW ログイン | 済（`e2e-supabase/auth-security.spec.ts`）                                            |
| TC-220 | AUTH-P0-001 | 実 Supabase: MFA 登録→ログインでコード必須→AAL1 で URL 直打ち拒否→誤コード拒否→検証後入場→解除      | 済（同上。TOTP は RFC 6238 自前実装 `tests/support/totp.ts`、RFC テストベクタで検証） |
| TC-221 | AI-P0-001   | Copilot: 権限内スナップショット限定・会話継続・他人/他組織の会話は読めない・参照リンク検証          | 済（`copilot.test.ts` 8 件）                                                          |
| TC-222 | AI-P0-001   | 実ブラウザ: 実データ回答＋出典＋会話継続＋リロード復元、不明事項に推測で答えない                    | 済（`auth-copilot.spec.ts`）＋実 OpenAI（confidence 0.99）                            |

---

## 5c. 独立最終レビューの回帰（2026-08-18・フェーズ 8）

| TC     | 対応 BUG | 内容                                                                                     | 自動化                                  |
| ------ | -------- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| TC-230 | BUG-037  | 再設定リンクは自組織メンバーのみ。他テナント（監査法人・別企業）指定は拒否＋監査ログ記録 | 済（`review-fixes` 3 件・Supabase E2E） |
| TC-231 | BUG-038  | 実 Supabase Auth で招待受諾（アカウント作成→ログイン→メンバー表示→受諾済み）             | 済（`auth-security.spec.ts`）           |
| TC-232 | BUG-039  | 内部取引の明細行が Data Room・母集団に入らない／欠損件数が潰れない                       | 済（`review-fixes`）                    |
| TC-233 | BUG-040  | 招待 ID がランダム UUID（決定論的ハッシュでない）                                        | 済（Supabase E2E の形式アサート）       |
| TC-234 | BUG-041  | 内部取引行が前年の連結値と比較されない（虚偽の前年比警告が出ない）                       | 済（`review-fixes`）                    |
| TC-235 | BUG-042  | テンプレートは hqOnly をデータモデルで判定（従業員数は拠点行、Scope3 Cat.1 は本社のみ）  | 済（`review-fixes`・Excel を実読み）    |
| TC-236 | BUG-043  | href 検証が `..` / `%2e%2e` / `javascript:` / 外部 URL / `//host` を拒否                 | 済（`safe-link` 15 件）                 |
| TC-237 | BUG-044  | 表示名が正規化衝突するメンションは全員へ通知                                             | 済（`review-fixes`）                    |
| TC-238 | BUG-045  | 開示権限の無いロールは開示回答へコメントできない（Data Point へは従来どおり可）          | 済（`review-fixes` 2 件）               |
| TC-239 | BUG-046  | 遷移コメント（差戻し理由）も 2,000 文字制限を受ける                                      | 済（`review-fixes`）                    |
| TC-240 | BUG-047  | Evidence 必須指標の承認済み行に Evidence が紐づく（品質統計を汚さない）                  | 済（`review-fixes`）                    |

---

## 6. アクセシビリティ

| TC     | 内容                                                      | 自動化                          |
| ------ | --------------------------------------------------------- | ------------------------------- |
| TC-006 | 4 画面で axe の critical／serious 違反 0 件               | 済（`vertical-slices.spec.ts`） |
| TC-007 | キーボードショートカット（Ctrl+K／j／k／e／入力中は無効） | 済                              |
| TC-200 | Dialog の Focus Trap と Esc                               | 済（コマンドパレット）          |

---

## 7. 未自動化（手動確認）

| TC     | 内容                             | 理由                                                                                     |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------- |
| TC-201 | 1280／1600／1920px での表示      | 1440px のみ自動化。他解像度は目視                                                        |
| TC-202 | 通信切断・二重クリック・連続送信 | Server Action は冪等キーと `required` で保護しているが、ネットワーク断の自動再現は未実施 |
| TC-203 | 大量データ（数万件）での性能     | Fixture は 1 期間 32 件。性能測定は未実施（`assumptions.md` G-8）                        |
| TC-204 | ファイルサイズ超過・不正 MIME    | サイズ上限の設定値が未確定（`assumptions.md`）                                           |
