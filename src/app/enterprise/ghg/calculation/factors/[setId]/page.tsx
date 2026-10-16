import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Archive, CheckCircle2, Link2 } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { NotFoundError, can } from '@/lib/authorization/can';
import {
  EMISSION_BASIS_LABELS,
  FACTOR_KIND_LABELS,
  FUEL_ECONOMY_CLASS_LABELS,
  VEHICLE_USE_LABELS,
} from '@/lib/domain/ghg/factor-import';
import type { TransportDefaultParams, TransportFormulaParams } from '@/lib/domain/ghg/tonkm';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { needLabel } from '@/lib/services/ghg/assignments';
import { loadFactorSet, type FactorSetDetail } from '@/lib/services/ghg/factor-sets';
import {
  FUEL_ECONOMY_CLASSES,
  type EmissionFactor,
  type EmissionFactorAssignment,
  type FactorActivityKind,
} from '@/types/domain';
import { calcTabHref, CalcNav } from '../../_components/calc-nav';
import { loadCalcContext } from '../../_components/calc-context';
import { activateFactorSetAction, retireFactorSetAction } from '../actions';
import { PeriodContext } from '../_components/s1-chrome';

export const metadata = { title: '係数セットの詳細' };

type SearchParams = Record<string, string | string[] | undefined>;

const n = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : formatNumber(value, { fraction: 12 });

function validity(factor: EmissionFactor): string {
  if (!factor.validFrom && !factor.validTo) return '—';
  return `${factor.validFrom ? formatJstDate(factor.validFrom) : ''}〜${factor.validTo ? formatJstDate(factor.validTo) : ''}`;
}

function payloadRange(min: number | null | undefined, max: number | null | undefined): string {
  if ((min === null || min === undefined) && (max === null || max === undefined)) return '指定なし';
  return `${min !== null && min !== undefined ? `${formatNumber(min)} kg 以上` : ''}${max !== null && max !== undefined ? ` ${formatNumber(max)} kg 未満` : ''}`.trim();
}

/**
 * P92 係数のセットの詳細（plan §2.4・CR-01・CR-16。S1）。
 *
 * - 種類ごとの表（燃料・ガス・熱: 単位発熱量・炭素排出係数・1 段の値／電力: 国・基準・年度／改良トンキロ法の式:
 *   燃費区分ごとの A・B・S／見なし積載率の原単位表）。値は保存した桁のまま
 * - 出所のバッジは出所で出し分ける（架空〔Fixture〕のときだけ「架空値（実係数ではありません）」。組織指定の係数を
 *   架空と書かない。plan K13）
 * - 主な操作は「有効にする」（下書きのときだけ。確認ダイアログ: 有効にすると係数は変更できない）。取り下げは「その他」
 */
export default async function GhgFactorSetPage({
  params,
  searchParams,
}: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ setId = '' }, query] = await Promise.all([params, searchParams]);
  const { shell, period, status } = await loadCalcContext(query);
  const { ctx, db } = shell;
  let detail: FactorSetDetail;
  try {
    detail = await loadFactorSet(db, ctx, decodeURIComponent(setId));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { set, factors, assignments } = detail;
  const canManage = can(ctx, 'enterprise.metric.manage');
  const byKind = (kinds: readonly FactorActivityKind[]) =>
    factors.filter((f) => f.activityKind !== null && kinds.includes(f.activityKind));
  const fuels = byKind(['fuel', 'gas', 'heat']);
  const electricity = byKind(['electricity']);
  const formulas = byKind(['transport_formula']);
  const defaults = byKind(['transport_default']);
  const name = (id: string | null) => (id ? (detail.names.get(id) ?? '—') : '—');
  const openAssignments = assignments.length;
  const scope = `${set.code}（${set.versionLabel || '版なし'}）・係数 ${factors.length} 件`;

  return (
    <>
      <PageHeader
        title={set.name}
        breadcrumbsTail={[{ label: set.code }]}
        context={
          <PeriodContext period={period} demo={ctx.demo}>
            <span className="font-mono text-caption">{set.code}</span>
            <StatusBadge domain="ghgFactorSet" value={set.status} />
            <StatusBadge domain="factorOrigin" value={set.origin} />
            {set.origin === 'fixture' && (
              <SemanticBadge semantic="blocked" label="架空値（実係数ではありません）" />
            )}
          </PeriodContext>
        }
        actions={
          <PageActions
            primary={{
              kind: 'confirm',
              id: 'activate-factor-set',
              label: '有効にする',
              icon: <CheckCircle2 aria-hidden="true" />,
              action: activateFactorSetAction,
              fields: { setId: set.id },
              hidden: !canManage || set.status !== 'draft',
              disabledReason:
                factors.length === 0 ? '係数の無いセットは有効にできません。' : undefined,
              confirm: {
                tier: 'irreversible',
                title: 'この係数のセットを有効にしますか',
                scope,
                consequences: [
                  '有効にすると係数は変更できません（変えるときは新しいセットを取り込みます）。',
                  '有効にしたセットの係数を、排出係数の画面の「割当」で期間・拠点・国に割り当てて使います。',
                ],
                confirmLabel: '有効にする',
                destructive: false,
              },
            }}
            secondary={[
              {
                kind: 'link',
                id: 'open-assignments',
                label: '割当を見る',
                icon: <Link2 aria-hidden="true" />,
                href: `/enterprise/ghg/calculation/factors?view=assignments&period=${encodeURIComponent(period.id)}`,
              },
            ]}
            more={[
              {
                kind: 'confirm',
                id: 'retire-factor-set',
                label: '取り下げる…',
                icon: <Archive aria-hidden="true" />,
                action: retireFactorSetAction,
                fields: { setId: set.id },
                hidden: !canManage || set.status !== 'active',
                destructive: true,
                confirm: {
                  tier: 'irreversible',
                  title: 'この係数のセットを取り下げますか',
                  scope,
                  consequences: [
                    `このセットの係数を使う割当（${openAssignments} 件）は残りますが、算定は「セットが有効ではありません」のエラーになります（別の係数を黙って使いません）。割当を別のセットの係数に替えてください。`,
                    '取り下げたセットは戻せません。過去の算定の記録は、記録した係数の値のまま残ります。',
                  ],
                  reason: {
                    name: 'reason',
                    label: '取り下げの理由（任意）',
                    required: false,
                    maxLength: 300,
                  },
                  confirmLabel: '取り下げる',
                },
              },
            ]}
          />
        }
      />
      <CalcNav current="factors" periodId={period.id} attention={status.attention} />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={query} />
        {ctx.demo && <GhgNotice id="N9" />}
        {set.status === 'draft' && (
          <Notice tone="info" title="下書きのセットです">
            算定には使いません。係数を確かめてから「有効にする」を押してください（有効にした後は変更できません）。
          </Notice>
        )}
        {set.status === 'retired' && (
          <Notice tone="warning" title="取り下げたセットです">
            このセットの係数を割り当てた活動は、算定でエラーになります。割当を別のセットの係数に替えてください。
          </Notice>
        )}

        <MetricStrip label="係数のセットの内容">
          <MetricTile label="係数" value={factors.length} />
          <MetricTile label="燃料・ガス・熱" value={fuels.length} />
          <MetricTile label="電力" value={electricity.length} />
          <MetricTile label="改良トンキロ法" value={formulas.length + defaults.length} />
          <MetricTile label="割当（全期間）" value={openAssignments} />
        </MetricStrip>

        <Section title="セットの情報">
          <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-[auto_1fr] lg:grid-cols-[auto_1fr_auto_1fr]">
            <dt className="text-ink-muted">出所</dt>
            <dd>
              <StatusBadge domain="factorOrigin" value={set.origin} />
            </dd>
            <dt className="text-ink-muted">出典</dt>
            <dd>{set.sourceLabel || '—'}</dd>
            <dt className="text-ink-muted">版</dt>
            <dd>{set.versionLabel || '—'}</dd>
            <dt className="text-ink-muted">公表日・基準年</dt>
            <dd>
              {set.publishedOn ? formatJstDate(set.publishedOn) : '—'} ／ {set.referenceYear ?? '—'}
            </dd>
            <dt className="text-ink-muted">作成</dt>
            <dd>
              {name(set.createdBy)}（{formatJst(set.createdAt)}）
            </dd>
            <dt className="text-ink-muted">有効化</dt>
            <dd>
              {set.activatedAt
                ? `${name(set.activatedBy)}（${formatJst(set.activatedAt)}）`
                : 'まだ有効にしていません'}
            </dd>
            {set.retiredAt && (
              <>
                <dt className="text-ink-muted">取り下げ</dt>
                <dd>
                  {name(set.retiredBy)}（{formatJst(set.retiredAt)}）
                </dd>
              </>
            )}
            {set.notes && (
              <>
                <dt className="text-ink-muted">メモ</dt>
                <dd className="whitespace-pre-wrap">{set.notes}</dd>
              </>
            )}
          </dl>
        </Section>

        {factors.length === 0 && (
          <EmptyState
            kind="not-applicable"
            title="係数がありません"
            description="このセットには係数がありません。係数セットを取り込み直してください。"
          />
        )}

        {fuels.length > 0 && (
          <Section title={`燃料・ガス・熱（${fuels.length}）`}>
            <div className="t4d-scroll-x">
              <Table>
                <caption className="sr-only">燃料・ガス・熱の係数</caption>
                <THead>
                  <TR>
                    <TH>コード</TH>
                    <TH>名称</TH>
                    <TH>種類・活動</TH>
                    <TH>国</TH>
                    <TH align="right">年度</TH>
                    <TH align="right">単位発熱量</TH>
                    <TH align="right">炭素排出係数</TH>
                    <TH align="right">1 段の係数</TH>
                    <TH>適用期間</TH>
                    <TH>出典</TH>
                  </TR>
                </THead>
                <TBody>
                  {fuels.map((f) => (
                    <TR key={f.id}>
                      <TD className="font-mono text-caption">{f.code}</TD>
                      <TD>{f.name}</TD>
                      <TD className="text-small">
                        {f.activityKind ? FACTOR_KIND_LABELS[f.activityKind] : '—'}・
                        <span className="font-mono text-caption">{f.activityCode}</span>
                      </TD>
                      <TD>{f.countryCode ?? '—'}</TD>
                      <TD align="right" className="tnum">
                        {f.factorYear}
                      </TD>
                      <TD align="right" className="tnum text-small">
                        {f.calorificValue !== null
                          ? `${n(f.calorificValue)} ${f.calorificUnit ?? ''}`
                          : '—'}
                      </TD>
                      <TD align="right" className="tnum text-small">
                        {f.carbonFactor !== null
                          ? `${n(f.carbonFactor)} ${f.carbonFactorUnit ?? ''}`
                          : '—'}
                      </TD>
                      <TD align="right" className="tnum text-small">
                        {n(f.factorValue)} {f.factorUnit}
                        {f.calorificValue !== null && (
                          <span className="block text-caption text-ink-muted">
                            2 段係数から（表示用）
                          </span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-caption">{validity(f)}</TD>
                      <TD className="text-caption text-ink-muted">{f.factorSource}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Section>
        )}

        {electricity.length > 0 && (
          <Section title={`電力（${electricity.length}）`}>
            <div className="t4d-scroll-x">
              <Table>
                <caption className="sr-only">電力の係数</caption>
                <THead>
                  <TR>
                    <TH>コード</TH>
                    <TH>名称</TH>
                    <TH>基準</TH>
                    <TH>国・契約</TH>
                    <TH align="right">年度</TH>
                    <TH align="right">係数</TH>
                    <TH>適用期間</TH>
                    <TH>出典</TH>
                  </TR>
                </THead>
                <TBody>
                  {electricity.map((f) => (
                    <TR key={f.id}>
                      <TD className="font-mono text-caption">{f.code}</TD>
                      <TD>{f.name}</TD>
                      <TD>{f.basis ? EMISSION_BASIS_LABELS[f.basis] : '—'}</TD>
                      <TD className="text-small">
                        {f.countryCode ?? '国の指定なし'}
                        {f.activityCode !== 'grid' && (
                          <span className="ml-1 font-mono text-caption text-ink-muted">
                            契約 {f.activityCode}
                          </span>
                        )}
                      </TD>
                      <TD align="right" className="tnum">
                        {f.factorYear}
                      </TD>
                      <TD align="right" className="tnum text-small">
                        {n(f.factorValue)} {f.factorUnit}
                      </TD>
                      <TD className="whitespace-nowrap text-caption">{validity(f)}</TD>
                      <TD className="text-caption text-ink-muted">{f.factorSource}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Section>
        )}

        {formulas.map((f) => {
          const params = f.params as unknown as TransportFormulaParams;
          const classes = FUEL_ECONOMY_CLASSES.filter((c) => params.classes?.[c]);
          return (
            <Section key={f.id} title={`改良トンキロ法の式: ${f.name}（${f.factorYear} 年度）`}>
              <p className="pb-1 text-small text-ink-muted">
                x ＝ A ÷ (積載率/100)^S ÷ 最大積載量(kg)^B（L/t·km）。S ＝ {n(params.S)}。燃料{' '}
                <span className="font-mono">{f.activityCode}</span>・コード{' '}
                <span className="font-mono">{f.code}</span>
              </p>
              <div className="t4d-scroll-x">
                <Table>
                  <caption className="sr-only">{f.name} の燃費区分ごとの係数</caption>
                  <THead>
                    <TR>
                      <TH>燃費区分</TH>
                      <TH align="right">A</TH>
                      <TH align="right">B</TH>
                      <TH align="right">対数式の定数</TH>
                      <TH>最大積載量の範囲</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {classes.map((c) => {
                      const cls = params.classes[c]!;
                      return (
                        <TR key={c}>
                          <TD>{FUEL_ECONOMY_CLASS_LABELS[c]}</TD>
                          <TD align="right" className="tnum">
                            {n(cls.A)}
                          </TD>
                          <TD align="right" className="tnum">
                            {n(cls.B)}
                          </TD>
                          <TD align="right" className="tnum">
                            {n(cls.lnA)}
                          </TD>
                          <TD className="text-small">
                            {payloadRange(cls.payloadMinKg, cls.payloadMaxKg)}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </Section>
          );
        })}

        {defaults.map((f) => {
          const params = f.params as unknown as TransportDefaultParams;
          const classes = FUEL_ECONOMY_CLASSES.filter((c) =>
            (params.table ?? []).some((row) => row.values[c] !== undefined),
          );
          return (
            <Section key={f.id} title={`見なし積載率の原単位表: ${f.name}（${f.factorYear} 年度）`}>
              <p className="pb-1 text-small text-ink-muted">
                積載率が分からない行に使う原単位（L/t·km）。燃料{' '}
                <span className="font-mono">{f.activityCode}</span>
                ・コード <span className="font-mono">{f.code}</span>
                。表に無い区分（—）は算定でエラーになります。
              </p>
              <div className="t4d-scroll-x">
                <Table>
                  <caption className="sr-only">{f.name} の区分ごとの原単位</caption>
                  <THead>
                    <TR>
                      <TH>用途</TH>
                      <TH>最大積載量の区分</TH>
                      <TH align="right">見なし積載率</TH>
                      {classes.map((c) => (
                        <TH key={c} align="right">
                          {FUEL_ECONOMY_CLASS_LABELS[c]}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {(params.table ?? []).map((row) => (
                      <TR key={`${row.vehicleUse}-${row.minKg}-${row.maxKg}`}>
                        <TD>{VEHICLE_USE_LABELS[row.vehicleUse]}</TD>
                        <TD className="text-small">{payloadRange(row.minKg, row.maxKg)}</TD>
                        <TD align="right" className="tnum">
                          {n(row.loadPct)}%
                        </TD>
                        {classes.map((c) => (
                          <TD key={c} align="right" className="tnum">
                            {n(row.values[c])}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Section>
          );
        })}

        <Section title={`このセットの係数を使う割当（${assignments.length}）`}>
          {assignments.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="割当はありません"
              description={
                set.status === 'active'
                  ? '排出係数の画面の「割当」で、期間・拠点・国に割り当てます。'
                  : '有効にしたセットの係数だけを割り当てられます。'
              }
              action={
                <Link
                  href={calcTabHref('factors', period.id)}
                  className="text-small text-brand-700 hover:underline"
                >
                  排出係数の画面へ
                </Link>
              }
            />
          ) : (
            <AssignmentTable
              assignments={assignments}
              factors={factors}
              periodLabels={detail.periodLabels}
              unitNames={detail.unitNames}
            />
          )}
        </Section>
      </div>
    </>
  );
}

function AssignmentTable({
  assignments,
  factors,
  periodLabels,
  unitNames,
}: {
  assignments: EmissionFactorAssignment[];
  factors: EmissionFactor[];
  periodLabels: Map<string, string>;
  unitNames: Map<string, string>;
}) {
  const factorById = new Map(factors.map((f) => [f.id, f]));
  return (
    <div className="t4d-scroll-x">
      <Table>
        <caption className="sr-only">このセットの係数を使う割当</caption>
        <THead>
          <TR>
            <TH>期間</TH>
            <TH>範囲</TH>
            <TH>活動</TH>
            <TH>係数</TH>
            <TH>理由</TH>
          </TR>
        </THead>
        <TBody>
          {assignments.map((a) => (
            <TR key={a.id}>
              <TD className="text-small">{periodLabels.get(a.reportingPeriodId) ?? '—'}</TD>
              <TD className="text-small">
                {a.unitId
                  ? `拠点 ${unitNames.get(a.unitId) ?? '（不明）'}`
                  : a.countryCode
                    ? `国 ${a.countryCode}`
                    : '全社既定'}
              </TD>
              <TD className="text-small">{needLabel(a.activityKind, a.activityCode, a.basis)}</TD>
              <TD className="font-mono text-caption">{factorById.get(a.factorId)?.code ?? '—'}</TD>
              <TD className="text-caption text-ink-muted">{a.reason || '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
