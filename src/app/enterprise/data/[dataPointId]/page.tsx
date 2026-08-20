import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, FileText, History, Send, Undo2 } from 'lucide-react';
import {
  DataPointStatusBadge,
  EvidenceBadge,
  SeverityBadge,
  ValidationBadge,
} from '@/components/shared/badges';
import { CommentBox } from '@/components/shared/comment-box';
import { MentionText } from '@/components/shared/mention-text';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { loadActiveValidations } from '@/lib/services/validation-store';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { summarizeValidations } from '@/lib/validation/data-point-rules';
import {
  linkEvidenceAction,
  transitionDataPointAction,
  updateDataPointAction,
} from '../../actions';

export const metadata = { title: 'Data Point 詳細' };

export default async function DataPointDetailPage({
  params,
}: {
  params: Promise<{ dataPointId: string }>;
}) {
  const { dataPointId } = await params;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const dataPoint = await db.findById('dataPoints', dataPointId);
  if (
    !dataPoint ||
    dataPoint.organizationId !== ctx.workspace.organizationId ||
    dataPoint.deletedAt
  ) {
    notFound();
  }

  const period =
    shell.periods.find((p) => p.id === dataPoint.reportingPeriodId) ?? shell.currentPeriod;
  const metric = shell.metrics.find((m) => m.id === dataPoint.metricId);
  const unit = shell.units.find((u) => u.id === dataPoint.unitId);
  if (!metric || !unit) notFound();

  // この Data Point の未解消の検証結果だけを取得する（期間全体は読み込まない）
  const validations = await loadActiveValidations(db, ctx.workspace.organizationId, [dataPoint.id]);
  const summary = summarizeValidations(validations).byDataPoint.get(dataPoint.id) ?? {
    errors: 0,
    warnings: 0,
  };

  const [
    versions,
    evidenceLinks,
    calculations,
    comments,
    approvals,
    mappings,
    auditEvents,
    allFiles,
  ] = await Promise.all([
    db.select('dataPointVersions', {
      where: { dataPointId: dataPoint.id },
      orderBy: { column: 'versionNo', dir: 'desc' },
    }),
    db.select('evidenceLinks', { where: { targetType: 'data_point', targetId: dataPoint.id } }),
    db.select('calculations', { where: { dataPointId: dataPoint.id } }),
    db.select('comments', {
      where: { targetType: 'data_point', targetId: dataPoint.id },
      orderBy: { column: 'createdAt', dir: 'desc' },
    }),
    db.select('approvals', {
      where: { targetType: 'data_point', targetId: dataPoint.id },
      orderBy: { column: 'decidedAt', dir: 'desc' },
    }),
    db.select('disclosureMappings', {
      where: { organizationId: ctx.workspace.organizationId, metricId: metric.id },
    }),
    db.select('auditEvents', {
      where: { resourceType: 'data_point', resourceId: dataPoint.id },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 20,
    }),
    db.select('files', {
      where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 50,
    }),
  ]);

  const fileVersionIds = evidenceLinks.map((l) => l.fileVersionId);
  const fileVersions =
    fileVersionIds.length > 0
      ? await db.select('fileVersions', { where: { id: { in: fileVersionIds } } })
      : [];
  const evidenceFileIds = fileVersions.map((v) => v.fileId);
  const evidenceFiles =
    evidenceFileIds.length > 0
      ? await db.select('files', { where: { id: { in: evidenceFileIds } } })
      : [];

  const disclosureItems =
    mappings.length > 0
      ? await db.select('disclosureItems', { where: { id: { in: mappings.map((m) => m.itemId) } } })
      : [];

  // 開示項目は CDP だけとは限らない（SSBJ にも紐づく）。
  // リンク先を framework から決めるために key を解決する。
  const mappedVersionIds = [...new Set(disclosureItems.map((i) => i.frameworkVersionId))];
  const mappedVersions =
    mappedVersionIds.length > 0
      ? await db.select('frameworkVersions', { where: { id: { in: mappedVersionIds } } })
      : [];
  const mappedFrameworkIds = [...new Set(mappedVersions.map((v) => v.frameworkId))];
  const mappedFrameworks =
    mappedFrameworkIds.length > 0
      ? await db.select('frameworks', { where: { id: { in: mappedFrameworkIds } } })
      : [];
  const frameworkKeyByVersionId = new Map(
    mappedVersions.map((v) => [v.id, mappedFrameworks.find((f) => f.id === v.frameworkId)?.key]),
  );

  /**
   * 開示項目へのリンク先。
   *
   * 質問単位の詳細画面を持つのは CDP だけ（Phase 1）。
   * それ以外は一覧へ送る。以前は全項目を `/disclosures/cdp/{id}` へ繋いでいたため、
   * SSBJ に紐づく Data Point から辿ると 404 になっていた。
   */
  function disclosureItemHref(frameworkVersionId: string, itemId: string): string {
    const key = frameworkKeyByVersionId.get(frameworkVersionId);
    if (key === 'cdp') return `/enterprise/disclosures/cdp/${itemId}`;
    return key ? `/enterprise/disclosures/${key}` : '/enterprise/disclosures/cdp';
  }

  const previousPeriod = shell.periods
    .filter((p) => p.startDate < period.startDate)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
  const previousDataPoints = previousPeriod
    ? await db.select('dataPoints', {
        where: {
          organizationId: ctx.workspace.organizationId,
          reportingPeriodId: previousPeriod.id,
          metricId: metric.id,
          unitId: unit.id,
        },
        limit: 1,
      })
    : [];
  const previous = previousDataPoints[0];

  const canWrite = can(ctx, 'enterprise.data.write');
  const canWriteData = canWrite;
  // メンション候補と、コメント著者名の解決（WF-P0-002）
  const mentionCandidates = await listMentionCandidates(db, ctx);
  const authorNameById = new Map(mentionCandidates.map((m) => [m.userId, m.displayName]));
  const canReview = can(ctx, 'enterprise.data.review');
  const canApprove = can(ctx, 'enterprise.data.approve');

  return (
    <>
      <PageHeader
        title={`${metric.name} — ${unit.name}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <DataPointStatusBadge status={dataPoint.status} />
            <ValidationBadge errorCount={summary.errors} warningCount={summary.warnings} />
            <EvidenceBadge count={evidenceLinks.length} required={metric.requiresEvidence} />
            {dataPoint.changedAfterApproval && <Badge tone="warning">承認後に変更あり</Badge>}
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '非財務データ', href: '/enterprise/data' },
          { label: metric.name },
        ]}
        actions={
          <>
            {canWrite && (dataPoint.status === 'draft' || dataPoint.status === 'returned') && (
              <form action={transitionDataPointAction}>
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <input type="hidden" name="to" value="submitted" />
                <Button type="submit" size="sm" variant="outline">
                  <Send aria-hidden="true" />
                  提出
                </Button>
              </form>
            )}
            {canReview && dataPoint.status === 'submitted' && (
              <form action={transitionDataPointAction}>
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <input type="hidden" name="to" value="in_review" />
                <Button type="submit" size="sm" variant="outline">
                  レビュー開始
                </Button>
              </form>
            )}
            {canReview &&
              (dataPoint.status === 'submitted' || dataPoint.status === 'in_review') && (
                <form action={transitionDataPointAction} className="flex items-center gap-1">
                  <input type="hidden" name="dataPointId" value={dataPoint.id} />
                  <input type="hidden" name="to" value="returned" />
                  <input
                    type="text"
                    name="comment"
                    placeholder="差戻し理由"
                    aria-label="差戻し理由"
                    className="h-7 w-40 rounded-t4d border border-line px-2 text-[12px]"
                  />
                  <Button type="submit" size="sm" variant="outline">
                    <Undo2 aria-hidden="true" />
                    差戻し
                  </Button>
                </form>
              )}
            {canApprove &&
              (dataPoint.status === 'submitted' || dataPoint.status === 'in_review') && (
                <form action={transitionDataPointAction}>
                  <input type="hidden" name="dataPointId" value={dataPoint.id} />
                  <input type="hidden" name="to" value="approved" />
                  <Button type="submit" size="sm">
                    <Check aria-hidden="true" />
                    承認
                  </Button>
                </form>
              )}
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3 p-4">
        {/* 左: 定義と値 */}
        <div className="col-span-2 space-y-3">
          <Card>
            <SectionTitle title="指標定義と値" />
            <div className="grid grid-cols-2 gap-x-6 px-3 pb-3 text-[13px]">
              <Row label="指標コード" value={metric.code} />
              <Row label="カテゴリ" value={metric.category} />
              <Row label="定義" value={metric.description} />
              <Row label="単位（定義）" value={metric.unit} />
              <Row label="集計方法" value={metric.aggregationMethod} />
              <Row label="Evidence 必須" value={metric.requiresEvidence ? 'はい' : 'いいえ'} />
              <Row label="組織・拠点" value={`${unit.name}（${unit.code}）`} />
              <Row
                label="連結範囲"
                value={`${dataPoint.boundary} / 持分 ${unit.ownershipPercent}%`}
              />
              <Row label="対象期間" value={`${period.label}`} />
              <Row
                label="前年実績"
                value={
                  previous
                    ? `${formatNumber(previous.value)} ${previous.unitOfMeasure}`
                    : '—（前年データなし）'
                }
              />
              <Row label="算定方法" value={dataPoint.methodology ?? '—'} />
              <Row label="最終更新" value={formatJst(dataPoint.updatedAt)} />
            </div>
          </Card>

          {canWrite && (
            <Card>
              <SectionTitle title="値の編集（更新すると新しい Version が追加されます）" />
              <form action={updateDataPointAction} className="grid grid-cols-4 gap-2 p-3">
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <label className="col-span-1 text-[12px] text-ink-muted">
                  値
                  <Input
                    name="value"
                    defaultValue={dataPoint.value ?? ''}
                    inputMode="decimal"
                    className="mt-0.5"
                  />
                </label>
                <label className="col-span-1 text-[12px] text-ink-muted">
                  単位
                  <Input
                    name="unitOfMeasure"
                    defaultValue={dataPoint.unitOfMeasure}
                    className="mt-0.5"
                  />
                </label>
                <label className="col-span-2 text-[12px] text-ink-muted">
                  変更理由（履歴に残ります）
                  <Input
                    name="changeReason"
                    required
                    placeholder="例: 検針票の再集計により修正"
                    className="mt-0.5"
                  />
                </label>
                <label className="col-span-4 text-[12px] text-ink-muted">
                  算定方法
                  <Textarea
                    name="methodology"
                    rows={2}
                    defaultValue={dataPoint.methodology ?? ''}
                    className="mt-0.5"
                  />
                </label>
                <div className="col-span-4">
                  <Button type="submit" size="sm" data-t4d-shortcut="save">
                    保存
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {calculations.length > 0 && (
            <Card>
              <SectionTitle title="算定内訳（Calculation Breakdown）" />
              {calculations.map((calc) => (
                <div key={calc.id} className="px-3 pb-3">
                  <p className="mb-1 font-mono text-[12px] text-ink-muted">{calc.formula}</p>
                  <Table>
                    <THead>
                      <TR>
                        <TH>内訳</TH>
                        <TH align="right">値</TH>
                        <TH>単位</TH>
                        <TH>根拠</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {calc.inputs.map((inputRow, i) => (
                        <TR key={i}>
                          <TD>{inputRow.label}</TD>
                          <TD align="right">{formatNumber(inputRow.value)}</TD>
                          <TD>{inputRow.unit}</TD>
                          <TD className="text-[11px] text-ink-muted">{inputRow.note}</TD>
                        </TR>
                      ))}
                      <TR>
                        <TD className="font-medium">合計</TD>
                        <TD align="right" className="font-medium">
                          {formatNumber(calc.result)}
                        </TD>
                        <TD>{calc.resultUnit}</TD>
                        <TD />
                      </TR>
                    </TBody>
                  </Table>
                </div>
              ))}
            </Card>
          )}

          <Card>
            <SectionTitle title={`Version 履歴（${versions.length}）`} />
            <Table>
              <THead>
                <TR>
                  <TH>版</TH>
                  <TH align="right">値</TH>
                  <TH>単位</TH>
                  <TH>出所</TH>
                  <TH>変更理由</TH>
                  <TH>作成日時</TH>
                </TR>
              </THead>
              <TBody>
                {versions.map((v) => (
                  <TR key={v.id}>
                    <TD>
                      v{v.versionNo}
                      {v.id === dataPoint.currentVersionId && (
                        <Badge tone="brand" className="ml-1">
                          現在
                        </Badge>
                      )}
                    </TD>
                    <TD align="right">{formatNumber(v.value)}</TD>
                    <TD>{v.unitOfMeasure}</TD>
                    <TD className="text-[11px]">{v.sourceReference ?? v.sourceType}</TD>
                    <TD className="text-[11px] text-ink-muted">{v.changeReason ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                      {formatJst(v.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </div>

        {/* 右: Validation / Evidence / 履歴 */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title={`Validation（${validations.length}）`} />
            {validations.length === 0 ? (
              <EmptyState title="検証エラー・警告はありません" />
            ) : (
              <ul className="divide-y divide-line">
                {validations.map((v) => (
                  <li key={v.id} className="flex items-start gap-2 px-3 py-2">
                    <SeverityBadge severity={v.severity} />
                    <span className="text-[12px] text-ink">{v.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card data-t4d-shortcut="evidence" tabIndex={-1} className="scroll-mt-2 outline-none">
            <SectionTitle title={`Evidence（${evidenceLinks.length}）`} />
            {evidenceLinks.length === 0 ? (
              <EmptyState
                title="Evidence が紐付いていません"
                description={
                  metric.requiresEvidence
                    ? 'この指標は Evidence 必須です。承認前に紐付けてください。'
                    : undefined
                }
                icon={<FileText className="size-5" aria-hidden="true" />}
              />
            ) : (
              <ul className="divide-y divide-line">
                {evidenceLinks.map((link) => {
                  const version = fileVersions.find((v) => v.id === link.fileVersionId);
                  const file = evidenceFiles.find((f) => f.id === version?.fileId);
                  return (
                    <li key={link.id} className="px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] font-medium text-ink">
                          {file?.originalName ?? '（ファイル）'}
                        </span>
                        {version && (
                          <a
                            href={`/api/files/signed-url?fileVersionId=${version.id}`}
                            className="shrink-0 text-[11px] text-brand-700 hover:underline"
                          >
                            開く
                          </a>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-muted">
                        {link.page ? `p.${link.page}` : ''} {link.cellRef ?? ''}{' '}
                        {link.coveragePeriodStart
                          ? `対象 ${formatJstDate(link.coveragePeriodStart)}〜${formatJstDate(link.coveragePeriodEnd)}`
                          : ''}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {can(ctx, 'enterprise.evidence.write') && (
              <form action={linkEvidenceAction} className="space-y-1.5 border-t border-line p-3">
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <label className="block text-[11px] text-ink-muted">
                  既存ファイルから紐付け
                  <select
                    name="fileVersionId"
                    required
                    className="mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[12px]"
                  >
                    <option value="">選択してください</option>
                    {allFiles.map((f) => (
                      <option key={f.id} value={f.currentVersionId ?? ''}>
                        {f.originalName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-1.5">
                  <Input name="page" placeholder="ページ" inputMode="numeric" className="w-20" />
                  <Input name="cellRef" placeholder="セル（例 Sheet1!C12）" />
                </div>
                <Button type="submit" size="xs" variant="outline">
                  紐付ける
                </Button>
              </form>
            )}
          </Card>

          {disclosureItems.length > 0 && (
            <Card>
              <SectionTitle title="開示マッピング" />
              <ul className="divide-y divide-line">
                {disclosureItems.map((item) => (
                  <li key={item.id} className="px-3 py-1.5">
                    <Link
                      href={disclosureItemHref(item.frameworkVersionId, item.id)}
                      className="text-[12px] text-brand-700 hover:underline"
                    >
                      {item.code}
                    </Link>
                    <div className="truncate text-[11px] text-ink-muted">{item.questionText}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <SectionTitle title="コメント・承認履歴" />
            {canWriteData && (
              <CommentBox
                targetType="data_point"
                targetId={dataPoint.id}
                href={`/enterprise/data/${dataPoint.id}`}
                members={mentionCandidates}
              />
            )}
            {comments.length === 0 && approvals.length === 0 ? (
              <EmptyState title="履歴はありません" />
            ) : (
              <ul className="divide-y divide-line">
                {approvals.map((a) => (
                  <li key={a.id} className="px-3 py-2">
                    <Badge tone={a.decision === 'approved' ? 'success' : 'warning'}>
                      {a.decision === 'approved' ? '承認' : '差戻し'}（{a.stage}）
                    </Badge>
                    {a.comment && <p className="mt-0.5 text-[12px] text-ink">{a.comment}</p>}
                    <span className="text-[11px] text-ink-muted">{formatJst(a.decidedAt)}</span>
                  </li>
                ))}
                {comments.map((c) => (
                  <li key={c.id} className="px-3 py-2">
                    <p className="text-[12px] text-ink">
                      <MentionText body={c.body} />
                    </p>
                    <span className="text-[11px] text-ink-muted">
                      {authorNameById.get(c.authorUserId) ?? '—'} ・ {formatJst(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title="Audit Timeline" />
            {auditEvents.length === 0 ? (
              <EmptyState title="監査ログはありません" icon={<History className="size-5" />} />
            ) : (
              <ul className="divide-y divide-line">
                {auditEvents.map((e) => (
                  <li key={e.id} className="px-3 py-1.5">
                    <div className="text-[12px] text-ink">{e.eventType}</div>
                    {e.afterSummary && (
                      <div className="text-[11px] text-ink-muted">{e.afterSummary}</div>
                    )}
                    <div className="text-[11px] text-ink-muted">{formatJst(e.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}
