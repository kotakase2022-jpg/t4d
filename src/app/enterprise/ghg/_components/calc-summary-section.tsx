import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { CompanyRuleNotice, PendingRuleNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatJst } from '@/lib/format/datetime';
import { statusLabel } from '@/lib/ui/status/registry';
import { GHG_SITE_STATUSES } from '@/lib/domain/ghg/verification-status';
import { showsCompanyRuleBadge, type GhgCalcSummaryData } from './calc-data';
import { siteResultRows } from './calc-view';
import { DualViewTable } from './dual-view-table';
import { SiteResultsTable } from './site-results-table';

/**
 * GHG 算定サマリーの「Scope1・2 の算定と照合」（plan §2.4 GHG サマリー・CR-09・CR-16）。
 * 算定の検証期間の拠点別の状態・最新の記録の報告区分の値と、概要（P90）への入口。
 * 係数の出所のバッジ（架空〔デモ〕・組織指定・公的参照）は、記録が使った係数セットの origin で出す（無条件に出さない）。
 * 区分規則の注記（N1・N2）は折りたたみに入れない。
 */
export function CalcSummarySection({ data }: { data: GhgCalcSummaryData }) {
  const { period, status, view } = data;
  const units = status.units.map((u) => u.unit);
  const run = status.latestRun;
  const summary = run?.summary ?? null;
  const rows = siteResultRows(summary, units, {
    organizationCountryCode: data.organizationCountryCode,
    statuses: new Map(status.units.map((u) => [u.unit.id, u.status.overall])),
  });
  const breakdown = GHG_SITE_STATUSES.map((s) => ({
    status: s,
    count: status.units.filter((u) => u.status.overall === s).length,
  })).filter((b) => b.count > 0);
  const overviewHref = `/enterprise/ghg/calculation?period=${encodeURIComponent(period.id)}`;
  const hasCompanyRule = showsCompanyRuleBadge(view);
  return (
    <Section
      id="ghg-calculation"
      title="Scope1・2 の算定と照合"
      summary={`${period.label}・拠点 ${units.length}`}
      actions={
        <Link
          href={overviewHref}
          className="inline-flex items-center gap-0.5 text-small text-brand-700 hover:underline"
        >
          Scope1・2算定を開く
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      }
    >
      <div className="space-y-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-small text-ink">
          <span>
            期間 {period.label}
            {run
              ? `・最新の算定 ${formatJst(run.createdAt)}（記録 #${run.id.slice(0, 8)}）`
              : '・まだ算定していません'}
          </span>
          {view.sets.map((set) => (
            <span key={set.id} className="inline-flex items-center gap-1">
              <span className="text-caption text-ink-muted">係数 {set.name}</span>
              <StatusBadge domain="factorOrigin" value={set.origin} />
            </span>
          ))}
          {hasCompanyRule && <HonestyBadge kind="company-rule" />}
        </div>
        {breakdown.length > 0 && (
          <p className="text-caption text-ink-muted">
            拠点の状態:{' '}
            {breakdown
              .map((b) => `${statusLabel('ghgSiteStatus', b.status)} ${b.count}`)
              .join('・')}
          </p>
        )}
        {view.appliedRules.map(({ rule, approverName }) => (
          <CompanyRuleNotice
            key={rule.id}
            ruleName={rule.name}
            approvedAt={rule.approvedAt ?? rule.updatedAt}
            approverName={approverName}
          />
        ))}
        {view.pendingRules.map((rule) => (
          <PendingRuleNotice key={rule.id} ruleName={rule.name} />
        ))}
        {units.length === 0 ? (
          <p className="text-small text-ink-muted">
            活動量 × 排出係数による Scope1・2
            の算定の拠点はまだありません。トライアルの算定の検証範囲で拠点を選ぶと、ここに拠点別の状態を出します。
          </p>
        ) : (
          <>
            <SiteResultsTable
              rows={rows}
              rounding={view.policy?.rounding ?? []}
              caption="Scope1・2 の算定の拠点別の結果"
            />
            <p className="text-caption text-ink-muted">
              単位 t-CO2e。値は最新の算定の記録の報告区分（拠点×区分の段の丸め後）で、Data Point
              の確定値ではありません。上の連結集計・Scope 別集計は承認済みの Data Point
              から集計しています。
            </p>
            {summary && (
              <div className="space-y-1">
                <h3 className="text-small font-semibold text-ink">報告区分と既定区分</h3>
                <DualViewTable
                  summary={summary}
                  rounding={view.policy?.rounding ?? []}
                  rules={view.rules}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
