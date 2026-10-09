import { notFound } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  CornerDownRight,
  History,
  Tag,
} from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { SubmitButton } from '@/components/ui/submit-button';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleSection } from '@/components/ui/collapsible';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import { NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { NARRATIVE_TEMPLATE_FIELDS } from '@/lib/domain/narrative-template';
import { formatJst } from '@/lib/format/datetime';
import {
  IRO_REF_THEMES,
  NARRATIVE_DETAIL_FIELDS,
  NO_AMOUNT_NOTE,
  getNarrativeEditor,
  type NarrativeEditorData,
} from '@/lib/services/narrative';
import { loadContentCoverage } from '@/lib/services/content-coverage';
import {
  listLinkableRequirements,
  loadNarrativeMappingCandidates,
} from '@/lib/services/narrative-requirement-links';
import { listDocumentsForCitation } from '@/lib/services/source-anchor';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  addNarrativeLinkAction,
  adoptNarrativeLinksAction,
  rejectNarrativeLinksAction,
  removeNarrativeLinkAction,
  suggestNarrativeLinksAction,
} from '../actions';
import { CoveragePanel } from '../_components/coverage-panel';
import { NarrativeEditor } from '../_components/narrative-editor';
import { CandidateBadge, NarrativeStatusBadge } from '../_components/narrative-badges';
import type { DocumentPayload } from '../_components/types';

export const metadata = { title: '定性情報の編集' };

/**
 * 定性情報の編集（§6.6）。左にテンプレート項目と本文、右に資料の該当箇所、下に版の履歴。
 * 「基準別の対応状況」（トライアル対応 NF-06）: 基準ごとの 5 区分（要求事項タブと同じ区分）、要求事項の行
 * （折りたたみ）、直接の対応付け（外した後は通知に「元に戻す」）、AI の対応付けの候補（NF-11。採用は人）。
 * リスク・機会／財務的影響のテーマは「関連するインパクト・リスク・機会」を選べる（NF-10。台帳の SSBJ 列）。
 */
export default async function NarrativeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ narrativeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { narrativeId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  let data: NarrativeEditorData;
  try {
    data = await getNarrativeEditor(db, ctx, narrativeId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader
            title="定性情報"
            breadcrumbs={[
              { label: 'ホーム', href: '/enterprise/dashboard' },
              { label: '定性情報', href: '/enterprise/narratives' },
            ]}
          />
          <PermissionDeniedState
            description="定性情報を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }

  const record = data.record;
  const current = data.currentVersion;
  // 基準別の対応状況（NF-06）・直接の対応付けの選択肢・AI の候補（NF-11。?mappingRun= で読み直す）
  const mappingRunId = typeof query.mappingRun === 'string' ? query.mappingRun : null;
  const [coverage, linkable, candidates] = await Promise.all([
    loadContentCoverage(db, ctx, { narrativeRecordId: record.id }),
    data.canWrite
      ? listLinkableRequirements(db, ctx, { narrativeRecordId: record.id })
      : Promise.resolve([]),
    mappingRunId
      ? loadNarrativeMappingCandidates(db, ctx, {
          narrativeRecordId: record.id,
          runId: mappingRunId,
        })
      : Promise.resolve(null),
  ]);
  const candidateDecidedBy = candidates?.run.reviewedBy
    ? (data.members.find((m) => m.userId === candidates.run.reviewedBy)?.displayName ?? null)
    : null;
  const undoItem = typeof query.undoItem === 'string' ? query.undoItem : null;
  const docs = await listDocumentsForCitation(db, ctx);
  const documents: DocumentPayload[] = docs.map((d) => ({
    fileId: d.file.id,
    name: d.file.originalName,
    usagePurposeLabel: d.usagePurposeLabel,
    confidentialityLabel: d.confidentialityLabel,
    fragmentCount: d.fragmentCount,
    periodCode: shell.periods.find((p) => p.id === d.periodId)?.code ?? null,
  }));
  const currentVersionNo = data.versions.find((v) => v.isCurrent)?.version.versionNo ?? null;
  // 版を作った直後（保存・前年から引継ぎ）はフラッシュが指す版が履歴にあるので開いて描く。
  // 版が 1 つも無いことは空状態として見せる（§10.4: 空状態は閉じない）
  const versionsOpen =
    query.flash === 'narrativeSaved' ||
    query.flash === 'narrativeCarried' ||
    data.versions.length === 0;
  const firstLinked = data.anchors.find(
    (a) => a.fileId && documents.some((d) => d.fileId === a.fileId),
  );

  return (
    <>
      <PageHeader
        title={record.title}
        breadcrumbs={[
          { label: 'ホーム', href: '/enterprise/dashboard' },
          { label: '定性情報', href: '/enterprise/narratives' },
          { label: record.title },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              <Tag className="size-3" aria-hidden="true" />
              {NARRATIVE_THEME_LABELS[record.theme]}
            </Badge>
            <NarrativeStatusBadge status={record.status} />
            {data.isCandidate && <CandidateBadge />}
            <span>
              責任者: {data.ownerName ?? '—'}
              {record.ownerDepartment ? `（${record.ownerDepartment}）` : ''}
            </span>
            <span>
              {record.confirmedAt
                ? `最新確認: ${formatJst(record.confirmedAt)}（${data.confirmedByName ?? '—'}・版 ${
                    data.versions.find((v) => v.isConfirmed)?.version.versionNo ?? '—'
                  }）`
                : '未確認'}
            </span>
          </span>
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage
          searchParams={query}
          undo={{
            // 外した対応付けを結び直す（plan §1.16 区分 3「元に戻す」）
            narrativeLinkRemoved:
              data.canWrite && undoItem ? (
                <form action={addNarrativeLinkAction}>
                  <input type="hidden" name="narrativeId" value={record.id} />
                  <input type="hidden" name="itemId" value={undoItem} />
                  <SubmitButton variant="secondary" size="xs" pendingLabel="戻しています…">
                    元に戻す
                  </SubmitButton>
                </form>
              ) : null,
          }}
        />
        {data.versionMissing && (
          <p
            role="alert"
            className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-small text-ink"
          >
            <AlertTriangle className="size-3.5 text-danger" aria-hidden="true" />
            現在の版が見つかりません（デモ環境では版の本文をこのブラウザの Cookie
            で持ち回しており、別のブラウザや、古い操作が押し出された後は失われることがあります）。保存はできません。
          </p>
        )}

        {!data.versionMissing && (
          <NarrativeEditor
            key={current?.id ?? 'none'}
            mode="edit"
            narrativeId={record.id}
            baseVersionId={record.currentVersionId}
            theme={record.theme}
            themes={[{ value: record.theme, label: NARRATIVE_THEME_LABELS[record.theme] }]}
            templateFieldsByTheme={{
              [record.theme]: NARRATIVE_TEMPLATE_FIELDS[record.theme].map((f) => ({
                key: f.key,
                label: f.label,
              })),
            }}
            detailFieldsByTheme={{
              [record.theme]: NARRATIVE_DETAIL_FIELDS[record.theme].map((f) => ({
                key: f.key,
                label: f.label,
              })),
            }}
            initial={{
              title: record.title,
              ownerDepartment: record.ownerDepartment,
              tags: record.tags.join('、'),
              reportingPeriodId: current?.reportingPeriodId ?? shell.currentPeriod.id,
              scopeNote: current?.scopeNote ?? '',
              fields: { ...(current?.fields ?? {}) },
              body: current?.body ?? '',
              anchors: data.anchors.map((a) => ({
                id: a.anchor.id,
                fileId: a.fileId,
                fileName: a.fileName,
                locationLabel: a.locationLabel,
                quoteText: a.anchor.quoteText,
                usagePurposeLabel: a.usagePurposeLabel,
                isCurrentFact: a.usagePurpose === 'current_fact',
                manual: a.anchor.acquiredBy === 'manual',
                missing: a.missing,
              })),
            }}
            periods={data.periods.map((p) => ({ id: p.id, code: p.code }))}
            documents={documents}
            initialDocumentId={firstLinked?.fileId ?? null}
            usage={data.usage.map((u) => ({
              blockId: u.blockId,
              blockTitle: u.blockTitle,
              blockStatusLabel: u.blockStatusLabel,
              projectId: u.projectId,
              projectName: u.projectName,
              citedVersionNo: u.citedVersionNo,
              citesCurrent: u.citesCurrent,
            }))}
            canWrite={data.canWrite}
            noAmountNote={NO_AMOUNT_NOTE}
            currentConfirmed={
              record.status === 'confirmed' && record.confirmedVersionId === record.currentVersionId
            }
            isCandidate={data.isCandidate}
            iroSelectable={IRO_REF_THEMES.includes(record.theme)}
            iroOptions={data.iroOptions}
            iroOptionsPeriodId={data.iroOptionsPeriodId}
            initialIroRefs={current?.iroRefs ?? []}
            coverage={
              <CoveragePanel
                narrativeId={record.id}
                coverage={coverage}
                linkable={linkable}
                candidates={candidates}
                candidateDecidedBy={candidateDecidedBy}
                canWrite={data.canWrite}
                canRunAi={can(ctx, 'enterprise.ai.run')}
                actions={{
                  add: addNarrativeLinkAction,
                  remove: removeNarrativeLinkAction,
                  suggest: suggestNarrativeLinksAction,
                  adopt: adoptNarrativeLinksAction,
                  reject: rejectNarrativeLinksAction,
                }}
              />
            }
          />
        )}

        {/* 履歴は既定で閉じる（見出しは常に見せる。docs/disclosure-first.md §10.4 B6） */}
        <CollapsibleSection
          id="narrative-versions"
          title={`版の履歴（${data.versions.length}）`}
          summary={`版の一覧（${data.versions.length} 版${
            currentVersionNo !== null ? `・現在 版 ${currentVersionNo}` : ''
          }）`}
          open={versionsOpen || undefined}
          bodyClassName="px-0 pb-0"
        >
          <ol className="divide-y divide-line">
            {data.versions.map((v) => (
              <li key={v.version.id} className="px-3 py-2 text-small">
                <p className="flex flex-wrap items-center gap-1.5">
                  <History className="size-3.5 text-ink-muted" aria-hidden="true" />
                  <span className="font-medium">版 {v.version.versionNo}</span>
                  <span>{v.period?.code ?? '—'}</span>
                  {v.isCurrent && (
                    <Badge tone="brand">
                      <CircleDot className="size-3" aria-hidden="true" />
                      現在の版
                    </Badge>
                  )}
                  {v.isConfirmed && (
                    <Badge tone="success">
                      <CheckCircle2 className="size-3" aria-hidden="true" />
                      確認済みの版
                    </Badge>
                  )}
                  {v.version.carriedFromVersionId && (
                    <Badge tone="neutral">
                      <CornerDownRight className="size-3" aria-hidden="true" />
                      前年から引継ぎ
                    </Badge>
                  )}
                  <span className="text-ink-muted">
                    {formatJst(v.version.createdAt)}・{v.createdByName ?? '—'}
                  </span>
                </p>
                {v.version.changeReason && (
                  <p className="mt-0.5 text-ink-muted">変更の理由: {v.version.changeReason}</p>
                )}
                <Collapsible variant="plain" summary="この版の本文" className="mt-0.5">
                  <p className="whitespace-pre-wrap rounded-t4d bg-surface-muted p-2">
                    {v.version.body || '（本文なし）'}
                  </p>
                </Collapsible>
              </li>
            ))}
            {data.versions.length === 0 && (
              <li className="px-3 py-2 text-small text-ink-muted">版がありません。</li>
            )}
          </ol>
        </CollapsibleSection>
      </div>
    </>
  );
}
