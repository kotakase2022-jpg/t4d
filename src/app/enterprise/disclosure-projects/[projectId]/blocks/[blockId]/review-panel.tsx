import { BadgeCheck, CheckCheck, ClipboardCheck, History, Info } from 'lucide-react';
import { PageActions } from '@/components/shared/page-actions';
import { Collapsible } from '@/components/ui/collapsible';
import type { ParagraphDiff } from '@/lib/domain/disclosure-block';
import { reviewPolicyLabel } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import type { ActionSpec } from '@/lib/ui/actions';
import type { EditorReviewRequest } from '@/lib/services/disclosure-block';
import type { ReviewActionState } from '@/lib/services/disclosure-review';
import { completeReviewAction, finalApproveAction } from '../actions';
import { ReviewRequestStatusBadge } from '../status-badges';
import { DiffText } from './diff-text';
import { ReturnReviewDialog, WithdrawReviewDialog } from './review-decision-forms';

/**
 * レビュー・最終承認の操作（依頼中・承認待ちの節）。plan §1.15 の原稿の行:
 *  - レビュー中＋指名レビュアー: primary「レビューを完了する」・secondary「差し戻す…」
 *  - 最終承認待ち＋承認者: primary「最終承認する（社内承認）」（取り消せない。確認ダイアログ）・secondary「差し戻す…」
 *  - 依頼した本人: secondary「依頼を取り下げる…」
 * 差戻し・取下げは理由を入れる小さなダイアログ（差戻しの理由は必須）。
 *
 * 審査するのは依頼で固定した版。前回の版からの差分・引用・未解決の指摘は同じ画面の本文と根拠パネルで確認する。
 * 企業内の承認であり、第三者保証ではない。
 *
 * 置き場所は本文の上（全幅）のまま: 根拠パネルは閉じられ、1366px 未満ではドロワーになるため、
 * 主操作をそこへ入れると見えなくなる（plan S7 の「右ペインの先頭」からの意図した差分）。
 */
export function ReviewPanel({
  projectId,
  blockId,
  request,
  actions,
  paragraphs,
  paragraphNames,
  diff,
  history,
}: {
  projectId: string;
  blockId: string;
  request: EditorReviewRequest | null;
  actions: ReviewActionState | null;
  /** 依頼で固定した版の段落（差戻しの対象を選ぶ） */
  paragraphs: Array<{ id: string; label: string }>;
  /** 段落 ID → 表示名（本文の中の位置。内部の段落 ID は出さない） */
  paragraphNames: Record<string, string>;
  /** 前の版からの差分（依頼で固定した版） */
  diff: ParagraphDiff[] | null;
  history: EditorReviewRequest[];
}) {
  const past = history.filter((r) => r.id !== request?.id);
  const versionLabel = `版 ${request?.targetVersionNo ?? '—'}`;
  const fields = request ? { projectId, blockId, requestId: request.id } : null;

  let primary: ActionSpec | undefined;
  if (actions && fields) {
    if (actions.canApprove) {
      primary = {
        kind: 'confirm',
        id: 'final-approve',
        label: '最終承認する（社内承認）',
        icon: <BadgeCheck aria-hidden="true" />,
        action: finalApproveAction,
        fields,
        confirm: {
          tier: 'irreversible',
          title: 'この版を最終承認しますか',
          scope: `${versionLabel} を社内承認済みとして固定します。承認した版は以後も変わりません。`,
          consequences: [
            '承認の直前に、引用した数値・定性情報がまだ有効かをサーバーで確かめ直します。',
            '社内の承認です。第三者による保証ではありません。',
          ],
          confirmLabel: '最終承認する',
          destructive: false,
        },
      };
    } else if (actions.canComplete) {
      primary = {
        kind: 'submit',
        id: 'complete-review',
        label: 'レビューを完了する',
        icon: <CheckCheck aria-hidden="true" />,
        action: completeReviewAction,
        fields,
        pendingLabel: '完了中…',
      };
    }
  }

  return (
    <section
      aria-labelledby="review-panel-title"
      className="border-b border-line bg-surface px-4 py-2"
    >
      {request ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck className="size-4 text-brand-700" aria-hidden="true" />
            <h2 id="review-panel-title" className="text-body font-semibold text-ink">
              レビュー・承認（版 {request.targetVersionNo ?? '—'} を審査中）
            </h2>
            <ReviewRequestStatusBadge status={request.status} />
            <span className="text-small text-ink-muted">
              依頼 {request.requestedByName} ／ レビュー {request.reviewerName} ／ 最終承認{' '}
              {request.approverName} ／ 規則 {reviewPolicyLabel(request.policyVersion)}
            </span>
            {actions && fields && (
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {actions.canWithdraw && (
                  <WithdrawReviewDialog versionLabel={versionLabel} {...fields} />
                )}
                {actions.canReturn && (
                  <ReturnReviewDialog
                    versionLabel={versionLabel}
                    paragraphs={paragraphs}
                    {...fields}
                  />
                )}
                <PageActions primary={primary} />
              </div>
            )}
          </div>
          <p className="mt-1 flex items-start gap-1 text-caption text-ink-muted">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            社内のレビュー・承認です（第三者保証ではありません）。依頼者・版の作成者・同じ依頼のレビュー完了者は最終承認できません。
            {actions?.canApprove &&
              ' 引用した数値・定性情報がまだ有効かを、承認の直前にサーバーで確かめ直します。'}
            {actions?.canComplete &&
              !actions.canApprove &&
              ' 未解決の要対応コメントがあるとレビューを完了できません。'}
          </p>
          {actions && actions.reasons.length > 0 && !actions.canComplete && !actions.canApprove && (
            <p className="mt-1 text-small text-ink-muted">{actions.reasons.join(' ')}</p>
          )}

          {diff && (
            <Collapsible variant="plain" summary="前の版からの差分を表示" className="mt-1">
              <ol className="space-y-1">
                {diff
                  .filter((d) => d.kind !== 'unchanged')
                  .map((d) => (
                    <li
                      key={`${d.kind}-${d.paragraphId}`}
                      className="rounded-t4d border border-line p-1.5"
                    >
                      <span className="mr-1 text-caption text-ink-muted">
                        {d.kind === 'removed'
                          ? '前の版の段落'
                          : (paragraphNames[d.paragraphId] ?? '（この版に無い段落）')}
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
            </Collapsible>
          )}
        </>
      ) : (
        <h2 id="review-panel-title" className="sr-only">
          レビューの履歴
        </h2>
      )}

      {past.length > 0 && (
        <Collapsible
          variant="plain"
          summary={
            <span className="inline-flex items-center gap-1">
              <History className="size-3.5" aria-hidden="true" />
              これまでのレビュー（{past.length} 件）
            </span>
          }
          className="mt-1"
        >
          <ol className="space-y-1.5 text-small">
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
                      {e.paragraphId
                        ? ` ／ ${paragraphNames[e.paragraphId] ?? '（現在の本文に無い段落）'}`
                        : ''}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </Collapsible>
      )}
    </section>
  );
}
