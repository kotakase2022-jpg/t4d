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
