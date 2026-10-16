import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, Scale, Send } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { CompanyRuleNotice, GhgNotice, LoadFactorNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can, NotFoundError } from '@/lib/authorization/can';
import {
  GHG_METHOD_LABELS,
  GHG_SCOPE_LABELS,
  LINE_WARNING_LABELS,
  activityLabel,
} from '@/lib/domain/ghg/calculate';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { loadRun } from '@/lib/services/ghg/calculation';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import {
  POSTING_ACTION_LABELS,
  planRunPosting,
  runShortId,
} from '@/lib/services/ghg/post-to-data-points';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import { isUuid } from '@/lib/validation/uuid';
import { GHG_METHODS, GHG_SCOPES, type GhgCalculationLine } from '@/types/domain';
import { loadProfileNames, loadRunViewContext } from '../../../_components/calc-data';
import {
  RUN_INPUT_STATE_VIEW,
  formatStageValue,
  formatUnrounded,
  roundingPolicyText,
  siteResultRows,
} from '../../../_components/calc-view';
import { DualViewTable } from '../../../_components/dual-view-table';
import { SiteResultsTable } from '../../../_components/site-results-table';
import { CalcNav } from '../../_components/calc-nav';
import { LineDetail } from '../_components/line-detail';
import { postGhgRunToDataPointsAction } from '../actions';

export const metadata = { title: '算定明細' };

/*
 * P96 算定明細（plan §2.4・CR-08・CR-09・CR-10・CR-15）。
 * 主操作は「Data Point に下書き反映」（確認ダイアログ・区分 2 一括／上書き）。CSV 出力（E18）は副操作。
 * 記録の数値は Demo の作り直し（plan K11）で入力ハッシュが合わなければ出さない（「入力が変わった」）。
 * 誠実さの注記（N9・N1・N5・N7）は折りたたみに入れない。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function values(params: SearchParams, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v : typeof v === 'string' && v !== '' ? [v] : [];
}

export default async function GhgRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { runId } = await params;
  const query = await searchParams;
  if (!isUuid(runId)) notFound();
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const loaded = await loadRun(db, ctx, runId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { run, inputState, lines } = loaded;
  const period = shell.periods.find((p) => p.id === run.reportingPeriodId);
  if (!period) notFound();
  const summary = run.summary;
  const short = runShortId(run.id);
  const demo = ctx.demo;

  const [view, plan, names, status] = await Promise.all([
    loadRunViewContext(db, ctx, run, period, shell.periods),
    planRunPosting(db, ctx, run.id),
    loadProfileNames(db, [run.createdBy]),
    loadGhgVerificationStatus(db, ctx, { periodId: period.id, unitIds: run.unitIds }),
  ]);
  const rounding = view.policy?.rounding ?? [];
  const units = run.unitIds
    .map((id) => shell.units.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u));
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const ruleName = new Map(view.rules.map((r) => [r.id, `${r.code} ${r.name}`]));
  const organization = await db.findById('organizations', ctx.workspace.organizationId);
  const organizationCountry = organization?.countryCode ?? 'JP';

  // ---- 算定行の絞り込み・ページ送り（サーバー側） ----
  const unitFilter = values(query, 'unit');
  const scopeFilter = values(query, 'scope');
  const methodFilter = values(query, 'method');
  const warnOnly = values(query, 'warn').includes('1');
  const q = typeof query.q === 'string' ? query.q.trim().normalize('NFKC').toLowerCase() : '';
  const filtered = lines.filter((line) => {
    if (unitFilter.length > 0 && !unitFilter.includes(line.unitId)) return false;
    if (scopeFilter.length > 0 && !scopeFilter.includes(line.reportedScope)) return false;
    if (methodFilter.length > 0 && !methodFilter.includes(line.method)) return false;
    if (warnOnly && line.warnings.length === 0) return false;
    if (q) {
      const text = [
        unitName.get(line.unitId) ?? '',
        line.month.slice(0, 7),
        activityLabel(line.activityKind, line.activityCode),
        GHG_METHOD_LABELS[line.method],
        line.resolutionPath,
        line.factorSetCode,
      ]
        .join(' ')
        .normalize('NFKC')
        .toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
  const pageSize = parsePageSize(query.size);
  const page = parsePage(query.page);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const basePath = `/enterprise/ghg/calculation/runs/${encodeURIComponent(run.id)}`;

  const filters: FilterGroup[] = [
    {
      key: 'unit',
      label: '拠点',
      options: units.map((u) => ({ value: u.id, label: u.name })),
    },
  ];
  const overflowFilters: FilterGroup[] = [
    {
      key: 'scope',
      label: '報告区分',
      options: GHG_SCOPES.map((s) => ({ value: s, label: GHG_SCOPE_LABELS[s] })),
    },
    {
      key: 'method',
      label: '算定方法',
      options: GHG_METHODS.map((m) => ({ value: m, label: GHG_METHOD_LABELS[m] })),
    },
    { key: 'warn', label: '警告', options: [{ value: '1', label: '警告のある行' }] },
  ];

  const lineColumns: DataTableColumn<GhgCalculationLine>[] = [
    {
      key: 'unit',
      header: '拠点',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (line) => <span className="font-medium">{unitName.get(line.unitId) ?? '—'}</span>,
    },
    {
      key: 'month',
      header: '月',
      importance: 'primary',
      cell: (line) => <span className="tnum">{line.month.slice(0, 7)}</span>,
    },
    {
      key: 'activity',
      header: '活動',
      importance: 'primary',
      cell: (line) => activityLabel(line.activityKind, line.activityCode),
    },
    {
      key: 'method',
      header: '方法',
      importance: 'detail',
      cell: (line) => GHG_METHOD_LABELS[line.method],
    },
    {
      key: 'amount',
      header: '活動量→換算後',
      importance: 'secondary',
      align: 'right',
      // 表示で丸め直さない（plan §2.0）。小さい換算後の量・係数（例 0.000441 t-CO2/kWh）を 0 にしない
      cell: (line) => (
        <span className="whitespace-nowrap">
          {formatUnrounded(line.activityAmount)} {line.activityUnit} →{' '}
          {formatUnrounded(line.convertedAmount)} {line.convertedUnit}
        </span>
      ),
    },
    {
      key: 'factor',
      header: '係数',
      importance: 'secondary',
      align: 'right',
      cell: (line) => (
        <span className="text-small">
          {formatUnrounded(line.factorValue)} {line.factorUnit}
          <span className="block text-caption text-ink-muted">
            {line.factorYear} 年・{line.factorSetCode} {line.factorSetVersion}
          </span>
        </span>
      ),
    },
    {
      key: 'path',
      header: '係数の解決経路',
      importance: 'detail',
      cell: (line) => <span className="text-caption">{line.resolutionPath}</span>,
    },
    {
      key: 'unrounded',
      header: '排出量（未丸め）',
      importance: 'primary',
      align: 'right',
      cell: (line) => formatUnrounded(line.emissionsUnrounded),
    },
    {
      key: 'rounded',
      header: '排出量（行の丸め後）',
      importance: 'detail',
      align: 'right',
      cell: (line) =>
        line.roundingApplied ? formatStageValue(line.emissionsRounded, rounding, 'line') : '—',
    },
    {
      key: 'protocol',
      header: '既定区分',
      importance: 'secondary',
      cell: (line) => GHG_SCOPE_LABELS[line.protocolScope],
    },
    {
      key: 'reported',
      header: '報告区分',
      importance: 'primary',
      cell: (line) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {GHG_SCOPE_LABELS[line.reportedScope]}
          {line.reportedScope !== line.protocolScope && (
            <SemanticBadge
              semantic="info"
              label="再分類"
              detail={`既定区分 ${GHG_SCOPE_LABELS[line.protocolScope]} から、区分規則で移しました。`}
            />
          )}
        </span>
      ),
    },
    {
      key: 'warnings',
      header: '警告',
      importance: 'secondary',
      cell: (line) =>
        line.warnings.length === 0 ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {line.warnings.map((w) => (
              <SemanticBadge key={w} semantic="blocked" label={LINE_WARNING_LABELS[w] ?? w} />
            ))}
          </span>
        ),
    },
  ];

  // ---- 注記の条件 ----
  const overseasTransport = lines.some(
    (l) => l.method === 'tonkm_improved' && l.methodDetail.overseas === true,
  );
  const defaultRows = lines.filter((l) => l.warnings.includes('default_load_factor')).length;
  const flooredRows = lines.filter((l) => l.warnings.includes('load_floored')).length;

  // ---- 反映（主操作）の可否と確認の内訳 ----
  const c = plan.counts;
  const skipped = c.skip_in_review + c.skip_ambiguous + c.skip_no_metric;
  const postDisabledReason =
    plan.permissionReason ??
    plan.blockedReason ??
    (plan.postable === 0
      ? '反映する値がありません（すべて Data Point と同じ値か、反映できない状態です）。'
      : c.approved_overwrite > 0 && !plan.canOverwriteApproved
        ? '承認済みの値の上書きにはレビュー権限が必要です。レビュー担当へ依頼してください。'
        : undefined);
  const consequences = [
    `新規作成 ${c.create} 件・新しい版 ${c.new_version} 件・承認済みの上書き ${c.approved_overwrite} 件（変更なし ${c.unchanged} 件・反映しない ${skipped} 件）`,
    '値は「下書き」の新しい版（出所: 算定）として積みます。承認はしません。確定は承認フローで人が行います。',
    ...(c.approved_overwrite > 0
      ? ['承認済みの値は下書きに戻り、承認後の変更として記録されます。']
      : []),
    'Scope3 カテゴリ4（既定区分の参考）は反映しません。',
  ];
  const inputView = RUN_INPUT_STATE_VIEW[inputState];
  const hasReclassification = view.appliedRules.length > 0;

  return (
    <>
      <PageHeader
        title="算定明細"
        breadcrumbsTail={[{ label: `記録 #${short}` }]}
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>
              期間 {period.label}（{formatJstDate(period.startDate)}〜
              {formatJstDate(period.endDate)}）・記録 #{short}・{formatJst(run.createdAt)}・実行者{' '}
              {names.get(run.createdBy) ?? '—'}
            </span>
            <SemanticBadge
              semantic={inputView.semantic}
              label={inputView.label}
              detail={inputView.detail}
            />
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
            {hasReclassification && <HonestyBadge kind="company-rule" />}
          </span>
        }
        help={
          <p>
            算定の記録（追記だけ）の行ごとに、活動量・換算・係数（値・年度・版・解決の経路）・未丸めの排出量・丸め・既定区分と報告区分を示します。各行の「詳細を開く」で段ごとの値を確かめられます。
          </p>
        }
        actions={
          <PageActions
            primary={{
              kind: 'confirm',
              id: 'post-to-data-points',
              label: 'Data Point に下書き反映',
              icon: <Send aria-hidden="true" />,
              action: postGhgRunToDataPointsAction,
              fields: { runId: run.id },
              disabledReason: postDisabledReason,
              confirm: {
                tier: 'bulk',
                title: '報告区分の値を Data Point に下書きとして反映しますか',
                scope: `${period.label}・算定の記録 #${short}（${run.unitIds.length} 拠点 × Scope1・Scope2 の 2 基準）`,
                consequences,
                acknowledge:
                  c.approved_overwrite > 0
                    ? {
                        name: 'acknowledgeApprovedOverwrite',
                        label: `承認済みの値 ${c.approved_overwrite} 件を下書きに戻すことを確認しました`,
                      }
                    : undefined,
                confirmLabel: '下書きとして反映する',
              },
            }}
            secondary={[
              {
                kind: 'link',
                id: 'export-calculation-csv',
                label: 'CSV を出力',
                icon: <Download aria-hidden="true" />,
                href: `/api/exports/ghg-calculation?run=${encodeURIComponent(run.id)}`,
                download: true,
                hidden: !can(ctx, 'enterprise.export.run'),
                disabledReason: summary
                  ? undefined
                  : '入力が変わったため、この記録の明細を出力できません。',
              },
              {
                // 照合の欄をこの記録を選んだ状態で開く（照合は開いた画面で許容差を入れて人が押す）
                kind: 'link',
                id: 'reconcile-this-run',
                label: 'この記録で照合する',
                icon: <Scale aria-hidden="true" />,
                href: `/enterprise/ghg/calculation/reconciliation?period=${encodeURIComponent(period.id)}&reconcile=1&run=${encodeURIComponent(run.id)}#reconcile`,
                hidden: !can(ctx, 'enterprise.data.write'),
                disabledReason: summary
                  ? undefined
                  : '入力が変わったため、この記録では照合できません。算定し直してから照合してください。',
              },
            ]}
          />
        }
      />
      <CalcNav current="overview" periodId={period.id} attention={status.attention} />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {demo && <GhgNotice id="N9" />}
        {inputState === 'stale' && (
          <Notice tone="warning" title="入力が変わりました（再算定が必要）">
            {RUN_INPUT_STATE_VIEW.stale.detail} 表の値は記録の時点のものです。Data Point
            へは反映できません。
          </Notice>
        )}
        {view.appliedRules.map(({ rule, approverName }) => (
          <CompanyRuleNotice
            key={rule.id}
            ruleName={rule.name}
            approvedAt={rule.approvedAt ?? rule.updatedAt}
            approverName={approverName}
          />
        ))}
        {overseasTransport && <GhgNotice id="N5" />}
        {view.policy && (
          <LoadFactorNotice
            defaultRows={defaultRows}
            minLoadPct={view.policy.tonkm.minLoadPct}
            flooredRows={flooredRows}
          />
        )}

        {!summary ? (
          <EmptyState
            kind="not-applicable"
            title="この記録の数値を表示できません"
            description={RUN_INPUT_STATE_VIEW.input_changed.detail}
            action={
              <Link
                href={`/enterprise/ghg/calculation?period=${encodeURIComponent(period.id)}`}
                className="text-small text-brand-700 underline underline-offset-2"
              >
                概要へ戻って算定をやり直す
              </Link>
            }
          />
        ) : (
          <>
            <Section title="報告区分と既定区分" divider="none">
              <div className="py-1.5">
                <DualViewTable summary={summary} rounding={rounding} rules={view.rules} />
              </div>
            </Section>

            <Section title="拠点別の結果" summary={roundingPolicyText(rounding)}>
              <div className="py-1.5">
                <SiteResultsTable
                  rows={siteResultRows(summary, units, {
                    organizationCountryCode: organizationCountry,
                  })}
                  rounding={rounding}
                  caption="拠点別の結果（この記録）"
                  showStatus={false}
                />
              </div>
            </Section>

            <Section
              id="ghg-run-posting"
              title="Data Point への反映（報告区分）"
              summary={`反映先 ${plan.targets.length} 件（書き込む ${plan.postable} 件）`}
            >
              <div className="space-y-1.5 py-1.5">
                {plan.blockedReason && <Notice tone="info">{plan.blockedReason}</Notice>}
                <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
                  <Table>
                    <caption className="sr-only">Data Point への反映（報告区分）</caption>
                    <THead>
                      <TR>
                        <TH>拠点</TH>
                        <TH>指標</TH>
                        <TH align="right">反映する値</TH>
                        <TH align="right">Data Point の値</TH>
                        <TH>Data Point の状態</TH>
                        <TH>反映の扱い</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {plan.targets.map((t) => (
                        <TR key={`${t.unitId}-${t.scope}`} data-posting-action={t.action}>
                          <TD>{t.unitName}</TD>
                          <TD>
                            {t.dataPoint ? (
                              <Link
                                href={`/enterprise/data/${t.dataPoint.id}`}
                                className="text-brand-700 hover:underline"
                              >
                                {t.metricName}
                              </Link>
                            ) : (
                              t.metricName
                            )}
                          </TD>
                          <TD align="right">{formatStageValue(t.value, rounding, 'site_scope')}</TD>
                          <TD align="right">
                            {t.dataPoint ? formatNumber(t.dataPoint.value) : '—（未作成）'}
                          </TD>
                          <TD>
                            {t.dataPoint ? (
                              <StatusBadge domain="dataPoint" value={t.dataPoint.status} />
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </TD>
                          <TD className="text-small">
                            {POSTING_ACTION_LABELS[t.action]}
                            {t.reason && (
                              <span className="block text-caption text-ink-muted">{t.reason}</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <p className="text-caption text-ink-muted">
                  単位 t-CO2e。反映は下書きの新しい版（出所: 算定）で、承認はしません。算定内訳に「Σ
                  算定行（記録 #{short}）」を残します。
                </p>
              </div>
            </Section>

            <Section
              id="ghg-run-lines"
              title="算定行"
              summary={`${lines.length.toLocaleString('ja-JP')} 行`}
            >
              <DataTable<GhgCalculationLine>
                id="ghg-run-lines"
                caption="算定行"
                columns={lineColumns}
                rows={paged}
                getRowId={(line) => line.id}
                getRowLabel={(line) =>
                  `${unitName.get(line.unitId) ?? ''} ${line.month.slice(0, 7)} ${activityLabel(line.activityKind, line.activityCode)}`
                }
                getRowStatus={(line) => (line.warnings.length > 0 ? '警告あり' : undefined)}
                searchParams={query}
                basePath={basePath}
                filters={filters}
                overflowFilters={overflowFilters}
                search={{ placeholder: '拠点・月・活動・係数の経路で検索' }}
                page={{ page, pageSize, total: filtered.length, sizes: [25, 50, 100] }}
                expand={(line) => (
                  <LineDetail
                    line={line}
                    ruleName={
                      line.classificationRuleId
                        ? (ruleName.get(line.classificationRuleId) ?? null)
                        : null
                    }
                  />
                )}
                empty={{
                  noData: {
                    title: 'この記録に算定行がありません',
                    action: (
                      <Link
                        href={`/enterprise/ghg/calculation?period=${encodeURIComponent(period.id)}`}
                        className="text-small text-brand-700 underline underline-offset-2"
                      >
                        概要へ戻る
                      </Link>
                    ),
                  },
                }}
              />
            </Section>
          </>
        )}
      </div>
    </>
  );
}
