import * as React from 'react';
import { Bot, CircleAlert, Database, ScrollText, ShieldCheck, UserCheck } from 'lucide-react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { PreservingForm } from '@/components/shared/preserving-form';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Input, Textarea } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { CSRD_GAP_KIND_QUESTION } from '@/lib/domain/csrd';
import { COVERAGE_LABEL, GAP_KIND_LABEL } from '@/lib/domain/ssbj';
import { formatJst } from '@/lib/format/datetime';
import type { CsrdRequirementView } from '@/lib/services/csrd/requirements';
import type { AiRun } from '@/types/domain';
import {
  SSBJ_COVERAGE_STATUSES,
  SSBJ_GAP_KINDS,
  type SsbjCoverageStatus,
  type SsbjGapKind,
} from '@/types/domain';
import { CoverageStatusBadge, FinalStatusBadge } from '../../_components/csrd-badges';
import {
  reviewCsrdAssessmentAction,
  reviewCsrdAssessmentFormAction,
  runCsrdGapAnalysisAction,
  saveCsrdAssessmentAction,
} from '../actions';

/**
 * 要求事項の詳細の「評価（3 観点）」の区画（plan S4。§1.15 の状態で変わる操作）。
 *
 * 以前は「AI ギャップ分析（候補）」と「担当者の確認」の 2 区画に、確定系の操作が 3 つ（候補を採用・
 * 修正して確定・担当者の入力として確定）並び、どれが最終の確定か分からなかった。ここでは状態から
 * 主操作（primary）を 1 つだけ選ぶ（CandidateDecision と同じ規則）:
 *   - candidate（AI の候補があり、担当者が未確認）: primary「候補を採用」、secondary「修正して確定…」
 *   - manual（候補が無く、未確定）: primary「担当者の入力として確定」、secondary「AI ギャップ分析を実行」
 *   - decided（担当者が確定済み）: 確定の記録を見せ、primary は対応計画の区画（呼び出し側）へ移る
 * 担当者の入力（担当部署を含む）とやり直しの操作は、どの状態でも閉じた折りたたみから使える。
 *
 * CandidateDecision（Stage A）をそのまま使わないのは、入力を残すフォーム（PreservingForm・useActionState の
 * Server Action）と「候補を採用」に添える確認コメント（任意）を、その部品が受けられないため。
 * 呼び出す Server Action は既存のまま（AI は候補だけを書き、確定は人の操作でだけ入る。CLAUDE.md §0.4）。
 */

export type AssessmentStage = 'candidate' | 'manual' | 'decided';

/** 状態（評価対象でないときは操作を出さないため、呼び出し側で inScope を別に見る） */
export function assessmentStageOf(
  view: CsrdRequirementView,
  hasCandidate: boolean,
): AssessmentStage {
  const a = view.assessment;
  if (hasCandidate && view.awaitingReview) return 'candidate';
  if (a?.reviewedAt) return 'decided';
  return 'manual';
}

const GAP_ICON: Record<SsbjGapKind, typeof Database> = {
  disclosure: ScrollText,
  data: Database,
  process: ShieldCheck,
};

/** 3 観点の 1 つ（人が確定した値）。観点が問う内容は「3 観点が問うこと」（既定で閉じる）にまとめる */
function GapCard({ kind, status }: { kind: SsbjGapKind; status: SsbjCoverageStatus }) {
  const Icon = GAP_ICON[kind];
  return (
    <div className="space-y-1 rounded-t4d border border-line p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span className="text-small font-semibold text-ink">{GAP_KIND_LABEL[kind]}</span>
      </div>
      <CoverageStatusBadge status={status} />
    </div>
  );
}

/** 3 観点の選択（担当者の入力・修正して確定で使う） */
function CoverageSelects({
  values,
  labelPrefix,
}: {
  values: Record<SsbjGapKind, SsbjCoverageStatus>;
  labelPrefix: string;
}) {
  const fields: Array<[string, SsbjGapKind]> = [
    ['disclosureStatus', 'disclosure'],
    ['dataStatus', 'data'],
    ['processStatus', 'process'],
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {fields.map(([name, kind]) => (
        <label key={name} className="space-y-1">
          <span className="block text-caption text-ink-muted">{GAP_KIND_LABEL[kind]}</span>
          <NativeSelect
            name={name}
            defaultValue={values[kind]}
            aria-label={`${labelPrefix}: ${GAP_KIND_LABEL[kind]}`}
          >
            {SSBJ_COVERAGE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {COVERAGE_LABEL[status]}
              </option>
            ))}
          </NativeSelect>
        </label>
      ))}
    </div>
  );
}

function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

export function AssessmentSection({
  view,
  stage,
  hasCandidate,
  inScope,
  canWrite,
  canRunAi,
  reportingPeriodId,
  runProvider,
  ownRun,
  providerKind,
  reviewedByName,
}: {
  view: CsrdRequirementView;
  stage: AssessmentStage;
  hasCandidate: boolean;
  inScope: boolean;
  canWrite: boolean;
  canRunAi: boolean;
  reportingPeriodId: string;
  /** 候補を作った実行の提供元（実行の記録が無い Fixture の候補は mock） */
  runProvider: AiRun['provider'];
  ownRun: AiRun | null;
  /** いまの AI の提供元（mock なら実行ボタンに「（デモ生成）」を添える） */
  providerKind: string;
  reviewedByName: string | null;
}) {
  const { item, applicability } = view;
  const a = view.assessment;
  const statuses: Record<SsbjGapKind, SsbjCoverageStatus> = {
    disclosure: a?.disclosureStatus ?? 'unconfirmed',
    data: a?.dataStatus ?? 'unconfirmed',
    process: a?.processStatus ?? 'unconfirmed',
  };
  const canAct = canWrite && inScope;

  // AI の実行は人の確定の代わりにならない（結果は候補）。実行は secondary
  const runForm =
    inScope && canRunAi ? (
      <form action={runCsrdGapAnalysisAction}>
        <Hidden fields={{ reportingPeriodId, itemId: item.id }} />
        <SubmitButton
          size="sm"
          variant="secondary"
          icon={<Bot aria-hidden="true" />}
          pendingLabel="分析しています…"
        >
          {hasCandidate ? 'AI ギャップ分析をやり直す' : 'AI ギャップ分析を実行'}
          {providerKind === 'mock' ? '（デモ生成）' : ''}
        </SubmitButton>
      </form>
    ) : null;

  const manualForm = (primary: boolean) => (
    <PreservingForm action={saveCsrdAssessmentAction} className="space-y-2.5">
      <Hidden fields={{ reportingPeriodId, itemId: item.id }} />
      <CoverageSelects labelPrefix="担当者の入力" values={statuses} />
      <div className="grid grid-cols-[2fr_1fr] gap-2">
        <label className="block space-y-1">
          <span className="text-caption text-ink-muted">
            {hasCandidate
              ? 'コメント（AI の候補と違う値で確定するときは理由が必須。履歴に残ります）'
              : 'コメント（履歴に残ります）'}
          </span>
          <Textarea name="comment" rows={2} defaultValue="" maxLength={600} />
        </label>
        <label className="block space-y-1">
          <span className="text-caption text-ink-muted">担当部署</span>
          <Input name="ownerDepartment" defaultValue={a?.ownerDepartment ?? ''} maxLength={100} />
        </label>
      </div>
      <SubmitButton
        size="sm"
        variant={primary ? 'primary' : 'secondary'}
        icon={<UserCheck aria-hidden="true" />}
        pendingLabel="確定しています…"
      >
        担当者の入力として確定
      </SubmitButton>
    </PreservingForm>
  );

  return (
    <div className="space-y-3">
      {/* 人が確定した値（3 観点）と最終判定 */}
      <div className="grid grid-cols-3 gap-2">
        <GapCard kind="disclosure" status={statuses.disclosure} />
        <GapCard kind="data" status={statuses.data} />
        <GapCard kind="process" status={statuses.process} />
      </div>
      <MoreInfo label="3 観点が問うこと">
        <dl className="space-y-0.5">
          {SSBJ_GAP_KINDS.map((kind) => (
            <div key={kind}>
              <dt className="inline font-medium text-ink">{GAP_KIND_LABEL[kind]}: </dt>
              <dd className="inline">{CSRD_GAP_KIND_QUESTION[kind]}</dd>
            </div>
          ))}
        </dl>
      </MoreInfo>
      {a?.finalStatus && (
        <div className="flex flex-wrap items-center gap-2 rounded-t4d bg-surface-muted p-2">
          <UserCheck className="size-3.5 text-ink-muted" aria-hidden="true" />
          <span className="text-caption text-ink-muted">最終判定</span>
          <FinalStatusBadge status={a.finalStatus} />
          <span className="text-caption text-ink-muted">
            {a.reviewDecision === 'approved'
              ? 'AI の候補を採用'
              : a.reviewDecision === 'modified'
                ? '担当者が修正'
                : '担当者が入力'}
            {a.reviewedAt && ` ／ ${reviewedByName ?? '担当者'} ・ ${formatJst(a.reviewedAt)}`}
          </span>
        </div>
      )}
      {a?.reviewComment && <p className="text-small leading-relaxed text-ink">{a.reviewComment}</p>}

      {!inScope ? (
        <EmptyState
          kind="not-applicable"
          size="compact"
          title="評価対象ではありません"
          description={`${applicability.reason} 事項が重要と判断されると評価できます。`}
          icon={<Bot className="size-5" aria-hidden="true" />}
        />
      ) : (
        <>
          {/* AI の候補（候補であることは折りたたまずに見せる） */}
          {hasCandidate && a ? (
            <div className="space-y-2 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <HonestyBadge kind="ai-candidate" />
                {runProvider === 'mock' && <HonestyBadge kind="mock-ai" />}
                {a.aiEvaluatedAt && (
                  <span className="text-caption text-ink-muted">
                    実行日時 {formatJst(a.aiEvaluatedAt)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caption text-ink-muted">候補</span>
                {SSBJ_GAP_KINDS.map((kind) => {
                  const value =
                    kind === 'disclosure'
                      ? a.aiDisclosureStatus
                      : kind === 'data'
                        ? a.aiDataStatus
                        : a.aiProcessStatus;
                  return value ? (
                    <CoverageStatusBadge key={kind} status={value} prefix={GAP_KIND_LABEL[kind]} />
                  ) : null;
                })}
                {a.aiStatus && (
                  <Badge tone="outline">
                    <Bot className="size-3" aria-hidden="true" />
                    総合（候補）: {COVERAGE_LABEL[a.aiStatus]}
                  </Badge>
                )}
              </div>
              <p className="text-caption text-ink-muted">
                この判定は候補です。最終判定は担当者の確認（候補を採用／修正して確定）で入ります。
              </p>
              {a.aiComment && (
                <div>
                  <p className="text-caption text-ink-muted">評価コメント</p>
                  <p className="text-small leading-relaxed text-ink">{a.aiComment}</p>
                </div>
              )}
              {a.aiMissingInfo.length > 0 && (
                <div>
                  <p className="text-caption text-ink-muted">不足している情報</p>
                  <ul className="list-inside list-disc space-y-0.5 text-small text-ink">
                    {a.aiMissingInfo.map((info) => (
                      <li key={info}>{info}</li>
                    ))}
                  </ul>
                </div>
              )}
              {a.aiRecommendation && (
                <div>
                  <p className="text-caption text-ink-muted">推奨される対応</p>
                  <p className="text-small leading-relaxed text-ink">{a.aiRecommendation}</p>
                </div>
              )}
              {ownRun && (
                <p className="text-caption text-ink-muted">
                  確信度 {Math.round(ownRun.confidence * 100)}% ／ プロンプトの版{' '}
                  {ownRun.promptVersion}
                  {ownRun.warnings.length > 0 && ` ／ 注意: ${ownRun.warnings.join('・')}`}
                </p>
              )}

              {canAct && stage === 'candidate' && (
                <div className="space-y-2 border-t border-brand-200 pt-2">
                  <form
                    action={reviewCsrdAssessmentAction}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <Hidden
                      fields={{
                        assessmentId: a.id,
                        itemId: item.id,
                        decision: 'approved',
                        // 表示した候補（実行日時）。採用までに分析がやり直されていれば、サーバーが断る
                        aiEvaluatedAt: a.aiEvaluatedAt ?? '',
                      }}
                    />
                    <label className="block min-w-60 flex-1 space-y-1">
                      <span className="text-caption text-ink-muted">確認コメント（任意）</span>
                      <Input name="comment" defaultValue="" maxLength={600} />
                    </label>
                    <SubmitButton
                      variant="primary"
                      size="sm"
                      icon={<UserCheck aria-hidden="true" />}
                      pendingLabel="確定しています…"
                    >
                      候補を採用
                    </SubmitButton>
                  </form>
                  <Collapsible variant="plain" summary="修正して確定…">
                    <PreservingForm action={reviewCsrdAssessmentFormAction} className="space-y-2">
                      <Hidden
                        fields={{ assessmentId: a.id, itemId: item.id, decision: 'modified' }}
                      />
                      <CoverageSelects
                        labelPrefix="修正後の対応状況"
                        values={{
                          disclosure: a.aiDisclosureStatus ?? 'unconfirmed',
                          data: a.aiDataStatus ?? 'unconfirmed',
                          process: a.aiProcessStatus ?? 'unconfirmed',
                        }}
                      />
                      <label className="block space-y-1">
                        <span className="text-caption text-ink-muted">修正の理由（必須）</span>
                        <Input name="comment" defaultValue="" required maxLength={600} />
                      </label>
                      <SubmitButton
                        size="sm"
                        variant="secondary"
                        icon={<UserCheck aria-hidden="true" />}
                        pendingLabel="確定しています…"
                      >
                        修正して確定
                      </SubmitButton>
                    </PreservingForm>
                  </Collapsible>
                </div>
              )}
            </div>
          ) : (
            stage === 'manual' && (
              <p className="flex items-start gap-1.5 text-small text-ink-muted">
                <Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                まだ AI ギャップ分析をしていません。承認済みの値・回答の状態・DMA の結果から、3
                観点の候補を作れます（候補は担当者が確認して初めて確定します）。
              </p>
            )
          )}

          {canAct ? (
            stage === 'manual' ? (
              // 候補が無く未確定: 担当者の入力がこの区画の主操作。AI の実行はその後ろの secondary
              <div className="space-y-2">
                {manualForm(true)}
                {runForm}
              </div>
            ) : (
              <div className="space-y-1.5">
                {runForm}
                <Collapsible
                  variant="plain"
                  summary={
                    stage === 'decided'
                      ? '担当者の入力で確定し直す（担当部署もここで変えられます）'
                      : '候補を使わず、担当者の入力で確定する'
                  }
                >
                  {manualForm(false)}
                </Collapsible>
              </div>
            )
          ) : (
            <div className="space-y-1.5">
              <p className="flex items-start gap-1.5 text-small text-ink-muted">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {canWrite
                  ? '評価対象（常に適用・重要と判断した事項）の要求事項だけ入力できます。'
                  : '確認・入力には開示対応の編集権限が必要です。'}
              </p>
              {runForm}
            </div>
          )}
        </>
      )}
    </div>
  );
}
