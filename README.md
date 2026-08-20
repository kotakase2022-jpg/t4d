# TERRAST for Disclosure（T4D）

日本の上場企業の**非財務情報開示**と、監査法人の**第三者保証業務**を同一データ基盤上で安全に接続する PC 専用ブラウザアプリです。

- 企業ワークスペース: 収集 → AI 構造化 → 検証 → Evidence → レビュー → 承認 → 開示再利用
- 監査法人ワークスペース: 契約 → スコープ → Data Room → Snapshot → 母集団 → Sample → 手続 → PBC → 指摘 → Review → Sign-off

両者は**完全に別テナント**で、`Engagement`（保証契約）と `Client Access Grant`（アクセス許諾）でのみ接続されます。

---

## クイックスタート（環境変数ゼロで動きます）

```bash
pnpm install
pnpm dev
```

http://localhost:3000 を開くと Demo / Fixture Mode で起動します。Supabase も OpenAI API Key も不要です。
画面上部に「デモデータ」バッジが常時表示され、表示内容がすべて架空データであることを示します。

### デモログイン

`/login` に並ぶボタンを押すだけでログインできます（パスワード不要。**本番 Auth とは完全に別経路**で、`NEXT_PUBLIC_APP_MODE=demo` のときだけ有効です）。

| アカウント                     | 氏名        | 組織               | ロール                       |
| ------------------------------ | ----------- | ------------------ | ---------------------------- |
| `enterprise-admin@demo.local`  | 青海 太郎   | 青海テクノロジー   | 企業管理者                   |
| `sustainability@demo.local`    | 海野 みどり | 青海テクノロジー   | 本社サステナビリティ担当     |
| `site-user@demo.local`         | 東 一郎     | 青海テクノロジー   | 拠点担当（東日本工場のみ）   |
| `reviewer@demo.local`          | 検見川 涼   | 青海テクノロジー   | レビュー担当                 |
| `approver@demo.local`          | 承 花子     | 青海テクノロジー   | 最終承認者                   |
| `assurance-manager@demo.local` | 青葉 健     | あおば保証監査法人 | マネージャー                 |
| `assurance-partner@demo.local` | 保 統括     | あおば保証監査法人 | 契約責任者                   |
| `assurance-staff@demo.local`   | 若葉 新     | あおば保証監査法人 | 担当者                       |
| `assurance-admin@demo.local`   | 法人 管理   | あおば保証監査法人 | 法人管理者（**未アサイン**） |

越権テスト用に、別テナントのアカウント（蒼天マテリアル／くろべ監査法人）もログイン画面下部から選べます。

> `assurance-admin@demo.local` は監査法人の管理者ですが、案件にアサインされていないため
> クライアントデータを一切閲覧できません。これは仕様であり、RLS テストでも検証しています。

### 触ってみる順序（おすすめ）

1. `enterprise-admin@demo.local` でログイン → ホームの KPI をクリックすると Filter 付き一覧へ遷移します
2. `sustainability@demo.local` → データ収集で CSV を取り込み（サンプル: `tests/e2e/fixtures/east-plant-fy2026.csv`）
3. 取込プレビューで AI の推定を修正 → 確定
4. `approver@demo.local` → 非財務データ詳細から承認
5. 開示対応 → CDP → 質問を開き「ドラフトを生成」→ 編集して保存 → 承認
6. `assurance-manager@demo.local` → Data Room で Snapshot 固定 → サンプリング → Testing → Sign-off（抑止条件で止まります）

---

## 技術スタック

| 層                | 採用                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| Frontend / BFF    | Next.js 15（App Router）, React 19, TypeScript strict                    |
| UI                | Tailwind CSS 4, shadcn/ui 準拠プリミティブ, lucide-react, TanStack Table |
| Form / Validation | React Hook Form, Zod                                                     |
| Hosting           | Vercel                                                                   |
| Database          | Supabase Postgres                                                        |
| Auth              | Supabase Auth（Demo Mode は独立した Cookie セッション）                  |
| Authorization     | Supabase RLS ＋ アプリ層権限判定（二重防御）                             |
| File              | Supabase Storage（Private Bucket ＋ 短時間 Signed URL）                  |
| Async             | Job テーブル ＋ Route Handler ワーカー（Edge Function 差し替え可能）     |
| AI                | OpenAI 公式 SDK / Responses API / 構造化出力（未接続時は決定論的 Mock）  |
| Test              | Vitest, Playwright, PGlite による実 RLS テスト                           |
| Package Manager   | pnpm                                                                     |

### 追加ライブラリと採用理由

| ライブラリ             | 目的                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `@electric-sql/pglite` | Docker なしで実 Postgres へ migration を適用し、**RLS を実際に検証**するため |
| `exceljs`              | XLSX の読み書き（SheetJS の npm 公開版は既知脆弱性があるため不採用）         |
| `docx`                 | 開示ドラフトの簡易 DOCX 出力                                                 |
| `unpdf`                | PDF テキスト抽出（サーバーレス互換。失敗時は「OCR／AI解析要確認」）          |
| `@axe-core/playwright` | 主要画面のアクセシビリティ検査                                               |

`openai` は **v7 系**を使います。当初の v4 系は同梱の `node-fetch` v2 が現在の API の応答を
読めず、全 Model・全 Endpoint で `ERR_STREAM_PREMATURE_CLOSE`（Premature close）になりました
（素の `fetch` では同じ Endpoint が正常に応答するため、SDK 側の問題）。
v7 はネイティブ `fetch` を使うため解消します。`responses.parse` と
`openai/helpers/zod` の `zodTextFormat` は v4 と同じ書き方のままです。

---

## コマンド

```bash
pnpm dev              # 開発サーバー（Demo Mode）
pnpm build            # 本番ビルド
pnpm start            # 本番サーバー

pnpm lint             # ESLint
pnpm format:check     # Prettier
pnpm typecheck        # TypeScript strict
pnpm test             # Vitest（unit + integration）
pnpm test:rls         # PGlite へ migration を適用して RLS 越権テスト
pnpm test:e2e         # Playwright（初回のみ pnpm test:e2e:install が必要）

pnpm test:e2e:supabase   # 実 Supabase（Auth + RLS + Storage）に接続した E2E
pnpm verify:supabase     # 実 Supabase へ 33 項目の越権・不変性・Storage 検証
pnpm verify:openai       # 実 OpenAI へ 1 回だけ呼んで疎通と構造化出力を確認

pnpm verify:env       # 環境変数の危険な組み合わせを検出
pnpm check:rls        # RLS 未設定テーブル / RLS 無効化記述の静的検出
pnpm seed:generate    # Fixture から supabase/seed.sql を再生成
```

---

## Supabase Mode への切り替え

```bash
cp .env.example .env.local
# NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY を設定
```

```bash
pnpm exec supabase start       # ローカル Supabase
pnpm exec supabase db reset    # migrations + seed.sql をまとめて適用
pnpm verify:env
pnpm dev
```

`supabase/seed.sql` には `auth.users` / `auth.identities` の行も含まれるため、
`db reset` だけで**そのままログインできる**状態になります
（ローカル専用パスワード。`src/lib/fixtures/to-sql.ts` の `LOCAL_DEMO_PASSWORD`）。

ログインは実 Supabase Auth（email / password）です。デモログインのボタンは Demo Mode 専用で、
Supabase Mode では表示されません。

動いていることの確認:

```bash
pnpm verify:supabase     # 33 項目（テナント分離 / 許諾 / 不変性 / Storage 非公開 …）
pnpm test:e2e:supabase   # ブラウザから実 Auth でログインして通す
```

> `pnpm seed:demo-users` / `pnpm verify:supabase` はリモート（`*.supabase.co`）に対しては
> 既定でブロックされます。共有環境を汚さないための安全装置です
> （`ALLOW_REMOTE_SEED=1` / `ALLOW_REMOTE_VERIFY=1` で明示解除）。

### OpenAI の接続

`.env.local` に `OPENAI_API_KEY` を設定すると自動的に `OpenAIProvider`（Responses API / 構造化出力）へ
切り替わります。未設定の間は決定論的な `MockAIProvider` が使われ、
UI には常に「Mock / AI未接続」バッジが出ます。Model は `OPENAI_MODEL` で差し替えられます
（既定 `gpt-4.1-mini`。動作確認済み: `gpt-5.6-terra`）。

```bash
pnpm verify:openai    # 実際に 1 回だけ呼んで、Model 名・構造化出力・スキーマ適合を確認する
```

> **推定コスト**は `src/lib/ai/openai-provider.ts` の単価表に載っている Model でのみ算定します。
> 未登録の Model は 0（＝未算定）を記録し、画面には「—」と表示されます。
> 推測した単価を入れると `ai_runs` に誤った金額が残るため、公式価格を確認してから追記してください。

> E2E（`pnpm test:e2e` / `pnpm test:e2e:supabase`）は `OPENAI_API_KEY` を空にして起動するため、
> `.env.local` に Key があっても**課金 API を叩かず** Mock で決定論的に走ります。

---

## Vercel

**本番 URL: https://terrast-t4d.vercel.app** （Vercel プロジェクト `t4d`）

環境変数は**一切設定していません**。したがって本番は Demo / Fixture Mode で動作し、
表示されるデータはすべて架空です。Supabase にも OpenAI にも接続していません
（AI は決定論的な Mock。画面に「Mock / AI未接続」バッジが出ます）。

```bash
pnpm exec vercel deploy --prod
```

`vercel.json` で `framework: nextjs` を固定しています。
CLI で作ったプロジェクトは Framework Preset が `Other` になり、
`public/` だけが配信されて**全ルートが 404 になる**ためです。

`.vercelignore` で `.env*` を除外しています。**Secret は Vercel へアップロードしません。**
Supabase / OpenAI を本番で使う場合は、ファイルではなく Vercel の環境変数として設定してください。

### 公開範囲

Vercel の Deployment Protection は **2026-08-16 に発注者の指示で無効化**しました。
URL を知っていれば誰でも閲覧できます。Demo ログインはパスワード不要なので、
**URL を知る全員が全画面を操作できます**（表示されるデータはすべて架空です）。

限定公開へ戻す場合は、`{"ssoProtection":{"deploymentType":"all_except_custom_domains"}}` を
書いた JSON を用意して次を実行します（この設定は CLI のオプションでは変更できません）。

```bash
pnpm exec vercel api /v9/projects/t4d -X PATCH --input protection.json
```

> 本番 Deploy は 2026-08-15 に発注者の明示指示で解禁したものです（指示書 2-8 の例外）。
> 実ユーザー招待・外部メール送信は引き続き行いません。

---

## セキュリティ設計の要点

- **テナント分離**: 企業／監査法人は独立テナント。接続点は `engagements` と `client_access_grants` のみ
- **二重防御**: アプリ層（`src/lib/authorization`）と DB 層（RLS 169 ポリシー / 75 テーブル）
- **Read-only by Default**: 監査法人はクライアント原本に UPDATE ポリシーを持たない
- **Immutable**: Snapshot / Snapshot Item / Audit Event / Sign-off / 各種 Version は追記専用（RLS ＋ トリガ）
- **代理 Sign-off 禁止**: `user_id = auth.uid()` を RLS の WITH CHECK とトリガで強制
- **AI は確定しない**: AI 由来の開示回答 Version は `approved` にできない（アプリ層 ＋ DB トリガ）
- **Evidence**: Private Bucket ＋ 短時間 Signed URL。発行前に DB スコープを再検証し、監査ログへ記録
- **CSP**: リクエストごとに nonce を発行し `script-src 'self' 'nonce-…' 'strict-dynamic'`
  （`src/middleware.ts`）。`style-src` の `'unsafe-inline'` のみ残置（理由は known-limitations S-6）

詳細は [`docs/authorization.md`](docs/authorization.md) / [`docs/rls-matrix.md`](docs/rls-matrix.md) を参照してください。

---

## ドキュメント

| ファイル                                                   | 内容                                        |
| ---------------------------------------------------------- | ------------------------------------------- |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 実装計画・Milestone・リスク                 |
| [docs/assumptions.md](docs/assumptions.md)                 | 置いた仮定と未入手事項                      |
| [docs/architecture.md](docs/architecture.md)               | 全体構成・二重モード・レイヤ                |
| [docs/domain-model.md](docs/domain-model.md)               | ドメインモデルと主要制約                    |
| [docs/authorization.md](docs/authorization.md)             | ロール・権限・認可の考え方                  |
| [docs/rls-matrix.md](docs/rls-matrix.md)                   | テーブル × 操作 × 主体の RLS 一覧           |
| [docs/storage-model.md](docs/storage-model.md)             | Bucket・Object Path・Signed URL             |
| [docs/ai-design.md](docs/ai-design.md)                     | AI Provider・Use Case・Provenance・禁止事項 |
| [docs/ux-spec.md](docs/ux-spec.md)                         | 画面構成・レイアウト・ショートカット        |
| [docs/api-contract.md](docs/api-contract.md)               | Route Handler と Server Action の契約       |
| [docs/testing-strategy.md](docs/testing-strategy.md)       | テスト方針と実行方法                        |
| [docs/known-limitations.md](docs/known-limitations.md)     | 既知の制約・未実装                          |
| [AI_HANDOFF.md](AI_HANDOFF.md)                             | Milestone ごとの変更・テスト・次作業        |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md)            | 開発規約（同一内容）                        |
