import * as React from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { MoreInfo } from '@/components/ui/more-info';
import {
  GHG_METHOD_LABELS,
  GHG_SCOPE_LABELS,
  LINE_WARNING_LABELS,
  activityLabel,
} from '@/lib/domain/ghg/calculate';
import { formatNumber } from '@/lib/format/datetime';
import {
  GHG_LOAD_FACTOR_SOURCES,
  type GhgLoadFactorSource,
} from '@/lib/ui/status/ghgLoadFactorSource';
import type { ConversionStep, GhgCalculationLine, RoundingMethod } from '@/types/domain';
import { ROUNDING_METHOD_LABELS, formatUnrounded } from '../../../_components/calc-view';

/**
 * 算定行の展開（plan §2.4 P96「展開行に各段の値（MoreInfo に式）」）。
 * 活動量 → 換算 →（輸送: t·km → 燃料使用原単位 → 燃料）→ 係数 → 排出量（未丸め → 行の丸め）→ 区分 の順に、
 * 記録した値をそのまま出す（表示で丸め直さない。未丸めは桁を落とさない）。
 */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function exact(value: number | null): string {
  return value === null ? '—' : formatUnrounded(value);
}

function conversionText(step: ConversionStep): string {
  const origin =
    step.source === 'builtin' ? '内蔵の換算' : `組織の換算: ${step.source.replace(/^policy:/, '')}`;
  return `${step.from} → ${step.to} × ${formatUnrounded(step.factor)}（${origin}）`;
}

function loadSourceOf(value: unknown): GhgLoadFactorSource | null {
  return (GHG_LOAD_FACTOR_SOURCES as readonly string[]).includes(value as string)
    ? (value as GhgLoadFactorSource)
    : null;
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-0.5">
      <dt className="text-caption font-medium text-ink-muted">{term}</dt>
      <dd className="min-w-0 text-small text-ink">{children}</dd>
    </div>
  );
}

export function LineDetail({
  line,
  ruleName,
}: {
  line: GhgCalculationLine;
  /** 報告区分を変えた区分規則の名前（無ければ null） */
  ruleName: string | null;
}) {
  const d = line.methodDetail;
  const tonkm = line.method === 'tonkm_improved';
  const twoStage = num(d.calorificValue) !== null && num(d.carbonFactor) !== null;
  const loadSource = loadSourceOf(d.loadFactorSource);
  const rounding = line.roundingApplied as {
    digits?: number;
    unit?: string;
    method?: RoundingMethod;
  } | null;
  const formula = tonkm
    ? 't·km ＝ 輸送重量 × 輸送距離 ／ 燃料（L）＝ t·km × 燃料使用原単位 ／ t-CO2 ＝ kL × 単位発熱量 × 炭素排出係数 × 44/12（2 段係数）'
    : twoStage
      ? 't-CO2 ＝ 換算後の量 × 単位発熱量 × 炭素排出係数 × 44/12（2 段係数）'
      : 't-CO2e ＝ 換算後の量 × 排出係数';
  return (
    <div className="grid gap-x-6 py-1 md:grid-cols-2" data-line-detail="">
      <dl>
        <Row term="活動量">
          {formatUnrounded(line.activityAmount)} {line.activityUnit}（
          {activityLabel(line.activityKind, line.activityCode)}・{GHG_METHOD_LABELS[line.method]}）
        </Row>
        {tonkm && (
          <>
            <Row term="燃料使用原単位">
              {exact(num(d.intensityRaw))}（未丸め）→ {exact(num(d.intensity))} L/(t·km)（
              {d.intensitySource === 'default_table' ? '見なし積載率の原単位表' : '式'}・
              {d.shape === 'log' ? '対数式' : '告示の形'}）
            </Row>
            <Row term="積載率">
              <span className="inline-flex flex-wrap items-center gap-1">
                {num(d.loadFactorUsed) === null ? '—' : `${formatNumber(num(d.loadFactorUsed))}%`}
                {loadSource && <StatusBadge domain="ghgLoadFactorSource" value={loadSource} />}
              </span>
            </Row>
            <Row term="燃料">
              {exact(num(d.fuelLiters))} L（{activityLabel('fuel', str(d.fuelCode) ?? '')}）
            </Row>
          </>
        )}
        <Row term="換算">
          {line.conversionSteps.length === 0 ? (
            '換算なし'
          ) : (
            <ul className="space-y-0.5">
              {line.conversionSteps.map((step, i) => (
                <li key={i}>{conversionText(step)}</li>
              ))}
            </ul>
          )}
          <span className="block text-ink-muted">
            換算後 {exact(line.convertedAmount)} {line.convertedUnit}
          </span>
        </Row>
      </dl>
      <div>
        <dl>
          <Row term="排出係数">
            {exact(line.factorValue)} {line.factorUnit}（{line.factorYear} 年・{line.factorSetCode}{' '}
            {line.factorSetVersion}）
            {twoStage && (
              <span className="block text-ink-muted">
                単位発熱量 {exact(num(d.calorificValue))} {str(d.calorificUnit) ?? ''} ×
                炭素排出係数 {exact(num(d.carbonFactor))} {str(d.carbonFactorUnit) ?? ''} ×
                44/12（熱量 {exact(num(d.gj))} GJ・炭素 {exact(num(d.tc))} tC）
              </span>
            )}
          </Row>
          <Row term="係数の解決経路">
            {line.resolutionPath}
            {str(d.intensityResolutionPath) && (
              <span className="block text-ink-muted">{str(d.intensityResolutionPath)}</span>
            )}
          </Row>
          <Row term="排出量">
            {exact(line.emissionsUnrounded)} t-CO2e（未丸め）→{' '}
            {rounding && typeof rounding.digits === 'number' && rounding.method
              ? `行の丸め（${rounding.unit ?? 't'}・小数 ${rounding.digits} 桁・${ROUNDING_METHOD_LABELS[rounding.method]}）`
              : '行の段の丸めなし'}{' '}
            → {exact(line.emissionsRounded)} t-CO2e
          </Row>
          <Row term="区分">
            既定区分 {GHG_SCOPE_LABELS[line.protocolScope]} → 報告区分{' '}
            {GHG_SCOPE_LABELS[line.reportedScope]}
            {ruleName && <span className="block text-ink-muted">区分規則「{ruleName}」</span>}
          </Row>
          {line.warnings.length > 0 && (
            <Row term="警告">
              {line.warnings.map((w) => LINE_WARNING_LABELS[w] ?? w).join('・')}
            </Row>
          )}
        </dl>
        <div className="pt-1">
          <MoreInfo label="この行の式">
            <p>{formula}</p>
            <p>
              各段の値は算定の記録に残した値です（係数は記録の時点の値・年度・版のスナップショット）。
            </p>
          </MoreInfo>
        </div>
      </div>
    </div>
  );
}
