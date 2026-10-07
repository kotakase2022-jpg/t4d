import Link from 'next/link';
import { ArrowRight, Ban, CircleCheck, CircleDashed, Clock, TriangleAlert } from 'lucide-react';
import { CategoryGrid, type CategoryGridItem } from '@/components/charts/category-grid';
import { FractionBar } from '@/components/charts/fraction-bar';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  DIAGNOSIS_STATE_LABEL,
  type DiagnosisArea,
  type DiagnosisFact,
  type DiagnosisScope3,
} from '@/lib/services/analysis/diagnosis';
import { DiagnosisStateBadge } from './analysis-badges';

/**
 * 現状診断の 1 領域（docs/disclosure-first.md §9.6・§10.4）。
 * 事実は「n / 分母 単位」を独立した文字で示し、帯（FractionBar）は補助。割合・点数にしない。
 * 各事実と領域に直す画面へのリンクを置く。
 *
 * 文字を減らすため（§10.4）: 数値の出所は「数値の出所」、拠点別の表は既定で閉じる。
 * 状態・理由・分母・GHG の拠点表（n / N 拠点）・権限なしの注記は閉じない。
 */

function AttentionBadge({ attention }: { attention: DiagnosisFact['attention'] }) {
  if (attention === 'gap') {
    return (
      <Badge tone="warning">
        <TriangleAlert className="size-3" aria-hidden="true" />
        要対応
      </Badge>
    );
  }
  if (attention === 'pending') {
    return (
      <Badge tone="brand">
        <Clock className="size-3" aria-hidden="true" />
        確認待ち
      </Badge>
    );
  }
  return null;
}

/**
 * 事実の行き先。帯の名前（label）は FractionBar が文字で書くため、リンクは短い「見る」にし、
 * 何を見るかは aria-label で伝える（表示の文字「見る」を名前に含める。WCAG 2.5.3）
 */
function FactLink({ fact }: { fact: DiagnosisFact }) {
  if (!fact.href) return null;
  return (
    <Link
      href={fact.href}
      aria-label={`${fact.label}を見る`}
      className="inline-flex items-center gap-0.5 text-caption text-brand-700 hover:underline"
    >
      見る
      <ArrowRight className="size-3" aria-hidden="true" />
    </Link>
  );
}

function FactItem({ fact, showDenominator }: { fact: DiagnosisFact; showDenominator: boolean }) {
  const footer =
    fact.attention !== null ||
    fact.href !== null ||
    (showDenominator && fact.denominatorLabel && fact.count !== null);
  return (
    <li className="min-w-0 space-y-1 rounded-t4d border border-line px-2.5 py-1.5">
      {fact.count !== null && fact.denominator !== null ? (
        <FractionBar
          label={fact.label}
          numerator={fact.count}
          denominator={fact.denominator}
          unit={fact.unitLabel}
        />
      ) : (
        // 分母の無い事実・値の無い事実（未算定など）は帯にしない（0 の帯を描かない）
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-small">
          <span className="text-ink">{fact.label}</span>
          <span className="tnum font-medium text-ink">
            {fact.count === null ? (fact.text ?? '—') : `${fact.count} ${fact.unitLabel}`}
          </span>
        </div>
      )}
      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <AttentionBadge attention={fact.attention} />
            {showDenominator && fact.denominatorLabel && fact.count !== null && (
              <span className="text-caption text-ink-muted">分母: {fact.denominatorLabel}</span>
            )}
          </span>
          <FactLink fact={fact} />
        </div>
      )}
    </li>
  );
}

/** 件数を持つ事実の分母がすべて同じなら、その分母（1 回だけ書く）。違えば null（事実ごとに書く） */
function sharedDenominatorOf(facts: readonly DiagnosisFact[]): string | null {
  const counted = facts.filter((f) => f.count !== null);
  const labels = new Set(counted.map((f) => f.denominatorLabel));
  if (counted.length < 2 || labels.size !== 1) return null;
  return counted[0]?.denominatorLabel ?? null;
}

function FactList({ facts }: { facts: DiagnosisFact[] }) {
  if (facts.length === 0) return null;
  const shared = sharedDenominatorOf(facts);
  return (
    <div className="space-y-1">
      <ul className="grid gap-x-3 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        {facts.map((f) => (
          <FactItem key={f.key} fact={f} showDenominator={shared === null} />
        ))}
      </ul>
      {shared && <p className="text-caption text-ink-muted">分母: {shared}</p>}
    </div>
  );
}

const nameList = (names: string[]) => (names.length === 0 ? '—' : names.join('、'));

/**
 * Scope3 の 15 カテゴリの格子。領域が持つのは未登録・未算定のカテゴリ名と件数だけなので、
 * 残りのカテゴリは「値あり」「対象外と判断」のどちらか一方しか無いときだけ言い切る
 * （両方あるときは「値か対象外判断あり」。どれがどれかは GHG 画面の格子で示す）
 */
function scope3GridItems(scope3: DiagnosisScope3): CategoryGridItem[] {
  const pending = new Set(scope3.pendingLabels);
  const settled =
    scope3.notApplicableCount === 0
      ? { stateLabel: '値あり', icon: CircleCheck }
      : scope3.presentCount === 0
        ? { stateLabel: '対象外と判断', icon: Ban }
        : { stateLabel: '値か対象外判断あり', icon: CircleCheck };
  return Array.from({ length: scope3.categoryTotal }, (_, index) => {
    const label = `Cat.${index + 1}`;
    return pending.has(label)
      ? { key: label, label, stateLabel: '未登録・未算定', icon: CircleDashed, filled: false }
      : { key: label, label, stateLabel: settled.stateLabel, icon: settled.icon, filled: true };
  });
}

export function DiagnosisAreaSection({ area }: { area: DiagnosisArea }) {
  const headingId = `diagnosis-${area.key}`;
  // GHG の Scope1・2 の「承認済みの拠点 n / N」は下の表と同じ事実なので、帯を重ねて出さない
  const ghgCodes = new Set((area.ghg ?? []).map((row) => row.code));
  const facts = area.facts.filter((f) => !ghgCodes.has(f.key));
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2.5 rounded-t4d-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-title-sm font-semibold text-ink">
          {area.title}
        </h2>
        <DiagnosisStateBadge state={area.state} label={area.stateLabel} />
      </div>
      <p className="text-small text-ink">{area.stateReason}</p>

      <FactList facts={facts} />

      {area.units && area.units.length > 0 && (
        <Collapsible variant="plain" summary={`拠点別の承認状況（${area.units.length} 拠点）`}>
          <div className="t4d-scroll-x">
            <Table>
              <caption className="px-2 pb-1 text-left text-small font-medium text-ink">
                拠点別の承認状況（サプライヤーを除く）
              </caption>
              <THead>
                <TR>
                  <TH>拠点</TH>
                  <TH align="right">承認済み / 総数</TH>
                  <TH align="right">未提出</TH>
                  <TH align="right">レビュー待ち</TH>
                  <TH align="right">検証エラー</TH>
                </TR>
              </THead>
              <TBody>
                {area.units.map((row) => (
                  <TR key={row.unitId}>
                    <th scope="row" className="px-2 text-left text-small font-medium">
                      <Link href={row.href} className="text-brand-700 hover:underline">
                        {row.unitName}
                      </Link>
                    </th>
                    <TD align="right" className="text-small">
                      {row.total === 0 ? '項目なし' : `${row.approved} / ${row.total} 件`}
                    </TD>
                    <TD align="right" className="text-small">
                      {row.notSubmitted} 件
                    </TD>
                    <TD align="right" className="text-small">
                      {row.reviewPending} 件
                    </TD>
                    <TD align="right" className="text-small">
                      {row.validationErrors} 件
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Collapsible>
      )}

      {area.ghg && (
        <div className="space-y-2">
          <div className="t4d-scroll-x">
            <Table>
              <caption className="px-2 pb-1 text-left text-small font-medium text-ink">
                Scope1・Scope2 の承認済み拠点（連結対象の拠点が分母）
              </caption>
              <THead>
                <TR>
                  <TH>区分</TH>
                  <TH align="right">承認済み / 対象</TH>
                  <TH>レビュー待ち</TH>
                  <TH>未提出</TH>
                  <TH>未入力</TH>
                  <TH>実績なし（推計・目標値のみ等）</TH>
                </TR>
              </THead>
              <TBody>
                {area.ghg.map((row) => (
                  <TR key={row.code}>
                    <th scope="row" className="px-2 text-left text-small font-medium">
                      <Link href={row.href} className="text-brand-700 hover:underline">
                        {row.label}
                      </Link>
                    </th>
                    <TD align="right" className="text-small">
                      {row.registered
                        ? `${row.approvedUnits} / ${row.expectedUnits} 拠点`
                        : '指標が未登録'}
                    </TD>
                    <TD className="text-small">{nameList(row.reviewUnits)}</TD>
                    <TD className="text-small">{nameList(row.unsubmittedUnits)}</TD>
                    <TD className="text-small">{nameList(row.missingUnits)}</TD>
                    <TD className="text-small">{nameList(row.noActualUnits)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {area.excludedUnitNames && area.excludedUnitNames.length > 0 && (
            <p className="text-caption text-ink-muted">
              持分法・連結対象外の拠点は分母に含めません: {area.excludedUnitNames.join('、')}
            </p>
          )}
          {area.scope3 && (
            <div className="space-y-1">
              <CategoryGrid
                label="Scope3 のカテゴリ（1〜15）の登録状況"
                items={scope3GridItems(area.scope3)}
                columns={5}
              />
              <p className="text-caption text-ink-muted">
                値あり {area.scope3.presentCount}・対象外と判断 {area.scope3.notApplicableCount}
                ・未登録・未算定 {area.scope3.pendingCount}（{area.scope3.categoryTotal}{' '}
                カテゴリ）。
                {area.scope3.totalValue === null
                  ? 'Cat.1 だけを Scope3 全量として扱いません。'
                  : '合計の登録値はカテゴリと照合するだけで、足し合わせません。'}
              </p>
            </div>
          )}
        </div>
      )}

      {area.frameworks && (
        <ul className="space-y-1.5">
          {area.frameworks.map((f) => (
            <li
              key={f.key}
              className="flex flex-wrap items-start gap-2 rounded-t4d border border-line px-2.5 py-1.5 text-small"
            >
              <span className="min-w-[96px] font-medium text-ink">{f.name}</span>
              <DiagnosisStateBadge state={f.state} label={DIAGNOSIS_STATE_LABEL[f.state]} />
              <span className="min-w-0 flex-1 text-ink">{f.line}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <nav aria-label={`${area.title}を直す画面`} className="flex flex-wrap gap-x-3 gap-y-1">
          {area.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
            >
              {link.label}
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          ))}
        </nav>
        <MoreInfo label="数値の出所">
          <p>出所: {area.source}</p>
        </MoreInfo>
      </div>
    </section>
  );
}
