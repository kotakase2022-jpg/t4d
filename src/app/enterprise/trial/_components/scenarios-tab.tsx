import Link from 'next/link';
import { ClipboardCheck, Gavel, PlayCircle } from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatRatePercent, TRIAL_THEME_LABELS } from '@/lib/domain/trial-metrics';
import { formatJst } from '@/lib/format/datetime';
import type {
  BusinessCompletion,
  MeasuredCandidates,
  ScenarioRow,
  ScenarioSummary,
} from '@/lib/services/trial-evaluation';
import type { TrialTextLimits } from '@/lib/services/trial-program';
import { statusLabel, statusOptions } from '@/lib/ui/status/registry';
import { TRIAL_THEMES } from '@/types/domain';
import { judgeScenarioAction, recordScenarioRunAction } from '../actions';
import { TRIAL_BASE, trialHref } from '../_lib/tabs';

type Params = Record<string, string | string[] | undefined>;

const COMPLETION_OPTIONS = statusOptions('trialCompletion');
const JUDGEMENT_OPTIONS = statusOptions('trialJudgement').filter((o) => o.value !== 'not_judged');

/**
 * シナリオ（NF-33）: 検証シナリオごとの実施数・自力完遂率（n 併記）・問い合わせ・判定。
 * 実施の記録は組織メンバー本人（作成の欄）。判定は管理者が確認ダイアログで記録する（追記で残り取り消せない）。
 * 測定値の候補（追跡率・不一致件数・未判定件数）はアプリが出すが、判定は人が決める。
 * 業務の完遂状況は既存の業務記録から算出する（操作は自動で追跡しない）。
 */
export function ScenariosTab({
  summary,
  business,
  candidates,
  params,
  canManage,
  limits,
  viewerId,
}: {
  summary: ScenarioSummary;
  business: BusinessCompletion;
  candidates: MeasuredCandidates | null;
  params: Params;
  canManage: boolean;
  limits: TrialTextLimits;
  /** 訂正できるのは自分の記録だけ */
  viewerId: string;
}) {
  const scenarioParam = typeof params.scenario === 'string' ? params.scenario : '';
  const supersedesParam = typeof params.supersedes === 'string' ? params.supersedes : '';
  const theme = typeof params.theme === 'string' ? params.theme : null;
  const judgement = typeof params.judgement === 'string' ? params.judgement : null;
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const rows = summary.rows
    .filter((row) => (theme ? row.scenario.theme === theme : true))
    .filter((row) => (judgement ? row.state === judgement : true))
    .filter((row) =>
      query === ''
        ? true
        : `${row.scenario.code} ${row.scenario.title}`.toLowerCase().includes(query),
    );

  const columns: DataTableColumn<ScenarioRow>[] = [
    {
      key: 'code',
      header: 'コード',
      importance: 'primary',
      lockVisible: true,
      width: 'xs',
      cell: (row) => <span className="font-medium">{row.scenario.code}</span>,
    },
    {
      key: 'theme',
      header: 'テーマ',
      importance: 'primary',
      cell: (row) => <span className="text-small">{TRIAL_THEME_LABELS[row.scenario.theme]}</span>,
    },
    {
      key: 'title',
      header: 'シナリオ',
      importance: 'primary',
      cell: (row) => <span className="text-small">{row.scenario.title}</span>,
    },
    {
      key: 'role',
      header: '対象役割',
      importance: 'secondary',
      cell: (row) => <span className="text-small">{row.scenario.targetRole || '—'}</span>,
    },
    {
      key: 'criterion',
      header: '判定の目安',
      importance: 'secondary',
      cell: (row) => <span className="text-small">{row.scenario.acceptanceCriterion || '—'}</span>,
    },
    {
      key: 'runs',
      header: '実施数',
      importance: 'primary',
      align: 'right',
      cell: (row) => <span className="tnum">{row.effectiveRunCount}</span>,
    },
    {
      key: 'completion',
      header: '自力完遂率（n）',
      importance: 'primary',
      cell: (row) => <span className="text-small">{row.completion.label}</span>,
    },
    {
      key: 'inquiry',
      header: '問い合わせ（1 実施あたり）',
      importance: 'secondary',
      cell: (row) => <span className="text-small">{row.inquiry.label}</span>,
    },
    {
      key: 'judgement',
      header: '判定',
      importance: 'primary',
      cell: (row) => (
        <span className="inline-flex flex-col items-start gap-0.5">
          <StatusBadge domain="trialJudgement" value={row.state} />
          {row.latest?.measuredValue && (
            <span className="text-caption text-ink-muted">{row.latest.measuredValue}</span>
          )}
        </span>
      ),
    },
    {
      key: 'steps',
      header: '手順',
      importance: 'detail',
      cell: (row) => <span className="text-small">{row.scenario.steps || '—'}</span>,
    },
  ];

  const panelOpen = params.new === '1';
  return (
    <div className="space-y-3">
      {panelOpen && (
        <CreatePanel
          id="trial-run-panel"
          title={supersedesParam ? '実施の記録を訂正' : 'シナリオを実施して記録'}
          searchParams={params}
          closeHref={createPanelHref(
            TRIAL_BASE,
            { ...params, scenario: undefined, supersedes: undefined },
            { open: false },
          )}
          description="あなたの名義で記録します（訂正は新しい記録で行い、前の記録は残ります）。環境の版を自動で添えます。"
        >
          <RunForm
            summary={summary}
            scenarioId={scenarioParam}
            supersedesRunId={supersedesParam}
            limits={limits}
          />
        </CreatePanel>
      )}

      <MetricStrip label="シナリオの集計">
        <MetricTile
          label="合格率（判定済み）"
          value={summary.pass.rate === null ? '—' : formatRatePercent(summary.pass.rate)}
          hint={`${summary.pass.label}・未判定 ${summary.pass.notJudged} 件は分母に入れません`}
        />
        <MetricTile
          label="自力完遂率（全シナリオ）"
          value={
            summary.completion.rate === null ? '—' : formatRatePercent(summary.completion.rate)
          }
          hint={summary.completion.label}
        />
        <MetricTile
          label="問い合わせ（1 実施あたり）"
          value={summary.inquiry.perRun === null ? '—' : summary.inquiry.perRun.toFixed(1)}
          unit="回"
          hint={summary.inquiry.label}
        />
        <MetricTile
          label="実施数"
          value={summary.runCount}
          hint="訂正された記録を除く。件数が 3 件未満の率は出しません"
        />
      </MetricStrip>

      <Section title={`検証シナリオ（${summary.rows.length}）`} divider="none">
        <DataTable<ScenarioRow>
          id="trial-scenarios"
          caption="検証シナリオ"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.scenario.id}
          getRowLabel={(row) => `${row.scenario.code} ${row.scenario.title}`}
          getRowStatus={(row) => statusLabel('trialJudgement', row.state)}
          searchParams={params}
          basePath={TRIAL_BASE}
          search={{ placeholder: 'コード・シナリオ名で検索' }}
          filters={[
            {
              key: 'theme',
              label: 'テーマ',
              options: TRIAL_THEMES.map((value) => ({ value, label: TRIAL_THEME_LABELS[value] })),
            },
            {
              key: 'judgement',
              label: '判定',
              options: statusOptions('trialJudgement'),
            },
          ]}
          rowActions={(row) => ({
            rowLabel: `${row.scenario.code} ${row.scenario.title}`,
            primary: {
              kind: 'link',
              id: `run-${row.scenario.id}`,
              label: '実施を記録',
              icon: <PlayCircle aria-hidden="true" />,
              href: trialHref('scenarios', { new: '1', scenario: row.scenario.id }),
            },
            items: [
              {
                kind: 'confirm',
                id: `judge-${row.scenario.id}`,
                label: '判定を記録…',
                icon: <Gavel aria-hidden="true" />,
                hidden: !canManage,
                action: judgeScenarioAction,
                fields: { scenarioId: row.scenario.id },
                confirm: {
                  tier: 'irreversible',
                  destructive: false,
                  title: 'このシナリオの判定を記録しますか',
                  scope: `${row.scenario.code} ${row.scenario.title}（判定の目安: ${row.scenario.acceptanceCriterion || '未設定'}）`,
                  consequences: [
                    '判定は追記で残り、取り消せません。判定を変えるときは新しい判定を記録します（最新の判定を表示します）。',
                    '測定値の候補はアプリが出したものです。判定は評価者が決めます。',
                  ],
                  extraFields: (
                    <JudgementFields
                      row={row}
                      candidate={candidates?.[row.scenario.theme] ?? null}
                    />
                  ),
                  reason: {
                    name: 'reason',
                    label: '判定の理由',
                    required: true,
                    maxLength: limits.text,
                  },
                  confirmLabel: '判定を記録',
                },
              },
            ],
          })}
          expand={(row) => <ScenarioDetail row={row} viewerId={viewerId} />}
          empty={{
            noData: {
              title: '検証シナリオがありません',
              description:
                'シナリオは運営（導入支援）が用意します。改善管理表から要望として送れます。',
              action: (
                <Link
                  href={trialHref('feedback')}
                  className="text-small text-brand-700 hover:underline"
                >
                  改善管理表を開く
                </Link>
              ),
            },
          }}
        />
      </Section>

      <Section
        title="業務の完遂状況（記録から算出）"
        summary="既存の業務記録から数えます。操作は自動で追跡していません"
        divider="top"
      >
        <MetricStrip label="業務の完遂状況">
          <MetricTile label="データ取込の確定率" value={business.ingestion.label} />
          <MetricTile label="標準 CSV の確定率" value={business.standardImport.label} />
          <MetricTile label="原稿の差戻し往復" value={business.review.label} />
          <MetricTile label="データの差戻し率（承認段階）" value={business.dataReturn.label} />
        </MetricStrip>
      </Section>
    </div>
  );
}

function JudgementFields({
  row,
  candidate,
}: {
  row: ScenarioRow;
  candidate: { value: string | null; source: string } | null;
}) {
  const base = `judge-${row.scenario.id}`;
  return (
    <div className="space-y-2">
      <Field label="判定" id={`${base}-judgement`} required>
        {(p) => (
          <NativeSelect {...p} name="judgement" defaultValue="">
            <option value="" disabled>
              選んでください
            </option>
            {JUDGEMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field
        label="測定値"
        id={`${base}-measured`}
        hint={
          candidate
            ? `候補（自動）: ${candidate.value ?? 'なし'} — ${candidate.source}。判定は人が決めます。`
            : '例: 確認した 6 件中 6 件（60 字以内）'
        }
      >
        {(p) => (
          <Input {...p} name="measuredValue" maxLength={60} defaultValue={candidate?.value ?? ''} />
        )}
      </Field>
    </div>
  );
}

function ScenarioDetail({ row, viewerId }: { row: ScenarioRow; viewerId: string }) {
  return (
    <div className="space-y-2 py-1">
      <p className="text-small text-ink">
        <span className="font-medium">手順: </span>
        {row.scenario.steps || '—'}
      </p>
      {row.runs.length === 0 ? (
        <p className="text-small text-ink-muted">実施の記録はまだありません。</p>
      ) : (
        <Table>
          <caption className="sr-only">{row.scenario.code} の実施記録</caption>
          <THead>
            <TR>
              <TH>実施日時</TH>
              <TH>実施者（役割）</TH>
              <TH>完了の区分</TH>
              <TH align="right">所要分</TH>
              <TH align="right">問い合わせ</TH>
              <TH align="right">分かりやすさ</TH>
              <TH>コメント・証跡</TH>
              <TH>環境の版</TH>
            </TR>
          </THead>
          <TBody>
            {row.runs.map((run) => (
              <TR key={run.id}>
                <TD className="whitespace-nowrap text-caption">
                  {formatJst(run.endedAt ?? run.createdAt)}
                </TD>
                <TD className="text-small">
                  {run.performerName}
                  {run.performedRole && (
                    <span className="text-ink-muted">（{run.performedRole}）</span>
                  )}
                </TD>
                <TD>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <StatusBadge domain="trialCompletion" value={run.completion} />
                    {run.superseded && <SemanticBadge semantic="excluded" label="訂正済み" />}
                  </span>
                </TD>
                <TD align="right" className="tnum">
                  {run.minutes ?? '—'}
                </TD>
                <TD align="right" className="tnum">
                  {run.helpCount}
                </TD>
                <TD align="right" className="tnum">
                  {run.easeRating === null ? '—' : `${run.easeRating} / 5`}
                </TD>
                <TD className="text-small">
                  {run.comment || '—'}
                  {typeof run.evidence.url === 'string' && run.evidence.url !== '' && (
                    <>
                      {' '}
                      <Link href={run.evidence.url} className="text-brand-700 hover:underline">
                        証跡を開く
                      </Link>
                    </>
                  )}
                </TD>
                <TD className="text-caption text-ink-muted">
                  {run.environmentVersion || '—'}
                  {!run.superseded && run.performedBy === viewerId && (
                    <>
                      {' '}
                      <Link
                        href={trialHref('scenarios', {
                          new: '1',
                          scenario: run.scenarioId,
                          supersedes: run.id,
                        })}
                        className="text-small text-brand-700 hover:underline"
                      >
                        訂正を記録
                      </Link>
                    </>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {row.judgements.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1 text-small font-medium text-ink">
            <ClipboardCheck className="size-3.5" aria-hidden="true" />
            判定の履歴（新しい順・取り消せない記録）
          </p>
          <ul className="space-y-1">
            {row.judgements.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-1.5 text-small">
                <span className="text-caption text-ink-muted">{formatJst(j.judgedAt)}</span>
                <StatusBadge domain="trialJudgement" value={j.judgement} />
                {j.measuredValue && <span className="text-ink-muted">{j.measuredValue}</span>}
                <span>{j.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RunForm({
  summary,
  scenarioId,
  supersedesRunId,
  limits,
}: {
  summary: ScenarioSummary;
  scenarioId: string;
  supersedesRunId: string;
  limits: TrialTextLimits;
}) {
  return (
    <PreservingForm action={recordScenarioRunAction} className="space-y-3 p-3">
      {supersedesRunId && <input type="hidden" name="supersedesRunId" value={supersedesRunId} />}
      <FormSection title="実施の結果" kind="required">
        <div className="grid grid-cols-12 gap-2">
          <Field label="シナリオ" id="trial-run-scenario" required className="col-span-6">
            {(p) => (
              <NativeSelect {...p} name="scenarioId" defaultValue={scenarioId}>
                <option value="" disabled>
                  選んでください
                </option>
                {summary.rows.map((row) => (
                  <option key={row.scenario.id} value={row.scenario.id}>
                    {row.scenario.code} {row.scenario.title}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="完了の区分" id="trial-run-completion" required className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="completion" defaultValue="">
                <option value="" disabled>
                  選んでください
                </option>
                {COMPLETION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="所要時間（分）" id="trial-run-minutes" className="col-span-2">
            {(p) => <Input {...p} name="minutes" type="number" min={0} max={1440} step={0.5} />}
          </Field>
          <Field
            label="問い合わせ回数"
            id="trial-run-help"
            hint="人に聞いた・資料を探した回数"
            className="col-span-3"
          >
            {(p) => (
              <Input {...p} name="helpCount" type="number" min={0} max={99} defaultValue={0} />
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="補足" kind="optional">
        <div className="grid grid-cols-12 gap-2">
          <Field label="分かりやすさ（1〜5）" id="trial-run-ease" className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="easeRating" defaultValue="">
                <option value="">未回答</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="証跡（画面のパス）"
            id="trial-run-evidence"
            hint="例: /enterprise/disclosure-projects（アプリ内のパスだけ）"
            className="col-span-9"
          >
            {(p) => <Input {...p} name="evidenceUrl" maxLength={200} />}
          </Field>
        </div>
        <Field label="コメント" id="trial-run-comment" hint={`${limits.text} 字以内`}>
          {(p) => <Textarea {...p} name="comment" rows={2} maxLength={limits.text} />}
        </Field>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="記録中…">
        実施を記録
      </SubmitButton>
    </PreservingForm>
  );
}
