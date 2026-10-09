'use client';

import Link from 'next/link';
import { ExternalLink, Link2, MessageSquareQuote, Sparkles } from 'lucide-react';
import { CandidateDecision } from '@/components/shared/candidate-decision';
import { PreservingForm } from '@/components/shared/preserving-form';
import { StatusBadge } from '@/components/shared/status-badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatJst } from '@/lib/format/datetime';
import type { ClientNoteState } from '@/lib/ui/status/clientNote';
import {
  RequirementPicker,
  type RequirementPickerOption,
} from '../../requirements/_components/requirement-picker';
import {
  adoptBlockRequirementCandidatesAction,
  rejectBlockRequirementCandidatesAction,
  suggestBlockRequirementsAction,
  updateBlockRequirementsFormAction,
} from '../actions';

/** 原稿エディタの「要求事項の対応付け」（トライアル対応 NF-05・NF-11）に渡す値（サーバーが作る） */
export interface RequirementMappingPaneData {
  projectId: string;
  blockId: string;
  frameworkVersionId: string;
  /** 開示の編集権限がある（対応付けを変えられる） */
  canEdit: boolean;
  /** AI の候補を出せる（enterprise.ai.run と編集権限） */
  canRunAi: boolean;
  /** 承認済みの版がある節（変更の理由が必須） */
  reasonRequired: boolean;
  reasonMaxLength: number;
  rejectReasonMaxLength: number;
  options: RequirementPickerOption[];
  selectedIds: string[];
  /** まだ採否を決めていない最新の AI の候補（無ければ null） */
  suggestion: {
    runId: string;
    source: 'openai' | 'mock';
    createdAt: string;
    confidence: number;
    candidates: Array<RequirementPickerOption & { rationale: string; confidence: number }>;
    warnings: string[];
  } | null;
}

/** 原稿エディタに出す保証側のコメント（共有された写しのこの節の段落・数値を指すもの。NF-21） */
export interface AssuranceNoteView {
  id: string;
  engagementLabel: string;
  body: string;
  state: ClientNoteState;
  paragraphId: string | null;
  createdAt: string;
  responseCount: number;
}

function ReasonField({
  id,
  required,
  maxLength,
}: {
  id: string;
  required: boolean;
  maxLength: number;
}) {
  return (
    <label className="block space-y-1" htmlFor={id}>
      <span className="flex items-center gap-1.5 text-small font-medium text-ink">
        変更の理由
        <span
          className={
            required
              ? 'rounded-t4d bg-danger-soft px-1 text-caption font-normal text-danger'
              : 'rounded-t4d bg-surface-muted px-1 text-caption font-normal text-ink-muted'
          }
        >
          {required ? '必須' : '任意'}
        </span>
      </span>
      <Textarea id={id} name="reason" rows={2} maxLength={maxLength} required={required} />
      <span className="block text-caption text-ink-muted">
        {required
          ? '承認済みの節です。理由は監査ログに残ります（承認済みの版・スナップショットは変わりません）。'
          : '理由は監査ログに残ります。'}
      </span>
    </label>
  );
}

/**
 * 根拠パネルの「要求事項」タブの下に置く、要求事項の対応付けの編集と AI の候補。
 * 主操作は原稿の「版として保存」のまま（ここは secondary）。AI の候補は CandidateDecision（採用は人が押す）。
 */
export function RequirementMappingPanel({ mapping }: { mapping: RequirementMappingPaneData }) {
  const fields = { projectId: mapping.projectId, blockId: mapping.blockId };
  const detailHref = (itemId: string) =>
    `/enterprise/disclosure-projects/${mapping.projectId}/requirements/${itemId}`;
  const selected = mapping.options.filter((o) => mapping.selectedIds.includes(o.id));
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-2" data-requirement-mapping="">
      <h3 className="flex items-center gap-1 text-small font-semibold text-ink">
        <Link2 className="size-3.5" aria-hidden="true" />
        要求事項の対応付け（{mapping.selectedIds.length} 件）
      </h3>
      {selected.length > 0 && (
        <ul className="space-y-0.5 text-caption">
          {selected.map((o) => (
            <li key={o.id}>
              <Link
                href={detailHref(o.id)}
                className="inline-flex items-center gap-1 text-brand-800 hover:underline"
              >
                {o.code} の詳細（区分・判断）
                <ExternalLink className="size-3" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {mapping.canEdit && (
        <Collapsible variant="plain" summary="要求事項を追加・外す…">
          <PreservingForm
            action={updateBlockRequirementsFormAction}
            className="space-y-2"
            aria-label="要求事項を追加・外す"
          >
            <input type="hidden" name="projectId" value={mapping.projectId} />
            <input type="hidden" name="blockId" value={mapping.blockId} />
            <RequirementPicker
              options={mapping.options}
              defaultSelected={mapping.selectedIds}
              idPrefix={`block-req-${mapping.blockId}`}
              legend="この節に対応する要求事項（節の基準の版のもの）"
            />
            <ReasonField
              id={`block-req-reason-${mapping.blockId}`}
              required={mapping.reasonRequired}
              maxLength={mapping.reasonMaxLength}
            />
            <SubmitButton variant="secondary" size="sm" pendingLabel="保存しています…">
              対応付けを保存
            </SubmitButton>
          </PreservingForm>
        </Collapsible>
      )}
      {mapping.canRunAi && mapping.canEdit && (
        <div className="space-y-1.5">
          {mapping.suggestion ? (
            <CandidateDecision
              candidate={{
                summary:
                  mapping.suggestion.candidates.length === 0 ? (
                    <span>本文に対応しうる要求事項の候補は見つかりませんでした。</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {mapping.suggestion.candidates.map((c) => (
                        <li key={c.id}>
                          <span className="font-mono">{c.code}</span> {c.title}
                          <span className="block text-caption text-ink-muted">{c.rationale}</span>
                        </li>
                      ))}
                      {mapping.suggestion.warnings.map((w) => (
                        <li key={w} className="text-caption text-ink-muted">
                          {w}
                        </li>
                      ))}
                    </ul>
                  ),
                source: mapping.suggestion.source,
                createdAt: mapping.suggestion.createdAt,
                confidence: mapping.suggestion.confidence,
              }}
              adopt={
                mapping.suggestion.candidates.length > 0
                  ? {
                      action: adoptBlockRequirementCandidatesAction,
                      fields: { ...fields, runId: mapping.suggestion.runId },
                    }
                  : undefined
              }
              adoptFields={
                mapping.suggestion.candidates.length > 0 ? (
                  <fieldset className="space-y-1">
                    <legend className="text-small font-medium text-ink">
                      対応付ける候補を選ぶ
                    </legend>
                    {mapping.suggestion.candidates.map((c) => (
                      <NativeCheckbox
                        key={c.id}
                        name="itemIds"
                        value={c.id}
                        defaultChecked
                        label={`${c.code} ${c.title}`}
                      />
                    ))}
                    {mapping.reasonRequired && (
                      <ReasonField
                        id={`block-req-adopt-reason-${mapping.blockId}`}
                        required
                        maxLength={mapping.reasonMaxLength}
                      />
                    )}
                  </fieldset>
                ) : undefined
              }
              reject={{
                action: rejectBlockRequirementCandidatesAction,
                fields: { ...fields, runId: mapping.suggestion.runId },
              }}
              rejectReasonMaxLength={mapping.rejectReasonMaxLength}
              canWrite={mapping.canEdit}
              canRunAi={mapping.canRunAi}
              labels={{ adopt: '選んだ候補を対応付ける', reject: '候補を採用しない' }}
            />
          ) : (
            <form action={suggestBlockRequirementsAction}>
              <input type="hidden" name="projectId" value={mapping.projectId} />
              <input type="hidden" name="blockId" value={mapping.blockId} />
              <input type="hidden" name="frameworkVersionId" value={mapping.frameworkVersionId} />
              <SubmitButton
                variant="secondary"
                size="sm"
                icon={<Sparkles aria-hidden="true" />}
                pendingLabel="候補を作っています…"
              >
                AI に対応の候補を出させる
              </SubmitButton>
              <p className="mt-1 text-caption text-ink-muted">
                候補は表示するだけです。対応付けは、選んで「対応付ける」を押したときだけ変わります。
              </p>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** 保証側のコメント（この節の段落・数値を指すもの）。回答は「保証側のコメント」の画面で行う */
export function AssuranceNotesList({
  notes,
  paragraphLabel,
}: {
  notes: AssuranceNoteView[];
  paragraphLabel: (paragraphId: string) => string;
}) {
  return (
    <div className="mb-3 space-y-1.5 border-b border-line pb-2" data-assurance-notes="">
      <h3 className="flex items-center gap-1 text-small font-semibold text-ink">
        <MessageSquareQuote className="size-3.5" aria-hidden="true" />
        保証側のコメント（{notes.length} 件）
      </h3>
      <ul className="space-y-1.5">
        {notes.map((note) => (
          <li key={note.id} className="rounded-t4d border border-line p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge domain="clientNote" value={note.state} />
              <span className="text-caption text-ink-muted">
                {note.engagementLabel}・{formatJst(note.createdAt)}
                {note.paragraphId ? `・${paragraphLabel(note.paragraphId)}` : ''}
                {note.responseCount > 0 ? `・回答 ${note.responseCount} 件` : ''}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-ink">{note.body}</p>
          </li>
        ))}
      </ul>
      <Link
        href="/enterprise/assurance-comments"
        className="text-caption text-brand-800 hover:underline"
      >
        保証側のコメントの一覧で回答する
      </Link>
    </div>
  );
}
