/**
 * OpenAI 実接続の疎通確認。
 *
 *   pnpm verify:openai       # 1 Use Case だけ（既定・課金 1 リクエスト）
 *   pnpm verify:openai:all   # 8 Use Case すべて（課金 8 リクエスト）
 *
 * `.env.local` の `OPENAI_API_KEY` / `OPENAI_MODEL` を読み、**実際に**
 * Responses API を呼んで次を確認する。
 *
 *   1. その Model 名が実在し、この API Key で使えること
 *   2. Responses API の構造化出力（`zodTextFormat`）が通ること
 *   3. 返ってきた JSON が `src/lib/ai/schemas.ts` の Zod スキーマに適合すること
 *
 * `src/lib/ai/openai-provider.ts` と同じ呼び出し形（`responses.parse` ＋ 同じスキーマ
 * ＋ 同じ System Prompt / Use Case 指示）を使う。Provider クラスを直接 import しないのは
 * `server-only` を挟んでいるため（Provider の内部ロジックは unit テストでカバー）。
 *
 * 制約:
 *  - 課金 API を大量に叩かない。既定は 1 リクエスト、`--all` でも 8 リクエスト。
 *  - API Key を標準出力・エラー出力へ絶対に出さない。
 *  - 入力は架空データのみ。実顧客データを送らない。
 */

import { existsSync } from 'node:fs';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AI_SCHEMAS, PROMPT_VERSIONS, type AiFeature } from '../src/lib/ai/schemas';
import { AI_SYSTEM_PROMPT, AI_FEATURE_INSTRUCTIONS } from '../src/lib/ai/prompt';

// Next.js は .env.local を自動で読むが、単体 Script は読まないので明示的に読む
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() ?? 'gpt-4.1-mini';
const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);
const maxRetries = Number(process.env.OPENAI_MAX_RETRIES ?? 2);
const runAll = process.argv.includes('--all');

if (!apiKey) {
  console.error(
    '.env.local に OPENAI_API_KEY がありません。\n' +
      '未設定の間はアプリが決定論的な MockAIProvider を使います（画面に「Mock / AI未接続」バッジ）。',
  );
  process.exit(1);
}

/** 検証用の最小入力。すべて架空データ。 */
const INPUTS: Record<AiFeature, unknown> = {
  importMapping: {
    headers: ['拠点', '指標', '期間', '数値', '単位'],
    rows: [
      { rowIndex: 1, cells: ['東日本工場', 'Scope1 排出量', 'FY2026', '4120.5', 't-CO2e'] },
      { rowIndex: 2, cells: ['東日本工場', '取水量', 'FY2026', '18200', 'm3'] },
    ],
    knownMetrics: [
      { code: 'GHG_SCOPE1', name: 'Scope1 排出量', unit: 't-CO2e' },
      { code: 'WATER_INTAKE', name: '取水量', unit: 'm3' },
    ],
    knownUnits: [{ code: 'EAST', name: '東日本工場' }],
    knownPeriods: [{ code: 'FY2026', label: '2026年度' }],
  },
  anomalyExplanation: {
    anomalies: [
      {
        dataPointId: '00000000-0000-4000-8000-000000000001',
        metricName: 'Scope1 排出量',
        unitName: '東日本工場',
        period: 'FY2026',
        value: 12_800,
        previousValue: 4_100,
        changeRatio: 2.12,
      },
    ],
  },
  cdpQuestionMapping: {
    questions: [
      { itemCode: 'C6.1', text: '報告対象期間の Scope1 総排出量（t-CO2e）を記載してください。' },
      { itemCode: 'C1.1', text: '気候関連課題を監督する取締役会レベルの責任者は存在しますか。' },
    ],
    metrics: [
      { code: 'GHG_SCOPE1', name: 'Scope1 排出量', unit: 't-CO2e' },
      { code: 'BOARD_WOMEN_RATIO', name: '女性役員比率', unit: '%' },
    ],
  },
  cdpDraftGeneration: {
    itemCode: 'C6.1',
    question: '報告対象期間の Scope1 総排出量（t-CO2e）を記載してください。',
    answerType: 'numeric',
    approvedData: [{ metricCode: 'GHG_SCOPE1', value: 7859.8, unit: 't-CO2e', period: 'FY2026' }],
    previousAnswer: { period: 'FY2025', text: '8931.6 t-CO2e', numeric: 8931.6 },
  },
  ssbjGapAnalysis: {
    itemCode: '気候-10',
    title: '監督に責任を負うガバナンス機関・個人の開示',
    requirementText:
      '10. 気候関連のリスク及び機会の監督に責任を負うガバナンス機関の名称又は当該責任を負う個人の役職名、報告の頻度、監督プロセスを開示しなければならない。',
    required: true,
    documents: [
      {
        name: '統合報告書2026',
        page: '42 ページ',
        excerpt: 'サステナビリティ委員会が気候関連の課題を審議し、取締役会へ報告しています。',
      },
    ],
    metricValues: [{ label: 'Scope1 排出量', value: 7859.8, unit: 't-CO2e' }],
    hasApprovalWorkflow: true,
    sources: [],
  },
  ssbjDisclosureDraft: {
    area: 'governance',
    areaLabel: 'ガバナンス',
    organizationName: '青海テクノロジー株式会社',
    periodLabel: '2026年度',
    requirements: [
      {
        code: '気候-10',
        title: '監督に責任を負うガバナンス機関・個人の開示',
        finalStatus: 'mostly_covered',
        materiality: 'material',
        reviewed: true,
      },
      {
        code: '気候-12',
        title: '経営者の役割の開示',
        finalStatus: null,
        materiality: 'not_assessed',
        reviewed: false,
      },
    ],
    metricValues: [{ label: 'Scope1 排出量', value: 7859.8, unit: 't-CO2e' }],
    documents: [
      {
        name: '統合報告書2026',
        page: '42 ページ',
        excerpt: 'サステナビリティ委員会が気候関連の課題を審議し、取締役会へ報告しています。',
      },
    ],
    sources: [],
  },
  evidenceMapping: {
    fragments: [
      {
        fileVersionId: '00000000-0000-4000-8000-0000000000f1',
        page: 3,
        text: '2026年度の当社単体 Scope1 排出量は 7,859.8 t-CO2e であった。',
      },
    ],
    targets: [{ kind: 'metric', code: 'GHG_SCOPE1', name: 'Scope1 排出量' }],
  },
  inconsistencyCheck: {
    responses: [
      {
        itemCode: 'C6.1',
        text: '2026年度の Scope1 排出量は 7,859.8 t-CO2e です。',
        period: 'FY2026',
      },
      {
        itemCode: 'C10.1',
        text: '2024年度の排出量について第三者保証を受けています。',
        period: 'FY2026',
      },
    ],
  },
  insightDiscovery: {
    periodLabel: 'FY2026（架空）',
    previousPeriodLabel: 'FY2025（架空）',
    submissionDueDate: '2026-06-30',
    metricYoY: [
      { metricName: 'Scope1 排出量', unit: 't-CO2e', current: 9800, previous: 9052 },
      { metricName: '用水使用量', unit: 'm3', current: 118000, previous: 124000 },
    ],
    unitYoY: [
      { metricName: '用水使用量', unitName: '東日本工場', current: 70000, previous: 60000 },
      { metricName: '用水使用量', unitName: '西日本工場', current: 48000, previous: 64000 },
    ],
    collection: { total: 40, approved: 22, draft: 10, submitted: 8, returned: 0 },
    quality: { openValidationErrors: 2, approvedWithoutEvidence: 3 },
    disclosures: [{ framework: 'CDP', total: 12, requiredUnanswered: 4, approved: 3 }],
    assurance: { openPbcRequests: 2 },
  },
  copilotChat: {
    question: 'Scope1 の当年値と前年比は？',
    history: [],
    snapshot: {
      periodLabel: 'FY2026（架空）',
      submissionDueDate: '2026-06-30',
      metricYoY: [
        {
          metricName: 'Scope1 直接排出',
          metricCode: 'scope1',
          unit: 't-CO2e',
          current: 9800,
          previous: 9052,
        },
      ],
      unitYoY: [],
      collection: { total: 40, approved: 22, draft: 10, submitted: 8 },
      disclosures: [{ framework: 'CDP', total: 12, requiredUnanswered: 4, approved: 3 }],
      assurance: { openPbcRequests: 2 },
    },
  },

  assuranceEvidenceSummary: {
    evidence: [
      {
        fileVersionId: '00000000-0000-4000-8000-0000000000f1',
        label: '2026年度 都市ガス検針票（東日本工場）',
        excerpt: '2026年4月〜2027年3月の都市ガス使用量合計 1,482,000 m3。',
      },
    ],
    metric: { code: 'GHG_SCOPE1', name: 'Scope1 排出量', unit: 't-CO2e' },
  },
  assuranceChangeSummary: {
    snapshotLabel: 'FY2026 中間 Snapshot',
    changes: [
      {
        subject: '東日本工場 / Scope1 排出量',
        before: '4,120.5 t-CO2e',
        after: '4,318.2 t-CO2e',
        changedAt: '2026-07-30T03:00:00.000Z',
      },
    ],
  },
};

const CONTEXT = {
  organizationName: '青海テクノロジー株式会社（架空）',
  reportingPeriodLabel: '2026年度',
  engagementLabel: 'ENG-2026-001（架空）',
};

interface Outcome {
  feature: AiFeature;
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  detail: string;
}

async function runFeature(client: OpenAI, feature: AiFeature): Promise<Outcome> {
  const schema = AI_SCHEMAS[feature];
  const startedAt = Date.now();

  const userContent = [
    '# 依頼',
    AI_FEATURE_INSTRUCTIONS[feature],
    '',
    '# コンテキスト',
    `- 組織: ${CONTEXT.organizationName}`,
    `- 対象期間: ${CONTEXT.reportingPeriodLabel}`,
    `- 保証案件: ${CONTEXT.engagementLabel}`,
    '',
    '# 入力データ（この範囲の情報だけを使うこと）',
    '```json',
    JSON.stringify(INPUTS[feature], null, 2),
    '```',
  ].join('\n');

  const response = await client.responses.parse({
    model,
    input: [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    text: { format: zodTextFormat(schema, feature) },
  });

  const latencyMs = Date.now() - startedAt;
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  const parsed = response.output_parsed;
  if (!parsed) {
    return {
      feature,
      ok: false,
      latencyMs,
      inputTokens,
      outputTokens,
      detail: '構造化出力を取得できませんでした（output_parsed が空）',
    };
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return {
      feature,
      ok: false,
      latencyMs,
      inputTokens,
      outputTokens,
      detail: `スキーマ不適合: ${validated.error.message.slice(0, 200)}`,
    };
  }

  const data = validated.data as { confidence: number; warnings: string[] };
  return {
    feature,
    ok: true,
    latencyMs,
    inputTokens,
    outputTokens,
    detail: `confidence ${data.confidence} / warnings ${data.warnings.length} 件`,
  };
}

async function main(): Promise<void> {
  // --only=<feature> で単一 Use Case を検証できる（課金 API の大量実行を避ける）
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) as AiFeature | undefined;
  const features: AiFeature[] = runAll
    ? (Object.keys(AI_SCHEMAS) as AiFeature[])
    : [only && only in AI_SCHEMAS ? only : 'anomalyExplanation'];

  console.log('OpenAI 実接続の疎通確認');
  console.log(`  Model     : ${model}`);
  console.log(`  API Key   : 設定あり（値は出力しません）`);
  console.log(`  Timeout   : ${timeoutMs} ms / Retry ${maxRetries}`);
  console.log(
    `  Use Case  : ${features.length} 件${runAll ? '（--all）' : '（既定。全件は --all）'}`,
  );
  console.log(`  ※ 課金対象のリクエストを ${features.length} 回送信します。\n`);

  const client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries });
  const outcomes: Outcome[] = [];

  for (const feature of features) {
    try {
      const outcome = await runFeature(client, feature);
      outcomes.push(outcome);
      const mark = outcome.ok ? '✓' : '✗';
      console.log(
        `  ${mark} ${feature.padEnd(26)} ${String(outcome.latencyMs).padStart(6)} ms  ` +
          `in ${String(outcome.inputTokens).padStart(4)} / out ${String(outcome.outputTokens).padStart(4)}  ${outcome.detail}`,
      );
      console.log(`      ${PROMPT_VERSIONS[feature]}`);
    } catch (error) {
      outcomes.push({
        feature,
        ok: false,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        detail: describeError(error),
      });
      console.error(`  ✗ ${feature} — ${describeError(error)}`);
    }
  }

  const failed = outcomes.filter((o) => !o.ok);
  const totalIn = outcomes.reduce((s, o) => s + o.inputTokens, 0);
  const totalOut = outcomes.reduce((s, o) => s + o.outputTokens, 0);
  console.log(`\n  Token 合計: input ${totalIn} / output ${totalOut}`);

  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} / ${outcomes.length} の Use Case が失敗しました。`);
    process.exit(1);
  }
  console.log(`\n✓ ${outcomes.length} / ${outcomes.length} の Use Case で実接続に成功しました。`);
}

/** API Key が載る可能性があるため、SDK のエラーは必要な項目だけ取り出す。 */
function describeError(error: unknown): string {
  const status = (error as { status?: number }).status;
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  const safe = message.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200);
  const parts = [status ? `HTTP ${status}` : '', code ?? '', safe].filter(Boolean);
  if (status === 404 || code === 'model_not_found') {
    parts.push(`→ Model「${model}」がこの API Key で見つかりません（OPENAI_MODEL を確認）`);
  }
  if (status === 401) parts.push('→ API Key が無効です（OPENAI_API_KEY を確認）');
  return parts.join(' / ');
}

main().catch((error: unknown) => {
  console.error('\n✗ OpenAI 実接続に失敗しました。');
  console.error(`  ${describeError(error)}`);
  process.exit(1);
});
