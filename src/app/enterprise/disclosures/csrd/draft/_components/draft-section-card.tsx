import Link from 'next/link';
import { Bot, Check, CircleAlert, Save, Sparkles, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { CSRD_DRAFT_BODY_MAX } from '@/lib/domain/csrd';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import type { CsrdDraftSectionView } from '@/lib/services/csrd/draft';
import type { Uuid } from '@/types/domain';
import { ApplicabilityBadge } from '../../_components/csrd-badges';
import {
  adoptCsrdDraftAction,
  confirmCsrdDraftAction,
  generateCsrdDraftAction,
  saveCsrdDraftBodyAction,
} from '../actions';
import { DraftStateBadge, FinalStatusBadge, ReviewedBadge, draftStateOf } from './draft-badges';

const requirementHref = (itemId: Uuid) => `/enterprise/disclosures/csrd/requirements/${itemId}`;

/**
 * CSRD 開示ドラフトの 1 節（docs/disclosure-first.md §9.4）。
 *
 * AI 草案（ai_body）と人の本文（body）を別の枠に分けて見せる。AI 草案は「本文に採用」を
 * 人が押すまで本文に入らず、確定も人が別に行う（CLAUDE.md §0.4）。
 * 押せない操作は隠すだけにせず、理由を文で示す（対象外・未判定・DMA 未確定・本文が空）。
 */
export function CsrdDraftSectionCard({
  view,
  reportingPeriodId,
  canWrite,
  canRunAi,
  aiMode,
}: {
  view: CsrdDraftSectionView;
  reportingPeriodId: Uuid;
  canWrite: boolean;
  canRunAi: boolean;
  aiMode: 'mock' | 'openai';
}) {
  const { draft, section, label } = view;
  const titleId = `csrd-draft-${section}-title`;
  const aiLabel = aiMode === 'mock' ? 'デモ生成' : 'AI 生成';
  const hasAiBody = draft !== null && draft.aiBody.trim() !== '';
  const hasBody = draft !== null && draft.body.trim() !== '';
  const adopted = hasAiBody && draft.body === draft.aiBody;
  const itemIdByCode = new Map(view.items.map((item) => [item.code, item.itemId]));

  return (
    <section id={`csrd-draft-${section}`} aria-labelledby={titleId}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 id={titleId} className="text-[13px] font-semibold text-ink">
            {label}
          </h2>
          <span className="flex flex-wrap items-center gap-1.5">
            <ApplicabilityBadge applicability={view.applicability} />
            <DraftStateBadge state={draftStateOf(draft)} />
          </span>
        </div>

        <div className="space-y-2.5 p-3">
          <p className="text-[12px] text-ink">{view.applicability.reason}</p>

          <div className="rounded-t4d border border-line">
            <p className="border-b border-line px-3 py-1.5 text-[12px] font-medium text-ink">
              この節の要求事項（{view.items.length}）
            </p>
            <ul className="divide-y divide-line">
              {view.items.map((item) => (
                <li key={item.code} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <Link
                    href={requirementHref(item.itemId)}
                    className="font-mono text-[11px] text-brand-700 underline"
                  >
                    {item.code}
                  </Link>
                  <span className="min-w-0 flex-1 text-[11px] text-ink-muted">{item.title}</span>
                  <FinalStatusBadge status={item.finalStatus} />
                  <ReviewedBadge reviewed={item.reviewed} />
                </li>
              ))}
            </ul>
          </div>

          {!view.inScope && (
            <p className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-2 text-[12px] text-ink">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
              {view.generateBlockedReason ?? 'この節は評価対象ではありません。'}
            </p>
          )}

          {hasAiBody && draft && (
            <div className="space-y-1.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2">
              <p className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-ink">
                <Bot className="size-3.5" aria-hidden="true" />
                AI 草案（候補・{aiLabel}）
                <span className="text-[11px] font-normal text-ink-muted">
                  {draft.aiGeneratedAt && `作成: ${formatJst(draft.aiGeneratedAt)}`}
                  {draft.aiConfidence !== null &&
                    ` ／ 確信度 ${Math.round(draft.aiConfidence * 100)}%`}
                </span>
              </p>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink">
                {draft.aiBody}
              </p>
              {draft.aiWarnings.length > 0 && (
                <ul className="space-y-0.5">
                  {draft.aiWarnings.map((warning, i) => (
                    <li key={i} className="flex items-start gap-1 text-[11px] text-[#8a5d00]">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
              {draft.coveredItemCodes.length > 0 && (
                <p className="text-[11px] text-ink-muted">
                  根拠にした要求事項: {draft.coveredItemCodes.join('、')}
                </p>
              )}
              {draft.gaps.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-ink">
                    書けなかった箇所（{draft.gaps.length}）
                  </p>
                  <ul className="space-y-0.5">
                    {draft.gaps.map((gap) => {
                      const itemId = itemIdByCode.get(gap.itemCode);
                      return (
                        <li key={gap.itemCode} className="text-[11px] text-ink-muted">
                          {itemId ? (
                            <Link
                              href={requirementHref(itemId)}
                              className="font-mono text-brand-700 underline"
                            >
                              {gap.itemCode}
                            </Link>
                          ) : (
                            // 草案の作成後にマスターから消えたコード。リンク先が無いので文字だけ示す
                            <span className="font-mono text-ink">{gap.itemCode}</span>
                          )}{' '}
                          {gap.reason}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {canWrite &&
                (adopted ? (
                  <p className="flex items-center gap-1 text-[11px] text-ink-muted">
                    <Check className="size-3" aria-hidden="true" />
                    この草案は本文に採用済みです
                  </p>
                ) : (
                  <form action={adoptCsrdDraftAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="draftId" value={draft.id} />
                    <input type="hidden" name="section" value={section} />
                    <SubmitButton
                      size="sm"
                      variant="secondary"
                      icon={<Check aria-hidden="true" />}
                      pendingLabel="採用しています…"
                    >
                      本文に採用
                    </SubmitButton>
                    <span className="text-[11px] text-ink-muted">
                      {hasBody
                        ? '採用すると、いまの本文を AI 草案で置き換えます（確定していた場合は外れます）。'
                        : '採用しても確定はされません。内容を確認・編集してから確定してください。'}
                    </span>
                  </form>
                ))}
            </div>
          )}

          {draft && (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-ink">
                本文（担当者が採用・編集したもの）
                {view.edited && (
                  <span className="ml-2 text-[11px] font-normal text-ink-muted">
                    AI 草案から担当者が修正
                  </span>
                )}
              </p>
              {canWrite ? (
                <form
                  key={draft.updatedAt}
                  action={saveCsrdDraftBodyAction}
                  className="space-y-1.5"
                >
                  <input type="hidden" name="draftId" value={draft.id} />
                  <input type="hidden" name="section" value={section} />
                  <Textarea
                    name="body"
                    defaultValue={draft.body}
                    rows={8}
                    maxLength={CSRD_DRAFT_BODY_MAX}
                    aria-label={`${label}の本文`}
                    placeholder="AI 草案を本文に採用するか、ここに直接書いて保存してください。"
                    className="text-[12px] leading-relaxed"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton
                      size="sm"
                      variant="outline"
                      icon={<Save aria-hidden="true" />}
                      pendingLabel="保存中…"
                    >
                      本文を保存
                    </SubmitButton>
                    <span className="text-[11px] text-ink-muted">
                      {formatNumber(CSRD_DRAFT_BODY_MAX)}{' '}
                      字以内。保存すると、確定していた場合は確定が外れます。
                    </span>
                  </div>
                </form>
              ) : hasBody ? (
                <p className="whitespace-pre-wrap rounded-t4d border border-line px-3 py-2 text-[12px] leading-relaxed text-ink">
                  {draft.body}
                </p>
              ) : (
                <p className="text-[12px] text-ink-muted">本文はまだありません。</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            {canRunAi && view.generatable ? (
              <form action={generateCsrdDraftAction}>
                <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
                <input type="hidden" name="section" value={section} />
                <SubmitButton
                  size="sm"
                  variant={hasAiBody ? 'outline' : 'primary'}
                  icon={<Sparkles aria-hidden="true" />}
                  pendingLabel="作成中…"
                >
                  {hasAiBody ? `AI 草案を作り直す（${aiLabel}）` : `AI 草案を作成（${aiLabel}）`}
                </SubmitButton>
              </form>
            ) : view.inScope && view.generateBlockedReason ? (
              <span className="text-[11px] text-ink-muted">{view.generateBlockedReason}</span>
            ) : view.inScope && canWrite && !canRunAi ? (
              <span className="text-[11px] text-ink-muted">
                AI の実行権限が無いため、草案は作れません。
              </span>
            ) : null}

            {draft?.confirmedAt ? (
              <span className="flex items-center gap-1 text-[11px] text-ink">
                <Check className="size-3 text-success" aria-hidden="true" />
                確定: {formatJst(draft.confirmedAt)}（{view.confirmedByName ?? '確定者不明'}）
              </span>
            ) : canWrite && draft ? (
              view.confirmable ? (
                <form action={confirmCsrdDraftAction}>
                  <input type="hidden" name="draftId" value={draft.id} />
                  <input type="hidden" name="section" value={section} />
                  <SubmitButton
                    size="sm"
                    icon={<Check aria-hidden="true" />}
                    pendingLabel="確定中…"
                  >
                    保存済みの本文で確定
                  </SubmitButton>
                </form>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                  <CircleAlert className="size-3" aria-hidden="true" />
                  確定できません: {view.confirmBlockedReason}
                </span>
              )
            ) : null}

            {hasAiBody && canRunAi && view.generatable && (
              <span className="text-[11px] text-ink-muted">
                作り直しても本文は変わりません（AI 草案だけを置き換えます）。
              </span>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
