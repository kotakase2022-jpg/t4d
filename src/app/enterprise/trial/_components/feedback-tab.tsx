import Link from 'next/link';
import { ClipboardPen } from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  FEEDBACK_CHANNEL_LABELS,
  VERIFICATION_RESULT_LABELS,
  VERIFICATION_RESULTS,
  verificationLabel,
  type OpenIssueSummary,
} from '@/lib/domain/trial-metrics';
import {
  SEPARATE_CONSULTATION_KINDS,
  SEPARATE_CONSULTATION_LABELS,
} from '@/lib/domain/trial-scope';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import type { FeedbackListRow, FeedbackOverview } from '@/lib/services/trial-feedback';
import type { TrialTextLimits } from '@/lib/services/trial-program';
import { statusLabel, statusOptions } from '@/lib/ui/status/registry';
import { FEEDBACK_CHANNELS, type TrialScenario } from '@/types/domain';
import {
  recordMeetingFeedbackAction,
  recordReverificationAction,
  triageFeedbackAction,
} from '../actions';
import { TRIAL_BASE, trialHref } from '../_lib/tabs';

type Params = Record<string, string | string[] | undefined>;

const linkClass = 'text-small text-brand-700 hover:underline';

/**
 * 改善管理表（NF-34）: 不具合・要望・質問・良かった点と、定例会などの論点を同じ表で管理する。
 * 見出しに「必須要件 × 重大 × 未解決」の件数（本導入の条件）を常に出す。
 * 投稿は誰でも（ご意見・不具合のダイアログ）、対応の記録・再検証・定例会の論点は管理者だけ。
 */
export function FeedbackTab({
  overview,
  scenarios,
  params,
  canManage,
  limits,
  build,
}: {
  overview: FeedbackOverview;
  scenarios: TrialScenario[];
  params: Params;
  canManage: boolean;
  limits: TrialTextLimits;
  build: string;
}) {
  const { summary } = overview;
  const kind = typeof params.kind === 'string' ? params.kind : null;
  const status = typeof params.status === 'string' ? params.status : null;
  const severity = typeof params.severity === 'string' ? params.severity : null;
  const cost = typeof params.cost === 'string' ? params.cost : null;
  const scopeKind = typeof params.scope === 'string' ? params.scope : null;
  const channel = typeof params.channel === 'string' ? params.channel : null;
  const mandatory = params.mandatory === 'yes';
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const rows = overview.items
    .filter((item) => (kind ? item.kind === kind : true))
    .filter((item) => (status ? item.status === status : true))
    .filter((item) => (severity ? item.severity === severity : true))
    .filter((item) => (cost ? item.costClass === cost : true))
    .filter((item) => (scopeKind ? item.scopeKind === scopeKind : true))
    .filter((item) => (channel ? item.channel === channel : true))
    .filter((item) => (mandatory ? item.mandatoryRequirement : true))
    .filter((item) =>
      query === '' ? true : `${item.title} ${item.body}`.toLowerCase().includes(query),
    );
  const triageId = params.triage === '1' && typeof params.item === 'string' ? params.item : null;
  const triageItem = triageId ? overview.items.find((item) => item.id === triageId) : undefined;

  const columns: DataTableColumn<FeedbackListRow>[] = [
    {
      key: 'title',
      header: '件名',
      importance: 'primary',
      lockVisible: true,
      cell: (item) => <span className="text-small font-medium">{item.title}</span>,
    },
    {
      key: 'kind',
      header: '種類',
      importance: 'primary',
      cell: (item) => <StatusBadge domain="feedbackKind" value={item.kind} />,
    },
    {
      key: 'severity',
      header: '重大度',
      importance: 'primary',
      cell: (item) =>
        item.severity ? <StatusBadge domain="severity" value={item.severity} /> : '—',
    },
    {
      key: 'mandatory',
      header: '必須要件',
      importance: 'secondary',
      cell: (item) =>
        item.mandatoryRequirement ? <SemanticBadge semantic="blocked" label="必須" /> : '—',
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (item) => <StatusBadge domain="feedbackStatus" value={item.status} />,
    },
    {
      key: 'policy',
      header: '対応方針',
      importance: 'secondary',
      cell: (item) => <span className="text-small">{item.responsePolicy || '—'}</span>,
    },
    {
      key: 'owner',
      header: '担当',
      importance: 'secondary',
      cell: (item) => <span className="text-small">{item.ownerLabel || '—'}</span>,
    },
    {
      key: 'due',
      header: '期限',
      importance: 'secondary',
      cell: (item) => (
        <span className="text-small">{item.dueOn ? formatJstDate(item.dueOn) : '—'}</span>
      ),
    },
    {
      key: 'cost',
      header: '費用区分',
      importance: 'secondary',
      cell: (item) => <StatusBadge domain="costClass" value={item.costClass} />,
    },
    {
      key: 'scopeKind',
      header: '別途協議の区分',
      importance: 'secondary',
      cell: (item) => (
        <span className="text-small">
          {item.scopeKind
            ? SEPARATE_CONSULTATION_LABELS[item.scopeKind]
            : item.costClass === 'separate_estimate'
              ? '区分なし'
              : '—'}
        </span>
      ),
    },
    {
      key: 'version',
      header: '反映した版',
      importance: 'detail',
      cell: (item) => <span className="text-caption">{item.resolvedInVersion || '—'}</span>,
    },
    {
      key: 'verification',
      header: '再検証',
      importance: 'detail',
      cell: (item) => (
        <span className="text-small">{verificationLabel(item.verificationResult)}</span>
      ),
    },
    {
      key: 'channel',
      header: '経路',
      importance: 'detail',
      cell: (item) => <span className="text-small">{FEEDBACK_CHANNEL_LABELS[item.channel]}</span>,
    },
    {
      key: 'created',
      header: '登録',
      importance: 'detail',
      cell: (item) => <span className="text-caption">{formatJst(item.createdAt)}</span>,
    },
  ];

  return (
    <div className="space-y-3">
      {canManage && params.new === '1' && (
        <CreatePanel
          id="trial-meeting-panel"
          title="定例会などの論点を記録"
          searchParams={params}
          closeHref={createPanelHref(TRIAL_BASE, params, { open: false })}
          description="定例会・メール・電話で受けた論点や決定を、改善管理表に同じ形で登録します。"
        >
          <MeetingForm scenarios={scenarios} limits={limits} />
        </CreatePanel>
      )}
      {canManage && triageItem && (
        <CreatePanel
          id="trial-triage-panel"
          title={`対応を記録: ${triageItem.title}`}
          openParam="triage"
          searchParams={params}
          closeHref={createPanelHref(TRIAL_BASE, { tab: 'feedback' }, { open: false })}
          description="投稿の内容（種類・件名・本文・画面）は変えません。変更の履歴は監査ログに残ります。"
        >
          <TriageForms item={triageItem} limits={limits} build={build} />
        </CreatePanel>
      )}

      <MetricStrip label="改善管理表の集計">
        <MetricTile
          label="必須要件 × 重大 × 未解決"
          value={summary.mandatoryCriticalOpen}
          unit="件"
          status={
            summary.mandatoryCriticalOpen > 0
              ? { semantic: 'error', label: '本導入の条件を満たしていません' }
              : { semantic: 'done', label: '0 件（本導入の条件）' }
          }
          href={trialHref('feedback', { mandatory: 'yes', severity: 'critical' })}
        />
        <MetricTile
          label="未解決の課題"
          value={summary.unresolved}
          unit="件"
          hint={`全 ${summary.total} 件（良かった点を除く未解決）`}
        />
        <MetricTile
          label="良かった点"
          value={summary.positive}
          unit="件"
          href={trialHref('feedback', { kind: 'positive' })}
        />
        <MetricTile
          label="AI に関する意見"
          value={overview.aiOpinions.length}
          unit="件"
          hint="AI の候補を採用しなかった理由"
        />
        <MetricTile
          label="別途協議"
          value={summary.byCostClass.separate_estimate}
          unit="件"
          hint={separateHint(summary.separateByScopeKind)}
          href={trialHref('feedback', { cost: 'separate_estimate' })}
        />
      </MetricStrip>

      <Section
        title={`改善管理表（必須要件 × 重大 × 未解決 ${summary.mandatoryCriticalOpen} 件）`}
        divider="none"
      >
        <DataTable<FeedbackListRow>
          id="trial-feedback"
          caption="改善管理表"
          columns={columns}
          rows={rows}
          getRowId={(item) => item.id}
          getRowLabel={(item) => item.title}
          getRowStatus={(item) => statusLabel('feedbackStatus', item.status)}
          searchParams={params}
          basePath={TRIAL_BASE}
          search={{ placeholder: '件名・内容で検索' }}
          filters={[
            { key: 'kind', label: '種類', options: statusOptions('feedbackKind') },
            { key: 'status', label: '状態', options: statusOptions('feedbackStatus') },
          ]}
          overflowFilters={[
            { key: 'severity', label: '重大度', options: statusOptions('severity') },
            { key: 'cost', label: '費用区分', options: statusOptions('costClass') },
            {
              key: 'scope',
              label: '別途協議の区分',
              options: SEPARATE_CONSULTATION_KINDS.map((value) => ({
                value,
                label: SEPARATE_CONSULTATION_LABELS[value],
              })),
            },
            {
              key: 'channel',
              label: '経路',
              options: FEEDBACK_CHANNELS.map((value) => ({
                value,
                label: FEEDBACK_CHANNEL_LABELS[value],
              })),
            },
            { key: 'mandatory', label: '必須要件', options: [{ value: 'yes', label: '必須' }] },
          ]}
          rowActions={(item) =>
            canManage
              ? {
                  rowLabel: item.title,
                  primary: {
                    kind: 'link',
                    id: `triage-${item.id}`,
                    label: '対応を記録',
                    icon: <ClipboardPen aria-hidden="true" />,
                    href: trialHref('feedback', { triage: '1', item: item.id }),
                  },
                }
              : null
          }
          expand={(item) => <FeedbackDetail item={item} />}
          empty={{
            noData: {
              title: '改善管理表はまだ空です',
              description: '「ご意見・不具合」から、組織のメンバーなら誰でも送れます。',
              action: (
                <Link href={trialHref('scenarios')} className={linkClass}>
                  検証シナリオを見る
                </Link>
              ),
            },
          }}
        />
      </Section>

      <Section
        id="trial-ai-opinions"
        title={`AI に関する意見（${overview.aiOpinions.length}）`}
        summary="AI の候補を採用しなかったときの理由（任意で書かれたもの）"
        collapsible
        defaultOpen={false}
      >
        {overview.aiOpinions.length === 0 ? (
          <p className="text-small text-ink-muted">
            まだありません。AI の候補を採用しないときに理由を書くと、ここに集まります。
          </p>
        ) : (
          <ul className="space-y-1">
            {overview.aiOpinions.map((opinion) => (
              <li key={opinion.id} className="text-small">
                <span className="mr-1.5 text-caption text-ink-muted">
                  {formatJst(opinion.createdAt)}
                </span>
                {opinion.comment}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** 別途協議のタイルの補足（区分ごとの件数。区分の無いものは「区分なし」） */
function separateHint(counts: OpenIssueSummary['separateByScopeKind']): string {
  const parts = SEPARATE_CONSULTATION_KINDS.flatMap((kind) =>
    counts[kind] > 0 ? [`${SEPARATE_CONSULTATION_LABELS[kind]} ${counts[kind]}`] : [],
  );
  if (counts.unclassified > 0) parts.push(`区分なし ${counts.unclassified}`);
  return parts.length > 0 ? parts.join('・') : '標準の範囲の外と判断した要望・論点';
}

function FeedbackDetail({ item }: { item: FeedbackListRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-1 text-small">
      <dt className="text-ink-muted">内容</dt>
      <dd className="whitespace-pre-wrap">{item.body || '—'}</dd>
      <dt className="text-ink-muted">画面</dt>
      <dd>{item.routePattern || '—'}</dd>
      <dt className="text-ink-muted">経路</dt>
      <dd>{FEEDBACK_CHANNEL_LABELS[item.channel]}</dd>
      <dt className="text-ink-muted">関連シナリオ</dt>
      <dd>{item.scenarioCode ?? '—'}</dd>
      <dt className="text-ink-muted">別途協議の区分</dt>
      <dd>{item.scopeKind ? SEPARATE_CONSULTATION_LABELS[item.scopeKind] : '—'}</dd>
      <dt className="text-ink-muted">登録時の環境の版</dt>
      <dd>{item.environmentVersion || '—'}</dd>
      <dt className="text-ink-muted">再検証</dt>
      <dd>
        {verificationLabel(item.verificationResult)}
        {item.verifiedAt && `（${formatJst(item.verifiedAt)}）`}
      </dd>
      <dt className="text-ink-muted">合意</dt>
      <dd>{item.agreed ? '合意済み' : '未合意'}</dd>
    </dl>
  );
}

function MeetingForm({
  scenarios,
  limits,
}: {
  scenarios: TrialScenario[];
  limits: TrialTextLimits;
}) {
  return (
    <PreservingForm action={recordMeetingFeedbackAction} className="space-y-3 p-3">
      <FormSection title="論点" kind="required">
        <div className="grid grid-cols-12 gap-2">
          <Field label="経路" id="trial-meeting-channel" required className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="channel" defaultValue="meeting">
                {FEEDBACK_CHANNELS.filter((c) => c !== 'in_app').map((value) => (
                  <option key={value} value={value}>
                    {FEEDBACK_CHANNEL_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="種類" id="trial-meeting-kind" required className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="kind" defaultValue="request">
                {statusOptions('feedbackKind').map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="件名"
            id="trial-meeting-title"
            required
            hint={`${limits.title} 字以内`}
            className="col-span-6"
          >
            {(p) => <Input {...p} name="title" maxLength={limits.title} />}
          </Field>
        </div>
      </FormSection>
      <FormSection title="詳細" kind="optional">
        <Field label="内容・決定" id="trial-meeting-body" hint={`${limits.text} 字以内`}>
          {(p) => <Textarea {...p} name="body" rows={2} maxLength={limits.text} />}
        </Field>
        <div className="grid grid-cols-12 items-end gap-2">
          <Field label="重大度（不具合のとき）" id="trial-meeting-severity" className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="severity" defaultValue="">
                <option value="">未選択</option>
                {statusOptions('severity').map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="関連するシナリオ" id="trial-meeting-scenario" className="col-span-5">
            {(p) => (
              <NativeSelect {...p} name="scenarioId" defaultValue="">
                <option value="">指定しない</option>
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.code} {scenario.title}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="col-span-4 pb-1">
            <NativeCheckbox name="mandatoryRequirement" label="必須要件に関わる" />
          </div>
        </div>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="登録中…">
        論点を登録
      </SubmitButton>
    </PreservingForm>
  );
}

function TriageForms({
  item,
  limits,
  build,
}: {
  item: FeedbackListRow;
  limits: TrialTextLimits;
  build: string;
}) {
  return (
    <div className="space-y-3 p-3">
      <Notice tone="info">
        {statusLabel('feedbackKind', item.kind)}: {item.body || item.title}
      </Notice>
      <PreservingForm action={triageFeedbackAction} className="space-y-3">
        <input type="hidden" name="itemId" value={item.id} />
        <FormSection title="対応" kind="required">
          <div className="grid grid-cols-12 gap-2">
            <Field label="状態" id="trial-triage-status" required className="col-span-4">
              {(p) => (
                <NativeSelect {...p} name="status" defaultValue={item.status}>
                  {statusOptions('feedbackStatus').map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="費用区分" id="trial-triage-cost" required className="col-span-4">
              {(p) => (
                <NativeSelect {...p} name="costClass" defaultValue={item.costClass}>
                  {statusOptions('costClass').map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field
              label="別途協議の区分"
              id="trial-triage-scope-kind"
              hint="費用区分が「別途協議」のときは必須。それ以外では選べません"
              className="col-span-4"
            >
              {(p) => (
                <NativeSelect {...p} name="scopeKind" defaultValue={item.scopeKind ?? ''}>
                  <option value="">選ばない</option>
                  {SEPARATE_CONSULTATION_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {SEPARATE_CONSULTATION_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {item.kind === 'defect' && (
              <Field label="重大度" id="trial-triage-severity" className="col-span-4">
                {(p) => (
                  <NativeSelect {...p} name="severity" defaultValue={item.severity ?? ''}>
                    <option value="">未選択</option>
                    {statusOptions('severity').map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            )}
          </div>
        </FormSection>
        <FormSection
          title="方針・担当・期限・合意"
          kind="optional"
          open={Boolean(item.responsePolicy || item.ownerLabel || item.dueOn || item.agreed)}
        >
          <Field label="対応方針" id="trial-triage-policy" hint={`${limits.text} 字以内`}>
            {(p) => (
              <Textarea
                {...p}
                name="responsePolicy"
                rows={2}
                maxLength={limits.text}
                defaultValue={item.responsePolicy}
              />
            )}
          </Field>
          <div className="grid grid-cols-12 items-end gap-2">
            <Field label="担当" id="trial-triage-owner" className="col-span-4">
              {(p) => (
                <Input
                  {...p}
                  name="ownerLabel"
                  maxLength={limits.title}
                  defaultValue={item.ownerLabel}
                />
              )}
            </Field>
            <Field label="期限" id="trial-triage-due" className="col-span-3">
              {(p) => <Input {...p} name="dueOn" type="date" defaultValue={item.dueOn ?? ''} />}
            </Field>
            <Field
              label="反映した版"
              id="trial-triage-version"
              hint={`この環境: ${build}`}
              className="col-span-5"
            >
              {(p) => (
                <Input
                  {...p}
                  name="resolvedInVersion"
                  maxLength={limits.title}
                  defaultValue={item.resolvedInVersion}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <NativeCheckbox
              name="mandatoryRequirement"
              label="必須要件に関わる"
              defaultChecked={item.mandatoryRequirement}
            />
            <NativeCheckbox
              name="agreed"
              label="対応方針・担当・期限・費用を合意した"
              defaultChecked={item.agreed}
            />
          </div>
        </FormSection>
        <SubmitButton variant="primary" size="sm" pendingLabel="保存中…">
          対応を保存
        </SubmitButton>
      </PreservingForm>

      <PreservingForm
        action={recordReverificationAction}
        className="space-y-2 border-t border-line pt-3"
        aria-label="再検証の結果"
      >
        <input type="hidden" name="itemId" value={item.id} />
        <p className="text-small font-medium text-ink">再検証の結果</p>
        <div className="grid grid-cols-12 items-end gap-2">
          <Field label="結果" id="trial-reverify-result" required className="col-span-5">
            {(p) => (
              <NativeSelect {...p} name="result" defaultValue="">
                <option value="" disabled>
                  選んでください
                </option>
                {VERIFICATION_RESULTS.map((value) => (
                  <option key={value} value={value}>
                    {VERIFICATION_RESULT_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="再検証した版"
            id="trial-reverify-version"
            hint="空欄は反映した版（無ければこの環境の版）"
            className="col-span-4"
          >
            {(p) => <Input {...p} name="version" maxLength={limits.title} />}
          </Field>
          <div className="col-span-3 pb-0.5">
            <SubmitButton variant="secondary" size="sm" pendingLabel="記録中…">
              再検証を記録
            </SubmitButton>
          </div>
        </div>
      </PreservingForm>
    </div>
  );
}
