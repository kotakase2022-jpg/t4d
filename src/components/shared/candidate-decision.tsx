import * as React from 'react';
import { Check, PenLine, Sparkles, X } from 'lucide-react';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { formatJst } from '@/lib/format/datetime';
import type { ServerAction } from '@/lib/ui/actions';
import { HonestyBadge } from './honesty-badge';
import { PreservingForm } from './preserving-form';

/**
 * AI の候補と人の確定（plan §2 S4・S9、§3.1 CandidateDecision）。SSBJ・CSRD の要求事項の詳細で
 * 「確定」系が区画に分散していたもの（候補を採用・修正して確定・担当者の入力として確定）を 1 つにする。
 *
 * - AI は確定しない（CLAUDE.md §0-4）: 候補は候補として常に外に表示し、確定は人がボタンを押す
 * - 状態から primary を 1 つだけ選ぶ:
 *     候補あり・未確定 → primary「候補を採用」、secondary「修正して確定…」（編集欄を開く）
 *     候補なし・未確定 → primary「担当者の入力として確定」、secondary「AI ギャップ分析を実行」（ai.run）
 *     確定済み        → 確定の記録（誰が・いつ）。primary は呼び出し側の次の操作（afterDecision）
 * - 呼び出す Server Action は既存のまま（このコンポーネントは置き場所と主操作だけを決める）
 * - 採用のフォームに入力を添えられる（adoptFields。例: 確認コメント。採用の根拠を履歴に残す）
 * - 修正・手入力のフォームは、入力を残す Server Action（useActionState 型。preservingAction）も受ける。
 *   サーバーが断ったときに選んだ値・書いた理由を失わない（plan §1.13-5。PreservingForm を使う）
 * - 候補を採用しない操作（reject）を渡すと、折りたたみの中に「採用しない理由（任意）」の欄を出す
 *   （トライアル対応 NF-34。name は rejectionReason。Server Action は recordAiFeedback で ai_feedback に追記する）
 */
type PreservingAction = (previous: FormActionState, formData: FormData) => Promise<FormActionState>;

export type FormActionRef =
  | { action: ServerAction; fields?: Record<string, string> }
  | { preservingAction: PreservingAction; fields?: Record<string, string> };

export interface CandidateDecisionProps {
  candidate?: {
    summary: React.ReactNode;
    source: 'openai' | 'mock';
    /** 生成日時（ISO 8601） */
    createdAt: string;
    /** 確信度（0〜1。表示用） */
    confidence?: number;
  };
  decided?: { by: string; at: string; summary: React.ReactNode };
  adopt?: FormActionRef;
  /** 採用のフォームに添える入力（例: 確認コメント（任意））。name は採用の Server Action に合わせる */
  adoptFields?: React.ReactNode;
  editAndConfirm?: FormActionRef;
  /** 候補を採用しない（不採用の理由は任意。name="rejectionReason"） */
  reject?: FormActionRef;
  /** 不採用の理由の上限（Demo Mode は 300 字。省略時 300） */
  rejectReasonMaxLength?: number;
  manualConfirm?: FormActionRef;
  run?: FormActionRef;
  canWrite: boolean;
  canRunAi: boolean;
  /** 確定後の次の操作（例: 対応計画に追加）。確定済みのときだけ出す */
  afterDecision?: React.ReactNode;
  /** 修正・手入力の編集欄（入力の name は既存の Server Action に合わせる） */
  children?: React.ReactNode;
  labels?: Partial<{
    adopt: string;
    editAndConfirm: string;
    reject: string;
    manualConfirm: string;
    run: string;
  }>;
}

function HiddenFields({ fields }: { fields?: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** 通常の Server Action はそのままの form、入力を残す Server Action は PreservingForm で送る */
function DecisionForm({
  target,
  className,
  children,
}: {
  target: FormActionRef;
  className?: string;
  children: React.ReactNode;
}) {
  if ('preservingAction' in target) {
    return (
      <PreservingForm action={target.preservingAction} className={className}>
        <HiddenFields fields={target.fields} />
        {children}
      </PreservingForm>
    );
  }
  return (
    <form action={target.action} className={className}>
      <HiddenFields fields={target.fields} />
      {children}
    </form>
  );
}

export function CandidateDecision({
  candidate,
  decided,
  adopt,
  adoptFields,
  editAndConfirm,
  reject,
  rejectReasonMaxLength = 300,
  manualConfirm,
  run,
  canWrite,
  canRunAi,
  afterDecision,
  children,
  labels,
}: CandidateDecisionProps) {
  const text = {
    adopt: labels?.adopt ?? '候補を採用',
    editAndConfirm: labels?.editAndConfirm ?? '修正して確定',
    reject: labels?.reject ?? '採用しない',
    manualConfirm: labels?.manualConfirm ?? '担当者の入力として確定',
    run: labels?.run ?? 'AI ギャップ分析を実行',
  };

  return (
    <div
      className="space-y-2"
      data-candidate-decision={decided ? 'decided' : candidate ? 'candidate' : 'none'}
    >
      {candidate && (
        // 候補であることは折りたたまずに見せる（誠実さの注記）
        <div className="space-y-1 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-small">
          <div className="flex flex-wrap items-center gap-1.5">
            <HonestyBadge kind="ai-candidate" />
            {candidate.source === 'mock' && <HonestyBadge kind="mock-ai" />}
            <span className="text-caption text-ink-muted">
              {formatJst(candidate.createdAt)}
              {candidate.confidence !== undefined &&
                ` ・ 確信度 ${Math.round(candidate.confidence * 100)}%`}
            </span>
          </div>
          <div className="text-ink">{candidate.summary}</div>
        </div>
      )}

      {decided ? (
        <div className="space-y-1 text-small" data-decided="">
          <p className="flex items-center gap-1 font-medium text-ink">
            <Check className="size-3.5 text-success" aria-hidden="true" />
            確定済み（{decided.by} ・ {formatJst(decided.at)}）
          </p>
          <div className="text-ink">{decided.summary}</div>
          {afterDecision && <div className="flex items-center gap-1.5 pt-1">{afterDecision}</div>}
        </div>
      ) : !canWrite ? null : candidate ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {adopt && (
              <DecisionForm target={adopt} className={adoptFields ? 'w-full space-y-2' : undefined}>
                {adoptFields}
                <SubmitButton variant="primary" size="sm" icon={<Check aria-hidden="true" />}>
                  {text.adopt}
                </SubmitButton>
              </DecisionForm>
            )}
          </div>
          {editAndConfirm && (
            <Collapsible variant="plain" summary={`${text.editAndConfirm}…`}>
              <DecisionForm target={editAndConfirm} className="space-y-2">
                {children}
                <SubmitButton variant="secondary" size="sm" icon={<PenLine aria-hidden="true" />}>
                  {text.editAndConfirm}
                </SubmitButton>
              </DecisionForm>
            </Collapsible>
          )}
          {reject && (
            <Collapsible variant="plain" summary={`${text.reject}…`}>
              <DecisionForm target={reject} className="space-y-2">
                <Field
                  label="採用しない理由"
                  name="rejectionReason"
                  hint="AI の候補の改善の検討に使います。"
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      name="rejectionReason"
                      rows={2}
                      maxLength={rejectReasonMaxLength}
                    />
                  )}
                </Field>
                <SubmitButton variant="secondary" size="sm" icon={<X aria-hidden="true" />}>
                  {text.reject}
                </SubmitButton>
              </DecisionForm>
            </Collapsible>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          {manualConfirm && (
            <DecisionForm target={manualConfirm} className="space-y-2">
              {children}
              <SubmitButton variant="primary" size="sm" icon={<Check aria-hidden="true" />}>
                {text.manualConfirm}
              </SubmitButton>
            </DecisionForm>
          )}
          {run && canRunAi && (
            <DecisionForm target={run}>
              <SubmitButton variant="secondary" size="sm" icon={<Sparkles aria-hidden="true" />}>
                {text.run}
              </SubmitButton>
            </DecisionForm>
          )}
        </div>
      )}
    </div>
  );
}
