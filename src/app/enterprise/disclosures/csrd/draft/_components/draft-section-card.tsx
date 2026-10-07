import Link from 'next/link';
import { Bot, Check, CircleAlert, Save, Sparkles, TriangleAlert } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { Collapsible } from '@/components/ui/collapsible';
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

/** AI の出所の表示（Mock は「デモ生成」、OpenAI などは「AI 生成」） */
const providerLabel = (provider: 'mock' | 'openai') =>
  provider === 'mock' ? 'デモ生成' : 'AI 生成';

/**
 * CSRD 開示ドラフトの 1 節（docs/disclosure-first.md §9.4）。
 *
 * AI 草案（ai_body）と人の本文（body）を別の枠に分けて見せる。AI 草案は「本文に採用」を
 * 人が押すまで本文に入らず、確定も人が別に行う（CLAUDE.md §0.4）。
 * 押せない操作は隠すだけにせず、理由を文で示す（対象外・未判定・DMA 未確定・本文が空）。
 * 採用・保存・確定は表示したときの版（updatedAt）を送り、別の操作で変わっていればサーバーが断る。
 * AI 草案の出所の表示は、草案を作った実行の提供元（draftProvider）で決める（いまの設定ではなく）。
 *
 * 節ごとの操作はすべて secondary（主操作を節ごとに繰り返さない。plan E30・§1.6）。装飾の枠は使わず、
 * 見出しと罫線で区切る（Section）。本文がある節で AI 草案を採用すると本文が置き換わるため、
 * 置き換わる内容を示す確認を挟む（plan §1.16 区分 2。本文が空なら置き換わるものが無いので確認しない）。
 */
export function CsrdDraftSectionCard({
  view,
  reportingPeriodId,
  canWrite,
  canRunAi,
  aiMode,
  draftProvider,
}: {
  view: CsrdDraftSectionView;
  reportingPeriodId: Uuid;
  canWrite: boolean;
  canRunAi: boolean;
  /** いまの AI の提供元（「AI 草案を作成」のボタンの表示に使う） */
  aiMode: 'mock' | 'openai';
  /** この節の AI 草案を作った実行の提供元（実行の記録が無い Fixture の草案は mock） */
  draftProvider: 'mock' | 'openai';
}) {
  const { draft, section, label } = view;
  const draftLabel = providerLabel(draftProvider);
  const buttonLabel = providerLabel(aiMode);
  const hasAiBody = draft !== null && draft.aiBody.trim() !== '';
  const hasBody = draft !== null && draft.body.trim() !== '';
  const adopted = hasAiBody && draft.body === draft.aiBody;
  const itemIdByCode = new Map(view.items.map((item) => [item.code, item.itemId]));
  const reviewedCount = view.items.filter((item) => item.reviewed).length;

  return (
    <Section
      id={`csrd-draft-${section}`}
      title={label}
      actions={
        <span className="flex flex-wrap items-center gap-1.5">
          <ApplicabilityBadge applicability={view.applicability} />
          <DraftStateBadge state={draftStateOf(draft)} />
        </span>
      }
      bodyClassName="space-y-2.5"
    >
      <p className="text-small text-ink">{view.applicability.reason}</p>

      {/* 要求事項ごとの状況は根拠の詳細なので既定で閉じ、件数だけを summary に出す（§10.4） */}
      <Collapsible
        summary={`この節の要求事項（${view.items.length} 件・担当者確認済み ${reviewedCount} 件）`}
        bodyClassName="p-0"
      >
        <ul className="divide-y divide-line">
          {view.items.map((item) => (
            <li key={item.code} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <Link
                href={requirementHref(item.itemId)}
                className="font-mono text-caption text-brand-700 underline"
              >
                {item.code}
              </Link>
              <span className="min-w-0 flex-1 text-caption text-ink-muted">{item.title}</span>
              <FinalStatusBadge status={item.finalStatus} />
              <ReviewedBadge reviewed={item.reviewed} />
            </li>
          ))}
        </ul>
      </Collapsible>

      {!view.inScope && (
        <p className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-2 text-small text-ink">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          {view.generateBlockedReason ?? 'この節は評価対象ではありません。'}
        </p>
      )}

      {view.staleConfirmation && (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-small text-ink"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          確定した後に事項の重要性の判断が変わり、この節は評価対象ではなくなりました。確定済みの節には数えていません。本文の観点が今の判断と合っているか確認してください。
        </p>
      )}

      {hasAiBody && draft && (
        <div className="space-y-1.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2">
          <p className="flex flex-wrap items-center gap-2 text-small font-medium text-ink">
            <Bot className="size-3.5" aria-hidden="true" />
            AI 草案（候補・{draftLabel}）
            <span className="text-caption font-normal text-ink-muted">
              {draft.aiGeneratedAt && `作成: ${formatJst(draft.aiGeneratedAt)}`}
              {draft.aiConfidence !== null && ` ／ 確信度 ${Math.round(draft.aiConfidence * 100)}%`}
            </span>
          </p>
          <p className="whitespace-pre-wrap text-small leading-relaxed text-ink">{draft.aiBody}</p>
          {draft.aiWarnings.length > 0 && (
            <ul className="space-y-0.5">
              {draft.aiWarnings.map((warning, i) => (
                <li key={i} className="flex items-start gap-1 text-caption text-warning-ink">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  {warning}
                </li>
              ))}
            </ul>
          )}
          {draft.coveredItemCodes.length > 0 && (
            <p className="text-caption text-ink-muted">
              根拠にした要求事項: {draft.coveredItemCodes.join('、')}
            </p>
          )}
          {draft.gaps.length > 0 && (
            <div>
              <p className="text-caption font-medium text-ink">
                書けなかった箇所（{draft.gaps.length}）
              </p>
              <ul className="space-y-0.5">
                {draft.gaps.map((gap) => {
                  const itemId = itemIdByCode.get(gap.itemCode);
                  return (
                    <li key={gap.itemCode} className="text-caption text-ink-muted">
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
              <p className="flex items-center gap-1 text-caption text-ink-muted">
                <Check className="size-3" aria-hidden="true" />
                この草案は本文に採用済みです
              </p>
            ) : hasBody ? (
              // いまの本文を置き換えるため、置き換わる内容を示して確かめる（区分 2）
              <div className="flex flex-wrap items-center gap-2">
                <ConfirmDialog
                  tier="bulk"
                  title="AI 草案を本文に採用しますか"
                  scope={`${label}: いまの本文（${formatNumber(draft.body.length)} 字）を AI 草案（${formatNumber(draft.aiBody.length)} 字）で置き換えます`}
                  consequences={[
                    'いまの本文は AI 草案で置き換わります（置き換えた後の本文は編集できます）。',
                    '確定していた場合は、確定が外れます。',
                    '採用しても確定はされません。内容を確認・編集してから確定してください。',
                  ]}
                  confirmLabel="置き換えて採用する"
                  action={adoptCsrdDraftAction}
                  fields={{ draftId: draft.id, section, baseUpdatedAt: draft.updatedAt }}
                  trigger={{
                    label: '本文に採用',
                    variant: 'secondary',
                    size: 'sm',
                    icon: <Check aria-hidden="true" />,
                    actionId: `adopt-${section}`,
                  }}
                />
                <span className="text-caption text-ink-muted">
                  採用すると、いまの本文を AI 草案で置き換えます（確定していた場合は外れます）。
                </span>
              </div>
            ) : (
              <form action={adoptCsrdDraftAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="draftId" value={draft.id} />
                <input type="hidden" name="section" value={section} />
                <input type="hidden" name="baseUpdatedAt" value={draft.updatedAt} />
                <SubmitButton
                  size="sm"
                  variant="secondary"
                  icon={<Check aria-hidden="true" />}
                  pendingLabel="採用しています…"
                >
                  本文に採用
                </SubmitButton>
                <span className="text-caption text-ink-muted">
                  採用しても確定はされません。内容を確認・編集してから確定してください。
                </span>
              </form>
            ))}
        </div>
      )}

      {(draft || view.canWriteBody) && (
        <div className="space-y-1.5">
          <p className="text-small font-medium text-ink">
            本文（担当者が採用・編集したもの）
            {view.edited && (
              <span className="ml-2 text-caption font-normal text-ink-muted">
                AI 草案から担当者が修正
              </span>
            )}
          </p>
          {view.canWriteBody ? (
            <PreservingForm
              key={draft?.updatedAt ?? 'new'}
              action={saveCsrdDraftBodyAction}
              className="space-y-1.5"
            >
              <input type="hidden" name="draftId" value={draft?.id ?? ''} />
              <input type="hidden" name="section" value={section} />
              <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
              <input type="hidden" name="baseUpdatedAt" value={draft?.updatedAt ?? ''} />
              <Textarea
                name="body"
                defaultValue={draft?.body ?? ''}
                rows={8}
                maxLength={CSRD_DRAFT_BODY_MAX}
                required={draft === null}
                aria-label={`${label}の本文`}
                placeholder={
                  draft
                    ? 'AI 草案を本文に採用するか、ここに直接書いて保存してください。'
                    : 'ここに本文を直接書いて保存できます（AI 草案は使わなくても構いません）。'
                }
                className="text-small leading-relaxed"
              />
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton
                  size="sm"
                  variant="secondary"
                  icon={<Save aria-hidden="true" />}
                  pendingLabel="保存中…"
                >
                  本文を保存
                </SubmitButton>
                <span className="text-caption text-ink-muted">
                  {formatNumber(CSRD_DRAFT_BODY_MAX)}{' '}
                  字以内。保存すると、確定していた場合は確定が外れます。
                </span>
              </div>
            </PreservingForm>
          ) : hasBody && draft ? (
            <p className="whitespace-pre-wrap rounded-t4d border border-line px-3 py-2 text-small leading-relaxed text-ink">
              {draft.body}
            </p>
          ) : (
            <p className="text-small text-ink-muted">本文はまだありません。</p>
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
              variant="secondary"
              icon={<Sparkles aria-hidden="true" />}
              pendingLabel="作成中…"
            >
              {hasAiBody
                ? `AI 草案を作り直す（${buttonLabel}）`
                : `AI 草案を作成（${buttonLabel}）`}
            </SubmitButton>
          </form>
        ) : view.inScope && view.generateBlockedReason ? (
          <span className="text-caption text-ink-muted">{view.generateBlockedReason}</span>
        ) : view.inScope && canWrite && !canRunAi ? (
          <span className="text-caption text-ink-muted">
            AI の実行権限が無いため、AI 草案は作れません。本文は上の欄に直接書いて保存できます（AI
            草案が要る場合は、AI の実行権限を持つ担当者に依頼してください）。
          </span>
        ) : null}

        {draft?.confirmedAt ? (
          <span className="flex items-center gap-1 text-caption text-ink">
            <Check className="size-3 text-success" aria-hidden="true" />
            確定: {formatJst(draft.confirmedAt)}（{view.confirmedByName ?? '確定者不明'}）
          </span>
        ) : canWrite && draft ? (
          view.confirmable ? (
            <form action={confirmCsrdDraftAction}>
              <input type="hidden" name="draftId" value={draft.id} />
              <input type="hidden" name="section" value={section} />
              <input type="hidden" name="baseUpdatedAt" value={draft.updatedAt} />
              <SubmitButton
                variant="secondary"
                size="sm"
                icon={<Check aria-hidden="true" />}
                pendingLabel="確定中…"
              >
                保存済みの本文で確定
              </SubmitButton>
            </form>
          ) : (
            <span className="flex items-center gap-1 text-caption text-ink-muted">
              <CircleAlert className="size-3" aria-hidden="true" />
              確定できません: {view.confirmBlockedReason}
            </span>
          )
        ) : null}

        {hasAiBody && canRunAi && view.generatable && (
          <span className="text-caption text-ink-muted">
            作り直しても本文は変わりません（AI 草案だけを置き換えます）。
          </span>
        )}
      </div>
    </Section>
  );
}
