import { notFound } from 'next/navigation';
import { AlertTriangle, Languages } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { getAiProvider } from '@/lib/ai';
import { AI_FEEDBACK_REASON_MAX, AI_FEEDBACK_REASON_MAX_DEMO } from '@/lib/ai/feedback';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import { describeReferenceDate } from '@/lib/clock';
import { paragraphText } from '@/lib/domain/disclosure-block';
import { formatJstDate } from '@/lib/format/datetime';
import { listNotesForClient } from '@/lib/services/assurance-notes';
import {
  blockNeedsMappingReason,
  listRequirementOptions,
  loadBlockMappingSuggestion,
  mappingReasonLimit,
} from '@/lib/services/block-requirements';
import { loadBlockDraftRuns, type DraftRunView } from '@/lib/services/disclosure-ai-draft';
import { getBlockEditorData, type BlockEditorData } from '@/lib/services/disclosure-block';
import { reviewActionsFor, type ReviewActionState } from '@/lib/services/disclosure-review';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { BlockParagraph } from '@/types/domain';
import { BlockStatusBadge, FreshnessBadge } from '../status-badges';
import { BlockEditor } from './block-editor';
import { paragraphLabelOf } from './editor-model';
import type { PaneTab } from './editor-right-pane';
import type { AssuranceNoteView, RequirementMappingPaneData } from './requirement-mapping-panel';
import { loadReviewDiff, parseReviewDiffMode, type ReviewDiffResult } from './review-diff';
import { ReviewPanel } from './review-panel';

export const metadata = { title: '原稿編集' };

export default async function BlockEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; blockId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, blockId } = await params;
  const sp = await searchParams;
  const { db, ctx } = await loadEnterpriseShell();

  let data: BlockEditorData;
  try {
    data = await getBlockEditorData(db, ctx, projectId, blockId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <PermissionDeniedState
          description="開示の原稿を閲覧する権限がありません。"
          permission="enterprise.disclosure.read"
        />
      );
    }
    throw error;
  }

  // AI の実行記録が読めなくても、手動の編集はできるようにする（A19）
  const runs: DraftRunView[] = await loadBlockDraftRuns(db, ctx, blockId).catch(() => []);
  const aiMode = (await getAiProvider()).kind === 'mock' ? 'mock' : 'openai';

  let actions: ReviewActionState | null = null;
  let reviewParagraphs: Array<{ id: string; label: string }> = [];
  let reviewDiff: ReviewDiffResult | null = null;
  let reviewTargetParagraphs: BlockParagraph[] = [];
  if (data.activeRequest) {
    const request = await db.findById('reviewRequests', data.activeRequest.id);
    if (request) {
      actions = await reviewActionsFor(db, ctx, request);
      const target = await db.findById('disclosureBlockVersions', request.targetVersionId);
      if (target) {
        reviewTargetParagraphs = target.body.paragraphs;
        reviewParagraphs = target.body.paragraphs.map((p) => ({
          id: p.id,
          label: `${paragraphLabelOf(target.body.paragraphs, p.id)}: ${paragraphText(p).slice(0, 30)}`,
        }));
        // 再承認では前回承認した版との差分を既定にする（?diff=previous で直前の版。NF-17）
        reviewDiff = await loadReviewDiff(db, ctx, {
          target,
          approvedVersionId: data.block.approvedVersionId,
          requested: parseReviewDiffMode(sp.diff),
        });
      }
    }
  }

  // 段落の表示名（審査中の版を優先し、無ければ現在の本文での位置）。内部の段落 ID は画面に出さない
  const paragraphNames: Record<string, string> = Object.fromEntries(
    data.body.paragraphs.map((p) => [p.id, paragraphLabelOf(data.body.paragraphs, p.id)]),
  );
  for (const p of reviewTargetParagraphs) {
    paragraphNames[p.id] = paragraphLabelOf(reviewTargetParagraphs, p.id);
  }

  const reference = describeReferenceDate();
  const projectHref = `/enterprise/disclosure-projects/${projectId}`;
  const blockHref = `${projectHref}/blocks/${blockId}`;

  // 要求事項の対応付けの編集と AI の候補（NF-05・NF-11）。読めなくても原稿の編集はできるようにする
  const canWriteDisclosure = can(ctx, 'enterprise.disclosure.write');
  const canRunAi = can(ctx, 'enterprise.ai.run');
  const [options, suggestion, clientNotes] = await Promise.all([
    canWriteDisclosure
      ? listRequirementOptions(db, ctx, {
          projectId,
          frameworkVersionId: data.framework.versionId,
        }).catch(() => [])
      : Promise.resolve([]),
    canWriteDisclosure && canRunAi
      ? loadBlockMappingSuggestion(db, ctx, blockId).catch(() => null)
      : Promise.resolve(null),
    listNotesForClient(db, ctx).catch(() => []),
  ]);
  const requirementMapping: RequirementMappingPaneData = {
    projectId,
    blockId,
    frameworkVersionId: data.framework.versionId,
    canEdit: canWriteDisclosure,
    canRunAi: canRunAi && canWriteDisclosure,
    reasonRequired: blockNeedsMappingReason({
      status: data.block.status,
      approvedVersionId: data.block.approvedVersionId,
    }),
    reasonMaxLength: mappingReasonLimit(ctx),
    rejectReasonMaxLength: ctx.demo ? AI_FEEDBACK_REASON_MAX_DEMO : AI_FEEDBACK_REASON_MAX,
    options,
    selectedIds: data.requirements.map((r) => r.id),
    suggestion: suggestion
      ? {
          runId: suggestion.run.id,
          source: suggestion.run.provider,
          createdAt: suggestion.run.createdAt,
          confidence: suggestion.run.confidence,
          candidates: suggestion.candidates,
          warnings: suggestion.warnings,
        }
      : null,
  };
  // 保証側のコメントのうち、この節（共有した写しの段落・数値）を指すもの（NF-21。読み取りは中核サービス）
  const assuranceNotes: AssuranceNoteView[] = clientNotes
    .filter((entry) => entry.note.targetBlockId === blockId)
    .map((entry) => ({
      id: entry.note.id,
      engagementLabel: `${entry.engagement.code} ${entry.engagement.name}`,
      body: entry.note.body,
      state: entry.state,
      paragraphId: entry.note.targetParagraphId,
      createdAt: entry.note.createdAt,
      responseCount: entry.responses.length,
    }));
  const pane = typeof sp.pane === 'string' ? sp.pane : null;
  const initialPaneTab: PaneTab | undefined =
    pane === 'requirements' || pane === 'comments' ? pane : undefined;
  const diffMode = reviewDiff?.mode ?? null;

  return (
    <>
      <PageHeader
        title={data.block.title}
        breadcrumbs={[
          { label: 'ホーム', href: '/enterprise/dashboard' },
          { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
          { label: data.project.name, href: `${projectHref}?tab=manuscripts` },
          { label: data.block.title },
        ]}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              基準・版: {data.framework.label}
              {data.framework.legalStatusLabel ? `（${data.framework.legalStatusLabel}）` : ''}
            </span>
            <span>
              対象期間: {formatJstDate(data.project.periodStart)} 〜{' '}
              {formatJstDate(data.project.periodEnd)}
            </span>
            {data.requirements.length > 0 && (
              <span>要求事項: {data.requirements.map((r) => r.code).join('、')}</span>
            )}
            <span>言語: {data.block.languageLabel}</span>
            <span>担当: {data.block.ownerName}</span>
            <span>期限: {formatJstDate(data.block.dueDate)}</span>
            {reference.label && <span>{reference.label}</span>}
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <BlockStatusBadge status={data.block.status} />
            <FreshnessBadge status={data.freshness.status} />
          </div>
        }
      />

      <div className="space-y-1 px-4 pt-2">
        <FlashMessage searchParams={sp} />
        {ctx.demo && (
          <p className="text-caption text-ink-muted">
            デモデータ｜企業・資料・数値はすべて架空です。本文の版はこのブラウザの Cookie
            でサーバー間を持ち回します（別のブラウザや、Cookie
            の容量不足で古い操作が押し出された後は、版を参照できない場合があります）。自動保存した作業中の本文はサーバーをまたいで持ち回さないため、「版として保存」で版にしてください。
          </p>
        )}
        {data.framework.isDraftStandard && (
          <p className="flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-small text-ink">
            <AlertTriangle
              className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
              aria-hidden="true"
            />
            この節の基準は草案です（{data.framework.coverageLabel ?? '収録状況未確認'}
            ）。承認しても「草案に基づく準備」であり、正式な基準への準拠完了ではありません。
          </p>
        )}
        {data.block.translationOfTitle && (
          <p className="flex items-center gap-1 text-small text-ink-muted">
            <Languages className="size-3.5" aria-hidden="true" />
            翻訳元: {data.block.translationOfTitle}
            <Badge tone="neutral">
              <Languages className="size-3" aria-hidden="true" />
              翻訳版
            </Badge>
            {data.block.translationNeedsCheck && (
              <Badge tone="warning">
                <AlertTriangle className="size-3" aria-hidden="true" />
                翻訳の要確認（翻訳元が更新されています）
              </Badge>
            )}
          </p>
        )}
      </div>

      {(data.activeRequest || data.reviewHistory.length > 0) && (
        <ReviewPanel
          projectId={projectId}
          blockId={blockId}
          request={data.activeRequest}
          actions={actions}
          paragraphs={reviewParagraphs}
          paragraphNames={paragraphNames}
          diff={reviewDiff?.diff ?? null}
          diffBase={
            reviewDiff
              ? {
                  label: reviewDiff.baseLabel,
                  switchHref: reviewDiff.canSwitch
                    ? `${blockHref}?diff=${diffMode === 'approved' ? 'previous' : 'approved'}`
                    : null,
                  switchLabel:
                    diffMode === 'approved' ? '直前の版と比べる' : '前回承認した版と比べる',
                  openByDefault: typeof sp.diff === 'string',
                }
              : null
          }
          history={data.reviewHistory}
        />
      )}

      <BlockEditor
        key={`${data.block.currentVersionId ?? 'none'}:${data.block.status}`}
        projectId={projectId}
        data={data}
        runs={runs}
        aiMode={aiMode}
        viewerId={ctx.userId}
        requirementMapping={requirementMapping}
        assuranceNotes={assuranceNotes}
        initialPaneTab={initialPaneTab}
      />
    </>
  );
}
