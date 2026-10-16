import type { ReactNode } from 'react';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { GHG_METHOD_LABELS, GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatNumber } from '@/lib/format/datetime';
import type { LineTrial, TrialResult } from '@/lib/services/ghg/transport-preview';
import { trialWarningLabel } from '@/lib/services/ghg/transport-preview';
import type { GhgActivityLine } from '@/types/domain';

/**
 * 活動量の行の試算の段（P95 の展開行）。t·km → 燃料使用原単位（式／見なし積載率の原単位表・積載率の出所）
 * → 燃料 L → kL → CO2 を、使った係数と経路の文と一緒に 1 段ずつ書く。値は未丸め（丸めは算定の記録の段で行う）。
 * 原単位は算定方針の有効数字で丸めた値を「算定に使う値」として未丸めと並べる（表示で丸め直さない）。
 */

function n(value: number | null | undefined, fraction: number): string {
  return value === null || value === undefined ? '—' : formatNumber(value, { fraction });
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface text-caption font-semibold text-ink-muted"
      >
        {index}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-small font-medium text-ink">{title}</p>
        <div className="text-small text-ink">{children}</div>
      </div>
    </li>
  );
}

function Path({ text }: { text: string }) {
  return text ? <p className="text-caption text-ink-muted">経路: {text}</p> : null;
}

function Conversion({ result }: { result: TrialResult }) {
  if (result.conversionSteps.length === 0) return null;
  return (
    <p className="text-caption text-ink-muted">
      換算:{' '}
      {result.conversionSteps
        .map(
          (s) =>
            `${s.from} → ${s.to} ×${s.factor}（${s.source === 'builtin' ? '単位の定義' : s.source.replace(/^policy:/, '組織の換算: ')}）`,
        )
        .join(' ／ ')}
    </p>
  );
}

function Co2Step({ index, result }: { index: number; result: TrialResult }) {
  return (
    <Step index={index} title="CO2（試算・未丸め）">
      {result.fuel ? (
        <p className="tnum">
          {n(result.convertedAmount, 7)} {result.convertedUnit} × {result.fuel.calorificValue}{' '}
          {result.fuel.calorificUnit ?? 'GJ/kL'} × {result.fuel.carbonFactor}{' '}
          {result.fuel.carbonFactorUnit ?? 'tC/GJ'} × 44/12 ＝{' '}
          <strong className="font-semibold">{n(result.emissionsT, 10)} t-CO2</strong>
          <span className="ml-1 text-caption text-ink-muted">
            （熱量 {n(result.fuel.gj, 6)} GJ・炭素 {n(result.fuel.tc, 8)} tC）
          </span>
        </p>
      ) : (
        <p className="tnum">
          {n(result.convertedAmount, 6)} {result.convertedUnit} × {result.factorValue}{' '}
          {result.factorUnit} ＝{' '}
          <strong className="font-semibold">{n(result.emissionsT, 10)} t-CO2</strong>
        </p>
      )}
      <p className="text-caption text-ink-muted">
        係数: {result.factorSetCode}（{result.factorSetVersion}）・{result.factorYear} 年
      </p>
      <Path text={result.resolutionPath} />
    </Step>
  );
}

function ScopeStep({ index, result }: { index: number; result: TrialResult }) {
  return (
    <Step index={index} title="区分">
      <p>
        既定区分 {GHG_SCOPE_LABELS[result.protocolScope]} ／ 報告区分{' '}
        {GHG_SCOPE_LABELS[result.reportedScope]}
        {result.protocolScope !== result.reportedScope && (
          <SemanticBadge semantic="info" label="組織の算定ルールで再分類" className="ml-1" />
        )}
      </p>
    </Step>
  );
}

function TransportSteps({ line, result }: { line: GhgActivityLine; result: TrialResult }) {
  const t = result.transport!;
  const c = t.coefficients;
  return (
    <ol className="space-y-1.5">
      <Step index={1} title="輸送トンキロ">
        <p className="tnum">
          {t.tonKmSource === 'input'
            ? `ファイルの t·km ${n(t.tonKm, 3)} t·km`
            : `${n(line.cargoWeightT, 3)} t × ${n(line.distanceKm, 3)} km ＝ ${n(t.tonKm, 6)} t·km`}
        </p>
      </Step>
      <Step index={2} title="燃料使用原単位（L/(t·km)）">
        <p className="flex flex-wrap items-center gap-1">
          <StatusBadge domain="ghgLoadFactorSource" value={t.loadFactorSource} />
          <span>算定に使う積載率 {n(t.loadFactorUsed, 2)}%</span>
          {t.loadFactorSource === 'floored' && (
            <span className="text-caption text-ink-muted">
              （ファイルの積載率 {n(line.loadFactorPct, 2)}%）
            </span>
          )}
        </p>
        {t.intensitySource === 'formula' ? (
          <p className="tnum">
            {t.shape === 'log' ? (
              <>
                対数式 x ＝ e<sup>{c.lnA}</sup> ÷ ({n(t.loadFactorUsed, 2)}/100)<sup>{c.S}</sup> ÷{' '}
                {n(line.maxPayloadKg, 0)}
                <sup>{c.B}</sup>
              </>
            ) : (
              <>
                告示の形 x ＝ {c.A} ÷ ({n(t.loadFactorUsed, 2)}/100)<sup>{c.S}</sup> ÷{' '}
                {n(line.maxPayloadKg, 0)}
                <sup>{c.B}</sup>
              </>
            )}{' '}
            ＝ 未丸め {n(t.intensityRaw, 10)} → 算定に使う値 <strong>{t.intensity}</strong>
          </p>
        ) : (
          <p className="tnum">
            見なし積載率の原単位表（最大積載量 {n(line.maxPayloadKg, 0)} kg の区分・見なし積載率{' '}
            {n(t.loadFactorUsed, 2)}%）＝ <strong>{t.intensity}</strong>
          </p>
        )}
        <Path text={t.intensityPath} />
      </Step>
      <Step index={3} title="燃料使用量">
        <p className="tnum">
          {n(t.tonKm, 6)} t·km × {t.intensity} ＝ {n(t.fuelLiters, 6)} L →{' '}
          {n(result.convertedAmount, 9)} {result.convertedUnit}
        </p>
        <Conversion result={result} />
      </Step>
      <Co2Step index={4} result={result} />
      <ScopeStep index={5} result={result} />
    </ol>
  );
}

function OtherSteps({ result }: { result: TrialResult }) {
  return (
    <ol className="space-y-1.5">
      <Step index={1} title={`活動量（${GHG_METHOD_LABELS[result.method]}）`}>
        <p className="tnum">
          {n(result.activityAmount, 6)} {result.activityUnit}
          {result.activityUnit !== result.convertedUnit &&
            ` → ${n(result.convertedAmount, 9)} ${result.convertedUnit}`}
        </p>
        <Conversion result={result} />
      </Step>
      <Co2Step index={2} result={result} />
      <ScopeStep index={3} result={result} />
    </ol>
  );
}

export function TrialSteps({
  line,
  trial,
}: {
  line: GhgActivityLine;
  trial: LineTrial | undefined;
}) {
  if (!trial || trial.error) {
    return (
      <p className="flex flex-wrap items-center gap-1 text-small text-ink">
        <SemanticBadge semantic="error" label="試算できません" />
        {trial?.error ?? '試算の結果がありません。'}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-trial-steps={line.lineNo}>
      {trial.results.map((result, index) => (
        <div key={`${result.method}-${index}`} className="space-y-1">
          {trial.results.length > 1 && (
            <p className="text-caption font-semibold text-ink-muted">
              {GHG_METHOD_LABELS[result.method]}
            </p>
          )}
          {result.transport ? (
            <TransportSteps line={line} result={result} />
          ) : (
            <OtherSteps result={result} />
          )}
          {result.warnings.length > 0 && (
            <p className="flex flex-wrap gap-1">
              {result.warnings.map((w) => (
                <SemanticBadge key={w} semantic="blocked" label={trialWarningLabel(w)} />
              ))}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
