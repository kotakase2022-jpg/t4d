# アーキテクチャ

## 1. 全体像

```
┌─────────────────────────────────────────────────────────────┐
│ ブラウザ（PC 専用 / 最小 1280px / 日本語 / Asia-Tokyo）        │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS（CSP・Secure Header・middleware Route Guard）
┌───────────────▼─────────────────────────────────────────────┐
│ Next.js 15 App Router（Vercel）                              │
│  ├ Server Components …… 既定。データ取得はここで完結         │
│  ├ Server Actions ……… 入力の取り出し + revalidate のみ      │
│  └ Route Handlers ……… /api/jobs, /api/files, /api/exports   │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ Service 層  src/lib/services/*                               │
│  業務ルール・状態遷移・抑止条件・監査記録                     │
│  Server Action からも Integration テストからも同じ関数を呼ぶ │
└───────────────┬─────────────────────────────────────────────┘
                │  DbClient（共通 Interface）
      ┌─────────┴──────────┐
      ▼                    ▼
 DemoDbClient        SupabaseDbClient
 （インメモリ）        （Postgres + RLS）
```

## 2. 二重モード

|         | Demo / Fixture Mode                                       | Supabase Mode                    |
| ------- | --------------------------------------------------------- | -------------------------------- |
| 判定    | Supabase 環境変数なし、または `NEXT_PUBLIC_APP_MODE=demo` | 環境変数あり、または `=supabase` |
| データ  | `src/lib/fixtures/store.ts` のインメモリ配列              | Postgres                         |
| 認証    | `t4d_demo_user` Cookie（HttpOnly / SameSite=Lax）         | Supabase Auth                    |
| 認可    | アプリ層のみ（**同じ `can()` を通す**）                   | アプリ層 ＋ RLS                  |
| Storage | プロセス内 Map ＋ `/api/files/download`                   | Supabase Storage ＋ Signed URL   |
| AI      | `MockAIProvider`（決定論的）                              | `OpenAIProvider`（Key があれば） |
| 表示    | 「デモデータ」バッジ常時表示                              | なし                             |

同じ架空データを両モードで使えるよう、`src/lib/fixtures/to-sql.ts` が
Fixture から `supabase/seed.sql` を生成します（`pnpm seed:generate`）。

## 3. Repository 抽象

`src/lib/repositories/types.ts` の `DbClient` は 6 メソッドだけの薄い層です。

```ts
select(table, { where, orderBy, limit, offset });
count(table, { where });
findById(table, id);
insert(table, rows);
update(table, id, patch);
softDelete(table, id, at);
```

Filter は両モードで表現できる範囲（等値 / in / notIn / neq / 比較 / null / 配列 contains）に
限定しています。JOIN や集計は Service 層で組み立てます（Phase 1 のデータ量で問題ない規模）。

- 列名変換（camelCase ↔ snake_case）は `table-names.ts` に集約。数字は分割しません（`sha256`）。
- テーブル名の対応表は `SQL_TABLE_NAMES`。`tests/unit/parsers-and-schema.test.ts` が
  migration に実在することを検査します。

## 4. 非同期ジョブ

Upload リクエストをブロックしない構成です。

```
Server Action              Route Handler（ワーカー）        画面
uploadFilesAction   ──▶  ジョブを queued で作成
   （即 redirect）                │
                                  ◀── GET /api/jobs/[jobId] ── JobPoller（指数バックオフ）
                                  processIngestionJob()
                                    parse → AI マッピング → ingestion_rows
                                  ──▶ status / progressPercent を返す
```

`supabase/functions/process-ingestion-job/` へ移す場合も、同じ
`processIngestionJob()` を呼ぶだけで済むようにしています。

Job は `idempotency_key` で重複作成を防ぎ、`retry_count` / `error_code` / `error_message` /
`progress_percent` / `started_at` / `finished_at` を保持します。

## 5. レイヤ境界のルール

| 層                     | してよいこと                                            | してはいけないこと           |
| ---------------------- | ------------------------------------------------------- | ---------------------------- |
| `app/**/page.tsx`      | データ取得・表示                                        | 業務ロジック・直接の DB 更新 |
| `app/**/actions.ts`    | FormData の取り出し・Service 呼び出し・`revalidatePath` | 業務ロジック                 |
| `lib/services/**`      | 業務ロジック・認可・監査記録                            | HTTP / FormData / revalidate |
| `lib/repositories/**`  | データアクセス                                          | 業務ルール                   |
| `lib/authorization/**` | 純粋な判定                                              | I/O                          |

この分離により、Integration テストは UI を経由せず
**Server Action と同じ経路**を検証できます。

## 6. Server 専用モジュールの境界

`import 'server-only'` を付けたモジュール:
`lib/repositories/index.ts` / `lib/auth/session.ts` / `lib/audit/logger.ts` /
`lib/storage/index.ts` / `lib/ai/*` / `lib/imports/*` / `lib/services/*` / `lib/exports/index.ts`

Client Component から誤って import するとビルドが失敗します。
テスト時のみ Vitest がスタブへ差し替えます（`tests/setup/server-only-stub.ts`）。

## 7. セキュリティヘッダー

`next.config.ts` で CSP / HSTS / X-Frame-Options: DENY / X-Content-Type-Options /
Referrer-Policy / Permissions-Policy を設定しています。
`frame-ancestors 'none'` と `object-src 'none'` を含みます。

## 8. 決定論性

- Fixture の全 ID は `fid(namespace, key)` による決定論的 UUID
- Snapshot / Version の hash は `contentHash()`
- サンプリングは `createRng(seed)`（xorshift128）。`Math.random()` を使わない

これにより、Demo / テスト / Seed SQL のどれでも同じ ID・同じ抽出結果になり、
E2E から ID を直接指定できます。
