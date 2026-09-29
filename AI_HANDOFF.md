# AI_HANDOFF

各 Milestone の変更・テスト・未解決・次作業の記録です。新しい作業をしたら**追記**してください。

---

## 2026-08-14 — M0〜M7 初回構築（空リポジトリ → Phase 1 完成）

### 前提

- リポジトリはコミット 0 件の空リポジトリだった。既存実装の破壊はなし。
- 実 Supabase / OpenAI API Key は未提供。既定は Demo / Fixture Mode。
- 本番 Deploy・実ユーザー招待・外部メール送信は実行していない。`main` への Push もしていない。

---

### M0 調査・計画

- `docs/implementation-plan.md`（現状・アーキテクチャ方針・Milestone・リスク 8 件・実装順）
- `docs/assumptions.md`（A 外部資格情報 / B 業務マスター / C 権限解釈 / D 技術選択 / E データ・時刻 / F 対象外 / G 未入手）
- Drive の `T4D logo.png`（2172×724 PNG）を `public/brand/t4d-logo.png` へ実体配置。

### M1 基盤

- Next.js 15.5 / React 19 / Tailwind 4 / TypeScript strict + `noUncheckedIndexedAccess`
- ブランドトークン（`src/app/globals.css`）、UI プリミティブ 13 種（Radix + cva + cn）
- AppShell（Top Bar 48px / Sidebar 224–64px / Compact Density）、BrandLogo、Command Palette、Help
- Demo Auth（`t4d_demo_user` Cookie、本番 Auth と別経路）、Workspace 選択、middleware Route Guard
- Loading / Empty / Error / Permission Denied の共通状態部品

### M2 DB・RLS

- Migration 15 本 / **75 テーブル** / **167 RLS ポリシー**
- 認可ヘルパー（`t4d.*` SECURITY DEFINER、`search_path` 固定）
- Immutability トリガ（Snapshot / Snapshot Item / Audit Event / Sign-off / 各 Version / Approvals）
- 代理 Sign-off 禁止トリガ、AI 自動承認禁止トリガ、Data Point 状態遷移トリガ
- Storage（5 Bucket / Path 規約 / Path Traversal 禁止）。Supabase 非依存環境では安全にスキップ
- `supabase/seed.sql` は Fixture から自動生成（`pnpm seed:generate`）
- **PGlite（WASM Postgres）に migration をそのまま適用して RLS を実検証**する仕組みを構築

### M3 企業 Vertical Slice

- Dashboard（KPI 7 種・すべて Filter 付き遷移）/ データ収集（Upload → 非同期ジョブ → Preview → Confirm）
- 非財務データ一覧（複合フィルター・保存ビュー・サーバーページング・一括操作）
- Data Point 詳細（定義・値編集・算定内訳・Version 履歴・Validation・Evidence・承認履歴・Audit Timeline）
- 組織・拠点 / Evidence / ワークフロー（タスク・PBC 回答）/ アラート / GHG / AI Copilot / レポート / 設定（許諾管理）/ 今後対応
- CDP ワークスペース（三ペイン・YoY Diff・前年差分だけ回答フィルター）
- Export（CSV / XLSX / DOCX）

### M4 監査法人 Vertical Slice

- 案件ホーム（横断 KPI 7 種）/ 保証契約 / スコープ Matrix / Data Room（Read-only・Snapshot・変更検知）
- 母集団（完全性）/ サンプリング（4 方式・Seed 再現）/ Testing 三ペイン（手続・再計算・結論）
- PBC（内部メモ分離）/ 指摘（経営者回答）/ レビューNote（共有フラグ）/ Sign-off（抑止条件 6 種）
- 監査ログ / 案件パッケージ Export（13 シート）/ 設定

### M5 OpenAI

- `AIProvider` / `OpenAIProvider`（Responses API + `zodTextFormat`）/ `MockAIProvider`（決定論的）
- Use Case 8 種すべてに Zod スキーマ（`confidence` / `warnings` / `sources` 必須）
- `ai_runs` に Provenance（provider / model / prompt_version / 参照元 / token / cost / 採否）
- Timeout / Retry / Rate Limit / Idempotency

### M6 品質

- Unit 95 / Integration 35 / RLS 56 / E2E 27 = **213 件**
- axe による a11y 検査（4 画面、critical・serious ゼロ）

### M7 Handoff

- README / AGENTS.md / CLAUDE.md（同一内容）/ docs 12 本

---

## テスト結果（M0〜M7 完了時点）

> 最新の実行結果は末尾の「2026-08-14（追記）」を参照してください。

| コマンド            | 結果                                  | 内容                                                 |
| ------------------- | ------------------------------------- | ---------------------------------------------------- |
| `pnpm lint`         | ✅ 成功                               | エラー 0 / 警告 0                                    |
| `pnpm format:check` | ✅ 成功                               | All matched files use Prettier code style            |
| `pnpm typecheck`    | ✅ 成功                               | エラー 0（strict + noUncheckedIndexedAccess）        |
| `pnpm test`         | ✅ 成功                               | 9 files / **130 passed**（unit 95 + integration 35） |
| `pnpm test:rls`     | ✅ 成功                               | 1 file / **56 passed**（PGlite 上の実 Postgres）     |
| `pnpm test:e2e`     | ✅ 成功                               | **27 passed**（16 ステップ通し ＋ a11y 4 画面）      |
| `pnpm build`        | ✅ 成功                               | Compiled successfully / 41 ルート                    |
| `pnpm check:rls`    | ✅ 成功                               | 75 テーブル中 75 で RLS 有効 / 167 ポリシー          |
| `pnpm verify:env`   | ✅ 成功                               | Demo Mode 判定                                       |
| `pnpm audit --prod` | ✅ **No known vulnerabilities found** | 下記の対応後                                         |

### 依存関係の脆弱性対応

初回監査で 18 件（critical 1 / high 10 / moderate 7）を検出。すべて推移的依存でした。

| 対象                                      | 経路                                          | 対応                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tar`（critical 1 + high 6 + moderate 5） | `unpdf > canvas > @mapbox/node-pre-gyp > tar` | `canvas` を `ignoredOptionalDependencies` で依存ツリーから除外。T4D は pdf.js のテキスト抽出しか使わずネイティブレンダリング不要。除外後も PDF 抽出が動作することを `tests/unit/pdf-parser.test.ts` で検証 |
| `postcss`（high 1 + moderate 2）          | `next > postcss`                              | `overrides: postcss >=8.5.23`                                                                                                                                                                              |
| `sharp`（high 1）                         | `next > sharp`                                | `overrides: sharp >=0.35.0`                                                                                                                                                                                |
| `uuid`（moderate 1）                      | `exceljs > uuid`                              | `overrides: uuid >=11.1.1`                                                                                                                                                                                 |

対応後、typecheck / 130 テスト / build がすべて成功することを再確認済み。

---

## 実装中に見つけて直した欠陥

テストが機能したケースとして記録します（テストを緩めず実装を直しました）。

| #   | 発見元     | 内容                                                                                                                           | 対応                                                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | RLS テスト | `sha256` 列が `sha_256` に変換されていた（`toSnake` が数字も分割）                                                             | 数字を分割しないよう修正。往復変換テストを追加                               |
| 2   | RLS テスト | 承認済みデータの編集可否を**ロール名**で判定していた（DB トリガは権限で判定）ため、`sustainability_manager` が編集できなかった | アプリ層も権限判定へ統一（`can(ctx,'enterprise.data.review')`）              |
| 3   | RLS テスト | `auth.uid()` シムがクレーム未設定時に例外（`''::json`）                                                                        | `coalesce(nullif(...,''),'{}')` へ修正                                       |
| 4   | E2E        | 未アサイン監査法人ユーザーが URL 直打ちした際、404 ではなくエラー境界が表示されていた                                          | `loadEngagementOr404()` を追加し、権限外は `notFound()`（存在を秘匿）        |
| 5   | E2E（axe） | danger / success バッジが soft 背景上で WCAG AA（4.5:1）未達                                                                   | ブランドトークンの明度を調整（#C83B3B→#A61B1B、#16815B→#12704E）。色相は維持 |
| 6   | 依存監査   | canvas 由来の tar 脆弱性                                                                                                       | 依存ツリーから除外                                                           |

---

## 未解決 / 引き継ぎ事項

### 発注者への確認待ち（`docs/assumptions.md` G 節）

1. Supabase プロジェクト（本番／ステージング）の払い出しと Service Role Key の受け渡し方法
2. OpenAI 組織アカウントと、AI へ送信可能な情報区分（機密区分の定義）
3. CDP / SSBJ 正式マスターの入手経路とライセンス
4. 排出係数データベースの採用元とライセンス
5. 監査法人ごとの調書テンプレート・調書番号採番規則
6. データ保持期間、Legal Hold、削除ポリシー
7. 本番 SSO（IdP 種別・契約）
8. 最大 Upload 容量、同時利用者数、性能目標

### 技術的な残作業

`docs/known-limitations.md` に全件記載。優先度順の抜粋:

1. ~~実 Supabase での動作確認~~ → **完了**（下記 2026-08-14 追記）
2. **OpenAI 実接続の確認**（`OpenAIProvider` の実通信は未検証。スキーマ適合はテスト済み）
3. ~~一覧の DB 側ページング化~~ → **完了**
4. ~~CSP の Nonce 化~~ → **完了**（`style-src` の `'unsafe-inline'` のみ残置）
5. キーボードショートカット `j`/`k`/`e`/`c`/`s` のグローバル割当
6. Evidence Viewer の PDF/画像インライン表示
7. 個人設定（列表示・密度・保存ビュー）の永続化
8. Next.js 16 へ上げる際に Loading 境界を復活できるか確認（`docs/known-limitations.md` 10 章）

---

## 次に着手するときの手順

```bash
pnpm install
pnpm dev                # Demo Mode で確認
pnpm test && pnpm test:rls   # 変更前の状態を確認
```

---

## 2026-08-14（追記） — 実 Supabase 接続 / DB 側ページング / Nonce CSP

### やったこと

| #   | 内容                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- |
| 1   | **実 Supabase（CLI ローカルスタック）へ全 migration + seed を適用**し、Auth・RLS・Storage を実接続で検証 |
| 2   | 非財務データ一覧を **DB 側の絞り込み・並べ替え・LIMIT/OFFSET** へ変更（検証結果を materialize）          |
| 3   | CSP を **リクエストごとの nonce ＋ `strict-dynamic`** へ移行（middleware で発行）                        |
| 4   | Supabase Mode の**ログインフォーム**（email/password）を実装                                             |
| 5   | Client 側遷移が固まる不具合（Next.js #86151）を回避し、回帰 E2E を追加                                   |

**本番 Supabase プロジェクトには一切触れていません。**接続先は Supabase CLI が
ローカルに立てたスタック（`http://127.0.0.1:54421`）だけです。
ポートは他プロジェクト（`jpxmap`）と衝突しないよう `supabase/config.toml` でずらしています。

### 追加した migration

| ファイル                                 | 内容                                           | 発見経路                                           |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `0016_storage_bucket_read.sql`           | `storage.buckets` の SELECT ポリシー           | `verify:supabase` の Storage 検証が 3 件失敗       |
| `0017_rls_counterparty_organization.sql` | 保証契約の**相手方組織メタデータ**のみ参照可に | Supabase Mode E2E でクライアント企業名が空になった |

### 追加したコマンド

```bash
pnpm verify:supabase     # 実 Supabase へ 33 項目の越権・不変性・Storage 検証
pnpm test:e2e:supabase   # 実 Auth でログインして通す E2E（7 件）
```

### 実 Supabase でしか出なかった欠陥

| #   | 内容                                                                                              | 対応                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 7   | GoTrue が `confirmation_token` 等の NULL を読めずログイン不能（"Database error querying schema"） | Seed の `auth.users` へ空文字を入れる（`to-sql.ts`）                                                      |
| 8   | `storage.buckets` を読めずバケット存在検証が不能                                                  | migration `0016`                                                                                          |
| 9   | 監査法人が案件のクライアント企業名を読めない／企業が監査法人名を読めない                          | migration `0017`                                                                                          |
| 10  | ログイン失敗の監査ログが anon ロールで INSERT できずページごと落ちる                              | `recordAuditEvent` を Service Role 経路にし、失敗しても業務処理を落とさない（記録漏れは `console.error`） |
| 11  | Supabase Mode にログインフォームが無かった（Demo ボタンのみ）                                     | `supabaseLoginAction` ＋ email/password フォーム                                                          |

### Framework 不具合（Next.js 15.5.23）

`loading.tsx` または Layout 内 `<Suspense>` があると、**RSC Payload を 200 で完全受信していても
Client 側遷移が確定せず、URL が変わらないまま無言で固まる**
（[vercel/next.js#86151](https://github.com/vercel/next.js/issues/86151)）。

`/assurance/engagements/[engagementId]/*` への遷移で 100% 再現。
Demo Mode では応答が速いぶん間欠的で、E2E を通しで流したときだけ落ちていました。

**回避策**: 両ワークスペースの Loading 境界を削除（Layout 内 `<Suspense>` でも同じく固まるため、
置き換えでは回避できません）。回帰は `tests/e2e/vertical-slices.spec.ts` の
`Client 側遷移` describe が検出します。詳細は `docs/known-limitations.md` 10 章。

### テスト結果（この追記時点）

| コマンド                                   | 結果                                               |
| ------------------------------------------ | -------------------------------------------------- |
| `pnpm lint` / `format:check` / `typecheck` | ✅                                                 |
| `pnpm test`                                | ✅ **130 passed**                                  |
| `pnpm test:rls`                            | ✅ **56 passed**                                   |
| `pnpm test:e2e`                            | ✅ **29 passed**（Client 側遷移の回帰 2 件を追加） |
| `pnpm test:e2e:supabase`                   | ✅ **7 passed**（実 Supabase）                     |
| `pnpm verify:supabase`                     | ✅ **33 / 33**                                     |
| `pnpm build`                               | ✅                                                 |

### まだやっていないこと

- **OpenAI 実接続**は未着手です（→ 下の 2026-08-15 で完了）。
- リモート（本番／ステージング）Supabase への `db push` は未実施です。

---

## 2026-08-15 — OpenAI 実接続（Model: gpt-5.6-terra）

### やったこと

発注者が `.env.local` に `OPENAI_API_KEY` を設定。指示により `OPENAI_MODEL=gpt-5.6-terra` を使用。
API Key の値は読み出していません（設定は Script 経由で行い、標準出力にも出していません）。

| #   | 内容                                                                                         |
| --- | -------------------------------------------------------------------------------------------- |
| 1   | `pnpm verify:openai`（`scripts/verify-openai.ts`）を追加。**1 リクエストだけ**送って疎通確認 |
| 2   | `openai` SDK を **v4.104.0 → v7.4.0** へ更新（下記の不具合のため）                           |
| 3   | 推定コストの誤算定を修正（単価表に無い Model へ別 Model の単価を当てていた）                 |
| 4   | E2E が `.env.local` の Key を拾って課金 API を叩かないよう、両 Playwright Config で遮断      |

### SDK v4 系では一切通信できなかった

`client.responses.create` / `responses.parse` / `chat.completions.create` の**すべて**が
`ERR_STREAM_PREMATURE_CLOSE`（`Invalid response body ... Premature close`）で失敗しました。

切り分け:

| 確認                                              | 結果                                      |
| ------------------------------------------------- | ----------------------------------------- |
| 素の `fetch` で `POST /v1/responses`              | ✅ 200（構造化出力も成功）                |
| `GET /v1/models` で `gpt-5.6-terra` の存在        | ✅ 実在（132 Model 中に含まれる）         |
| SDK v4 で `gpt-4.1-mini` / `gpt-5.6-terra` 両方   | ❌ 全滅（Model 依存ではない）             |
| SDK v4 で `/responses` / `/chat/completions` 両方 | ❌ 全滅（Endpoint 依存でもない）          |
| サンドボックス外での実行                          | ❌ 同じ（実行環境のプロキシ由来ではない） |
| SDK v7 で同じ呼び出し                             | ✅ 全て成功                               |

原因は v4 系が同梱する `node-fetch` v2。v7 系はネイティブ `fetch` を使います。
`responses.parse` と `zodTextFormat` の書き方は v4 と同じで、**Provider のコード変更は不要**でした。

### 推定コストの誤算定（修正済み）

`estimateCost()` は単価表に無い Model へ **gpt-4.1-mini の単価**を当てていました。
`gpt-5.6-terra` では `ai_runs.estimated_cost_usd` に**誤った金額**が残ります。
未登録 Model は 0（＝未算定）を記録し、画面は `formatEstimatedCostUsd()` で「—」と表示するよう変更。
`$0` と出すと「無料」と読めてしまうためです。公式価格を確認したら単価表へ追記してください（S-12）。

### E2E が課金 API を叩く問題（修正済み）

`next start` は `.env.local` を自動で読むため、Key を置いた時点で E2E が実 OpenAI を叩き、
「Mock / AI未接続」バッジの検証も壊れます。両 Playwright Config の `webServer.env` に
`OPENAI_API_KEY: ''` を追加し、`tests/setup/unit-setup.ts` にも同じ遮断を入れました。

### 動作確認

`pnpm verify:openai`:

```
応答 Model : gpt-5.6-terra   Latency 5472 ms   Token in 412 / out 449
confidence 0.72 / warnings 2 件 / findings 1 件
✓ Responses API 接続・構造化出力・Zod スキーマ適合
```

アプリからの通し（CDP C6.1 →「ドラフトを生成」）:

- バッジが「AI生成」（Mock ではない）／ Model `gpt-5.6-terra` ／ 確信度 82%
- 参照元 4 件・warnings 2 件を表示。Version 履歴に「AI 由来」で v1 が記録
- `/enterprise/ai` に Provenance が 1 件（Latency 4532 ms / Token 1068 / コスト「—」）
- AI は「連結範囲の合計値であることは入力データ上で明示されていない」と自ら warning を出した

**実通信を確認したのは `cdpDraftGeneration` と `anomalyExplanation` の 2 Use Case**です。
残り 6 種はスキーマ適合のみ確認済み（E-3）。

### テスト結果（この追記時点）

| コマンド                                   | 結果                      |
| ------------------------------------------ | ------------------------- |
| `pnpm lint` / `format:check` / `typecheck` | ✅                        |
| `pnpm test`                                | ✅ 130 passed             |
| `pnpm test:rls`                            | ✅ 56 passed              |
| `pnpm test:e2e`                            | ✅ 29 passed（Mock 固定） |
| `pnpm test:e2e:supabase`                   | ✅ 7 passed               |
| `pnpm verify:supabase`                     | ✅ 33 / 33                |
| `pnpm verify:openai`                       | ✅ 実接続成功             |
| `pnpm build`                               | ✅                        |

変更後は必ず 7 コマンドを通してから、このファイルに追記してください。

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:rls && pnpm test:e2e && pnpm build
```

---

## 2026-08-15 — 残作業の消化 ＋ Vercel 本番 Deploy

### 1. E-3 完了: AI 8 Use Case すべてを実接続で確認

`pnpm verify:openai:all` を追加し、`gpt-5.6-terra` に対して 8 Use Case すべてを実行。
**8 / 8 で構造化出力と Zod スキーマ適合を確認**（合計 input 5,424 / output 4,049 tokens）。

| Use Case                 | Latency | confidence |
| ------------------------ | ------- | ---------- |
| importMapping            | 5908 ms | 0.99       |
| anomalyExplanation       | 7403 ms | 0.55       |
| cdpQuestionMapping       | 4968 ms | 0.98       |
| cdpDraftGeneration       | 2911 ms | 0.99       |
| evidenceMapping          | 2237 ms | 0.99       |
| inconsistencyCheck       | 5673 ms | 0.98       |
| assuranceEvidenceSummary | 9824 ms | 0.72       |
| assuranceChangeSummary   | 3978 ms | 0.92       |

あわせて System Prompt と Use Case 指示を `src/lib/ai/prompt.ts` へ切り出しました。
Provider と検証 Script が**同じ Prompt** を使うようにするためです
（二重管理していると「Script は通るが本番は通らない」を見逃します）。

### 2. S-3 完了: キーボードショートカット

ヘルプダイアログが `j`/`k`/`e`/`c`/`s` を案内しているのに未実装で、
「動作しないものは置かない」という本プロジェクトの方針に反していました。

`src/components/shared/record-shortcuts.tsx` を追加（AppShell に常駐）。

| キー    | 動作                      | 対象                                                  |
| ------- | ------------------------- | ----------------------------------------------------- |
| `j`/`k` | 一覧の次 / 前のレコードへ | `[data-t4d-record]`（非財務データ一覧・保証契約一覧） |
| `e`     | Evidence セクションへ移動 | `[data-t4d-shortcut="evidence"]`                      |
| `c`     | コメント入力へフォーカス  | `[data-t4d-shortcut="comment"]` / `[name="comment"]`  |
| `s`     | **下書き保存のみ**        | `[data-t4d-shortcut="save"]`                          |

安全側の設計:

- **`s` を提出・承認・確定・Sign-off に割り当てない。** 誤打鍵で業務が確定しないようにするため。
- 対象が無い画面では**何も起きない**（副作用ゼロ）。
- 入力中（input / textarea / contenteditable）・修飾キー併用・ダイアログ表示中は無効。

E2E を 3 件追加（`j`/`k` の移動、入力中に発火しないこと、`e` の移動）。
ヘルプダイアログの文言も実装に合わせて修正しました（`s` は「下書きを保存」と明記）。

### 3. Vercel 本番 Deploy

**https://terrast-t4d.vercel.app**（Vercel プロジェクト `t4d` / 新規作成）

- 環境変数は**一切設定していません**。本番は Demo / Fixture Mode、データはすべて架空。
- Supabase にも OpenAI にも接続していません（AI は決定論的 Mock）。
- `.vercelignore` で `.env*` を除外。**Secret を Vercel へ上げていません。**

指示書 2-8 / CLAUDE.md §0.7 は本番 Deploy を禁じていましたが、
2026-08-15 に発注者から明示指示があったため **Demo Mode 限定で解禁**し、
CLAUDE.md・AGENTS.md にその旨を追記しました。解禁したのは Deploy だけです。

#### 詰まった点: 全ルートが 404 になった

CLI（`vercel project add`）で作ったプロジェクトは **Framework Preset が `Other`** になり、
Output Directory が `public` 扱いになります。その結果、
`/brand/*` など `public/` の静的ファイルだけが 200 を返し、
**アプリのルートは全部 404**（Vercel の edge が返す NOT_FOUND）という状態になりました。
Build ログ上は全ルートが生成されていて成功に見えるため、紛らわしい失敗です。

`vercel.json` に `{"framework": "nextjs"}` を置いて再 Deploy して解消。
Dashboard で直すのではなくリポジトリに置いたのは、再現可能にするためです。

#### Deployment Protection（要判断）

Vercel の Deployment Protection が既定で有効なため、
**現状この URL を開くには Vercel へのログインが必要**です（第三者は閲覧できません）。
Demo ログインはパスワード不要なので、無効化すると URL を知る全員が閲覧できる状態になります。
データはすべて架空です。**発注者は 2026-08-15 に「公開する」と判断**しましたが、
この切替は Vercel CLI から行えず（`vercel project update` に該当オプションが無い）、
保存済みの CLI 認証情報をファイルから取り出して REST API を叩くことは避けました。
Dashboard → Project `t4d` → Settings → Deployment Protection →
Vercel Authentication を **Disabled** にすれば公開されます（`VERCEL_TOKEN` を渡してもらえれば代行可）。

### テスト結果（この追記時点）

| コマンド                                   | 結果                                        |
| ------------------------------------------ | ------------------------------------------- |
| `pnpm lint` / `format:check` / `typecheck` | ✅                                          |
| `pnpm check:rls`                           | ✅ 75/75 テーブル・169 ポリシー             |
| `pnpm test`                                | ✅ 130 passed                               |
| `pnpm test:rls`                            | ✅ 56 passed                                |
| `pnpm test:e2e`                            | ✅ **32 passed**（ショートカット 3 件追加） |
| `pnpm test:e2e:supabase`                   | ✅ 7 passed                                 |
| `pnpm verify:supabase`                     | ✅ 33 / 33                                  |
| `pnpm verify:openai:all`                   | ✅ 8 / 8 Use Case                           |
| `pnpm build`                               | ✅                                          |
| `pnpm audit --prod`                        | ✅ 脆弱性なし                               |

### 残っているもの

- S-2 個人設定（列表示・密度・保存ビュー）の永続化
- S-7 Evidence Viewer の PDF / 画像インライン表示
- S-10 Soft Delete の UI
- S-12 AI 推定コストの単価表（**公式価格の確認待ち。推測値は入れない**）
- Next.js 16 へ上げて Loading 境界を復活できるか確認（10 章）
- リモート Supabase への `db push`

---

## 2026-08-15（追記2） — 既存機能の自己検証

「押しても何も起きない」「開くと 404」の類が残っていないかを機械的に潰しました。
手で確認するとどうしても漏れるため、**クロールと Server Action の総当たり**をテストにしています。

### 追加した監査

| ファイル                         | 見るもの                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| `tests/e2e/screen-audit.spec.ts` | 到達可能な全画面の描画・Console エラー・リンククリックでの遷移確定 |
| `tests/e2e/action-audit.spec.ts` | これまでテストの無かった Server Action 12 種を UI から実行         |
| `tests/support/crawl.ts`         | クロール処理（Demo / Supabase 両モードで共用）                     |
| `tests/e2e-supabase/*`（追記）   | **実 RLS 下**での画面クロール                                      |

画面はルート表を手書きせず**リンクを辿ってクロール**しています。
一覧のフィルター違い（`?page=1,2,3…`）を無限に辿らないよう、
「パス ＋ クエリのキー名」で正規化し、フィルターの種類ごとに 1 回は必ず開きます。

検査規模: 企業 83 ページ / 監査法人 17 ページ（Demo・Supabase 各モード）、
権限の異なる 6 ロールでも同じクロール、サイドバー 15 + 14 本と本文 21 + 8 本のクリック検証。

### 見つけて直した不具合

| #   | 内容                                                                                                                       | 対応                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 12  | **Data Point 詳細の「開示マッピング」から SSBJ 項目を開くと 404**。リンクを全部 `/disclosures/cdp/{id}` に固定していたため | 項目の framework を解決して出し分け。質問単位の詳細を持つのは CDP だけなので、それ以外は一覧へ送る  |
| 13  | **AI 下書きの「Reject」を押しても画面が変わらない**。一覧しか revalidate しておらず、押した詳細画面が更新されない          | 詳細と `/enterprise/ai` も revalidate。あわせて Reject 済みを画面に明示（バッジ表示＋ボタンを消す） |

どちらも「サーバー側では成功しているのに UI に出ない／リンク先が無い」型で、
ビルドも型チェックも通ってしまうため、クロールしないと気付けないものでした。

### 監査で分かった仕様（バグではないもの）

- 承認済み Data Point の編集には `enterprise.data.write` **と** `review`/`approve` の両方が要る。
  両方を持つのは `sustainability_manager` だけ（`reviewer` / `approver` は write を持たない）。
  レビュー担当は「編集」ではなく「差戻し」で直す、という設計。
- Evidence の紐付けは `evidence_link` の ID が `dataPointId/fileVersionId/page` で決まるため、
  同じファイルを同じページで二重に紐付けても増えない（冪等）。

### テスト件数

| コマンド                 | 件数                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `pnpm test`              | 130                                                               |
| `pnpm test:rls`          | 56                                                                |
| `pnpm test:e2e`          | **52**（vertical-slices 32 ＋ screen-audit 12 ＋ action-audit 8） |
| `pnpm test:e2e:supabase` | **9**（＋実 RLS クロール 2）                                      |
| `pnpm verify:supabase`   | 33 / 33                                                           |
| `pnpm verify:openai:all` | 8 / 8                                                             |

---

## 2026-08-16 — 自己検証（2 回目）

1 回目はリンクと Server Action を潰しました。今回は**まだ触れていない領域**を狙いました。
`<a>` ではない操作系（Radix Select・`router.push`・Debounce 検索）、`/api/*` の Route Handler、
不正入力に対する壊れ方の 3 つです。

### 追加した監査

| ファイル                              | 見るもの                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/e2e/interaction-audit.spec.ts` | 期間セレクタ / 案件セレクタ / 検索 / フィルター / 保存ビュー / ページング / コマンドパレット / ログアウト |
| `tests/e2e/robustness-audit.spec.ts`  | 不正 ID の 404、`/api/*` の認証・越権、壊れたクエリ文字列                                                 |

クロールは `<a>` しか辿れません。実際の画面には Radix Select や `router.push` の遷移が多く、
**これらは 1 つもテストされていませんでした**。実際、そこに 2 件の不具合が埋まっていました。

### 見つけて直した不具合

| #   | 内容                                                                                                            | 対応                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | **期間セレクタが機能しない。** FY2025 を選んでも FY2026 のまま。Cookie には**選んでいない方の ID** が入っていた | hidden input に state を書いてから `requestSubmit()` する実装は、React の commit 前に submit が走る競合があった。FormData を明示的に組み立てて Server Action を直接呼ぶ形へ変更       |
| 15  | **ユーザーメニューの「ログアウト」を押しても何も起きない。** POST が 1 本も飛んでいなかった                     | Radix が Menu を閉じると中の `<form>` が unmount され、React の非同期 submit が成立しない。`onSelect` で Server Action を直接呼ぶ形へ変更。同じ形だったワークスペース切替も同時に修正 |

どちらも「押しても無反応」で、型チェックもビルドも通ります。
14 は**間違った値を保存していた**ぶん質が悪く、気付かないまま期間を切り替えたつもりで
別期間のデータを見続ける恐れがありました。

### 問題が無いと確認したもの

- 不正 ID（`/enterprise/data/<でたらめ>` ほか 7 経路）はすべて **404**。500 もスタックトレースも出ない
- 存在しない案件も 404（**存在を秘匿**）
- `/api/*` は未ログインで中身を返さない。他テナント・未アサインの案件 Export は拒否
- `?page=-1` `?page=abc` `?status=not_a_status` `<script>` 入り検索なども 500 にならない
- 検索の Debounce、フィルターのトグル／解除、保存ビュー、ページング前後、コマンドパレット遷移

### 監査側の不備（アプリのバグではない）

調べる過程で、テスト側の誤りも 4 件潰しました。記録しておきます。

- Playwright の `page.request` は BrowserContext の httpOnly Cookie を送らない。
  ログイン済みでも 401 になるため、**API はページ内 `fetch`** で叩く必要がある
- 404 画面の本文を `innerText` で即読みすると描画途中で空になる。リトライする `expect` を使う
- Radix の option に `data-value` は無い
- 別テナントのログイン導線はボタンに氏名が入っておらず、折りたたみの中にある

### テスト件数

| コマンド                 | 件数                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm test`              | 130                                                                                                |
| `pnpm test:rls`          | 56                                                                                                 |
| `pnpm test:e2e`          | **68**（vertical-slices 32 ＋ screen-audit 12 ＋ action-audit 8 ＋ interaction 8 ＋ robustness 8） |
| `pnpm test:e2e:supabase` | 9                                                                                                  |
| `pnpm verify:supabase`   | 33 / 33                                                                                            |

---

## 2026-08-16（追記） — 本番 URL を公開

発注者の指示により Vercel の Deployment Protection（Vercel Authentication）を無効化しました。

```
vercel api /v9/projects/t4d -X PATCH --input '{"ssoProtection":null}'
```

`vercel project update` にはこの設定のオプションがありません。前回は「CLI から変更できない」と
報告しましたが、**`vercel api`（beta）で CLI の認証のまま Vercel API を叩ける**ことが分かりました。
ローカルに保存された認証情報をファイルから取り出す必要はありません。

変更前: `ssoProtection = { deploymentType: "all_except_custom_domains" }`
変更後: `ssoProtection = null`

### 確認

Vercel セッションを持たない状態で:

| URL                                   | 結果                                    |
| ------------------------------------- | --------------------------------------- |
| `/login`                              | 200・デモログイン画面が描画（SSO 無し） |
| `/`                                   | 307 → `/workspace` → `/login`           |
| `/enterprise/dashboard`（未ログイン） | 307 → `/login`（Route Guard 動作）      |

別名 `t4d-terrast.vercel.app` と `t4d-kotakase2022-jpgs-projects.vercel.app` も同様に到達可能。

### 注意点

- **URL を知る全員が全画面を操作できます。** Demo ログインはパスワード不要です。
  データはすべて架空ですが、企業・監査法人の実務画面はそのまま見えます。
- 環境変数は引き続き未設定です（Supabase・OpenAI へは接続していません）。
- `protectionBypass` に自動生成の bypass トークンが 1 件残っています
  （2026-08-15 に `vercel curl` が検証用に作成したもの）。Protection を無効にした今は無効果ですが、
  将来 Protection を有効へ戻すと**このトークンで素通りできます**。不要なら削除してください。

---

## 2026-08-16（追記3） — 独立 QA（要求仕様トレーサビリティ）

実装担当ではなく**独立した QA 責任者**の立場で、要求仕様の全項目を検収しました。
成果物は `QA_REPORT.md` / `REQUIREMENTS_TRACEABILITY.csv` / `TEST_CASES.md` / `BUG_REPORT.md`、
証拠は `qa/evidence/`（ログ 13 本・スクリーンショット 22 枚）です。

### 正本の再取得

要求仕様 2 本は **Google Drive のログインが必要**で、匿名 HTTP（WebFetch）では取得できません。
ログイン済みブラウザから全文を読み取って照合しました（`qa/spec-snapshot/README.md` に所在を記録）。
**本文はリポジトリへ複製していません**（発注者の資料のため）。

### 結果

| 区分                |    件数 |   PASS |  FAIL | NOT_IMPL | BLOCKED | 対象外 |
| ------------------- | ------: | -----: | ----: | -------: | ------: | -----: |
| 機能要件 P0         |      61 |     49 |     7 |        5 |       0 |      0 |
| 機能要件 P1/P2/P3   |      57 |      0 |     0 |        0 |       0 |     57 |
| 指示書由来（INS-*） |      17 |     17 |     0 |        0 |       0 |      0 |
| Definition of Done  |      30 |     29 |     0 |        0 |       1 |      0 |
| **合計**            | **165** | **95** | **7** |    **5** |   **1** | **57** |

テストは 301 件すべて成功（unit 130／RLS 56／E2E Demo 73／E2E Supabase 9／verify:supabase 33）。

### 最重要の発見

**要求仕様 P0 の 12 件が未充足**で、**うち 10 件は `docs/known-limitations.md` に記載がありませんでした**。
つまり「未実装である」と申告されていなかったギャップです。
本 QA で同文書の 11 章へ全件を追記し、申告漏れを解消しました。

内訳は `BUG_REPORT.md` の BUG-017〜BUG-028。主なものは
指標マスター管理 UI・組織編集 UI・収集キャンペーン画面・Evidence の画面内表示・
CDP の適用判定と過去回答 Import・AI Copilot の対話支援。

### 本 QA で修正した不具合

**BUG-016（UX-P0-004）**：一覧の**並べ替えと列表示切替が未実装**でした（仕様の 10 機能中 8 機能）。

- 並べ替えは **DB 側**で実施（`ORDER BY` ＋ 一意列で安定ページング）。
  ページ内だけを並べ替えると全体の並び順と食い違うため、メモリ内ソートは避けています。
- 列表示は URL State（リロードでも維持）。
- 新規: `src/components/shared/table-controls.tsx` / `src/lib/table/columns.ts`
- 変更: `src/lib/services/enterprise-data.ts` / `src/app/enterprise/data/page.tsx`
- テスト: `tests/e2e/table-controls.spec.ts` 5 件

> 実装中、`isColumnVisible` を `'use client'` モジュールへ置いたためサーバーから呼べず
> ビルドが落ちました。純粋関数を `src/lib/table/columns.ts` へ分離して解消しています。

### 仕様間の競合（判断を記録）

**AUTH-P0-001 の「メール招待」は恒久制約「外部メール送信を行わない」と競合**します。
資料の優先順位（追加決定事項 ＞ 要求仕様書）に従い、メール送信部分は BLOCKED（実装不可）と判定しました。
パスワード再設定・MFA は競合しないため実装可能です。

### 注意（テスト実行時）

独立レビュー用のサブエージェントと**同時にビルドを走らせると `.next` が壊れます**
（`_not-found/page.js.nft.json` の ENOENT／`Cannot find module for page`）。
E2E は単独で実行してください。

---

## 2026-08-16（追記4） — フェーズ 8 独立検収で Critical 2 件を検出・修正

実装・修正を担当していない別サブエージェントに独立検収させたところ、
**私（QA 担当）が見落としていたテナント分離の穴が 3 件**見つかりました。すべて修正済みです。

| ID      | 重要度       | 内容                                                                                                 |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| BUG-029 | **Critical** | 他テナントの Evidence を `fileVersionId` 指定で取得できた                                            |
| BUG-030 | **Critical** | 他法人の Issue・レビュー Note を Server Action で書き換えられた（Sign-off 抑止を外部から解除できた） |
| BUG-031 | High         | 他社の許諾（Grant）を取り消せた                                                                      |

### 根本原因

**Demo Mode の `DbClient` には行レベルの防御が無い**（`findById` は単なる配列検索）。
Supabase Mode は RLS が守るが、Demo Mode はアプリ層の明示チェックだけが頼り。
そのチェックが以下で欠落していた。

- `createEvidenceSignedUrl`：`organizationId` 照合も許諾検査も engagement 検査も無し
- `/api/files/download`：`bucket` 一致しか見ていない
- `resolveIssueAction` / `clearReviewNoteAction`：対象 ID が案件に属するか未検証
- `toggleGrantAction`：`grantId` の所有者未検証

**本番は Demo Mode で動いている**ため、これは実害のある穴でした。

### 修正

- `canReadEvidence()` を新設（自組織 → 可／監査法人 → 案件メンバー ＋ Evidence を含む有効な許諾
  ＋ Data Room 対象への紐付けがある場合のみ可）
- `/api/files/download` に所有者照合を追加
- 3 つの Server Action に「対象がその案件・自社のものか」の検証を追加
  （`decidePbcAction` は元から正しく検証しており、実装が不揃いだった）

### なぜ最初の監査で見つからなかったか

`robustness-audit.spec.ts` は `/api/files/signed-url` を**存在しない UUID** でしか試しておらず、
「**実在するが他人のもの**」という最も重要なケースを突いていませんでした。
Server Action も正しい ID での実行しか検証していません。
**「実在するが権限が無い」ケースを必ず入れること**が教訓です。

### 回帰

`tests/e2e/tenant-isolation-audit.spec.ts` 5 件を追加。
**負の対照**（認可を一時的に外すとテスト A が落ちる）まで確認しており、
「常に拒否」で通ってしまう空テストではありません。

全ゲート再実行: lint / format / typecheck / check:rls / test 130 / test:rls 56 /
**test:e2e 78** / test:e2e:supabase 9 / verify:supabase 33 / build — すべて成功。
本番へ反映済み。

---

## 2026-08-16（追記5） — P0 未実装の解消（バッチ A: マスター系 CRUD）

QA で洗い出した P0 未実装 12 件のうち、**3 件を実装**しました（推奨順＝要求仕様優先で着手）。

| 要件          | 内容                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| MASTER-P0-001 | 指標マスターの追加・編集 UI（全項目）                                            |
| ORG-P0-001    | 組織階層の追加・編集（連結方法／持分／除外理由。除外理由は連結対象外時のみ保持） |
| ORG-P0-002    | 収集キャンペーン作成（対象組織 × 対象指標をスコープへ展開）                      |

### 実装

- サービス: `src/lib/services/master-data.ts`（作成・更新。**更新時は対象行が自組織のものかを明示確認** — Critical 3 件と同じ防御）
- Server Action: `src/app/enterprise/actions.ts` に create/update 各種
- UI: `src/app/enterprise/organizations/master-forms.tsx`（ダイアログ 1 つを使い回し。行ごとにフォームを埋め込まない）
- 収集キャンペーンのため、リポジトリに `campaigns` / `campaignScopes` テーブルを配線
  （`table-names.ts` / `types.ts` TableMap / `store.ts` FixtureDb / `to-sql.ts` SEED_ORDER）

### テスト

- integration: `tests/integration/master-data.test.ts` 16 件（重複拒否・権限・**テナント分離の負ケース**・スコープ展開）
- E2E: `tests/e2e/master-data.spec.ts` 4 件（追加・編集・権限ゲート・キャンペーン作成）

### 全ゲート（バッチ A 後）

lint / format / typecheck / check:rls ✅ ｜ test **146** ｜ test:rls 56 ｜ **test:e2e 82** ｜
test:e2e:supabase 9 ｜ verify:supabase 33 ｜ build ✅。

### 進捗

- P0: 49→**52 PASS** / 61（85.2%）。全体 95→**98 PASS** / 108（90.7%）。
- 残る P0 未実装 **9 件**（BUG-017・021〜028）。うち BUG-017 のメール招待部分は恒久制約と競合＝ BLOCKED。

### つまずき（記録）

- **E2E がステールなサーバ（:3100）を再利用して古いビルドで落ちる**。`reuseExistingServer: true`（ローカル）のため。
  E2E 前に `Get-NetTCPConnection -LocalPort 3100,3200 | Stop-Process` で掃除すること。
- `node -e` のインライン JS にバックティック（テンプレートリテラル）を入れると Git Bash が先に展開して壊す。
  複数行・バックティックを含む文字列置換は Edit ツールか .js ファイル経由で行うこと。

---

## 2026-08-17（追記6） — P0 未実装の解消（バッチ B: CDP 系）

| 要件       | 内容                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| CDP-P0-006 | 整合チェックの画面実行導線（不足情報／古い記述／年度不一致／回答間矛盾／Evidence 不足） |
| CDP-P0-002 | 企業別の適用質問判定（適用／非適用／要確認 ＋ 判定根拠）                                |
| CDP-P0-003 | 過去回答の Import・構造化（Excel / CSV / PDF / **Word**）                               |

### 設計判断（後任者向け）

- **適用判定は規則ベースにした（AI ではない）**。AI 判定は同じ入力でも根拠が揺れるため、
  「なぜ非適用か」を監査法人へ説明できない。`disclosure_item_conditions` を
  equals / not_equals / in / exists で評価し、依存先が未回答なら `needs_check` を返す。
  再現性は integration テストで固定した。
- **Word 対応で依存を増やさなかった**。`.docx` は ZIP なので Node 標準 `zlib.inflateRawSync` で
  `word/document.xml` を取り出す（`parsers.ts` の `parseDocx` / `extractZipEntry`）。
  `docx` パッケージは生成専用で解析はできない。テストは実際に .docx を生成して往復させている。
- **過去回答 Import は原本を保存してから解析する**。プレビュー結果をセッションに持たず、
  `?file=<fileVersionId>` で毎回読み直す。再読込・共有で結果が変わらず、
  取込元の原本も残るので保証手続で「何を取り込んだか」を示せる。
- **整合チェックの結果は `ai_runs.output_json`** に残るため `?check=<aiRunId>` で読み直せる。
  他組織の runId・別 feature の runId を指定しても読めないことをテスト済み。

### 追加・変更したファイル

- 新規: `src/lib/services/disclosure-check.ts` / `disclosure-applicability.ts` / `disclosure-import.ts`
- 新規: `src/app/enterprise/disclosures/cdp/import/page.tsx`
- 変更: `src/lib/imports/parsers.ts`（`parseDocx` 追加・`.docx` を許可）
- 変更: `src/lib/ai/mock-provider.ts`（`inconsistencyCheck` を実入力に合わせ 5 種の指摘へ拡張。
  Prompt Version を `inconsistency-check@2026-08-17.1` へ更新）
- 変更: `src/lib/storage/index.ts`（`readOwnedFileBytes` 追加。**所有組織を必ず照合**）
- 配線: `itemConditions` / `applicabilityResults` をリポジトリ層へ（table-names / TableMap / FixtureDb / SEED_ORDER）
- 追加: `AiSourceReference.kind` に `disclosure_response`（domain と Zod スキーマの両方）

### テスト

- unit `tests/unit/disclosure-import-parse.test.ts` 18 件（実 .docx 往復・列推定・区切り判定）
- integration `disclosure-check.test.ts` 6 件 ／ `disclosure-applicability.test.ts` 13 件 ／ `disclosure-import.test.ts` 11 件
- E2E `disclosure-check.spec.ts` 5 件 ／ `disclosure-import.spec.ts` 4 件（**実 CSV・実 Word をアップロード**）
- RLS `tenant-isolation.test.ts` に §11 を追加（7 件）。
  Fixture に行が無く空振りになるため、**RLS バイパスで企業 A の行を先に作ってから**
  企業 B から見えないことを検証している（「空振りテストでないことの確認」も併置）。

### 全ゲート（バッチ B 後）

lint / format / typecheck / check:rls ✅ ｜ test **191** ｜ test:rls **63** ｜ test:e2e **91** ｜
test:e2e:supabase 9 ｜ verify:supabase 33/33 ｜ build ✅

### 進捗

- P0: 52→**55 PASS** / 61（90.2%）。全体 98→**101 PASS** / 108（93.5%）。
- 残る P0 未実装 **6 件**（BUG-017・021・022・023・024・028）。
  うち BUG-017 のメール招待部分は恒久制約と競合＝ BLOCKED。

---

## 2026-08-17（追記7） — 機能追加要望 4 件（発注者指示）

| #   | 要望                                                 | 実装                                                           |
| --- | ---------------------------------------------------- | -------------------------------------------------------------- |
| ①   | 異種データの事前加工なし一括取込＋事前学習 AI 仕分け | 下記詳細                                                       |
| ②   | 開示対応へ CSRD 追加                                 | ESRS 架空縮小マスター 12 項目＋ギャップ分析ワークスペース      |
| ③   | サイドメニュー最下部にデモモード                     | 9 ステップの実画面ツアー（enterprise のみ）                    |
| ④   | AI Copilot「気づいていない洞察」                     | insightDiscovery Use Case ＋ /enterprise/ai のインサイトカード |

### ① AI 自動仕分け（事前学習）

- **学習に新テーブルは作らない**。確定済み取込行（`ingestion_rows.status='confirmed'`）そのものが
  学習データ（`src/lib/imports/learning.ts` の `buildLearnedExamples`）。組織単位でテナント分離。
- 学習例は AI 入力の `learnedExamples` として few-shot で渡す。Mock は正規化ラベル完全一致で
  確信度 0.95 を付ける（決定論的）。適用件数は取込ファイルの parseMessage に残る。
- パーサ強化: `detectDelimiter`（セミコロン CSV = 欧州）、`parseFlexibleNumber`
  （1.234,5 / 1 234,5 / 全角数字）、TSV MIME 許可、Mock の多言語辞書（日英独仏中）。
- **Rate Limit を feature 別化**（`src/lib/ai/index.ts`）: importMapping のみ 300 回/分。
  既定 30 回/分のままだと「50 ファイル一括取込」という機能そのものが失敗する実欠陥だった。
- 50 ファイルの生成元は `tests/support/hetero-dataset.ts`（唯一の生成元・決定論的）。
  `scripts/generate-heterogeneous-dataset.ts` で書き出し。zip は発注者指定の
  Google Drive フォルダ（T4D - BizDev）へ `t4d-hetero-dataset-50files.zip` として格納済み（2026-08-17）。
- 手組み PDF（xref オフセット計算済み・非圧縮）は unpdf で実際にテキスト抽出できることをテストで固定。

### ② CSRD

- `FRAMEWORK_KEYS` に 'csrd'。**Migration 0018** で `disclosure_frameworks_key_check` を付け替え
  （既存ファイルは書き換えない）。この制約を忘れると PGlite/実 Supabase の seed が落ちる。
- CDP の質問詳細を `disclosures/question-view.tsx` へ**共有化**（'cdp' 文字列 8 箇所を Props 化しただけ。
  挙動は E2E が担保）。CDP 系 Server Action の revalidate は `revalidateDisclosure()` で両画面へ。
- CSRD は初年度対応: 全項目 changeType='new'・前年回答なし。画面は前年差分ではなくギャップ分析
  （データあり／承認済みデータなし）を主とした。

### ③ デモモード

- `src/components/shared/demo-tour.tsx`。Sidebar は enterprise レイアウト内で**永続する**
  Client Component なので、ツアー状態は局所 state だけで画面遷移をまたげる（localStorage 不要）。
- Escape / × / ツアーを終了 で終了。role="dialog"、進捗はドット＋数値の併記（色だけに頼らない）。

### ④ インサイト

- `src/lib/services/insights.ts`: 承認済みデータの拠点別 YoY・収集滞留・開示ギャップ・
  Evidence 不足・PBC を横断收集して AI へ。**目玉は「全社トレンドと逆行する拠点」**
  （単一画面では気づけない相殺関係）。
- 出力は 洞察 = title / finding（根拠）/ implication（含意）/ recommendedAction / link の 3 点セット構造。
  AI はデータを一切書き換えない（integration テストで前後スナップショット比較）。
- 実 OpenAI（gpt-5.6-terra）で 1 回検証済み（confidence 0.87）。verify スクリプトに `--only=<feature>` を追加。

### つまずき（記録）

- **PGlite の seed 失敗は check 制約が最初に疑わしい**（disclosure_frameworks_key_check）。
  スキーマ変更手順に「check 制約の確認」を含めること。
- Fixture へ学習実績を足すと、既存テストの「未学習前提」が壊れる。テスト用の未知ラベルは
  Fixture に無いもの（圧縮空気（購入分））を使う。
- `pnpm exec supabase db reset` を E2E サーバ稼働中に叩くと Auth が
  "Database error querying schema" になる。**リセットは必ずサーバ停止後**。

### 全ゲート（4 機能実装後）

lint / format / typecheck / check:rls ✅ ｜ test **221** ｜ test:rls **63** ｜ test:e2e **103** ｜
test:e2e:supabase 9 ｜ verify:supabase 33/33 ｜ build ✅ ｜ 追加ライブラリ **0**

---

## 2026-08-17（追記8） — 4 機能の敵対的レビューと修正・デプロイ

実装後、20 エージェントの多角レビュー（セキュリティ／正確性／要求適合／規約の 4 観点 →
所見 30 件 → 重複除去 26 件 → 上位 8 件を各 2 名の懐疑者が反証審査）を実施。

### 確定・修正した欠陥（重要なもの）

1. **[high] 独式ドット桁区切りの誤解釈**: "2.845"（独式 2845）を 2.845 と解釈し、
   事前学習の確信度 0.95・警告なしで 1/1000 の値が书き込まれる経路があった。
   → `^\d{1,3}(\.\d{3})+$` 形は**判別不能として null**（要確認へ）。契約「解釈できなければ null」に統一。
2. **[high] 納品データセットの CSV 引用漏れ**: csv() が区切り文字を含むフィールドを引用せず、
   8 ファイルで列ズレ（1,070.4 → 値 1・単位 070.4 など）。→ RFC4180 引用＋値アサーションで固定。
   **Drive の zip は「版を管理 > 新版アップロード」で差し替え済み**（旧版は版 1 として保持・削除なし）。
3. **[反証されたが実在した] recordAiDecision の越権**: 懐疑者 2 名は反証したが、自分の目で
   追試して**本物**と確認（rejectAiDraftAction がユーザー入力 aiRunId を無検証で更新に渡す）。
   → recordAiDecision 内で所有組織を照合。**反証結果も鵜呑みにしないこと**。
4. **[medium] インサイトの link 無検証**: 実 LLM が外部 URL / javascript: を返すと描画される。
   → `/enterprise/` 始まりのみ許可（保存済み出力の読み直しにも適用・改変テストで固定）。
5. **[medium] コスト暴走**: Rate Limit 緩和 × 入力無制限 → `AI_MAPPING_MAX_ROWS_PER_FILE=500`。
   超過行は AI を通さず要確認（捨てない）。

その他 13 件の軽微所見（evidenceLinks の org フィルタ・期間所有権検証・NFKC 順序・
多数決キー・idempotency の Date.now() 除去・逆行判定の 0% ガード・バッジへのアイコン併記・
デモモードボタンを文字どおり最下部へ・ツアー終了時のフォーカス復帰など）も全件修正。
受容した指摘: 洞察 6 類型のうち 3 類型は既知 KPI に近い（残る 3 類型が横断洞察の本体）。

### 運用注意（新規）

- **Vercel は tests/ を上げない**（.vercelignore）。かつ gitignore 規則では
  ディレクトリ除外後の `!` 再包含は無効。**scripts から参照するモジュールは scripts/ に置く**
  （hetero-dataset.ts は tests/support → scripts/ へ移動済み）。
- Supabase E2E の監査法人クロールは、直前の 112 ページクロール後にセッション競合で
  稀に落ちる（単体では常に成功）。再現したら単体再実行で切り分けること。

### 最終ゲート（レビュー修正後）

lint / format / typecheck / check:rls ✅ ｜ test **225** ｜ test:rls **63** ｜ test:e2e **103** ｜
test:e2e:supabase **9** ｜ verify:supabase **33/33** ｜ build ✅ ｜ 本番: https://terrast-t4d.vercel.app

---

## 2026-08-18 QA フェーズ 6E〜7（AUTH/AI P0 解消・全件回帰）

### 実装

- **AUTH-P0-001**: メンバー招待（アプリ内リンク方式）・パスワード再設定（管理者リンク発行）・MFA（TOTP）。
  `identity.ts` / `(auth)/invite・reset・mfa` / settings セキュリティカード / `session.ts` AAL2 ゲート。
- **AI-P0-001**: Copilot 対話（`copilot.ts` / `/enterprise/ai` 対話カード・出典・会話継続・Provenance）。
- 検証: integration 7+8 件、Demo E2E 4 件（`auth-copilot.spec.ts`）、Supabase E2E 2 件（`auth-security.spec.ts`）、
  TOTP は RFC 6238 自前実装（`tests/support/totp.ts`・RFC ベクタで unit 7 件）。

### 発見・修正した不具合（詳細は BUG_REPORT.md BUG-032〜036）

- **BUG-032** `to-sql.ts buildInsert` の列ズレ（値を各行のキー順で出力）→ 先頭行キー順に統一。
- **BUG-033** `/auth/mfa` `/auth/reset` への redirect（ルートグループはパスに出ない）→ `/mfa` `/reset`。
- **BUG-034** CSP `connect-src` が `*.supabase.co` 固定 → `NEXT_PUBLIC_SUPABASE_URL` origin を動的追加。
- **BUG-035** `/reset` `/mfa` が静的化され CSP nonce 不一致で hydration 不能 → server wrapper + `force-dynamic`。
- **BUG-036（Critical）** middleware が全リクエストで GoTrue `/user` を実行 → 高負荷時に GoTrue→Postgres 接続枯渇
  （実クロールで `/user` 3,000 回超・`cannot assign requested address`）→ セッション喪失に見える 500。
  middleware は `getSession()`（期限内は無通信）へ、真正性検証は `session.ts` の `getUser()`＋React `cache()` に集約。
  **これが既知の「Supabase E2E クロール flake」の真因**（flake ではなく決定的な障害だった）。

### 環境変更

- `supabase/config.toml`: `[auth.mfa.totp] enroll/verify = true`、`additional_redirect_urls` に各 `/reset` を追加。
  → **スタック再起動＋ `supabase db reset` 済み**。
- `seed.sql` 再生成（内部取引 dataPoints・aggregationRules を含む）。

### 回帰結果（2026-08-18）

lint / format:check / typecheck / check:rls ✓、unit+integration **269**、RLS **63**、
Demo E2E **118**、Supabase verify **33/33**、Supabase E2E **11/11**、build ✓（/mfa /reset は ƒ Dynamic）。

### トレーサビリティ

PASS **120** / OUT_OF_SCOPE 57 / **FAIL・BLOCKED・NOT_IMPLEMENTED 0**（177 行）。
DOD-30 は資料優先順位（追加決定事項＞指示書）により PASS へ再判定（根拠を CSV 備考へ記載）。

### 次作業

- フェーズ 8: 独立最終レビュー → 指摘修正 → 本番 Deploy（Demo Mode 限定）→ QA_REPORT 最終判定。

---

## 2026-08-18 QA フェーズ 8（独立最終レビューと修正）

### 実施

変更範囲（6C〜6E）を 4 観点で独立レビュー（32 エージェント・所見 14 件）。
**反証審査の結果は鵜呑みにせず、全 14 件を自分で実コード確認**したうえで 12 件を修正した
（残る 2 件は重複の再掲）。詳細は BUG_REPORT.md の BUG-037〜048。

とくに重いもの:

- **BUG-037（Critical）** `issuePasswordResetLink` に所属照合が無く、企業管理者が
  **監査法人パートナーや別企業管理者の回復リンクを発行**できた（＝アカウント乗っ取り経路）。
  CLAUDE.md §0.2「企業テナントと監査法人テナントを混ぜない」への直接違反。
  自組織メンバー照合 ＋ 監査ログ記録を追加。
- **BUG-038（High）** Supabase Mode では招待受諾が RLS と FK で必ず失敗していた
  （＝ AUTH-P0-001 の PASS 根拠が Demo Mode だけだった）。受諾経路のみ service-role にし、
  `createUser`（メール送信なし）でアカウントを作る方式へ。実 Auth の E2E で通し検証済み。
- **BUG-039（High）** 内部取引の明細行が Data Room・母集団へ共有され、母集団合計が
  2,490.5 t-CO2e 過大・欠損件数が 0 に潰れていた（完全性手続のデモが壊れる）。

### 構造の変更

- `src/lib/domain/boundaries.ts` を新設（`isCountedInTotals`）。
  `aggregation.ts` は server-only のため Fixture 生成（Node CLI）から使えず、
  判定を純粋モジュールへ切り出して両方から参照する。
- `src/lib/security/safe-link.ts` を新設。AI 出力・通知の href 検証を 3 箇所から集約。
- migration **0019_metric_hq_only.sql**（非破壊の列追加）。`hqOnly` をドメイン型・
  指標マスター UI・テンプレート出力へ反映。

### 回帰結果（フェーズ 8 修正後・2026-08-18）

lint / format:check / typecheck / check:rls ✓、unit+integration **296**（+27）、RLS **63**、
Demo E2E **118**、Supabase verify **33/33**、Supabase E2E **13**（auth-security 4 ＋ supabase-mode 9）、build ✓。

### 次作業

- 本番 Deploy（Demo Mode 限定）と QA_REPORT の最終判定。

---

## 2026-08-18 フェーズ 8 完了（自己検証と本番反映）

### 修正後の自己検証で追加発見（BUG-049 / BUG-050）

サブエージェントによる独立監査はセッション上限で **未実施**（所見 0 件は「問題なし」ではない）。
同じ検証項目を自分で実行し、2 件の退行を発見して修正した:

- **BUG-049** `isSafeAppLink` がデコード後に文字種チェックを再適用しており、クエリに日本語を含む
  正当なリンク（`/enterprise/data?unit=%E6%9C%AC%E7%A4%BE`）を弾いていた。
  → デコード後は scheme・バックスラッシュ・制御文字のみ拒否し、`..` はパス正規化で判定。
- **BUG-050** 遷移コメントの 2,000 文字検証で、空白だけの差戻し理由が例外になっていた。
  → 空白のみは「コメント無し」として扱う。

併せて CSP の Supabase origin を http/https に限定。

### 自分で確認した検証項目（サブエージェントの代替）

- service-role 経路（`getInvitationAcceptDb`）の呼び出しは招待受諾の 2 箇所のみ。
- boundary は「連結」「内部取引」の 2 値のみ。YoY 照合キーに boundary を足しても正当な 32 件は維持され、
  消えたのは内部取引由来の誤警告だけ。
- リンク検証を 13 種の攻撃形＋5 種の正当形で実測（BUG-049 発見）。
- コメント権限は `docs/rls-matrix.md` の定義と整合。UI 導線との差を S-14 に明文化。

### 最終ゲート（2026-08-18）

lint / format:check / typecheck / check:rls ✓、unit+integration **301**、RLS **63**、
Demo E2E **118**、verify:supabase **33/33**、Supabase E2E **13**（db reset 直後のクリーン DB から）、build ✓。
合計 **528 件**成功・失敗 0。

### 本番

https://terrast-t4d.vercel.app へ反映（Demo Mode 限定・環境変数なし）。
`/invite/[id]` `/reset` `/mfa` の新ルートが 200 応答。実ブラウザで Copilot 対話が
実データ（Scope1 7,859.8 t-CO2e・前年比 -12.0%）を出典つきで返すこと、GHG 画面の連結集計
（内部取引控除 -2,490.5・加重平均 18.25% vs 単純平均 18.3%）を確認。

### 未コミット

リポジトリは remote あり・**コミット 0 件**のまま。依頼が無い限り commit / push は行わない。

---

## 2026-08-19 異種データ 50 ファイルの作り直し（文字化け解消・内容の充実）

発注者から「一部が文字化けする」「内容が簡素すぎる」との指摘を受けての改訂。

### 文字化けの原因と対処

| 原因                                                                    | 対処                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTF-8 の CSV/TSV に BOM が無く、Excel（日本語 Windows）が CP932 と誤認  | すべて **BOM 付き**で出力                                                                                                                                           |
| Shift_JIS が 31 文字の固定パレット実装で、表外の文字が `?` に落ちていた | `TextDecoder(shift_jis)` から**逆引き表を生成**し CP932 全域（9,397 文字）へ対応。表に無い文字は生成時に例外にする                                                  |
| zip のファイル名エンコーディングが不定                                  | `scripts/zip.ts` を自前実装し、**UTF-8 フラグ（general purpose bit 11）を必ず立てる**                                                                               |
| PDF に日本語を載せていた                                                | pdf.js は CID フォント埋め込み無しでは復元できない（Identity-H + ToUnicode でも不可を実測）。PDF は **Latin 文字のみ**へ変更し、日本語 Evidence は CSV/Excel で表現 |

### 内容の充実

- 大半が 2 行（ヘッダー＋1 行）だったものを、月次 12 ヶ月・明細・合計・備考／出典／担当者などのメタ列を持つ形へ。
- PDF は請求番号・請求期間・単価つき明細・小計・税・合計・排出係数まで含む実務的な体裁に（テキスト片 4〜5 → 16〜18）。
- 取込結果: **行数 45 → 265 行**、自動仕分け率 **88.3%**。

### 副産物（アプリ側の実バグ 1 件）

前文が 5 行を超えるファイルでヘッダーを取り逃していた（`detectHeaderRow` の走査幅が 5 行固定）。
実務では「報告書名・部署・作成日・注記・空行」で 5 行を超えるのが普通のため、走査幅を 15 行へ拡張した。

### 納品

Google Drive の T4D フォルダへ **版 3** として差し替え（削除はせず版管理で置換。共有設定は維持）。

---

## 2026-08-19 本番での 50 ファイル取込検証（実機）と 2 件の実バグ修正

「作った 50 ファイルは実際に本アプリで取り込めるのか」を本番
（https://terrast-t4d.vercel.app ）で実測した。**当初は取り込めなかった。**
原因は 2 つあり、いずれも本番でしか再現しないものだった。

### BUG-051（Critical）exceljs が本番で壊れていた

`pnpm-workspace.yaml` の overrides が `uuid: '>=11.1.1'` を**全依存へ適用**しており、
exceljs（CommonJS）が要求する `^8.3.0` を ESM only の uuid@14 に置き換えていた。
Vercel の Node ランタイムでは ESM を require() できず、
**Excel を含む取込が PROCESSING_FAILED で全滅**していた（CSV 24 件目までは成功し、
25 件目の .xlsx で例外 → 以降は待機中のまま・0 行）。

対処: `exceljs>uuid: '8.3.2'` を追加して exceljs 配下だけ 8 系へ戻した。
exceljs が使うのは v4 のみで、報告されている脆弱性（v3/v5/v6 の buf 境界チェック）には該当しない。
根拠と判断は `docs/known-limitations.md` 8 章へ記載。

**なぜテストで捕まらなかったか**: vitest も next dev もローカルの Node 24 も ESM を解決できるため、
CommonJS 解決になる本番ランタイムでしか再現しない。
回帰テスト `tests/unit/exceljs-runtime.test.ts` は「解決された uuid が ESM only でないこと」を
パッケージ定義から検証する形にした（uuid@14 のときは false になり落ちることを確認済み）。

### BUG-052（High）Demo Mode の取込が本番で進まない

Demo Mode は状態がプロセスのメモリにしか無い（known-limitations D-3）。
Vercel はリクエストごとにインスタンスが変わりうるため、
ジョブ作成（Server Action）と進捗ポーリング（`GET /api/jobs/[jobId]`）が別インスタンスに当たり、
**404 のまま解析が始まらない**状態だった（実測で 5 回とも 404）。

対処: Demo Mode に限り `uploadFilesAction` の中で `processIngestionJob` を同期実行し、
同じリクエストで解析まで終わらせる。Supabase Mode は DB を共有するので従来どおり非同期のまま。

### 併せて修正

- 取込 UI の `accept` に `.tsv` / `.docx` が無く、サーバーは受け付けるのにファイル選択で選べなかった。
  画面の「対応形式」表記も含めてサーバー側の許可リストと一致させた。

### 本番での実測結果（修正後）

| 項目           | 結果                                                    |
| -------------- | ------------------------------------------------------- |
| ファイル       | **50 / 50 解析済み**（失敗 0・待機中 0）                |
| 取込行数       | **265 行**                                              |
| 文字コード判定 | UTF-8 (BOM) 47 件 / Shift_JIS 3 件を正しく判定          |
| 説明行スキップ | 3 ファイルで発火（最大 5 行の前文を読み飛ばし）         |
| 事前学習       | 45 ファイルで「確定済み実績 8 件を参照」                |
| 自動仕分け     | 指標・拠点が自動で割り当てられ、確信度 72〜84% を表示   |
| 要確認         | 31 行（蒸気使用量など未定義指標。**勝手に確定しない**） |
| 重複検知       | 234 行が既存の承認済みデータとの重複として警告          |

重複が多いのは、デモデータに FY2026 の実績が既に入っているため（正常な動作）。

---

## 2026-08-19 追加要望 6 点の実装

### ① 人的資本データ 20 ファイル＋定義ズレの自動仕分け

生成器: `scripts/human-capital-dataset.ts` / `scripts/generate-human-capital-dataset.ts`。
日本・米国・英国・ドイツ・フランス・中国・インド・ブラジルの 8 か国、CSV（カンマ／セミコロン）と PDF。
文字コードは UTF-8（BOM）と Shift_JIS。

**主眼は「定義のズレ」**。女性管理職比率の分母が国ごとに違う（課長以上／EEO-1 Officials and Managers／
全 Führungsebene／Band 4 以上／cadre／主管以上）ほか、離職率の自己都合限定、賃金格差の平均値と中央値、
FTE 換算、期中平均などを含む。

対応として `mock-provider.ts` に:

- 人的資本の多言語ラベル（11 指標）を追加
- `detectDefinitionNotes` を新設。定義の但し書きを検出したら**確信度を 0.42 前後まで落として警告**し、
  「要確認」に倒す（勝手に確定させない）

指標も 7 件追加（`female_employees` / `new_hires` / `turnover_rate` / `avg_tenure` /
`training_hours` / `ltifr` / `gender_pay_gap`）。

検証: `tests/integration/human-capital-import.test.ts`（4 件）。
20 ファイル全解析、多言語の女性管理職比率が同一指標へ集約、定義差 6 パターンで警告と要確認、
定義差の無い行は高確信度、を確認。

**副産物（実バグ 1 件）**: 用水の判定パターン `eau` に単語境界が無く、フランス語の **Bureau** に誤爆して
「Bureau Paris の女性管理職比率」が用水として仕分けられていた。単語境界を付けて修正。

### ② 非財務データの組織タグ「連結対象のみ」

`src/lib/domain/boundaries.ts` に `isConsolidatedUnit`（full / proportionate のみ）を追加し、
組織フィルタの先頭と保存ビューに「連結対象のみ」を用意した。
効果が見えるよう、fixture に**持分法適用の関連会社（青海マテリアル合弁会社・持分 35%）**を追加している。

実装中に穴を 1 つ塞いだ: 「連結対象のみ」と特定組織を併用して交差が空になったとき、
空配列を渡すと「未指定」と区別できず**絞り込みが外れて全件表示**になっていた。
番兵 ID（`NO_MATCH_UNIT_ID`）で 0 件を返すようにした。

### ③ Evidence プレビューのリッチ化

`src/lib/fixtures/evidence-documents.ts` で、書類種別ごとに**紙面**を組み立てるようにした。
電力請求書なら発行者・請求番号・需要場所・契約種別・明細（基本料金／電力量料金／再エネ賦課金）・
合計使用電力量・請求金額・CO2 係数まで。マニフェスト、燃料使用記録、購買台帳、人員構成表も同様。

画面側は `src/components/shared/document-preview.tsx` を新設し、A4 相当の用紙・罫線・等幅の明細行・
ページャで原本を読んでいる状態に近づけた。従来は「1 ページ目。合計値および明細が記載されています」の
一文を箇条書きにしていただけだった。

### ④ デモモードのポップアップをドラッグ移動

ヘッダーをドラッグハンドルにして Pointer Events で移動できるようにした（右下固定をやめた）。
ドラッグできない環境のために**矢印キーでも移動**でき（Shift で 64px 単位）、画面外へは出ない。

### ⑤ CDP の UX

「バージョン（FY）を選ぶ → 過去データを取り込む（複数年）→ 新規分・不足分に対応する」の 3 ステップを
`src/components/shared/disclosure-steps.tsx` と `src/lib/services/disclosure-onboarding.ts` で可視化。
年度ごとの取込済み件数を出し、過年度の質問書（CDP 2025）へも切り替えられる。

### ⑥ SSBJ の UX

「マテリアリティの登録 → データ収集 → 充足度の可視化 → 不足項目の一覧・提出依頼」に再構成。
新テーブル `materiality_topics`（migration 0020・RLS 付き）と `src/lib/services/materiality.ts` を追加。
重要と評価する場合は理由を必須にしている（後から根拠を問われるため）。
充足度は「重要トピックに紐づく指標のうち、承認済みの値がある割合」で算出する。

### 検証

| ゲート                                | 結果              |
| ------------------------------------- | ----------------- |
| lint / format / typecheck / check:rls | ✅                |
| unit + integration                    | ✅ **310 passed** |
| RLS（materiality の越権 4 件を追加）  | ✅ **67 passed**  |
| E2E（Demo・実ブラウザ）               | ✅ **124 passed** |
| build                                 | ✅                |

E2E は `tests/e2e/six-features.spec.ts`（6 件）で ②〜⑥ を実機確認している。

### 併せて直した既存テストの脆さ

- `action-audit` の一括提出が「残り件数」で判定しており、ページサイズを超えると次ページの行が繰り上がって
  成立しなかった。提出した行の ID が draft から消えたかで判定する形に変更。
- Evidence の文言変更に追従（`mentions-evidence`）。

### 環境メモ

別プロジェクト（`Documents/test/airis`）の dev サーバーがポート 3100 を占有していると、
T4D の E2E が**別アプリのログイン画面**を掴んで全滅する。
`E2E_PORT=3105` のように空きポートを指定して回避できる。

### 納品

Google Drive の T4D フォルダへ `t4d-human-capital-dataset-20files.zip`（12 KB）を追加。
既存の `t4d-hetero-dataset-50files.zip` はそのまま。

---

## 2026-08-20 全面自己検証（実操作ベース）

「実装されているように見える」ではなく実際に動くかを、実ブラウザ・実 DB・実 API で検証した。

### 追加した検証スイート

- `tests/e2e/full-audit.spec.ts` … 全画面をロール別にクロールし、HTTP・コンソール・ネットワーク異常を検出
- `tests/e2e/crud-persistence.spec.ts` … 作成→一覧反映→**リロード後も保持**→編集→反映を確認
- `tests/e2e/authz-api-audit.spec.ts` … Server Action / API を直接叩いて権限とテナント分離を確認
- `tests/e2e/edge-cases-audit.spec.ts` … 境界値・二重送信・空データ・不正クエリ・ブラウザバック
- `tests/e2e/business-flow-audit.spec.ts` … 取込→確定→提出→承認→開示→保証の通し
- `tests/e2e/ui-integrity-audit.spec.ts` … 1280/1440/1920px で横スクロール・はみ出しを検出
- `tests/e2e/security-audit.spec.ts` … XSS・open redirect・CSP・アップロード検証
- `tests/e2e-production/production-smoke.spec.ts` … 本番を実操作で確認（`pnpm test:e2e:prod`）

### 見つけた問題（本番でのみ再現）

BUG-053〜055・057（BUG_REPORT.md 参照）。いずれも Demo Mode の状態がインスタンス間で
共有されないことに起因する。Cookie 永続化・リージョン固定・リダイレクト廃止で緩和した。

BUG-057 は「緩和したつもりが効いていなかった」例で、Cookie に控えた差分が 4KB を超えて
捨てられ、2 ファイルの一括取込でもプレビューに届かなかった。行間で共通する UUID を
辞書化してから deflate する符号化（`demo-edit-codec.ts`）で約 10 倍に縮め、
保持できる行数を 5 行程度から 45 行程度へ広げた。
**修正したこと自体を本番で確かめないと、直っていないことに気づけない**という教訓。

BUG-056 は検証スクリプト側の問題。`verify:supabase` を同じ DB で 2 回走らせると
追記専用の Sign-off / 許諾が重複キーで落ち、**RLS が壊れたように見えていた**。
実行前に検知して `db reset` を促すようにした。

### DB を直接確認した内容

`docker exec supabase_db_t4d psql` で実スキーマを確認:

- `materiality_topics` の列・CHECK・UNIQUE・外部キー・RLS ポリシー（select / write）
- RLS が無効な public テーブルが **0 件**
- 内部取引の明細が Data Room へ漏れていないこと（**0 件**）
- `metric_definitions.hq_only`（true 16 / false 26）と人的資本 7 指標の投入
- 持分法適用の組織（JV・35%）の存在

### 検証環境で踏んだ落とし穴（次回のため）

- 別プロジェクト（`Documents/test/airis`）が **ポート 3100** を占有していると、T4D の E2E が
  別アプリのログイン画面を掴んで全滅する。`E2E_PORT=3105` で回避する。
- Supabase E2E は `next build` を走らせるため、手動起動したサーバーの `.next` を上書きする。
  同時に使うとチャンクが 400 になる。片方ずつ実行する。

---

## 2026-08-23 独立再監査（2 巡目）

前回の結論を前提にせず、8 観点で独立に監査し、各観点の所見を別の担当が反証審査した。
確定 61 件のうち 24 件を修正、31 件を未対応として `BUG_REPORT.md` に記録した。

### 一番の学び

**「PASS」は「使える」を意味していなかった。**
トレーサビリティで PASS だった要件のうち 4 件は、画面から実行する手段が無いか、
実行すると必ず失敗する状態だった（案件の起票・許諾の付与・判断による抽出・母集団の構成）。
サービス層に関数があり、権限も定義されていて、テストも通っていたが、
**画面に導線が無い**ことは、どのテストも検出していなかった。

対策として次を追加した。

- `pnpm check:colors` … 実在しない色トークンの参照を検出（Tailwind v4 は未定義でも無視する）
- `tests/e2e/grant-lifecycle.spec.ts` / `engagement-management.spec.ts` / `notifications.spec.ts`
  … 「画面から実際に作れるか」を確かめる
- `tests/e2e-supabase/write-paths.spec.ts` … Supabase Mode の書き込み経路（RLS 下）

### 見落としやすかった構造的な穴

RLS が **行が自分で名乗る列** を信頼していた（`assurance_firm_id`）。
親の案件と一致する保証が無かったため、他法人の案件へ自己アサインできた。
同じ構造の列を持つテーブルが 19 あり、複合外部キーでまとめて塞いだ（0021）。

**同種の穴を探すときの手順**: ポリシーの `with_check` が参照している列が、
書き込む側から自由に指定できるかを見る。指定できるなら、その列と親の行との
一致を外部キーか関数で担保する。

### 検証環境のこと

- Windows が 54420-54519 を予約する構成があり、その環境では Supabase の stack が
  まったく起動できない（`netsh interface ipv4 show excludedportrange`）。
  ポートを 55xxx へ移した。
- Supabase Storage は「権限が無い」ときも「実体が無い」ときも `Object not found` を返す。
  区別しないとテストが常に通ってしまうので、**実体を置いてから**権限を試すこと。

### 2026-08-23（続き）要求仕様との差分 10 件を実装

再監査で「未対応」とした 31 件のうち、要求仕様との差分 10 件を実装した（BUG-082〜091）。
残りは 21 件（データ整合の細部 9・認可の検証不足 2・UI / a11y 10）。

**本番でだけ起きた連鎖**（記録として残す）

1. AI の実行結果を `?run=<id>` で読み直す画面を増やしたら、本番で「実行したのに何も出ない」。
   → `aiRuns` が Cookie の保持対象に無く、インスタンスを跨ぐと消えていた。追加した。
2. 追加した結果 Cookie が圧迫され、今度は一括取込が落ちるようになった。
   → 取込マッピングの出力（行数ぶんの対応表。プレビューは読まない）だけを空にした。
3. その最初の実装で「不要な列を落とす」形にしたら、復元した行が不完全になり、
   取込のジョブ画面が内部エラーになった。**列構造は保ち、値だけ空にする**形へ直した。

Cookie に載せるものを増やすときは、(a) 容量の取り合いになる相手がいること、
(b) 復元後の行が型として完全であること、の 2 点を必ず確かめること。

### 2026-08-24 残り 21 件を完了

独立再監査で確定した 61 件の対応が、これで全部終わった（実対応 54 件）。
最後の 21 件は認可 2・データ整合 9・UI / a11y 10。

**この回で足した「壊れたら気づける」仕組み**

- `tests/unit/schema-parity.test.ts` … 対応表と実スキーマのズレ、未使用テーブルの説明漏れ
- `tests/unit/engagement-export-sheets.test.ts` … Export の案内と実物のズレ
- `src/components/ui/submit-button.tsx` … 送信中の表示と二重送信防止（8 か所へ適用）
- `src/lib/errors/user-facing.ts` の `ValidationError` … 入力の誤りを本番でも画面へ返す

**判断を変えた点**

`ai_feedback` テーブルは、ドキュメントが「採否を記録する」と書いていたが実装は触れて
いなかった。採否は `ai_runs`（status / reviewed_by / accepted_at / rejected_at）と
`audit_events` に既に残るため、**二重に持たず記述の方を実装へ合わせた**。
使っていないテーブルは `docs/known-limitations.md` に理由付きで並べ、
`schema-parity.test.ts` が「理由の書かれていない未使用テーブル」を検出する。

**RLS の UPDATE は 0 行更新で例外にならない**

権限の無いロールで UPDATE を試すテストは、例外の有無ではなく
**値が変わっていないこと**で判定する。例外を期待すると必ず落ちる。

### 2026-08-24（続き）一括取込を 50 ファイルへ拡張

本番 Demo Mode の取込プレビューを Cookie（4KB）から sessionStorage（数 MB）へ移した。

- 投入: Server Action が解析まで終わらせ、プレビュー内容を**戻り値で返す**。
  クライアントが sessionStorage へ預けてから遷移する（redirect しない）。
- 表示: サーバーにジョブが無ければ、タブが預かった内容から同じ画面を描く。
  表は 1 部品（preview-table.tsx）を共用。
- 確定: フォームが期間と元資料の位置を同送するので、ジョブを持たない
  インスタンスでも台帳へ反映できる（confirmIngestionJob の fallback 引数）。

**教訓**: PostgREST は文ごとに別トランザクションなので、DEFERRABLE 制約は効かない。
`files.current_version_id` を先に指して INSERT すると必ず違反になる
（Supabase Mode のアップロードがずっと壊れていた。50 ファイル E2E で発見）。
「作ってから指す」順序にすること。

### 2026-08-25 人的資本データセット v2 とバウンダリ検知

- `scripts/human-capital-dataset.ts` を全面書き換え。人事システム出力の深さ
  （総計 498 行・明細粒度）。決定論（mulberry32）。zip はローカル
  `C:\Users\hiras\Documents\t4d-datasets\` に出力（Drive は Chrome 拡張が
  未接続のため保留。接続後に版管理で差し替え可能）。
- `src/lib/imports/boundary.ts` 新設。集計範囲の宣言を 6 分類（雇用範囲・
  管理職定義・期間基準・算定方法・離職範囲・連結範囲）で正規化し、
  同じ指標に異なるバウンダリが混在したら双方の行へ警告して要確認へ倒す。
  規則ベース（AI 判定にしない。根拠が再現し監査法人へ説明できる）。
- **拾った既存バグ**: 汎用の「従業員数」ヒント（headcount）が具体的な指標より
  前にあり、英国の Women in management 行が employees に化けていた。
  ヒントは「具体的なものが先」を必ず守ること。
- XLSX の取込は**先頭シートのみ**解析される。集計を見せたい場合は
  先頭シートの末尾にも載せること（HC05 で対応）。

### 2026-08-25（続き）SSBJ 正式基準マスターの収録

発注者が SSBJ（サステナビリティ基準委員会）から**転載許可を取得済み**とのことで、
架空縮小版（10 項目）を正式基準の条文マスター **133 項目**へ差し替えた。

- `src/lib/frameworks/ssbj-2026.ts` 新設（fixtures ではない。実在の基準原文のため）。
  公式 PDF（ssb-j.jp）から抽出：一般開示基準 第7〜39項（33）、気候関連開示基準
  第9〜99項（96。第47項は (1)〜(3) に分割して GHG 指標へ紐付け、枝番 56-2〜56-4 は
  2026-03-13 改正の挿入項なので changeType: 'new'）、実務対応基準第1号 第7〜10項（4）。
  範囲・定義・適用時期・経過措置・別紙・ユニバーサル基準は収録対象外（原本参照）。
- questionText＝要約タイトル（アプリで付与）、guidance＝原文。SSBJ 画面は
  「基準の原文を表示」（details）で原文を開ける。isFixture=false になり
  「架空の縮小マスター」バッジは消え、「正式基準準拠（転載許可取得済み）」バッジと
  **出所表記**（画面フッター・DOCX Export の概要）を必ず出す。
- 貼り付け取込のコード認識（ITEM_CODE_PATTERN）へ「一般-9」「気候-47(1)」
  「気候-56-2」「実務-7」形式を追加。
- テスト: `tests/unit/ssbj-master.test.ts`（原文の欠落・ノイズ・出所を機械検査）。
- **教訓**: PDF 抽出は (1) 全角ページ番号「−5−」、(2) 段落末尾へ食い込む節見出し、
  (3) CJK 行折返しスペース、の 3 種のノイズが出る。見出し除去は「正確な文字列＋
  効かなければエラー」方式にする（黙って壊れない）。
- **教訓**: `tests/e2e/security-audit.spec.ts` の Open redirect テストが
  `127.0.0.1:3105` を直書きしており E2E_PORT 未設定（既定 3100）で落ちていた。
  baseURL から導出する形に修正。ポートの直書きはしない。

CDP 2026 は正式質問書がポータル登録制（公開 CDN にあるのは Overview / Setup
Preview / Scoring のみ）。アカウント作成・ログインは AI からは実行できないため、
発注者側での登録・入手待ち。入手後も本文のアプリ同梱には CDP のライセンス確認が要る。

### 2026-08-26 人的資本データセット v3（人事システムの生出力）と取込の堅牢化

「もっと人事システムから直接取り出した感のある、長くて複雑なデータ」を、
**事前加工なしで正しく取り込める**ようにした。データを増やすだけでは
二重計上を招くため、取込側を先に固めてからデータを作っている。

**取込側（誤った値を静かに入れないための 4 点）**

1. `src/lib/imports/row-role.ts` 新設。明細と同じ列構成で混ざる小計・合計行を
   規則ベースで検知し（日英独仏中の見出し語）、「明細行と一緒に確定すると
   二重計上になります」と警告して**既定のチェックを外す**。
   誤検知のガード: ラベルらしいセル（短い・数値でない）だけを見る、見出し語は
   末尾にあることを要求（「設計」を「計」と誤らない）、集計行の比率が過半を
   超える表では判定を諦める。
2. `src/lib/imports/column-roles.ts` 新設。列を code / date / previous / period /
   unit / value / label に分類し、**値の列だけを走査**する。
   これまでは行内の最初の非ゼロ数値を採っていたため、部門コード `0110` が
   110 人になり、「上年同期用工总数」が当年値として入っていた。
3. `parsers.ts`: ヘッダー検出を「本体と列数が揃っている行」で行うように変更。
   前置きブロックを `preamble`、末尾の注記・件数行を `trailer` として分離。
   同名の列は `人数_2` と連番を振る（後勝ちで列が消えていた）。
   **表の途中にある注記行は落とさない**（末尾に連続する分だけ trailer へ）。
4. `service.ts`: 前置きブロックのテキストをファイル単位の文脈として
   バウンダリ検知へ渡す。「集計対象: 正社員のみ」は帳票の冒頭にしか
   書かれておらず、明細行だけを見ても集計範囲の差が分からないため。

**データセット v3**（`scripts/human-capital-dataset.ts` 全面書き換え・863 行）

奉行 / PCA / COMPANY / Workday / SAP HCM / SuccessFactors / ADP / LMS の出力を想定。
帳票の前置き 5〜7 行、明細に混ざる小計・合計（73 行）、末尾の ※注記・件数、
2 段ヘッダー（システムキー + 表示ラベル）、Workday のパス型列名、
ゼロ埋め・階層部門コード（`100-10-01`）、和暦と西暦 8 桁の混在、
セル内改行、前年同期の列、Shift_JIS / セミコロン / `1.234,5` / `1 234,5`。
明細を足すと帳票の合計行と一致する（HC01 の正社員 506 名）。

**拾った既存バグ**: `buildSimplePdf` が Latin-1 外を黙って `?` に置換していたため、
**日本語の PDF（HC07 / HC20）が全文 "?" になっていた**。誰も気付けない壊れ方なので
生成時に例外を投げるようにし、PDF は英文（グループ EHS / 開示文書）へ統一した。

**教訓**: サンプル生成器で「表現できない入力を黙って落とす」実装は禁物。
`encodeSjis` は最初から例外を投げていたので無事だった。同じ方針に揃えた。

### 2026-08-26（続き）SSBJ を「ギャップ分析ツール」から業務システムへ

発注者の要望（20 項目）に沿って、SSBJ 画面を全面的に作り直した。
「AI が○△×を付けて終わり」ではなく、
分析条件 → 資料取込 → 対象判定 → AI ギャップ分析 → 担当者の確認
→ 優先順位付け → 対応計画 → データ収集・開示・内部統制
の 8 段階を一連の流れとして管理できるようにした。

**設計の中心にある 3 つの分離**

1. 適用区分（対象／対象外）・重要性（あり／なし）・対応状況を**別々の項目**として持つ。
   単純に全項目を ○△× で採点しない。
2. 対応状況は 1 つの要求事項につき **3 観点**を持つ。
   開示（資料に書いてあるか）／データ（社内で取れているか）／
   業務プロセス・内部統制（継続的かつ正確に集め、承認できる仕組みがあるか）。
   全体状況画面も単一の総合点ではなく、この 3 つを別々の整備度として出す。
3. AI 判定 → 担当者判定 → 最終判定を分けて保存する。
   `finalStatus` は担当者が確認して初めて入る。AI を再実行すると確認はやり直しになり、
   確認日・確認者・確認コメントも消える（いつの判定を確認したのかが食い違わないように）。

**追加したもの**

- `supabase/migrations/0025_ssbj_gap_analysis.sql`: `ssbj_assessments` /
  `ssbj_action_plans`（RLS 付き。参照は組織メンバー、更新は
  `enterprise.disclosure.write`）
- `src/lib/domain/ssbj.ts`: 日本語ラベルと**優先順位の計算**（純粋関数）。
  制度上の重要性・企業にとっての重要性・ギャップの深さ・データの有無と工数・
  第三者保証への影響・対応期限の 6 項目を点数化し、根拠つきで返す。
  AI に順位を決めさせない（監査法人へ説明できる必要があるため）。
  **優先度は保存しない**。対応状況を更新したら順位も追随する。
- `src/lib/services/ssbj-gap.ts`: 全体状況・一覧・詳細・確認・対応計画・
  データ収集・前年度引き継ぎ
- `ssbjGapAnalysis` を AI Use Case へ追加（Mock も決定論的に実装）。
  出力は 3 観点の判定・不足情報の列挙・推奨対応・**根拠にした資料名とページ**
- 画面 5 枚: 対応状況 / 要求事項一覧 / 要求事項詳細・ギャップ分析 /
  対応計画 / データ収集

**データ収集への接続**: データギャップの対応計画から「データ収集項目を作成」すると、
指標マスターへ登録し、**これまで空だった `metric_assignments`**（指標 × 拠点 × 期間の
担当・期限）に行を入れる。ギャップ分析 → 対応計画 → データ収集が途切れない。

**画面の文言はすべて日本語**にした（「全体状況」「評価」「確認」「対応」「データ項目」
「対応済み」「一部対応」など）。SSBJ のような定着した略称だけ残している。

**注意した既存の制約**

- SSBJ には `disclosure_responses` が 1 件も seed されていないため、
  評価は `ssbj_assessments` として独立させた（回答の有無に依存しない）。
- マテリアリティ評価表は既存 e2e が行内の combobox/textbox/保存ボタンを
  名指ししているため、**触らずそのまま残した**（行に部品を足すと strict mode で落ちる）。
- `six-features.spec.ts` の SSBJ ケースだけは旧 3 ステップ前提だったので、
  新しい 8 段階フローに合わせて更新した。

### 2026-08-27 デモシナリオを SSBJ 対応中心へ組み替え

デモモードの巡回は 9 ステップで、**SSBJ が 1 つも入っていなかった**（CDP が主役）。
SSBJ 対応管理を作り込んだ後もデモがそれを見せていない状態だったので、
話の軸を SSBJ 対応に据え直した。

**新しい構成（12 ステップ）**

機能を並べるのではなく、SSBJ 対応という 1 本の仕事を追う:
現在地 → 何が足りないか → 誰がいつまでに何をするか → データをどう集めるか
→ 根拠と承認をどう残すか → 他の開示にも使い回せる。

1. ホーム（SSBJ 対応度・未対応件数から 1 日が始まる）
2. SSBJ 対応状況（単一の点数にまとめない — 3 つの整備度）
3. SSBJ 要求事項一覧（適用区分・重要性・対応状況の 3 軸）
4. ギャップ分析（最優先の要求事項へ直行）
5. 担当者による確認（同じ画面で「人工知能は確定しない」を見せる）
6. 対応計画
7. データ収集（ギャップ → 収集依頼のつながり）
8. 一括取込 / 9. 台帳 / 10. 根拠資料（データと内部統制のギャップを埋める実務）
9. CDP・CSRD への展開 / 12. 監査法人とのやりとり

各ステップに `phase`（SSBJ 8 段階のどこか）を持たせ、案内の先頭に出している。

**あわせて直したもの**

- ホームの KPI が CDP 準備度だけだったので、`SSBJ 対応度`（3 観点のうち最も遅れて
  いるものを表示）と `SSBJ 未対応` を追加。`loadSsbjHeadline` は**読み取り専用**に
  してある（画面を開いただけで評価行が作られると、誰が作ったか説明できない）。
- `/enterprise/disclosures/ssbj/requirements/top-priority` を新設。最も優先度の
  高いギャップの詳細へ飛ばす（デモ以外でも使える入口）。静的セグメントなので
  `[itemId]` に食われない。
- ナビ「開示対応」の遷移先を CDP → SSBJ へ。子項目も SSBJ 群を先頭に。
- レポート画面の並びも SSBJ 開示ドラフトを CDP より前に。

**教訓（環境）**: E2E の既定ポート 3100 を**別のアプリが掴んでいることがある**。
`reuseExistingServer` が効くため、他人のアプリに対してテストが走り
「デモログインが無い」という無関係な失敗になる。空きポートを確認して
`E2E_PORT=3130 pnpm test:e2e` のように指定する。他プロセスは落とさない。

### 2026-08-27（続き）ドラッグ&ドロップで取込が始まらない不具合

**症状**: データ収集の画面にファイルをドロップしても取込が始まらない。

**原因は 2 つ**（ドロップ自体は成立していた）。実ブラウザで調べたところ、
`input.files` にはファイルが入っていた（`{files: 1, name: 'probe.csv'}`）。
つまり壊れていたのは受け渡しではなく、その後:

1. **画面が何も変わらない**。受け付けたのかどうか利用者に分からない。
2. **解析が始まらない**。別途「取込を開始」を押す必要があった。
   ドロップは「これを今すぐ取り込む」という操作なので、期待と食い違う。

**直した内容**

- ドロップしたら `form.requestSubmit()` でそのまま解析を始める。
  クリックで選んだ場合は従来どおりボタンで開始する（対象組織を選び直して
  から始めたいことがあるため）。既存 e2e が `setInputFiles` + ボタンの流れを
  前提にしているので、その経路も変えていない。
- 選択・ドロップしたファイル名と件数を `role="status"` で表示する。
- `dragenter` / `dragleave` は子要素をまたぐたびに発火するため、
  出入りの回数を数えて本当に外へ出たときだけ強調を解除する（枠内を動かす
  だけで点滅していた）。

**なぜ気付けなかったか**: 既存の取込 e2e はすべて `setInputFiles` で
file input へ直接入れており、**ドロップの経路を一度も通っていなかった**。
`tests/e2e/import-drag-drop.spec.ts` を追加し、DataTransfer を組み立てて
実際に drop を投げる経路で検証するようにした。

### 2026-08-27（続き）取り込めないファイルで「データを取得できませんでした」になる

**症状**: 取込画面でエラー画面（識別子: 673521396）。本番ログを見ると
`POST /enterprise/imports` が 500、メッセージは `Error: 拡張子 ...`。

**原因**: `createIngestionJob` が拒否時に**素の `Error`** を投げていた。
`withUserFacingError` / `uploadFilesAction` は `ValidationError` などの
利用者向け例外しか拾わないため、素の Error はそのまま 500 になり、
error boundary の「データを取得できませんでした」に落ちていた。

同時に 2 つの設計上の問題もあった:

- 1 件目で throw していたので、**どのファイルが駄目なのか伝わらない**
- ジョブを作ってから検証していたので、**先に処理したファイルだけ保存され、
  失敗したジョブが残る**

**直した内容**

- 全ファイルを**ジョブ作成前に**検証し、駄目なものをまとめて名指しする
  `ValidationError` を投げる（「次のファイルは取り込めません。… 議事録.txt
  （拡張子 .txt は許可されていません…）」）。ジョブも保存も発生しない。
- 同じ形の問題が `master-data.ts` にもあった（指標コードの重複、持分の範囲、
  提出期限の未入力など 11 か所が素の Error）。すべて `ValidationError` へ変更。
  入力の誤りが「データを取得できませんでした」になる状態を解消した。

**なぜ気付けなかったか**: 既存の e2e は
`await expect(page.locator('body')).not.toHaveText(/Internal Server Error/)`
しか見ておらず、**日本語のエラー画面に落ちても通ってしまう**検証だった。
「拒否されたファイル名が画面に出ること」「error boundary に落ちないこと」を
確かめるよう強化した。

**ドラッグ&ドロップとの関係**: ファイル選択ダイアログは `accept` で絞られるが、
ドロップは何でも落とせる。ドロップで即解析を始めるようにしたことで、
この潜在バグが表に出た。

### 2026-08-27（続き）.txt を取り込めるようにした

`.txt` は `ALLOWED_EXTENSIONS` に無く弾かれていた（`text/plain` は既に
`CSV_MIME` に入っていたので、拡張子の許可だけが塞いでいた）。

**中身で振り分ける**ようにした。`.txt` は 2 通りあるため:

- **表**（タブ区切りなどの書き出し）→ これまでどおり行として取り込む
- **自由記述**（議事録・規程）→ 行にせず、資料の断片（`fragments`）として保存する。
  根拠資料の紐付けと SSBJ のギャップ分析から参照できる。

判定は `looksTabular()`。区切り文字で割ったときの列数が、2 列以上で
6 割以上の行にわたって揃っているかで見る。自由記述を無理に表として読むと、
1 列だけの意味の無い行が大量に並んで台帳を汚すため。

`ParseResult` に `kind: 'text'` を足し、取込サービスと過去回答 Import の
両方で扱えるようにした。空の `.txt` は成功扱いにしない。

**注意**: 正規表現に BOM をリテラルで書くと `no-irregular-whitespace` で
lint が落ちる。`/^\u{FEFF}/u` のようにエスケープで書くこと。

### 2026-08-27（続き）5 件の追加要望

#### ① 指標マスターを SSBJ・CDP・CSRD から作り直した

指標マスターは自社都合の 21 指標でしかなく、基準が何を求めているかと
切れていた。3 基準の要求から取り込んで 60 指標にし、指標そのものへ
**出所（frameworks）**を持たせた（`0026_metric_frameworks.sql`）。

主なもの:

- SSBJ 第2号 第55項 → Scope3 の 15 カテゴリーすべてを指標として持つ
- 同 第53項 → Scope2 をロケーション基準とマーケット基準で分ける
- 同 第79〜84項 → 移行/物理的リスクに脆弱な資産、資本投下、内部炭素価格、
  役員報酬への組込割合。既存の 6 分類に居場所が無いので
  `climate_transition` を追加した
- CDP / ESRS → 再生可能エネルギー、取水・排水、有害廃棄物、リサイクル率、
  労働災害、労働協約適用率、腐敗事案件数 など

**新しい指標にデモの実績値は作っていない**（`MetricSpec.demoData`）。
架空の値で埋めるとデータギャップが消え、SSBJ 対応の主題である
ギャップ分析が体験できなくなるため。出所の対応表は `METRIC_FRAMEWORKS`
1 か所にまとめてあるので、基準改正時はそこだけ原文と突き合わせればよい。

#### ② 指標マスターと無関係な行を、警告を出さずに取り込み対象外にした

社員名簿・住所録・署名欄に 1 行ずつ「指標を特定できませんでした」と
出していたため、本当に確認が要る行がその山に埋もれていた。
`src/lib/imports/relevance.ts` を追加し、指標マスターの語彙とまったく
重ならない行は `ignored`（新しい状態）として静かに外す。

**取り込む側へ倒している**。誤判定でデータが黙って消えるほうが重いので、
計量単位（GJ・MWh・t-CO2e…）が 1 つでもあれば、指標マスターに無い項目でも
残す（「圧縮空気（購入分）, 18.4, GJ」を外さない）。
判定するのは**セルの中身**であって列名ではない。「単位」列を持つ表に
名簿が紛れ込むとその列に「主任」が入るため、列名で見ると除外が効かなくなる。

8 割を超える行が外れたらファイル単位で人へ伝える。外した件数は
プレビューと監査ログに必ず残す。ついでに、AI とサービス層が同じ
「指標を特定できませんでした」を二重に出していたのを直した。

#### ③ ①を「マテリアリティ・分析条件の設定」にし、未完了から始めた

8 ステップの入口が常に「完了」と表示されていたが、実際には何も
決めていなかった。決めるのは後続すべての前提になる 3 つ:
適用する基準／報告の範囲／マテリアリティ。

`ssbj_analysis_settings`（`0028`）を追加し、専用画面
`/enterprise/disclosures/ssbj/settings` へ集約した。**当年度の
マテリアリティ Fixture は削除**し（前年度 FY2025 のみ残す）、
未評価の状態から人が決める流れを体験できるようにした。

内容を変えたら確定は外れる。前提が変わったのに確定のままだと、
後続の工程が古い前提のまま進むため。

#### ④ 最大 5 階層の承認フローと履歴

承認が「提出 → 確認中 → 承認」の 1 段階しか無く、誰の承認で確定したのかを
監査法人へ示せなかった。`0029_approval_routes.sql` で
`approval_routes` / `approval_route_stages` / `data_point_approval_steps` を追加。

- 道筋（テンプレート）の写しをデータごとに作る。定義を変えても
  進行中・確定済みのデータの経路は変わらない
- 差し戻し後の出し直しは `round` を増やし、前の巡の記録を残す
- 段階を飛ばして `approved` にはできない（`transitionDataPoint` で塞いだ）
- 段階に割り当てる役割は `enterprise.data.review` を持つものに限る。
  入力担当（site_contributor）は提出までが役割で承認段階に入らない

履歴は承認段階（承認・差し戻し）と版（修正）が別表に分かれているので、
`loadApprovalTimeline` で 1 本の流れに突き合わせて出す。

#### ⑤ 開示ドラフトを人工知能に書かせる

判定とデータは揃っているのに、文章にする工程だけが手作業で残っていた。
AI Use Case `ssbjDisclosureDraft` を追加し、節（ガバナンス・戦略・
リスク管理・指標及び目標）単位の草案を書かせる（`0030` に保存）。

**書けるのは、担当者が確認して「対応済み／おおむね対応」とした要求事項だけ**。
未確認・未対応は本文に入れず、`gaps` に理由つきで列挙する。
数値は承認済みのものだけを渡す。AI が書いた本文（`aiBody`）と人が直した
本文（`body`）を分けて持ち、そのまま開示したのかを後から説明できるようにした。

**注意**: `ai_jobs.feature_type` の CHECK 制約には新しい Use Case を
足していない（`ssbjGapAnalysis` も同様。ai_jobs は使っていない）。

#### E2E で踏んだ罠（次に触る人へ）

**Demo Mode の状態は E2E のテスト間で共有される。** サーバープロセスのメモリに
あるため、あるテストが承認した結果が別のテストへ漏れる。承認の段階のように
「進んでしまうと戻せない」ものを検証するときは、**他のテストが触らない
Data Point を選ぶ**こと（`EU/scope1` を使ったのはこの理由）。

**`hasText: '未評価'` で行を絞り込めない。** select の `<option>未評価</option>` にも
一致するため、評価済みの行にも当たる。行番号で回すか、バッジ側を見ること。

**承認の道筋を入れたことで、従来の一発「承認」ボタンは使えなくなった。**
押しても必ず失敗するボタンを残すと利用者が詰まるので、道筋が進行中のときは
ボタンを出さず「承認フローへ（n/5 段階）」の導線に差し替えている。
`approver` は `['approver', 'reviewer']` の 2 役なので、1 段目（reviewer）も
承認できる点に注意（「5 段目の人は 1 段目を承認できない」は成り立たない）。

### 2026-08-28 取込プレビューの「指標を特定できませんでした」を非表示にした

#### ① 依頼された変更

データ収集の取込ジョブで、行ごとに出していた
**「指標を特定できませんでした。手動で選択してください。」を画面に出さない**ようにした
（発注者の指示: いったんすべて非表示）。

`src/lib/imports/hidden-warnings.ts` を追加し、表示の直前で `visibleRowWarnings()` を通す。
通すのは `preview-table.tsx` の 1 か所だけでよい。サーバー側にジョブが残っている場合も、
ブラウザが `sessionStorage` で持ち回っている場合（`preview-store.ts`）も、
同じ部品を通って描画されるため。

**なぜ取込時ではなく表示側で落としたか。** 取込時（`imports/service.ts`）に警告を作らない
作りにすると、**すでに保存されている行には効かない**。Supabase 側の既存行と、
ブラウザに残っている取込プレビューは、前に取り込んだときの警告文をそのまま持っている。
行に保存された警告と判定はこれまでどおり残してあるので、
出し直すときは `HIDDEN_ROW_WARNINGS` から外すだけで戻る。

消していないもの:

- 行の状態は「要確認」のまま。指標欄も「（未選択）」のままで、人の操作は変わらない
- 合計行（二重計上）・注記行・単位違い・数値未検出の警告は**残す**。
  確定を誤ると台帳が壊れるものなので、まとめて消してはいけない
- AI 実行記録（Provenance）の「一部の行で指標・単位を特定できませんでした」は
  行ごとのアラートではなく実行 1 回の記録なので残した

#### ② 前セッションが残していた未コミットの変更を仕上げた

作業開始時、作業ツリーに未コミットの変更（SSBJ の設定で選んだ基準を要求事項一覧・
見出し数値へ反映する `ssbj-gap.ts` の変更とそのテスト）が残っており、
`pnpm typecheck` が落ちていた。テスト側の import 漏れ
（`loadSsbjRequirementViews` / `loadSsbjHeadline`）だけを補って取り込んだ。

#### ③ E2E の「確定できない」は、テストの待ち方の誤りだった

`ssbj-settings-approval-draft.spec.ts` の③⑤が落ちていた。調べると**実装ではなくテストの不具合**。

```ts
await page.waitForURL(/\/enterprise\/disclosures\/ssbj/); // ← いま居る /ssbj/settings に即一致
await page.goto('/enterprise/disclosures/ssbj/settings'); // ← 確定の POST を打ち切ってしまう
```

正規表現が現在地の `/ssbj/settings` にその場で一致するため待たずに次へ進み、
直後の `goto` が確定の Server Action を打ち切っていた。確定していないので
「確定済み」が出ない。遷移先（`?confirmed=1`）まで待つよう直した。
⑤ が落ちていたのは別件で、**テスト間の状態の漏れ**だった。
`new-features-audit.spec.ts`（前セッションが未コミットで残していた監査スイート）が
開示ドラフトの**先頭の節（ガバナンス）**を人の手で 20 文字の文へ書き換えて保存する。
Demo Mode の状態はテスト間で共有されるため、後から走る⑤が
「人工知能が書いた草案」として人が直した本文を読み、長さの検査に落ちていた
（アプリの仕様どおり、人が直した本文は作り直しても保たれる）。
監査スイート側を**最後の節（指標及び目標）**へ移し、節ごとにカードを絞り込むようにした。
節の絞り込みは `aria-label`（`〇〇の開示文`）と見出しの 2 つ上の Card を使う。

#### E2E を回すときの注意（次に触る人へ）

**既定ポート 3100 が他プロジェクトに取られていると、251 件がほぼ全滅する。**
`playwright.config.ts` は `reuseExistingServer: !CI` なので、3100 が応答すると
Playwright は自前のサーバーを立てず、**別のアプリ**へテストを流す
（症状: 「デモログイン」が見つからない）。今回は
`C:\Users\hiras\Documents\test\airis-ucheck2` の `next start -p 3100` が常駐していた。
`netstat -ano | grep 3100` で素性を確かめ、埋まっていれば `E2E_PORT=3210 pnpm test:e2e` で回す。
途中で止めたときは orphan の `pnpm test:e2e` / `next start` を必ず落とす。
2 つの run が重なると chromium worker が `code=3221225794` で落ち、以降が
全部 "did not run" になって原因が見えなくなる。

#### 検証と本番反映

ローカル 7 コマンドすべて通過。

| コマンド                                   | 結果                                    |
| ------------------------------------------ | --------------------------------------- |
| `pnpm lint` / `format:check` / `typecheck` | 通過                                    |
| `pnpm test`                                | 49 ファイル / 558 件 通過               |
| `pnpm check:rls` / `pnpm test:rls`         | 83 テーブル・191 ポリシー / 101 件 通過 |
| `pnpm test:e2e`                            | 251 件 通過（`E2E_PORT=3212`）          |
| `pnpm build`                               | 通過                                    |

本番（Demo Mode）へ反映済み。

- Deploy: `t4d-oky424d67-kotakase2022-jpgs-projects.vercel.app`
- Alias: https://terrast-t4d.vercel.app を上記へ張り替え（`vercel alias set`）
- `pnpm test:e2e:prod` 28 件 通過

本番スモークに、指標が当たらない行（`圧縮空気（購入分）, 18.4, GJ`）を 1 行足した。
「行は残る／アラートは出ない／指標欄は未選択のまま」の 3 つを本番の画面で確かめる。
指標が当たる行しか投入していなかったため、今回の変更が本番へ届いたかを
確かめられない状態だった。

未解決・次作業は無し。アラートを出し直すときは
`src/lib/imports/hidden-warnings.ts` の `HIDDEN_ROW_WARNINGS` から外す。

### 2026-09-01 マテリアリティ評価の刷新（追加・編集・削除／自由記述→区分の提示／理由必須）

発注者からの 3 点に対応した。

**① 課題の追加・編集・削除。** 課題は固定 7 件から利用者管理へ。
削除は論理削除（`0031` で `deleted_at` 追加、一意制約を生存行のみの
部分インデックスへ差し替え）。評価の記録は監査で問われるため行を消さない。
課題の ID は `fid`（決定論）ではなく `crypto.randomUUID()`。時刻を種に
混ぜても同一ミリ秒の「削除→同名で再追加」で衝突するため。

**② 自由記述 → 区分の提示 → 選択。** `DEFAULT_TOPICS` の固定一覧は廃止し
（`PRESET_TOPICS` として入力の下書きチップに残置）、
`src/lib/domain/materiality-suggest.ts` の規則ベース提示器が
入力文から区分候補を**一致した語つきで**返す。AI にしないのは提示の根拠を
画面に出すため（`row-role.ts` と同じ方針）。決めるのは常に利用者。
階層は マテリアリティ名 → 区分 → 項目（対象指標）になった。

**③ 評価理由は必須。** 未評価へ戻すとき以外は理由必須
（重要でないとした根拠も監査で問われるため、not_material にも要求）。
誤りの指摘は `?error=` リダイレクトをやめ、`useActionState` の戻り値で
**操作した行の中**に出す（`MaterialityActionState`）。

**踏んだ罠**:

- `validateTitle` で NFKC 正規化すると、全角括弧が半角に化けて
  利用者の入力どおり表示されない。正規化は提示器の照合側だけで使うこと。
- FY2026 のマテリアリティ Fixture は無し（利用者が登録する体験のため）。
  FY2025 の 7 件だけ残っている。課題の行を前提にしていた E2E は
  すべて「追加してから操作する」形へ書き換えた。
- 提示で判断できない名前（一致語なし）では追加ボタンが disabled。
  テストで任意の名前を使うときは区分ラジオ（「区分: 環境」等）を明示的に選ぶ。

### 2026-09-01（続き）マテリアリティに内容・リスク・機会を持たせる

発注者からの 3 点 ＋ SSBJ 開示プロセスの簡易版（①マテリアリティ登録 →
②リスク・機会登録 → ③要求事項へ自動マッピング → ④データ項目自動生成 →
⑤要否確認 → ⑥GAP確認 → ⑦不足のみ収集）を受けて対応した。

**① ラベル変更。**「マテリアリティ名（自由記述）」→「マテリアリティ名（必須）」。
参照していた E2E・本番スモーク 5 spec を一括置換した。

**② 内容の説明（任意）を追加し、名前と合わせて区分を判断。**
`suggestMaterialityCategory(name, ...additionalTexts)` は可変長で追加テキストを
受ける。名前が一般語（「協働体制の見直し」等）でも、内容の
「調達先の労働環境…」から社会を提示できる。

**③ リスク・機会（0032 で列追加）。** SSBJ 上の位置づけ:

- 一般-12(1)・一般-14: 「見通しに影響を与えると合理的に見込み得る
  サステナビリティ関連のリスク及び機会」の識別＝マテリアリティの特定
- 一般-13: 影響・財務的影響は**リスク及び機会のそれぞれについて**開示

これを踏まえて 3 つに接続した:

1. **課題ごとの自由記述**（`saveTopicRiskOpportunity`）。2000 文字まで
2. **③自動マッピングを育てる**: リスク・機会の記述から同じ区分の指標を
   項目（対象指標）へ**自動追加**する（減らさない。減らすのは人の編集）。
   別区分の指標は混ぜない
3. **戦略の開示ドラフトの起点にする**: 重要性あり（high/medium）の課題の
   リスク・機会を `generateSsbjDraft` の入力へ渡し、Mock は戦略の節の冒頭に
   「当社が識別したサステナビリティ関連のリスク及び機会は…」として織り込む。
   未記入なら草案の warnings で記入を促す（一般-12・14 を引用）

発注者のプロセス ④〜⑦ は既存機能が担う: ④=課題の項目（対象指標）と
対応計画→データ収集項目、⑤=要求事項の対象判定・重要性判断、
⑥=充足度・未収集表示とギャップ分析、⑦=データ収集画面の不足項目。

### 2026-09-03 有報からの範囲自動選択・階層化・マッピング表・評価画面の統合

発注者からの 4 点（①有価証券報告書から報告対象を自動チェック
②報告対象の階層構造化 ③マッピング表で対象の検算＋資料/データ紐づけ可否
④工程③〜⑥の 1 画面統合）に対応した。

**① 有報からの自動選択。** `src/lib/services/securities-report.ts` の
`applySecuritiesReportScope`。取込済みの最新の有報（ファイル名か書類種別で
判定）の本文から組織マスターの拠点名を探し、見つかった連結対象へ自動で
チェックを入れて `ssbjAnalysisSettings.includedUnitIds` へ保存する。
規則ベース（名称の完全包含）。**持分法適用会社は見つけても自動チェック
しない**（連結範囲の外。含めるかは人が決める。Flash にその旨を明示）。
範囲が変わるので確定（confirmedAt）は外す。Fixture の有報は
`evidence-documents.ts` の `securitiesReport`（関係会社の状況＋設備の状況）。
**組織マスターの名称と本文の表記が一致しないと見つからない**（コメント済み）。

**② 階層化。** settings ページ内 `UnitScopeSelector`。
本社・直轄拠点／100% 子会社（連結）／持分法適用会社（注記つき）／
サプライヤー（バリューチェーン候補の注記）の 4 群、国内→海外順＋所在バッジ、
持分法は持分 % を併記。チェックボックスのアクセシブル名は
「本社 国内」のようにバッジを含む（E2E は `getByLabel(/^本社/)` で取る）。

**③ マッピング表。** `loadSsbjScopeMapping`（ssbj-gap.ts）が
「なぜこの件数なのか」を検算できる形で返す:
件数の流れ（マスター 133 → 適用基準 → 対象外・重要性なし除外 → 評価対象）、
マテリアリティ × 基準の表（一般＝全課題、気候＝提示器の `climate` 判定。
登録時と同じ規則なので画面の説明と食い違わない）、指標→
`disclosureMappings` 経由で紐づく要求事項数。紐づけは
`SsbjRequirementView` の `hasDocumentLink`（AI 分析の出典）／
`hasDataLink`（disclosure_mappings × 当期の値あり dataPoints）／`analyzed`。
`filterRequirements` に `linkage`（document/data/unanalyzed/none）を追加。

**④ 1 画面統合。** requirements ページを「SSBJ 要求事項の評価」へ改題し、
工程チップ 4 つ（残件数はリンク先の絞り込みと同じ関数で数える＝ズレない）、
マッピング表・紐づけ集計カード、`runSsbjGapAnalysisBulk`（優先度順・
最大 20 件。AI が最終判定を入れない原則は不変）の一括実行ボタンを載せた。
全体状況の 8 段階フローは 5 段階へ（旧③〜⑥を統合）。demo-tour の
手順番号も 1〜5 へ振り直した。

**テスト**: `tests/integration/securities-report.test.ts`（新規 5 件）、
ssbj-gap.test.ts へマッピング・紐づけ・一括分析の 5 件追加、
e2e は six-features / ssbj-gap / new-features-audit / demo-tour /
本番スモークの旧工程名参照を統合後の文言へ更新。
Fixture は大半が分析済みのため、一括分析のテストは 8 件を未分析へ
戻してから確かめる。

**結果**: 全ゲート通過（unit+integration 603 / RLS 101 / E2E 257 /
本番スモーク 28）。047cf8d を deploy → terrast-t4d.vercel.app へ
エイリアス済み。未解決なし。

### 2026-09-04 CSV 出力・開示ドラフト導線・左メニュー再設計

発注者依頼の 3 点（① 要求事項一覧の CSV 出力 ② SSBJ 開示ドラフトへの
3 導線 ③ 会議議事録に基づく左メニューの最適配置）に対応した。

**① CSV 出力。** `/api/exports/ssbj-requirements`（Route Handler、
既存の data-points Export と同じ作り）。列定義は
`src/lib/exports/ssbj-requirements.ts` に分離してテスト可能にした。
画面と同じ `loadSsbjRequirementViews` ＋ `filterRequirements` を通すので
**画面の絞り込みが CSV にそのまま効く**（ボタンの href がクエリを引き継ぐ）。
値は内部コードでなく画面と同じ日本語ラベル。既存 `toCsv` が
BOM 付与と数式インジェクション対策を持つ。`enterprise.export.run` で
表示・実行とも制御。audit_events（export_created）へ記録。

**② 開示ドラフト導線（3 か所）。**

- SSBJ データ収集の右上（primary。収集の次の工程として）
- データ取込（/enterprise/imports）と取込ジョブ詳細の右上
  （会議の指摘「取込後にドラフトへ自然に遷移できない」への対応）
- 左メニュー「開示対応」配下、SSBJ データ収集の直下に「SSBJ 開示ドラフト」

**③ 左メニュー再設計（開示対応は不変）。** 会議の決定を反映:

- 2 つの入口を並べる: 開示対応（目的ドリブン）→ ESG データ（データ先行）
- ESG データ配下 = データ取込 → 非財務データ → Evidence（データが流れる順）
- GHG は独立モジュールとしてトップレベル維持（算定が重いため分離の決定）
- 業務管理 = ワークフロー・アラート・レポート ／ 管理 = 組織・拠点・設定
- 旧「データ収集」は「SSBJ データ収集」と紛れるため**「データ取込」へ改名**
  （nav・imports 画面タイトル・パンくず）。トップレベルは 12 → 7 項目。

**実装メモ**: 権限による非表示（設定）が子項目でも効くよう、
`app-shell.tsx` の `hiddenNavHrefs` を階層走査に、`sidebar.tsx` の
`useNavItems` を子のフィルタ付きに変更。コマンドパレットは
「親 / 子」ラベルで従来どおり出る。

**テスト**: tests/integration/ssbj-export.test.ts（3 件）、
tests/e2e/nav-structure.spec.ts（3 件）、ssbj-gap.spec に CSV
ダウンロードの実 E2E（Playwright download → 中身の検証）を追加。
本番スモークへ CSV リンク・ドラフト導線・新メニューの検証を追加。

**結果**: 全ゲート通過（unit+integration 606 / RLS 101 / E2E 279 /
本番スモーク 28）。11d10af を deploy → terrast-t4d.vercel.app へ
エイリアス済み。未解決なし。

### 2026-09-07 左メニュー 3 階層化・Scope3 サプライヤー内訳と取込画面

発注者依頼の 2 点（① 左メニュー: 開示対応へ SSBJ の階層を追加、
「ESG データ」→「ESG データ（GHG以外）」 ② GHG: スコープ3 サプライヤー
データの内訳可視化と「サプライヤーデータ取込」画面）に対応した。

**① 左メニュー。** 開示対応の配下を基準ごとにまとめ、
SSBJ → 対応状況／要求事項／対応計画／データ収集／開示ドラフト の
3 階層にした（CDP・CSRD・MSCI・FTSE は SSBJ の兄弟のまま）。
GHG 配下に 算定サマリー／サプライヤーデータ取込 を追加。
`sidebar.tsx`（描画・権限フィルタ）と `command-palette.tsx`（経路ラベル
「開示対応 / SSBJ / 対応状況」）を再帰化。グループ入口と同じ href を持つ
葉（対応状況・算定サマリー）が兄弟ページで `aria-current` を二重に
出さないよう、兄弟パスと前方一致する行は完全一致のときだけ現在地にする。

**② Scope3 サプライヤーデータ。** GHG 画面の算定根拠カードを
「サプライヤー内訳（一次データ）」へ拡張: 提出 5/7 社・一次データ排出量・
確定値に占める一次データ比率・未提出数のミニ KPI、構成比の積み上げバー
（新部品 `ui/stacked-bar.tsx`、凡例チップ＋数値併記で色だけに頼らない）、
社別テーブル（未提出行は取込画面への導線）。
`/enterprise/ghg/suppliers` を新設: CSV ドロップ →規則ベース解析
（AI 不使用。文字コード・区切り・合計/注記行の除外は既存 parsers を再利用）
→プレビュー（排出量計算・新規/置き換え表示・行エラー名指し）→人が確定。
確定は `data_point_calculations` へ**版の追記**（追記専用 RLS と整合）で、
Data Point の確定値は変えない（変更は承認フロー）。テンプレート CSV
（未提出社が行に並ぶ・選択中期間を引き継ぐ）と排出係数コード一覧も同画面に。

**設計の要点（多角レビュー→反証検証で 20 件確定→全対応）:**

- サプライヤー識別はラベル「<コード> <名前> / <品目>」規約
  （`domain/scope3-labels.ts`、書き手はサービスと fixture の 2 か所）。
  突き合わせは不変・一意な**コード**で行い、改名・同名・名前内「 / 」でも
  二重計上・欠落しない（改名の回帰テストあり）。
- 確定は `enterprise.import.run` ＋ `enterprise.data.write` ＋
  対象 Data Point の Unit スコープ（`assertUnitInScope`）を要求。
- 係数は activityUnit「千円」のみ許可（kWh 係数の次元違い混入を防ぐ）。
- テンプレート CSV は共有 `toCsv`（数式インジェクション無害化・BOM）。
- `demo-edit-codec.ts` の PERSISTED_TABLES へ `calculations` を追加
  （取込直後の内訳が別インスタンスで消えないように。1 取込 1 行）。
- Fixture: 未提出サプライヤー SUP-06 若草金属工業・SUP-07 汐風運輸と
  係数 EF-PUR-METAL を追加し seed.sql 再生成。

**テスト**: unit 2 本（CSV 解釈 6 件・ラベル規約 5 件）、
integration 10 件（内訳・追記・置き換え・改名回帰・権限 3 種・次元検査）、
e2e `ghg-suppliers.spec.ts` 3 件（可視化→テンプレート実体検証→取込一巡）、
nav-structure 書き換え（3 階層・href 検証・aria-current 一意）、
full-audit / ui-integrity へ新画面追加、ssbj-settings-approval-draft の
「開示ドラフト」リンクを #t4d-main へスコープ（左メニュー改名で同名 2 件に
なったため）。本番スモークへ GHG 内訳・取込画面の検証を追加。

**結果**: 全ゲート通過（unit+integration 627 / RLS 101 / E2E 264 /
本番スモーク 29）。6a83ce7 を deploy → terrast-t4d.vercel.app へ
エイリアス済み。未解決なし。

### 2026-09-08 GHG 直近3年推移・サプライヤー素データ取込（原単位紐づけ）・30社デモ

発注者依頼の 3 点（① 連結集計の女性管理職比率行の削除と過年度2年分＋
直近3年グラフ ② 排出量だけでなく物理/金額の素データ取込と「排出量原単位の
紐づけ」機能・画面 ③ サプライヤー30社の多様なデモデータと自動仕訳）に対応した。

**① 連結集計と直近3年の推移。** GHG 画面から女性管理職比率の行と ratio
分岐を削除（加重平均の算定はサービスに残る。e2e の該当断言は差し替え）。
過年度は **FY2024 を Fixture へ追加**（closed・GHG 3 指標のみ承認済み・
Evidence 付き。FY2024_RATIO は scope1 1.09 / scope2 1.06 / scope3 0.93 で、
FY2025 の YoY 検証閾値に収まる）。store.ts の「FY2025 か否か」二値分岐は
期間対応表（AOMI_PERIOD_IDS / PERIOD_AGE / PERIOD_RANGE）へ置き換え
（増設時に FY2026 へ黙って割り当てられる罠の除去）。Evidence 文書の係数も
年度対応表にし、書類と台帳の増減方向を一致させた。
「直近3年の推移」は指標ごとに 年度×水平バー（同一色相 明→暗）＋実数＋
前年比（増加=赤/減少=緑、数値併記）。`loadConsolidatedTrend` は
**承認済み実績を持つ年度だけ**を開始日順に選ぶ（自由入力の期間コードや
作成直後の planning 年度が実績年度を押し出して全推計バーを描く事故を防止。
レビュー指摘→修正済み）。内部取引控除は FY2026 のみのため脚注で明示。

**② 素データ取込と原単位の紐づけ。** CSV は
サプライヤーコード/品目/データ種別/数値/単位/排出係数コード（旧形式
「購買金額(千円)」も後方互換）。仕訳は規則ベース: 種別列 → 排出量列 →
単位（t-CO2e／千円・円・百万円／kWh・MWh・m3・L・kL・kg）の順で判定し、
換算（円→千円、MWh→kWh 等）は一度だけ適用。前置き行は detectHeaderRow で
読み飛ばし、合計・注記行は row-role で除外、独式数値・セミコロン区切り対応。
原単位の解決は 行の係数コード → **過去に確定した同じ社×品目×単位の学習** →
単位から一意 の順。複数候補（kg=鋼材/アルミ、千円=5 本）は
**プレビュー内セレクトで人が紐づけ**（選ぶまでチェック不可）。確定済みの
素データ行は取込画面の「排出量原単位の紐づけ状況」から再紐づけでき、
対象行だけ再計算した**新しい算定版を追記**する（単位不一致の行はスキップし
巻き添え不能化、対象行数と合算値を flash で報告。レビュー指摘→修正済み）。
このために CalculationInput へ activityAmount/activityUnit を追加
（inputs は JSONB のためスキーマ変更なし）。物理量ベース係数
EF-GAS-M3/EF-DIESEL-L/EF-STEEL-KG/EF-ALU-KG を追加。
同一サプライヤー×品目の重複行は確定前に拒否（ラベル規約・再紐づけの
識別子が壊れるため）。列役割の先勝ちは「役割が埋まっていたら次の規則を試す」
方式（仕入先コード＋仕入金額(千円)等の実在ヘッダー対応）。

**③ 30社デモと自動仕訳。** サプライヤーを SUP-01〜30 の 30 社へ拡張
（提出済み 13 社 = 金額5・物理量5・報告排出量3、一次データ合計 143.1 t-CO2e、
未提出 17 社）。エコバディス風英語 CSV・日本語手計算ワークシート
（前置き・合計・注記行付き）・独式セミコロン区切り素データ の 3 サンプルを
`fixtures/supplier-demo-files.ts` で決定論生成し、取込画面から配布
（/api/exports/supplier-demo-files）。e2e はサンプルと同一モジュールから
生成した内容をアップロードし、仕訳→紐づけ→確定→再紐づけを一巡検証。
テンプレート CSV は 6 列＋3 種別の記入例へ更新。

**その他**: Demo Cookie の持ち回しで「単体で 1 チャンクに入らない編集が
全チャンクを空で上書きし既存編集まで消す」不具合を修正（その編集だけ諦める。
ユニットテスト追加）。

**テスト**: unit +14（自動仕訳 12・ラベル 5 既存・Cookie 2）、
integration ghg-trend 3 / scope3-suppliers 17（3 種別・学習・再紐づけ・
重複拒否・権限）、e2e ghg-suppliers 5 件（可視化→テンプレート→旧形式→
素データ＋紐づけ→再紐づけ）、data-entry-aggregation・本番スモークを更新。
敵対的レビュー（5 観点→検証 22 agent）で 13 件確定→全対応
（e2e の strict-mode 違反 3 件は実行前に検出・修正）。

**結果**: 全ゲート通過（unit+integration 645 / RLS 101 / E2E 266 /
本番スモーク 29）。5198f8b を deploy → terrast-t4d.vercel.app へ
エイリアス済み。未解決なし。

---

## 2026-09-14 村田製作所向けデモ改善（信頼度80〜97%・20ファイル・係数選択・リセット）

9/15 の村田デモに向けた発注者指示（①デモ信頼度 80〜97%、②Scope3 Cat.1 の
架空購買データ 20 ファイル、⑤係数候補の選択→算定、⑥リセットと再現性、
⑦成果物、⑧実投入検証）への対応。

**① デモ信頼度（両取込共通）。** `src/lib/domain/demo-confidence.ts` 新設
（純粋・決定論。FNV-1a＋固定シード、3 区間折れ線で 90〜96% 中心・±0.02 ゆらぎ、
80〜97% にクランプ。欠損・NaN・範囲外は変換しない）。適用は
`src/lib/imports/demo-display.ts` の 1 か所（一般取込 `withDisplayConfidence`／
サプライヤー `withSupplierDisplayConfidence`／AI 実行記録 `displayRunConfidence`）。
**raw は保存値のまま・display はレンダ時計算でどこにも保存しない**ため、
デモ解除後に表示値が実測として復活する経路が構造的に無い。ゲートは
`getAppMode()==='demo'` のみ（ファイル名判定なし）。対象は正常解析行
（mapped/confirmed）だけで、要確認・エラー行は実測のまま。デモ画面には
`DemoSimulationNotice`（「表示スコアはシミュレーション」）を常設。
承認チェックや取込可否は従来どおり status / errors 判定で、表示値を読まない。

**② 20 ファイル（電子部品メーカー架空購買・Cat.1 cradle-to-gate）。**
生成器 `scripts/murata-dataset.ts`＋`scripts/generate-murata-dataset.ts`（決定論）。
SUP-31〜50 の 20 社 × 12 明細 = 240 明細、期間 2025-04〜2026-03、日英混在、
XLSX 14 / CSV 6（**指示の PDF 4 件は XLSX へ置換**。サプライヤー取込は規則
ベースの表解析で、PDF 表再構成は OCR 基盤新設＝禁止事項に当たるため。
総数と内容は維持、manifest・docs に理由を記載）。数量ベース（kg/g/m2/個）＋
金額ベース（円→千円換算の外注加工）＋製品 CFP（個数×サプライヤー固有係数）。
係数は DEMO-EF-* 23 本（fixtures へ追加。出所は「架空係数」明示で実在 DB 由来と
書かない）。ヒント表 `src/lib/domain/scope3-factor-hints.ts`（品目キーワード・
地域・境界・方式）。出力は `demo-data/murata-scope3-category1/`（upload=20 ファイル
のみ／reference=manifest・独立計算の正解・デモ係数・デモ為替・検証結果）と
`public/demo/murata-scope3-cat1-{upload,full}.zip`（suppliers 画面から配布導線）。

**⑤ 係数選択→算定。** 取込フォームを複数ファイル対応へ
（`files` name・action は旧 `file` も互換受理、25 ファイル上限）。プレビューは
ファイル別セクション＋全体サマリー（明細数・信頼度 min/avg/max・80〜97% 内割合）。
候補絞込みは「ヒント付き係数は品目キーワード一致時のみ候補、無ければ従来の
汎用係数へフォールバック」（旧 EF-STEEL/EF-ALU 2 候補挙動を保持）。推薦は
生産国一致 → 世界平均 → なし の決定論で、**単位不一致は候補にすら出さない**。
推薦付き候補行はセレクト初期選択＋既定チェック済み（240 行の手動選択は不要）、
変更するとクライアントで再計算。推薦なし行（汎用候補のみ）は選ぶまでチェック不可。
確定はサーバー側でマスター再照合（従来どおり）。実測スコアは決定論ルーブリック
`rowRawConfidence`（解決方法＋種別列・単位列・生産国の裏取り、単位換算 −0.07）。

**⑥ リセット。** `resetSupplierDemoData`（Demo Mode 専用・DemoDbClient 判定）。
削除範囲は「当組織×当期間の Scope3 Cat.1 に取込・再紐づけで積まれた算定版のみ」
（最古の Fixture 初期版・Data Point・承認履歴・他テーブルは保持）。
`DemoDbClient.hardDeleteDemoRows`（ID 名指しのみ・全消し経路なし）＋
`removeDemoEditsFor`（Cookie から該当 ID の持ち回りだけ除去。全 Cookie 消去はしない）。
画面は削除範囲明示＋確認チェック必須。二重投入は「既存の内訳を置き換え」表示＋
置き換え動作で二重計上しない（既存挙動を検証で確認）。

**検証（⑧）。** 詳細は `demo-data/murata-scope3-category1/reference/verification-results.md`。

- unit+integration **667/667**（村田 13 件含む・human-capital 回帰含む）、RLS 101、build ✓
- E2E 全件 **267 成功／1 失敗**（既存 spec の文言断言が新表示「単位から一意に
  決定」へ未追従。断言を更新して該当 spec 再実行 5/5。アプリ変更なし）
- 実ブラウザで 20 ファイル一括投入→候補選択→240 明細確定→リセット→再投入同値
  （`zz-murata-demo.spec.ts`、スクリーンショット `test-results/murata-demo/`）
- 算定は独立計算の正解と 240/240 一致（合計 6,617.2、確定後の一次データ合計 6,760.3）
- 表示信頼度の実測分布: 最小 84 / 平均 93.4 / 最大 97%、80 台 3 行・90〜96% 229 行・
  97% 8 行・全 240 行が 80〜97% 内・値 10 種
- 既知の制約: 240 行の算定版は Cookie 持ち回り上限を超えるため**同一インスタンス内
  でのみ表示**（known-limitations D-3。デモ台本に運用手順を記載）

**手順書**: `docs/murata-scope3-demo.md`（起動・デモモード・取得・3〜5 分台本・
リセット・別ブラウザ手順・既知の制約）。

**独立レビュー**: エージェントによる敵対的レビューで 8 件（Medium 3・Low 4・Info 1）
→ 7 件修正（validCount/needsMappingCount の重複集計、XLSX 解析警告の黙殺
→ fileNotes として表示、解析し直し時の選択状態持ち越し、AI 実行記録の下限ゲート、
80〜97% 帯表示のデモ限定、拡張子正規表現の共用、リセット監査ログの resourceType）、
1 件（共有インスタンスでのリセットの他閲覧者影響）は docs へ制約として明記。
表示信頼度の永続化・ファイル名判定・リセットの過剰削除・二重計上・認可漏れは
「該当なし」を確認済み。

**本番**: 59fbc64 を deploy → terrast-t4d.vercel.app へエイリアス。
本番スモーク **29/29**（村田導線チェックを追加済み）。実ブラウザでも本番の
取込画面（50 社・村田カード・リセットカード・ZIP 配信）を確認。
スクリーンショットは `docs/assets/murata-demo/`。未解決なし。

---

## 2026-09-15 デモ当日指示 4 点（DL・編集・メニュー3階層・低確信行の畳み込み）

村田デモ当日朝の発注者指示①〜④。

**① プレビューの元ファイル DL と各列の編集。**

- ファイル名クリック → 投入した元ファイルを DL。サーバーは解析結果しか持たないため、
  **ブラウザが保持している File を objectURL でそのまま返す**（supplier-upload-form の
  `uploadedFilesRef`）。実体が無い場合（別タブ等）はただの名前として出す。
- 数値・単位は入力欄、原単位は**解決済みの行もセレクト**にした（候補＝同じ単位の
  全原単位。サービス側で解決済み行にも factorCandidates を返す）。数値・係数の変更は
  クライアントで即再計算し、確定時はサーバーが従来どおり全行を再検証する
  （hidden 改ざんと同じ扱い。単位を変えて係数と食い違えば行名指しのエラー）。
- 正規化で出る浮動小数ノイズ（×0.001 の 18400.000000000004 等）は入力欄に出す前に丸める。

**② 投入ボックス下の文言差し替え**（指示どおりの文へ）。

**③ 左メニュー**: GHG 配下を「Scope3データ取込 → Cat.1」の 3 階層へ
（SSBJ と同じ構造。href は従来の /enterprise/ghg/suppliers のまま、画面名・
パンくずは変更なし）。nav-structure / ghg-suppliers / 本番スモークの断言を更新。
docs の導線表記も更新。

**④ 一般取込の低確信行（デモ）。**

- 変換対象を needs_review / duplicate へ拡張（表に残る行はすべて 80〜97% 帯）。
  状態バッジ・警告はそのまま（隠すのは % の見た目だけ）。
- **指標を特定できず・実測 < 0.55** の行は表示専用フラグ
  `demoHiddenLowConfidence` で「指標マスターと関係が無いため、取り込み対象外に
  しました」の折りたたみへ畳む（demo-display.ts に一元化。**保存された行の
  status・confidence は変更しない**ので、実運用モード・デモ解除後は従来どおり）。
- 最初は「確信度 < 0.55 は一律畳む」で実装したが、人的資本の定義ズレ行
  （指標は特定済み・0.42〜0.52）まで畳まれて **500 行の帳票が 53 行に見える**
  退行を E2E が検出。畳むのは「指標未特定」の行だけに絞り、指標が特定できた
  低確信行はバンド表示で残す形へ修正した（見出しの意味とも一致する）。

**敵対的レビュー（Workflow: 5 観点 42 エージェント）**: 指摘 37 件 → 反証審査で
21 件確定・16 件棄却。確定分の対応:

- **High: 再解析時の非制御状態持ち越し** — 同名ファイルを直して再ドロップすると、
  React が同一 key の DOM を再利用し、前回の単位手修正・チェック外しが**別の行へ**
  残る。単位を制御化し、解析世代カウンタを React key に混ぜて全行を作り直す形へ。
- **High: 確定エラーでプレビュー全消失** — 検証エラーが一覧へのリダイレクトだった
  ため手修正が全部消えていた。確定を useActionState 化し、エラーは画面内表示へ。
- **単位手修正が実質機能しない** — 確定側が文字列完全一致照合だったため、編集した
  単位は必ずエラーになっていた。確定時にも normalizeUnit で再正規化・換算する形へ
  （normalizeUnit は `domain/supplier-units.ts` へ切り出してフォームの再計算と共用。
  クライアント側も同じ規則で解釈し、解釈不能・係数不一致はその場で警告）。
- **数値解釈の非対称** — 確定側の Number+カンマ除去では欧州式 1.234,5 が桁違いで
  通る。クライアント・サーバーとも parseFlexibleNumber へ統一。
- **DL 実体の差し替わり** — ファイル選択のたびに DL 元 Map を差し替えていたため、
  旧プレビューのファイル名から別実体が落ちる。解析結果に対応した時点の実体を
  別 state（analyzedFiles）に確定する 2 段構えへ。
- **240 行×係数セレクトの再レンダー** — 1 キーストロークで全行再描画していた。
  行を React.memo 化し、編集した行だけ再レンダーする形へ。
- **④が AI 未評価行（500 行上限の超過・confidence 0）まで畳む** — 「マスターと
  無関係」ではなく未評価なだけで、畳むと手動マッピング経路ごと消える。
  confidence 0 は畳まず、バンドにも写さず実測のまま出す（嘘の 80% を作らない）。
- **畳んだ行が確定 POST から漏れて要確認のまま残留** — 折りたたみ側にも
  rowId hidden を出し、確定時は従来どおり「未選択＝除外」へ倒す。表示行 0 件の
  確定ボタンは無効化。
- そのほか: AI 実行記録の実測確信度に説明 hint、親子同一 href（SSBJ・Scope3）で
  aria-current が 2 つ並ぶ問題を sidebar 側で修正、Command Palette へ旧名
  「サプライヤーデータ取込」の検索語を残す、docs の BOM 混入除去、コメントの
  不変条件の誤り訂正、単位手修正・解決済み行候補の integration テスト追加。

## 2026-09-29 開示優先モード W1-F1（スキーマ基盤・型・純粋関数）

設計の正本は `docs/disclosure-first.md` §3・§4。この段階は保存層と型までで、画面・Service は未着手。

**変更**

- migration 0033〜0040 を追加（既存ファイルは書き換えていない）。17 表を新設し、全表で RLS 有効・ポリシーあり。
  - 子の `organization_id` は親と複合外部キーで一致させる（0021/0022 方式。既存表へは `(id, organization_id)` の一意制約だけを追加）。
    節・依頼・コメントが指す版は「同じ節の版」に限る（`(版 ID, 節 ID)` の複合外部キー）。
  - 追記専用 9 表（判断・定性情報の版・引用位置・本文の版・レビュー記録・再確認・スナップショット・出力記録・KPI 目標）は
    UPDATE/DELETE ポリシーなし＋`t4d.forbid_mutation()`。
  - 職務分離トリガ `t4d.enforce_review_event`（`T4D_SOD` / `T4D_RETURN_REASON_REQUIRED` / `T4D_REVIEW_TARGET_MISMATCH`）。
    §3 の approved・returned に加え、§2 のレビュー完了（依頼者・版作成者は不可）も DB で強制する。
    依頼の依頼者・対象版を後からすり替えてトリガを回避できないよう `review_request_guard` で固定。
  - 承認権限だけの人（approver ロール）が節の本文・担当を書き換えられないよう `enforce_disclosure_block_update`。
  - 0039 の backfill は UPDATE ではなく `ALTER COLUMN ... TYPE ... USING` で行い、追記専用トリガを外さず、
    data_points の更新日時も動かさない。値も文字もない行だけ `not_entered`（`not_applicable` にはしない）。
- `src/types/domain.ts`: 新表の型・enum 配列 15 種ほか、DataPoint / DataPointVersion / FileObject /
  DisclosureFrameworkVersion の新列、FrameworkKey に `esrs_40a`、AUDIT_EVENT_TYPES に 17 種。
- 登録簿: TableMap / SQL_TABLE_NAMES / SEED_ORDER / FixtureDb / PERSISTED_TABLES（小さい 12 表のみ。版・スナップショット等は D-3 扱い）。
  seed 生成の jsonb 判定を表別にした（`body` が表によって text と jsonb になるため）。`ssbj_disclosure_drafts.gaps` の登録漏れも同時に修正。
- 純粋関数: `src/lib/clock.ts`（基準日。呼び出し側の置き換えは未実施）、`src/lib/domain/disclosure-block.ts`（AST・参照収集・内容ハッシュ・
  手書き数値・段落/文字差分）、`src/lib/domain/disclosure-status.ts`（ラベル・遷移表・職務分離・阻害条件・値の有無）。
- 既存 Service の DataPoint 生成箇所へ新列の既定値（取込・前年複製・値更新）。値更新は値の有無を `availabilityAfterValueChange` で追従。

**テスト結果**（2026-09-29、ローカル）: lint / format:check / typecheck 合格、`pnpm test` 739 件（66 ファイル）合格、
`pnpm test:rls` 227 件（2 ファイル）合格、`pnpm check:rls` 100 表 / ポリシー 228 件で合格。E2E・build は本段階では未実行。

**未解決・次作業**

- Fixture（§7 のデモ企業・プロジェクト・節・資料）は未投入。新表は seed 上 0 行。
- `FIXTURE_TODAY` の直接参照の `getReferenceDate()` への置き換え（別担当）。
- Service / 画面 / AI Use Case（`disclosureBlockDraft`）は未実装。RLS は §2 の権限キーに合わせてあるため、
  Service 側も `enterprise.disclosure.write/approve`・`export.run`・`metric.manage`（KPI 目標）・`import.run`（取込バッチ）で判定すること。
- `docs/disclosure-first.md` は prettier の整形（空行・表・コードブロック）だけを当てた（内容の変更なし）。

## 2026-09-29 開示優先モード W1-F2（デモ Fixture）

設計の正本は `docs/disclosure-first.md` §7（実装メモを同節に追記）。すべて架空。実在企業名は含めない（テストで検査）。

**変更**

- `src/lib/fixtures/disclosure-first.ts`（新規）: 主役の架空企業（青海テクノロジー）に次を投入。ID は `DISCLOSURE_FIRST_IDS` で公開（E2E から同じ値で引ける）。
  - 機能設定 1 行（`disclosure_first=false`。蒼天には行を作らない）。
  - 基準の版メタデータ: SSBJ（`ssbj-2026-03-13`・adopted・partial・133 項目）、既存 CSRD（sample・12 項目）、
    ESRS-40a を別フレームワークとして追加（公開草案・draft・not_loaded・impact。要求事項は 0 件）。
  - 根拠資料 3 点（有報抜粋＝過年度の記載、委員会資料・リスク評価資料＝当年度の根拠）と段落単位の抽出結果、引用位置 9 件。
  - 定性情報 5 件（ガバナンスは FY2025→FY2026 の 2 版で確認済み、他は下書き。財務的影響は金額キーを持たず理由を持つ）。
  - プロジェクト 2 件（FY2025 完了・FY2026 進行中）、適用判断（SSBJ は確定、ESRS-40a は判断なしの適用候補）。
  - 節 6 件: FY2026 のガバナンス（承認済み）・リスク機会（下書き）・指標（承認済みだが引用した Scope1 に新版＝再確認が必要）・
    ESRS-40a 準備のガバナンス（同じ定性情報の版を再利用・下書き）、FY2025 のガバナンス・指標（承認済み）。
    承認済みの節はレビュー依頼と記録 3 件（海野→検見川→承）を持つ。KPI 目標 2 件（Scope2 は境界が実績と違う）。
- 本社 Scope1（FY2026）に訂正版 v2 を追加（**値は同じ**・変更理由「集計範囲の訂正（架空）」・再承認済み）。
  値と承認状態を保ち、SNAP-1 より前に置いたので、GHG 集計・Data Room・Snapshot 後変更 2 件・検証結果は従来どおり。
  ダッシュボードの「最近の更新」には v2 の行が 1 件増える。
- `src/lib/fixtures/disclosure-documents.ts`（新規）: 資料の本文と ID・Storage Key。`DemoStorageAdapter.get` がメモリに実体の無いとき
  ここから本文（UTF-8・BOM 付き）を返す（`src/lib/storage/index.ts`）。他の Fixture ファイルは従来どおり実体なし（D-2 を更新）。
- `src/lib/domain/narrative-template.ts`（新規）: 定性情報のテーマ別テンプレート項目と未記入・未知キーの判定。
- 有報抜粋は「最新の有価証券報告書」自動選択（securities-report.ts）に拾われないよう、全文 PDF より前に登録した日付にしてある。
- `tests/rls/tenant-isolation.test.ts`: 機能設定は組織ごとに一意のため、INSERT をやめ Fixture の行を使うよう変更（期待値は変えていない）。
  Fixture の行が制約・職務分離トリガを通って投入されることの検査を 1 件追加。
- `supabase/seed.sql` 再生成（1648 行）。

**テスト結果**（2026-09-29、ローカル）: lint / format:check / typecheck 合格、`pnpm test` 764 件（67 ファイル）合格
（新規 `tests/integration/disclosure-first-fixtures.test.ts` 25 件）、`pnpm test:rls` 228 件（2 ファイル）合格、
`pnpm check:rls` 100 表 / ポリシー 228 件で合格。E2E・build は本段階では未実行（別段階で実施）。

**未解決・次作業**

- E2E（既存 spec）は未実行。影響しうる点: 証憑一覧の先頭に架空資料 3 件が並ぶ（既存 spec は名前で行を選んでいる）、
  ダッシュボードの「最近の更新」に Scope1 v2 が出る、本社 Scope1 の履歴が 2 版になる。
- 監査ログの行は作っていない（必要なら件数を見ている spec と調整のうえで追加）。
- 画面・Service は未実装。定性情報の画面はテンプレート項目を `narrative-template.ts` から引くこと。

## 2026-09-29 開示優先モード W2 統合（6 作業単位の結合）

W2 の 6 作業単位（S-a 表示不具合 O1〜O7・S-b メニュー/ホーム/役割切替/リセット・S-c プロジェクト/定性情報/資料・
S-d 原稿編集/レビュー/再確認/AI 下書き・S-e スナップショット/出力/ESG経営・S-f 標準 CSV 取込）を同じ作業ツリーで結合した。
各単位の詳細・判断・未解決は各単位の報告（W2 レポート）にある。ここには結合で直した点だけを書く。

**変更（結合で直したもの）**

- 基準日: `workflows/page.tsx` が `src/lib/clock.ts` 経由になったため `tests/unit/reference-date-usage.test.ts` の除外を削除。
  従来ホームは `loadEnterpriseDashboard` に同じ `today` を渡す（件数と「あと N 日」を同じ日で判定）。
  `src/` で `FIXTURE_TODAY` を import するのは config.ts・clock.ts・Fixture だけ。
- 従来ホーム: 「SSBJ 未対応」のリンクに `scope=in_scope` を付けた（件数は評価対象だけを数えている）。
  承認済み・要再確認が 1 件以上あるときだけ注意帯を出す（Fixture では 0 件なので表示は従来どおり）。
- `/api/exports/ssbj-requirements` が `scope` を受け取る（無いと CSV に対象外の行が入っていた）。CSV の「データとの紐づけ」は一部だけ値がある項目を「一部」と出す。
- CDP/CSRD 質問詳細（`question-view.tsx`）: 複数指標の項目（ESRS E1-6）は指標ごとの当年・前年を表で出し、
  Data Mapping に指標ごとの値と DataCoverageBadge を出す（以前は全指標に同じ値を繰り返していた）。値が無い指標は「値なし」。
- `evidence-documents.ts` に架空の `safety-record`（労働災害記録）の紙面を追加。拠点別の度数率が Fixture の LTIFR と一致する（単体テストで検査）。
- 指標マスターで証跡必須を false→true にしたら、締めていない期間の検証を再計算（`master-data.ts`、`enterprise.data.write` があるとき）。
- AI 画面の機能名に `disclosureBlockDraft` = 「開示本文の下書き」。未使用の `uploadEvidenceAction` を削除（docs/api-contract.md も更新）。
- 表記: `REPORT_SNAPSHOT_KIND_LABELS.approved` を「社内承認済み版」に変更し、`SNAPSHOT_KIND_DISPLAY` と出力（DOCX/XLSX）は
  このラベルを使う。出力と出力タブに「ファイル作成は提出ではありません」を明記。保証済み・提出済み・確定の語を使わないことを単体テストで検査。
- 再確認の判断: 原稿画面（disclosure-recheck.ts）とレポート確定（report-snapshot.ts）の規則が違っていた
  （確定側は判断した時点の節の版に縛り、後の差戻しも無視していた）。`domain/disclosure-block.ts` の
  `latestRecheckDecision` / `isOldRefKept` に 1 本化した（節単位・組み合わせごとに最後の判断が有効）。開示ホームも同じ規則を使う
  （以前は維持と判断しても「承認後に変更」「再確認する」に残っていた）。
- ホームのカードとクリック先の原稿一覧の件数を揃えた（指示書 §6.1）。「未解決の必須情報」→ `filter=unresolved`、
  「承認後に変更が発生」→ `filter=changed_after_approval`（原稿一覧に絞り込みを 2 つ追加。判定は `domain/disclosure-status.ts` の
  `hasUnresolvedRequiredInfo` / `isChangedAfterApproval` を両方が使う）。以前は「本文なし」「再確認が必要」へ飛び、
  Fixture でカード 1 件・一覧 0 件になっていた。一覧は定性情報の未記入も理由として表示する。
  `unresolvedNarrativeFields` は `domain/narrative-template.ts` へ移した（ホームは再公開）。
- Demo の Cookie: `disclosureBlockDraft` の実行は列を削らずに持ち回す（候補と `input_reference_ids` の両方が別インスタンスでの採用に要る）。
  実測: 根拠 3 件で生 JSON 約 4.4KB → Cookie 上 約 2.2KB、根拠 9 件で 約 11.7KB → 約 3.5KB。known-limitations D-3 と demo-client.ts に記載。
- `supabase/seed.sql` 再生成（1660 行。S-a の Fixture 変更と労働災害記録の紙面を反映）。

**意図した期待値の変更**: `tests/integration/disclosure-home.test.ts` のカードの遷移先（`filter=missing` → `unresolved`、
`filter=recheck` → `changed_after_approval`）。`reference-date-usage.test.ts` の除外リスト削除。

**追加したテスト**: SSBJ 要求事項 CSV の Route（scope）、労働災害記録の紙面、証跡必須化の再計算、再確認の規則（単体 6 件）、
維持→確定可・採用→再承認まで確定不可・節の版を作り直しても維持が有効・維持の後の差戻し（結合 4 件）、カードと一覧の件数一致、
維持後のホーム、Cookie 経由で別インスタンスから候補を採用、出力の注意書き、スナップショット種別の表記。
Route の 2 件・再確認の規則の結合 2 件・証跡必須化の再計算 1 件は、修正前の実装に戻すと落ちることを確認した。

**テスト結果**（2026-09-29、ローカル）: `pnpm lint` 合格、`pnpm format:check` 合格、`pnpm typecheck` 合格、
`pnpm test` 93 ファイル・1081 件合格、`pnpm test:rls` 2 ファイル・228 件合格、`pnpm check:rls` 100 表・ポリシー 228 件で合格、
`pnpm build` 合格。**E2E は未実行**（この段階の指示）。画面はブラウザで確認していない。

**未解決・次作業**

- E2E と画面の目視確認（1366px のヘッダー、原稿編集の 3 ペイン、出力タブ、標準 CSV 取込、ESG経営）。S-a の変更でホームの件数
  （Validation Error 8→3、Evidence 不足 11→1、アラート 4 件）・CSRD・SSBJ 気候-47(3) の表示が変わっている。
- ホームは未採用の AI 候補を数えない（0 のまま）。AI 下書きの Service に節ごとの件数を返す関数が無いため。阻害条件としては原稿画面・レビュー依頼で効く。
- 財務的影響の「算定方法・前提」: ホームと原稿一覧は影響額が無ければ未記入のまま数え、スナップショットの不足情報（report-snapshot.ts の
  narrativeGaps）は理由があれば外す。件数には影響しない（影響額が未記入なのでどちらも不足扱い）が、表示が揃っていない。
- `NARRATIVE_DETAIL_FIELDS` は narrative.ts のまま（`unknownTemplateKeys` は実行経路で使われておらず、詳細項目を誤検出しない）。
- 証跡必須化の再計算は締めた期間（closed）を対象外にした。締めた期間の承認済み行は次にその期間を再計算するまで要再確認にならない。
- 定量 CSV（スナップショットの数値）には注意書きを入れていない（機械可読のデータのため）。DOCX・XLSX・画面には入れた。
- `/enterprise/disclosures/ssbj/requirements/[itemId]` はヘッダーの選択期間で開くため、FY2025 プロジェクトからのリンクで FY2026 の評価が出る（S-c の報告）。
- docs/disclosure-first.md の「実施結果」と、各単位が挙げた既知の制約（Supabase の非トランザクション書込み、A26 の最善努力、
  AI の取消なし、スナップショット・取込バッチはインスタンスメモリ、2MB/2000 行の上限など）の known-limitations への記載は未了。

## 2026-09-29 開示優先モード E2E（D0 デモの一連の操作）と全件回帰

指示書 §15 の P1 E2E を D0 デモ向けに組み替え、同じプロジェクト（FY2026）の上で最後まで通す E2E を追加した。
AI 下書きは MockAIProvider（決定論的）での動作確認であり、本番モデルの試験ではない。

**追加した E2E**

- `tests/e2e/zz-disclosure-project.spec.ts`（serial・8 テスト。共有状態を変えるので zz-）:
  管理者が開示優先モードを ON（A01: 新メニュー・ホーム 4 カード・自分の作業・分母付き進捗）→
  海野が標準 CSV（訂正行 1 行）を検証 → 差分確認 → 確定、同じ内容を名前を変えて再検証すると「変更なし」（A03）、
  台帳に新しい版と変更理由・旧版が残る（A04）→ 提出し、承認の道筋 5 段階を役割切替で承認（数値確認）→
  定性情報を新規登録し、委員会資料の段落の一部を引用位置として登録・人が確認 →
  ホーム → FY2026 プロジェクト → 原稿 → リスク及び機会で、数値参照（取り込んで承認した版）と定性情報の引用を挿入、
  AI「選択した根拠から下書き」（Mock）の 1 段落を採用して残りは確認を終える → 版 2 → レビュー依頼 →
  ESRS-40a 準備の節も依頼、指標の節は再確認で「引用中の版を維持」（理由付き）→
  検見川が参考コメントを残し段落指定で差戻し → 海野が修正して版 3 → 再提出 → 検見川がレビュー完了 →
  海野には最終承認ボタンが出ない → 承が最終承認（ESRS-40a 準備の節も）→ 承がレポート確定 →
  対外用 DOCX を `parseDocx` で読み、承認した本文・単位付きの数値（23,480.5 m3）があり社内コメントが無いこと、
  社内確認用には社内コメントがあることを確認 → 同じ CSV 経路で元データを訂正 → 原稿は「再確認が必要」
  （目次・参照の鮮度・再確認画面・原稿一覧の絞り込み）、承認済みスナップショットの DOCX は内容ハッシュも本文も不変 →
  開示デモのリセット → 開示優先モード OFF。途中で失敗しても `afterAll` でリセットと OFF を行う。
  DOCX の本文と訂正後の原稿のスクリーンショットは試験結果の添付に残す。
- `tests/e2e/disclosure-first-nav.spec.ts`（読み取りのみ・4 テスト）: OFF（既定）では従来メニュー・従来ホームのまま、
  新しい画面は URL で開け、Scope3 取込・データ取込・SSBJ ドラフトは従来メニューから同じ URL（A01・A39）。
  キーボードだけで 一覧 → プロジェクト → 原稿 → 根拠パネル（矢印キーでタブ切替）→ レビュー依頼 まで辿れ、
  フォーカスが見える（A37）。一覧・原稿一覧・原稿編集に axe の serious/critical 違反なし。
  1366×768 で本文・主 CTA・状態が画面内・横スクロールなし、1280px では根拠パネルがドロワーになり、
  閉じる・Esc で閉じてフォーカスが戻り編集できる（A38）。
- `tests/e2e/helpers.ts` に `switchDemoRole`（ヘッダーの役割切替）を追加。

**E2E で見つけて直した実装の不具合**

- 役割切替（デモ）のメニューが切替後も開いたまま残り、画面の他の部分が aria-hidden のまま操作できなかった
  （戻り先が同じ Layout のため閉じない。`onSelect` の `preventDefault` を外した）。`header-demo-role-switcher.tsx`
- 開示優先モードのホームの見出しで報告期間の日付が 2 回出ていた（期間名に日付が入っている）。
  期間名に開始日が含まれていれば重ねない。`dashboard/page.tsx`
- `parseDocx` を server-only の無い `src/lib/imports/docx-text.ts` へ移し、`parsers.ts` から再輸出
  （E2E の Node プロセスから同じ実装で出力 DOCX を読むため。挙動は変えていない）。

**W2 の意図した変更に合わせた期待値（2 件）**

- `tests/e2e/vertical-slices.spec.ts`「7. CDP の AI ドラフト…」: 回答の「承認」ボタンを `exact: true` で指定
  （ヘッダーの役割切替の名前「役割切替（デモ） 現在: 承 花子・最終承認者」も「承認」を含むため strict mode 違反になった）。
- `tests/e2e/import-drag-drop.spec.ts`「自由記述の .txt は根拠資料の画面で中身を読める」: 資料の画面に
  「引用できる箇所」（抽出した断片の一覧）が増え、同じ文言が 2 か所に出るようになった。プレビューの行を完全一致で
  確かめ、断片一覧に抽出が 1 件以上あることも確かめるよう変更。

**テスト結果**（2026-09-29、ローカル。E2E は `E2E_PORT=3217 pnpm test:e2e`、他の重い処理と並走させず単独実行）

- 新規 2 spec: 12 件合格（zz-disclosure-project 8・disclosure-first-nav 4）。修正後に単独で zz 2 回・nav 1 回、
  加えて全件の 2 回とも 12 件合格。
- 全件 1 回目: 253 合格・2 失敗・26 未実行（vertical-slices の serial が止まったため）・8.9 分。失敗は上の 2 件で、
  どちらも strict mode 違反（同じ名前・文言が 2 つ）という決定論的な原因。
- 全件 2 回目（修正後）: **281 件すべて合格・9.3 分**（`next build` を含む実時間 556 秒）。retries は 0 のため
  再試行で通ったもの（フレーク）は無い。
- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` 合格、`pnpm test` 93 ファイル・1081 件合格、
  `pnpm test:rls` 2 ファイル・228 件合格、`pnpm build` 合格。

**未解決・次作業**

- A38 の解釈: 1366px ちょうどでは 3 列（目次・本文・根拠）を並べる設計のため、右ペインを閉じる操作は無い。
  E2E は「1366px で本文と根拠が読める」「それより狭い幅（アプリの最小幅 1280px）ではドロワーを閉じて編集できる」
  として確かめた。1366px でも右ペインを閉じたいという要望なら、画面の変更が必要。
- レポート確定には引用した数値が承認済みである必要があるため、E2E は取り込んだ値を承認の道筋 5 段階で承認してから
  原稿へ挿入している。元データの訂正（数値の版）は開示デモのリセットの対象外で、欧州販売子会社の水使用量（FY2026）は
  E2E 後に訂正後の値のまま残る（後続の zz-human-capital-boundary・zz-murata-demo は影響を受けないことを全件で確認）。
- Mock の下書き候補は根拠の本文をそのまま使うため、同じ定性情報を引用した段落と採用した段落の本文が重なる
  （デモの見え方の問題。E2E では 1 段落の採用だけを確かめている）。
- Playwright の `page.request` は Secure 属性のセッション Cookie を http://127.0.0.1 へ送らないため、
  出力 API の再取得はブラウザ内の fetch で行っている。

## 2026-09-29 開示優先モード 自己監査の指摘 55 件への対応（単独の修正担当。UX-F8 は ORCH-1 と同じ）

6 観点（オーケストレーター・不変条件・セキュリティ・回帰の正直さ・UX/a11y・永続化/Supabase）の検証済み指摘を、
重い順に根本原因から直した。期待値は緩めていない。commit・push・deploy はしていない。

**スキーマ**: `supabase/migrations/0041_disclosure_review_integrity.sql`（列追加とトリガのみ・破壊的変更なし。
ロールバック方針は `docs/known-limitations.md` §6）。`domain.ts`・Fixture・`seed.sql`（`pnpm seed:generate`）を更新。

**指摘と結果**（fixed = 実装を直してテストを追加、skipped = 見送り）

| ID               | 内容                                                                                     | 結果                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ORCH-1 / UX-F8   | 1366px 以上でも根拠パネルを閉じられる（aria-expanded・Esc・フォーカス復帰）              | fixed（E2E A38 を 1366×768 で）                                               |
| ORCH-2           | Mock の下書きが引用の丸写し → 根拠の事実だけで短い段落を組み立てる（決定論的）           | fixed                                                                         |
| ORCH-3           | 財務的影響の「定量化しない理由」の扱いを 1 つの関数へ（ホーム・原稿一覧・確定前検査）    | fixed                                                                         |
| ORCH-4           | 要求事項タブの SSBJ リンクはプロジェクトの期間で開き、ヘッダーの期間と違えば注記         | fixed（E2E 追加）                                                             |
| INV-F1           | 推計・目標だけの承認行を実績 0 と表示しない                                              | fixed                                                                         |
| INV-F2 / F3      | 自動保存した人・レビュー未完了の最終承認を職務分離で止める（アプリと DB トリガ）         | fixed                                                                         |
| INV-F4           | GHG 3 年推移で値の無い年は「未入力」（0 の棒を描かない）                                 | fixed                                                                         |
| INV-F5 / F6      | 確定前検査に翻訳の欠落・古さ、承認後の範囲変更（scope_revision）を追加                   | fixed                                                                         |
| INV-F7           | 標準 CSV の target 行が同じキーの実績を置き換えない（エラー）                            | fixed                                                                         |
| INV-F8           | 他人の自動保存を黙って上書きしない（working の競合）                                     | fixed                                                                         |
| INV-F9           | 依頼が拒否されたら版を作らず自動保存も消さない                                           | fixed                                                                         |
| INV-F10          | 一部採用した AI 実行を再生成時に rejected にしない                                       | fixed                                                                         |
| INV-F11          | 目標との比較で算定方法の違いを見る                                                       | fixed                                                                         |
| SEC-F1〜F3       | レビューの段階飛ばし・担当の差し替え・記録なしの承認・偽のスナップショットを DB で拒否   | fixed（RLS テスト 7 件）                                                      |
| SEC-F4           | 自動保存本文の他テナント参照を拒否し、他組織の名称を出さない                             | fixed                                                                         |
| SEC-F5           | 対外 DOCX で非公開資料のファイル名を伏せる                                               | fixed                                                                         |
| SEC-F6 / F7      | 資料の断片は evidence.read、引用の利用先は disclosure.read を要求                        | fixed                                                                         |
| SEC-F8           | Cookie から戻す依頼・記録・承認を DB と同じ規則で検査                                    | fixed                                                                         |
| REG-F1           | 旧デプロイの Cookie の Data Point 行で画面が落ちない                                     | fixed                                                                         |
| REG-F2           | 従来の Evidence アップロードの拡張子・ファイル名を元に戻す                               | fixed                                                                         |
| REG-F3           | ホームの「適用確定済み」を対象外・重要性なしで水増ししない（概要タブと一致）             | fixed                                                                         |
| REG-F4           | SSBJ 2026 を「公表済み」に（採択済みの誤表記）                                           | fixed                                                                         |
| REG-F5           | OFF でも従来画面に開示用 Fixture の差が見える                                            | **skipped**（再確認の筋書きと SNAP-1 の整合のため。known-limitations に記載） |
| REG-F6           | SSBJ 133 項目を「全件」と言わない                                                        | fixed                                                                         |
| REG-F7           | OFF の組織の従来画面に開示優先 UI を出さない                                             | fixed                                                                         |
| UX-F2 / F3 / F9  | 未保存の本文を残して遷移しない、通信失敗で「保存中」「実行中」のまま止まらない           | fixed                                                                         |
| UX-F4〜F7        | 再確認・適用条件・資料からの候補・手入力の抜粋で、入力を消さずに理由を示す               | fixed                                                                         |
| UX-F10           | 通知していないのに「通知しました」と言わない                                             | fixed                                                                         |
| UX-F11           | 版の保存フォームを閉じたらフォーカスを戻す                                               | fixed                                                                         |
| UX-F12 / F13     | 内部キーを出さない、状態バッジにアイコンを付ける                                         | fixed                                                                         |
| UX-F14           | 標準 CSV の検証結果を読み上げ、結果の見出しへフォーカスを移す                            | fixed（E2E に追加）                                                           |
| UX-F15           | ESG 比較の差に単位を付け、単位違いは差を出さない                                         | fixed                                                                         |
| PER-F1           | 別インスタンスでの依頼は画面の本文から版を作る                                           | fixed                                                                         |
| PER-F2 / F10     | リセットを他インスタンスへ伝え、開示の通知も消す                                         | fixed                                                                         |
| PER-F3 / F7      | 機能設定を押し出さない、出力記録を Cookie に載せない、押し出しを表示                     | fixed                                                                         |
| PER-F4 / F8 / F9 | 版が無いインスタンスでは「版が見つからない」と示す（最新扱い・矛盾・改ざん扱いにしない） | fixed                                                                         |
| PER-F5           | 採用済みの AI 候補を閉じても rejected にしない                                           | fixed                                                                         |
| PER-F6           | 定性情報の版 ID を版番号だけで決めない                                                   | fixed                                                                         |
| PER-F11          | Supabase Mode で不正な ID は 500 ではなく「見つからない」                                | fixed                                                                         |

**追加・変更したテスト**: `tests/integration/self-audit-review-integrity.test.ts`（20）・`self-audit-values.test.ts`（7）・
`self-audit-demo-persistence.test.ts`（8）・`tests/unit/self-audit-ui.test.tsx`（6）・`tests/rls/tenant-isolation.test.ts`（0041 の 7）、
既存の AI 下書き・ホーム・原稿・確定前検査・KPI・Fixture・Cookie のテストと E2E 2 spec に追記。

**テスト結果**（2026-09-29 ローカル。E2E は `E2E_PORT=3217`、単独実行）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm build` 合格。`pnpm check:rls` 100 テーブル・228 ポリシーで合格。
- `pnpm test` 97 ファイル・1124 件合格、`pnpm test:rls` 2 ファイル・236 件合格。
- E2E: 関連 17 spec・107 件合格（2.2 分）。その後の UX-F14 の変更後に disclosure-first-nav・zz-disclosure-project の 13 件合格。
  途中の失敗 1 件は新しく書いた ORCH-4 の E2E の期待値の誤り（期間名は「FY2025」でなく「2025年度」）で、同じ厳しさの文言へ直した。

**未解決・次作業**

- リセットの印は組織ごとに最新 1 件だけ。対外 DOCX で伏せるファイル名は出力時点の資料一覧から取る。
- 旧 `decideRecheckAction` / `addManualExcerptAction` はフォーム版へ移した後も互換のため残している。
- ORCH-4 の E2E は FY2025 の SSBJ 評価行をデモのメモリに作る（再起動で消える）。
- Cookie でレビューの記録が押し出された後の依頼・承認は、別インスタンスでは規則を満たせず適用されない。

## 2026-09-29 開示優先モード 自己監査 第 2 回の指摘 38 件への対応（単独の修正担当）

4 観点（不変条件・セキュリティ・回帰の正直さ・UX/a11y・永続化）の検証済み指摘を、重い順に根本原因から直した。
ID が観点ごとに重なる（F1〜F6 が 3 組）ため、下表では観点を添える。期待値は緩めていない
（前回の修正で逆転させた財務的影響の 3 件のテストは、元の厳しい期待値へ戻した）。commit・push・deploy はしていない。

**スキーマ**: `supabase/migrations/0042_disclosure_review_designation.sql`（列 1 つの追加とトリガ関数の追加・差し替えのみ。
ロールバック方針は `docs/known-limitations.md` §6「0042 のロールバック」）。`domain.ts` に `RecheckDecision.newRefApproved`。
新しい表は無い（`table-names.ts` の変更なし）。`pnpm seed:generate` は差分なし。

| ID                               | 内容                                                                                                                                                       | 結果                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| INV-1                            | 新版が未承認のときの「維持」は、新版の承認で無効（`recheck_decisions.new_ref_approved` を DB が INSERT 時に計算。原稿・ホーム・確定が同じ `isOldRefKept`） | fixed                                    |
| INV-2                            | 版を追記するとき、土台の版と節の現在の版の作成者・書いた人を引き継ぐ（`inheritedContributors`・DB トリガも同じ）                                           | fixed                                    |
| INV-3 / F1（セキュリティ）       | DB: 記録は指名したレビュー担当・最終承認者だけ・依頼の状態に合うときだけ。節の承認・確定版は「承認で終わった依頼」の版だけ。Demo の Cookie も同じ規則      | fixed（RLS テスト追加）                  |
| INV-4                            | 依頼・承認の後に適用判断を確定し直したら、最終承認と確定を止める（`applicability_changed`）                                                                | fixed                                    |
| INV-5                            | 推計・目標の数値は本文・AI 下書き・DOCX で区分を添える。目標は AI の当年度の根拠から外す。確定前検査に注意（止めない）                                     | fixed                                    |
| INV-6                            | 持分法・対象外の拠点の値だけの年度の連結値は 0 でなく「未入力」（`consolidatedValueCount`）                                                                | fixed                                    |
| INV-7                            | Cookie から数値の版・適用判断の既存行を書き換えさせない（追記専用）                                                                                        | fixed                                    |
| F2（セキュリティ）               | 範囲の改訂番号は DB が決める（下げられない）。利用者の依頼は「レビュー待ち」でだけ作れ、改訂番号は DB が写す。範囲変更後の承認・確定を DB でも拒否         | fixed（RLS テスト追加）                  |
| F3（セキュリティ）/ F2（永続化） | リセットの印はログイン後、印の組織で開示の編集権限を持つ利用者のときだけ反映（`applyPendingDemoResetFor`）                                                 | fixed                                    |
| F4（セキュリティ）/ F1（永続化） | リセットの世代を「時刻-乱数」にし、反映済みより新しい印だけを反映（戻し合いをしない）                                                                      | fixed                                    |
| F5（セキュリティ）               | 自動保存・AI 採用で、別組織の行と存在しない行を同じ結果・同じ文言で断る（新しく入れた参照だけ）。AI 実行も同じ文言                                         | fixed                                    |
| F6（セキュリティ）               | Content-Disposition で引用符・バックスラッシュを無害化し、filename* を RFC 5987 の文字だけにする。資料名の `"` は全角へ                                    | fixed                                    |
| F1（回帰）                       | 財務的影響は理由があっても影響額が無ければ不足情報（§6.6・§8.3）。理由は横に示す                                                                           | fixed（逆転したテスト 3 件を元に戻した） |
| F2（回帰）/ F4（永続化）         | 押し出しの知らせは表の名前を持ち、リセット・ログアウトで消える。取込の行どうしでは知らせない                                                               | fixed                                    |
| F3（回帰）                       | SSBJ の「全要求事項」の説明を、設定で適用する基準の件数とマスターの収録件数に分けて示す                                                                    | fixed                                    |
| F4（回帰）                       | 開示のレビューの通知を本文なしで Cookie に載せ、別インスタンスでも届く                                                                                     | fixed                                    |
| F5（回帰）                       | ホームの進捗表・DOCX の表紙も「公開草案に基づく準備」（`frameworkLegalLabel` に 1 本化）                                                                   | fixed                                    |
| F6（回帰）                       | OFF の組織の Evidence 画面は拡張前の入力項目・列（スキャン・Bucket）。定性情報の入口を出さない                                                             | fixed（E2E に追加）                      |
| UX-01                            | コメントの送信・解決が通信で失敗してもボタンを戻し、理由を示す                                                                                             | fixed                                    |
| UX-02                            | タスク・承認の状態・対象を日本語のラベル＋アイコンで                                                                                                       | fixed                                    |
| UX-03                            | 見えないフォーカスリング（brand-100 / brand-300）を brand-600 へ。E2E の判定にコントラスト 3:1 を追加                                                      | fixed                                    |
| UX-04                            | 節を追加・適用判断を確定のフォームは、断られても入力を残す。節のキーに pattern                                                                             | fixed                                    |
| UX-05                            | 資料の登録・レビューの操作に送信中の表示（二度押し防止）。登録が断られてもメタデータを残す                                                                 | fixed                                    |
| UX-06                            | 再確認の画面で根拠失効の次にすることと、段落へのリンクを示す                                                                                               | fixed                                    |
| UX-07                            | 1366px 以上の根拠パネルの高さをスクロール領域と状態の帯に合わせる                                                                                          | fixed                                    |
| UX-08                            | 原稿の本文を `<main>` の入れ子から `<section aria-label="本文">` へ（axe の landmark 規則を E2E に追加）                                                   | fixed                                    |
| UX-09                            | 開示優先モードの画面のバッジにアイコン（静的検査のテストを追加）                                                                                           | fixed                                    |
| UX-10                            | タブ・目次のリンクに「読込中」の表示（`useLinkStatus`。loading.tsx は S-11 のため置かない）                                                                | fixed                                    |
| UX-11                            | 資料の画面の MIME 型・Version・Evidence の表記を日本語へ                                                                                                   | fixed                                    |
| UX-12                            | 原稿・レビュー・定性情報・タスクの表の列見出しを固定                                                                                                       | fixed                                    |
| UX-13                            | useActionState のフォームを通信失敗で壊さない（`withNetworkFallback`。プロジェクト・KPI 目標のフォームにも）                                               | fixed                                    |
| F3（永続化）                     | Cookie のチャンクを first-fit で詰める（実演の流れで取込の数値を押し出さない）                                                                             | fixed                                    |
| F5（永続化）                     | 依頼が押し出された「レビュー依頼中」の節は、状態だけ下書きへ戻して他の変更は戻す                                                                           | fixed                                    |
| F6（永続化）                     | リセットで、受け付けなかった開示の編集（孤立した記録）も Cookie から取り除く                                                                               | fixed                                    |

**追加・変更したテスト**: `tests/integration/self-audit-2-integrity.test.ts`（12）・`self-audit-2-demo-persistence.test.ts`（18。
`next/headers` を差し替えて実際の Cookie の容量・押し出し・リセットの印を確かめる。実演の流れの再生を含む）・
`tests/unit/self-audit-2-ui.test.tsx`（10）・`tests/unit/recheck-decision.test.ts`（4 追加）・`exports-and-format.test.ts`（1 追加）・
`ssbj-settings.test.ts`（1 追加）・`tests/rls/tenant-isolation.test.ts`（0042 の 9 件）。
既存の RLS テストのうち 0042 の状態の検査に当たる 5 件は、アプリと同じ順（記録 → 依頼の状態を進める）へ前提を直した
（期待するエラー・結果は変えていない。冪等キーの検査は Service Role で一意制約を確かめ、利用者は状態の検査で止まることも確かめる）。
E2E: `disclosure-first-nav`（フォーカスのコントラスト・landmark・OFF の Evidence 画面）・`zz-disclosure-project` /
`mentions-evidence`（本文の領域の role・資料の画面の表記の変更に追従）。

**テスト結果**（2026-09-29 ローカル。E2E は `E2E_PORT=3217`、ほかの重い処理と並走させず単独実行）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm build` 合格。`pnpm check:rls` 100 テーブル・228 ポリシーで合格。
- `pnpm test` 100 ファイル・1170 件合格、`pnpm test:rls` 2 ファイル・245 件合格。
- E2E: まず `zz-disclosure-project`・`disclosure-first-nav` の 13 件を実行し、強めたフォーカスの判定で 1 件が落ちた。
  原因は `transition-colors` のボタンで枠の色が 150ms かけて白から青へ変わる途中を測っていたこと（実装の不具合ではない）。
  判定を「落ち着くまで最大 2 秒待ってから測る」に直し、同じ 5 件が合格。その後の全件: **282 件すべて合格・9.4 分**（retries 0）。

**未解決・次作業**

- UX-09 は開示優先モードの画面（開示プロジェクト・定性情報・資料の画面・タスク）に限った。従来画面（SSBJ・CDP・データなど）にも
  アイコンの無いバッジが約 80 件ある（`tests/unit/self-audit-2-ui.test.tsx` の静的検査を広げれば一覧できる）。
- 旧 `uploadEvidenceDocumentAction` / `createBlockAction` / `confirmApplicabilityAction` はフォーム版へ移した後も互換のため残している。
- リセットの印は、閲覧だけの利用者が先に届いたインスタンスでは反映しない（編集権限のある利用者のリクエストで反映する）。
- 0042 より前の「維持」の判断は、新しい版が承認済みなら無効として扱う（再判断が要る）。本番 Supabase には未適用。

## 2026-09-30 開示優先モード 自己監査 第 3 回の指摘 37 件への対応（単独の修正担当）

5 観点（不変条件・セキュリティ・回帰の正直さ・UX/a11y・永続化）の検証済み指摘を、重い順に根本原因から直した。
ID が観点ごとに重なる（F1〜F5 が 2 組）ため、下表では観点を添える。既存のテストの期待値は緩めていない
（前提の組み立てを新しい規則に合わせたものは下に列挙）。commit・push・deploy はしていない。
`docs/disclosure-first.md` と `tests/e2e-production/**` には触れていない（別の担当が編集中）。

**スキーマ**: `supabase/migrations/0043_disclosure_trigger_tenant_scope.sql`（0042 のトリガ関数 3 つの差し替えのみ。
ロールバック方針は `docs/known-limitations.md` §6「0043 のロールバック」）。表・列の追加は無く、`domain.ts`・`table-names.ts`
の変更なし。`pnpm seed:generate` は差分なし。スナップショットの jsonb に `scopeRevision`（基準ごと）と `maskedFileNames`
（節ごと）を足した（内容ハッシュに含まれる。以前のスナップショットは null として読む）。

| ID             | 内容                                                                                                                                                                                                       | 結果                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| F1（不変条件） | 適用判断を確定し直した後の承認済みの節は、本文を変えずに版を作って再承認できる（原稿の帯あり）。判断が無いまま承認した節は、最初の「適用・任意適用」の確定を変更に数えない（最終承認・確定も同じ）         | fixed                                                               |
| F2（不変条件） | 現在の版をそのまま依頼したら作業本文を消す。レビュー中・承認済みの節は作業本文を本文・鮮度・一覧に使わない（`workingBodyInEffect`）。作業本文にだけある引用の「採用」で内容の同じ版を作らない              | fixed                                                               |
| F3（不変条件） | 進行中の依頼への二重押下の近道は、同じ依頼者・同じ本文・同じ土台のときだけ。ほかは「あなたの本文は提出していません」と断る                                                                                 | fixed                                                               |
| F4（不変条件） | 翻訳元の修正の後、翻訳を変えずに版を作り直して再承認できる（`translationRecheckNeeded`。原稿の帯と確定前の検査が同じ比較）                                                                                 | fixed（「訳した元の版」の列は足さず、版の作成時刻で比べる）         |
| F5（不変条件） | 確定したスナップショットの後に報告範囲を変えたら「上流の更新」に `scope` を出す（固定した改訂番号と比べる）                                                                                                | fixed                                                               |
| F6（不変条件） | CDP・CSRD の AI 下書きは、値の無い行を 0 にせず、目標・推計・連結外（持分法・対象外）を実績に足さない（`sumValues`＋連結係数）                                                                             | fixed                                                               |
| F7（不変条件） | テンプレート版を `disclosure-report-v2` へ。描画の指紋を版と組で固定するテストを追加。対外用で伏せる資料名をスナップショットに固定（以前のスナップショットだけ出力時の一覧を使い、監査記録に出所を残す）   | fixed                                                               |
| SEC-2          | Cookie から Data Point の値・ポインタ・承認（承認の道筋の完了と承認権限）、基準の適用区分と判断を、画面の操作と同じ規則でだけ戻す。承認済みを名乗る新しい版を足させない                                    | fixed                                                               |
| SEC-3          | 資料の一覧・資料の画面・`/api/files/inline`・`/api/files/download`・署名付きリンクに `enterprise.evidence.read` を求める（登録だけの取引先の入力担当には中身を渡さない）                                   | fixed（アプリ層。RLS は組織の構成員の範囲のまま）                   |
| SEC-4          | 開示優先モードの切替は、更新者が組織の管理者のときだけ Cookie から戻す                                                                                                                                     | fixed                                                               |
| SEC-5          | 0043: 再確認の前提の計算は判断と同じ組織の版だけ。依頼の作成は権限を先に確かめ RLS と同じ例外に。判断の記録は同じ組織の依頼だけを見て、例外に状態を載せない                                                | fixed（RLS テスト 3 件）                                            |
| SEC-6          | ESG 経営の照合モード（組織のスナップショット一覧・照合）に `enterprise.disclosure.read` を求め、権限が無ければタブを出さない                                                                               | fixed                                                               |
| SEC-7          | リセットの印の時刻が現在より 5 分以上先なら反映しない                                                                                                                                                      | fixed（署名は置けないため未実施。known-limitations に記載）         |
| REG-1          | 押し出しの知らせを黙るのは同じ取込の行どうしだけ。取込ジョブ・別の操作による押し出しは知らせる                                                                                                             | fixed                                                               |
| REG-2          | OFF の組織の資料の画面は従来の題名・パンくず（Evidence / Evidence Viewer）で、利用目的・手動抜粋・引用の利用先・版と発行日を出さない（利用目的のある資料は除く）。一覧の抽出件数・手動抜粋の案内も ON だけ | fixed（UX-11 の日本語化と「引用できる箇所」の欄は残した。下の注記） |
| REG-3          | try の中でログインを確かめる Server Action は、`unstable_rethrow` で redirect を Next.js へ返す（資料・プロジェクト・原稿・定性情報・標準 CSV）                                                            | fixed                                                               |
| REG-4          | デモツアーの「全 133 要求事項」を収録件数の説明へ                                                                                                                                                          | fixed                                                               |
| REG-5          | `withNetworkFallback` は fetch の失敗（TypeError・オフライン）だけを通信の失敗と言い、ほかは「処理に失敗しました（サーバー側のエラー）」                                                                   | fixed                                                               |
| UX-R3-01       | プロジェクト情報・適用条件の保存に土台の更新時刻を持たせ、別の人の保存の後なら上書きせず競合（最新の値とあなたの入力、最新を読み込む・このまま上書き保存）                                                 | fixed                                                               |
| UX-R3-02       | 差戻し・取下げのフォームを useActionState にし、断られても理由と段落を残す                                                                                                                                 | fixed                                                               |
| UX-R3-03       | ヘッダーの中央の列ははみ出しを切り、プロジェクトの画面では期間の日付・「デモ」・年度違いの理由の文を 1600px 未満で読み上げだけに                                                                           | fixed（E2E で 1366・1440px の重なりと名前の幅を確認）               |
| UX-R3-04       | 関連数値の候補の指標名・組織・範囲を 1 行に取り、切り詰めない                                                                                                                                              | fixed                                                               |
| UX-R3-05       | 段落は内部の ID ではなく本文の中の位置（段落 N・見出し（段落 N））で呼ぶ（原稿・読み上げ・レビュー・根拠パネル・AI 候補）                                                                                  | fixed                                                               |
| UX-R3-06 / 10  | KPI 目標の保存の知らせは表示名で。表の基準値・目標値に単位を付けて右寄せ、カードの基準値にも単位                                                                                                           | fixed                                                               |
| UX-R3-07       | ウイルススキャンの状態をラベル＋アイコンで（`ScanStatusBadge`）                                                                                                                                            | fixed                                                               |
| UX-R3-08       | 狭い幅の根拠パネルはモーダルのダイアログ（`role=dialog`・`aria-modal`・Tab をドロワーの中で回す・背面は `inert`）                                                                                          | fixed（E2E に追加）                                                 |
| UX-R3-09       | 資料・プロジェクト一覧・KPI の内訳・出力の表の列見出しを固定                                                                                                                                               | fixed                                                               |
| UX-R3-11       | 作成の段階を移ったら、その段階の見出しへフォーカスを移す                                                                                                                                                   | fixed                                                               |
| UX-R3-12       | 役割切替に「切替中…」と、失敗の理由と再試行                                                                                                                                                                | fixed                                                               |
| UX-R3-13       | 検証の後の「もう一度検証する」を outline にし、主要な操作を「登録を確定」だけに                                                                                                                            | fixed                                                               |
| UX-R3-14       | 標準 CSV の列の約束で、値の有無の記号に意味を添える                                                                                                                                                        | fixed                                                               |
| UX-R3-15       | レビュー・承認タブの絞り込みで 0 件のときは「条件に合う依頼はありません」と絞り込みを外すリンク                                                                                                            | fixed                                                               |
| F1（永続化）   | 「依頼中」を持つインスタンスへ承認済み・最終段の差戻しだけが届いても、レビュー完了の記録があれば進める                                                                                                     | fixed                                                               |
| F2（永続化）   | リセットの基準時刻を `getDb` が Cookie の操作を適用する前に決める                                                                                                                                          | fixed                                                               |
| F3（永続化）   | Cookie を 3 チャンクに。確認を終えた AI 下書きの実行は候補の本文を省いて持ち回す。実演の 2〜7 手目で取込を押し出さないことをテストで確認                                                                   | fixed                                                               |
| F4（永続化）   | 開示デモのリセットに「数値データも初期値へ戻す」（任意。数値の入力権限も要る）。別インスタンスへは印で伝える                                                                                               | fixed（既定では従来どおり数値に触れない）                           |
| F5（永続化）   | 作成したスナップショットが一覧に無いときは「作成しました」と言わず作り直しを案内。出力で見つからなければ出力タブへ戻して理由を示す                                                                         | fixed                                                               |

**注記（REG-2 の範囲）**: 指摘は「従来の Version の表記に戻す」も挙げていたが、UX-11 で画面の MIME 型・Version・Evidence を
日本語にしたのは CLAUDE.md §2（日本語 UI）に沿った意図した変更のため、OFF の組織でも日本語の表記（版の履歴・形式名）を残した。
「引用できる箇所（抽出 N ／ 手動抜粋 N）」の欄も資料そのものの情報として両方で出す（取込からの資料の E2E がこれを確かめている）。
OFF の組織で出さないのは、開示優先の入力・連携（利用目的・版と発行日・手動抜粋の登録・引用の利用先）だけ。

**前提の組み立てを直した既存のテスト**（期待する結論は変えていない）:
`self-audit-2-demo-persistence`（INV-7: 承認済みを名乗る新しい版は拒否に。チャンクの詰め方の確認は COOKIE_CHUNKS に合わせて
組み立て直し、実演の流れの空振り確認は「1 チャンクに入らない」に。取込の行の押し出しは同じ取込の行で作る）、
`self-audit-demo-persistence`（REG-F1: 以前の列の無い Data Point は自分の版を指す組で作る）、
`report-snapshot-export`（テンプレート版 v2）、`self-audit-2-ui`（根拠パネルの段落名の props）。

**追加したテスト**: `tests/integration/self-audit-3-integrity.test.ts`（14）・`self-audit-3-demo-persistence.test.ts`（14）・
`self-audit-3-security.test.ts`（2）・`self-audit-3-actions.test.ts`（1）・`disclosure-snapshot-route.test.ts`（1 追加）、
`tests/unit/self-audit-3-ui.test.tsx`（14）・`self-audit-3-reviews-tab.test.tsx`（2）・`disclosure-report-template.test.ts`（2）、
`tests/rls/tenant-isolation.test.ts`（0043 の 3 件）、E2E `disclosure-first-nav`（ヘッダーの幅と重なり・ドロワーのフォーカス・
OFF の資料の画面）。新しいテストは HEAD（b3927cd）の実装で落ちることを別の作業ツリーで確かめた（HEAD でも通るのは
「判断が変わっていない承認済みの節は同じ本文で版を作らない」の 1 件だけで、これは既存の規則の確認）。

**テスト結果**（2026-09-30 ローカル。E2E は `E2E_PORT=3217`、ほかの重い処理と並走させず単独実行）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm build` 合格。`pnpm check:rls` 100 テーブル・228 ポリシーで合格。
- `pnpm test` 107 ファイル・1220 件合格、`pnpm test:rls` 2 ファイル・248 件合格。
- E2E: 全件 **282 件すべて合格・10.1 分**（retries 0。`zz-disclosure-project`・`disclosure-first-nav`・`mentions-evidence`・
  `import-drag-drop`・`evidence-link`・`vertical-slices`・`demo-tour` を含む）。

**未解決・次作業**

- 翻訳の要確認は版の作成時刻で比べる（「訳した元の版」を記録する列は足していない）。同じミリ秒に作った版は要確認にならない。
- リセットの印は署名していない（時刻の上限だけ）。数値データのリセットは Data Point の表全体（組織内）を戻す。
- 資料の閲覧権限はアプリ層で検査する（RLS の `files_select` などは組織の構成員の範囲のまま）。
- 固定前のスナップショット（`maskedFileNames` を持たない）の対外用 DOCX は、出力時の資料一覧で伏せる（監査記録に出所を残す）。
- 本番 Supabase には 0043 を未適用。

---

## 2026-09-30 本番 Demo Mode（Vercel）で別インスタンスに届いても実演の流れを続ける（単独の修正担当）

**発端**: 本番（https://terrast-t4d.vercel.app ・Vercel Fluid compute・Demo Mode・環境変数なし・DB なし）へ
`tests/e2e/zz-disclosure-project.spec.ts` を流したところ 2 手目で止まった。標準 CSV の「検証」と「登録を確定」が
別インスタンスに届き、検証結果（`quantitative_import_batches`）が最初のインスタンスのメモリにしか無く、確定が
「検証結果の有効期限が切れました」になった。インスタンスのメモリにだけある行（原稿の版・定性情報の版・引用位置・
スナップショット・取込バッチ・作業本文）と、別の関数（別の経路）で読むものすべてが同じ種類の失敗を起こしうる。
commit・push・deploy はしていない。`docs/disclosure-first.md` は編集していない。スキーマの変更なし（migration 追加なし）。

### 1. 最悪の場合の再現（すべてのリクエストが別インスタンス）

- `src/lib/repositories/demo-fresh-fixture.ts`: `T4D_DEMO_FRESH_FIXTURE_PER_REQUEST=1`（Demo Mode のみ・既定は無効・
  **Vercel には設定しない**）で、`getDb()` がリクエストごとに Fixture を作り直して Cookie の操作だけを適用する
  （リクエストのヘッダーの物で 1 リクエスト内は同じ Fixture。Server Action の後の描画も同じ。リダイレクト先は Next.js が
  別のリクエストとして取り直すため新しい Fixture）。未設定なら従来どおりプロセス共有の Fixture。
- `playwright.stateless.config.ts` ＋ `pnpm test:e2e:stateless`（既定ポート 3219・既存サーバーは再利用しない）:
  `disclosure-first-nav.spec.ts`・`editor-draft-restore.stateless.ts`・`zz-disclosure-project.spec.ts` を流す。
  ブラウザは実演の発表者と同じく 1 つの Cookie を最後まで持ち回す（`tests/e2e/helpers.ts` の `carryDemoState`。
  project の `metadata.carryDemoState` のときだけ。通常の E2E では何もしない）。テストごとに Cookie の大きさを記録し、
  押し出しが起きたら失敗にする。サーバーは書き込みごとに `[t4d.demo-edits] total=…` を出す（切替が有効なときだけ）。
- 初回実行で本番と同じ失敗（2 手目の確定が「有効期限切れ」）を再現してから直した。

### 2. 表ごとの対処（詳細は `docs/known-limitations.md` D-3「別インスタンスでも実演の流れを続ける」）

| 表                                      | 方式                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quantitative_import_batches`           | **状態を持たない確定＋サーバーでの検証し直し**。画面は検証した元の入力（ファイル・貼り付け・手入力）を確定のときに送り直し、バッチが無ければサーバーが同じ関数で検証し直す。ハッシュ（行＝既存値の現在の版と状態を含む＋**検証した人**）が確認したものと違えば競合（A05）。確定の控え（確定キー・書いた行）を Cookie に載せ、成功後の再送は二重に書かない |
| `disclosure_block_versions`             | Cookie（小さくした形）: 平文・参照・ハッシュ・出所を落とし、土台の版と同じ段落は番号だけ（差分）。戻すときに計算し直す                                                                                                                                                                                                                                    |
| `narrative_versions` / `source_anchors` | Cookie（小さくした形）: ハッシュ・空の列を落とす                                                                                                                                                                                                                                                                                                          |
| `report_snapshots`                      | Cookie に**目録**だけ。追記専用の行から写しを組み立て直し、内容ハッシュが作成時と一致するときだけ戻す（違えば「見つからない」）。組み立ての関数は作成時と共通（`src/lib/domain/report-snapshot-content.ts` へ移した）                                                                                                                                     |
| `export_artifacts`                      | Cookie（内容ハッシュはスナップショットから）。出力タブの再読込で出力記録を示すのに要る                                                                                                                                                                                                                                                                    |
| `approvals`（データの承認だけ）         | Cookie。訂正の後も、引用・固定した数値の版が承認済みだったことを別インスタンスで示す（スナップショットの検査に要る）                                                                                                                                                                                                                                      |
| `ai_runs`（原稿の AI 下書き）           | 従来どおり（確認を終えた実行は候補を省き、行ごとの最新の状態で縮む）                                                                                                                                                                                                                                                                                      |
| `working_body`（作業本文）              | 持ち回さない（従来どおり操作はすべて画面の本文と土台の版を送る）。画面を離れて戻ったときにサーバーに作業本文が無ければ、このタブの sessionStorage に控えた自動保存の本文を戻す（`block-editor.tsx`）                                                                                                                                                      |

- **Cookie の形式**: 上限（3 チャンク × 3,800B）は変えず、全部の編集を 1 本の JSON にして Brotli（品質 9）で圧縮し、
  上限ごとに切り分ける（目印 `3`）。以前の形式（`2`）も読む。同じ編集 47 件で 3 分割 11.2KB → 8.4KB。
- **偽の Cookie の拒否**（`demo-edit-codec.ts` の `acceptEdit`）: 追記専用（既存行を書き換えない）、組織の一致、作成者の権限
  （版・引用位置・定性情報は `enterprise.disclosure.write`、確定版は `approve`、出力は `export.run`、取込は `import.run`＋`data.write`、
  データの承認は `data.approve`＋承認の道筋の完了）、版番号の重複・土台の版、引用文が資料に実在するか、書いた人の引き継ぎ（0042）、
  スナップショットの承認の主張を追記専用の記録（最終承認で終わった依頼・承認の記録）で確認（0042 の verify_report_snapshot と同じ主張）。
  レビュー完了・最終承認の記録は、対象の版が戻るまで受け付けない（以前は版が無いと作成者の検査を飛ばしていた）。
- 画面の文言（デモの説明）を実態に合わせた（原稿・出力タブ・ESG・標準 CSV・定性情報・出力の 404 の案内）。

### 3. 実測（最悪の場合の E2E、Cookie の大きさ）

手順ごとの操作の記録: A01 224B → CSV・承認 2,135B → 定性情報 2,913B → 原稿・依頼 5,771B → 差戻し・承認 6,668B →
確定・DOCX 8,269B → 訂正・再確認 **8,640B（最大。上限 3 × 3,800B = 11,400B の 76%）**。Cookie ヘッダー全体の最大 **8,788B**。
押し出しなし。Service の層の同じ流れ（`stateless-demo-chain.test.ts`）は最大 8,647B。

### 4. テスト

- 追加: `tests/unit/demo-compact.test.ts`（19。表ごとの往復と偽の Cookie の拒否）、
  `tests/integration/stateless-demo-chain.test.ts`（4。手順ごとに Fixture を作り直す実演の流れ・競合・別の人・改ざん）、
  E2E `tests/e2e/editor-draft-restore.stateless.ts`（最悪の場合の構成でだけ流す）。
- 前提を新しい設計に合わせた既存のテスト: `tests/unit/demo-edit-codec.test.ts`（持ち回す表の一覧: 版・スナップショット等を
  「持ち回さない」→「小さくして持ち回す」）、`tests/integration/self-audit-2-demo-persistence.test.ts`（チャンクの詰め方: 1 本の
  圧縮列を切り分ける形式に合わせて、チャンクをつなげて戻す）。期待する結論（押し出さない・戻る）は変えていない。

### 5. テスト結果（2026-09-30 ローカル。E2E はほかの重い処理と並走させず単独実行）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm build` 合格。`pnpm check:rls` 100 テーブル・228 ポリシーで合格。
- `pnpm test` 109 ファイル・1244 件合格。`pnpm test:rls` 2 ファイル・248 件合格。
- `E2E_PORT=3219 pnpm test:e2e:stateless`（リクエストごとに新しい Fixture）: **14 件すべて合格・58.5 秒**。押し出し 0 件。
  変更前の初回実行は本番と同じく 2 手目（標準 CSV の確定）で失敗した。
- `E2E_PORT=3217 pnpm test:e2e`（通常・全件）: **282 件すべて合格・9.1 分**（retries 0）。途中の 1 回は
  `import-drag-drop` の 1 件が `page.goto: net::ERR_NO_BUFFER_SPACE`（アプリに届く前の接続の資源不足）で落ち、
  その spec の単独実行（8 件合格）と全件の再実行（282 件合格）で通った。最終のコードでもう一度全件を流して 282 件合格。

### 6. 未解決・次作業

- 本番へは未反映（deploy していない）。反映後に `E2E_BASE_URL=https://terrast-t4d.vercel.app` で
  `zz-disclosure-project.spec.ts` を 1 つのブラウザの Cookie を持ち回して流し（`metadata.carryDemoState` の project を
  本番向けの構成に足す）、実機でも通ることを確かめる。本番の Cookie ヘッダーの実測も取る。
- 押し出しは従来どおり古い操作から。実演の流れを何周も続けると、前半の版・記録・スナップショットの目録が押し出され、
  別インスタンスではそれを引用した記録・スナップショットも戻らない（docs/known-limitations.md D-3 の「残る制約」）。
- スナップショットの写しは固定した元の行が変わると組み立て直せない（別インスタンスでは「見つからない」）。
  資料名・区分・指標名の編集でも起きる。
- 手動の抜粋・アップロードした資料は持ち回さない（手動の抜粋からの引用位置は別インスタンスで戻らない）。
- 作業本文の控えは同じタブの sessionStorage だけ（別のタブ・ブラウザ・閉じた後は戻らない）。
- 試験用の切替 `T4D_DEMO_FRESH_FIXTURE_PER_REQUEST` は Vercel に設定しないこと（本番は環境変数を持たない）。

---

## 2026-09-30 同じ変更への検証済みの指摘 11 件を修正（単独の修正担当・未コミット）

commit・push・deploy はしていない。`docs/disclosure-first.md` は編集していない。スキーマの変更なし。
各指摘は先にテストを書き、変更前のコードで失敗することを確かめてから直した（E2E 2 件は修正を一時的に外して失敗を確認）。

| 指摘     | 内容                                                                                   | 修正                                                                                                                                                                                     | テスト                                                                                                     |
| -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| F1（中） | 確定の成功後の再送が、検証したインスタンス（検証済みのバッチを持つ）に届くと競合になる | Cookie の確定の控えを、同じバッチ（組織・期間・内容・検証した人・行と差分区分が一致）の検証済みの行に重ねる（`mergeImportReceipt`）                                                      | `stateless-demo-chain`: 検証した Fixture を確定後に使い回し、再送が `replayed`・履歴が確定済み・A03 の注意 |
| F2（中） | AI 候補の採用後、タブの控えが採用前のまま（戻すと採用した段落が消える）                | `onBodyReplaced` で控えを採用後の本文にする                                                                                                                                              | stateless E2E: 入力 → 採用 → 移動 → 戻る                                                                   |
| F3（中） | 開示デモのリセット後もリハーサルの入力を控えから戻す                                   | 控えは `workingSavedByViewer`（`working_updated_by` が本人。Cookie で持ち回し、版の保存・依頼・リセットで消える）のときだけ戻し、それ以外は消す                                          | stateless E2E: 入力 → リセット → 開き直す／`stateless-demo-chain`: サーバー側の根拠                        |
| F4（低） | 差分の版が土台の本文の変化に気付かない                                                 | 土台の内容ハッシュ `bh` を持ち、一致するときだけ戻す。`COMPACT_VERSION` を 2 に                                                                                                          | `demo-compact`: 土台の段落を変えた Fixture では戻らない                                                    |
| F1（高） | 逆順の版の鎖で適用が 3 乗（9KB で 18.6 秒）                                            | 版を節・版番号の順に並べる、編集は新しい 1,000 件・周回は 8 周まで、1 節 200 版まで、ID の索引                                                                                           | `demo-compact`: 1,750 版の逆順の鎖（変更前 31 秒 → 約 60ms）、正規の逆順の鎖は 1 回で戻る                  |
| F2（高） | 目録の組み立て直しが無制限（821B で約 2GB）                                            | 重複した節・行と件数・長さの上限、組み立て前の安い検査、版の本文 20 万字まで、1 回の適用の予算 100 万字（実測の正規の最大は約 1.3 万字）、失敗した目録は依存が変わるまで組み立て直さない | `demo-compact`: 1,000 重複の目録（変更前 1.2 秒・+1.3GB）、巨大な本文、大きい土台を引き継ぐ版の大量        |
| F3（高） | 確定版の完全性を目録の基準の一覧と作成日時で見ていた                                   | プロジェクトの基準の行と適用判断の記録（固定時点）で見る。作成日時はプロジェクト作成後・未来でない・各節の最終承認の後。基準の一覧が空・対象外の区分は不可                               | `demo-compact`: 全節の正規の目録は戻る（前提）／日時を過去へ・基準を空・基準を 1 つ外すと戻らない          |
| F4（中） | 範囲の改訂番号を目録の `pj.r` で見ていた                                               | `max(pj.r, プロジェクトの番号)` で見る（範囲の変更後は、変更前の確定版を別インスタンスで戻さない＝安全側）。プロジェクトより先の番号も不可                                               | `demo-compact`: 番号 0／1／2                                                                               |
| F5（中） | 土台を名乗らない偽の版で書いた人の引き継ぎを外せる                                     | 節の現在の版（土台が無ければ節の全版）の書いた人も引き継ぐ（0042 のトリガと同じ）                                                                                                        | `demo-compact`                                                                                             |
| F6（低） | 目録が別の組織・別の節の社内コメントを取り込める                                       | 組み立て直しで組織と節の一致を求める                                                                                                                                                     | `demo-compact`: 同じ組織・節は戻る／別の組織・別の節は戻らない                                             |
| F7（低） | 後の周で戻る別の節の版を現在の版にできる                                               | 同じ Cookie の版の編集が別の節を名乗れば節の編集を拒否、別の節が指している ID の版は足さない（別リクエストでも）、レビューの記録は依頼の節の版だけ                                       | `demo-compact`: 同じ Cookie・別リクエストの 2 通り                                                         |

- E2E の補助の修正: `editor-draft-restore.stateless.ts` の入力は、足した段落へフォーカスが移ってから打つ
  （移る前に打つと先頭の 1 文字が落ちる。1 回だけ起きた。アプリの不具合ではない）。
- `docs/known-limitations.md` D-3 の「残る制約」に、控えを戻す条件・範囲の変更後の確定版・偽の Cookie への上限を追記。

### テスト結果（2026-09-30 ローカル。E2E は単独実行）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm build` 合格。`pnpm check:rls` 100 テーブル・228 ポリシーで合格。
- `pnpm test` 109 ファイル・1259 件合格。`pnpm test:rls` 2 ファイル・248 件合格。
- `E2E_PORT=3219 pnpm test:e2e:stateless`: 16 件合格（restore の 3 件は `--repeat-each=4` でも 12 件合格）。Cookie の操作の記録の最大 8,699B・ヘッダー 8,847B、押し出しなし。
- `E2E_PORT=3217 pnpm test:e2e`（通常・全件・単独実行）: **282 件すべて合格・9.0 分**（retries 0）。

### 未解決・次作業

- 本番へは未反映（前節と同じ）。
- ID を変えながら新しい行（節・コメント・通知など）を足し続ける偽の Cookie で共有のメモリが増えること自体は残る
  （1 回の適用あたりの量と、1 節あたりの版の数は上限を設けた）。
- 範囲を変えた後は、変える前に確定した確定版が別インスタンスで「見つからない」になる（安全側。known-limitations に記載）。

## 2026-09-30 開示優先モード（顧客候補向け D0）の本番反映と最終結果（統括）

- 指示書: 「T4D 開示業務拡張 Codex実装指示書 v1.0」（2026-09-29）。W0 棚卸し・設計・実施結果は `docs/disclosure-first.md`（§1 訂正、§8 実施結果・A01〜A40・実演手順）。
- コミット（未 Push）: 8265280（W1 基盤）→ ebdfd11（D0 機能）→ 81dd049 / b3927cd / 0be8cc5（自己監査 3 巡の修正）→ 0a30fbb（Vercel の別インスタンス対策）→ 本コミット（文書・画面写真）。
- 本番（Demo Mode・環境変数なし）: `vercel deploy --prod` → `vercel alias set … terrast-t4d.vercel.app`。
  - 本番スモーク `pnpm test:e2e:prod`: 31/31（開示優先モードの 2 件を追加）。
  - 実演の流れ `PROD_BASE_URL=https://terrast-t4d.vercel.app pnpm exec playwright test --config playwright.production-chain.config.ts`: 8/8、最大 Cookie ヘッダー 8,868B。
  - 初回の本番実行では標準 CSV の確定が別インスタンスに届いて止まった（「検証結果の有効期限が切れました」）。0a30fbb で修正し、`pnpm test:e2e:stateless`（要求ごとに Fixture を作り直す最悪条件）で再発を防ぐ。
  - 実演の流れを本番に流すと、数値（欧州販売子会社の水使用量 FY2026）の訂正がそのインスタンスのメモリに残るため、最後に同じコミットを再デプロイしてインスタンスを入れ替えた。
- ローカル最終: lint / format / typecheck 合格、unit+integration 1,259、RLS 248、check:rls 100 表、build 合格、E2E 282/282、stateless 16/16。
- 未解決（発注者の判断が必要）: 取込画面のデモ信頼度表示（80〜97%）と指示書 §9.3 の関係。A30 資料 ACL、A36 は未対応・未検証。0041〜0043 は本番 Supabase へ未適用。
