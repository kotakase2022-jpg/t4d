import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { cleanFloat } from '@/lib/domain/ghg/rounding';
import type { GhgClassificationRule, GhgRunSummary, RoundingRule } from '@/types/domain';
import {
  dualViewRows,
  effectiveRoundingRule,
  digitsInTonnes,
  formatStageValue,
  formatUnrounded,
  reclassifiedByRule,
  type DualViewRow,
} from './calc-view';

/**
 * 報告区分と既定区分の二重表示（plan K7・CR-09。P90・P96・GHG サマリーで同じ表）。
 *
 *  - 報告区分（組織の算定ルール）と既定区分（GHG プロトコル。参考）を同じ行に並べ、差（再分類で移った分）を出す
 *  - Scope1＋Scope3 カテゴリ4 の計は、どちらの見方でも同じ（再分類は移動だけ。二重計上なし）
 *  - Scope2 のロケーション基準とマーケット基準は別の行にし、決して足さない
 *  - 値の無い区分は「—」（0 と書かない）。値は合計の段の丸め後（表示で丸め直さない）
 */

function signed(value: number, rounding: readonly RoundingRule[]): string {
  if (value === 0) return '±0';
  const text = formatStageValue(Math.abs(value), rounding, 'total');
  return value > 0 ? `+${text}` : `−${text}`;
}

function DifferenceCell({
  row,
  rounding,
}: {
  row: DualViewRow;
  rounding: readonly RoundingRule[];
}) {
  if (row.difference === null || row.unroundedDifference === null) return <>—</>;
  if (row.key === 'scope1_scope3_total') {
    const moved = cleanFloat(row.unroundedDifference) === 0;
    return (
      <span className="inline-flex flex-col items-end">
        <span>{moved ? '±0（移動だけ・二重計上なし）' : signed(row.difference, rounding)}</span>
        {moved && row.difference !== 0 && (
          <span className="text-caption text-ink-muted">
            丸め後の計の差 {signed(row.difference, rounding)}（丸めの段の違い。未丸めでは 0）
          </span>
        )}
      </span>
    );
  }
  return <>{signed(row.difference, rounding)}</>;
}

export function DualViewTable({
  summary,
  rounding,
  rules,
}: {
  summary: GhgRunSummary;
  rounding: readonly RoundingRule[];
  rules: ReadonlyArray<Pick<GhgClassificationRule, 'id' | 'code' | 'name'>>;
}) {
  const rows = dualViewRows(summary);
  const moved = reclassifiedByRule(summary);
  const totalRule = effectiveRoundingRule(rounding, 'total');
  return (
    <div className="space-y-1.5" data-dual-view="">
      <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
        <Table>
          <caption className="sr-only">報告区分と既定区分</caption>
          <THead>
            <TR>
              <TH>区分</TH>
              <TH align="right">
                報告区分<span className="normal-case">（組織の算定ルール）</span>
              </TH>
              <TH align="right">
                既定区分<span className="normal-case">（GHG プロトコル・参考）</span>
              </TH>
              <TH align="right">差（再分類で移った分）</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR
                key={row.key}
                data-dual-row={row.key}
                className={
                  row.key === 'scope1_scope3_total'
                    ? 'bg-surface-muted font-medium'
                    : row.key === 'scope2_location'
                      ? 'border-t-2 border-line'
                      : undefined
                }
              >
                <TD>{row.label}</TD>
                <TD align="right">
                  {row.reported === null ? '—' : formatStageValue(row.reported, rounding, 'total')}
                </TD>
                <TD align="right">
                  {row.protocol === null ? '—' : formatStageValue(row.protocol, rounding, 'total')}
                </TD>
                <TD align="right">
                  <DifferenceCell row={row} rounding={rounding} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <p className="text-caption text-ink-muted">
        単位 t-CO2e。値は算定方針の合計の段の値
        {totalRule ? `（小数 ${digitsInTonnes(totalRule)} 桁）` : '（丸めの段なし・未丸め）'}
        です。Scope2 のロケーション基準とマーケット基準は別々に示し、足しません。
      </p>
      {moved.length > 0 && (
        <ul aria-label="区分規則による再分類" className="space-y-0.5 text-small text-ink">
          {moved.map((m) => {
            const rule = rules.find((r) => r.id === m.ruleId);
            return (
              <li
                key={`${m.ruleId}-${m.from}-${m.to}`}
                className="flex flex-wrap items-center gap-1"
              >
                <span>
                  区分規則「{rule ? `${rule.code} ${rule.name}` : '（名前を読めない規則）'}」:
                </span>
                <span>{GHG_SCOPE_LABELS[m.from]}</span>
                <ArrowRight className="size-3 text-ink-muted" aria-hidden="true" />
                <span className="sr-only">から</span>
                <span>{GHG_SCOPE_LABELS[m.to]}</span>
                <span className="text-ink-muted">
                  （{formatUnrounded(m.unrounded)} t-CO2e・未丸め・{m.unitIds.length} 拠点）
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
