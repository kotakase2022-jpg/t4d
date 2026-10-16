import * as React from 'react';
import Link from 'next/link';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import type { RoundingRule } from '@/types/domain';
import { formatStageValue, type SiteResultRow } from './calc-view';

/**
 * 拠点別の結果（plan §2.4 P90 の「拠点別の結果」。GHG サマリー・算定明細でも同じ表）。
 *
 * 列: 拠点〔国〕・Scope1〔報告区分〕・うち再分類分・Scope2 ロケーション・Scope2 マーケット・
 * Scope3 カテゴリ4〔既定区分の参考〕・（警告）・状態。値は拠点×区分の段の丸め後。値の無い区分は「—」（0 にしない）。
 * 状態は登録簿 ghgSiteStatus のラベル＋アイコン（色だけにしない）
 */
export function SiteResultsTable({
  rows,
  rounding,
  caption,
  siteHref,
  showStatus = true,
}: {
  rows: readonly SiteResultRow[];
  rounding: readonly RoundingRule[];
  caption: string;
  /** 拠点名のリンク先（例: 算定明細をその拠点で絞る）。無ければ文字だけ */
  siteHref?: (unitId: string) => string;
  showStatus?: boolean;
}) {
  const value = (v: number | null) =>
    v === null ? '—' : formatStageValue(v, rounding, 'site_scope');
  return (
    <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <TR>
            <TH>拠点（国）</TH>
            <TH align="right">
              Scope1<span className="normal-case">（報告区分）</span>
            </TH>
            <TH align="right">うち再分類分</TH>
            <TH align="right">
              Scope2<span className="normal-case">（ロケーション基準）</span>
            </TH>
            <TH align="right">
              Scope2<span className="normal-case">（マーケット基準）</span>
            </TH>
            <TH align="right">
              Scope3 カテゴリ4<span className="normal-case">（既定区分・参考）</span>
            </TH>
            {showStatus && <TH>状態</TH>}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.unitId} data-site-row={row.unitCode}>
              <TD>
                <span className="flex flex-wrap items-center gap-x-1.5">
                  {siteHref ? (
                    <Link
                      href={siteHref(row.unitId)}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {row.unitName}
                    </Link>
                  ) : (
                    <span className="font-medium">{row.unitName}</span>
                  )}
                  <span className="text-caption text-ink-muted">
                    （{row.countryCode}・{row.domestic ? '国内' : '海外'}）
                  </span>
                  {row.warningLines > 0 && (
                    <SemanticBadge
                      semantic="blocked"
                      label={`警告 ${row.warningLines} 行`}
                      detail="見なし積載率・下限の適用・式の範囲外・海外拠点の輸送など、印の付いた算定行があります。"
                    />
                  )}
                </span>
              </TD>
              <TD align="right">{value(row.scope1)}</TD>
              <TD align="right">
                {row.reclassifiedToScope1 === null ? '—' : value(row.reclassifiedToScope1)}
              </TD>
              <TD align="right">{value(row.scope2Location)}</TD>
              <TD align="right">{value(row.scope2Market)}</TD>
              <TD align="right">{value(row.scope3Cat4Protocol)}</TD>
              {showStatus && (
                <TD>
                  {row.status ? (
                    <StatusBadge domain="ghgSiteStatus" value={row.status} />
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </TD>
              )}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
