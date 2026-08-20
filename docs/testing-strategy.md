# テスト戦略

## 1. 5 層構成

| 層              | 実行                       | 対象                                                                                       | 件数 |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| Unit            | `pnpm test`（unit）        | 純粋関数（検証ルール / サンプリング / 権限 / AI スキーマ / パーサ / Export / 日時）        | 95   |
| Integration     | `pnpm test`（integration） | Service 層を通した業務フロー（Server Action と同じ経路）                                   | 35   |
| RLS             | `pnpm test:rls`            | **実 Postgres（PGlite）** へ migration を適用して越権を検証                                | 56   |
| E2E（Demo）     | `pnpm test:e2e`            | 通し 16 ステップ ＋ a11y ＋ 全画面クロール ＋ Server Action 総当たり ＋ 操作系 ＋ 不正入力 | 68   |
| E2E（Supabase） | `pnpm test:e2e:supabase`   | **実 Supabase**（Auth + Postgres + RLS + Storage）での通し ＋ 実 RLS 下のクロール          | 9    |

合計 263 件。`test.skip` / `test.only` / TODO だけのテストはありません。

さらに `pnpm verify:supabase` が、実 Supabase に対して越権・不変性・Storage 非公開などを
**33 項目**、アプリを介さず直接検証します（下記 8 章）。

## 2. Unit

- `validation.test.ts` — 異常 Fixture（女性役員数 > 役員総数 / 前年比 10 倍 / t と kg の混在 /
  Evidence 不足 / 承認後変更）を**実際に検出できる**ことを確認
- `sampling.test.ts` — 同一 Seed で完全再現、Seed が違えば結果が変わる、層化・重要項目・判断抽出
- `authorization.test.ts` — ロール × 権限、Unit スコープ、Sign-off 段階権限、
  **SQL（`role_permissions`）と TS（`ROLE_PERMISSIONS`）の一致検査**
- `ai-schema.test.ts` — 8 Use Case すべてがスキーマを満たす、決定論性、
  confidence / warnings / sources の必須性、監査 AI が結論を出さないこと
- `parsers-and-schema.test.ts` — CSV（引用符・改行・CRLF）、ヘッダー推定、
  文字コード判定（UTF-8 BOM / UTF-8 / Shift_JIS）、Path Traversal 無害化、
  列名変換の往復、**SQL_TABLE_NAMES が migration に実在すること**
- `exports-and-format.test.ts` — CSV エスケープと BOM、XLSX / DOCX 生成、
  日本語ファイル名の Content-Disposition、**JST 日付境界**（UTC 15:00 / 年またぎ / 年度境界）

## 3. Integration

Service を直接呼び、Server Action と同じ経路を検証します。

### 企業スライス（`enterprise-slice.test.ts`）

Import → AI マッピング → 重複検出 → Confirm → 版追加 → 提出 → 差戻し → 承認 →
CDP AI ドラフト → 人が編集 → 承認 → CSV Export

権限系: 担当外拠点の取込拒否 / 拠点担当は承認不可 / Evidence 必須指標は Evidence なしで承認不可 /
許可されない状態遷移の拒否 / AI 生成のままでは承認不可 / 冪等キーによる重複ジョブ防止

### 監査法人スライス（`assurance-slice.test.ts`）

案件アクセス（未アサイン・別法人は NotFound）→ Data Room（許諾範囲のみ・未承認は除外）→
Snapshot（固定値の不変性）→ 変更検知 → 再固定で解消 → 母集団（完全性）→
サンプリング（**別インスタンスでも同一 Seed なら同一結果**）→ 調書自動生成 →
Sign-off 抑止（6 種すべて）→ 解消 → prepared → reviewed → partner_approved

## 4. RLS（最重要）

Docker も実 Supabase も無しで、**本物の Postgres** に対して検証します。

```
PGlite（WASM Postgres）
  ├ auth スキーマのシム（auth.uid() は request.jwt.claims から sub を読む）
  ├ authenticated / anon / service_role ロール
  ├ supabase/migrations/*.sql を番号順にそのまま適用
  └ Fixture を SQL 化して投入（本番と同じ seed.sql 生成経路）

各テスト:
  BEGIN
  set_config('request.jwt.claims', '{"sub": "<user>", "role":"authenticated"}', true)
  SET LOCAL ROLE authenticated
  ... クエリ ...
  COMMIT / ROLLBACK
```

指示書 11 章の必須 10 項目に加え、承認権限・自己レビュー・代理 Sign-off 禁止・
AI 自動承認禁止・許諾の付与主体・許諾取消の即時反映を検証しています。
詳細は [`rls-matrix.md`](rls-matrix.md) の 12 節。

さらに `pnpm check:rls` が静的に検査します。

- `DISABLE ROW LEVEL SECURITY` が存在しないこと
- すべての `create table` に対応する `enable row level security` があること
- すべてのテーブルに RLS ポリシーが 1 件以上あること
- `evidence-private` バケットが public でないこと

## 5. E2E

`pnpm test:e2e:install`（初回のみ）→ `pnpm test:e2e`。
`next build && next start` を Playwright が自動起動します（Demo Mode）。

指示書 20 章の 16 ステップを網羅:

1. 企業管理者ログイン → 2. ダッシュボード KPI → 3. CSV アップロード →
2. 取込プレビュー修正 → 5. 確定 → 6. 提出・差戻し・承認 → 7. CDP AI ドラフト →
3. 監査法人ログイン → 9. 案件表示 → 10. Snapshot 作成 → 11. Sample 作成 →
4. Test 入力 → 13. PBC 作成 → 14. Issue 作成 → 15. Sign-off 抑止 → 16. Issue 解消後に抑止解除

加えて: ロゴの実体埋め込み / デモデータバッジ / KPI クリックの Filter 遷移 /
権限による UI 分岐 / 未アサイン法人管理者の URL 直打ち 404 / PBC 内部メモの非表示 /
自己レビュー禁止 / Export ダウンロード / 監査ログ / Ctrl+K / 未ログイン時のリダイレクト

### Client 側遷移（回帰テスト）

`Client 側遷移` describe は、企業・監査法人の両ワークスペースで
「**未訪問ルートへの `<Link>` クリックで URL と本文が切り替わる**」ことを検証します。

Next.js 15.5.23 には、Layout と Page の間に Suspense 境界（`loading.tsx` を含む）があると
RSC Payload を受信済みでも遷移が確定しない不具合があり、実際にこのアプリで発生しました
（`docs/known-limitations.md` 10 章）。Loading 境界を復活させるとこのテストが落ちます。

### アクセシビリティ

`@axe-core/playwright` で 4 画面を検査し、`wcag2a` / `wcag2aa` の
**critical・serious 違反ゼロ**を強制しています。

> この検査で `color-contrast` の serious 違反が実際に見つかったため、
> テストを緩めるのではなくブランドトークン（danger / success）の明度を調整しました。

## 6. 決定論性の担保

| 対象          | 手段                                                     |
| ------------- | -------------------------------------------------------- |
| Fixture の ID | `fid(namespace, key)`（FNV-1a ベース）                   |
| ハッシュ      | `contentHash()`                                          |
| サンプリング  | `createRng(seed)`（xorshift128）。`Math.random()` 不使用 |
| Mock AI       | 入力ハッシュから安定生成                                 |
| 基準日        | `FIXTURE_TODAY = 2026-08-14`                             |
| タイムゾーン  | テスト環境も `TZ=Asia/Tokyo`                             |

E2E から `dataPointId('EAST', 'water', 'FY2026')` のように ID を直接指定できるのは
この決定論性のおかげです。

## 7. CI で流すべき順序

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm check:rls      # 静的
pnpm test           # unit + integration
pnpm test:rls       # 実 Postgres（PGlite）
pnpm build
pnpm test:e2e       # ビルド済みを起動して実行（Demo Mode）
```

## 8. 実 Supabase に対する検証

PGlite は SQL と RLS を検証できますが、**GoTrue（Auth）・PostgREST・Storage は含みません**。
そこで Supabase CLI のローカルスタックに対して次の 2 つを実行します。

```bash
pnpm exec supabase start
pnpm exec supabase db reset   # 全 migration + seed
pnpm verify:supabase          # 33 項目（アプリを介さず直接検証）
pnpm test:e2e:supabase        # 7 件（ブラウザから実 Auth でログイン）
```

`scripts/verify-supabase.ts` は、実 JWT でログインしたうえで
テナント分離 / 許諾スコープ / Read-only / 拠点スコープ / 承認権限 / 不変性 /
代理 Sign-off 禁止 / 情報非対称 / 許諾発行 / Storage 非公開 を検証します。
リモート URL に対しては `ALLOW_REMOTE_VERIFY` がない限り実行を拒否します
（本番 Supabase への誤爆防止）。

> この経路でしか見つからない不具合が実際に 3 件出ました:
> 相手方組織名を読めない RLS の穴（migration `0017`）、
> anon ロールでの監査ログ書き込み失敗、Supabase Mode のログインフォーム欠落。
> `storage.buckets` の SELECT ポリシー不足（migration `0016`）も同様です。

## 9. 実 OpenAI に対する検証

自動テストは**すべて決定論的な `MockAIProvider`** で動きます。
`next start` は `.env.local` を自動で読むため、Key を置くと E2E が実 API を叩いてしまいます。
これを防ぐために、両 Playwright Config の `webServer.env` と `tests/setup/unit-setup.ts` で
`OPENAI_API_KEY` を空へ落としています。**テストから課金 API は絶対に叩きません。**

実接続はテストとは別経路で、明示的に確認します。

```bash
pnpm verify:openai   # 1 リクエストだけ送る
```

確認するのは次の 3 点です。

1. `OPENAI_MODEL` の Model 名が実在し、その API Key で使えること
2. Responses API の構造化出力（`zodTextFormat`）が通ること
3. 返った JSON が `src/lib/ai/schemas.ts` の Zod スキーマに適合すること

> この経路で `openai` SDK v4 系が現在の API と通信できないこと
> （全 Model・全 Endpoint で `ERR_STREAM_PREMATURE_CLOSE`）を検出し、v7 系へ更新しました。
> スキーマの unit テストだけでは**実通信の破綻を検出できません**。

## 10. 画面・機能の網羅監査

シナリオテストは「想定した経路」しか通りません。想定外の画面が黙って壊れているのを
見つけるために、機械的な監査を別に持っています。

### 画面クロール（`tests/e2e/screen-audit.spec.ts`）

ルート表を手で書かず、**リンクを辿って到達可能な画面をすべて開きます**
（一覧から詳細ページも自動で対象に入る）。各ページで次を確認します。

- HTTP 400 以上でないこと
- `#t4d-main` が描画されること
- 「問題が発生しました」「ページが見つかりません」等が出ていないこと
- Console にエラーが出ていないこと

一覧のフィルター違い（`?page=1,2,3…`）を無限に辿らないよう、
「パス ＋ クエリのキー名」で正規化しています（フィルターの種類ごとに 1 回は必ず開く）。

権限の異なる 6 ロールでも同じクロールを回します。権限分岐で描画経路が変わるためです。
さらに `tests/e2e-supabase` で**実 RLS 下**でも同じクロールを回します
（「許諾外のテーブルを読んで落ちる」型は Demo Mode では原理的に出ません）。

### Client 側遷移

`page.goto` は Server 側しか見ません。実際の利用はクリックなので、
サイドバー全項目と本文リンクを**クリックして URL が確定すること**を確認します。
Next.js #86151 のように「RSC は 200 で返っているのに無言で固まる」不具合は、
これでしか検出できません。

### Server Action の総当たり（`tests/e2e/action-audit.spec.ts`）

`src/app/**/actions.ts` の Server Action のうち、シナリオテストで通らないものを
UI から実際に叩き、**結果が画面へ反映されること**まで確認します。
「サーバー側では成功しているのに UI が更新されない」型の欠陥
（revalidate 漏れ）を検出するためです。実際にこれで 1 件見つかりました。

### 操作系の監査（`tests/e2e/interaction-audit.spec.ts`）

クロールは `<a>` しか辿れません。実際の画面には **`<a>` ではない遷移**が多くあります。

- Radix Select（期間セレクタ・案件セレクタ）
- `router.push` / `router.replace`（案件切替・フィルター・検索の Debounce）
- Dropdown Menu の中の Server Action（ログアウト・ワークスペース切替）

これらはクロールでは 1 つも踏めないため、個別に踏みます。
実際にこの経路で「期間セレクタが選んだ値と違う ID を送る」「ログアウトが無反応」の
2 件が見つかりました。**どちらも型チェックとビルドは通ります。**

### 壊れ方の監査（`tests/e2e/robustness-audit.spec.ts`）

正しくない URL・不正な ID・壊れたクエリ文字列を投げ、
500 やスタックトレースではなく 404 / 403 で行儀よく落ちることを確認します。
あわせて、画面クロールでは踏めない `/api/*` の Route Handler を
未ログイン・他テナント・未アサインの各条件で叩きます。

> API はページ内 `fetch` で叩きます。Playwright の `page.request` は
> BrowserContext の httpOnly Cookie を送らず、ログイン済みでも 401 になるためです。
