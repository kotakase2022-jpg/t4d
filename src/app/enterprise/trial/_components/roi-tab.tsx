import { Calculator } from 'lucide-react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  estimateRoi,
  includesReferenceTiming,
  missingRoiFields,
  monthlyHoursFromSavedMinutes,
  parseRoiParams,
  roiTimingBasis,
  ROI_COST_FIELDS,
  ROI_MAX_MONTHS,
  ROI_PARAM,
} from '@/lib/domain/roi-estimate';
import {
  TRIAL_TASK_LABELS,
  TRIAL_TIMING_METHOD_LABELS,
  type TaskReduction,
} from '@/lib/domain/trial-metrics';
import { formatNumber } from '@/lib/format/datetime';
import { TRIAL_BASE } from '../_lib/tabs';

type Params = Record<string, string | string[] | undefined>;

const yen = (value: number) => `${formatNumber(Math.round(value))} 円`;
const hours = (value: number) => `${formatNumber(Math.round(value * 10) / 10)} 時間`;

/**
 * 費用対効果（NF-36）: 削減時間 × 部門数 × 月数 × 社内換算単価の試算。
 *  - 入力は URL（GET のフォーム）だけに載せ、保存しない（財務影響分析と同じ）
 *  - 単価・比較する費用は利用者が入れる。製品に価格・単価を埋め込まない（例の値も初期値にしない）
 *  - 「試算（実測効果ではない）」「人件費の現金削減を意味しない」を常に表示する（折りたたまない）
 *  - 月あたりの削減時間は手入力か、作業時間の記録（両方 n ≥ 3 の作業 1 つの短縮分）× 月あたりの件数から換算する。
 *    作業ごとに単位が違うため短縮分を合計しない。換算に使った作業の n と測り方を結果に添え（K10）、
 *    記録からの推定（参考値）は利用者が含めると選んだときだけ使い、使ったら警告する
 */

/** 測り方の並び（例「自己申告・同席観察」） */
function methodsText(methods: readonly string[]): string {
  return (
    methods
      .map((m) => TRIAL_TIMING_METHOD_LABELS[m as keyof typeof TRIAL_TIMING_METHOD_LABELS] ?? m)
      .join('・') || '—'
  );
}

/** 換算に使った作業の n と測り方（K10） */
function basisText(task: TaskReduction): string {
  return `${TRIAL_TASK_LABELS[task.taskKey]}: 現行 n=${task.baseline.n}（${methodsText(task.baseline.methods)}）・T4D n=${task.t4d.n}（${methodsText(task.t4d.methods)}）・1 単位あたり ${Math.round((task.savedMinutesPerUnit ?? 0) * 10) / 10} 分短縮`;
}

export function RoiTab({ params, tasks }: { params: Params; tasks: TaskReduction[] }) {
  const parsed = parseRoiParams(params);
  const includeReference = parsed.raw[ROI_PARAM.includeReference] === '1';
  const basis = roiTimingBasis(tasks, {
    task: parsed.raw[ROI_PARAM.task] ?? '',
    includeReference,
  });
  const selected = basis.selected;
  const monthlyHours =
    parsed.source === 'timing'
      ? parsed.unitsPerMonth === null || !selected
        ? null
        : monthlyHoursFromSavedMinutes(selected.savedMinutesPerUnit ?? 0, parsed.unitsPerMonth)
      : parsed.monthlyHours;
  const missing = missingRoiFields(parsed);
  const timingUnavailable = parsed.source === 'timing' && basis.reason !== null;
  const usesReference =
    parsed.source === 'timing' && selected !== null && includesReferenceTiming(selected);
  const ready =
    parsed.errors.length === 0 &&
    missing.length === 0 &&
    !timingUnavailable &&
    monthlyHours !== null &&
    parsed.unitPriceYen !== null &&
    parsed.departments !== null &&
    parsed.months !== null;
  const result = ready
    ? estimateRoi({
        unitPriceYen: parsed.unitPriceYen!,
        departments: parsed.departments!,
        monthlyHours: monthlyHours!,
        months: parsed.months!,
        costs: parsed.costs.map((c) => c.yen),
      })
    : null;
  const raw = parsed.raw;

  return (
    <div className="space-y-3">
      {/* 誠実さの注記（折りたたまない） */}
      <Notice tone="warning" title="試算（実測効果ではない）">
        <p className="flex flex-wrap items-center gap-1.5">
          <HonestyBadge kind="estimate" />
          画面に入れた仮定による試算です。創出した時間は、人件費の現金削減を意味しません。
        </p>
        <p>
          導入・教育・並行運用・オプションなどの費用は、比較する費用として利用者が入れます（製品は価格を持ちません）。入力は保存せず、URL
          にだけ載せます。
        </p>
      </Notice>

      <Section title="仮定" divider="none">
        <form method="get" action={TRIAL_BASE} className="space-y-3" aria-label="試算の仮定">
          <input type="hidden" name="tab" value="roi" />
          <FormSection title="削減時間と単価" kind="required">
            <div className="grid grid-cols-12 gap-2">
              <Field
                label="社内換算単価（円 / 時間）"
                id="roi-price"
                required
                className="col-span-3"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={ROI_PARAM.unitPriceYen}
                    inputMode="decimal"
                    defaultValue={raw[ROI_PARAM.unitPriceYen]}
                  />
                )}
              </Field>
              <Field label="対象部門数" id="roi-depts" required className="col-span-2">
                {(p) => (
                  <Input
                    {...p}
                    name={ROI_PARAM.departments}
                    inputMode="numeric"
                    defaultValue={raw[ROI_PARAM.departments]}
                  />
                )}
              </Field>
              <Field
                label="月数"
                id="roi-months"
                required
                hint={`${ROI_MAX_MONTHS} か月まで`}
                className="col-span-2"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={ROI_PARAM.months}
                    inputMode="numeric"
                    defaultValue={raw[ROI_PARAM.months]}
                  />
                )}
              </Field>
              <Field label="削減時間の出所" id="roi-source" required className="col-span-5">
                {(p) => (
                  <NativeSelect {...p} name={ROI_PARAM.source} defaultValue={parsed.source}>
                    <option value="manual">手入力（1 部門の月あたり削減時間）</option>
                    <option value="timing">作業時間の記録から換算</option>
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="月あたり削減時間（時間・1 部門あたり。手入力のとき）"
                id="roi-hours"
                className="col-span-6"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={ROI_PARAM.monthlyHours}
                    inputMode="decimal"
                    defaultValue={raw[ROI_PARAM.monthlyHours]}
                  />
                )}
              </Field>
              <Field
                label="換算する作業（記録から換算するとき）"
                id="roi-task"
                hint="作業ごとに単位が違うため、1 つの作業の短縮分だけで換算します（合計しません）。"
                className="col-span-6"
              >
                {(p) => (
                  <NativeSelect
                    {...p}
                    name={ROI_PARAM.task}
                    defaultValue={selected?.taskKey ?? parsed.raw[ROI_PARAM.task] ?? ''}
                  >
                    <option value="">選んでください</option>
                    {basis.candidates.map((t) => (
                      <option key={t.taskKey} value={t.taskKey}>
                        {TRIAL_TASK_LABELS[t.taskKey]}
                        {includesReferenceTiming(t) ? '（参考値を含む）' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="月あたりの件数（1 部門あたり。記録から換算するとき）"
                id="roi-volume"
                hint={
                  selected
                    ? `選んだ作業の単位で数えます（${basisText(selected)}）`
                    : basis.candidates.length > 0
                      ? '換算する作業を選ぶと、その作業の n と測り方を示します'
                      : '短縮率を出せる作業（両方 3 件以上）がまだありません'
                }
                className="col-span-6"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={ROI_PARAM.unitsPerMonth}
                    inputMode="decimal"
                    defaultValue={raw[ROI_PARAM.unitsPerMonth]}
                  />
                )}
              </Field>
              {basis.referenceOnly.length > 0 && (
                <NativeCheckbox
                  name={ROI_PARAM.includeReference}
                  value="1"
                  defaultChecked={includeReference}
                  className="col-span-12"
                  label={`記録からの推定（参考値。待ち時間を含む）を含む作業も換算に使う（${basis.referenceOnly
                    .map((t) => TRIAL_TASK_LABELS[t.taskKey])
                    .join('・')}）`}
                />
              )}
            </div>
          </FormSection>
          <FormSection
            title="比較する費用（円・任意）"
            kind="optional"
            open={parsed.costs.length > 0}
            description="入れた費用だけを合計して比べます。"
          >
            <div className="grid grid-cols-5 gap-2">
              {ROI_COST_FIELDS.map((cost) => (
                <Field key={cost.key} label={cost.label} id={`roi-${cost.key}`}>
                  {(p) => (
                    <Input
                      {...p}
                      name={cost.param}
                      inputMode="numeric"
                      defaultValue={raw[cost.param]}
                    />
                  )}
                </Field>
              ))}
            </div>
          </FormSection>
          <SubmitButton
            variant="primary"
            size="sm"
            icon={<Calculator aria-hidden="true" />}
            pendingLabel="試算中…"
          >
            試算する
          </SubmitButton>
        </form>
      </Section>

      <Section title="試算の結果" divider="top">
        {parsed.errors.length > 0 && (
          <Notice tone="danger" role="alert" title="入力を確かめてください">
            <ul className="list-disc pl-4">
              {parsed.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Notice>
        )}
        {timingUnavailable && <Notice tone="warning">{basis.reason}</Notice>}
        {result ? (
          <div className="space-y-2">
            {parsed.source === 'timing' && selected && (
              <p className="text-small text-ink" data-testid="roi-timing-basis">
                換算に使った作業時間の記録: {basisText(selected)}
              </p>
            )}
            {usesReference && (
              <Notice tone="warning" title="参考値を含む試算">
                記録からの推定（参考値。待ち時間を含みます）を使った換算です。自己申告・同席観察の記録より大きく出ることがあります。
              </Notice>
            )}
            <MetricStrip label="試算の数値">
              <MetricTile
                label="創出時間（期間の合計）"
                value={hours(result.hours)}
                hint={`${formatNumber(Math.round(monthlyHours! * 10) / 10)} 時間 × ${parsed.departments} 部門 × ${parsed.months} か月`}
              />
              <MetricTile
                label="円換算（試算）"
                value={yen(result.yen)}
                hint={`${hours(result.hours)} × ${yen(parsed.unitPriceYen!)}`}
              />
              <MetricTile
                label="比較する費用の合計"
                value={result.totalCost === null ? '—' : yen(result.totalCost)}
                hint={
                  result.totalCost === null
                    ? '費用を入れていません'
                    : parsed.costs.map((c) => c.label).join('・')
                }
              />
              <MetricTile
                label="差額（円換算 − 費用）"
                value={result.difference === null ? '—' : yen(result.difference)}
                hint={
                  result.ratio === null
                    ? '倍率は費用が 0 より大きいときだけ出します'
                    : `円換算は費用の ${Math.round(result.ratio * 100) / 100} 倍`
                }
              />
            </MetricStrip>
            <p className="flex items-center gap-1.5 text-caption text-ink-muted">
              <HonestyBadge kind="estimate" />
              試算（実測効果ではない）。人件費の現金削減を意味しません。
            </p>
          </div>
        ) : (
          parsed.errors.length === 0 &&
          !timingUnavailable && (
            <p className="text-small text-ink-muted">
              {parsed.touched
                ? `試算には次の入力が必要です: ${missing.join('・')}`
                : '仮定を入れて「試算する」を押すと、創出時間と円換算を出します。'}
            </p>
          )
        )}
      </Section>
    </div>
  );
}
