import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, FileSearch, Sparkles } from 'lucide-react';
import { ActionButton } from '@/components/shared/action-button';
import { ReadOnlyBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadTestingWorkspace } from '@/lib/services/assurance';
import { loadEvidenceSummary } from '@/lib/services/ai-assist';
import { canFor } from '@/lib/ui/home-profile';
import { SELF_REVIEW_REASON, testStateActions } from '@/lib/ui/state-actions';
import type { TestStatus } from '@/types/domain';
import {
  recordTestResultAction,
  summarizeEvidenceAction,
  updateTestAction,
} from '../../../actions';
import { TEST_RESULT_OPTIONS, testResultEntry } from '../../../_components/labels';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '保証手続・調書' };

/** サーバーの検査（updateTestAction）と同じ趣旨の文: 作成が済んでいない調書はレビューできない */
const NOT_PREPARED_REASON = '作成完了として記録してから、他の人がレビューします。';

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

  // 状態で変わる主操作（plan §1.15 調書の行）。作成・保存・レビューの 3 つは状態によらず残し
  // （サーバーはどの状態でも受け付ける）、強調だけを状態で変える
  const preparedByMe = selected?.preparedBy === ctx.userId;
  const actionPlan = selected
    ? testStateActions({
        status: selected.status as TestStatus,
        can: canFor(ctx),
        preparedByMe,
      })
    : null;
  const primaryId = actionPlan?.primary?.id ?? null;
  const reviewBlockedReason = !selected?.preparedBy
    ? NOT_PREPARED_REASON
    : preparedByMe
      ? SELF_REVIEW_REASON
      : null;

  return (
    <>
      <EngagementHeader
        context={context}
        page="保証手続・調書"
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'previous-sample',
                label: '前のサンプル',
                icon: <ArrowLeft aria-hidden="true" />,
                href: previous ? `${base}?item=${previous.sampleItemId}` : base,
                hidden: !previous,
              },
              {
                kind: 'link',
                id: 'next-sample',
                label: '次のサンプル',
                icon: <ArrowRight aria-hidden="true" />,
                href: next ? `${base}?item=${next.sampleItemId}` : base,
                hidden: !next,
              },
            ]}
          />
        }
      />

      {!sample || rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            kind="no-data"
            title="サンプルが未作成です"
            description="サンプリング画面で母集団からサンプルを抽出すると、ここで手続と調書を記録できます。"
            icon={<FileSearch className="size-5" aria-hidden="true" />}
            action={
              <Button variant="secondary" asChild size="sm">
                <Link href={`/assurance/engagements/${engagementId}/sampling`}>サンプリングへ</Link>
              </Button>
            }
          />
        </div>
      ) : (
        // 三ペイン（指示書 16.7）: 左 サンプル一覧 / 中央 データ・手続・結論 / 右 資料・関連
        <div className="space-y-3 p-4">
          <FlashMessage searchParams={query} />
          <div className="grid grid-cols-[280px_1fr_360px] gap-3">
            {/* 左 */}
            <aside
              aria-labelledby="sample-list-title"
              className="h-fit max-h-[calc(100vh-160px)] overflow-y-auto rounded-t4d-lg border border-line bg-surface"
            >
              <h2 id="sample-list-title" className="px-3 py-2 text-body font-semibold text-ink">
                {sample.name}（{rows.length}）
              </h2>
              <ul className="divide-y divide-line border-t border-line">
                {rows.map((row) => (
                  <li key={row.sampleItemId} data-t4d-record="">
                    <Link
                      href={`${base}?item=${row.sampleItemId}`}
                      aria-current={
                        row.sampleItemId === selected?.sampleItemId ? 'page' : undefined
                      }
                      className={`block px-3 py-1.5 transition-colors ${
                        row.sampleItemId === selected?.sampleItemId
                          ? 'bg-brand-100'
                          : 'hover:bg-brand-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-small font-medium text-ink">
                          {row.unitName}
                        </span>
                        <StatusBadge domain="test" value={row.status as TestStatus} />
                      </div>
                      <div className="truncate text-caption text-ink-muted">{row.metricName}</div>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.hasException && <SemanticBadge semantic="error" label="例外" />}
                        {row.reviewedBy && row.status !== 'reviewed' && (
                          <SemanticBadge semantic="done" label="レビュー済み" />
                        )}
                        {row.currentValue !== null && row.currentValue !== row.snapshotValue && (
                          <SemanticBadge semantic="blocked" label="固定後に変更" />
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>

            {/* 中央 */}
            <div className="min-w-0 space-y-3">
              {selected && (
                <>
                  <Section
                    title={`${selected.unitName} / ${selected.metricName}`}
                    actions={<ReadOnlyBadge />}
                    divider="none"
                  >
                    <dl className="grid grid-cols-2 gap-x-6 text-body">
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
                        <Notice tone="warning" className="mt-2">
                          Snapshot 固定後にクライアント側で値が変更されています。影響評価を Data
                          Room で記録してください。
                        </Notice>
                      )}
                  </Section>

                  <Section title="手続チェックリスト">
                    <ul className="divide-y divide-line rounded-t4d border border-line">
                      {procedures.map((procedure) => {
                        const result = resultByProcedure.get(procedure.id);
                        const entry = result ? testResultEntry(result.result) : null;
                        return (
                          <li key={procedure.id} className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-caption text-ink-muted">
                                {procedure.code}
                              </span>
                              <span className="text-body font-medium text-ink">
                                {procedure.title}
                              </span>
                              {procedure.required && (
                                <span className="rounded-t4d bg-danger-soft px-1 text-caption text-danger">
                                  必須
                                </span>
                              )}
                              {result && entry && (
                                <SemanticBadge
                                  semantic={entry.semantic}
                                  label={entry.label}
                                  dataAttributes={{ 'data-test-result': result.result }}
                                />
                              )}
                            </div>
                            <p className="text-small text-ink-muted">{procedure.description}</p>
                            {result?.note && (
                              <p className="mt-0.5 text-small text-ink">{result.note}</p>
                            )}

                            {canWrite && (
                              <form
                                action={recordTestResultAction}
                                className="mt-1.5 flex flex-wrap items-end gap-2"
                              >
                                <input type="hidden" name="engagementId" value={engagementId} />
                                <input type="hidden" name="testId" value={selected.testId} />
                                <input type="hidden" name="procedureId" value={procedure.id} />
                                <label className="text-caption text-ink-muted">
                                  結果
                                  <NativeSelect
                                    name="result"
                                    size="sm"
                                    defaultValue={result?.result ?? 'pass'}
                                    className="mt-0.5 w-auto"
                                  >
                                    {TEST_RESULT_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </NativeSelect>
                                </label>
                                {procedure.category === 'recalculation' && (
                                  <>
                                    <label className="text-caption text-ink-muted">
                                      再計算結果
                                      <Input
                                        name="recalculationResult"
                                        defaultValue={result?.recalculationResult ?? ''}
                                        inputMode="decimal"
                                        className="mt-0.5 w-28"
                                      />
                                    </label>
                                    <label className="text-caption text-ink-muted">
                                      記録値
                                      <Input
                                        name="recordedValue"
                                        defaultValue={
                                          result?.recordedValue ?? selected.snapshotValue
                                        }
                                        inputMode="decimal"
                                        className="mt-0.5 w-28"
                                      />
                                    </label>
                                  </>
                                )}
                                <label className="min-w-[220px] flex-1 text-caption text-ink-muted">
                                  メモ
                                  <Input
                                    name="note"
                                    defaultValue={result?.note ?? ''}
                                    className="mt-0.5"
                                  />
                                </label>
                                <SubmitButton size="xs" variant="secondary">
                                  記録
                                </SubmitButton>
                              </form>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Section>

                  <Section
                    title="結論（下書き）"
                    summary={<StatusBadge domain="test" value={selected.status as TestStatus} />}
                  >
                    <form action={updateTestAction} className="space-y-2">
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
                            <SubmitButton name="action" value="save" size="sm" variant="secondary">
                              保存
                            </SubmitButton>
                            <SubmitButton
                              variant={primaryId === 'prepare' ? 'primary' : 'secondary'}
                              name="action"
                              value="prepare"
                              size="sm"
                              icon={<Check aria-hidden="true" />}
                            >
                              作成完了として記録
                            </SubmitButton>
                            {reviewBlockedReason ? (
                              <ActionButton
                                variant={primaryId === 'review' ? 'primary' : 'secondary'}
                                action={{
                                  kind: 'submit',
                                  id: 'review',
                                  label: 'レビュー完了として記録',
                                  action: updateTestAction,
                                  disabledReason: reviewBlockedReason,
                                }}
                              />
                            ) : (
                              <SubmitButton
                                variant={primaryId === 'review' ? 'primary' : 'secondary'}
                                name="action"
                                value="review"
                                size="sm"
                              >
                                レビュー完了として記録
                              </SubmitButton>
                            )}
                          </>
                        )}
                      </div>
                      {preparedByMe && (
                        <p className="text-caption text-ink-muted">
                          自身が作成した調書を自身でレビューすることはできません（自己レビュー禁止）。
                        </p>
                      )}
                    </form>
                  </Section>
                </>
              )}
            </div>

            {/* 右 */}
            <div className="min-w-0 space-y-3">
              <Section title={`資料（${evidenceLinks.length}）`} divider="none">
                {evidenceLinks.length === 0 ? (
                  <EmptyState
                    kind="no-data"
                    size="compact"
                    title="紐付いた資料がありません"
                    description="企業へ資料依頼（PBC）で追加の提出を求めることができます。"
                    action={
                      <Link
                        href={`/assurance/engagements/${engagementId}/requests?new=1`}
                        className="text-small text-brand-700 hover:underline"
                      >
                        資料依頼を作成
                      </Link>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-line rounded-t4d border border-line">
                    {evidenceLinks.map((link) => {
                      const version = fileVersions.find((v) => v.id === link.fileVersionId);
                      const file = files.find((f) => f.id === version?.fileId);
                      return (
                        <li key={link.id} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-small font-medium text-ink">
                              {file?.originalName ?? '（ファイル）'}
                            </span>
                            {version && (
                              <a
                                href={`/api/files/signed-url?fileVersionId=${version.id}&engagementId=${engagementId}`}
                                className="shrink-0 text-caption text-brand-700 hover:underline"
                              >
                                開く
                              </a>
                            )}
                          </div>
                          <div className="text-caption text-ink-muted">
                            {link.page ? `p.${link.page}` : ''} {link.cellRef ?? ''}
                          </div>
                          {version && canRunAi && (
                            <form action={summarizeEvidenceAction} className="mt-1">
                              <input type="hidden" name="engagementId" value={engagementId} />
                              <input type="hidden" name="fileVersionId" value={version.id} />
                              <SubmitButton
                                size="xs"
                                variant="secondary"
                                icon={<Sparkles aria-hidden="true" />}
                                pendingLabel="要約中…"
                              >
                                AI に要約させる
                              </SubmitButton>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>

              {evidenceSummary && (
                <Section title="Evidence の AI 要約" summary={<HonestyBadge kind="ai-candidate" />}>
                  <div className="space-y-1.5">
                    {/* 要約は候補。保証結論ではないことを常に見せる（折りたたまない） */}
                    <p className="text-caption text-ink-muted">要約であり保証結論ではありません</p>
                    <p className="text-small text-ink">{evidenceSummary.summary.summary}</p>
                    {evidenceSummary.summary.keyFigures.length > 0 && (
                      <ul className="space-y-0.5">
                        {evidenceSummary.summary.keyFigures.map((figure, position) => (
                          <li key={position} className="text-caption text-ink-muted">
                            {figure.label}: {figure.value}
                            {figure.locator ? `（${figure.locator}）` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div>
                      <p className="text-caption font-medium text-ink">確かめること</p>
                      <ul className="list-disc pl-4">
                        {evidenceSummary.summary.pointsToVerify.map((point, position) => (
                          <li key={position} className="text-caption text-ink-muted">
                            {point}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </Section>
              )}

              {fragments.length > 0 && (
                <Section
                  id="evidence-text"
                  title="資料の抽出テキスト"
                  collapsible
                  summary={`${fragments.length} 件の抜粋`}
                >
                  <ul className="divide-y divide-line">
                    {fragments.map((fragment) => (
                      <li key={fragment.id} className="py-1.5">
                        <div className="text-caption text-ink-muted">{fragment.locator}</div>
                        <p className="text-small text-ink">{fragment.text.slice(0, 160)}</p>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section
                id="sample-issues"
                title={`このサンプルに紐づく指摘（${issues.length}）`}
                collapsible
                open={issues.length > 0 || undefined}
                summary={issues.length === 0 ? '指摘はありません' : `${issues.length} 件`}
              >
                {issues.length === 0 ? (
                  <p className="text-small text-ink-muted">
                    指摘はありません。例外を記録したら、指摘・例外の画面で起票します。
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {issues.map((issue) => (
                      <li key={issue.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="text-small font-medium text-ink">
                          {issue.code} {issue.title}
                        </span>
                        <StatusBadge domain="issue" value={issue.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {selected && (
                <Section
                  id="workpaper-record"
                  title="調書の記録情報"
                  collapsible
                  summary={`更新 ${formatJst(selected.updatedAt)}`}
                >
                  <dl className="space-y-1 text-small">
                    <Row label="作成（Prepared）" value={selected.preparedBy ? '完了' : '未'} />
                    <Row label="レビュー（Reviewed）" value={selected.reviewedBy ? '完了' : '未'} />
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
                </Section>
              )}
            </div>
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
