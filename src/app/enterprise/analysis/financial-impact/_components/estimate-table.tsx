import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  FINANCIAL_LINE_LABEL,
  describeFormula,
  fiscalYearLabel,
  formatMillionYen,
  type PathwayId,
  type PathwayResult,
  type SimulationInput,
  type SimulationResult,
} from '@/lib/domain/financial-impact';
import { formatNumber } from '@/lib/format/datetime';
import type { ImpactOrigin, RelatedItem } from '@/lib/services/analysis/financial-impact';
import { EvidenceBadges, ImpactValue, PathwayStatusBadge, QuantifiedCount } from './impact-badges';
import { cellText, startText } from './format';

/**
 * 経路ごとの試算表（docs/disclosure-first.md §10.3。既定で閉じた中に置く）。
 * 起点の値と出所リンク、値を埋めた式、結果、根拠の種類、関連する定性情報・IRO を経路ごとに 1 行で示す。
 * 年次の内訳は「制度開始前」「時間差」の 0 と「未定量」を書き分ける（0 と未定量を混ぜない）。
 */

const RELATED_KIND_LABEL: Record<RelatedItem['kind'], string> = {
  iro: 'IRO',
  narrative: '定性',
  ssbj: 'SSBJ',
};

function OriginCell({
  result,
  origins,
}: {
  result: PathwayResult;
  origins: readonly ImpactOrigin[];
}) {
  const pathway = result.pathway;
  if (pathway.origin.kind === 'input') {
    return (
      <span className="text-[12px] text-ink">
        {pathway.origin.label}
        <span className="block text-[11px] text-ink-muted">入力値だけを使います</span>
      </span>
    );
  }
  const driver = pathway.origin.driver;
  const origin = origins.find((o) => o.driver === driver);
  if (!origin) return null;
  return (
    <span className="block space-y-0.5 text-[12px]">
      <span className="block text-ink">{origin.spec.label}</span>
      {origin.value !== null ? (
        <span className="tnum block font-semibold text-ink">
          {formatNumber(origin.value)} {origin.spec.unit}
          <span className="ml-1 text-[11px] font-normal text-ink-muted">
            （{origin.periodCode} 確定）
          </span>
        </span>
      ) : (
        <span className="block text-[11px] text-ink-muted">
          {origin.label}
          {origin.reason && `: ${origin.reason}`}
        </span>
      )}
      {origin.href && (
        <Link
          href={origin.href}
          className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
        >
          {origin.periodCode} の値はデータ一覧（年度はヘッダーで選ぶ）
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      )}
    </span>
  );
}

function RelatedCell({ id, related }: { id: PathwayId; related: readonly RelatedItem[] }) {
  if (related.length === 0) return <span className="text-[11px] text-ink-muted">—</span>;
  return (
    <ul className="space-y-0.5">
      {related.map((item) => (
        <li key={`${id}-${item.kind}-${item.href}-${item.label}`} className="text-[11px]">
          <span className="text-ink-muted">{RELATED_KIND_LABEL[item.kind]}: </span>
          <Link href={item.href} className="text-brand-700 hover:underline">
            {item.label}
          </Link>
          {item.note && <span className="block text-ink-muted">{item.note}</span>}
        </li>
      ))}
    </ul>
  );
}

export function EstimateTable({
  result,
  input,
  origins,
  relatedByPathway,
  referenceYear,
}: {
  result: SimulationResult;
  input: SimulationInput;
  origins: readonly ImpactOrigin[];
  relatedByPathway: Record<PathwayId, RelatedItem[]>;
  referenceYear: number;
}) {
  const reference = fiscalYearLabel(referenceYear);
  return (
    <div className="space-y-3">
      <div className="t4d-scroll-x">
        <Table className="min-w-[1180px]">
          <caption className="px-2 py-1 text-left text-[12px] font-semibold text-ink">
            経路ごとの試算（{reference} の 1 年分と 10 年累計。百万円、＋増益・−減益）
          </caption>
          <THead>
            <TR>
              <TH>経路</TH>
              <TH>起点</TH>
              <TH>時期</TH>
              <TH>式（{reference} の値を埋めた式）</TH>
              <TH align="right">{reference} の影響</TH>
              <TH align="right">10 年累計</TH>
              <TH>根拠の種類</TH>
              <TH>関連する定性情報・IRO</TH>
            </TR>
          </THead>
          <TBody>
            {result.pathways.map((r) => {
              const cell = r.years.find((y) => y.year === referenceYear) ?? null;
              return (
                <TR key={r.pathway.id} className="align-top">
                  <th
                    scope="row"
                    className="max-w-[200px] px-2 py-2 text-left align-top text-[12px]"
                  >
                    <span className="font-semibold text-ink">
                      {r.pathway.id} {r.pathway.mechanism}
                    </span>
                    <span className="block font-normal text-ink-muted">
                      → {FINANCIAL_LINE_LABEL[r.pathway.line]}
                    </span>
                    <span className="mt-0.5 block font-normal">
                      <PathwayStatusBadge status={r.status} />
                    </span>
                  </th>
                  <TD className="max-w-[220px] py-2 align-top">
                    <OriginCell result={r} origins={origins} />
                  </TD>
                  <TD className="max-w-[150px] py-2 align-top text-[11px] text-ink">
                    時間差 {r.lag} 年・{startText(r)}
                    {r.pathway.startYear !== null && (
                      <span className="block text-ink-muted">
                        制度の開始 {fiscalYearLabel(r.pathway.startYear)}
                      </span>
                    )}
                  </TD>
                  <TD className="max-w-[320px] py-2 align-top text-[11px]">
                    <span className="block text-ink-muted">{r.pathway.formula}</span>
                    <span className="block text-ink">
                      {describeFormula(r, input, referenceYear)}
                    </span>
                    {r.pathway.note && (
                      <span className="block text-ink-muted">{r.pathway.note}</span>
                    )}
                  </TD>
                  <TD align="right" className="py-2 align-top">
                    {r.status === 'quantified' && cell && cell.note !== null ? (
                      // 制度開始前・時間差の 0 は「変化なし」と区別して注記する
                      <span className="tnum whitespace-nowrap text-[12px] text-ink">
                        {cellText(cell, r.pathway.preStartLabel)} 百万円
                      </span>
                    ) : r.status === 'quantified' ? (
                      <ImpactValue value={cell?.value ?? null} />
                    ) : (
                      <span className="text-[11px] text-ink-muted">{r.reason}</span>
                    )}
                  </TD>
                  <TD align="right" className="py-2 align-top">
                    {r.status === 'quantified' ? (
                      <ImpactValue value={r.cumulative} />
                    ) : (
                      <span className="text-[11px] text-ink-muted">—</span>
                    )}
                  </TD>
                  <TD className="py-2 align-top">
                    <EvidenceBadges kinds={r.evidence} />
                  </TD>
                  <TD className="max-w-[260px] py-2 align-top">
                    <RelatedCell id={r.pathway.id} related={relatedByPathway[r.pathway.id]} />
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      {/* 年度の列は折り返して幅に収める（中にリンクの無い表を横スクロールにしない） */}
      <div className="t4d-scroll-x">
        <Table>
          <caption className="px-2 py-1 text-left text-[12px] font-semibold text-ink">
            年次の内訳（百万円。制度開始前・時間差の年は 0、未定量は 0 にしません）
          </caption>
          <THead>
            <TR>
              <TH>経路</TH>
              {result.years.map((year) => (
                <TH key={year} align="right">
                  {fiscalYearLabel(year)}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {result.pathways.map((r) => (
              <TR key={r.pathway.id}>
                <th scope="row" className="px-2 py-1 text-left text-[12px] font-normal text-ink">
                  {r.pathway.id} {r.pathway.mechanism}
                </th>
                {r.years.map((cell) => (
                  <TD
                    key={cell.year}
                    align="right"
                    className={`tnum py-1 text-[11px] ${cell.value === null ? 'text-ink-muted' : 'text-ink'}`}
                  >
                    {r.status === 'disabled' ? '無効' : cellText(cell, r.pathway.preStartLabel)}
                  </TD>
                ))}
              </TR>
            ))}
            <TR>
              <th scope="row" className="px-2 py-1 text-left text-[12px] font-semibold text-ink">
                年合計
                <span className="block font-normal">
                  <QuantifiedCount
                    quantified={result.quantifiedCount}
                    enabled={result.enabledCount}
                  />
                </span>
              </th>
              {result.totals.map((total, index) => (
                <TD
                  key={result.years[index]}
                  align="right"
                  className="tnum py-1 text-[11px] font-semibold"
                >
                  {total === null ? '未定量' : formatMillionYen(total)}
                </TD>
              ))}
            </TR>
          </TBody>
        </Table>
      </div>
    </div>
  );
}
