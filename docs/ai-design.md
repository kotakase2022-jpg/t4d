# AI 設計

指示書 14 章に対応。**AI は候補を提示するだけで、何も確定しません。**

---

## 1. Provider Interface

```ts
interface AiProvider {
  readonly kind: 'openai' | 'mock';
  readonly model: string;
  run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>>;
}
```

| 実装             | 使用条件              | 特徴                                                                   |
| ---------------- | --------------------- | ---------------------------------------------------------------------- |
| `OpenAIProvider` | `OPENAI_API_KEY` あり | 公式 SDK / Responses API / `zodTextFormat` による構造化出力            |
| `MockAIProvider` | Key なし（既定）      | **決定論的**。入力ハッシュから安定生成。UI に「Mock / AI未接続」バッジ |

`getAiProvider()` が切り替えます。呼び出し側は具象を知りません。
Model 名は `OPENAI_MODEL` で差し替え可能（コードに固定しない）。

疎通は `pnpm verify:openai` で確認できます（**1 リクエストだけ**送り、Model 名の実在・
Responses API の構造化出力・Zod スキーマ適合を検証）。
確認済み Model: `gpt-5.6-terra`（推論 Model。`output_tokens` に reasoning 分を含む）。

> `openai` SDK は v7 系が必要です。v4 系は同梱の `node-fetch` v2 が現在の API の応答を読めず、
> 全 Model・全 Endpoint で `ERR_STREAM_PREMATURE_CLOSE` になります（README「追加ライブラリと採用理由」）。

## 2. Use Case（8 種）と構造化出力

すべて Zod スキーマで検証します（`src/lib/ai/schemas.ts`）。
**Free Text をそのまま業務確定値へ入れません。**

| feature                    | 用途                    | 主な出力                                                                                        |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `importMapping`            | 取込行の項目マッピング  | rows[]（metricCode / unitCode / value / unitOfMeasure / confidence / warnings / sourceLocator） |
| `anomalyExplanation`       | 異常値の原因候補        | findings[]（likelyCause / suggestedAction / severity）                                          |
| `cdpQuestionMapping`       | 質問 ↔ 指標の対応候補   | mappings[]（itemCode / metricCode / rationale）                                                 |
| `cdpDraftGeneration`       | 開示回答ドラフト        | draftText / draftNumeric / changeSummary / missingInformation                                   |
| `evidenceMapping`          | Evidence 該当箇所の候補 | candidates[]（fileVersionId / page / excerpt）                                                  |
| `inconsistencyCheck`       | 矛盾・陳腐化            | issues[]（kind / subject / detail / severity）                                                  |
| `assuranceEvidenceSummary` | Evidence 要約（監査）   | summary / keyFigures / **pointsToVerify**                                                       |
| `assuranceChangeSummary`   | Snapshot 後変更の要約   | changes[]（possibleImpact / suggestsRetest）                                                    |

全スキーマが `confidence`（0..1）/ `warnings` / `sources` を**必須**にしています。
`tests/unit/ai-schema.test.ts` がこれを検査します。

## 3. Provenance（ai_runs へ必ず記録）

| 列                                                       | 内容                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `feature_type` / `provider` / `model` / `prompt_version` | 何を・どの実装で・どのモデル・どの Prompt 版で             |
| `input_reference_ids`                                    | 参照した DB レコードの ID                                  |
| `output_json`                                            | 構造化出力そのもの                                         |
| `source_references`                                      | 参照元（種別 / ID / ラベル / 箇所 / 対象年度）             |
| `confidence` / `warnings`                                | 確信度と不足・推測                                         |
| `latency_ms` / `token_usage` / `estimated_cost_usd`      | 実行コスト（単価表に無い Model は 0＝未算定。画面は「—」） |
| `status`                                                 | running / succeeded / failed / **accepted** / **rejected** |
| `reviewed_by` / `accepted_at` / `rejected_at`            | 誰がいつ採否を決めたか                                     |

`/enterprise/ai` で一覧できます。

## 4. AI 出力の UI 表示

| 表示                         | 実装                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| AI 生成 Badge                | `AiGeneratedBadge provider="openai"`                             |
| Mock Badge                   | `AiGeneratedBadge provider="mock"` → 「Mock / AI未接続」         |
| 参照元一覧                   | `ai_runs.source_references`                                      |
| 対象年度                     | 参照元と実行コンテキストに含む                                   |
| Confidence                   | パーセント表示                                                   |
| 推測／不足                   | `warnings` / `missingInformation`                                |
| 採用 / 編集して採用 / Reject | `recordAiDecision()` が `ai_feedback` と `ai_runs.status` へ記録 |

## 5. 禁止事項と、それをどう担保しているか

| 禁止事項                               | 担保                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 承認済み Data Point の無断上書き       | AI 出力から Data Point を直接更新する経路が存在しない。取込は `ingestion_rows`（候補）へ入り、人が確定する                        |
| 最終 CDP 回答の自動提出                | AI 由来 Version は `approved` にできない。アプリ層（`transitionDisclosureResponse`）＋ DB トリガ `forbid_ai_auto_approval` の二重 |
| 保証結論・意見・Sign-off の自動確定    | 監査 AI は `assuranceEvidenceSummary` / `assuranceChangeSummary` のみ。スキーマに結論フィールドが無い。Sign-off は人の操作のみ    |
| 権限外 Evidence の参照                 | Prompt へ渡す入力は Service 層が**権限内・承認済み**に絞ってから構築する                                                          |
| Client Secret / API Key の Prompt 送信 | 入力は明示的に構築した JSON のみ。環境変数を混ぜる経路が無い                                                                      |
| Evidence がない内容の断定              | `missingInformation` / `warnings` を必ず出し、UI に表示                                                                           |
| 「わからない」を隠す                   | `confidence` を正直に低く出す（Mock も指標を特定できない行は 0.2〜0.4）                                                           |

### 監査 AI の限定

`assuranceEvidenceSummary` の出力は `summary` / `keyFigures` / `pointsToVerify` のみです。
「結論」「意見」に相当するフィールドを**スキーマに持たせていません**。
`assuranceChangeSummary` も `possibleImpact`（候補）と `suggestsRetest`（示唆）までで、
`assessment` の確定は人の操作（`assessSnapshotChangeAction`）でのみ行われます。

## 6. 安全弁

| 項目        | 実装                                                  |
| ----------- | ----------------------------------------------------- |
| Timeout     | `OPENAI_TIMEOUT_MS`（既定 60s）。SDK へ渡す           |
| Retry       | `OPENAI_MAX_RETRIES`（既定 2）。SDK の指数バックオフ  |
| Rate Limit  | 組織あたり 60 秒 30 回（`src/lib/ai/index.ts`）       |
| Idempotency | 同一キーの同時実行を 1 本にまとめる（`inflight` Map） |
| エラー露出  | 例外メッセージに Secret・スタック・SQL を含めない     |

## 7. Prompt

システムプロンプトで以下を明示しています。

- 入力に存在しない事実を作らない。根拠がなければ `missingInformation` / `warnings` に書く
- 「わからない」を隠さない。confidence を正直に低く出す
- 承認済みデータ・開示回答・保証結論・Sign-off を確定しない。常に「候補」である
- 保証意見・監査結論の文言を生成しない
- 数値は入力に含まれる値のみを使う
- 出力は指定 JSON スキーマに厳密に従う
- 日本語で書く

Prompt 版は `PROMPT_VERSIONS` で管理し、`ai_runs.prompt_version` に記録します。
変更したら版を上げてください（過去の AI 出力の再現性・監査証跡のため）。
