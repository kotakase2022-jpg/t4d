import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  Check,
  CircleX,
  FileText,
  Link2,
  Send,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import {
  AiGeneratedBadge,
  DataCoverageBadge,
  ResponseStatusBadge,
} from '@/components/shared/badges';
import { CommentBox } from '@/components/shared/comment-box';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MentionText } from '@/components/shared/mention-text';
import { PageActions } from '@/components/shared/page-actions';
import { ActionButton } from '@/components/shared/action-button';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  frameworkKeyOfItem,
  isFrameworkAvailable,
  listResponseAssignees,
  loadDisclosureWorkspace,
  loadQuestionLinks,
  type LinkedContent,
} from '@/lib/services/disclosure';
import { loadLatestConsistencyIssues } from '@/lib/services/disclosure-check';
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
import {
  addResponseLinkAction,
  assignResponseAction,
  linkResponseEvidenceAction,
  removeMetricMappingAction,
  removeResponseLinkAction,
  startResponseAction,
  startResponseDraftAction,
} from './cdp/actions';
import { CdpNotContracted } from './cdp/_components/cdp-not-contracted';

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

const ISSUE_KIND_LABEL: Record<string, string> = {
  missing_information: '不足情報',
  stale_content: '古い記述',
  period_mismatch: '年度不一致',
  contradiction: '回答間の矛盾',
  evidence_gap: 'Evidence 不足',
};
const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 対応付けた T4D の情報の 1 行（題名・使う版・抜粋・外す操作） */
function LinkedContentList({
  title,
  entries,
  versionLabel,
  emptyText,
  canEdit,
  itemId,
  itemCode,
}: {
  title: string;
  entries: LinkedContent[];
  versionLabel: string | null;
  emptyText: string;
  canEdit: boolean;
  itemId: string;
  itemCode: string;
}) {
  return (
    <div className="space-y-1" data-linked-content={title}>
      <h3 className="text-small font-semibold text-ink">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-caption text-ink-muted">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.link.id} className="space-y-0.5 py-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-small text-ink">
                  {entry.href ? (
                    <Link href={entry.href} className="text-brand-700 hover:underline">
                      {entry.label}
                    </Link>
                  ) : (
                    entry.label
                  )}
                  {versionLabel && entry.versionNo !== null && (
                    <span className="ml-1 text-caption text-ink-muted">
                      （{versionLabel} {entry.versionNo}）
                    </span>
                  )}
                </span>
                {canEdit && (
                  <ConfirmDialog
                    tier="irreversible"
                    title="この対応付けを外しますか"
                    scope={`${itemCode} ↔ ${entry.label}`}
                    consequences={[
                      'この質問の回答・AI の草案の材料にこの情報を使わなくなります。',
                      '外した記録は残ります。もう一度使うときは「対応付けを追加」から選び直します。',
                    ]}
                    confirmLabel="外す"
                    action={removeResponseLinkAction}
                    fields={{ linkId: entry.link.id, itemId }}
                    trigger={{
                      label: '外す…',
                      size: 'xs',
                      actionId: `remove-link-${entry.link.id}`,
                    }}
                  />
                )}
              </div>
              {entry.usable ? (
                entry.excerpt && <p className="text-caption text-ink-muted">{entry.excerpt}</p>
              ) : (
                <p className="text-caption text-warning-ink">
                  確認済み・承認済みの版が見つかりません（AI の材料には使いません）。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 開示質問の詳細（三ペイン）。CDP と CSRD で共有する（plan §2 S6）。
 * フレームワーク固有なのはキー・ラベル・リンク先だけなので Props で受ける。
 *
 * 操作は「状態 × 権限」で決める（src/lib/ui/state-actions.ts の responseStateActions。plan §1.15）:
 *  - primary は 1 つ（下書き・差戻しは「保存（下書き）」、レビュー中は承認者の「承認」）
 *  - 下書きのまま承認する経路は「その他」へ。現在の版を作った人には承認を出さない（職務分離 NF-39 C-07）
 *  - 差戻しは理由必須の確認ダイアログ。AI の生成・不採用は「その他」
 * 補助の情報（前年との差分・対応する T4D の情報・根拠・版の履歴）は既定で閉じた節にし、要点を summary に書く。
 * 「AI は確定しない・候補である」の注記は閉じた節の外に置く。
 *
 * トライアル対応（2026-10）:
 *  - CDP は組織ごとに契約するオプション。契約が無ければ理由だけを出す（NF-38）
 *  - 質問の版で一覧を読む（過年度の版の質問も開ける）。期間の版の質問なら、回答の行が無くても
 *    最初の保存・AI 草案で回答を始められる（C-02）
 *  - 担当（C-01）・対応する T4D の情報（C-03）・根拠の再利用（C-04）・整合チェックの指摘（C-06）・
 *    AI の不足情報（NF-41）
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

  if (!(await isFrameworkAvailable(db, ctx, frameworkKey))) {
    return <CdpNotContracted title={`${frameworkLabel} 質問`} />;
  }

  // 質問の版で一覧を読む（前・次はその版の中で動く）。他の基準の項目・無い ID は 404
  const item = UUID.test(questionId) ? await db.findById('disclosureItems', questionId) : null;
  if (!item || (await frameworkKeyOfItem(db, item)) !== frameworkKey) notFound();

  const workspace = await loadDisclosureWorkspace(
    db,
    ctx,
    frameworkKey,
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
    { versionId: item.frameworkVersionId },
  );
  if (!workspace) notFound();

  const index = workspace.rows.findIndex((r) => r.item.id === questionId);
  const row = workspace.rows[index];
  if (!row) notFound();

  const previousRow = index > 0 ? workspace.rows[index - 1] : undefined;
  const nextRow = index < workspace.rows.length - 1 ? workspace.rows[index + 1] : undefined;
  const isPeriodVersion = workspace.version.id === workspace.periodVersionId;

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
  const [mentionCandidates, links, latestIssues, assignees] = await Promise.all([
    listMentionCandidates(db, ctx),
    loadQuestionLinks(db, ctx, row, workspace.period, shell.metrics),
    loadLatestConsistencyIssues(db, ctx, workspace),
    listResponseAssignees(db, ctx),
  ]);
  const authorNameById = new Map(mentionCandidates.map((m) => [m.userId, m.displayName]));
  const issues = latestIssues?.byItemId.get(row.item.id) ?? [];

  const status = row.response?.status ?? 'not_started';
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canRunAi = can(ctx, 'enterprise.ai.run');
  // 回答の行が無い質問は、期間の版の質問なら最初の保存・AI 草案で回答を始める（C-02）
  const canStart = canWrite && !row.response && isPeriodVersion;
  const canEditAnswer = canWrite && (row.response !== null || canStart);
  const canEditMetricMapping = canWrite && frameworkKey === 'cdp';
  const isAiDraft = Boolean(currentVersion?.originatedFromAiRunId);
  const hasPendingAiDraft = aiRun !== null && aiRun.status !== 'rejected';
  const pagePath = `${basePath}/${row.item.id}`;
  // AI が埋められなかった情報（NF-41）。出力を持たない実行（Cookie で出力を空にした行など）は空
  const aiOutput: Record<string, unknown> = aiRun?.outputJson ?? {};
  const aiMissing = Array.isArray(aiOutput.missingInformation)
    ? (aiOutput.missingInformation as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];

  const plan = responseStateActions({
    status,
    can: (permission) => can(ctx, permission),
    hasResponse: Boolean(row.response?.currentVersionId),
    isAiDraft,
    hasPendingAiDraft,
    isCurrentVersionAuthor: Boolean(currentVersion && currentVersion.createdBy === ctx.userId),
  });

  /** 状態の操作を画面の操作（ActionSpec）へ写す。回答が無い質問では回答の開始（AI 草案）だけ */
  const toSpec = (action: StateAction): MenuActionSpec | null => {
    const response = row.response;
    const base = {
      id: action.id,
      label: action.label,
      ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
    };
    if (!response) {
      if (action.id !== 'generate-ai-draft' || !canStart) return null;
      return {
        ...base,
        kind: 'submit',
        group: 'advanced',
        icon: <Bot aria-hidden="true" />,
        action: startResponseDraftAction,
        fields: { itemId: row.item.id, periodId: workspace.period.id },
        pendingLabel: '生成中…',
      };
    }
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

  const ownerId = row.response?.ownerUserId ?? null;
  const reviewerId = row.response?.reviewerUserId ?? null;
  const nameOf = (id: string | null) => (id ? (assignees.nameById.get(id) ?? '—') : '未割当');
  const withCurrent = (options: typeof assignees.owners, current: string | null) =>
    current && !options.some((o) => o.userId === current)
      ? [...options, { userId: current, displayName: nameOf(current) }]
      : options;

  const gapParts = [
    ...(row.gaps.dataMissing > 0 ? [`データ不足 ${row.gaps.dataMissing}`] : []),
    ...(row.gaps.unmapped ? ['未対応付け'] : []),
    ...(row.gaps.aiMissing.length > 0 ? [`AI の不足情報 ${row.gaps.aiMissing.length}`] : []),
  ];
  const linkedCount =
    row.mappedMetrics.length +
    links.narratives.length +
    links.blocks.length +
    links.requirements.length;
  const hasLinkCandidates =
    (canEditMetricMapping && links.candidates.metrics.length > 0) ||
    links.candidates.narratives.length > 0 ||
    links.candidates.blocks.length > 0 ||
    links.candidates.requirements.length > 0;
  const canEditLinks = canWrite && isPeriodVersion;

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
            {gapParts.length > 0 && (
              <Badge tone="warning">
                <TriangleAlert className="size-3" aria-hidden="true" />
                不足 {row.gaps.total}
              </Badge>
            )}
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
          {!isPeriodVersion && (
            <p
              className="rounded-t4d border border-line bg-surface-muted px-2 py-1.5 text-small text-ink"
              data-other-version=""
            >
              この質問は {workspace.versionLabel} の質問です。{workspace.period.label}{' '}
              の回答の対象の版ではないため、ここから回答は始められません。
            </p>
          )}
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
            {canEditAnswer ? (
              <form
                action={row.response ? saveCdpResponseAction : startResponseAction}
                className="space-y-2"
              >
                {row.response ? (
                  <>
                    <input type="hidden" name="responseId" value={row.response.id} />
                    {aiRun && <input type="hidden" name="aiRunId" value={aiRun.id} />}
                    <input type="hidden" name="editedFromAi" value={isAiDraft ? 'true' : 'false'} />
                  </>
                ) : (
                  <>
                    <input type="hidden" name="itemId" value={row.item.id} />
                    <input type="hidden" name="periodId" value={workspace.period.id} />
                    <p className="text-caption text-ink-muted" data-response-start="">
                      まだ回答がありません。保存すると {workspace.period.label}{' '}
                      の回答を始めます（下書き）。
                    </p>
                  </>
                )}

                {row.item.answerType === 'numeric' && (
                  <label className="block text-small text-ink-muted">
                    数値
                    <Input
                      name="answerNumeric"
                      defaultValue={row.response?.answerNumeric ?? row.currentValue ?? ''}
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
                    defaultValue={row.response?.answerText ?? ''}
                    placeholder="承認済みデータと根拠資料をもとに記載してください。"
                    className="mt-0.5"
                  />
                </label>

                <label className="block text-small text-ink-muted">
                  前年からの扱い
                  <NativeSelect
                    name="carryForwardDecision"
                    defaultValue={row.response?.carryForwardDecision ?? ''}
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

        {/* 右: 担当・AI 回答ドラフト（候補）・補助の情報 */}
        <div className="min-w-0 space-y-3">
          <Section id="question-assignee" title="担当" divider="none">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-small">
              <dt className="text-ink-muted">作成担当</dt>
              <dd className="text-ink" data-owner="">
                {nameOf(ownerId)}
              </dd>
              <dt className="text-ink-muted">レビュー担当</dt>
              <dd className="text-ink" data-reviewer="">
                {nameOf(reviewerId)}
              </dd>
            </dl>
            {canEditAnswer && (
              <form action={assignResponseAction} className="mt-2 space-y-2">
                <input type="hidden" name="itemId" value={row.item.id} />
                <input type="hidden" name="periodId" value={workspace.period.id} />
                <Field label="作成担当" id="response-owner" hint="開示を編集できる人">
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name="ownerUserId"
                      size="xs"
                      defaultValue={ownerId ?? 'none'}
                    >
                      <option value="none">未割当</option>
                      {withCurrent(assignees.owners, ownerId).map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field label="レビュー担当" id="response-reviewer" hint="作成担当とは別の人">
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name="reviewerUserId"
                      size="xs"
                      defaultValue={reviewerId ?? 'none'}
                    >
                      <option value="none">未割当</option>
                      {withCurrent(assignees.reviewers, reviewerId).map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <SubmitButton
                  variant="secondary"
                  size="xs"
                  icon={<UserCheck aria-hidden="true" />}
                  pendingLabel="更新中…"
                >
                  担当を更新
                </SubmitButton>
              </form>
            )}
          </Section>

          <Section title="AI 回答ドラフト">
            <div className="space-y-2">
              {/* AI は確定しない。候補であることは閉じずに見せる（誠実さの注記） */}
              <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                <HonestyBadge kind="ai-candidate" />
                承認済みデータ・前年回答と、この質問に対応付けた定性情報（確認済みの版）・承認済みの原稿・根拠の引用位置をもとに下書きを作ります。AI
                は確定しません。人が編集・承認してください。
              </p>
              {!can(ctx, 'enterprise.evidence.read') && (
                <p className="text-caption text-ink-muted">
                  根拠資料の閲覧権限が無いため、資料の引用は AI の入力に含めません。
                </p>
              )}
              {!aiRun && canRunAi && (row.response || canStart) && (
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

                  {aiMissing.length > 0 && (
                    <div data-ai-missing="">
                      <div className="text-caption font-medium text-ink">
                        AI が埋められなかった情報（{aiMissing.length} 件）
                      </div>
                      <ul className="space-y-0.5">
                        {aiMissing.map((m, i) => (
                          <li key={i} className="text-caption text-warning-ink">
                            ・{m}
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

          {issues.length > 0 && latestIssues && (
            <Section id="question-issues" title={`整合チェックの指摘（${issues.length}）`}>
              <ul className="divide-y divide-line">
                {issues.map((issue, i) => (
                  <li key={i} className="space-y-0.5 py-1.5">
                    <Badge tone={issue.severity === 'low' ? 'neutral' : 'warning'}>
                      <TriangleAlert className="size-3" aria-hidden="true" />
                      {ISSUE_KIND_LABEL[issue.kind] ?? '指摘'}・重要度{' '}
                      {SEVERITY_LABEL[issue.severity]}
                    </Badge>
                    <p className="text-small text-ink">{issue.detail}</p>
                  </li>
                ))}
              </ul>
              <p className="pt-1 text-caption text-ink-muted">
                {formatJst(latestIssues.run.createdAt)} の整合チェック（AI）の指摘です。AI
                は指摘のみを行い、回答の修正・承認は人が行います。
                {frameworkKey === 'cdp' && (
                  <Link
                    href={`${basePath}?check=${latestIssues.run.id}`}
                    className="ml-1 text-brand-700 hover:underline"
                  >
                    実行の結果を開く
                  </Link>
                )}
              </p>
            </Section>
          )}

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
            title="対応する T4D の情報"
            summary={
              linkedCount === 0
                ? '対応付けた情報はありません'
                : `指標 ${row.mappedMetrics.length}・定性情報 ${links.narratives.length}・原稿 ${links.blocks.length}・要求事項 ${links.requirements.length} 件`
            }
            defaultOpen={gapParts.length > 0}
          >
            <div className="space-y-3">
              {gapParts.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-warning-ink">
                  <TriangleAlert className="size-3" aria-hidden="true" />
                  不足: {gapParts.join('・')}
                </p>
              )}

              <div className="space-y-1" data-linked-content="数値（指標）">
                <h3 className="text-small font-semibold text-ink">数値（指標）</h3>
                {row.mappedMetrics.length === 0 ? (
                  frameworkKey === 'cdp' ? (
                    <EmptyState
                      kind="no-data"
                      size="compact"
                      title="対応付けた指標がありません"
                      description="下の「対応付けを追加」で指標を選ぶか、CDP 開示対応の「その他」にある「質問マッピングを実行（AI）」で候補を作り、人が確定します。"
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
                      {row.metricValues.map((value) => {
                        const mapping = row.mappings.find((m) => m.metricId === value.metric.id);
                        return (
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
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Link
                                href={`/enterprise/data?q=${encodeURIComponent(value.metric.name)}&status=approved`}
                                className="text-caption text-brand-700 hover:underline"
                              >
                                承認済みデータを見る
                              </Link>
                              {canEditMetricMapping && isPeriodVersion && mapping && (
                                <ConfirmDialog
                                  tier="irreversible"
                                  title="指標の対応付けを外しますか"
                                  scope={`${row.item.code} ↔ ${value.metric.name}`}
                                  consequences={[
                                    'この質問の値・不足・AI の草案の材料にこの指標を使わなくなります。',
                                    '外した記録は監査ログに残ります。もう一度使うときは「対応付けを追加」から選び直します。',
                                  ]}
                                  confirmLabel="外す"
                                  action={removeMetricMappingAction}
                                  fields={{ mappingId: mapping.id, itemId: row.item.id }}
                                  trigger={{
                                    label: '外す…',
                                    size: 'xs',
                                    actionId: `remove-mapping-${mapping.id}`,
                                  }}
                                />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>

              <LinkedContentList
                title="定性情報（確認済みの版）"
                entries={links.narratives}
                versionLabel="確認済みの版"
                emptyText="対応付けた定性情報はありません。"
                canEdit={canEditLinks}
                itemId={row.item.id}
                itemCode={row.item.code}
              />
              <LinkedContentList
                title="承認済みの原稿"
                entries={links.blocks}
                versionLabel="承認済みの版"
                emptyText="対応付けた原稿の節はありません。"
                canEdit={canEditLinks}
                itemId={row.item.id}
                itemCode={row.item.code}
              />
              <LinkedContentList
                title="SSBJ の要求事項"
                entries={links.requirements}
                versionLabel={null}
                emptyText="対応付けた SSBJ の要求事項はありません。"
                canEdit={canEditLinks}
                itemId={row.item.id}
                itemCode={row.item.code}
              />

              {canEditLinks && hasLinkCandidates && (
                <FormSection
                  kind="optional"
                  title="対応付けを追加"
                  description="人が確かめて対応付けたものだけを、回答・AI の草案の材料にします。定性情報は確認済みの版、原稿は承認済みの版を使います。"
                >
                  <form action={addResponseLinkAction} className="space-y-2">
                    <input type="hidden" name="itemId" value={row.item.id} />
                    <Field label="対応付ける情報" id="response-link-target" required>
                      {(control) => (
                        <NativeSelect {...control} name="target" size="xs" defaultValue="">
                          <option value="" disabled>
                            選んでください
                          </option>
                          {canEditMetricMapping && links.candidates.metrics.length > 0 && (
                            <optgroup label="数値（指標）">
                              {links.candidates.metrics.map((c) => (
                                <option key={c.id} value={`metric:${c.id}`}>
                                  {c.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {links.candidates.narratives.length > 0 && (
                            <optgroup label="定性情報（確認済みの版）">
                              {links.candidates.narratives.map((c) => (
                                <option key={c.id} value={`narrative_record:${c.id}`}>
                                  {c.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {links.candidates.blocks.length > 0 && (
                            <optgroup label="承認済みの原稿">
                              {links.candidates.blocks.map((c) => (
                                <option key={c.id} value={`disclosure_block:${c.id}`}>
                                  {c.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {links.candidates.requirements.length > 0 && (
                            <optgroup label="SSBJ の要求事項">
                              {links.candidates.requirements.map((c) => (
                                <option key={c.id} value={`requirement_item:${c.id}`}>
                                  {c.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </NativeSelect>
                      )}
                    </Field>
                    <SubmitButton
                      variant="secondary"
                      size="xs"
                      icon={<Link2 aria-hidden="true" />}
                      pendingLabel="追加中…"
                    >
                      対応付けを追加
                    </SubmitButton>
                  </form>
                </FormSection>
              )}
            </div>
          </Section>

          <Section
            id="question-evidence"
            collapsible
            title={`根拠（${row.evidenceCount}）`}
            summary={
              links.evidence.hidden
                ? `紐付け済み ${row.evidenceCount} 件`
                : `紐付け済み ${links.evidence.linked.length} 件・候補 ${links.evidence.candidates.length} 件`
            }
          >
            {links.evidence.hidden ? (
              <p className="text-small text-ink-muted">
                根拠資料の閲覧権限が無いため、資料名は表示しません（紐付け済み {row.evidenceCount}{' '}
                件）。
              </p>
            ) : (
              <div className="space-y-2">
                {links.evidence.linked.length === 0 ? (
                  <p className="text-caption text-ink-muted">
                    この回答に紐付けた根拠はまだありません。
                  </p>
                ) : (
                  <ul className="divide-y divide-line" data-evidence-linked="">
                    {links.evidence.linked.map((e) => (
                      <li key={e.evidenceLinkId} className="flex items-center gap-1.5 py-1">
                        <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />
                        <span className="text-small text-ink">
                          {e.fileName}
                          {e.page !== null ? ` p.${e.page}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {links.evidence.candidates.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-small font-semibold text-ink">
                      対応付けた指標の承認済みデータの根拠（候補）
                    </h3>
                    {!row.response && (
                      <p className="text-caption text-ink-muted">
                        回答を保存すると、根拠を紐付けられます。
                      </p>
                    )}
                    <ul className="divide-y divide-line" data-evidence-candidates="">
                      {links.evidence.candidates.map((e) => (
                        <li
                          key={e.evidenceLinkId}
                          className="flex items-start justify-between gap-2 py-1"
                        >
                          <span className="text-small text-ink">
                            {e.fileName}
                            {e.page !== null ? ` p.${e.page}` : ''}
                            <span className="block text-caption text-ink-muted">
                              {e.metricName} の承認済みデータの根拠
                            </span>
                          </span>
                          {canWrite && row.response && isPeriodVersion && (
                            <ConfirmDialog
                              tier="irreversible"
                              title="この資料を回答の根拠として紐付けますか"
                              scope={`${row.item.code} の回答（${workspace.period.label}）← ${e.fileName}${
                                e.page !== null ? ` p.${e.page}` : ''
                              }`}
                              consequences={[
                                '回答の根拠の件数に数え、出力・保証側の確認で参照します。',
                                '紐付けは外せません（根拠の記録として残ります）。',
                              ]}
                              confirmLabel="紐付ける"
                              destructive={false}
                              action={linkResponseEvidenceAction}
                              fields={{
                                responseId: row.response.id,
                                evidenceLinkId: e.evidenceLinkId,
                                itemId: row.item.id,
                              }}
                              trigger={{
                                label: '根拠にする…',
                                size: 'xs',
                                actionId: `link-evidence-${e.evidenceLinkId}`,
                              }}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
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
