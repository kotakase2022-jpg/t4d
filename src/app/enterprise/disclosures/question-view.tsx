import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Bot, Check, CircleX, Send } from 'lucide-react';
import {
  AiGeneratedBadge,
  DataCoverageBadge,
  ResponseStatusBadge,
} from '@/components/shared/badges';
import { CommentBox } from '@/components/shared/comment-box';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MentionText } from '@/components/shared/mention-text';
import { PageActions } from '@/components/shared/page-actions';
import { ActionButton } from '@/components/shared/action-button';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import { responseStateActions, type StateAction } from '@/lib/ui/state-actions';
import type { AnswerType, FrameworkKey } from '@/types/domain';
import {
  generateCdpDraftAction,
  rejectAiDraftAction,
  saveCdpResponseAction,
  transitionCdpResponseAction,
} from '../actions';
import { QuestionList } from './_components/question-list';
import { ReturnResponseDialog } from './_components/return-response-dialog';

/** 指標 1 つ分の値の表示。値の行が無いときは 0 ではなく「値なし」と書く（W0 O4） */
function metricValueLabel(value: number | null, unit: string): string {
  return value === null ? '値なし' : `${formatNumber(value)} ${unit}`;
}

/** 回答の形（生の enum を画面に出さない。plan §1.17） */
const ANSWER_TYPE_LABEL: Record<AnswerType, string> = {
  text: '文章',
  numeric: '数値',
  single_choice: '単一選択',
  multi_choice: '複数選択',
  table: '表',
};

/**
 * 開示質問の詳細（三ペイン）。CDP と CSRD で共有する（plan §2 S6）。
 * フレームワーク固有なのはキー・ラベル・リンク先だけなので Props で受ける。
 *
 * 操作は「状態 × 権限」で決める（src/lib/ui/state-actions.ts の responseStateActions。plan §1.15）:
 *  - primary は 1 つ（下書き・差戻しは「保存（下書き）」、レビュー中は承認者の「承認」）
 *  - 作成と承認を兼ねる利用者が下書きのときは、承認を「その他」へ（作る人と承認する人の仕事を重ねない）
 *  - 差戻しは理由必須の確認ダイアログ。AI の生成・不採用は「その他」
 * 補助の情報（前年との差分・対応するデータ・版の履歴・コメント）は既定で閉じた節にし、要点を summary に書く。
 * 「AI は確定しない・候補である」の注記は閉じた節の外に置く。
 *
 * `backLink` は任意。CSRD は要求事項の評価（適用・3 観点）から回答へ来るため、
 * 「要求事項の評価へ戻る」を出す（docs/disclosure-first.md §9.4）。CDP は渡さない。
 */
export async function QuestionDetailView({
  frameworkKey,
  frameworkLabel,
  basePath,
  questionId,
  backLink,
}: {
  frameworkKey: FrameworkKey;
  frameworkLabel: string;
  basePath: string;
  questionId: string;
  backLink?: { href: string; label: string };
}) {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const workspace = await loadDisclosureWorkspace(
    db,
    ctx,
    frameworkKey,
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
  );
  if (!workspace) notFound();

  const index = workspace.rows.findIndex((r) => r.item.id === questionId);
  const row = workspace.rows[index];
  if (!row) notFound();

  const previousRow = index > 0 ? workspace.rows[index - 1] : undefined;
  const nextRow = index < workspace.rows.length - 1 ? workspace.rows[index + 1] : undefined;

  const currentVersion = row.response?.currentVersionId
    ? await db.findById('disclosureResponseVersions', row.response.currentVersionId)
    : null;
  const aiRun = currentVersion?.originatedFromAiRunId
    ? await db.findById('aiRuns', currentVersion.originatedFromAiRunId)
    : null;

  const versions = row.response
    ? await db.select('disclosureResponseVersions', {
        where: { responseId: row.response.id },
        orderBy: { column: 'versionNo', dir: 'desc' },
      })
    : [];

  // 質問単位のコメント＋メンション（WF-P0-002）
  const comments = row.response
    ? await db.select('comments', {
        where: { targetType: 'disclosure_response', targetId: row.response.id },
        orderBy: { column: 'createdAt', dir: 'desc' },
      })
    : [];
  const mentionCandidates = await listMentionCandidates(db, ctx);
  const authorNameById = new Map(mentionCandidates.map((m) => [m.userId, m.displayName]));

  const status = row.response?.status ?? 'not_started';
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canRunAi = can(ctx, 'enterprise.ai.run');
  const isAiDraft = Boolean(currentVersion?.originatedFromAiRunId);
  const hasPendingAiDraft = aiRun !== null && aiRun.status !== 'rejected';
  const pagePath = `${basePath}/${row.item.id}`;

  const plan = responseStateActions({
    status,
    can: (permission) => can(ctx, permission),
    hasResponse: Boolean(row.response?.currentVersionId),
    isAiDraft,
    hasPendingAiDraft,
  });

  /** 状態の操作を画面の操作（ActionSpec）へ写す。回答が無い質問では何も出さない */
  const toSpec = (action: StateAction): MenuActionSpec | null => {
    const response = row.response;
    if (!response) return null;
    const base = {
      id: action.id,
      label: action.label,
      ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
    };
    switch (action.id) {
      case 'request-review':
        return {
          ...base,
          kind: 'submit',
          icon: <Send aria-hidden="true" />,
          action: transitionCdpResponseAction,
          fields: { responseId: response.id, to: 'in_review' },
          pendingLabel: '依頼中…',
        };
      case 'approve':
        return {
          ...base,
          kind: 'submit',
          icon: <Check aria-hidden="true" />,
          action: transitionCdpResponseAction,
          fields: { responseId: response.id, to: 'approved' },
          pendingLabel: '承認中…',
        };
      case 'generate-ai-draft':
        return {
          ...base,
          kind: 'submit',
          group: 'advanced',
          icon: <Bot aria-hidden="true" />,
          action: generateCdpDraftAction,
          fields: { responseId: response.id },
          pendingLabel: '生成中…',
        };
      case 'reject-ai-draft':
        if (!aiRun) return null;
        return {
          ...base,
          kind: 'confirm',
          group: 'advanced',
          icon: <CircleX aria-hidden="true" />,
          action: rejectAiDraftAction,
          fields: { aiRunId: aiRun.id, itemId: row.item.id },
          confirm: {
            tier: 'irreversible',
            title: 'この AI 下書きを不採用にしますか',
            scope: `${row.item.code} の AI 回答ドラフト（${formatJst(aiRun.createdAt)} 生成）`,
            consequences: [
              '採用しないことを AI の実行記録に残します。取り消せません。',
              '回答の本文は変わりません。直す場合は回答を編集して保存してください。',
            ],
            reason: { name: 'comment', label: '不採用の理由', required: false },
            confirmLabel: '不採用にする',
            destructive: false,
          },
        };
      default:
        return null;
    }
  };

  const saveIsPrimary = plan.primary?.id === 'save-draft';
  const footerPrimary =
    plan.primary && plan.primary.id !== 'save-draft' ? toSpec(plan.primary) : null;
  const footerSecondary = plan.secondary.filter((a) => a.id !== 'return');
  const canReturn = plan.secondary.some((a) => a.id === 'return') && row.response !== null;
  const moreItems = plan.more.map(toSpec).filter((spec): spec is MenuActionSpec => spec !== null);

  const isMultiMetric = row.metricValues.length > 1;
  const delta =
    row.currentValue !== null && row.previousValue !== null && row.previousValue !== 0
      ? ((row.currentValue - row.previousValue) / row.previousValue) * 100
      : null;
  const changed = row.item.changeType === 'new' || row.item.changeType === 'changed';
  // 前年との差分（数値）。前年の回答文は回答欄の下に参照として出す（plan D7）ので、ここでは数えない
  const hasPrevious = row.currentValue !== null || row.previousValue !== null || isMultiMetric;
  const previousAnswer = row.previousResponse?.answerText ?? null;

  const backAction: ActionSpec | undefined = backLink
    ? {
        kind: 'link',
        id: 'back',
        label: backLink.label,
        href: backLink.href,
        icon: <ArrowLeft aria-hidden="true" />,
      }
    : undefined;

  return (
    <>
      <PageHeader
        title={`${row.item.code} ${row.item.section}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ResponseStatusBadge status={status} />
            <Badge tone={row.item.changeType === 'new' ? 'warning' : 'neutral'}>
              {row.item.changeType === 'new'
                ? '新規質問'
                : row.item.changeType === 'changed'
                  ? '変更あり'
                  : '前年から継続'}
            </Badge>
            {row.item.required && <Badge tone="brand">必須</Badge>}
            {isAiDraft && aiRun && <AiGeneratedBadge provider={aiRun.provider} />}
          </span>
        }
        context={
          // 前・次は 1 つのページャにまとめる（左の一覧では j/k で移動できる）
          <nav aria-label="質問の移動" className="flex flex-wrap items-center gap-2 text-small">
            <span className="text-ink-muted">
              {frameworkLabel} の質問 {index + 1} / {workspace.rows.length}
            </span>
            {previousRow && (
              <Link
                href={`${basePath}/${previousRow.item.id}`}
                className="text-brand-700 hover:underline"
              >
                ← 前の質問
              </Link>
            )}
            {nextRow && (
              <Link
                href={`${basePath}/${nextRow.item.id}`}
                className="text-brand-700 hover:underline"
              >
                次の質問 →
              </Link>
            )}
          </nav>
        }
        breadcrumbsTail={[{ label: row.item.code }]}
        actions={<PageActions secondary={backAction ? [backAction] : undefined} more={moreItems} />}
      />

      {/* 三ペイン（指示書 15.4） */}
      <div className="grid grid-cols-[260px_1fr_360px] gap-3 p-4">
        {/* 左: 質問一覧（絞り込み付き。折りたためる） */}
        <Collapsible
          summary={`質問一覧（${workspace.rows.length} 件）`}
          defaultOpen
          className="h-fit"
          bodyClassName="px-2 pb-2"
        >
          <QuestionList
            currentId={row.item.id}
            items={workspace.rows.map((r) => ({
              id: r.item.id,
              code: r.item.code,
              text: r.item.questionText,
              href: `${basePath}/${r.item.id}`,
              change:
                r.item.changeType === 'new'
                  ? 'new'
                  : r.item.changeType === 'changed'
                    ? 'changed'
                    : null,
              approved: (r.response?.status ?? 'not_started') === 'approved',
            }))}
          />
        </Collapsible>

        {/* 中央: 質問と回答 */}
        <div className="min-w-0 space-y-3">
          <Section title="質問" divider="none">
            <div className="space-y-2">
              <p className="text-body text-ink">{row.item.questionText}</p>
              {row.item.guidance && (
                <p className="rounded-t4d bg-surface-muted p-2 text-small text-ink-muted">
                  記入の手引き: {row.item.guidance}
                </p>
              )}
              <p className="text-caption text-ink-muted">
                回答の形: {ANSWER_TYPE_LABEL[row.item.answerType]}
                {row.item.options.length > 0 && ` ／ 選択肢: ${row.item.options.join(' / ')}`}
              </p>
            </div>
          </Section>

          <Section
            title="回答"
            actions={
              isAiDraft ? (
                <Badge tone="warning">
                  AI 下書きのままでは承認できません（編集して保存してください）
                </Badge>
              ) : undefined
            }
          >
            {canWrite && row.response ? (
              <form action={saveCdpResponseAction} className="space-y-2">
                <input type="hidden" name="responseId" value={row.response.id} />
                {aiRun && <input type="hidden" name="aiRunId" value={aiRun.id} />}
                <input type="hidden" name="editedFromAi" value={isAiDraft ? 'true' : 'false'} />

                {row.item.answerType === 'numeric' && (
                  <label className="block text-small text-ink-muted">
                    数値
                    <Input
                      name="answerNumeric"
                      defaultValue={row.response.answerNumeric ?? row.currentValue ?? ''}
                      inputMode="decimal"
                      className="mt-0.5 w-48"
                    />
                  </label>
                )}

                {row.item.answerType === 'single_choice' && (
                  <fieldset className="text-small text-ink-muted">
                    <legend>選択</legend>
                    <div className="mt-0.5 flex flex-wrap gap-2">
                      {row.item.options.map((option) => (
                        <label key={option} className="flex items-center gap-1 text-body text-ink">
                          <input
                            type="radio"
                            name="answerChoice"
                            value={option}
                            defaultChecked={row.response?.answerChoice.includes(option)}
                            className="accent-brand-700"
                          />
                          {option}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                <label className="block text-small text-ink-muted">
                  回答本文
                  <Textarea
                    name="answerText"
                    rows={10}
                    defaultValue={row.response.answerText ?? ''}
                    placeholder="承認済みデータと根拠資料をもとに記載してください。"
                    className="mt-0.5"
                  />
                </label>

                <label className="block text-small text-ink-muted">
                  前年からの扱い
                  <NativeSelect
                    name="carryForwardDecision"
                    defaultValue={row.response.carryForwardDecision ?? ''}
                    className="mt-0.5 block w-48"
                  >
                    <option value="">未設定</option>
                    <option value="reuse">前年をそのまま継続</option>
                    <option value="update">前年を更新</option>
                    <option value="new">新規作成</option>
                  </NativeSelect>
                </label>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {/* 状態で主操作が変わる: 下書き・差戻しのときだけ保存が主操作（レビュー中・承認済みでも
                      直して保存はできる。版が増える） */}
                  <SubmitButton
                    variant={saveIsPrimary ? 'primary' : 'secondary'}
                    size="sm"
                    data-t4d-shortcut="save"
                    pendingLabel="保存中…"
                  >
                    保存（下書き）
                  </SubmitButton>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap text-body text-ink">
                {row.response?.answerText ?? '（未回答）'}
              </p>
            )}

            {previousAnswer && (
              // 前年の回答を入力欄のそばに参照として出す（入力はしない。plan D7）
              <div
                className="mt-2 rounded-t4d border border-line bg-surface-muted px-2 py-1.5"
                data-previous-answer=""
              >
                <p className="text-caption font-medium text-ink-muted">
                  前年回答（{workspace.previousPeriod?.label ?? '前年'}・参照のみ）
                </p>
                <p className="whitespace-pre-wrap text-small text-ink-muted">{previousAnswer}</p>
              </div>
            )}

            {(footerPrimary || footerSecondary.length > 0 || canReturn || isAiDraft) && (
              <div
                className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2"
                data-response-actions=""
              >
                {footerSecondary.map((action) => {
                  const spec = toSpec(action);
                  return spec ? <ActionButton key={spec.id} action={spec} /> : null;
                })}
                {canReturn && row.response && (
                  <ReturnResponseDialog
                    responseId={row.response.id}
                    scope={`${frameworkLabel} ${row.item.code} の回答（${workspace.period.label}）`}
                  />
                )}
                {footerPrimary && <ActionButton action={footerPrimary} variant="primary" />}
                {isAiDraft && (
                  <span className="text-caption text-warning-ink">
                    AI 生成のままでは承認できません（DB 側でも禁止されています）。
                  </span>
                )}
              </div>
            )}
          </Section>
        </div>

        {/* 右: AI 回答ドラフト（候補）・補助の情報 */}
        <div className="min-w-0 space-y-3">
          <Section title="AI 回答ドラフト" divider="none">
            <div className="space-y-2">
              {/* AI は確定しない。候補であることは閉じずに見せる（誠実さの注記） */}
              <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                <HonestyBadge kind="ai-candidate" />
                承認済みデータ・前年回答・根拠資料をもとに下書きを作ります。AI
                は確定しません。人が編集・承認してください。
              </p>
              {!aiRun && canRunAi && row.response && (
                <p className="text-caption text-ink-muted">
                  まだ AI
                  回答ドラフトはありません。見出しの「その他」の「ドラフトを生成（AI）」で作れます。
                </p>
              )}

              {aiRun && (
                <div className="space-y-1.5 rounded-t4d border border-line bg-surface-muted p-2">
                  <div className="flex items-center justify-between gap-2">
                    <AiGeneratedBadge provider={aiRun.provider} />
                    <span className="text-caption text-ink-muted">
                      確信度 {Math.round(aiRun.confidence * 100)}%
                    </span>
                  </div>
                  <dl className="space-y-0.5 text-caption text-ink-muted">
                    <div className="flex justify-between gap-2">
                      <dt>モデル</dt>
                      <dd className="truncate text-ink">{aiRun.model}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>プロンプトの版</dt>
                      <dd className="truncate text-ink">{aiRun.promptVersion}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>対象年度</dt>
                      <dd className="text-ink">{workspace.period.code}</dd>
                    </div>
                  </dl>

                  {aiRun.sourceReferences.length > 0 && (
                    <div>
                      <div className="text-caption font-medium text-ink">参照元</div>
                      <ul className="space-y-0.5">
                        {aiRun.sourceReferences.map((s, i) => (
                          <li key={i} className="text-caption text-ink-muted">
                            ・{s.label}
                            {s.periodLabel ? `（${s.periodLabel}）` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {aiRun.warnings.length > 0 && (
                    <ul className="space-y-0.5">
                      {aiRun.warnings.map((w, i) => (
                        <li key={i} className="text-caption text-warning-ink">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}

                  {aiRun.status === 'rejected' ? (
                    // 不採用の結果が画面に出ないと「押しても何も起きない」操作になる。
                    // 採否は ai_runs に残る監査証跡なので、ここでも状態を明示する。
                    <div className="flex items-center gap-1.5">
                      <Badge tone="danger">
                        <CircleX className="size-3" aria-hidden="true" />
                        不採用
                      </Badge>
                      <span className="text-caption text-ink-muted">
                        この AI 下書きは採用しないと記録しました。
                      </span>
                    </div>
                  ) : (
                    canRunAi && (
                      <p className="text-caption text-ink-muted">
                        採用しない場合は「その他」の「この下書きを不採用にする…」で記録します。
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          </Section>

          {hasPrevious && (
            <Section
              id="question-previous"
              collapsible
              title="前年との差分"
              summary={
                delta === null
                  ? `前年（${workspace.previousPeriod?.code ?? '—'}）と比べる`
                  : `増減 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`
              }
              // 新規・変更のあった質問は開いて描く（継続の質問は要点だけ）
              defaultOpen={changed}
            >
              {isMultiMetric ? (
                // 複数の指標を求める項目（例: ESRS E1-6）は、異なる指標を足した値に意味が無いため
                // 合計の増減を出さず、指標ごとに当年・前年を並べる（W0 O7）
                <div className="t4d-scroll-x">
                  <Table>
                    <THead>
                      <TR>
                        <TH>指標</TH>
                        <TH align="right">当年（承認済み）</TH>
                        <TH align="right">前年（{workspace.previousPeriod?.code ?? '—'}）</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {row.metricValues.map((value) => (
                        <TR key={value.metric.id}>
                          <TD>{value.metric.name}</TD>
                          <TD align="right" className="tnum">
                            {metricValueLabel(value.currentValue, value.metric.unit)}
                          </TD>
                          <TD align="right" className="tnum text-ink-muted">
                            {metricValueLabel(value.previousValue, value.metric.unit)}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <dl className="grid grid-cols-3 gap-2 text-small">
                  <div>
                    <dt className="text-ink-muted">当年（承認済みデータ）</dt>
                    <dd className="tnum text-title font-semibold text-ink">
                      {formatNumber(row.currentValue)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">
                      前年（{workspace.previousPeriod?.code ?? '—'}）
                    </dt>
                    <dd className="tnum text-title font-semibold text-ink-muted">
                      {formatNumber(row.previousValue)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">増減</dt>
                    <dd className="tnum text-title font-semibold text-ink">
                      {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
                    </dd>
                  </div>
                </dl>
              )}
            </Section>
          )}

          <Section
            id="question-data"
            collapsible
            title="対応するデータ"
            summary={
              row.mappedMetrics.length === 0
                ? '対応付けた指標はありません'
                : `指標 ${row.mappedMetrics.length} 件`
            }
          >
            {row.mappedMetrics.length === 0 ? (
              frameworkKey === 'cdp' ? (
                <EmptyState
                  kind="no-data"
                  size="compact"
                  title="対応付けた指標がありません"
                  description="対応付けは CDP 開示対応の「その他」にある「質問マッピングを実行（AI）」で候補を作り、人が確認します。"
                  action={
                    <Link href={basePath} className="text-small text-brand-700 hover:underline">
                      CDP 開示対応を開く
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  kind="not-applicable"
                  size="compact"
                  title="対応付けた指標がありません"
                  description="数値を求めない（定性的な）開示項目です。回答本文で記載してください。"
                />
              )
            ) : (
              <>
                {row.dataCoverage !== 'not_mapped' && (
                  <div className="pb-1.5">
                    {/* 値は承認済みだけを数えるため、無い場合は「承認済みデータなし」と書く */}
                    <DataCoverageBadge
                      coverage={row.dataCoverage}
                      missingNames={row.missingMetrics.map((m) => m.name)}
                      noneLabel="承認済みデータなし"
                    />
                  </div>
                )}
                <ul className="divide-y divide-line">
                  {/* 指標ごとに自分の値を出す。項目全体の値（currentValue）を各行に繰り返すと、
                      複数の指標を求める項目で Scope1 の値が Scope2 の行にも出てしまう（W0 O7） */}
                  {row.metricValues.map((value) => (
                    <li key={value.metric.id} className="py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-small text-ink">{value.metric.name}</span>
                        <span className="tnum text-small text-ink-muted">
                          {metricValueLabel(value.currentValue, value.metric.unit)}
                        </span>
                      </div>
                      {value.currentEstimate !== null && (
                        <div className="tnum text-caption text-ink-muted">
                          推計（実績と別）: {formatNumber(value.currentEstimate)}{' '}
                          {value.metric.unit}
                        </div>
                      )}
                      <Link
                        href={`/enterprise/data?q=${encodeURIComponent(value.metric.name)}&status=approved`}
                        className="text-caption text-brand-700 hover:underline"
                      >
                        承認済みデータを見る
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section id="question-comments" title={`コメント（${comments.length}）`}>
            {/* 入力欄は閉じない: ショートカット「c」（コメント入力へ移る）が閉じた節の中では効かず、
                レビューの依頼・差戻し理由のやり取りがこの欄に集まるため（plan S6 の「1 件以上で開く」より
                熟練者の操作を優先した。件数は見出しに出している） */}
            {canWrite && row.response && (
              <CommentBox
                targetType="disclosure_response"
                targetId={row.response.id}
                href={pagePath}
                members={mentionCandidates}
              />
            )}
            {comments.length === 0 && !(canWrite && row.response) && (
              <p className="text-small text-ink-muted">まだコメントはありません。</p>
            )}
            {comments.length > 0 && (
              <ul className="divide-y divide-line">
                {comments.map((c) => (
                  <li key={c.id} className="py-1.5">
                    <p className="text-small text-ink">
                      <MentionText body={c.body} />
                    </p>
                    <span className="text-caption text-ink-muted">
                      {authorNameById.get(c.authorUserId) ?? '—'} ・ {formatJst(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="question-versions"
            collapsible
            title={`版の履歴（${versions.length}）`}
            summary={
              versions[0]
                ? `最新 v${versions[0].versionNo}（${formatJst(versions[0].createdAt)}）`
                : 'まだ版はありません'
            }
          >
            {versions.length === 0 ? (
              <p className="text-small text-ink-muted">回答を保存すると、ここに版が残ります。</p>
            ) : (
              <ul className="divide-y divide-line">
                {versions.map((v) => (
                  <li key={v.id} className="py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-small text-ink">v{v.versionNo}</span>
                      {v.originatedFromAiRunId && <Badge tone="warning">AI 由来</Badge>}
                    </div>
                    <div className="text-caption text-ink-muted">{v.changeReason ?? '—'}</div>
                    <div className="text-caption text-ink-muted">{formatJst(v.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
