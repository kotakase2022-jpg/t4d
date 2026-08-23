import 'server-only';

import { runAi } from '@/lib/ai';
import type {
  AssuranceEvidenceSummaryOutput,
  CdpQuestionMappingOutput,
  EvidenceMappingOutput,
} from '@/lib/ai/schemas';
import { assertCan, assertEngagementMember, NotFoundError } from '@/lib/authorization/can';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AiSourceReference,
  AuthorizationContext,
  FrameworkKey,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { loadDisclosureWorkspace } from './disclosure';

/**
 * 画面から実行できていなかった AI 機能をつなぐ層。
 *
 * `AiFeature` に定義があり Provider も実装済みなのに、アプリ内に実行経路が無い機能が
 * 3 つあった（CDP 質問マッピング / Evidence 自動マッピング / Evidence 要約（監査））。
 * 「利用できる AI 機能」として画面に並んでいるため、押せないままだと嘘になる。
 *
 * いずれも **AI は候補と指摘を出すだけ**で、確定は人が行う（docs/ai-safety.md）。
 */

// ----------------------------------------------------------------------
// CDP 質問マッピング（開示質問 → 指標）
// ----------------------------------------------------------------------

export type QuestionMapping = CdpQuestionMappingOutput['mappings'][number];

export interface QuestionMappingResult {
  run: AiRun;
  mappings: QuestionMapping[];
}

export async function runQuestionMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<QuestionMappingResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const metrics = await db.select('metrics', {
    where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
  });
  const workspace = await loadDisclosureWorkspace(db, ctx, frameworkKey, period, periods, metrics);
  if (!workspace) throw new NotFoundError('開示フレームワークが見つかりません。');

  // まだ指標が紐付いていない質問だけを対象にする（済んでいるものを上書きしない）
  const targets = workspace.rows.filter((row) => row.mappedMetrics.length === 0);
  if (targets.length === 0) {
    throw new Error('マッピング候補が必要な質問はありません。');
  }

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `cdpQuestionMapping:${ctx.workspace.organizationId}:${frameworkKey}:${period.id}`,
    sources: [],
    invocation: {
      feature: 'cdpQuestionMapping',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period.label,
      },
      inputReferenceIds: targets.map((row) => row.item.id),
      input: {
        items: targets.map((row) => ({ code: row.item.code, text: row.item.questionText })),
        metrics: metrics.map((metric) => ({ code: metric.code, name: metric.name })),
      },
    },
  });

  return { run, mappings: output.mappings };
}

/** 過去に実行した質問マッピングを読み直す。 */
export async function loadQuestionMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<QuestionMappingResult | null> {
  const run = await db.findById('aiRuns', runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'cdpQuestionMapping'
  ) {
    return null;
  }
  return { run, mappings: (run.outputJson.mappings ?? []) as QuestionMapping[] };
}

// ----------------------------------------------------------------------
// Evidence 自動マッピング（Data Point → Evidence 候補）
// ----------------------------------------------------------------------

export type EvidenceCandidate = EvidenceMappingOutput['candidates'][number];

export interface EvidenceMappingResult {
  run: AiRun;
  candidates: EvidenceCandidate[];
}

export async function suggestEvidenceForDataPoint(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<EvidenceMappingResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const dataPoint = await db.findById('dataPoints', dataPointId);
  if (!dataPoint || dataPoint.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('Data Point が見つかりません。');
  }
  const metric = await db.findById('metrics', dataPoint.metricId);

  const fragments = await db.select('fragments', {
    where: { organizationId: ctx.workspace.organizationId },
    limit: 40,
  });
  if (fragments.length === 0) {
    throw new Error(
      '抽出済みの Evidence テキストがありません。先に Evidence を取り込んでください。',
    );
  }

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `evidenceMapping:${dataPointId}`,
    sources: [],
    invocation: {
      feature: 'evidenceMapping',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: '',
      },
      inputReferenceIds: [dataPointId],
      input: {
        targetCode: metric?.code ?? '',
        fragments: fragments.map((fragment) => ({
          fileVersionId: fragment.fileVersionId,
          page: fragment.page ?? 0,
          text: fragment.text,
          locator: fragment.locator,
        })),
      },
    },
  });

  return { run, candidates: output.candidates };
}

/** 過去に実行した Evidence 候補を読み直す。 */
export async function loadEvidenceSuggestion(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  dataPointId: Uuid,
): Promise<EvidenceMappingResult | null> {
  const run = await db.findById('aiRuns', runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'evidenceMapping' ||
    !run.inputReferenceIds.includes(dataPointId)
  ) {
    return null;
  }
  return { run, candidates: (run.outputJson.candidates ?? []) as EvidenceCandidate[] };
}

// ----------------------------------------------------------------------
// Evidence 要約（監査）
// ----------------------------------------------------------------------

export interface EvidenceSummaryResult {
  run: AiRun;
  summary: AssuranceEvidenceSummaryOutput;
}

export async function summarizeEvidenceForAssurance(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
  fileVersionId: Uuid,
): Promise<EvidenceSummaryResult> {
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.ai.run');

  const version = await db.findById('fileVersions', fileVersionId);
  if (!version) throw new NotFoundError('Evidence が見つかりません。');

  // 監査法人がこの Evidence を読めるか（許諾・案件メンバーシップ）は Storage 層と同じ判定を通す
  const { canReadEvidence } = await import('@/lib/storage');
  if (!(await canReadEvidence(db, ctx, version, engagementId))) {
    throw new NotFoundError('Evidence が見つかりません。');
  }

  const fragments = await db.select('fragments', { where: { fileVersionId } });
  const file = await db.findById('files', version.fileId);

  const sources: AiSourceReference[] = [
    {
      kind: 'evidence',
      id: fileVersionId,
      label: file?.originalName ?? 'Evidence',
      locator: null,
      periodLabel: null,
    },
  ];

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `assuranceEvidenceSummary:${engagementId}:${fileVersionId}`,
    sources,
    invocation: {
      feature: 'assuranceEvidenceSummary',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: '',
      },
      inputReferenceIds: [fileVersionId],
      input: {
        subjectLabel: file?.originalName ?? 'Evidence',
        fragments: fragments.map((fragment) => ({
          text: fragment.text,
          locator: fragment.locator,
        })),
      },
    },
  });

  return { run, summary: output };
}

/** 過去に実行した Evidence 要約を読み直す。 */
export async function loadEvidenceSummary(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  fileVersionId: Uuid,
): Promise<EvidenceSummaryResult | null> {
  const run = await db.findById('aiRuns', runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'assuranceEvidenceSummary' ||
    !run.inputReferenceIds.includes(fileVersionId)
  ) {
    return null;
  }
  return { run, summary: run.outputJson as unknown as AssuranceEvidenceSummaryOutput };
}
