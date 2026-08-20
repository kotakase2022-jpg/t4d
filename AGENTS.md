# T4D 開発規約（AGENTS / CLAUDE 共通）

このファイルと `CLAUDE.md` は同一内容です。どちらを読んでも同じ規約に従ってください。

---

## 0. 何よりも先に守ること

1. **Supabase RLS を無効化しない。** `DISABLE ROW LEVEL SECURITY` を書かない。新しいテーブルを作ったら必ず RLS を有効化し、ポリシーを書き、`pnpm check:rls` と `pnpm test:rls` を通す。
2. **企業テナントと監査法人テナントを混ぜない。** 接続点は `engagements` と `client_access_grants` のみ。
3. **監査法人はクライアント原本を更新しない。** クライアントデータに監査法人向け UPDATE ポリシーを追加しない。
4. **AI は確定しない。** 承認・保証結論・Sign-off を AI が自動で行う経路を作らない。
5. **Secret をクライアントへ渡さない。** `SUPABASE_SERVICE_ROLE_KEY` / `OPENAI_API_KEY` は `import 'server-only'` の付いたモジュールからのみ参照する。
6. **実顧客データを Fixture / Seed / Git へ入れない。**
7. **実ユーザー招待・外部メール送信を行わない。**
   本番 Deploy は 2026-08-15 に発注者から明示的な指示があり、**Demo Mode 限定で解禁**した
   （Vercel プロジェクト `t4d` / https://terrast-t4d.vercel.app ）。
   解禁したのは Deploy だけで、**環境変数は一切設定していない**。
   本番 Supabase・OpenAI API Key・実顧客データを Vercel へ載せることは引き続き禁止。
8. **`main` へ直接 Push しない。** Push 自体も依頼がない限り行わない。

---

## 1. ディレクトリの役割

```
src/app/          ルーティングと画面。Server Component が既定。
                  Server Action は入力の取り出しと revalidate だけを行い、業務ロジックを持たない。
src/components/ui       shadcn/ui 準拠のプリミティブ（Radix + cva + cn）
src/components/shared   AppShell・バッジ・状態表示など画面横断の部品
src/lib/services  業務ロジック。Server Action からも テストからも同じ関数を呼ぶ。
src/lib/repositories  データアクセス。Demo（インメモリ）と Supabase（RLS）の 2 実装。
src/lib/authorization アプリ層の認可（can / assert*）。RLS と対で使う。
src/lib/fixtures  架空データ。Demo Mode・テスト・seed.sql の唯一の生成元。
supabase/migrations   スキーマと RLS。番号順に適用される。
tests/            unit / integration / rls / e2e
```

## 2. コーディング規約

- TypeScript `strict: true` ＋ `noUncheckedIndexedAccess`。`any` 禁止（ESLint エラー）。
- 大規模な状態管理ライブラリを追加しない。Server Components / Server Actions / URL State / 局所 state で足りる。
- ライブラリ追加時は README の「追加ライブラリと採用理由」へ理由を書く。
- 日本語 UI。日時は必ず `src/lib/format/datetime.ts` の `formatJst` 系を通す（DB は UTC、表示は Asia/Tokyo）。
- 色だけで状態を表さない。バッジは必ずラベル＋アイコンを併記する。
- `icon-only` のボタンには `aria-label` を必ず付ける。Focus Ring を消さない。
- コメントは「なぜそうしたか」を書く。自明な処理の説明は書かない。

## 3. 変更を加えるときの手順

1. 影響範囲を確認する（`src/types/domain.ts` → `supabase/migrations` → `src/lib/services` → 画面）。
2. **先に最小テストを書く**（unit か integration）。
3. 実装する。
4. 下の 7 コマンドをすべて通す。
5. `AI_HANDOFF.md` に変更・テスト結果・未解決・次作業を追記する。

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:rls && pnpm test:e2e && pnpm build
```

## 4. スキーマを変更するとき

1. `supabase/migrations/` へ**新しい番号のファイルを追加**する（既存ファイルを書き換えない）。
2. `src/types/domain.ts` の型を更新する。
3. `src/lib/repositories/table-names.ts` の対応表を更新する。
4. RLS を有効化し、ポリシーを書く。追記専用テーブルなら UPDATE/DELETE ポリシーを作らず、`t4d.forbid_mutation()` トリガも付ける。
5. `tests/rls/tenant-isolation.test.ts` に越権テストを追加する。
6. `pnpm seed:generate` で `supabase/seed.sql` を再生成する。
7. 破壊的マイグレーション（DROP COLUMN / DROP TABLE）は行わない。ロールバック方針を `docs/known-limitations.md` へ書く。

## 5. 認可を追加・変更するとき

権限は**必ず 2 か所**に書く。片方だけの変更は禁止。

| 層       | 場所                                                          |
| -------- | ------------------------------------------------------------- |
| アプリ層 | `src/lib/authorization/roles.ts`（`ROLE_PERMISSIONS`）        |
| DB 層    | `supabase/migrations/0002_identity.sql`（`role_permissions`） |

`tests/unit/authorization.test.ts` が両者の一致を検査します。ズレるとテストが落ちます。

## 6. AI を追加・変更するとき

- Use Case を追加したら `src/lib/ai/schemas.ts` に Zod スキーマと `PROMPT_VERSIONS` を追加する。
- 出力には必ず `confidence` / `warnings` / `sources` を含める。
- `MockAIProvider` にも同じ Use Case を実装する（決定論的であること）。
- AI 出力を業務確定値へ直接書かない。必ず「候補」として保存し、人の操作で確定する。
- Prompt に Secret・API Key・権限外 Evidence を含めない。

## 7. テストの禁止事項

- `test.skip` / `describe.skip` / `it.skip` / `test.only` を残さない。
- TODO だけのテスト、Mock で必ず通るだけのテストを書かない。
- 失敗を隠すために期待値を緩めない。**実装側の欠陥ならば実装を直す**
  （例: a11y の contrast 違反はテストを緩めず、ブランドトークンの明度を調整した）。

## 8. 用語

| 用語       | 意味                                                                |
| ---------- | ------------------------------------------------------------------- |
| Data Point | 組織 × 期間 × 指標 × 境界 で一意の非財務データ 1 件                 |
| Engagement | 保証契約。監査法人が所有し、クライアント企業と紐付く                |
| Grant      | 企業が監査法人へ与えるアクセス許諾（指標 / 組織 / 期間 / Evidence） |
| Data Room  | 許諾済みかつ承認済みのクライアントデータの Read-only ビュー         |
| Snapshot   | 保証対象を固定した不変のコピー。以後の変更は差分として検知される    |
| Population | Snapshot から構成した母集団                                         |
| PBC        | Prepared By Client。監査法人から企業への資料依頼                    |
| Sign-off   | prepared → reviewed → partner_approved の 3 段階。代理禁止          |
