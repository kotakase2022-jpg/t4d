# 前提・仮定（Assumptions）

指示書 2-5「軽微な判断で作業を止めないでください。保守的な仮定を置き、docs/assumptions.md へ記録してください」に基づく記録。

判定基準：**迷った場合は、よりセキュアかつ企業／監査法人の権限分離が強い側**を採用した。

---

## A. 外部資格情報・接続

| #   | 事項                               | 未入手内容                        | 置いた仮定                                                                                                                                                                                                            | 影響範囲                                      | 解消方法                                          |
| --- | ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| A-1 | Supabase プロジェクト              | URL / anon key / service role key | 既定は Demo Mode。Supabase Mode 用のコードと Migration は完成させるが、実インスタンスへは適用しない                                                                                                                   | `src/lib/supabase/*`, `supabase/migrations/*` | `.env.local` へ 3 変数を設定し `supabase db push` |
| A-2 | OpenAI API Key                     | 未提供                            | `MockAIProvider` を既定。`OpenAIProvider`（公式 SDK / Responses API）は実装済みで Key 設定のみで切替                                                                                                                  | `src/lib/ai/*`                                | `OPENAI_API_KEY` を設定                           |
| A-3 | OpenAI Model 名                    | 未指定                            | 既定 `gpt-4.1-mini`（`OPENAI_MODEL` で差替可能、コードに固定しない）                                                                                                                                                  | `src/lib/ai/openai-provider.ts`               | 環境変数変更のみ                                  |
| A-4 | Supabase Edge Functions ランタイム | デプロイ不可                      | 非同期 Job は `ingestion_jobs` テーブル + Next.js Route Handler ワーカー（`/api/jobs/process`）で実装。Edge Function 版のエントリを `supabase/functions/process-ingestion-job/` に用意し、同一 Service を呼ぶ形にする | `src/lib/jobs/*`                              | Supabase へ deploy                                |

## B. 業務マスター

| #    | 事項                      | 置いた仮定                                                                                                                                                                                      | 影響                                |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| B-1  | CDP 正式質問書            | 著作物のため同梱不可。**架空の縮小版**（C0/C1/C4/C6/C7 相当の 12 問）を `disclosure_framework_versions` + `disclosure_items` へ Seed。年度 Version 差分（新規／変更／継続）を再現できる最小構成 | CDP Workspace / YoY Diff            |
| B-2a | SSBJ ギャップ評価の初期値 | 133 要求事項の適用区分・重要性・3 観点の対応状況を、初年度対応の途中を想定した分布で Fixture 生成（決定論的）。実企業の評価ではない                                                             | SSBJ 対応状況・要求事項一覧         |
| B-2  | SSBJ 正式項目             | **2026-08-25 解消**。SSBJ の転載許可を得て、公表基準の原文から正式マスター 133 項目を収録（src/lib/frameworks/ssbj-2026.ts。一般 33・気候 96・実務対応 4）                                      | SSBJ 画面（一覧・原文・マッピング） |
| B-3  | 排出係数                  | 実係数はライセンス条件が未確定のため、`emission_factors` に**架空値**を Seed。`factor_source = 'FIXTURE (架空値)'` を必ず表示                                                                   | Scope3 Cat.1 算定                   |
| B-4  | 保証手続テンプレート      | 法人別差異が未確定。ISAE3000 相当の一般的な 8 手続を架空テンプレートとして Seed                                                                                                                 | `assurance_procedures`              |
| B-5  | 重要性の基準値            | 未確定。案件フィクスチャで「Scope1+2 合計の 5%」を既定値として設定可能にし、変更履歴を残す                                                                                                      | `engagements.materiality_*`         |

## C. 権限・セキュリティの解釈

| #   | 論点                                                    | 採用した（厳しい側の）解釈                                                                                                                                                              |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | 監査法人管理者（`assurance_admin`）のクライアントデータ | **未アサイン案件は一切閲覧不可**。RLS も `engagement_members` を必須条件にしており、`assurance_admin` の特権バイパスを作らない。法人内のユーザー・テンプレート管理のみ可能              |
| C-2 | 許諾（Grant）取消の即時性                               | `client_access_grants.revoked_at IS NOT NULL` を RLS 条件へ直接組み込み、**次のクエリから即座に不可視**。既存の Signed URL も `storage_access_events` 側で失効判定し、再発行を拒否      |
| C-3 | Snapshot と Grant 取消の関係                            | Snapshot は「その時点で許諾されていた」証跡として残すが、**Grant 取消後は Snapshot 経由でも本文・Evidence を再取得できない**。Snapshot Item のメタデータ（hash / 数値サマリ）のみ閲覧可 |
| C-4 | 監査法人の Review Note                                  | 既定は **法人内部限定**（`shared_with_client = false`）。企業へ見せる場合のみ明示的に共有フラグを立てる。企業側 RLS は `shared_with_client = true` の行しか返さない                     |
| C-5 | 企業ユーザーが監査法人の調書を見る                      | 不可。`assurance_tests` / `workpaper_references` 等は監査法人テナントのみ                                                                                                               |
| C-6 | 代理 Sign-off                                           | 完全禁止。`signoffs.user_id = auth.uid()` を RLS の WITH CHECK に強制。UI にも代理入力欄を置かない                                                                                      |
| C-7 | Demo Mode の認証                                        | 本番 Auth と**完全に別経路**。`demo_session` Cookie（HttpOnly / SameSite=Lax）で、`APP_MODE=demo` のときのみ有効。Supabase Mode ではこの経路自体が 404 を返す                           |
| C-8 | Demo Mode でも RLS 相当の分離を掛けるか                 | 掛ける。`DemoRepository` も `AuthorizationContext` 必須で、越権行はそもそも返さない。「デモだから見える」を作らない                                                                     |
| C-9 | `platform_admin`                                        | Phase 1 ではデータモデルとロールのみ定義。**クライアントデータへのアクセス権は与えない**（ログイン後に案件データを持たない）                                                            |

## D. 技術選択

| #    | 事項                 | 仮定・採用理由                                                                                                                                                                                                                                       |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | RLS テストの実行基盤 | Docker / 実 Supabase 無しでも越権を実証するため **PGlite（WASM Postgres）** を採用。`supabase/migrations/*.sql` をそのまま適用し、`SET LOCAL ROLE authenticated` + `request.jwt.claims` を切り替えて検証する。`SUPABASE_DB_URL` があればそちらを優先 |
| D-2  | `auth.uid()` の互換  | Supabase の `auth.uid()` は `current_setting('request.jwt.claims')::json->>'sub'` 相当。PGlite ハーネス側で同一定義の `auth.uid()` / `auth.jwt()` / `auth.role()` を作成し、本番と同じ SQL を検証する                                                |
| D-3  | Tailwind             | v4 の CSS-first `@theme` を採用。ブランドトークンは `src/app/globals.css` に集約                                                                                                                                                                     |
| D-4  | shadcn/ui            | CLI 実行（ネットワーク対話）を避け、shadcn の実装規約（Radix + `cva` + `cn`）に沿って `src/components/ui` へ**同等のプリミティブを直接実装**。追加理由は README に記載                                                                               |
| D-5  | Excel 入出力         | `exceljs`（純 JS・メンテ継続中）。SheetJS の npm 公開版は既知脆弱性があるため不採用                                                                                                                                                                  |
| D-6  | DOCX 出力            | `docx` パッケージ。指示書 7.1-16「簡易 DOCX」の範囲                                                                                                                                                                                                  |
| D-7  | PDF テキスト抽出     | `unpdf`（pdf.js ベース、サーバーレス互換）。抽出 0 文字／例外時は**成功扱いにせず** `needs_review` + 「OCR／AI解析要確認」                                                                                                                           |
| D-8  | 文字コード           | CSV は BOM 判定 → UTF-8 → Shift_JIS(`TextDecoder('shift_jis')`, Node 24 は full-ICU) の順に試行し、置換文字が閾値を超えたらエラー表示                                                                                                                |
| D-9  | 状態管理             | 大規模ライブラリ不使用。Server Components / Server Actions / URL State（`searchParams`）/ 局所 `useState` のみ                                                                                                                                       |
| D-10 | Realtime             | Phase 1 では Import ジョブ進捗を **Polling**（2 秒間隔・指数バックオフ）で実装。Realtime 差し替え点を `useJobProgress` に隔離                                                                                                                        |

## E. データ・時刻

| #   | 事項         | 仮定                                                                                                                                                 |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1 | タイムゾーン | DB は UTC（`timestamptz`）保存、表示は Asia/Tokyo 固定（`src/lib/format/datetime.ts` の `formatJst`）                                                |
| E-2 | 会計年度     | FY2025 = 2025-04-01〜2026-03-31、FY2026 = 2026-04-01〜2027-03-31（日本の一般的な年度）。`reporting_periods` に開始・終了日を持たせ、境界テストを作成 |
| E-3 | 「本日」     | 実装・Fixture の基準日は 2026-08-14。期限超過 Fixture はこの日付基準で生成                                                                           |
| E-4 | 通貨         | 既定 JPY。`currency_rates` は Phase 1 では固定レート Fixture（EUR/JPY = 168.0）                                                                      |

## F. Phase 1 で意図的に実装しない（指示書 7.3）

以下はデータモデル・Feature Flag・Placeholder 説明までに留め、**動かないボタンを置かない**。
`/enterprise/roadmap` および `/assurance/roadmap`（「今後対応」一覧）にのみ表示する。

- CDP Portal 直接 API 提出 / 双方向 Sync
- MSCI / FTSE 直接 API 連携
- 全 SSBJ / 全 CDP 正式マスター
- 全 Scope3 Category（Cat.1 のみ実装）
- XBRL / iXBRL 提出 Package
- 監査法人既存調書システムとの Sync
- 本番 SSO
- 本番メール通知（通知は `notifications` テーブル + アプリ内 AlertCenter のみ）
- 自律 AI Agent
- 正式 CDP Score 算定
- 保証意見の自動生成・自動確定

## G. 未入手・要確認事項（発注者への確認待ち）

1. Supabase プロジェクト（本番／ステージング）の払い出しと Service Role Key の受け渡し方法
2. OpenAI 組織アカウントと、AI へ送信可能な情報区分（機密区分の定義）
3. CDP / SSBJ 正式マスターの入手経路とライセンス
4. 排出係数データベースの採用元とライセンス
5. 監査法人ごとの調書テンプレート・調書番号採番規則
6. データ保持期間、Legal Hold、削除ポリシー
7. 本番 SSO（IdP 種別・契約）
8. 最大 Upload 容量、同時利用者数、性能目標
