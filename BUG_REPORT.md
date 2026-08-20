# BUG_REPORT — T4D

独立 QA（2026-08-16）・独立検収サブエージェント・直前 2 回の自己検証で発見した不具合の一覧です。
「修正済み」は本 QA までに実装・検証まで完了したもの、「未修正」は本 QA 時点で残っているものです。

重要度の定義

| 重要度   | 定義                                             |
| -------- | ------------------------------------------------ |
| Critical | セキュリティ・権限・データ破損。即時修正が必要   |
| High     | 要求仕様 P0 の未充足、または主要業務フローの停止 |
| Medium   | 主要機能の誤動作・画面遷移不良で、回避策がある   |
| Low      | 表示・軽微な UX                                  |

---

## 修正済み（8 件）

### BUG-012 ／ High ／ DISC-P0-001

**内容**：Data Point 詳細の「開示マッピング」から SSBJ 項目を開くと **404**。

- **再現**：企業ユーザーで SSBJ 項目に紐づく Data Point 詳細 → 開示マッピングのリンクをクリック
- **期待**：該当する開示項目の画面が開く
- **実際**：`/enterprise/disclosures/cdp/<SSBJ項目ID>` へ遷移し 404
- **原因**：リンク先を framework に関係なく `/enterprise/disclosures/cdp/{id}` に固定していた
- **修正**：項目の framework を解決して出し分け。質問単位の詳細を持つのは CDP だけなので、それ以外は一覧へ送る
- **変更**：`src/app/enterprise/data/[dataPointId]/page.tsx`
- **追加テスト**：`screen-audit.spec.ts`（全画面クロールで内部リンクの到達性を検査）
- **回帰**：Demo E2E 全件・Supabase E2E 全件 PASS

### BUG-013 ／ Medium ／ AI-P0-002

**内容**：AI 下書きの「Reject」を押しても**画面が変わらない**。

- **再現**：CDP 質問でドラフト生成 → 「この下書きを Reject」
- **期待**：Reject 済みと分かる表示になる
- **実際**：見た目が一切変わらず、押しても無反応に見える
- **原因**：`rejectAiDraftAction` が一覧しか `revalidatePath` しておらず、押した詳細画面が再検証されない。さらに Reject 済み状態を画面が表示していなかった
- **修正**：詳細と `/enterprise/ai` も revalidate。Reject 済みバッジを表示しボタンを消す
- **変更**：`src/app/enterprise/actions.ts` / `src/app/enterprise/disclosures/cdp/[questionId]/page.tsx`
- **追加テスト**：`action-audit.spec.ts`「AI 下書きを Reject できる」
- **回帰**：全件 PASS

### BUG-014 ／ High ／ ORG-P0-002 関連

**内容**：**期間セレクタが機能しない。** FY2025 を選んでも FY2026 のまま。

- **再現**：企業ユーザーでヘッダーの期間セレクタから FY2025 を選ぶ
- **期待**：対象期間が FY2025 に切り替わる
- **実際**：表示は FY2026 のまま。Cookie を確認すると**選んでいない方（FY2026）の ID** が保存されていた
- **原因**：hidden input に React state を書いてから `requestSubmit()` していたため、state が DOM へ commit される前に submit が走り、**1 つ前の値**が送信されていた
- **影響**：期間を切り替えたつもりで別期間のデータを見続ける恐れ。表示上の不具合より質が悪い
- **修正**：FormData を明示的に組み立てて Server Action を直接呼ぶ（競合が原理的に起きない形へ）
- **変更**：`src/components/shared/selectors.tsx`
- **追加テスト**：`interaction-audit.spec.ts`「期間セレクタで対象期間を切り替えられる」
- **回帰**：全件 PASS

### BUG-015 ／ High

**内容**：ユーザーメニューの**「ログアウト」を押しても何も起きない**。

- **再現**：ユーザーメニュー → ログアウト
- **期待**：ログアウトして `/login` へ
- **実際**：何も起きない。POST が 1 本も飛んでいない（cookie も残る）
- **原因**：Radix がメニューを閉じると中の `<form>` が unmount され、React の非同期 submit が成立しない
- **修正**：`onSelect` で Server Action を直接呼ぶ。同じ構造だった**ワークスペース切替**も同時に修正
- **変更**：`src/components/shared/selectors.tsx`
- **追加テスト**：`interaction-audit.spec.ts`「ユーザーメニューからログアウトできる」
- **回帰**：全件 PASS

### BUG-016 ／ High ／ UX-P0-004

**内容**：一覧の**並べ替えと列表示切替が未実装**（仕様が要求する 10 機能のうち 8 機能しか無い）。

- **再現**：`/enterprise/data` を開く
- **期待**：固定列・列表示切替・並べ替え・複合フィルター・検索・サーバーページング・一括選択・一括操作・保存ビュー・CSV 出力の 10 機能
- **実際**：列表示切替と並べ替えのコントロールが DOM に存在しない（実ブラウザで確認、`qa/evidence/logs/ui-conformance.md`）
- **原因**：未実装
- **修正**：本 QA で実装。並べ替えは **DB 側**（`ORDER BY` ＋ 一意列で安定ページング）、列表示は URL State
- **変更**：`src/components/shared/table-controls.tsx`（新規）／`src/lib/table/columns.ts`（新規）／`src/lib/services/enterprise-data.ts`／`src/app/enterprise/data/page.tsx`
- **追加テスト**：`table-controls.spec.ts` 5 件（昇順降順・1 ページ目復帰・URL 保持・指標列固定・不正入力）
- **回帰**：Demo E2E 73 件・Supabase E2E 9 件・unit 130・RLS 56 すべて PASS

> 実装中、`isColumnVisible` を `'use client'` モジュールへ置いたためサーバーから呼べずビルドが失敗した。
> 純粋関数を `src/lib/table/columns.ts` へ分離して解消（この失敗もテストで検出）。

### BUG-029 ／ **Critical** ／ AUTH-P0-005・EVID-P0-001

**内容**：**他テナントの Evidence を `fileVersionId` 指定で取得できた**（テナント分離の破綻）。

- **再現**：企業 B（蒼天マテリアル）または無関係な監査法人 B（くろべ）でログインし、
  企業 A（青海テクノロジー）の `fileVersionId` を指定して
  `GET /api/files/signed-url?fileVersionId=...` を叩く
- **期待**：404（存在を秘匿）
- **実際**：307 で `/api/files/download` へリダイレクトし、**認可ゲートを通過**していた。
  Fixture ファイルは実体が無いため 410 だが、**実体のある実ファイルなら本文がそのまま返る**。
  リダイレクト先の Location に他社の組織 UUID と `storageKey` も漏れていた
- **原因**：`createEvidenceSignedUrl` が `db.findById` の戻り値の有無だけを見ており、
  **`organizationId` の照合も許諾（grant）検査も engagement 検査も無かった**。
  Supabase Mode は RLS が止めるが、**Demo Mode の `DbClient` に行レベル防御は無い**（単なる配列検索）。
  本番は Demo Mode で動いているため実害があった。
  `/api/files/download` も `bucket` 一致しか見ていなかった
- **修正**：`canReadEvidence()` を新設してアプリ層で明示的に認可
  （自組織 → 可／監査法人 → 案件メンバー ＋ Evidence を含む有効な許諾 ＋ Data Room 対象への紐付けがある場合のみ可）。
  `/api/files/download` にも所有者照合を追加
- **変更**：`src/lib/storage/index.ts` ／ `src/app/api/files/download/route.ts`
- **追加テスト**：`tenant-isolation-audit.spec.ts` の A・A2・D
- **負の対照**：認可を一時的に外すと、テスト A が
  「別テナントは拒否されるべき Expected: false / Received: true」で落ちることを確認済み

### BUG-030 ／ **Critical** ／ AUTH-P0-002

**内容**：**他法人の Issue とレビュー Note を Server Action で書き換えられた**。

- **再現**：監査法人 B のマネージャーで自法人の案件 URL へ POST し、
  フォームに**他法人の `issueId`** を混ぜる（`engagementId` は自法人のもの）
- **期待**：404
- **実際**：200。被害法人の Issue が `resolved` になり、
  **Sign-off の抑止条件（未解決の重要度「高」の指摘）が外部から解除**された。
  監査ログは攻撃者側の engagement に記録されるため、被害側に痕跡が残らない
- **原因**：`resolveIssueAction` ／ `clearReviewNoteAction` は
  `assertEngagementMember(engagementId)` を行うが、
  **対象の `issueId` ／ `noteId` がその案件に属するかを検証していなかった**。
  同じファイルの `decidePbcAction` は正しく検証しており、実装が不揃いだった
- **修正**：対象レコードを引き、`engagementId` の一致を確認してから更新
- **変更**：`src/app/assurance/actions.ts`
- **追加テスト**：`tenant-isolation-audit.spec.ts` の B

### BUG-031 ／ **High** ／ ASSUR-P0-003

**内容**：**他社の許諾（Grant）を取り消せた**。

- **再現**：企業 B の管理者で `/enterprise/settings` へ POST し、企業 A の `grantId` を指定
- **期待**：404
- **実際**：取消が成立し、企業 A と監査法人の間のアクセスを第三者が遮断できた
- **原因**：`toggleGrantAction` が `grantId` の所有者（`clientOrganizationId`）を検証していなかった
- **修正**：自社が付与した許諾であることを確認
- **変更**：`src/app/enterprise/actions.ts`
- **追加テスト**：`tenant-isolation-audit.spec.ts` の C

---

## 追加で修正した P0 未実装（3 件・2026-08-17 バッチ B: CDP 系）

| ID      | 要件ID     | 内容                                               | 実装                                                                          |
| ------- | ---------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| BUG-025 | CDP-P0-002 | 企業別の適用質問判定（適用／非適用／要確認＋根拠） | `src/lib/services/disclosure-applicability.ts`。**規則ベース**（AI ではない） |
| BUG-026 | CDP-P0-003 | 過去回答の Import・構造化（Excel/CSV/PDF/Word）    | `src/lib/services/disclosure-import.ts` ＋ `parsers.ts` の `parseDocx`        |
| BUG-027 | CDP-P0-006 | 整合チェックの画面実行導線                         | `src/lib/services/disclosure-check.ts`。結果は `?check=<aiRunId>` で再読込可  |

判断の記録：

- **適用判定を AI にしなかった理由**：AI 判定は同じ入力でも根拠が揺れるため、
  「なぜ非適用なのか」を監査法人へ説明できません。質問に付いた適用条件
  （`disclosure_item_conditions`）を評価する規則ベースにし、再現性をテストで固定しました。
- **Word 対応で依存を増やさなかった理由**：`.docx` は ZIP なので、Node 標準の `zlib` で
  `word/document.xml` を展開しています（解析専用ライブラリの追加を避けた）。
  実際に `docx` パッケージで生成した .docx を往復させて検証しています。
- **整合チェックは AI が回答を書き換えないこと**を integration テストで固定しました
  （実行前後で回答本文・状態・バージョン数が一致すること）。

---

## 追加で修正した P0 未実装（3 件・2026-08-16 バッチ A）

| ID      | 要件ID        | 内容                                                | 実装                                                                 |
| ------- | ------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| BUG-018 | ORG-P0-001    | 組織階層の登録／編集（連結方法・持分・除外理由）UI  | `src/lib/services/master-data.ts` / `organizations/master-forms.tsx` |
| BUG-019 | ORG-P0-002    | 収集キャンペーン作成（対象組織×指標のスコープ展開） | 同上 ＋ 収集キャンペーンカード                                       |
| BUG-020 | MASTER-P0-001 | 指標マスターの追加／編集 UI                         | 同上                                                                 |

いずれもテナント分離の負ケース（他組織のマスターは編集不可）を含めてテスト済み：
`tests/integration/master-data.test.ts`（16 件）／`tests/e2e/master-data.spec.ts`（4 件）。

---

## 追加で修正した P0 未実装（6 件・2026-08-18 QA フェーズ 6C〜6E）

前回 QA で「未修正」だった 6 件をすべて実装し、実ブラウザ（Demo E2E ＋ Supabase E2E）で検証しました。

| ID      | 要件ID      | 実装内容                                                                                                                                                   | 検証                                                                                                                                         |
| ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-023 | EVID-P0-002 | Evidence Viewer（`/enterprise/evidence/[fileId]`）。画像/PDF の画面内表示、表のセル参照ハイライト、断片ハイライト、メタデータ・関連データ・版の同時表示    | `tests/e2e/mentions-evidence.spec.ts`（6 件）                                                                                                |
| BUG-024 | WF-P0-002   | コメントの @メンション（氏名の正規化完全一致・最長一致優先）と通知作成。ワークフロー差戻しコメントにも適用                                                 | `tests/integration/comments-mentions.test.ts`（11 件）＋ E2E                                                                                 |
| BUG-021 | DATA-P0-004 | 前年度から複製（承認済み→draft）・Excel テンプレート出力（`/api/exports/template`）・コピペ表入力（取込パイプライン経由）                                  | `tests/integration/data-entry-aggregation.test.ts`（11 件）＋ `tests/e2e/data-entry-aggregation.spec.ts`（5 件）                             |
| BUG-022 | DATA-P0-006 | 連結集計（単純合計・持分調整・内部取引控除・連結値・前年推計・加重平均 Σ分子÷Σ分母・単純平均・除外拠点）。GHG 画面に連結集計カード                         | 同上（内部取引 2,490.5 t-CO2e の控除まで数値検証）                                                                                           |
| BUG-017 | AUTH-P0-001 | メンバー招待（**アプリ内リンク方式**・外部メール送信なし）・パスワード再設定（管理者リンク発行→本人設定）・MFA（TOTP 登録→ログイン時コード必須→AAL1 遮断） | `tests/integration/identity.test.ts`（7 件）＋ `tests/e2e/auth-copilot.spec.ts`（2 件）＋ `tests/e2e-supabase/auth-security.spec.ts`（2 件） |
| BUG-028 | AI-P0-001   | AI Copilot 対話（権限内スナップショット限定・出典と参照リンク・会話継続・Provenance 記録）                                                                 | `tests/integration/copilot.test.ts`（8 件）＋ E2E ＋ 実 OpenAI（confidence 0.99）                                                            |

BUG-017 の補足: メール**送信**は恒久制約（CLAUDE.md §0.7）により行いません。招待は画面に表示した
リンクを管理者が手渡す方式、パスワード再設定は Supabase Admin `generateLink`（**リンク生成のみで
送信しない** API）で発行したリンクを管理者が手渡す方式です。制約と要件を両立しています。

---

## 実装中に発見・修正した不具合（5 件・2026-08-18）

| ID      | 重要度   | 内容                                                                                                                                                                  | 修正                                                                                                                                              |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-032 | High     | `seed.sql` 生成（`to-sql.ts buildInsert`）が列名を先頭行のキー順・値を各行のキー順で出しており、プロパティ記述順が違う行は**列ズレした値が DB へ入る**                | 先頭行のキー順で全行の値を引く。未知キーはエラーにする                                                                                            |
| BUG-033 | High     | MFA/再設定のリダイレクト先が `/auth/mfa` `/auth/reset`（存在しないパス）で 404。`(auth)` はルートグループでありパスに現れない                                         | `/mfa` `/reset` へ修正                                                                                                                            |
| BUG-034 | High     | CSP `connect-src` が `*.supabase.co` 固定で、production ビルドではブラウザ→Supabase Auth（MFA・再設定）の fetch が**全てブロック**され無限リトライ                    | 設定された `NEXT_PUBLIC_SUPABASE_URL` の origin を `connect-src` へ動的追加                                                                       |
| BUG-035 | High     | `/reset` `/mfa`（'use client' 単体ページ）がビルド時に静的化され、middleware の per-request CSP nonce と不一致→**スクリプト全ブロック・hydration 不能**               | サーバーラッパー＋ `export const dynamic = 'force-dynamic'` 化                                                                                    |
| BUG-036 | Critical | middleware が**全リクエスト**（プリフェッチ・アセット込み）で GoTrue `/user` を呼び、高負荷時に GoTrue→Postgres の接続枯渇（500 連発）→**セッション喪失に見える障害** | middleware は `getSession()`（期限内はネットワークなし）へ。真正性検証は `session.ts` の `getUser()`（React `cache()` でリクエスト内 1 回）が担う |

BUG-036 は実 Supabase E2E の 112 画面クロールで再現し（`/user` 3,000 回超→ `cannot assign requested address`）、
修正後は同クロールが安定して PASS します。

---

## 独立最終レビューで発見・修正（12 件・2026-08-18 フェーズ 8）

変更範囲を 4 観点（セキュリティ／集計・入力／AI・コメント／規約・回帰）で独立レビューし、
出た所見を全件コードで再確認したうえで修正しました。

| ID      | 重要度       | 内容                                                                                                                                              | 修正                                                                                                                                                 |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-037 | **Critical** | `issuePasswordResetLink` が対象メールの所属を照合せず、**他テナント（監査法人・別企業）の回復リンクを発行できた**。発行が監査ログにも残らなかった | 自組織のアクティブメンバーであることをサーバー側で照合。発行を `audit_events` へ記録                                                                 |
| BUG-038 | High         | Supabase Mode で招待受諾が構造的に不動作（RLS で招待行を読めず、`profiles.id` は `auth.users` への FK のため書き込みも失敗）                      | 招待受諾のみ service-role 経由に限定（`getInvitationAcceptDb`）。受諾時に `createUser`（**メール送信なし**）でアカウント作成、パスワードは本人が設定 |
| BUG-039 | High         | 内部取引の明細行が Data Room・Snapshot・母集団へ共有され、母集団合計が 2,490.5 t-CO2e 過大に。欠損件数も 0 になり完全性手続が壊れていた           | 共有対象から `isCountedInTotals` で除外                                                                                                              |
| BUG-040 | Medium       | 招待 ID が決定論的ハッシュ（組織 ID＋メール＋作成時刻の FNV-1a）で、リンクが推測可能だった                                                        | `crypto.randomUUID()`（CSPRNG）へ変更                                                                                                                |
| BUG-041 | Medium       | 前年比検証の照合キーに boundary が無く、内部取引の明細行が前年の連結合計と比較されて虚偽の警告が出ていた                                          | 照合キーへ boundary を追加（重複検出キーと粒度を統一）                                                                                               |
| BUG-042 | Medium       | 標準テンプレートの「本社のみ」判定がカテゴリ推測で、拠点別の従業員数行が欠落し、本社限定の Scope3 Cat.1 が全拠点に出力されていた                  | `metric_definitions.hq_only` を追加（migration 0019）し、判定をデータモデルへ移管。指標マスター UI にも項目追加                                      |
| BUG-043 | Low          | AI 出力・通知の href 検証が `..` / `%2e%2e` を許し、`/enterprise/` 外（監査側画面・GET API）へ誘導できた                                          | `src/lib/security/safe-link.ts` に集約し、デコード後にパス正規化して `/enterprise/` 配下を強制                                                       |
| BUG-044 | Low          | メンションが正規化衝突（"田中 太郎" と "田中太郎"）時に片方へしか通知されず、依頼が黙って届かなかった                                             | 一致する全員へ通知（取りこぼしより過剰通知を優先）                                                                                                   |
| BUG-045 | Low          | 開示回答へのコメントが `enterprise.data.read` だけで通り、開示画面を閲覧できないロールが Server Action 直叩きで書き込めた                         | 対象種別に応じて `enterprise.disclosure.read` を要求                                                                                                 |
| BUG-046 | Low          | 遷移コメント（差戻し理由）が `addComment` の 2,000 文字制限を迂回していた                                                                         | `assertValidCommentBody` を共通化し両経路で適用                                                                                                      |
| BUG-047 | Low          | 内部取引 fixture が Evidence 必須指標なのに Evidence 無しで承認済みとなり、品質指標に `missing_evidence` 2 件のノイズが乗っていた                 | 購買台帳を紐付け（アプリの承認ゲートで到達可能な状態に揃えた）                                                                                       |
| BUG-048 | Low          | 再設定リンク（アカウント乗っ取り相当のトークン）を `httpOnly:false` の Cookie で渡していた                                                        | `httpOnly:true` ＋本番 `secure` へ。表示はサーバーコンポーネントが Cookie を読んで行う                                                               |

回帰テスト: `tests/integration/review-fixes.test.ts`（12 件）、`tests/unit/safe-link.test.ts`（15 件）、
`tests/e2e-supabase/auth-security.spec.ts` に招待受諾（実 Auth でアカウント作成→ログイン）と
再設定リンクの越権拒否を追加（計 4 件）。

---

## 修正の自己検証で追加発見（2 件・2026-08-18）

「フェーズ 8 の修正が新たな欠陥を生んでいないか」を自分で検証する過程で見つけたものです。

| ID      | 重要度 | 内容                                                                                                                                                                        | 修正                                                                                     |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| BUG-049 | Medium | 新設した `isSafeAppLink` がデコード後に文字種チェックを再適用しており、**クエリに日本語を含む正当なリンク**（例: `/enterprise/data?unit=%E6%9C%AC%E7%A4%BE`）まで弾いていた | デコード後は scheme・バックスラッシュ・制御文字だけを拒否し、`..` はパス正規化で判定する |
| BUG-050 | Low    | 遷移コメントへ 2,000 文字検証を入れた際、**空白だけの差戻し理由**が例外になっていた（従来は無視されていた）                                                                 | 空白のみは「コメント無し」として扱い、中身がある場合だけ検証する                         |

併せて、CSP の `connect-src` へ入れる Supabase origin を http/https に限定しました
（`javascript:` などが設定された場合に `null` が混ざらないように）。

---

## 自己検証（2026-08-20）で発見・修正（3 件）

本番を実操作で検証したところ、**本番（Vercel の Demo Mode）でのみ再現する**問題が 3 件見つかった（BUG-056 は検証スクリプト側の問題）。
いずれもローカル（単一プロセス）では再現しない。

| ID      | 重要度 | 内容                                                                                                                                                    | 修正                                                                                                                                                    |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-053 | High   | AI Copilot が本番で回答を表示しない。`?chat=<id>` へリダイレクトして会話を読み直す設計のため、別インスタンスに当たると会話が見つからず空のままだった    | リダイレクトをやめ、Server Action が回答を返してクライアントが保持する方式へ（`copilot-chat.tsx`）                                                      |
| BUG-054 | High   | 保存した内容がリロードで消える（マテリアリティ評価・コメント・値編集）。Demo Mode の状態は `globalThis` にしか無く、インスタンスをまたぐと失われる      | 人の操作だけを Cookie に控えて読み取り時に再適用する仕組みを追加（`demo-persistence.ts`）。あわせて `vercel.json` でリージョンを `hnd1` に固定          |
| BUG-055 | Medium | 取込直後のジョブ画面が 404 になることがある（同上の理由）                                                                                               | 取込系テーブルも Cookie 永続化の対象にし、それでも参照できない場合は**取込直後に限り**理由を説明する画面を出す（存在秘匿のため、それ以外は 404 のまま） |
| BUG-056 | Low    | `pnpm verify:supabase` を同じ DB で 2 回走らせると 4 件が失敗し、**RLS が壊れたように見える**。実際は Sign-off と許諾が追記専用で消せないための重複キー | 実行前に自分の書き込み跡を検知し、`supabase db reset` を促して終了する（exit 2）。RLS の異常ではないと明示する                                          |

**再現条件**: Vercel が同一セッションを別インスタンスへ振り分けたとき。
本番スモークで 1 回目失敗・リトライで成功、という形で表面化した。

**検証**: 修正後、本番スモーク 8 件を連続 3 回実行して 8/8 × 3 回 PASS。

---

## 未修正（0 件）

本 QA（2026-08-18 完了）時点で、未修正の不具合・P0 未充足はありません。
