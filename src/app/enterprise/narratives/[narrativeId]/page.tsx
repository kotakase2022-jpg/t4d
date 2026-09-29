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
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { NARRATIVE_TEMPLATE_FIELDS } from '@/lib/domain/narrative-template';
import { formatJst } from '@/lib/format/datetime';
import {
  NARRATIVE_DETAIL_FIELDS,
  NO_AMOUNT_NOTE,
  getNarrativeEditor,
  type NarrativeEditorData,
} from '@/lib/services/narrative';
import { listDocumentsForCitation } from '@/lib/services/source-anchor';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { NarrativeEditor } from '../_components/narrative-editor';
import { CandidateBadge, NarrativeStatusBadge } from '../_components/narrative-badges';
import type { DocumentPayload } from '../_components/types';

export const metadata = { title: '定性情報の編集' };

/**
 * 定性情報の編集（§6.6）。左にテンプレート項目と本文、右に資料の該当箇所、下に版の履歴。
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
              { label: '企業ワークスペース' },
              { label: '定性情報', href: '/enterprise/narratives' },
            ]}
          />
          <PermissionDeniedState description="定性情報を見るには、開示の閲覧権限が必要です。" />
        </>
      );
    }
    throw error;
  }

  const record = data.record;
  const current = data.currentVersion;
  const docs = await listDocumentsForCitation(db, ctx);
  const documents: DocumentPayload[] = docs.map((d) => ({
    fileId: d.file.id,
    name: d.file.originalName,
    usagePurposeLabel: d.usagePurposeLabel,
    confidentialityLabel: d.confidentialityLabel,
    fragmentCount: d.fragmentCount,
    periodCode: shell.periods.find((p) => p.id === d.periodId)?.code ?? null,
  }));
  const firstLinked = data.anchors.find(
    (a) => a.fileId && documents.some((d) => d.fileId === a.fileId),
  );

  return (
    <>
      <PageHeader
        title={record.title}
        breadcrumbs={[
          { label: '企業ワークスペース' },
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
        <FlashMessage searchParams={query} />
        {data.versionMissing && (
          <p
            role="alert"
            className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
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
          />
        )}

        <Card>
          <SectionTitle title={`版の履歴（${data.versions.length}）`} />
          <ol className="divide-y divide-line">
            {data.versions.map((v) => (
              <li key={v.version.id} className="px-3 py-2 text-[12px]">
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
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-[11px] text-brand-800">
                    この版の本文
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap rounded-t4d bg-surface-muted p-2">
                    {v.version.body || '（本文なし）'}
                  </p>
                </details>
              </li>
            ))}
            {data.versions.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-ink-muted">版がありません。</li>
            )}
          </ol>
        </Card>
      </div>
    </>
  );
}
