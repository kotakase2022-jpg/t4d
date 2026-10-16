import { FractionBar } from '@/components/charts/fraction-bar';
import { SemanticBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { ACTIVITY_KIND_LABELS } from '@/lib/domain/ghg/calculate';
import type { ActivityCoverage } from '@/lib/services/ghg/activity-import';
import { monthLabel } from '../_lib/labels';

/**
 * 拠点 × 活動 × 月の充足（P94）。確定済みの行がある月だけを数える（確認中の行は別の列）。
 * 未受領の月は月の語で出す（色だけで示さない）。活動量が 1 行も無い検証拠点も行として出す
 */
export function CoverageTable({ coverage }: { coverage: ActivityCoverage }) {
  const total = coverage.months.length;
  return (
    <div className="t4d-scroll-x">
      <Table>
        <caption className="sr-only">拠点 × 活動の月の充足</caption>
        <THead>
          <TR>
            <TH>拠点（国）</TH>
            <TH>活動</TH>
            <TH className="w-col-md">確定済みの月</TH>
            <TH align="right">確定の行</TH>
            <TH align="right">確認中の行</TH>
            <TH>未受領の月</TH>
          </TR>
        </THead>
        <TBody>
          {coverage.sites.flatMap((site) => {
            const siteLabel = (
              <span className="text-small">
                <span className="font-medium text-ink">{site.unit.name}</span>
                <span className="ml-1 text-caption text-ink-muted">
                  {site.unit.code}・{site.unit.countryCode}
                  {site.overseas ? '・海外' : '・国内'}
                  {site.verification ? '' : '・検証対象外'}
                </span>
              </span>
            );
            if (site.kinds.length === 0) {
              return [
                <TR key={site.unit.id} data-coverage-site={site.unit.code}>
                  <TD>{siteLabel}</TD>
                  <TD>—</TD>
                  <TD>
                    <FractionBar label="確定済み" numerator={0} denominator={total} unit="か月" />
                  </TD>
                  <TD align="right">0</TD>
                  <TD align="right">0</TD>
                  <TD>
                    <SemanticBadge semantic="todo" label="活動量がありません" />
                  </TD>
                </TR>,
              ];
            }
            return site.kinds.map((k) => (
              <TR
                key={`${site.unit.id}-${k.kind}`}
                data-coverage-site={site.unit.code}
                data-coverage-kind={k.kind}
              >
                <TD>{siteLabel}</TD>
                <TD className="text-small">{ACTIVITY_KIND_LABELS[k.kind]}</TD>
                <TD>
                  <FractionBar
                    label="確定済み"
                    numerator={k.monthsCovered}
                    denominator={total}
                    unit="か月"
                  />
                </TD>
                <TD align="right" className="tnum">
                  {k.confirmedLines}
                </TD>
                <TD align="right" className="tnum">
                  {k.draftLines > 0 ? (
                    <SemanticBadge semantic="draft" label={`確認中 ${k.draftLines}`} />
                  ) : (
                    0
                  )}
                </TD>
                <TD className="text-caption">
                  {k.missingMonths.length === 0 ? (
                    <SemanticBadge semantic="done" label="すべて受領" />
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <SemanticBadge
                        semantic="pending"
                        label={`未受領 ${k.missingMonths.length} か月`}
                      />
                      <span className="text-ink-muted">
                        {k.missingMonths.slice(0, 3).map(monthLabel).join('・')}
                        {k.missingMonths.length > 3 && ` ほか ${k.missingMonths.length - 3}`}
                      </span>
                    </span>
                  )}
                </TD>
              </TR>
            ));
          })}
        </TBody>
      </Table>
    </div>
  );
}
