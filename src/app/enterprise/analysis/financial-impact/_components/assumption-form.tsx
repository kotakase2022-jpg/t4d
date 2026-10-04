import Link from 'next/link';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ASSUMPTION_GROUPS,
  ASSUMPTION_GROUP_LABEL,
  ASSUMPTION_SPECS,
  DRIVER_KEYS,
  DRIVERS,
  GROWTH_RATE_RANGE,
  PATHWAY_IDS,
  PATHWAYS,
  SCENARIOS,
  SCENARIO_LABEL,
  type AssumptionValues,
  type ParsedImpactParams,
} from '@/lib/domain/financial-impact';
import { formatNumber } from '@/lib/format/datetime';

/**
 * 仮定を変えるフォーム（docs/disclosure-first.md §10.3）。`<form method="get">` で URL に載せ、
 * JavaScript なしで再計算でき、URL で共有できる（Cookie・DB に保存しない）。
 * 範囲外・数値でない値はサーバーが既定に戻して通知する（parseImpactParams）。
 * 数値欄はラベルと単位・範囲・既定を書く。Demo Mode の既定は「仮定・デモ既定」、Supabase モードは空欄。
 */

const FIELD_CLASS =
  'mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink';

function valueText(value: number | null): string {
  return value === null ? '' : String(value);
}

export function AssumptionForm({
  action,
  params,
  defaults,
  source,
}: {
  action: string;
  params: ParsedImpactParams;
  defaults: AssumptionValues;
  source: 'demo' | 'none';
}) {
  // 範囲・既定の表示（年度は桁区切りにしない）
  const numberText = (value: number, unit: string) =>
    unit === '年度' ? String(value) : formatNumber(value);
  const defaultText = (value: number | null, unit: string) => {
    if (value === null) return '既定なし（入力があるときだけ試算）';
    return `${source === 'demo' ? '仮定・デモ既定' : '既定'} ${numberText(value, unit)}`;
  };
  return (
    <form method="get" action={action} className="space-y-3" aria-label="仮定を変えて再計算">
      <label className="block max-w-xs text-[12px] font-semibold text-ink">
        シナリオ
        <select name="sc" defaultValue={params.scenario} className={`${FIELD_CLASS} font-normal`}>
          {SCENARIOS.map((scenario) => (
            <option key={scenario} value={scenario}>
              {SCENARIO_LABEL[scenario]}
            </option>
          ))}
        </select>
      </label>

      {ASSUMPTION_GROUPS.map((group) => {
        const specs = ASSUMPTION_SPECS.filter((s) => s.group === group);
        return (
          <fieldset key={group} className="space-y-1">
            <legend className="text-[12px] font-semibold text-ink">
              {ASSUMPTION_GROUP_LABEL[group]}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {specs.map((s) => {
                const fallback = defaults[s.key];
                return (
                  <label key={s.key} className="block text-[12px] text-ink-muted">
                    <span className="text-ink">
                      {s.label}（{s.unit}）
                    </span>
                    <input
                      name={`a_${s.key}`}
                      type="text"
                      inputMode="decimal"
                      defaultValue={valueText(params.assumptions[s.key])}
                      placeholder={fallback === null ? '未入力（未定量）' : undefined}
                      className={FIELD_CLASS}
                    />
                    <span className="mt-0.5 block text-[11px]">
                      範囲 {numberText(s.min, s.unit)}〜{numberText(s.max, s.unit)}・
                      {defaultText(fallback, s.unit)}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <fieldset className="space-y-1">
        <legend className="text-[12px] font-semibold text-ink">
          カスタムの年率（%/年、複利。シナリオがカスタムのときだけ使います）
        </legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DRIVER_KEYS.map((driver) => (
            <label key={driver} className="block text-[12px] text-ink-muted">
              <span className="text-ink">{DRIVERS[driver].label}の年率（%/年）</span>
              <input
                name={`r_${driver}`}
                type="text"
                inputMode="decimal"
                defaultValue={
                  params.growthRates[driver] === 0 ? '' : String(params.growthRates[driver])
                }
                placeholder="0"
                className={FIELD_CLASS}
              />
              <span className="mt-0.5 block text-[11px]">
                範囲 {GROWTH_RATE_RANGE.min}〜{GROWTH_RATE_RANGE.max}・空欄は 0（一定）
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-[12px] font-semibold text-ink">経路の有効・無効</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PATHWAY_IDS.map((id) => (
            <label key={id} className="block text-[12px] text-ink-muted">
              <span className="text-ink">
                {id} {PATHWAYS[id].mechanism}
              </span>
              <select
                name={`p_${id}`}
                defaultValue={params.enabled[id] ? '1' : '0'}
                className={FIELD_CLASS}
              >
                <option value="1">有効（算定に含める）</option>
                <option value="0">無効（算定に含めない）</option>
              </select>
              <span className="mt-0.5 block text-[11px]">
                既定: {PATHWAYS[id].defaultEnabled ? '有効' : '無効'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm">
          再計算
        </Button>
        <Link
          href={action}
          className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          既定に戻す
        </Link>
        <span className="text-[11px] text-ink-muted">
          仮定は URL にだけ載り、保存しません（URL で共有できます）。
        </span>
      </div>
    </form>
  );
}
