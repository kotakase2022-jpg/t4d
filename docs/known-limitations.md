# 既知の制約（Known Limitations）

正直に書きます。「動いているように見えるだけ」の箇所を残さないための一覧です。

---

## 1. 環境に起因するもの

| #   | 制約                                                                              | 影響                                                                                                                                                                                                                                                                  | 解消方法                                                                                            |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| E-1 | **リモート（本番／ステージング）Supabase へは Migration を適用していない**        | ローカルスタック（Supabase CLI）へは全 migration + seed を適用し、Auth・RLS・Storage を実接続で検証済み（`pnpm verify:supabase` 33/33、`pnpm test:e2e:supabase` 7/7）。リモート固有の設定（カスタムドメイン・SMTP・レプリカ）は未確認                                 | プロジェクト払い出し後に `supabase db push` ＋ `seed.sql`                                           |
| E-2 | ~~RLS の検証は PGlite 上のみ~~ → **解消済み**                                     | PGlite（56 件）に加え、実 Supabase に対しても `pnpm verify:supabase` で 33 項目を検証している（Storage の public/private を含む）                                                                                                                                     | —                                                                                                   |
| E-3 | ~~OpenAI API を実際に呼んでいない~~ → **解消済み**（Model: `gpt-5.6-terra`）      | `pnpm verify:openai` で疎通を、アプリの CDP ドラフト生成で通し動作を確認済み。ただし**確認したのは `cdpDraftGeneration` と `anomalyExplanation` の 2 Use Case**で、残り 6 Use Case の実通信は未確認（スキーマ適合は unit テスト済み）                                 | 各 Use Case を対象画面から 1 回ずつ実行して確認                                                     |
| E-4 | ~~Vercel へ Deploy していない~~ → **解消済み**（https://terrast-t4d.vercel.app ） | **Demo Mode 限定**（環境変数を一切設定していない）。**2026-08-16 に発注者の指示で Deployment Protection を無効化**し、URL を知っていれば誰でも閲覧できる状態にした。Demo ログインはパスワード不要なため、**URL を知る全員が全画面を操作できる**（データはすべて架空） | 再び限定公開にするなら Vercel Authentication を有効へ戻す（`vercel api /v9/projects/t4d -X PATCH`） |

## 2. Demo Mode 固有

| #   | 制約                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- |
| D-1 | データはサーバープロセスのメモリ上にあり、**再起動で初期状態へ戻る**                                    |
| D-2 | アップロードしたファイルの実体もメモリ上。Fixture 由来のファイルは実体を持たず、開くと 410 と説明を返す |
| D-3 | 複数プロセス（Vercel の複数インスタンス等）では状態が共有されない。Cookie による緩和あり（下記）        |
| D-4 | Demo ログインはパスワード不要。`NEXT_PUBLIC_APP_MODE=demo` のときのみ有効で、本番 Auth とは別経路       |

### D-3 の実害と緩和策（2026-08-20 追記）

本番（Vercel の Demo Mode）で実操作を検証したところ、インスタンスをまたぐと
「保存したのにリロードで消える」「取込直後のジョブ画面が 404 になる」
「Copilot の回答が表示されない」が起きていた。恒久制約により外部ストアは使えないため、
次の 3 段構えで緩和している。

1. `vercel.json` で `regions: ["hnd1"]` を指定し、インスタンスの分散を抑える。
2. `src/lib/repositories/demo-persistence.ts` が、人の操作（評価・コメント・値編集・小さな取込）を
   **変更のあった列だけ** Cookie（httpOnly・約 3.8KB 上限・8 時間）に控え、読み取り時に Fixture へ再適用する。
   上限を超えた分は古い操作から捨てる。
3. Copilot のように「作った直後に見せる」ものは、リダイレクトせず Server Action の戻り値で描画する。

取込のプレビューは **ブラウザの sessionStorage（数 MB）** で持ち回す（2026-08-24 変更）。
投入時に Server Action が解析まで終わらせてプレビュー内容を返し、タブが預かる。
確定時はフォームが期間と元資料の位置も一緒に送るため、確定のリクエストが
ジョブを持たないインスタンスへ届いても台帳へ反映できる。

| 一括取込        | 本番 Demo Mode     | ローカル Demo Mode | Supabase Mode  |
| --------------- | ------------------ | ------------------ | -------------- |
| 50 ファイルまで | 動く（本番で実測） | 動く               | 動く           |
| 51 ファイル以上 | 件数付きで拒否     | 件数付きで拒否     | 件数付きで拒否 |

**残る制約**: 本番 Demo Mode のプレビューは**投入したタブでのみ**参照できる。
別のブラウザ・別のタブ・タブを閉じた後は表示できず、理由を説明する画面を出す
（存在秘匿のため、取込直後以外の未知 ID は 404 のまま）。
評価・コメント・値編集などの小さな操作は引き続き Cookie でも持ち回している。
Supabase Mode では DB を共有するため、これらの制約は無い。

## 3. 実装の範囲

### 使っていないテーブル

| テーブル                                                         | 状況                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_feedback`                                                    | 作成と RLS だけあり、アプリからは読み書きしない。AI 出力の採否は `ai_runs`（status / reviewed_by / accepted_at / rejected_at）と `audit_events` に残るため、Phase 1 では二重に持たない |
| `user_preferences`                                               | Phase 1 未使用。表示設定は URL とローカル状態で持つ                                                                                                                                    |
| `aggregation_runs`                                               | Phase 1 未使用。集計はリクエストごとに計算する                                                                                                                                         |
| `workflow_definitions` / `workflow_instances` / `workflow_steps` | Phase 1 未使用。データの承認は `data_points.status` と `data_point_approval_steps`（最大 5 階層）で表す                                                                                |
| `ai_jobs`                                                        | Phase 1 未使用。AI は同期実行し `ai_runs` に残す                                                                                                                                       |
| `ai_sources`                                                     | Phase 1 未使用。出典は `ai_runs.source_references` に持つ                                                                                                                              |
| `workpaper_references`                                           | Phase 1 未使用。調書番号は `assurance_tests.workpaper_ref` に持つ                                                                                                                      |

この一覧は `tests/unit/schema-parity.test.ts` が検査する（対応表にも理由にも無いテーブルがあると落ちる）。

| #    | 制約                                                                                                                                                  | 補足                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-1  | ~~一覧のページングは取得後にメモリ内で分割~~ → **解消済み**。非財務データ一覧は DB 側で絞り込み・並べ替え・LIMIT/OFFSET する                          | 検証結果を `validation_results` へ materialize し、`flag=validation_error` も DB 側で引けるようにした（`src/lib/services/validation-store.ts`）。他の小規模一覧（案件配下など）は件数が二桁のため従来どおり                                                  |
| S-2  | 列表示切替・列幅・密度の**個人保存**は未実装                                                                                                          | `user_preferences.saved_views` の器はある（P1: UX-P1-001）                                                                                                                                                                                                   |
| S-3  | ~~キーボードショートカット `j`/`k`/`e`/`c`/`s` は未実装~~ → **解消済み**                                                                              | `src/components/shared/record-shortcuts.tsx`。対象が無い画面では何も起きない。`s` は**下書き保存だけ**に割り当て、提出・承認・Sign-off には割り当てない                                                                                                      |
| S-4  | Realtime 未使用。取込進捗は Polling（指数バックオフ最大 8 秒）                                                                                        | 差し替え点は `JobPoller` に閉じている                                                                                                                                                                                                                        |
| S-5  | Edge Function は雛形のみ。ワーカーは Route Handler（`GET /api/jobs/[jobId]`）が兼ねる                                                                 | `processIngestionJob()` をそのまま呼べる構造                                                                                                                                                                                                                 |
| S-6  | ~~CSP に `'unsafe-inline'` / `'unsafe-eval'` を含む~~ → **script-src は解消済み**。`style-src` のみ `'unsafe-inline'` が残る                          | `src/middleware.ts` がリクエストごとに nonce を発行し `script-src 'self' 'nonce-…' 'strict-dynamic'` を設定する（`'unsafe-eval'` は開発時のみ）。`style-src` は Next.js / Tailwind が挿入する style 要素のため残置（スタイル経由の任意コード実行は起きない） |
| S-7  | ~~Evidence Viewer は Signed URL リンク＋抽出テキストのみ~~ → **解消済み（2026-08-18）**                                                               | `/enterprise/evidence/[fileId]` で画像/PDF の画面内表示・表のセル参照ハイライト・断片ハイライト・メタデータ/関連データ/版の同時表示。インライン配信は `/api/files/inline`（png/jpeg/gif/webp/pdf のみ）                                                      |
| S-8  | サプライヤーポータル（外部画面）は未実装                                                                                                              | P1: SUP-P1-001                                                                                                                                                                                                                                               |
| S-9  | ~~集計（連結・加重平均・内部取引控除）はデータモデルのみ~~ → **解消済み（2026-08-18）**                                                               | `computeConsolidatedAggregation`（単純合計・持分調整・内部取引控除・連結値・前年推計・加重平均 Σ分子÷Σ分母・単純平均・除外拠点）。GHG 画面に連結集計カード。`aggregation_runs` の永続化は未使用（画面表示時に都度計算）                                      |
| S-10 | Soft Delete の UI（削除操作）は未提供                                                                                                                 | `deleted_at` 列と RLS の除外条件は実装済み                                                                                                                                                                                                                   |
| S-11 | **Loading 境界（`loading.tsx` / Layout 内 `<Suspense>`）を置いていない** ため、遷移中のスケルトン表示がなく、サーバー応答を待ってから画面が切り替わる | Next.js 15.5.23 の不具合回避（下記 10 章）。ページ内の部分的な Loading 表示は各 Component が持つ                                                                                                                                                             |
| S-14 | コメントの投稿はサービス層では**組織メンバー＋対象種別の read 権限**で許可する（UI の導線は write 権限者にだけ表示）                                  | `docs/rls-matrix.md` の定義（org member scope・本人が INSERT）と RLS に合わせている。閲覧者が疑義を書ける方が実務に合うための意図的な緩さで、書けるのは自組織の内部コメントのみ                                                                              |
| S-13 | 招待受諾（`/invite/[id]`）だけは RLS をバイパスする service-role 経路で処理する                                                                       | 受諾者はまだメンバーではなく RLS 下では招待行を読めないため。資格は招待 ID（CSPRNG の UUID・14 日で失効）のみで、`getInvitationAcceptDb()` の用途をこの経路に限定している。本番運用ではハッシュ化トークン＋短期失効へ強化する                                |
| S-12 | AI の**推定コストは単価表（`COST_PER_MTOK`）に載っている Model でしか算定しない**                                                                     | 未登録 Model では `ai_runs.estimated_cost_usd` に 0 を記録し、画面は「—」と表示する。`gpt-5.6-terra` は未登録のため現状「—」。公式価格を確認してから `src/lib/ai/openai-provider.ts` へ追記すること（**推測した単価を入れない**）                            |

## 4. マスターデータ

| #   | 制約                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-1 | CDP は**架空の縮小マスター**（12 問。正式質問書は CDP ポータル登録制のため未収録。バッジを常時表示）。SSBJ は転載許可を得て**正式基準 133 項目**を収録済み（2026-08-25。出所表記を画面と Export に常時表示） |
| M-2 | 排出係数は**架空値**。`factor_source` に「FIXTURE（架空値・実係数ではありません）」を保持し画面表示                                                                                                          |
| M-3 | 保証手続テンプレートは ISAE3000 相当の一般的な 8 手続の架空版。法人別差異は未反映                                                                                                                            |
| M-4 | Scope3 は Category 1 のみ                                                                                                                                                                                    |

## 5. Phase 1 実装対象外（指示書 7.3）

アプリ内の `/enterprise/roadmap` に理由付きで一覧しています。**動作しないボタンは置いていません。**

CDP Portal 直接 API 提出 / CDP Portal 双方向 Sync / MSCI・FTSE 直接 API 連携 /
全 SSBJ・全 CDP 正式マスター / 全 Scope3 Category / XBRL・iXBRL 提出 Package /
監査法人既存調書システムとの Sync / 本番 SSO / 本番メール通知 / 自律 AI Agent /
正式 CDP Score 算定 / 保証意見の自動生成・自動確定（**これは恒久的に実装しない**）

## 6. Migration のロールバック方針

- **破壊的マイグレーションを行わない。** `DROP TABLE` / `DROP COLUMN` / 型の縮小変更は禁止。
- 列の廃止は「使用停止 → 一定期間後に削除」の 2 段階とし、削除は別リリースで行う。
- ロールバックは「打ち消す新しい migration を追加する」方針（`supabase/migrations` は追記のみ）。
- 適用前に必ず `pnpm test:rls` を通す（PGlite に対して全 migration を最初から適用するため、
  順序依存の破綻を検出できる）。
- Seed は `pnpm seed:generate` で再生成する。手で編集しない。

### 0026〜0031 のロールバック

いずれも列追加・制約差し替え・テーブル追加のみで、既存データを壊さない。

| Migration                              | 打ち消し方                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0026_metric_frameworks`               | `frameworks` 列と GIN 索引を無視する。`category` の CHECK は `climate_transition` を除いた式へ戻す（該当行があるなら先に別分類へ移す） |
| `0027_ingestion_row_ignored`           | `status` の CHECK から `ignored` を外す。該当行は `needs_review` へ寄せる                                                              |
| `0028_ssbj_analysis_settings`          | テーブルを使わない。分析条件が未確定の扱いへ戻るだけで、他の工程は動く                                                                 |
| `0029_approval_routes`                 | 3 テーブルを使わない。承認は `data_points.status` の単段階へ戻る（履歴は残る）                                                         |
| `0030_ssbj_disclosure_drafts`          | テーブルを使わない。開示ドラフトは DOCX 書き出しだけへ戻る                                                                             |
| `0031_materiality_topics_user_managed` | `deleted_at` を無視し、部分一意インデックスを元の一意制約へ戻す（削除済み行があるなら先に整理する）                                    |

## 7. データ保持・削除

- `deleted_at` による Soft Delete と `audit_events` の追記型ログを**区別**している。
- Soft Delete しても監査ログは残る（追記専用のため物理削除できない）。
- 保持期間・Legal Hold・物理削除ポリシーは未確定（`docs/assumptions.md` G-6）。
  データモデルとしては `assurance_procedures` / 案件ポリシーに保持設定を追加できる構造。

## 8. 依存関係の脆弱性

`pnpm audit` の結果は `AI_HANDOFF.md` に記録しています。
`canvas`（pdf.js の任意依存・ネイティブビルド）は `pnpm-workspace.yaml` の
`allowBuilds` で **false** にしており、ビルドスクリプトを実行していません。

### uuid（exceljs 経由・moderate 1 件を受容）

`pnpm audit --prod` は `.>exceljs>uuid` に GHSA-w5hq-g745-h8pq（moderate）を報告する。
**受容する。** 理由:

- 指摘は uuid の **v3 / v5 / v6 に `buf` 引数を渡したときの境界チェック漏れ**。
- exceljs が使うのは `v4` だけで（`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`）、`buf` 引数も渡さない。
- 修正版の uuid 11 以降は **ESM only** のため、CommonJS の exceljs が `require('uuid')` に失敗する。
  実際、`uuid: '>=11.1.1'` を全体へ適用していた間、**Vercel 上で Excel の取込が PROCESSING_FAILED で全滅していた**
  （ローカルの vitest / dev は ESM 解決のため再現しない）。
- そのため `pnpm-workspace.yaml` で `exceljs>uuid: '8.3.2'` を固定している。exceljs 以外は 11 以降のまま。

代替（exceljs を ESM 対応ライブラリへ置換）は影響範囲が大きいため Phase 2 以降で検討する。

## 9. パフォーマンス

- 本番相当の同時利用者数・データ量での測定は未実施（`docs/assumptions.md` G-8）。
- 現状の想定: 1 テナント・1 期間あたり Data Point 数百件、Evidence 数百件。
- 主要一覧はサーバー側で取得しており、全件をブラウザへ一括 Load していない。
- 非財務データ一覧は DB 側で絞り込み・並べ替え・LIMIT/OFFSET する（S-1）。
- 検索は 300ms デバウンス。

## 10. Framework の不具合とその回避（Next.js 15.5.23）

### 症状

Layout と Page の間に **Suspense 境界**（`loading.tsx`、または Layout 内で `{children}` を
`<Suspense>` で包む書き方）があると、Client 側の遷移（`<Link>` クリック）が確定しないことがある。

- RSC Payload はサーバーから **200 で完全に返っている**（本文も欠けていない）
- それでも URL が変わらず、画面も切り替わらない
- Console エラー・CSP 違反・ネットワークエラーは一切出ない（**無言で固まる**）

上流 Issue: https://github.com/vercel/next.js/issues/86151

### 本アプリでの再現条件

`/assurance/engagements` から `/assurance/engagements/[engagementId]/overview` への
遷移で **100% 再現**した（Supabase Mode・本番ビルド）。Demo Mode では
サーバー応答が速いため間欠的にしか出ず、E2E を通しで流したときだけ落ちていた。
上流 Issue のとおり「ページの描画が重い／Payload が大きいほど出やすい」挙動と一致する。

### 回避策

`src/app/enterprise/loading.tsx` と `src/app/assurance/loading.tsx` を**削除**し、
Layout 内にも `<Suspense>` を置かない。Layout 内 `<Suspense>` でも同じように固まることを
実機で確認済みなので、**loading.tsx を Suspense へ置き換えるだけでは回避できない**。

トレードオフは S-11 のとおり（遷移中のスケルトンが出ない）。PC 前提の社内システムで
サーバーが同一 VPC 内にある想定のため、Phase 1 では許容する。

### 回帰検出

`tests/e2e/vertical-slices.spec.ts` の `Client 側遷移` describe が、
企業・監査法人の両ワークスペースで「未訪問ルートへの `<Link>` クリックで URL と本文が
切り替わる」ことを検証する。Loading 境界を復活させるとここが落ちる。

### 解消の見込み

Next.js 16 系で修正 PR（vercel/next.js#95391）が取り込まれている。
16 へ上げる際は、この回避策を外して上記 E2E が通るかを最初に確認すること。

## 11. 要求仕様 P0 の未充足（2026-08-16 の独立 QA で検出 → 2026-08-18 全件解消）

機能要件一覧 v0.2 の **P0（必須）61 件のうち 12 件が未充足**でした。
2026-08-16 に 3 件（バッチ A）、2026-08-17 に 3 件（バッチ B）、2026-08-18 に残る 6 件（QA フェーズ 6C〜6E）を実装し、
**未充足は 0 件**になりました。各件の実装内容と検証は `BUG_REPORT.md`、
要件との対応は `REQUIREMENTS_TRACEABILITY.csv`（PASS 120 / OUT_OF_SCOPE 57 / FAIL 0）を参照してください。

| 要件ID      | 内容                                                     | 状態                    |
| ----------- | -------------------------------------------------------- | ----------------------- |
| AUTH-P0-001 | 招待・パスワード再設定・MFA                              | PASS（2026-08-18 解消） |
| DATA-P0-004 | 前年度複製・Excel テンプレート出力／再取込・コピペ表入力 | PASS（2026-08-18 解消） |
| DATA-P0-006 | 加重平均・内部取引控除・推計                             | PASS（2026-08-18 解消） |
| EVID-P0-002 | Evidence の画面内表示・該当箇所ハイライト                | PASS（2026-08-18 解消） |
| WF-P0-002   | コメントのメンション                                     | PASS（2026-08-18 解消） |
| AI-P0-001   | AI Copilot の対話支援                                    | PASS（2026-08-18 解消） |

### 仕様間の競合

**AUTH-P0-001 の「メール招待」は、本文書 0 章の恒久制約「外部メール送信を行わない」と競合していました。**
資料の優先順位（追加決定事項 ＞ 要求仕様書）に従い、**メールを送信しない方式**で要件を充足しました:
招待は**アプリ内リンク方式**（画面に表示したリンクを管理者が本人へ手渡す）、
パスワード再設定は Supabase Admin `generateLink`（**リンク生成のみで送信しない** API）による発行方式です。
外部メール送信は一切行っていません。

### 解消済み

- **UX-P0-004（一覧操作の標準化）** は列表示切替と並べ替えを実装し、
  仕様が要求する 10 機能すべてを充足しました（`tests/e2e/table-controls.spec.ts` 5 件）。
- **CDP-P0-002 / CDP-P0-003 / CDP-P0-006** は 2026-08-17（バッチ B）に実装しました。
  適用質問判定（規則ベース。AI にしていないのは判定根拠を再現・説明可能にするため）、
  過去回答 Import（Excel / CSV / PDF / **Word**。`.docx` は Node 標準 `zlib` で展開）、
  整合チェックの画面実行導線。
  `disclosure-applicability.ts` / `disclosure-import.ts` / `disclosure-check.ts`、
  integration 30 件・unit 18 件・E2E 9 件。
- **MASTER-P0-001 / ORG-P0-001 / ORG-P0-002** は 2026-08-16（バッチ A）に実装しました。
  指標マスター管理・組織階層編集（連結方法／持分／除外理由）・収集キャンペーン作成。
  `src/lib/services/master-data.ts`、`tests/integration/master-data.test.ts`（16 件）、
  `tests/e2e/master-data.spec.ts`（4 件）。テナント分離の負ケースも含む。
