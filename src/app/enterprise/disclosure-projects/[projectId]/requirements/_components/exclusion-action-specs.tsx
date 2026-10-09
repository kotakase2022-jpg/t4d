import { BadgeCheck, Send, Undo2 } from 'lucide-react';
import type { ExclusionState } from '@/lib/domain/requirement-coverage';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import type { ExclusionDecision } from '@/types/domain';
import {
  approveExclusionAction,
  requestExclusionAction,
  returnExclusionAction,
  withdrawExclusionAction,
} from '../actions';

/**
 * 対象外・非重要の申請と承認の操作（トライアル対応 NF-02）。要求事項の詳細（プロジェクト）・要求事項タブの行・
 * SSBJ 要求事項の詳細が同じ形で使う（同じ意味の操作を画面ごとに別の作りにしない）。
 *
 *  - 対象外を承認（取り消せない）: ConfirmDialog（irreversible）。範囲＝基準・要求事項コード・理由の先頭 60 字
 *  - 差し戻す…: ConfirmDialog（理由必須）
 *  - 対象外として申請: そのまま送る（申請は取り下げられる）
 *  - 申請を取り下げる: 申請者・編集者だけ
 * どれもサーバーが権限・職務分離・理由のダイジェストを確かめ直す（画面の出し分けは補助）。
 */

export interface ExclusionActionInput {
  /** 隠し項目（source・itemId・projectFrameworkId または reportingPeriodId・projectId・returnTo） */
  fields: Record<string, string>;
  state: ExclusionState;
  requestedBy: string | null;
  decision: ExclusionDecision;
  reason: string;
  /** 基準の名前と要求事項のコード（確認ダイアログの範囲） */
  frameworkLabel: string;
  code: string;
  viewerId: string;
  canWrite: boolean;
  canApprove: boolean;
  /** 差戻しの理由の上限 */
  noteLimit: number;
  /** 操作の目印（data-action-id）の末尾。一覧の行では要求事項ごとに変える */
  idSuffix?: string;
}

export interface ExclusionActions {
  approve?: ActionSpec;
  returnBack?: ActionSpec;
  request?: ActionSpec;
  withdraw?: MenuActionSpec;
}

/** 理由の先頭 60 字（確認ダイアログの範囲・一覧の表示） */
export function reasonHead(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export function exclusionScope(
  input: Pick<ExclusionActionInput, 'frameworkLabel' | 'code' | 'decision' | 'reason'>,
): string {
  const label = input.decision === 'not_applicable' ? '対象外' : '非重要';
  return `${input.frameworkLabel} ${input.code}／${label}の理由: ${reasonHead(input.reason)}`;
}

export function exclusionActions(input: ExclusionActionInput): ExclusionActions {
  const scope = exclusionScope(input);
  const out: ExclusionActions = {};
  const suffix = input.idSuffix ? `-${input.idSuffix}` : '';
  if (input.state === 'requested' && input.canApprove) {
    const selfRequest = input.requestedBy === input.viewerId;
    out.approve = {
      kind: 'confirm',
      id: `approve-exclusion${suffix}`,
      label: '対象外を承認',
      icon: <BadgeCheck aria-hidden="true" />,
      action: approveExclusionAction,
      fields: input.fields,
      disabledReason: selfRequest ? '申請した人は承認・差戻しできません（職務分離）。' : undefined,
      confirm: {
        tier: 'irreversible',
        title: 'この対象外・非重要の判断を承認しますか',
        scope,
        consequences: [
          '承認は追記で残り、取り消せません。理由を変えると承認し直しになります。',
          '承認すると、この要求事項は分母から外れ「対象外」になります。',
        ],
        confirmLabel: '承認する',
        destructive: false,
      },
    };
    if (!selfRequest) {
      out.returnBack = {
        kind: 'confirm',
        id: `return-exclusion${suffix}`,
        label: '差し戻す…',
        icon: <Undo2 aria-hidden="true" />,
        action: returnExclusionAction,
        fields: input.fields,
        confirm: {
          tier: 'bulk',
          title: 'この申請を差し戻しますか',
          scope,
          consequences: [
            '申請者に差戻しの理由が見えます。申請し直すまで「未判定」のまま分母に残します。',
          ],
          reason: {
            name: 'note',
            label: '差し戻す理由',
            required: true,
            maxLength: input.noteLimit,
          },
          confirmLabel: '差し戻す',
        },
      };
    }
  }
  if (
    input.canWrite &&
    (input.state === 'not_requested' ||
      input.state === 'returned' ||
      input.state === 'reapproval_required')
  ) {
    out.request = {
      kind: 'submit',
      id: `request-exclusion${suffix}`,
      label: '対象外として申請',
      icon: <Send aria-hidden="true" />,
      action: requestExclusionAction,
      fields: input.fields,
      pendingLabel: '申請しています…',
    };
  }
  if (input.state === 'requested' && (input.canWrite || input.requestedBy === input.viewerId)) {
    out.withdraw = {
      kind: 'submit',
      id: `withdraw-exclusion${suffix}`,
      label: '対象外の申請を取り下げる',
      action: withdrawExclusionAction,
      fields: input.fields,
    };
  }
  return out;
}
