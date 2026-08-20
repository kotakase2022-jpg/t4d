# 実装計画（Implementation Plan）

- 対象：TERRAST for Disclosure（T4D）
- 版：v1.0 / 2026-08-14
- 正本：`Claude_Code_T4D_開発指示書_企業・監査法人UX_Vercel・Supabase.txt`（本指示書）
- バックログ正本：`T4D_PC専用_非財務情報・開示・保証対応アプリ_機能要件一覧_v0.2`（118 件）

---

## 1. 現状（Milestone 0 調査結果）

| 調査対象                             | 結果                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `github.com/kotakase2022-jpg/t4d`    | **空リポジトリ**（コミット 0 件、ブランチ未作成）                                                |
| `package.json` / lockfile            | 無し → 新規初期化                                                                                |
| `src` / `app` / `components`         | 無し                                                                                             |
| `supabase` / `migrations`            | 無し                                                                                             |
| `tests`                              | 無し                                                                                             |
| `README` / `AGENTS.md` / `CLAUDE.md` | 無し                                                                                             |
| 既存の認証・権限・データモデル       | 無し                                                                                             |
| 既存 UI                              | 無し                                                                                             |
| ロゴ                                 | Drive の `T4D logo.png`（2172×724 / RGB PNG）を取得し `public/brand/t4d-logo.png` へ実体配置済み |

→ 指示書 2-3「空リポジトリの場合は新規に初期化」に従い、破壊対象なしでゼロから構築する。

### 実行環境

| 項目         | 値                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| OS           | Windows 11 Pro (win32)                                                                                           |
| Node.js      | v24.17.0                                                                                                         |
| pnpm         | 11.8.0                                                                                                           |
| Next.js      | 15.5.23（App Router）                                                                                            |
| React        | 19.2.8                                                                                                           |
| Tailwind CSS | 4.3.3（CSS-first `@theme`）                                                                                      |
| TypeScript   | 5.9 系 / `strict: true` + `noUncheckedIndexedAccess`                                                             |
| Supabase     | 実インスタンス無し → Migration/RLS は SQL として作成し、**PGlite（インプロセス Postgres）で実適用・実 RLS 検証** |
| OpenAI       | API Key 無し → `MockAIProvider` を既定、`OpenAIProvider`（Responses API）を実装のみ                              |

---

## 2. アーキテクチャ方針

### 2.1 二重モードを 1 本の Interface で

```
UI (Server Components / Server Actions)
        │
        ▼
Service 層  src/lib/services/*        … 業務ルール・遷移条件・監査記録
        │
        ▼
Repository Interface  src/lib/repositories/types.ts
        ├── DemoRepository      … インメモリ Fixture（環境変数ゼロで起動）
        └── SupabaseRepository  … Supabase Postgres + RLS
```

- 画面・Service は Repository の**具象を知らない**。`getRepositories()` が `APP_MODE` で切り替える。
- 認可は **二重**に掛ける。
  1. アプリ層 `src/lib/authorization/*`（Demo Mode でも常に有効／`can()` 判定）
  2. DB 層 Supabase RLS（Supabase Mode で有効）
     Demo Mode でも 1 が働くため「越権できてしまうデモ」にはならない。

### 2.2 テナント分離の実装単位

- `organizations.type ∈ {enterprise, assurance_firm, platform_admin}`
- 企業テナント ↔ 監査法人テナントの接続は **`engagements` + `client_access_grants` のみ**。
- `client_access_grants` は「企業が何を（期間 × 組織 × 指標 × Evidence 種別）誰に見せるか」の唯一の真実。
- 監査法人側の作業成果（調書・PBC・Issue・Review Note・Sign-off）は
  `owner_organization_id = 監査法人` として**別テーブル・別所有**で保存し、企業原本を一切上書きしない。

### 2.3 Immutability

| 対象                                               | 実装                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `assurance_snapshots` / `assurance_snapshot_items` | RLS に UPDATE / DELETE ポリシーを**作らない**＋ `BEFORE UPDATE OR DELETE` トリガで例外 |
| `audit_events`                                     | 同上（追記専用）                                                                       |
| `signoffs`                                         | 同上（撤回は `signoff_revocations` の追記で表現）                                      |
| `data_point_versions`                              | 追記専用。現在値は `data_points.current_version_id` が指す                             |

---

## 3. Milestone 計画と成果物

| M      | 内容             | 主要成果物                                                                                                                      | 完了判定                                                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **M0** | 調査・計画       | `docs/implementation-plan.md`, `docs/assumptions.md`, ロゴ配置                                                                  | 本ファイル                                                        |
| **M1** | 基盤             | Next.js / Tailwind / UI プリミティブ / AppShell / BrandLogo / Demo Auth / Workspace 選択 / Route Guard / Loading・Empty・Error  | `pnpm build` 成功、`/login` → `/workspace` → 各 Dashboard が動作  |
| **M2** | DB・RLS          | `supabase/migrations/0001..0012`, `supabase/seed.sql`, Storage ポリシー, `audit_events`                                         | `pnpm test:rls` で越権 10 種が全て遮断                            |
| **M3** | 企業スライス     | Dashboard / Import→Preview→Confirm / Data Point / Evidence / Validation / Workflow / CDP / Export                               | Integration テスト「Import→Approve→CDP Draft」通過                |
| **M4** | 監査法人スライス | Engagement / Grant / Data Room / Snapshot / Population / Sampling / Testing 三ペイン / PBC / Issue / Review / Sign-off / Export | Integration テスト「Snapshot→Sampling→Testing→Sign-off 抑止」通過 |
| **M5** | OpenAI           | `AIProvider` / `OpenAIProvider` / `MockAIProvider` / 8 Use Case / `ai_runs`                                                     | AI Schema 単体テスト通過、UI に Source・Confidence・Mock バッジ   |
| **M6** | 品質             | unit / integration / rls / e2e / a11y                                                                                           | 7 コマンド全成功                                                  |
| **M7** | Handoff          | README / docs 12 本 / AGENTS.md / CLAUDE.md / AI_HANDOFF.md                                                                     | Definition of Done 30 項目                                        |

---

## 4. 変更対象（新規作成）ディレクトリ

```
docs/            12 本の設計文書
public/brand/    t4d-logo.png（実体）
src/app/         (auth) / enterprise / assurance / api
src/components/  ui（shadcn 準拠プリミティブ）/ shared（AppShell 等）
src/features/    20 feature（enterprise 10 / assurance 8 / 共通 2）
src/lib/         supabase / auth / authorization / audit / storage / ai / jobs / validation / exports / fixtures / repositories / services
src/types/
supabase/        migrations / functions / seed.sql
scripts/         verify-env / check-rls / seed-demo-users
tests/           unit / integration / e2e / rls / fixtures / setup
```

---

## 5. リスクと対策

| #   | リスク                                                                       | 影響                       | 対策                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 実 Supabase が無いため RLS が「書いただけ」になる                            | 最重要要件が未検証         | **PGlite で migrations を実適用**し、`SET ROLE authenticated` + `request.jwt.claims` を切り替えて越権テストを実行。CI/ローカルとも Docker 不要。                     |
| R2  | Supabase 固有オブジェクト（`auth.users`, `storage.objects`）が PGlite に無い | migration 適用不能         | Supabase 依存を `supabase/migrations/0000_supabase_bootstrap.sql`（Supabase では no-op）に隔離し、テストハーネスが `auth` / `storage` スキーマの互換シムを先に作る。 |
| R3  | OpenAI 未接続で「AI が動くように見えるだけ」になる                           | 実装未検証                 | `MockAIProvider` を**決定論的**（入力ハッシュから安定生成）にし、Provider 差し替えの契約テストを両実装へ同一適用。UI に `Mock` バッジ常時表示。                      |
| R4  | PDF 抽出が環境依存で落ちる                                                   | Import が壊れる            | `unpdf` を try/catch で包み、失敗時は行を破棄せず `needs_review` + 「OCR／AI解析要確認」として保存（成功扱いにしない）。                                             |
| R5  | Playwright ブラウザ未取得                                                    | `pnpm test:e2e` 不能       | `pnpm test:e2e:install` を用意し、README と完了報告に明記。                                                                                                          |
| R6  | Demo Mode がテナント分離を素通しする                                         | 「デモでは越権できる」実装 | Demo Repository も `AuthorizationContext` を必須引数にし、`assertCanRead` を通らない行を返さない。越権テストは Demo Mode 側にも用意。                                |
| R7  | 全 118 要件の薄い実装に流れる                                                | 指示書 7 章違反            | Phase 1 は 2 本の Vertical Slice のみ完成。範囲外は `/enterprise/roadmap`・`/assurance/roadmap`（今後対応一覧）に**ボタン無し**で明示。                              |
| R8  | Windows 環境の改行・パス差異                                                 | lint / format 失敗         | Prettier `endOfLine: lf` + `.gitattributes`、パス結合は `node:path` に統一。                                                                                         |

---

## 6. 実装順（依存関係）

```
M1 基盤
 ├─ src/lib/config.ts（APP_MODE 判定）
 ├─ src/types/domain.ts（ドメイン型）
 ├─ src/lib/authorization（Role / Permission / can()）
 ├─ src/components/ui（プリミティブ 20 種）
 ├─ src/components/shared（AppShell, BrandLogo, ...）
 └─ src/app/(auth)/login, /workspace, Route Guard
      ↓
M2 DB・RLS（型はドメイン型と 1:1）
      ↓
M3 企業スライス ── M4 監査法人スライス（Snapshot は M3 の data_point_versions に依存）
      ↓
M5 AI（両スライスへ後付け／Provenance 記録）
      ↓
M6 品質 → M7 Handoff
```

---

## 7. 前提（詳細は `docs/assumptions.md`）

1. 実 Supabase プロジェクト・OpenAI API Key は未提供。既定は Demo Mode。
2. SSBJ / CDP の正式マスターは未提供。**架空の縮小マスター**（CDP 12 問 / SSBJ 10 項目）を Fixture として作成し、`disclosure_framework_versions` で差し替え可能にする。
3. 排出係数は架空値（ライセンス上、実係数は同梱しない）。
4. 本番 Deploy・実ユーザー招待・外部メール送信は実行しない。
5. `main` への直接 Push、および Push 自体を行わない（指示書 2-9）。
