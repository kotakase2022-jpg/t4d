'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, Loader2, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';
import { cn } from '@/lib/utils';
import type { ProjectFormState, ProjectFormValues } from '../actions';

/**
 * 開示プロジェクトの入力フォーム（新規作成は 3 段階、設定タブでは同じ項目を一度に編集）。
 *
 * - 詳細な法的条件は設定タブの基準ごとの欄で扱い、ここでは長い判定フォームを強制しない（§6.2）。
 * - 送信に失敗しても入力を保つ（送信した値をサーバーから受け取り直して初期値にする。A35）。
 * - 報告範囲の変更は、影響する原稿・数値・承認を見せてから保存する（§6.2）。
 */

export interface OptionItem {
  value: string;
  label: string;
  hint?: string;
}

export interface VersionOptionItem {
  versionId: string;
  label: string;
  legalLabel: string;
  coverageLabel: string | null;
  itemCount: number;
}

export interface ProjectFormProps {
  mode: 'create' | 'edit';
  action: (state: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;
  projectId?: string;
  initial: ProjectFormValues;
  /** rangeLabel は表示用（サーバー側で formatJstDate を通した開始日〜終了日） */
  periods: Array<{
    id: string;
    code: string;
    label: string;
    startDate: string;
    endDate: string;
    rangeLabel: string;
  }>;
  members: Array<{ userId: string; displayName: string; canApprove: boolean }>;
  units: Array<{ id: string; name: string }>;
  purposes: Array<{ value: string; label: string; frameworkLabel: string | null }>;
  versionOptions: Record<string, VersionOptionItem[]>;
  languages: OptionItem[];
  statuses?: OptionItem[];
  fieldLabels: Record<string, string>;
}

const INITIAL_STATE: ProjectFormState = {
  status: 'idle',
  message: null,
  fieldErrors: {},
  impact: null,
  changedFields: [],
  values: null,
};

/** 項目 → 段階（エラーのある段階へ戻すため）。Service の PROJECT_FIELD_STEP と同じ対応 */
const FIELD_STEP: Record<string, 1 | 2 | 3> = {
  name: 1,
  reportingEntity: 1,
  reportingPeriodId: 1,
  periodStart: 1,
  periodEnd: 1,
  currency: 1,
  ownerUserId: 1,
  dueDate: 1,
  status: 1,
  purposes: 2,
  frameworkVersions: 2,
  scopeOrgNote: 3,
  includedUnitIds: 3,
  languages: 3,
  reviewerUserId: 3,
  finalApproverUserId: 3,
};

const STEPS = [
  { no: 1 as const, title: '報告主体と期間' },
  { no: 2 as const, title: '対応する制度と基準' },
  { no: 3 as const, title: '報告範囲と承認' },
];

function one(values: ProjectFormValues, key: string): string {
  const v = values[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function many(values: ProjectFormValues, key: string): string[] {
  const v = values[key];
  return Array.isArray(v) ? v : v ? [v] : [];
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-0.5 flex items-center gap-1 text-[11px] text-danger">
      <AlertTriangle className="size-3" aria-hidden="true" />
      {message}
    </p>
  );
}

function Label({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink">
      {children}
      {required && <span className="ml-1 text-[11px] text-danger">（必須）</span>}
    </label>
  );
}

const selectClass =
  'mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 aria-[invalid=true]:border-danger';

/** 通信そのものが失敗したとき（接続断・502）。入力値を残してエラーとして返す */
function networkFailureState(_previous: ProjectFormState, formData: FormData): ProjectFormState {
  const values: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith('$ACTION')) continue;
    const all = formData.getAll(key).map((v) => (typeof v === 'string' ? v : ''));
    values[key] =
      all.length > 1 || ['purposes', 'languages', 'includedUnitIds'].includes(key)
        ? all
        : (all[0] ?? '');
  }
  return { ...INITIAL_STATE, status: 'error', message: NETWORK_ERROR_MESSAGE, values };
}

export function ProjectForm(props: ProjectFormProps) {
  const action = React.useMemo(
    () => withNetworkFallback(props.action, networkFailureState),
    [props.action],
  );
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const values = state.values ?? props.initial;
  const errors = state.fieldErrors;
  const isCreate = props.mode === 'create';
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const startRef = React.useRef<HTMLInputElement>(null);
  const endRef = React.useRef<HTMLInputElement>(null);
  const [selectedPurposes, setSelectedPurposes] = React.useState<string[]>(
    many(values, 'purposes'),
  );
  const statusRef = React.useRef<HTMLParagraphElement>(null);

  // サーバーの検証でエラーが返ったら、最初にエラーがある段階へ戻して読み上げる
  React.useEffect(() => {
    if (state.status === 'idle') return;
    const firstStep = Object.keys(state.fieldErrors)
      .map((key) => FIELD_STEP[key] ?? 1)
      .sort()[0];
    if (isCreate && firstStep) setStep(firstStep);
    if (state.values) setSelectedPurposes(many(state.values, 'purposes'));
    statusRef.current?.focus();
  }, [state, isCreate]);

  const describedBy = (key: string) => (errors[key] ? `err-${key}` : undefined);
  const invalid = (key: string) => (errors[key] ? true : undefined);
  const stepHidden = (no: 1 | 2 | 3) => isCreate && step !== no;
  // フォームを作り直して defaultValue を反映する（送信後に React がフォームを初期化するため）
  const formKey = JSON.stringify(state.values ?? null);

  return (
    <form key={formKey} action={formAction} className="space-y-3" noValidate>
      {props.projectId && <input type="hidden" name="projectId" value={props.projectId} />}

      {isCreate && (
        <ol className="flex flex-wrap items-center gap-2 text-[12px]" aria-label="作成の段階">
          {STEPS.map((s) => (
            <li key={s.no}>
              <button
                type="button"
                onClick={() => setStep(s.no)}
                aria-current={step === s.no ? 'step' : undefined}
                className={cn(
                  'rounded-t4d border px-2 py-1',
                  step === s.no
                    ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
                    : 'border-line bg-surface text-ink-muted',
                )}
              >
                {s.no}. {s.title}
                {Object.keys(errors).some((k) => (FIELD_STEP[k] ?? 1) === s.no) && (
                  <span className="ml-1 text-danger">（要確認）</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      <p
        ref={statusRef}
        tabIndex={-1}
        role={state.status === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        className={cn(
          'text-[12px]',
          state.message ? 'rounded-t4d border px-3 py-1.5' : 'sr-only',
          state.status === 'error' && 'border-danger/40 bg-danger-soft text-ink',
          state.status === 'needs_confirmation' && 'border-warning/40 bg-warning-soft text-ink',
          state.status === 'unchanged' && 'border-line bg-surface-muted text-ink',
        )}
      >
        {state.status === 'error' && (
          <AlertTriangle className="mr-1 inline size-3.5 text-danger" aria-hidden="true" />
        )}
        {state.message ?? ''}
      </p>

      {/* 段階 1: 報告主体と期間 */}
      <fieldset hidden={stepHidden(1)} className="space-y-2">
        <legend className="text-[13px] font-semibold text-ink">1. 報告主体と期間</legend>
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <Label htmlFor="pf-name" required>
              プロジェクト名
            </Label>
            <Input
              id="pf-name"
              name="name"
              defaultValue={one(values, 'name')}
              aria-invalid={invalid('name')}
              aria-describedby={describedBy('name')}
              className="mt-0.5"
            />
            <FieldError id="err-name" message={errors.name} />
          </div>
          <div>
            <Label htmlFor="pf-entity">報告主体（親会社・対象法人）</Label>
            <Input
              id="pf-entity"
              name="reportingEntity"
              defaultValue={one(values, 'reportingEntity')}
              placeholder="例: 株式会社○○及び連結子会社"
              className="mt-0.5"
            />
          </div>
          {isCreate ? (
            <div>
              <Label htmlFor="pf-period" required>
                報告期間
              </Label>
              <select
                id="pf-period"
                name="reportingPeriodId"
                defaultValue={one(values, 'reportingPeriodId')}
                aria-invalid={invalid('reportingPeriodId')}
                aria-describedby={describedBy('reportingPeriodId')}
                className={selectClass}
                onChange={(event) => {
                  const period = props.periods.find((p) => p.id === event.target.value);
                  if (period && startRef.current && endRef.current) {
                    startRef.current.value = period.startDate;
                    endRef.current.value = period.endDate;
                  }
                }}
              >
                <option value="">選択してください</option>
                {props.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}（{p.rangeLabel}）
                  </option>
                ))}
              </select>
              <FieldError id="err-reportingPeriodId" message={errors.reportingPeriodId} />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="pf-start" required>
                年度の開始日
              </Label>
              <Input
                ref={startRef}
                id="pf-start"
                name="periodStart"
                type="date"
                defaultValue={one(values, 'periodStart')}
                aria-invalid={invalid('periodStart')}
                aria-describedby={describedBy('periodStart')}
                className="mt-0.5"
              />
              <FieldError id="err-periodStart" message={errors.periodStart} />
            </div>
            <div>
              <Label htmlFor="pf-end" required>
                年度の終了日
              </Label>
              <Input
                ref={endRef}
                id="pf-end"
                name="periodEnd"
                type="date"
                defaultValue={one(values, 'periodEnd')}
                aria-invalid={invalid('periodEnd')}
                aria-describedby={describedBy('periodEnd')}
                className="mt-0.5"
              />
              <FieldError id="err-periodEnd" message={errors.periodEnd} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="pf-currency">報告通貨</Label>
              <Input
                id="pf-currency"
                name="currency"
                defaultValue={one(values, 'currency') || 'JPY'}
                maxLength={3}
                aria-invalid={invalid('currency')}
                aria-describedby={describedBy('currency')}
                className="mt-0.5"
              />
              <FieldError id="err-currency" message={errors.currency} />
            </div>
            <div>
              <Label htmlFor="pf-due">期限</Label>
              <Input
                id="pf-due"
                name="dueDate"
                type="date"
                defaultValue={one(values, 'dueDate')}
                aria-invalid={invalid('dueDate')}
                aria-describedby={describedBy('dueDate')}
                className="mt-0.5"
              />
              <FieldError id="err-dueDate" message={errors.dueDate} />
            </div>
          </div>
          <div>
            <Label htmlFor="pf-owner">作成担当</Label>
            <select
              id="pf-owner"
              name="ownerUserId"
              defaultValue={one(values, 'ownerUserId')}
              aria-invalid={invalid('ownerUserId')}
              aria-describedby={describedBy('ownerUserId')}
              className={selectClass}
            >
              <option value="">未定</option>
              {props.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <FieldError id="err-ownerUserId" message={errors.ownerUserId} />
          </div>
          {props.statuses && (
            <div>
              <Label htmlFor="pf-status">状態</Label>
              <select
                id="pf-status"
                name="status"
                defaultValue={one(values, 'status')}
                className={selectClass}
              >
                {props.statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </fieldset>

      {/* 段階 2: 対応する制度と基準（新規作成のみ。版は作成時に固定し、以後は設定タブで新しい版を追加する） */}
      {isCreate && (
        <fieldset hidden={stepHidden(2)} className="space-y-2">
          <legend className="text-[13px] font-semibold text-ink">2. 対応する制度と基準</legend>
          <p className="text-[12px] text-ink-muted">
            複数選べます。基準ごとに使う版を固定し、適用条件と判断は基準ごとに持ちます。
            ここでは「保存して準備を始める」までで、適用判断の確定は作成後の「設定」タブで行います。
          </p>
          <div
            role="group"
            aria-labelledby="pf-purposes-label"
            aria-describedby={describedBy('purposes')}
            className="space-y-2"
          >
            <span id="pf-purposes-label" className="sr-only">
              対応する制度と基準
            </span>
            {props.purposes.map((purpose) => {
              const checked = selectedPurposes.includes(purpose.value);
              const options = props.versionOptions[purpose.value] ?? [];
              return (
                <div key={purpose.value} className="rounded-t4d border border-line p-2">
                  <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
                    <input
                      type="checkbox"
                      name="purposes"
                      value={purpose.value}
                      defaultChecked={checked}
                      onChange={(event) =>
                        setSelectedPurposes((prev) =>
                          event.target.checked
                            ? [...prev, purpose.value]
                            : prev.filter((p) => p !== purpose.value),
                        )
                      }
                    />
                    {purpose.label}
                    {purpose.frameworkLabel && (
                      <span className="text-[11px] font-normal text-ink-muted">
                        （{purpose.frameworkLabel}）
                      </span>
                    )}
                  </label>
                  {checked && options.length > 0 && (
                    <div className="mt-1.5 pl-6">
                      <label
                        htmlFor={`pf-version-${purpose.value}`}
                        className="block text-[12px] text-ink-muted"
                      >
                        使う基準の版
                      </label>
                      <select
                        id={`pf-version-${purpose.value}`}
                        name={`frameworkVersion.${purpose.value}`}
                        defaultValue={
                          one(values, `frameworkVersion.${purpose.value}`) || options[0]?.versionId
                        }
                        className={selectClass}
                      >
                        {options.map((o) => (
                          <option key={o.versionId} value={o.versionId}>
                            {o.label} ／ {o.legalLabel}
                            {o.coverageLabel ? ` ／ ${o.coverageLabel}` : ''}（{o.itemCount} 項目）
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {checked && options.length === 0 && purpose.frameworkLabel && (
                    <p className="mt-1 pl-6 text-[11px] text-danger">
                      この目的で使える基準の版が登録されていません。
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <FieldError id="err-purposes" message={errors.purposes} />
          <FieldError id="err-frameworkVersions" message={errors.frameworkVersions} />
          <div>
            <Label htmlFor="pf-prep">準備の区分</Label>
            <select
              id="pf-prep"
              name="preparationStatus"
              defaultValue={one(values, 'preparationStatus') || 'candidate'}
              className={selectClass}
            >
              <option value="candidate">適用候補（準備を始める）</option>
              <option value="awaiting_confirmation">確認待ち（適用条件を確認中）</option>
            </select>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              未入力の条件から「対象外」とは判断しません。判断の確定には理由・参照規則・確認日が必要です。
            </p>
          </div>
        </fieldset>
      )}

      {/* 段階 3: 報告範囲と承認 */}
      <fieldset hidden={stepHidden(3)} className="space-y-2">
        <legend className="text-[13px] font-semibold text-ink">
          {isCreate ? '3. 報告範囲と承認' : '報告範囲と承認'}
        </legend>
        <div className="grid gap-2 md:grid-cols-2">
          {(
            [
              ['scopeOrgNote', '対象組織'],
              ['scopeConsolidationNote', '財務連結の範囲'],
              ['scopeGhgBoundaryNote', 'GHG 算定境界'],
              ['scopeValueChainNote', 'バリューチェーンの範囲'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <Label htmlFor={`pf-${key}`}>{label}</Label>
              <Textarea
                id={`pf-${key}`}
                name={key}
                rows={2}
                defaultValue={one(values, key)}
                className="mt-0.5"
              />
            </div>
          ))}
        </div>
        {props.units.length > 0 && (
          <fieldset aria-describedby={describedBy('includedUnitIds')}>
            <legend className="text-[12px] font-medium text-ink">
              対象に含める拠点（選ばない場合は全社）
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {props.units.map((u) => (
                <label key={u.id} className="flex items-center gap-1 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    name="includedUnitIds"
                    value={u.id}
                    defaultChecked={many(values, 'includedUnitIds').includes(u.id)}
                  />
                  {u.name}
                </label>
              ))}
            </div>
            <FieldError id="err-includedUnitIds" message={errors.includedUnitIds} />
          </fieldset>
        )}
        <fieldset aria-describedby={describedBy('languages')}>
          <legend className="text-[12px] font-medium text-ink">原稿の言語</legend>
          <div className="mt-1 flex gap-3">
            {props.languages.map((l) => (
              <label key={l.value} className="flex items-center gap-1 text-[12px] text-ink">
                <input
                  type="checkbox"
                  name="languages"
                  value={l.value}
                  defaultChecked={many(values, 'languages').includes(l.value)}
                />
                {l.label}
              </label>
            ))}
          </div>
          <FieldError id="err-languages" message={errors.languages} />
        </fieldset>
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <Label htmlFor="pf-reviewer">レビュアー</Label>
            <select
              id="pf-reviewer"
              name="reviewerUserId"
              defaultValue={one(values, 'reviewerUserId')}
              aria-invalid={invalid('reviewerUserId')}
              aria-describedby={describedBy('reviewerUserId')}
              className={selectClass}
            >
              <option value="">未定</option>
              {props.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <FieldError id="err-reviewerUserId" message={errors.reviewerUserId} />
          </div>
          <div>
            <Label htmlFor="pf-approver">最終承認者</Label>
            <select
              id="pf-approver"
              name="finalApproverUserId"
              defaultValue={one(values, 'finalApproverUserId')}
              aria-invalid={invalid('finalApproverUserId')}
              aria-describedby={describedBy('finalApproverUserId')}
              className={selectClass}
            >
              <option value="">未定</option>
              {props.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                  {m.canApprove ? '' : '（承認権限なし）'}
                </option>
              ))}
            </select>
            <FieldError id="err-finalApproverUserId" message={errors.finalApproverUserId} />
            <p className="mt-0.5 text-[11px] text-ink-muted">
              作成担当・レビュアー・最終承認者は別の人にします（職務分離）。企業内の承認は保証（監査法人の結論）ではありません。
            </p>
          </div>
        </div>
      </fieldset>

      {state.status === 'needs_confirmation' && state.impact && (
        <section
          aria-labelledby="impact-title"
          className="space-y-2 rounded-t4d border border-warning/40 bg-warning-soft/40 p-3"
        >
          <h3
            id="impact-title"
            className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"
          >
            <AlertTriangle className="size-4 text-[#8a5d00]" aria-hidden="true" />
            影響する原稿・数値・承認（変更:{' '}
            {state.changedFields.map((f) => props.fieldLabels[f] ?? f).join('・')}）
          </h3>
          <div className="grid gap-2 md:grid-cols-3">
            <div>
              <p className="text-[12px] font-medium text-ink">
                原稿（{state.impact.blocks.length} 節）
              </p>
              <ul className="mt-1 space-y-0.5 text-[12px]">
                {state.impact.blocks.map((b) => (
                  <li key={b.blockId} className="flex flex-wrap items-center gap-1">
                    <span>{b.title}</span>
                    <Badge tone="neutral">
                      <FileText className="size-3" aria-hidden="true" />
                      {b.statusLabel}
                    </Badge>
                    <span className="text-[11px] text-ink-muted">{b.frameworkLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[12px] font-medium text-ink">
                引用している数値（{state.impact.metricRefs.length} 件）
              </p>
              <ul className="mt-1 space-y-0.5 text-[12px]">
                {state.impact.metricRefs.map((m) => (
                  <li key={`${m.blockId}-${m.dataPointVersionId}`}>
                    {m.metricName} {m.display}
                    {m.versionNo !== null ? `（版 ${m.versionNo}）` : ''}
                    <span className="text-[11px] text-ink-muted"> ／ {m.blockTitle}</span>
                  </li>
                ))}
                {state.impact.metricRefs.length === 0 && (
                  <li className="text-ink-muted">数値の引用はありません。</li>
                )}
              </ul>
            </div>
            <div>
              <p className="text-[12px] font-medium text-ink">
                承認・レビュー（{state.impact.approvals.length} 件）
              </p>
              <ul className="mt-1 space-y-0.5 text-[12px]">
                {state.impact.approvals.map((a, index) => (
                  <li key={`${a.blockId}-${a.kind}-${index}`}>
                    {a.blockTitle}: {a.label}
                  </li>
                ))}
                {state.impact.approvals.length === 0 && (
                  <li className="text-ink-muted">承認・レビュー中の節はありません。</li>
                )}
              </ul>
            </div>
          </div>
          <p className="text-[11px] text-ink-muted">
            保存しても原稿の本文・承認済みの版は変わりません。必要に応じて原稿を見直してください。
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {isCreate && step > 1 && (
          <Button
            variant="outline"
            onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s))}
          >
            <ChevronLeft aria-hidden="true" />
            戻る
          </Button>
        )}
        {isCreate && step < 3 && (
          <Button
            variant="secondary"
            onClick={() => setStep((s) => (s < 3 ? ((s + 1) as 2 | 3) : s))}
          >
            次へ
            <ChevronRight aria-hidden="true" />
          </Button>
        )}
        {(!isCreate || step === 3) &&
          (state.status === 'needs_confirmation' ? (
            <Button
              type="submit"
              name="confirmImpact"
              value="1"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              影響を確認して保存
            </Button>
          ) : (
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isCreate ? '保存して準備を始める' : '変更を保存'}
            </Button>
          ))}
        {pending && (
          <span role="status" className="text-[12px] text-ink-muted">
            保存中…
          </span>
        )}
      </div>
    </form>
  );
}
