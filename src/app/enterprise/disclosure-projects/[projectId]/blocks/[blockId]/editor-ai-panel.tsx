'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Bot, CheckCircle2, Info, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { changedSinceRun } from '@/lib/ai/draft-conflict';
import { contentHashOf, diffChars } from '@/lib/domain/disclosure-block';
import { formatJst } from '@/lib/format/datetime';
import type { DisclosureDraftOperation } from '@/lib/ai/schemas';
import type { DraftRunView, SelectableSourceKind } from '@/lib/services/disclosure-ai-draft';
import type { BlockBody } from '@/types/domain';
import { adoptDraftAction, closeDraftRunAction, generateBlockDraftAction } from '../actions';
import { DiffText } from './diff-text';

export interface AiPanelProps {
  projectId: string;
  blockId: string;
  runs: DraftRunView[];
  aiMode: 'mock' | 'openai';
  canRunAi: boolean;
  editable: boolean;
  selectedSources: Array<{ kind: SelectableSourceKind; id: string }>;
  getBody: () => BlockBody;
  /** 画面が読み込んだ・最後に保存した作業本文の保存時刻（別の人の自動保存との競合の検出） */
  getWorkingToken: () => string | null;
  baseVersionId: string | null;
  onBodyReplaced: (body: BlockBody, savedAt: string) => void;
  /** ほかの人が自動保存した作業本文があり、採用を止めた */
  onWorkingConflict: (body: BlockBody, message: string) => void;
  onAnnounce: (message: string) => void;
  paragraphText: (paragraphId: string) => string | null;
}

/** 通信そのものが失敗したとき（接続断・タイムアウト前の 5xx など）。手動の作業は続けられる */
const NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした（AI の処理が完了したかは分かりません）。手動での編集・保存・レビュー依頼はそのまま続けられます。画面を再読み込みすると結果を確認できます。';

const OPERATIONS: Array<{ op: DisclosureDraftOperation; label: string; hint: string }> = [
  {
    op: 'draft_from_sources',
    label: '選択した根拠から下書き',
    hint: '根拠パネルで「AI の根拠に使う」を選んだ資料・定性情報・数値だけを使います。',
  },
  {
    op: 'update_from_prior_year',
    label: '前年からの変更案',
    hint: '前年の同じ節を、選んだ当年度の根拠で書き直す案を出します。',
  },
  {
    op: 'polish',
    label: '文章を整える',
    hint: '数値・引用を含まない段落の表記だけを整えます（意味・数値は変えません）。',
  },
];

export function AiPanel(props: AiPanelProps) {
  const router = useRouter();
  const [runs, setRuns] = React.useState<DraftRunView[]>(props.runs);
  const [pending, setPending] = React.useState<DisclosureDraftOperation | 'adopt' | 'close' | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [conflictRun, setConflictRun] = React.useState<string | null>(null);

  React.useEffect(() => setRuns(props.runs), [props.runs]);

  const latest = runs[0] ?? null;
  const disabledReason = !props.canRunAi
    ? 'AI 下書きを使う権限がありません（手動の編集はそのまま使えます）。'
    : !props.editable
      ? '下書き・差戻しの節でだけ AI 下書きを使えます。'
      : null;

  /** 通信が失敗したら「実行中」のまま止めず、失敗を示して操作できる状態へ戻す（A19） */
  const failNetwork = () => {
    setError(NETWORK_ERROR_MESSAGE);
    props.onAnnounce(NETWORK_ERROR_MESSAGE);
  };

  const generate = async (operation: DisclosureDraftOperation, regenerate = false) => {
    setPending(operation);
    setError(null);
    setConflictRun(null);
    props.onAnnounce('AI の下書き候補を作成しています…');
    let result: Awaited<ReturnType<typeof generateBlockDraftAction>>;
    try {
      result = await generateBlockDraftAction({
        projectId: props.projectId,
        blockId: props.blockId,
        operation,
        sources: operation === 'polish' ? [] : props.selectedSources,
        workingBody: props.getBody(),
        regenerate,
      });
    } catch {
      failNetwork();
      return;
    } finally {
      setPending(null);
    }
    if (result.status !== 'succeeded') {
      // 失敗・タイムアウトの文面はサーバーが「手動で続けられる」旨まで付けて返す
      const message =
        result.status === 'error'
          ? `${result.message} 手動での編集・保存・レビュー依頼はそのまま続けられます。`
          : result.message;
      setError(message);
      props.onAnnounce(message);
      router.refresh();
      return;
    }
    setRuns((prev) => [result.run, ...prev.filter((r) => r.runId !== result.run.runId)]);
    props.onAnnounce(
      result.reused
        ? '同じ入力の候補が既にあるため、その候補を表示しました。'
        : `候補を ${result.run.candidates.length} 件作成しました（${result.run.providerLabel}）。本文にはまだ反映していません。`,
    );
    router.refresh();
  };

  const adopt = async (run: DraftRunView, indexes: number[], allowOnConflict = false) => {
    setPending('adopt');
    setError(null);
    let result: Awaited<ReturnType<typeof adoptDraftAction>>;
    try {
      result = await adoptDraftAction({
        projectId: props.projectId,
        blockId: props.blockId,
        runId: run.runId,
        candidateIndexes: indexes,
        workingBody: props.getBody(),
        baseVersionId: props.baseVersionId,
        allowOnConflict,
        knownWorkingSavedAt: props.getWorkingToken(),
      });
    } catch {
      failNetwork();
      return;
    } finally {
      setPending(null);
    }
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    if (result.status === 'working_conflict') {
      setError(result.message);
      props.onWorkingConflict(result.body, result.message);
      return;
    }
    if (result.status === 'version_conflict') {
      setError(
        'ほかの操作で新しい版が保存されています。画面を再読み込みしてから採用してください。',
      );
      return;
    }
    if (result.status === 'conflict') {
      setConflictRun(run.runId);
      props.onAnnounce(result.message);
      return;
    }
    props.onBodyReplaced(result.body, result.savedAt);
    props.onAnnounce(
      `候補を ${result.adopted} 段落採用し、作業中の本文に入れました（自動保存済み）。`,
    );
    router.refresh();
  };

  const close = async (run: DraftRunView, discard: boolean) => {
    setPending('close');
    setError(null);
    let result: Awaited<ReturnType<typeof closeDraftRunAction>>;
    try {
      result = await closeDraftRunAction({
        projectId: props.projectId,
        blockId: props.blockId,
        runId: run.runId,
        discard,
        // 採用した段落があるかは画面の本文で判定する（作業本文は別のサーバーに無いことがある）
        workingBody: props.getBody(),
      });
    } catch {
      failNetwork();
      return;
    } finally {
      setPending(null);
    }
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    props.onAnnounce(
      result.decision === 'accepted'
        ? '候補の確認を終えました（採用した段落は本文に残ります）。'
        : discard
          ? '候補を破棄しました。'
          : '候補の確認を終えました（採用した段落はありません）。',
    );
    router.refresh();
  };

  // サーバーの採用処理と同じ判定（同じ実行の候補を採用した変化は数えない）
  const bodyChangedSince = (run: DraftRunView) =>
    run.baseParagraphHashes
      ? changedSinceRun(run.baseParagraphHashes, props.getBody(), run.runId)
      : run.baseHash !== null && run.baseHash !== contentHashOf(props.getBody());

  return (
    <section
      aria-labelledby="ai-panel-title"
      className="rounded-t4d-lg border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Bot className="size-4 text-brand-700" aria-hidden="true" />
        <h2 id="ai-panel-title" className="text-[13px] font-semibold text-ink">
          AI 下書き支援（補助）
        </h2>
        <Badge tone={props.aiMode === 'mock' ? 'warning' : 'brand'}>
          <Info className="size-3" aria-hidden="true" />
          {props.aiMode === 'mock' ? 'デモ生成（Mock）' : 'AI 接続中'}
        </Badge>
        <span className="text-[11px] text-ink-muted">
          候補を出すだけで、本文への反映・承認は人が行います。
        </span>
      </div>

      <div className="space-y-2 p-3">
        {disabledReason ? (
          <p className="text-[12px] text-ink-muted">{disabledReason}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {OPERATIONS.map(({ op, label, hint }) => {
              const needsSources =
                op === 'draft_from_sources' && props.selectedSources.length === 0;
              return (
                <Button
                  key={op}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending !== null || needsSources}
                  onClick={() => generate(op)}
                  title={hint}
                  aria-describedby={`ai-hint-${op}`}
                >
                  {pending === op ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles aria-hidden="true" />
                  )}
                  {label}
                </Button>
              );
            })}
            {latest?.operation && latest.state !== 'failed' && latest.state !== 'timeout' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => generate(latest.operation as DisclosureDraftOperation, true)}
              >
                <RotateCcw aria-hidden="true" />
                作り直す（本文の編集は残ります）
              </Button>
            )}
          </div>
        )}
        {!disabledReason && (
          <ul className="space-y-0.5 text-[11px] text-ink-muted">
            {OPERATIONS.map(({ op, hint }) => (
              <li key={op} id={`ai-hint-${op}`}>
                {hint}
              </li>
            ))}
            <li>選択中の根拠: {props.selectedSources.length} 件</li>
          </ul>
        )}

        {pending && pending !== 'adopt' && pending !== 'close' && (
          <p role="status" className="flex items-center gap-1 text-[12px] text-ink">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            実行中です。完了までの間も本文は編集できます（完了後に本文が変わっていれば自動では反映しません）。
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft p-2 text-[12px] text-ink"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
            {error}
          </p>
        )}

        {latest && (
          <RunView
            run={latest}
            {...{ props, pending, adopt, close, conflictRun, bodyChangedSince }}
          />
        )}

        {runs.length > 1 && (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-ink-muted">
              これまでの実行（{runs.length - 1} 件）
            </summary>
            <ul className="mt-1 space-y-1">
              {runs.slice(1).map((run) => (
                <li key={run.runId} className="text-ink-muted">
                  {formatJst(run.metadata.startedAt)} ／ {run.operationLabel} ／ {run.stateLabel} ／{' '}
                  {run.providerLabel}
                  {run.metadata.failureReason ? ` ／ ${run.metadata.failureReason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function RunView({
  run,
  props,
  pending,
  adopt,
  close,
  conflictRun,
  bodyChangedSince,
}: {
  run: DraftRunView;
  props: AiPanelProps;
  pending: string | null;
  adopt: (run: DraftRunView, indexes: number[], allowOnConflict?: boolean) => Promise<void>;
  close: (run: DraftRunView, discard: boolean) => Promise<void>;
  conflictRun: string | null;
  bodyChangedSince: (run: DraftRunView) => boolean;
}) {
  const open = run.state === 'pending' || run.state === 'accepted';
  const conflict = conflictRun === run.runId || (open && bodyChangedSince(run));
  const canAct = props.canRunAi && props.editable && open && pending === null;

  return (
    <div className="rounded-t4d border border-line">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-muted px-2 py-1.5 text-[12px]">
        <span className="font-medium text-ink">{run.operationLabel}</span>
        <Badge
          tone={
            run.state === 'failed' || run.state === 'timeout'
              ? 'danger'
              : run.state === 'pending'
                ? 'brand'
                : 'neutral'
          }
        >
          {run.state === 'failed' || run.state === 'timeout' ? (
            <AlertTriangle className="size-3" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-3" aria-hidden="true" />
          )}
          {run.stateLabel}
        </Badge>
        <Badge tone="outline">{run.providerLabel}</Badge>
        <span className="text-ink-muted">{formatJst(run.metadata.startedAt)}</span>
      </div>

      <div className="space-y-2 p-2 text-[12px]">
        {(run.state === 'failed' || run.state === 'timeout') && (
          <p className="text-ink">
            {run.metadata.failureReason ?? 'AI の実行に失敗しました。'}
            手動での編集・保存・レビュー依頼はそのまま続けられます。
          </p>
        )}

        {conflict && open && (
          <p
            role="alert"
            className="flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft p-2 text-ink"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
            生成を始めた後に本文が変更されています。候補は自動では反映しません。差分を確認し、段落ごとに採用してください（置き換えずに元の段落の直後へ追加します）。
          </p>
        )}

        {run.candidates.length > 0 && (
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <h3 className="text-[12px] font-semibold text-ink">本文の候補（差分プレビュー）</h3>
              {canAct && !conflict && run.state === 'pending' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    adopt(
                      run,
                      run.candidates.map((c) => c.index),
                    )
                  }
                >
                  すべて採用
                </Button>
              )}
            </div>
            <ol className="space-y-1.5">
              {run.candidates.map((c) => {
                const current = c.paragraphId ? props.paragraphText(c.paragraphId) : null;
                return (
                  <li key={c.index} className="rounded-t4d border border-line p-2">
                    <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                      <span>候補 {c.index + 1}</span>
                      <Badge tone={current !== null ? 'warning' : 'success'}>
                        {current !== null ? `段落 ${c.paragraphId} の置き換え案` : '新しい段落'}
                      </Badge>
                      {c.kind === 'heading' && <Badge tone="neutral">見出し</Badge>}
                    </div>
                    {current !== null ? (
                      <DiffText segments={diffChars(current, c.text)} />
                    ) : (
                      <ins className="whitespace-pre-wrap text-ink no-underline">
                        <span className="sr-only">（追加）</span>
                        {c.text}
                      </ins>
                    )}
                    <p className="mt-1 text-[11px] text-ink-muted">
                      根拠: {c.sourceLabels.join(' ／ ') || '—'}
                    </p>
                    {canAct && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-1"
                        onClick={() => adopt(run, [c.index], conflict)}
                      >
                        {conflict ? '差分を確認して採用（直後に追加）' : 'この段落を採用'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {run.missingInformation.length > 0 && (
          <div className="rounded-t4d border border-warning/40 bg-warning-soft/40 p-2">
            <h3 className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-ink">
              <AlertTriangle className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
              不足情報（本文には書いていません）
            </h3>
            <ul className="list-disc space-y-1 pl-4">
              {run.missingInformation.map((m, i) => (
                <li key={i} className="text-ink">
                  {m.item}: {m.reason}
                  {m.nextCheck && (
                    <span className="block text-ink-muted">次に確認: {m.nextCheck}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {run.conflicts.length > 0 && (
          <div className="rounded-t4d border border-danger/40 bg-danger-soft/40 p-2">
            <h3 className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-ink">
              <AlertTriangle className="size-3.5 text-danger" aria-hidden="true" />
              相反する根拠（人が判断するまで本文にしません）
            </h3>
            <ul className="space-y-1">
              {run.conflicts.map((c, i) => (
                <li key={i} className="text-ink">
                  <span className="font-medium">{c.subject}</span>: {c.detail}
                  <span className="block text-ink-muted">出典: {c.sourceLabels.join(' ／ ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {run.warnings.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}

        {canAct && run.state === 'pending' && (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => close(run, false)}>
              候補の確認を終える
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => close(run, true)}>
              候補を破棄
            </Button>
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-[11px] text-ink-muted">生成の記録</summary>
          <dl className="mt-1 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
            <dt className="text-ink-muted">実行 ID</dt>
            <dd className="break-all font-mono text-ink">{run.metadata.runId}</dd>
            <dt className="text-ink-muted">モデル</dt>
            <dd className="text-ink">
              {run.providerLabel} ／ {run.metadata.model}
            </dd>
            <dt className="text-ink-muted">プロンプト版</dt>
            <dd className="break-all text-ink">{run.metadata.promptVersion}</dd>
            <dt className="text-ink-muted">開始・終了</dt>
            <dd className="text-ink">
              {formatJst(run.metadata.startedAt)} 〜 {formatJst(run.metadata.finishedAt)}
            </dd>
            <dt className="text-ink-muted">入力の参照</dt>
            <dd className="text-ink">{run.metadata.inputReferenceCount} 件</dd>
            <dt className="text-ink-muted">使った要求事項</dt>
            <dd className="text-ink">{run.usedRequirementCodes.join('、') || '—'}</dd>
            {run.rejectedRefCount > 0 && (
              <>
                <dt className="text-ink-muted">採用しなかった参照</dt>
                <dd className="text-ink">{run.rejectedRefCount} 件（入力に無い ID）</dd>
              </>
            )}
            {run.metadata.failureReason && (
              <>
                <dt className="text-ink-muted">失敗理由</dt>
                <dd className="text-ink">{run.metadata.failureReason}</dd>
              </>
            )}
          </dl>
        </details>
      </div>
    </div>
  );
}
