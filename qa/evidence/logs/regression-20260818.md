# 全件回帰ログ（QA フェーズ 7 / 8・2026-08-18）

実行環境: Windows 11 / Node 22 / pnpm / ローカル Supabase スタック（127.0.0.1:54421）。
`supabase stop` → `start` → `db reset`（migration 0019 適用・seed 再生成）済み。

## フェーズ 8 の修正を反映した最終結果

| ゲート                  | コマンド                 | 結果                                                                         |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| Lint                    | `pnpm lint`              | ✅ エラー 0                                                                  |
| Format                  | `pnpm format:check`      | ✅ All matched files use Prettier code style                                 |
| 型検査                  | `pnpm typecheck`         | ✅ tsc --noEmit エラー 0                                                     |
| RLS 静的検査            | `pnpm check:rls`         | ✅ 合格                                                                      |
| Unit + Integration      | `pnpm test`              | ✅ **301 passed**（25 files）                                                |
| RLS（PGlite 実行）      | `pnpm test:rls`          | ✅ **63 passed**                                                             |
| E2E（Demo・実ブラウザ） | `pnpm test:e2e`          | ✅ **118 passed**（3.3m）                                                    |
| 実 Supabase 通し検証    | `pnpm verify:supabase`   | ✅ **33/33**                                                                 |
| E2E（実 Supabase）      | `pnpm test:e2e:supabase` | ✅ **13 passed**（auth-security 4 ＋ supabase-mode 9。112 画面クロール含む） |
| 本番ビルド              | `pnpm build`             | ✅ Compiled successfully。`/mfa` `/reset` は ƒ Dynamic                       |

合計 **528 件**（301 + 63 + 118 + 33 + 13）が成功、失敗 0。
Supabase E2E は `supabase db reset` 直後のクリーンな DB から実行している。

## フェーズ 7 時点（レビュー前）との差分

- テスト数 262 → **296**（review-fixes 12・safe-link 15・totp 7 を追加）
- Supabase E2E 11 → **13**（招待受諾の実 Auth 通し、再設定リンクの越権拒否）

## 特記事項

- 既知だった「Supabase E2E クロールの flake」は **flake ではなく決定的な障害**（BUG-036:
  middleware が全リクエストで GoTrue `/user` を実行 → GoTrue→Postgres 接続枯渇）だった。
  修正後、同クロール（企業 112 画面・監査法人）は連続 4 回 PASS。
- 途中 1 回だけ Demo E2E が `net::ERR_NO_BUFFER_SPACE` で 1 件落ちたが、これは
  Windows のソケット枯渇（Supabase E2E・Docker との並行実行）による環境要因。
  当該テスト単体・および全件再実行はいずれも PASS。アプリ側の欠陥ではない。
- 無効化されたテスト（`describe.skip` / `it.skip` / `test.only`）は 0 件。
  `tests/e2e/action-audit.spec.ts` に **条件付き** `test.skip(条件, 理由)`（データ不在時のガード）が
  5 か所あるが、実行時にスキップされたテストは 0 件（118 passed / 0 skipped）。
- migration 0019（`metric_definitions.hq_only`）は非破壊の列追加。既存行は false。
