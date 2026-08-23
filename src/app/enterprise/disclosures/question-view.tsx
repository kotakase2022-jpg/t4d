import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Bot, Check, Send, Undo2 } from 'lucide-react';
import { AiGeneratedBadge, ResponseStatusBadge } from '@/components/shared/badges';
import { CommentBox } from '@/components/shared/comment-box';
import { MentionText } from '@/components/shared/mention-text';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { FrameworkKey } from '@/types/domain';
import {
  generateCdpDraftAction,
  rejectAiDraftAction,
  saveCdpResponseAction,
  transitionCdpResponseAction,
} from '../actions';

/**
 * 開示質問の詳細（三ペイン）。CDP と CSRD で共有する。
 * フレームワーク固有なのはキー・ラベル・リンク先だけなので Props で受ける。
 */
export async function QuestionDetailView({
  frameworkKey,
  frameworkLabel,
  basePath,
  questionId,
}: {
  frameworkKey: FrameworkKey;
  frameworkLabel: string;
  basePath: string;
  questionId: string;
}) {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const workspace = await loadDisclosureWorkspace(
    db,
    ctx,
    frameworkKey,
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
  );
  if (!workspace) notFound();

  const index = workspace.rows.findIndex((r) => r.item.id === questionId);
  const row = workspace.rows[index];
  if (!row) notFound();

  const previousRow = index > 0 ? workspace.rows[index - 1] : undefined;
  const nextRow = index < workspace.rows.length - 1 ? workspace.rows[index + 1] : undefined;

  const currentVersion = row.response?.currentVersionId
    ? await db.findById('disclosureResponseVersions', row.response.currentVersionId)
    : null;
  const aiRun = currentVersion?.originatedFromAiRunId
    ? await db.findById('aiRuns', currentVersion.originatedFromAiRunId)
    : null;

  const versions = row.response
    ? await db.select('disclosureResponseVersions', {
        where: { responseId: row.response.id },
        orderBy: { column: 'versionNo', dir: 'desc' },
      })
    : [];

  // 質問単位のコメント＋メンション（WF-P0-002）
  const comments = row.response
    ? await db.select('comments', {
        where: { targetType: 'disclosure_response', targetId: row.response.id },
        orderBy: { column: 'createdAt', dir: 'desc' },
      })
    : [];
  const mentionCandidates = await listMentionCandidates(db, ctx);
  const authorNameById = new Map(mentionCandidates.map((m) => [m.userId, m.displayName]));

  const status = row.response?.status ?? 'not_started';
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');
  const isAiDraft = Boolean(currentVersion?.originatedFromAiRunId);

  const delta =
    row.currentValue !== null && row.previousValue !== null && row.previousValue !== 0
      ? ((row.currentValue - row.previousValue) / row.previousValue) * 100
      : null;

  return (
    <>
      <PageHeader
        title={`${row.item.code} ${row.item.section}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ResponseStatusBadge status={status} />
            <Badge tone={row.item.changeType === 'new' ? 'warning' : 'neutral'}>
              {row.item.changeType === 'new'
                ? '新規質問'
                : row.item.changeType === 'changed'
                  ? '変更あり'
                  : '前年から継続'}
            </Badge>
            {row.item.required && <Badge tone="brand">必須</Badge>}
            {isAiDraft && aiRun && <AiGeneratedBadge provider={aiRun.provider} />}
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: frameworkLabel, href: basePath },
          { label: row.item.code },
        ]}
        actions={
          <>
            {previousRow && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`${basePath}/${previousRow.item.id}`}>← 前の質問</Link>
              </Button>
            )}
            {nextRow && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`${basePath}/${nextRow.item.id}`}>次の質問 →</Link>
              </Button>
            )}
          </>
        }
      />

      {/* 三ペイン（指示書 15.4） */}
      <div className="grid grid-cols-[260px_1fr_360px] gap-3 p-4">
        {/* 左: 質問ツリー */}
        <Card className="h-fit max-h-[calc(100vh-160px)] overflow-y-auto">
          <SectionTitle title="質問一覧" />
          <ul className="divide-y divide-line">
            {workspace.rows.map((r) => (
              <li key={r.item.id}>
                <Link
                  href={`${basePath}/${r.item.id}`}
                  aria-current={r.item.id === row.item.id ? 'page' : undefined}
                  className={`block px-3 py-1.5 text-[12px] transition-colors ${
                    r.item.id === row.item.id
                      ? 'bg-brand-100 font-medium text-brand-900'
                      : 'text-ink hover:bg-brand-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono">{r.item.code}</span>
                    <span className="flex items-center gap-1">
                      {r.item.changeType === 'new' && <Badge tone="warning">新</Badge>}
                      {r.item.changeType === 'changed' && <Badge tone="brand">変</Badge>}
                      {(r.response?.status ?? 'not_started') === 'approved' && (
                        <Check className="size-3 text-success" aria-label="承認済み" />
                      )}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-ink-muted">{r.item.questionText}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* 中央: 質問と回答エディタ */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title="質問" />
            <div className="space-y-2 px-3 pb-3">
              <p className="text-[13px] text-ink">{row.item.questionText}</p>
              {row.item.guidance && (
                <p className="rounded-t4d bg-surface-muted p-2 text-[12px] text-ink-muted">
                  Guidance: {row.item.guidance}
                </p>
              )}
              <p className="text-[11px] text-ink-muted">
                回答型: {row.item.answerType}
                {row.item.options.length > 0 && ` ／ 選択肢: ${row.item.options.join(' / ')}`}
              </p>
            </div>
          </Card>

          {(row.currentValue !== null || row.previousValue !== null || row.previousResponse) && (
            <Card>
              <SectionTitle title="前年差分（YoY Diff）" />
              <div className="grid grid-cols-3 gap-3 px-3 pb-3 text-[12px]">
                <div>
                  <div className="text-ink-muted">当年（承認済みデータ）</div>
                  <div className="tnum text-[16px] font-semibold text-ink">
                    {formatNumber(row.currentValue)}
                  </div>
                </div>
                <div>
                  <div className="text-ink-muted">
                    前年（{workspace.previousPeriod?.code ?? '—'}）
                  </div>
                  <div className="tnum text-[16px] font-semibold text-ink-muted">
                    {formatNumber(row.previousValue)}
                  </div>
                </div>
                <div>
                  <div className="text-ink-muted">増減</div>
                  <div
                    className={`tnum text-[16px] font-semibold ${
                      delta === null
                        ? 'text-ink-muted'
                        : delta >= 0
                          ? 'text-danger'
                          : 'text-success'
                    }`}
                  >
                    {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
                  </div>
                </div>
              </div>
              {row.previousResponse?.answerText && (
                <div className="border-t border-line px-3 py-2">
                  <div className="text-[11px] font-medium text-ink-muted">前年回答</div>
                  <p className="whitespace-pre-wrap text-[12px] text-ink-muted">
                    {row.previousResponse.answerText}
                  </p>
                </div>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle
              title="回答"
              action={
                isAiDraft ? (
                  <Badge tone="warning">
                    AI 下書きのままでは承認できません（編集して保存してください）
                  </Badge>
                ) : undefined
              }
            />
            {canWrite && row.response ? (
              <form action={saveCdpResponseAction} className="space-y-2 p-3">
                <input type="hidden" name="responseId" value={row.response.id} />
                {aiRun && <input type="hidden" name="aiRunId" value={aiRun.id} />}
                <input type="hidden" name="editedFromAi" value={isAiDraft ? 'true' : 'false'} />

                {row.item.answerType === 'numeric' && (
                  <label className="block text-[12px] text-ink-muted">
                    数値
                    <Input
                      name="answerNumeric"
                      defaultValue={row.response.answerNumeric ?? row.currentValue ?? ''}
                      inputMode="decimal"
                      className="mt-0.5 w-48"
                    />
                  </label>
                )}

                {row.item.answerType === 'single_choice' && (
                  <fieldset className="text-[12px] text-ink-muted">
                    <legend>選択</legend>
                    <div className="mt-0.5 flex flex-wrap gap-2">
                      {row.item.options.map((option) => (
                        <label
                          key={option}
                          className="flex items-center gap-1 text-[13px] text-ink"
                        >
                          <input
                            type="radio"
                            name="answerChoice"
                            value={option}
                            defaultChecked={row.response?.answerChoice.includes(option)}
                            className="accent-[#0b57a4]"
                          />
                          {option}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                <label className="block text-[12px] text-ink-muted">
                  回答本文
                  <Textarea
                    name="answerText"
                    rows={10}
                    defaultValue={row.response.answerText ?? ''}
                    placeholder="承認済みデータと Evidence を根拠に記載してください。"
                    className="mt-0.5"
                  />
                </label>

                <label className="block text-[12px] text-ink-muted">
                  前年からの扱い
                  <select
                    name="carryForwardDecision"
                    defaultValue={row.response.carryForwardDecision ?? ''}
                    className="mt-0.5 block h-7 w-48 rounded-t4d border border-line bg-surface px-2 text-[13px]"
                  >
                    <option value="">未設定</option>
                    <option value="reuse">前年をそのまま継続</option>
                    <option value="update">前年を更新</option>
                    <option value="new">新規作成</option>
                  </select>
                </label>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <SubmitButton size="sm" data-t4d-shortcut="save" pendingLabel="保存中…">
                    保存（下書き）
                  </SubmitButton>
                </div>
              </form>
            ) : (
              <div className="p-3">
                <p className="whitespace-pre-wrap text-[13px] text-ink">
                  {row.response?.answerText ?? '（未回答）'}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
              {canWrite && row.response && status === 'draft' && (
                <form action={transitionCdpResponseAction}>
                  <input type="hidden" name="responseId" value={row.response.id} />
                  <input type="hidden" name="to" value="in_review" />
                  <Button type="submit" size="sm" variant="outline">
                    <Send aria-hidden="true" />
                    レビュー依頼
                  </Button>
                </form>
              )}
              {canWrite && row.response && status === 'in_review' && (
                <form action={transitionCdpResponseAction}>
                  <input type="hidden" name="responseId" value={row.response.id} />
                  <input type="hidden" name="to" value="returned" />
                  <Button type="submit" size="sm" variant="outline">
                    <Undo2 aria-hidden="true" />
                    差戻し
                  </Button>
                </form>
              )}
              {canApprove && row.response && (status === 'in_review' || status === 'draft') && (
                <form action={transitionCdpResponseAction}>
                  <input type="hidden" name="responseId" value={row.response.id} />
                  <input type="hidden" name="to" value="approved" />
                  <Button type="submit" size="sm" disabled={isAiDraft}>
                    <Check aria-hidden="true" />
                    承認
                  </Button>
                </form>
              )}
              {isAiDraft && (
                <span className="text-[11px] text-[#8a5d00]">
                  AI 生成のままでは承認できません（DB 側でも禁止されています）。
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* 右: AI / マッピング / Evidence / 履歴 */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title="AI 回答ドラフト" />
            <div className="space-y-2 p-3">
              <p className="text-[11px] text-ink-muted">
                承認済みデータ・前年回答・Evidence を根拠に下書きを生成します。AI
                は確定しません。人が編集・承認してください。
              </p>
              {can(ctx, 'enterprise.ai.run') && row.response && (
                <form action={generateCdpDraftAction}>
                  <input type="hidden" name="responseId" value={row.response.id} />
                  <SubmitButton
                    size="sm"
                    variant="secondary"
                    icon={<Bot aria-hidden="true" />}
                    pendingLabel="生成中…"
                  >
                    ドラフトを生成
                  </SubmitButton>
                </form>
              )}

              {aiRun && (
                <div className="space-y-1.5 rounded-t4d border border-line bg-surface-muted p-2">
                  <div className="flex items-center justify-between gap-2">
                    <AiGeneratedBadge provider={aiRun.provider} />
                    <span className="text-[11px] text-ink-muted">
                      確信度 {Math.round(aiRun.confidence * 100)}%
                    </span>
                  </div>
                  <dl className="space-y-0.5 text-[11px] text-ink-muted">
                    <div className="flex justify-between gap-2">
                      <dt>Model</dt>
                      <dd className="truncate text-ink">{aiRun.model}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Prompt</dt>
                      <dd className="truncate text-ink">{aiRun.promptVersion}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>対象年度</dt>
                      <dd className="text-ink">{workspace.period.code}</dd>
                    </div>
                  </dl>

                  {aiRun.sourceReferences.length > 0 && (
                    <div>
                      <div className="text-[11px] font-medium text-ink">参照元</div>
                      <ul className="space-y-0.5">
                        {aiRun.sourceReferences.map((s, i) => (
                          <li key={i} className="text-[11px] text-ink-muted">
                            ・{s.label}
                            {s.periodLabel ? `（${s.periodLabel}）` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {aiRun.warnings.length > 0 && (
                    <ul className="space-y-0.5">
                      {aiRun.warnings.map((w, i) => (
                        <li key={i} className="text-[11px] text-[#8a5d00]">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}

                  {aiRun.status === 'rejected' ? (
                    // Reject の結果が画面に出ないと「押しても何も起きない」ボタンになる。
                    // 採否は ai_runs に残る監査証跡なので、ここでも状態を明示する。
                    <div className="flex items-center gap-1.5">
                      <Badge tone="danger">Reject 済み</Badge>
                      <span className="text-[11px] text-ink-muted">
                        この AI 下書きは採用しないと記録しました。
                      </span>
                    </div>
                  ) : (
                    <form action={rejectAiDraftAction}>
                      <input type="hidden" name="aiRunId" value={aiRun.id} />
                      <input type="hidden" name="itemId" value={row.item.id} />
                      <Button type="submit" size="xs" variant="outline">
                        この下書きを Reject
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Data Mapping" />
            {row.mappedMetrics.length === 0 ? (
              <EmptyState title="マッピングされた指標がありません" />
            ) : (
              <ul className="divide-y divide-line">
                {row.mappedMetrics.map((metric) => (
                  <li key={metric.id} className="px-3 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-ink">{metric.name}</span>
                      <span className="tnum text-[12px] text-ink-muted">
                        {formatNumber(row.currentValue)} {metric.unit}
                      </span>
                    </div>
                    <Link
                      href={`/enterprise/data?q=${encodeURIComponent(metric.name)}&status=approved`}
                      className="text-[11px] text-brand-700 hover:underline"
                    >
                      承認済みデータを見る
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title={`コメント（${comments.length}）`} />
            {canWrite && row.response && (
              <CommentBox
                targetType="disclosure_response"
                targetId={row.response.id}
                href={`${basePath}/${row.item.id}`}
                members={mentionCandidates}
              />
            )}
            {comments.length === 0 ? (
              <EmptyState title="コメントはありません" />
            ) : (
              <ul className="divide-y divide-line">
                {comments.map((c) => (
                  <li key={c.id} className="px-3 py-1.5">
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
            <SectionTitle title={`Version 履歴（${versions.length}）`} />
            {versions.length === 0 ? (
              <EmptyState title="履歴はありません" />
            ) : (
              <ul className="divide-y divide-line">
                {versions.map((v) => (
                  <li key={v.id} className="px-3 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-ink">v{v.versionNo}</span>
                      {v.originatedFromAiRunId && <Badge tone="warning">AI 由来</Badge>}
                    </div>
                    <div className="text-[11px] text-ink-muted">{v.changeReason ?? '—'}</div>
                    <div className="text-[11px] text-ink-muted">{formatJst(v.createdAt)}</div>
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
