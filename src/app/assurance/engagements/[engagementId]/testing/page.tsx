import Link from 'next/link';
import { AlertTriangle, Check, FileSearch, Sparkles } from 'lucide-react';
import { ReadOnlyBadge, TestStatusBadge } from '@/components/shared/badges';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadTestingWorkspace } from '@/lib/services/assurance';
import { loadEvidenceSummary } from '@/lib/services/ai-assist';
import {
  recordTestResultAction,
  summarizeEvidenceAction,
  updateTestAction,
} from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '保証手続・調書' };

export default async function TestingPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const { sample, rows, procedures } = await loadTestingWorkspace(db, ctx, engagementId);

  const selectedId = typeof query.item === 'string' ? query.item : rows[0]?.sampleItemId;
  const selected = rows.find((r) => r.sampleItemId === selectedId) ?? rows[0];
  const base = `/assurance/engagements/${engagementId}/testing`;

  // Evidence の AI 要約は ?evidenceSummary=<aiRunId>&fileVersionId=<id> で読み直す
  const canRunAi = can(ctx, 'assurance.ai.run');
  const summaryRunId = typeof query.evidenceSummary === 'string' ? query.evidenceSummary : null;
  const summaryFileVersionId = typeof query.fileVersionId === 'string' ? query.fileVersionId : null;
  const evidenceSummary =
    summaryRunId && summaryFileVersionId
      ? await loadEvidenceSummary(db, ctx, summaryRunId, summaryFileVersionId)
      : null;

  const results = selected
    ? await db.select('testResults', { where: { testId: selected.testId } })
    : [];
  const resultByProcedure = new Map(results.map((r) => [r.procedureId, r]));

  const evidenceLinks = selected
    ? await db.select('evidenceLinks', {
        where: { targetType: 'data_point', targetId: selected.populationItem.sourceDataPointId },
      })
    : [];
  const fileVersions =
    evidenceLinks.length > 0
      ? await db.select('fileVersions', {
          where: { id: { in: evidenceLinks.map((l) => l.fileVersionId) } },
        })
      : [];
  const fragments =
    fileVersions.length > 0
      ? await db.select('fragments', {
          where: { fileVersionId: { in: fileVersions.map((v) => v.id) } },
          limit: 6,
        })
      : [];
  const files =
    fileVersions.length > 0
      ? await db.select('files', { where: { id: { in: fileVersions.map((v) => v.fileId) } } })
      : [];

  const issues = selected
    ? await db.select('issues', {
        where: { engagementId, affectedSampleItemId: selected.sampleItemId },
      })
    : [];

  const canWrite = can(ctx, 'assurance.testing.write');
  const index = rows.findIndex((r) => r.sampleItemId === selected?.sampleItemId);
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : undefined;
  const previous = index > 0 ? rows[index - 1] : undefined;

  return (
    <>
      <EngagementHeader
        context={context}
        page="保証手続・調書"
        actions={
          <>
            {previous && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`${base}?item=${previous.sampleItemId}`}>← 前のサンプル</Link>
              </Button>
            )}
            {next && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`${base}?item=${next.sampleItemId}`}>次のサンプル →</Link>
              </Button>
            )}
          </>
        }
      />

      {!sample || rows.length === 0 ? (
        <div className="p-4">
          <Card>
            <EmptyState
              title="サンプルが未作成です"
              description="サンプリング画面から抽出してください。"
              icon={<FileSearch className="size-5" aria-hidden="true" />}
              action={
                <Button asChild size="sm">
                  <Link href={`/assurance/engagements/${engagementId}/sampling`}>
                    サンプリングへ
                  </Link>
                </Button>
              }
            />
          </Card>
        </div>
      ) : (
        // 三ペイン（指示書 16.7）: 左 Sample 一覧 / 中央 Data Point・手続 / 右 Evidence・履歴
        <div className="grid grid-cols-[280px_1fr_360px] gap-3 p-4">
          {/* 左 */}
          <Card className="h-fit max-h-[calc(100vh-160px)] overflow-y-auto">
            <SectionTitle title={`${sample.name}（${rows.length}）`} />
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.sampleItemId}>
                  <Link
                    href={`${base}?item=${row.sampleItemId}`}
                    aria-current={row.sampleItemId === selected?.sampleItemId ? 'page' : undefined}
                    className={`block px-3 py-1.5 transition-colors ${
                      row.sampleItemId === selected?.sampleItemId
                        ? 'bg-brand-100'
                        : 'hover:bg-brand-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-[12px] font-medium text-ink">
                        {row.unitName}
                      </span>
                      <TestStatusBadge status={row.status as never} />
                    </div>
                    <div className="truncate text-[11px] text-ink-muted">{row.metricName}</div>
                    <div className="flex items-center gap-1">
                      {row.hasException && <Badge tone="danger">例外</Badge>}
                      {row.reviewedBy && <Badge tone="success">Reviewed</Badge>}
                      {row.currentValue !== null && row.currentValue !== row.snapshotValue && (
                        <Badge tone="warning">固定後変更</Badge>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {/* 中央 */}
          <div className="space-y-3">
            {selected && (
              <>
                <Card>
                  <SectionTitle
                    title={`${selected.unitName} / ${selected.metricName}`}
                    action={<ReadOnlyBadge />}
                  />
                  <dl className="grid grid-cols-2 gap-x-6 px-3 pb-3 text-[13px]">
                    <Row
                      label="Snapshot 固定値"
                      value={`${formatNumber(selected.snapshotValue)} ${selected.populationItem.unitOfMeasure}`}
                    />
                    <Row
                      label="現在のクライアント値"
                      value={`${formatNumber(selected.currentValue)} ${selected.populationItem.unitOfMeasure}`}
                    />
                    <Row label="調書番号" value={selected.workpaperRef ?? '未採番'} />
                    <Row label="選定理由" value={selected.selectionReason} />
                  </dl>
                  {selected.currentValue !== null &&
                    selected.currentValue !== selected.snapshotValue && (
                      <p className="flex items-center gap-1.5 border-t border-line bg-warning-soft px-3 py-2 text-[12px] text-[#8a5d00]">
                        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                        Snapshot 固定後にクライアント側で値が変更されています。影響評価を Data Room
                        で記録してください。
                      </p>
                    )}
                </Card>

                <Card>
                  <SectionTitle title="Procedure Checklist" />
                  <ul className="divide-y divide-line">
                    {procedures.map((procedure) => {
                      const result = resultByProcedure.get(procedure.id);
                      return (
                        <li key={procedure.id} className="p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-ink-muted">
                                  {procedure.code}
                                </span>
                                <span className="text-[13px] font-medium text-ink">
                                  {procedure.title}
                                </span>
                                {procedure.required && <Badge tone="brand">必須</Badge>}
                                {result && (
                                  <Badge
                                    tone={
                                      result.result === 'pass'
                                        ? 'success'
                                        : result.result === 'exception'
                                          ? 'danger'
                                          : 'neutral'
                                    }
                                  >
                                    {result.result}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[12px] text-ink-muted">{procedure.description}</p>
                              {result?.note && (
                                <p className="mt-0.5 text-[12px] text-ink">{result.note}</p>
                              )}
                            </div>
                          </div>

                          {canWrite && (
                            <form
                              action={recordTestResultAction}
                              className="mt-2 flex flex-wrap items-end gap-2"
                            >
                              <input type="hidden" name="engagementId" value={engagementId} />
                              <input type="hidden" name="testId" value={selected.testId} />
                              <input type="hidden" name="procedureId" value={procedure.id} />
                              <label className="text-[11px] text-ink-muted">
                                結果
                                <select
                                  name="result"
                                  defaultValue={result?.result ?? 'pass'}
                                  className="mt-0.5 block h-7 rounded-t4d border border-line bg-surface px-1 text-[12px]"
                                >
                                  <option value="pass">相違なし</option>
                                  <option value="exception">例外あり</option>
                                  <option value="not_applicable">該当なし</option>
                                </select>
                              </label>
                              {procedure.category === 'recalculation' && (
                                <>
                                  <label className="text-[11px] text-ink-muted">
                                    再計算結果
                                    <Input
                                      name="recalculationResult"
                                      defaultValue={result?.recalculationResult ?? ''}
                                      inputMode="decimal"
                                      className="mt-0.5 w-28"
                                    />
                                  </label>
                                  <label className="text-[11px] text-ink-muted">
                                    記録値
                                    <Input
                                      name="recordedValue"
                                      defaultValue={result?.recordedValue ?? selected.snapshotValue}
                                      inputMode="decimal"
                                      className="mt-0.5 w-28"
                                    />
                                  </label>
                                </>
                              )}
                              <label className="min-w-[220px] flex-1 text-[11px] text-ink-muted">
                                メモ
                                <Input
                                  name="note"
                                  defaultValue={result?.note ?? ''}
                                  className="mt-0.5"
                                />
                              </label>
                              <Button type="submit" size="xs" variant="outline">
                                記録
                              </Button>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Card>

                <Card>
                  <SectionTitle title="結論（Conclusion Draft）" />
                  <form action={updateTestAction} className="space-y-2 p-3">
                    <input type="hidden" name="engagementId" value={engagementId} />
                    <input type="hidden" name="testId" value={selected.testId} />
                    <Textarea
                      name="conclusionDraft"
                      rows={3}
                      defaultValue={selected.conclusionDraft ?? ''}
                      placeholder="実施した手続と結論を記載してください（保証意見ではありません）。"
                      aria-label="結論"
                      disabled={!canWrite}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        name="workpaperRef"
                        defaultValue={selected.workpaperRef ?? ''}
                        placeholder="調書番号（例: WP-1000）"
                        aria-label="調書番号"
                        className="w-48"
                        disabled={!canWrite}
                      />
                      {canWrite && (
                        <>
                          <Button
                            type="submit"
                            name="action"
                            value="save"
                            size="sm"
                            variant="outline"
                          >
                            保存
                          </Button>
                          <Button type="submit" name="action" value="prepare" size="sm">
                            <Check aria-hidden="true" />
                            作成完了（Prepared）
                          </Button>
                          <Button
                            type="submit"
                            name="action"
                            value="review"
                            size="sm"
                            variant="secondary"
                            disabled={!selected.preparedBy || selected.preparedBy === ctx.userId}
                          >
                            レビュー完了（Reviewed）
                          </Button>
                        </>
                      )}
                    </div>
                    {selected.preparedBy === ctx.userId && (
                      <p className="text-[11px] text-ink-muted">
                        自身が作成した調書を自身でレビューすることはできません（自己レビュー禁止）。
                      </p>
                    )}
                  </form>
                </Card>
              </>
            )}
          </div>

          {/* 右 */}
          <div className="space-y-3">
            <Card>
              <SectionTitle title={`Evidence（${evidenceLinks.length}）`} />
              {evidenceLinks.length === 0 ? (
                <EmptyState
                  title="Evidence がありません"
                  description="PBC 依頼で追加提出を求めることができます。"
                />
              ) : (
                <ul className="divide-y divide-line">
                  {evidenceLinks.map((link) => {
                    const version = fileVersions.find((v) => v.id === link.fileVersionId);
                    const file = files.find((f) => f.id === version?.fileId);
                    return (
                      <li key={link.id} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] font-medium text-ink">
                            {file?.originalName ?? '（ファイル）'}
                          </span>
                          {version && (
                            <a
                              href={`/api/files/signed-url?fileVersionId=${version.id}&engagementId=${engagementId}`}
                              className="shrink-0 text-[11px] text-brand-700 hover:underline"
                            >
                              開く
                            </a>
                          )}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {link.page ? `p.${link.page}` : ''} {link.cellRef ?? ''}
                        </div>
                        {version && canRunAi && (
                          <form action={summarizeEvidenceAction} className="mt-1">
                            <input type="hidden" name="engagementId" value={engagementId} />
                            <input type="hidden" name="fileVersionId" value={version.id} />
                            <Button type="submit" size="xs" variant="outline">
                              <Sparkles aria-hidden="true" />
                              AI に要約させる
                            </Button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {evidenceSummary && (
              <Card>
                <SectionTitle
                  title="Evidence の AI 要約"
                  action={
                    <span className="text-[11px] text-ink-muted">
                      要約であり保証結論ではありません
                    </span>
                  }
                />
                <div className="space-y-1.5 px-3 py-2">
                  <p className="text-[12px] text-ink">{evidenceSummary.summary.summary}</p>
                  {evidenceSummary.summary.keyFigures.length > 0 && (
                    <ul className="space-y-0.5">
                      {evidenceSummary.summary.keyFigures.map((figure, index) => (
                        <li key={index} className="text-[11px] text-ink-muted">
                          {figure.label}: {figure.value}
                          {figure.locator ? `（${figure.locator}）` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div>
                    <p className="text-[11px] font-medium text-ink">確かめること</p>
                    <ul className="list-disc pl-4">
                      {evidenceSummary.summary.pointsToVerify.map((point, index) => (
                        <li key={index} className="text-[11px] text-ink-muted">
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Card>
            )}

            {fragments.length > 0 && (
              <Card>
                <SectionTitle title="Evidence 抽出テキスト" />
                <ul className="divide-y divide-line">
                  {fragments.map((fragment) => (
                    <li key={fragment.id} className="px-3 py-1.5">
                      <div className="text-[11px] text-ink-muted">{fragment.locator}</div>
                      <p className="text-[12px] text-ink">{fragment.text.slice(0, 160)}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <SectionTitle title="このサンプルに紐づく指摘" />
              {issues.length === 0 ? (
                <EmptyState title="指摘はありません" />
              ) : (
                <ul className="divide-y divide-line">
                  {issues.map((issue) => (
                    <li key={issue.id} className="px-3 py-1.5">
                      <div className="text-[12px] font-medium text-ink">
                        {issue.code} {issue.title}
                      </div>
                      <div className="text-[11px] text-ink-muted">{issue.status}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {selected && (
              <Card>
                <SectionTitle title="調書メタデータ" />
                <dl className="space-y-1 px-3 pb-3 text-[12px]">
                  <Row label="Prepared" value={selected.preparedBy ? '完了' : '未'} />
                  <Row label="Reviewed" value={selected.reviewedBy ? '完了' : '未'} />
                  <Row
                    label="必須手続の実施"
                    value={`${
                      procedures.filter(
                        (p) => p.required && selected.completedProcedureIds.includes(p.id),
                      ).length
                    } / ${procedures.filter((p) => p.required).length}`}
                  />
                  <Row label="更新" value={formatJst(selected.updatedAt)} />
                </dl>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1 last:border-b-0">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}
