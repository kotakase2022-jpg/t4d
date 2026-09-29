'use client';

import * as React from 'react';
import { AlertTriangle, Ban, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import type { RecheckDecisionKind, RecheckRefKind } from '@/types/domain';
import { decideRecheckFormAction, type RecheckFormState } from '../../actions';

export interface RecheckFormsProps {
  projectId: string;
  blockId: string;
  refKind: RecheckRefKind;
  oldRefId: string;
  /** 判断ごとに選べるか・選べない理由（サーバーが decideRecheck と同じ条件で決める） */
  decisions: Record<RecheckDecisionKind, { allowed: boolean; reason: string | null }>;
}

const INITIAL: RecheckFormState = { status: 'idle', decision: null, message: null, reason: '' };

const SPECS: Array<{
  decision: RecheckDecisionKind;
  label: string;
  reasonLabel: string;
  required: boolean;
  description: string | null;
  variant: 'primary' | 'outline' | 'ghost';
  idPrefix: string;
}> = [
  {
    decision: 'adopt_new',
    label: '新しい版を採用',
    reasonLabel: '変更理由（任意）',
    required: false,
    description:
      '新しい版で本文を書き換えた次の版を作ります（節は下書きに戻り、再レビューが必要です）。',
    variant: 'primary',
    idPrefix: 'adopt',
  },
  {
    decision: 'keep_old',
    label: '引用中の版を維持',
    reasonLabel: '引用中の版を維持する理由（必須）',
    required: true,
    description: null,
    variant: 'outline',
    idPrefix: 'keep',
  },
  {
    decision: 'return_to_owner',
    label: '担当者へ差戻し',
    reasonLabel: '担当者へ差し戻す理由（必須）',
    required: true,
    description: null,
    variant: 'ghost',
    idPrefix: 'return',
  },
];

/**
 * 再確認の判断（新しい版を採用・引用中の版を維持・担当者へ差戻し）。
 * 選べない判断は押せる形で出さず、理由を横に示す（押してから断られ、書いた理由が消えることを防ぐ）。
 * サーバーで断られたときも、入力した理由はそのまま残す。
 */
export function RecheckForms({
  projectId,
  blockId,
  refKind,
  oldRefId,
  decisions,
}: RecheckFormsProps) {
  return (
    <div className="mt-3 grid gap-2 min-[1100px]:grid-cols-3">
      {SPECS.map((spec) => (
        <DecisionForm
          key={spec.decision}
          spec={spec}
          projectId={projectId}
          blockId={blockId}
          refKind={refKind}
          oldRefId={oldRefId}
          availability={decisions[spec.decision]}
        />
      ))}
    </div>
  );
}

function DecisionForm({
  spec,
  projectId,
  blockId,
  refKind,
  oldRefId,
  availability,
}: {
  spec: (typeof SPECS)[number];
  projectId: string;
  blockId: string;
  refKind: RecheckRefKind;
  oldRefId: string;
  availability: { allowed: boolean; reason: string | null };
}) {
  const [state, formAction, pending] = React.useActionState(decideRecheckFormAction, INITIAL);
  // 入力は画面側で持つ（送信後にフォームが作り直されても、書いた理由を消さない）
  const [reason, setReason] = React.useState('');
  const inputId = `${spec.idPrefix}-${oldRefId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const failed = state.status === 'error' && state.decision === spec.decision;

  return (
    <form action={formAction} className="space-y-1 rounded-t4d border border-line p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="blockId" value={blockId} />
      <input type="hidden" name="refKind" value={refKind} />
      <input type="hidden" name="oldRefId" value={oldRefId} />
      <input type="hidden" name="decision" value={spec.decision} />
      {spec.description && <p className="text-[12px] text-ink">{spec.description}</p>}
      <label htmlFor={inputId} className={spec.required ? 'block text-[12px] text-ink' : 'sr-only'}>
        {spec.reasonLabel}
      </label>
      <Textarea
        id={inputId}
        name="reason"
        rows={spec.required ? 2 : 1}
        placeholder={spec.required ? undefined : spec.reasonLabel}
        required={spec.required && availability.allowed}
        disabled={!availability.allowed || pending}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-invalid={failed || undefined}
        aria-describedby={
          [failed ? errorId : null, !availability.allowed ? hintId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
      {spec.decision === 'keep_old' && availability.allowed && (
        <p className="text-[11px] text-ink-muted">
          承認された版に限り選べます。失効した資料・削除された数値には使えません。
        </p>
      )}
      {!availability.allowed && availability.reason && (
        <p id={hintId} className="flex items-start gap-1 text-[11px] text-ink-muted">
          <Ban className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          選べません: {availability.reason}
        </p>
      )}
      {failed && state.message && (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-[12px] text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {state.message}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        variant={spec.variant}
        disabled={!availability.allowed || pending}
      >
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        {spec.label}
      </Button>
    </form>
  );
}
