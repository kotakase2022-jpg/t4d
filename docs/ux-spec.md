# UX 仕様

指示書 5 章・15 章・16 章に対応。

## 1. 基本

| 項目         | 値                                                                       |
| ------------ | ------------------------------------------------------------------------ |
| 対象         | PC 専用。最小 1280px、主対象 1440 / 1600 / 1920px                        |
| 言語         | 日本語                                                                   |
| タイムゾーン | 表示 Asia/Tokyo 固定（DB は UTC）                                        |
| 密度         | Compact（本文 13px、Table Row 36px、Card Padding 12–16px、Radius 6–8px） |
| Top Bar      | 48px                                                                     |
| Sidebar      | 展開 224px / 折畳 64px（localStorage で保持）                            |

Mobile 専用ナビは作っていません。`t4d-min-canvas`（`min-width: 1280px`）で
横スクロールを許容します。

## 2. ブランド

ロゴは `public/brand/t4d-logo.png` の実体を `next/image` で表示。
高さ 28px 標準・横幅自動・アスペクト比維持・`alt="TERRAST for Disclosure"`・
App Shell 左上に常時表示。変形・切断・再着色はしていません。

### カラートークン（`src/app/globals.css`）

青と白が基調。オレンジはロゴ由来の注意色として、期限超過・警告に限定して使用します。

| トークン                                    | 値                | 備考                                                  |
| ------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `--color-brand-950` … `--color-brand-50`    | #062F63 … #F5F9FF | 指示書の指定値                                        |
| `--color-surface` / `--color-surface-muted` | #FFFFFF / #F5F7FA |                                                       |
| `--color-line`                              | #DDE4EC           |                                                       |
| `--color-ink` / `--color-ink-muted`         | #172033 / #617083 |                                                       |
| `--color-warning`                           | #F5A800           | 指示書の指定値                                        |
| `--color-success`                           | **#12704E**       | 指示書の #16815B は soft 背景で AA 未達のため暗度調整 |
| `--color-danger`                            | **#A61B1B**       | 指示書の #C83B3B は soft 背景で AA 未達のため暗度調整 |

> 変更理由: axe（`pnpm test:e2e`）が `color-contrast` を serious 違反として検出したため。
> 色相は保ち、明度のみ下げています。テストを緩めるのではなく実装を直しました。

大きなグラデーション、過度な Glassmorphism、巨大 Hero、巨大カード、過剰な角丸は使っていません。

## 3. App Shell

```
┌ Top Bar 48px ─────────────────────────────────────────────────┐
│ [T4D ロゴ] Workspace名 期間/案件セレクタ [デモデータ]  通知 ヘルプ ユーザー │
├──────────┬────────────────────────────────────────────────────┤
│ Sidebar  │ main（#t4d-main）                                   │
│ 224/64px │  PageHeader（パンくず / タイトル / 説明 / アクション） │
│          │  本文                                               │
└──────────┴────────────────────────────────────────────────────┘
```

### 企業 Sidebar

ホーム / データ収集 / 非財務データ / 組織・拠点 / Evidence / ワークフロー / GHG /
開示対応（CDP・SSBJ・MSCI・FTSE）/ アラート / AI Copilot / レポート / 設定

### 監査法人 Sidebar

案件ホーム / 保証契約 / スコープ / Data Room / 母集団 / サンプリング / 保証手続・調書 /
PBC／資料依頼 / 指摘・例外 / レビューNote / Sign-off / 監査ログ / Export / 設定

設定は権限がない場合に非表示（Sidebar）＋ 403 相当の表示（画面）になります。

## 4. キーボードショートカット

| キー                 | 動作                                 |
| -------------------- | ------------------------------------ |
| `Ctrl` / `Cmd` + `K` | Command Palette                      |
| `/`                  | 一覧検索へフォーカス（入力中は無効） |
| `Esc`                | Drawer / ダイアログを閉じる          |

ヘルプ（Top Bar の `?`）にショートカット一覧を表示します。
`j` / `k`（次・前レコード）、`e`（Evidence）、`c`（Comment）、`s`（保存）は
ヘルプに記載していますが、Phase 1 では一覧・詳細画面のグローバル割当までは実装していません
（`docs/known-limitations.md` 参照）。三ペインの「次のサンプルへ」は画面上のボタンで提供します。

## 5. 状態表示

Loading / Empty / Error / Permission Denied の 4 状態を `src/components/shared/states.tsx` に集約。
一覧・カードはこれらを使い分けます。Error には常に Retry を添えます。

**色だけで状態を表しません。** すべてのバッジがラベル文字列とアイコンを併記します。

## 6. 一覧の標準機能（指示書 UX-P0-004）

| 機能               | 実装                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 複合フィルター     | `FilterBar`（URL クエリに保持）                                              |
| 検索               | 300ms デバウンス、`/` でフォーカス                                           |
| 保存ビュー         | `FilterBar` の `savedViews`（クエリ文字列のプリセット）                      |
| サーバーページング | `Pagination`（`page` クエリ、既定 25 件）                                    |
| 一括選択・一括操作 | チェックボックス ＋ `BulkActionBar`（提出 / レビュー / 差戻し / 承認）       |
| Sticky Header      | `.t4d-sticky-head`                                                           |
| 横スクロール       | `.t4d-scroll-x`                                                              |
| CSV 出力           | `/api/exports/*`                                                             |
| 詳細               | 一覧 → 詳細ページ（Drawer プリミティブも `components/ui/drawer.tsx` に用意） |

## 7. 三ペイン

### CDP（`/enterprise/disclosures/cdp/[questionId]`）

- 左: 質問ツリー（コード / 新規・変更バッジ / 承認済みチェック）
- 中央: 質問・Guidance・YoY Diff・回答エディタ（numeric / choice / text）・状態遷移
- 右: AI ドラフト（Provenance 付き）・Data Mapping・Version 履歴

### 保証手続（`/assurance/engagements/[id]/testing`）

- 左: Sample 一覧（状態 / 例外 / Reviewed / 固定後変更バッジ）
- 中央: Data Point（Snapshot 固定値 vs 現在値）・Procedure Checklist・再計算・結論
- 右: Evidence Viewer（Signed URL リンク）・抽出テキスト・関連 Issue・調書メタ

画面遷移せずに「次のサンプルへ」進めます。

## 8. ダッシュボード

### 企業（指示書 15.1）

上部 KPI 7 種（期限超過 / 未提出 / Validation Error / Evidence 不足 / Review 待ち /
承認率 / CDP 準備度）。**すべてクリックで対象一覧へ Filter 付き遷移**します。
中央に拠点別進捗 Table・重要アラート・直近 Activity・今日のタスク。

### 監査法人（指示書 16.1）

案件横断 KPI 7 種（Active Engagements / PBC 未受領 / Testing 未完了 / Review 待ち /
未解決 High Issue / Snapshot 後変更 / 期限接近）＋ 案件 Table
（Client / Period / 保証水準 / Progress / PBC / Testing / Issues / Review / Deadline / Sign-off）。

## 9. アクセシビリティ

- `wcag2a` / `wcag2aa` の critical・serious 違反ゼロを E2E で強制（4 画面）
- Focus Ring を消さない（`:focus-visible` に 2px のブランド色アウトライン）
- icon-only ボタンに `aria-label`
- Dialog / Drawer は Radix による Focus Trap ＋ Esc 閉じ
- 「本文へスキップ」リンク（`#t4d-main`）
- 進捗は `role="progressbar"` ＋ `aria-valuenow`
- 状態変化は `aria-live`（取込ジョブの進捗、一括選択件数）
