import Link from 'next/link';
import { PencilLine, Target } from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Notice } from '@/components/shared/notice';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  reductionTargetLabel,
  TRIAL_MIN_SAMPLE,
  TRIAL_TASK_LABELS,
  TRIAL_TIMING_METHOD_LABELS,
  TRIAL_TIMING_MODE_LABELS,
  type TaskReduction,
  type TimingSide,
} from '@/lib/domain/trial-metrics';
import { formatJstDate, toJstDate } from '@/lib/format/datetime';
import type { TrialTextLimits } from '@/lib/services/trial-program';
import type { TimingRecordView, TimingSummary } from '@/lib/services/trial-timing';
import { TRIAL_TASK_KEYS, TRIAL_TIMING_METHODS, TRIAL_TIMING_MODES } from '@/types/domain';
import { recordTaskTimingAction } from '../actions';
import { TRIAL_BASE, trialHref } from '../_lib/tabs';

type Params = Record<string, string | string[] | undefined>;

function sideText(side: TimingSide): string {
  if (side.n === 0) return '記録なし';
  const median = side.median === null ? '—' : `${Math.round(side.median * 10) / 10} 分`;
  const methods = side.methods.map((m) => TRIAL_TIMING_METHOD_LABELS[m]).join('・');
  return `${median}（n=${side.n}・${methods}）`;
}

/**
 * 作業時間（NF-35）: 作業ごとに現行と T4D の 1 単位あたりの分（中央値）・件数・測り方・短縮率。
 * 両方 n ≥ 3 のときだけ短縮率を出す。目標は計画の値を結果とは別の行に出す（達成の判定はしない）。
 */
export function TimingTab({
  summary,
  params,
  limits,
  viewerId,
}: {
  summary: TimingSummary;
  params: Params;
  limits: TrialTextLimits;
  /** 訂正できるのは自分の記録だけ */
  viewerId: string;
}) {
  const supersedesId = typeof params.supersedes === 'string' ? params.supersedes : '';
  const correcting = supersedesId
    ? summary.records.find(
        (r) => r.id === supersedesId && !r.superseded && r.recordedBy === viewerId,
      )
    : undefined;
  const mode = typeof params.mode === 'string' ? params.mode : null;
  const task = typeof params.task === 'string' ? params.task : null;
  const records = summary.records
    .filter((r) => (mode ? r.mode === mode : true))
    .filter((r) => (task ? r.taskKey === task : true));
  const hasLogEstimate = summary.tasks.some(
    (t) => t.baseline.includesLogEstimate || t.t4d.includesLogEstimate,
  );

  const recordColumns: DataTableColumn<TimingRecordView>[] = [
    {
      key: 'measuredOn',
      header: '測定日',
      importance: 'primary',
      lockVisible: true,
      cell: (r) => (
        <span className="whitespace-nowrap text-small">{formatJstDate(r.measuredOn)}</span>
      ),
    },
    {
      key: 'task',
      header: '作業',
      importance: 'primary',
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1 text-small">
          {TRIAL_TASK_LABELS[r.taskKey]}
          {r.superseded && <SemanticBadge semantic="excluded" label="訂正済み（数えない）" />}
        </span>
      ),
    },
    {
      key: 'mode',
      header: '区分',
      importance: 'primary',
      cell: (r) => <span className="text-small">{TRIAL_TIMING_MODE_LABELS[r.mode]}</span>,
    },
    {
      key: 'minutes',
      header: '所要分',
      importance: 'primary',
      align: 'right',
      cell: (r) => (
        <span className="tnum">
          {r.minutes}
          {r.quantity !== 1 && (
            <span className="text-caption text-ink-muted">
              {' '}
              （{r.quantity} {r.unitLabel || '件'}）
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'perUnit',
      header: '1 単位あたり分',
      importance: 'secondary',
      align: 'right',
      cell: (r) => <span className="tnum">{Math.round(r.perUnitMinutes * 10) / 10}</span>,
    },
    {
      key: 'method',
      header: '測り方',
      importance: 'primary',
      cell: (r) => <span className="text-small">{TRIAL_TIMING_METHOD_LABELS[r.method]}</span>,
    },
    {
      key: 'department',
      header: '部署',
      importance: 'secondary',
      cell: (r) => <span className="text-small">{r.department || '—'}</span>,
    },
    {
      key: 'recorder',
      header: '記録者',
      importance: 'detail',
      cell: (r) => <span className="text-small">{r.recorderName}</span>,
    },
    {
      key: 'note',
      header: 'メモ',
      importance: 'detail',
      cell: (r) => <span className="text-small">{r.note || '—'}</span>,
    },
  ];

  return (
    <div className="space-y-3">
      {params.new === '1' && (
        <CreatePanel
          id="trial-timing-panel"
          title={correcting ? '作業時間の記録を訂正' : '作業時間を記録'}
          searchParams={params}
          closeHref={createPanelHref(
            TRIAL_BASE,
            { ...params, supersedes: undefined },
            { open: false },
          )}
          description={
            correcting
              ? '前の記録は残し、新しい記録で訂正します（前の記録は集計から外します）。'
              : 'あなたの名義で記録します（訂正は新しい記録で行います）。'
          }
        >
          <TimingForm correcting={correcting ?? null} limits={limits} />
        </CreatePanel>
      )}

      {/* 数え方の注記（結果の読み方に関わるため折りたたまない） */}
      <Notice tone="info">
        現行と T4D の両方が {TRIAL_MIN_SAMPLE}{' '}
        件以上の作業だけ短縮率を出します（中央値で比べます）。
        {hasLogEstimate && '「記録からの推定」は待ち時間を含む参考値です。'}
      </Notice>

      <Section
        title="作業ごとの比較（1 単位あたりの分の中央値）"
        divider="none"
        summary={
          <span className="inline-flex items-center gap-1">
            <Target className="size-3.5" aria-hidden="true" />
            {reductionTargetLabel(summary.target)}（目標。結果とは別に示します）
          </span>
        }
      >
        <div className="t4d-scroll-x rounded-t4d border border-line">
          <Table>
            <caption className="sr-only">作業ごとの比較</caption>
            <THead>
              <TR>
                <TH>作業</TH>
                <TH>現行</TH>
                <TH>T4D</TH>
                <TH>短縮率</TH>
              </TR>
            </THead>
            <TBody>
              {summary.tasks.map((row: TaskReduction) => (
                <TR key={row.taskKey} data-t4d-record="" data-task={row.taskKey}>
                  <TD className="font-medium">{TRIAL_TASK_LABELS[row.taskKey]}</TD>
                  <TD className="text-small">{sideText(row.baseline)}</TD>
                  <TD className="text-small">{sideText(row.t4d)}</TD>
                  <TD className="text-small">
                    {row.rate === null ? (
                      <span className="text-ink-muted">{row.label}</span>
                    ) : (
                      <span className="font-medium">{row.label}</span>
                    )}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD className="text-small text-ink-muted">目標（参考）</TD>
                <TD colSpan={3} className="text-small text-ink-muted">
                  {reductionTargetLabel(summary.target)}
                  {!summary.target && '（計画の「短縮の目標」で設定します）'}
                </TD>
              </TR>
            </TBody>
          </Table>
        </div>
      </Section>

      <Section title={`作業時間の記録（${summary.records.length}）`} divider="top">
        <DataTable<TimingRecordView>
          id="trial-timing-records"
          caption="作業時間の記録"
          columns={recordColumns}
          rows={records}
          getRowId={(r) => r.id}
          getRowLabel={(r) =>
            `${formatJstDate(r.measuredOn)} ${TRIAL_TASK_LABELS[r.taskKey]}（${TRIAL_TIMING_MODE_LABELS[r.mode]}）`
          }
          searchParams={params}
          basePath={TRIAL_BASE}
          search={false}
          filters={[
            {
              key: 'task',
              label: '作業',
              options: TRIAL_TASK_KEYS.map((value) => ({ value, label: TRIAL_TASK_LABELS[value] })),
            },
            {
              key: 'mode',
              label: '区分',
              options: TRIAL_TIMING_MODES.map((value) => ({
                value,
                label: TRIAL_TIMING_MODE_LABELS[value],
              })),
            },
          ]}
          rowActions={(r) =>
            r.superseded || r.recordedBy !== viewerId
              ? null
              : {
                  rowLabel: `${formatJstDate(r.measuredOn)} ${TRIAL_TASK_LABELS[r.taskKey]}`,
                  items: [
                    {
                      kind: 'link',
                      id: `correct-${r.id}`,
                      label: '訂正を記録',
                      icon: <PencilLine aria-hidden="true" />,
                      href: trialHref('timing', { new: '1', supersedes: r.id }),
                    },
                  ],
                }
          }
          empty={{
            noData: {
              title: '作業時間の記録はまだありません',
              description: '同じ作業を現行の方法と T4D で行い、それぞれ記録します。',
              action: (
                <Link
                  href={trialHref('timing', { new: '1' })}
                  className="text-small text-brand-700 hover:underline"
                >
                  作業時間を記録
                </Link>
              ),
            },
          }}
        />
      </Section>
    </div>
  );
}

function TimingForm({
  correcting,
  limits,
}: {
  correcting: TimingRecordView | null;
  limits: TrialTextLimits;
}) {
  const today = toJstDate(new Date().toISOString());
  return (
    <PreservingForm action={recordTaskTimingAction} className="space-y-3 p-3">
      {correcting && <input type="hidden" name="supersedesId" value={correcting.id} />}
      <FormSection title="測定" kind="required">
        <div className="grid grid-cols-12 gap-2">
          <Field label="作業" id="trial-timing-task" required className="col-span-4">
            {(p) => (
              <NativeSelect {...p} name="taskKey" defaultValue={correcting?.taskKey ?? ''}>
                <option value="" disabled>
                  選んでください
                </option>
                {TRIAL_TASK_KEYS.map((value) => (
                  <option key={value} value={value}>
                    {TRIAL_TASK_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="区分" id="trial-timing-mode" required className="col-span-2">
            {(p) => (
              <NativeSelect {...p} name="mode" defaultValue={correcting?.mode ?? 'baseline'}>
                {TRIAL_TIMING_MODES.map((value) => (
                  <option key={value} value={value}>
                    {TRIAL_TIMING_MODE_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="測り方" id="trial-timing-method" required className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="method" defaultValue={correcting?.method ?? 'self_report'}>
                {TRIAL_TIMING_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {TRIAL_TIMING_METHOD_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="所要時間（分）" id="trial-timing-minutes" required className="col-span-2">
            {(p) => (
              <Input
                {...p}
                name="minutes"
                type="number"
                min={0}
                step={0.5}
                defaultValue={correcting?.minutes ?? ''}
              />
            )}
          </Field>
          <Field label="測定日" id="trial-timing-date" required className="col-span-3">
            {(p) => (
              <Input
                {...p}
                name="measuredOn"
                type="date"
                defaultValue={correcting?.measuredOn ?? today}
              />
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="数量・部署・メモ" kind="optional" open={Boolean(correcting)}>
        <div className="grid grid-cols-12 gap-2">
          <Field
            label="数量"
            id="trial-timing-quantity"
            hint="空欄は 1。1 単位あたりの分で比べます"
            className="col-span-2"
          >
            {(p) => (
              <Input
                {...p}
                name="quantity"
                type="number"
                min={0}
                step="any"
                defaultValue={correcting?.quantity ?? ''}
              />
            )}
          </Field>
          <Field label="単位" id="trial-timing-unit" hint="例: 節・表" className="col-span-2">
            {(p) => (
              <Input
                {...p}
                name="unitLabel"
                maxLength={limits.title}
                defaultValue={correcting?.unitLabel ?? ''}
              />
            )}
          </Field>
          <Field label="部署" id="trial-timing-department" className="col-span-4">
            {(p) => (
              <Input
                {...p}
                name="department"
                maxLength={limits.title}
                defaultValue={correcting?.department ?? ''}
              />
            )}
          </Field>
        </div>
        <Field label="メモ" id="trial-timing-note" hint={`${limits.text} 字以内`}>
          {(p) => (
            <Textarea
              {...p}
              name="note"
              rows={2}
              maxLength={limits.text}
              defaultValue={correcting?.note ?? ''}
            />
          )}
        </Field>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="記録中…">
        {correcting ? '訂正を記録' : '作業時間を記録'}
      </SubmitButton>
    </PreservingForm>
  );
}
