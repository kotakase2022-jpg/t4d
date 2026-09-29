import { ClipboardCheck, History, Info } from 'lucide-react';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import type { ParagraphDiff } from '@/lib/domain/disclosure-block';
import { reviewPolicyLabel } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import type { EditorReviewRequest } from '@/lib/services/disclosure-block';
import type { ReviewActionState } from '@/lib/services/disclosure-review';
import {
  completeReviewAction,
  finalApproveAction,
  returnReviewAction,
  withdrawReviewAction,
} from '../actions';
import { ReviewRequestStatusBadge } from '../status-badges';
import { DiffText } from './diff-text';

/**
 * レビュー・最終承認の操作（依頼中・承認待ちの節）。
 * 審査するのは依頼で固定した版。前回の版からの差分・引用・未解決の指摘は同じ画面の本文と根拠パネルで確認する。
 * 企業内の承認であり、第三者保証ではない。
 */
export function ReviewPanel({
  projectId,
  blockId,
  request,
  actions,
  paragraphs,
  diff,
  history,
}: {
  projectId: string;
  blockId: string;
  request: EditorReviewRequest | null;
  actions: ReviewActionState | null;
  /** 依頼で固定した版の段落（差戻しの対象を選ぶ） */
  paragraphs: Array<{ id: string; label: string }>;
  /** 前の版からの差分（依頼で固定した版） */
  diff: ParagraphDiff[] | null;
  history: EditorReviewRequest[];
}) {
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="blockId" value={blockId} />
      {request && <input type="hidden" name="requestId" value={request.id} />}
    </>
  );
  const past = history.filter((r) => r.id !== request?.id);

  return (
    <section
      aria-labelledby="review-panel-title"
      className="border-b border-line bg-surface px-4 py-3"
    >
      {request ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck className="size-4 text-brand-700" aria-hidden="true" />
            <h2 id="review-panel-title" className="text-[13px] font-semibold text-ink">
              レビュー・承認（版 {request.targetVersionNo ?? '—'} を審査中）
            </h2>
            <ReviewRequestStatusBadge status={request.status} />
            <span className="text-[12px] text-ink-muted">
              依頼 {request.requestedByName} ／ レビュー {request.reviewerName} ／ 最終承認{' '}
              {request.approverName} ／ 規則 {reviewPolicyLabel(request.policyVersion)}
            </span>
          </div>
          <p className="mt-1 flex items-start gap-1 text-[11px] text-ink-muted">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            社内のレビュー・承認です（第三者保証ではありません）。依頼者・版の作成者・同じ依頼のレビュー完了者は最終承認できません。
          </p>

          {diff && (
            <details className="mt-2 text-[12px]">
              <summary className="cursor-pointer text-brand-700">前の版からの差分を表示</summary>
              <ol className="mt-1 space-y-1">
                {diff
                  .filter((d) => d.kind !== 'unchanged')
                  .map((d) => (
                    <li
                      key={`${d.kind}-${d.paragraphId}`}
                      className="rounded-t4d border border-line p-1.5"
                    >
                      <span className="mr-1 font-mono text-[10px] text-ink-muted">
                        {d.paragraphId}
                      </span>
                      {d.kind === 'changed' ? (
                        <DiffText segments={d.segments} />
                      ) : d.kind === 'added' ? (
                        <ins className="text-ink">
                          <span className="sr-only">（追加）</span>
                          {d.text}
                        </ins>
                      ) : (
                        <del className="text-ink-muted">
                          <span className="sr-only">（削除）</span>
                          {d.text}
                        </del>
                      )}
                    </li>
                  ))}
                {diff.every((d) => d.kind === 'unchanged') && (
                  <li className="text-ink-muted">前の版から本文の変更はありません。</li>
                )}
              </ol>
            </details>
          )}

          {actions && (
            <div className="mt-2 grid gap-2 min-[900px]:grid-cols-2">
              {(actions.canComplete || actions.canApprove) && (
                <form
                  action={actions.canApprove ? finalApproveAction : completeReviewAction}
                  className="rounded-t4d border border-line p-2"
                >
                  {hidden}
                  <p className="mb-1 text-[12px] text-ink">
                    {actions.canApprove
                      ? '引用した数値・定性情報がまだ有効かを、承認の直前にサーバーで確かめ直します。'
                      : '未解決の要対応コメントがあるとレビューを完了できません。'}
                  </p>
                  {/* 送信中は押せなくし、処理中と分かる表示にする（二度押しで同じ判断を送らない） */}
                  <SubmitButton size="sm" pendingLabel={actions.canApprove ? '承認中…' : '完了中…'}>
                    {actions.canApprove ? '最終承認する（社内承認）' : 'レビューを完了する'}
                  </SubmitButton>
                </form>
              )}
              {actions.canReturn && (
                <form
                  action={returnReviewAction}
                  className="space-y-1 rounded-t4d border border-line p-2"
                >
                  {hidden}
                  <label className="block text-[12px] text-ink">
                    差戻しの対象の段落（必須）
                    <select
                      name="paragraphId"
                      required
                      defaultValue=""
                      className="mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      <option value="" disabled>
                        段落を選択
                      </option>
                      {paragraphs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="return-reason" className="block text-[12px] text-ink">
                    差戻しの理由（必須）
                  </label>
                  <Textarea id="return-reason" name="reason" rows={2} required />
                  <SubmitButton size="sm" variant="outline" pendingLabel="差戻し中…">
                    差し戻す
                  </SubmitButton>
                </form>
              )}
              {actions.canWithdraw && (
                <form
                  action={withdrawReviewAction}
                  className="space-y-1 rounded-t4d border border-line p-2"
                >
                  {hidden}
                  <label htmlFor="withdraw-reason" className="block text-[12px] text-ink">
                    依頼を取り下げて編集に戻る（理由は任意）
                  </label>
                  <Textarea id="withdraw-reason" name="reason" rows={1} />
                  <SubmitButton size="sm" variant="ghost" pendingLabel="取下げ中…">
                    依頼を取り下げる
                  </SubmitButton>
                </form>
              )}
              {actions.reasons.length > 0 && !actions.canComplete && !actions.canApprove && (
                <p className="text-[12px] text-ink-muted">{actions.reasons.join(' ')}</p>
              )}
            </div>
          )}
        </>
      ) : (
        <h2 id="review-panel-title" className="sr-only">
          レビューの履歴
        </h2>
      )}

      {past.length > 0 && (
        <details className="mt-2 text-[12px]">
          <summary className="flex cursor-pointer items-center gap-1 text-ink-muted">
            <History className="size-3.5" aria-hidden="true" />
            これまでのレビュー（{past.length} 件）
          </summary>
          <ol className="mt-1 space-y-1.5">
            {past.map((r) => (
              <li key={r.id} className="rounded-t4d border border-line p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-ink">版 {r.targetVersionNo ?? '—'}</span>
                  <ReviewRequestStatusBadge status={r.status} />
                  <span className="text-ink-muted">
                    依頼 {r.requestedByName} ／ レビュー {r.reviewerName} ／ 最終承認{' '}
                    {r.approverName}
                  </span>
                </div>
                <ol className="mt-1 space-y-0.5 text-ink-muted">
                  {r.events.map((e) => (
                    <li key={e.id}>
                      {formatJst(e.createdAt)} {e.label}（{e.stageLabel}） {e.actorName}
                      {e.reason ? ` ／ 理由: ${e.reason}` : ''}
                      {e.paragraphId ? ` ／ 段落 ${e.paragraphId}` : ''}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
