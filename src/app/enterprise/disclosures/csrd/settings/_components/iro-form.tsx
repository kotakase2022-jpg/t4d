'use client';

import * as React from 'react';
import { AlertTriangle, Save } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { IDLE_FORM_STATE, formFailure, type FormActionState } from '@/lib/errors/form-action-state';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  IMPACT_DIRECTION_LABEL,
  IMPACT_OCCURRENCE_LABEL,
  IRO_TYPE_LABEL,
  TIME_HORIZON_LABEL,
  TIME_HORIZON_MEANING,
  VALUE_CHAIN_STAGE_LABEL,
} from '@/lib/domain/dma';
import {
  IMPACT_DIRECTIONS,
  IMPACT_OCCURRENCES,
  IRO_TYPES,
  TIME_HORIZONS,
  VALUE_CHAIN_STAGES,
  type ImpactDirection,
  type ImpactOccurrence,
  type IroType,
} from '@/types/domain';
import { iroFormValuesFromEntries, type IroFormValues } from '../iro-form-values';

const SELECT_CLASS = 'h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]';

/** 1〜5 の段階の選択（整数だけを選ばせる。入力の誤りを先に減らす） */
function ScoreSelect({
  name,
  label,
  hint,
  defaultValue,
}: {
  name: string;
  label: string;
  hint: string;
  defaultValue: string;
}) {
  return (
    <label className="space-y-1 text-[11px] text-ink-muted">
      <span className="block">
        {label}
        <span className="ml-1 text-[10px]">（{hint}）</span>
      </span>
      {/* 出している欄は、その種類の IRO で必須の欄だけ（送る前にブラウザが止める） */}
      <select name={name} defaultValue={defaultValue} required className={SELECT_CLASS}>
        <option value="">選択</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

type IroAction = (previous: FormActionState, formData: FormData) => Promise<FormActionState>;

interface IroFormProps {
  action: IroAction;
  reportingPeriodId: string;
  topic: string;
  initial: IroFormValues;
  /** リスク・機会が関連付けられるインパクト IRO（同じ事項のもの。編集中の自分は除く） */
  impactIroOptions: Array<{ id: string; description: string }>;
  submitLabel: string;
}

/**
 * IRO（影響・リスク・機会）の追加・編集フォーム（docs/disclosure-first.md §9.2）。
 *
 * 種類・実在／潜在・負／正によって入力する欄が変わる。合わない欄は出さない（送らない）ことで、
 * 0044 の形の規則（validateIroShape）に沿った入力だけが送られるようにする。出している欄は必須にする。
 * 最終的な検査はサーバー側のサービスが行う（ここは入力を助けるだけ）。
 * サーバーが断ったとき・通信に失敗したときは、入力を残したまま理由を示す（フォームを作り直し、
 * 送った値を初期値にする。リダイレクトで画面が組み直されて入力が消えることはない）。
 */
export function IroForm({ action, initial, ...props }: IroFormProps) {
  const wrapped = React.useMemo(
    () =>
      withNetworkFallback(action, (_previous, formData, message) => formFailure(message, formData)),
    [action],
  );
  const [state, formAction] = React.useActionState(wrapped, IDLE_FORM_STATE);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (state.status === 'error') setGeneration((g) => g + 1);
  }, [state]);
  const values =
    state.status === 'error' && state.values
      ? iroFormValuesFromEntries(state.values, initial)
      : initial;
  return (
    <IroFormFields
      key={generation}
      {...props}
      formAction={formAction}
      initial={values}
      error={state.status === 'error' ? state.message : null}
    />
  );
}

function IroFormFields({
  formAction,
  reportingPeriodId,
  topic,
  initial,
  impactIroOptions,
  submitLabel,
  error,
}: Omit<IroFormProps, 'action'> & {
  formAction: (formData: FormData) => void;
  error: string | null;
}) {
  const errorId = React.useId();
  const [iroType, setIroType] = React.useState<IroType>(initial.iroType);
  const [occurrence, setOccurrence] = React.useState<ImpactOccurrence | ''>(
    initial.impactOccurrence,
  );
  const [direction, setDirection] = React.useState<ImpactDirection | ''>(initial.impactDirection);
  const isImpact = iroType === 'impact';

  return (
    <form
      action={formAction}
      className="space-y-2.5"
      aria-describedby={error ? errorId : undefined}
    >
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[12px] text-ink"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span>{error}（入力は残っています）</span>
        </p>
      )}
      <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
      <input type="hidden" name="topic" value={topic} />
      {initial.iroId && <input type="hidden" name="iroId" value={initial.iroId} />}

      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-[11px] font-medium text-ink">種類</legend>
        {IRO_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-1 text-[12px] text-ink">
            <input
              type="radio"
              name="iroType"
              value={type}
              checked={iroType === type}
              onChange={() => setIroType(type)}
              className="accent-[#0b57a4]"
            />
            {IRO_TYPE_LABEL[type]}
            <span className="text-[10px] text-ink-muted">
              {type === 'impact' ? '（インパクト重要性）' : '（財務的重要性）'}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <label className="space-y-1 text-[11px] text-ink-muted">
          <span className="block">サブトピック（任意）</span>
          <Input name="subTopic" defaultValue={initial.subTopic} maxLength={100} />
        </label>
        <label className="space-y-1 text-[11px] text-ink-muted">
          <span className="block">内容（必須）</span>
          <Input
            name="description"
            defaultValue={initial.description}
            required
            maxLength={300}
            placeholder={
              isImpact ? '例: 製造拠点の GHG 排出' : '例: 炭素価格の上昇による操業コストの増加'
            }
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1 text-[11px] text-ink-muted">
          <span className="block">段階（バリューチェーン）</span>
          <select
            name="valueChainStage"
            defaultValue={initial.valueChainStage}
            className={SELECT_CLASS}
          >
            {VALUE_CHAIN_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {VALUE_CHAIN_STAGE_LABEL[stage]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[11px] text-ink-muted">
          <span className="block">期間{isImpact ? '（任意）' : '（必須）'}</span>
          <select
            name="timeHorizon"
            defaultValue={initial.timeHorizon}
            required={!isImpact}
            className={SELECT_CLASS}
          >
            <option value="">{isImpact ? '未設定' : '選択'}</option>
            {TIME_HORIZONS.map((horizon) => (
              <option key={horizon} value={horizon}>
                {TIME_HORIZON_LABEL[horizon]}（{TIME_HORIZON_MEANING[horizon]}）
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[11px] text-ink-muted">
          <span className="block">影響を受ける人（任意）</span>
          <Input
            name="affectedStakeholders"
            defaultValue={initial.affectedStakeholders}
            maxLength={300}
          />
        </label>
      </div>

      {isImpact ? (
        <fieldset className="space-y-2 rounded-t4d border border-line p-2">
          <legend className="px-1 text-[11px] font-medium text-ink">
            インパクトの評価（人・環境への影響）
          </legend>
          <div className="flex flex-wrap gap-4">
            <div role="radiogroup" aria-label="実在か潜在か" className="flex items-center gap-2">
              {IMPACT_OCCURRENCES.map((value) => (
                <label key={value} className="flex items-center gap-1 text-[12px] text-ink">
                  <input
                    type="radio"
                    name="impactOccurrence"
                    value={value}
                    required
                    checked={occurrence === value}
                    onChange={() => setOccurrence(value)}
                    className="accent-[#0b57a4]"
                  />
                  {IMPACT_OCCURRENCE_LABEL[value]}
                </label>
              ))}
            </div>
            <div role="radiogroup" aria-label="負か正か" className="flex items-center gap-2">
              {IMPACT_DIRECTIONS.map((value) => (
                <label key={value} className="flex items-center gap-1 text-[12px] text-ink">
                  <input
                    type="radio"
                    name="impactDirection"
                    value={value}
                    required
                    checked={direction === value}
                    onChange={() => setDirection(value)}
                    className="accent-[#0b57a4]"
                  />
                  {IMPACT_DIRECTION_LABEL[value]}のインパクト
                </label>
              ))}
            </div>
            <label className="flex items-center gap-1 text-[12px] text-ink">
              <input
                type="checkbox"
                name="humanRights"
                defaultChecked={initial.humanRights}
                className="size-3.5 accent-[#0b57a4]"
              />
              人権に関わる（潜在でも深刻度で評価）
            </label>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <ScoreSelect
              name="impactScale"
              label="規模"
              hint="1〜5"
              defaultValue={initial.impactScale}
            />
            <ScoreSelect
              name="impactScope"
              label="範囲"
              hint="1〜5"
              defaultValue={initial.impactScope}
            />
            {direction !== 'positive' && (
              <ScoreSelect
                name="impactIrremediability"
                label="回復困難性"
                hint="負のみ"
                defaultValue={initial.impactIrremediability}
              />
            )}
            {occurrence !== 'actual' && (
              <ScoreSelect
                name="impactLikelihood"
                label="発生可能性"
                hint="潜在のみ"
                defaultValue={initial.impactLikelihood}
              />
            )}
          </div>
        </fieldset>
      ) : (
        <fieldset className="space-y-2 rounded-t4d border border-line p-2">
          <legend className="px-1 text-[11px] font-medium text-ink">
            リスク・機会の評価（企業への財務的な影響）
          </legend>
          <div className="grid grid-cols-3 gap-2">
            <ScoreSelect
              name="financialLikelihood"
              label="発生可能性"
              hint="1〜5"
              defaultValue={initial.financialLikelihood}
            />
            <ScoreSelect
              name="financialMagnitude"
              label="財務影響の大きさ"
              hint="1〜5"
              defaultValue={initial.financialMagnitude}
            />
            <label className="space-y-1 text-[11px] text-ink-muted">
              <span className="block">関連するインパクト（任意）</span>
              <select
                name="relatedImpactIroId"
                defaultValue={initial.relatedImpactIroId}
                className={SELECT_CLASS}
              >
                <option value="">なし</option>
                {impactIroOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.description}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <SubmitButton size="sm" icon={<Save aria-hidden="true" />} pendingLabel="保存中…">
          {submitLabel}
        </SubmitButton>
        <span className="text-[11px] text-ink-muted">
          保存すると算定結果（提案）が変わり、DMA の確定は取り消されます。人の判断は変わりません。
        </span>
      </div>
    </form>
  );
}
