import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileSpreadsheet, NotebookPen, RefreshCw } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/states';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can, NotFoundError } from '@/lib/authorization/can';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { BASELINE_GRANULARITY_LABELS } from '@/lib/services/ghg/baseline-import';
import {
  loadReconciliation,
  type LoadedReconciliation,
  type ReconciliationItemView,
} from '@/lib/services/ghg/reconciliation';
import {
  isResidualItem,
  noteCommentLimit,
  notePermissionReason,
} from '@/lib/services/ghg/reconciliation-notes';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import {
  listWhatIfAlternatives,
  whatIfForReconciliation,
  type WhatIfAlternative,
  type WhatIfItemResult,
  type WhatIfResult,
} from '@/lib/services/ghg/what-if';
import { isUserFacingError } from '@/lib/errors/user-facing';
import { statusEntry, statusLabel } from '@/lib/ui/status/registry';
import { isUuid } from '@/lib/validation/uuid';
import { GHG_CAUSES, GHG_RECON_VERDICTS, GHG_SCOPES, type GhgReconVerdict } from '@/types/domain';
import { loadCalcContext } from '../../_components/calc-context';
import { CALC_DETAIL_HREF, CalcNav } from '../../_components/calc-nav';
import {
  formatT,
  ItemBreakdown,
  itemActivityText,
  itemLabel,
  MainCauseBadge,
  VERDICT_ORDER,
} from '../_components/item-parts';
import {
  orderLabel,
  reconciliationDetailHref,
  reconciliationListHref,
  toleranceSummary,
} from '../_components/reconcile-options';
import { PreservingForm } from '@/components/shared/preserving-form';
import { recordCauseAction } from '../actions';

export const metadata = { title: '照合の詳細' };

type Query = Record<string, string | string[] | undefined>;

function param(query: Query, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isVerdict(value: string | null): value is GhgReconVerdict {
  return value !== null && (GHG_RECON_VERDICTS as readonly string[]).includes(value);
}

/** 仮説の再計算の結果の表に出す行の上限（それ以上は件数だけ） */
const WHAT_IF_ROWS = 50;

export default async function GhgReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (!isUuid(id)) notFound();
  const calc = await loadCalcContext(query);
  const { shell } = calc;
  const { db, ctx } = shell;
  let loaded: LoadedReconciliation;
  try {
    loaded = await loadReconciliation(db, ctx, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { reconciliation, run, baseline } = loaded;
  // 照合の期間は記録の期間（URL の期間と違えば、タブの件数もその期間で数える）
  const period = shell.periods.find((p) => p.id === run.reportingPeriodId) ?? calc.period;
  const attention =
    period.id === calc.period.id
      ? calc.status.attention
      : (
          await loadGhgVerificationStatus(db, ctx, {
            periodId: period.id,
            unitIds: calc.unitIds,
          })
        ).attention;

  const demo = ctx.demo;
  const canReview = notePermissionReason(ctx) === null;
  const canExport = can(ctx, 'enterprise.export.run');
  const basePath = CALC_DETAIL_HREF.reconciliation(id);
  const items = loaded.items;

  const unitById = new Map(shell.units.map((u) => [u.id, u]));
  const unitName = (unitId: string | null) => {
    const unit = unitId ? unitById.get(unitId) : undefined;
    return unit ? `${unit.name}${unit.countryCode ? `（${unit.countryCode}）` : ''}` : '—';
  };
  const userIds = [
    ...new Set([
      reconciliation.createdBy,
      baseline.createdBy,
      ...(items ?? []).flatMap((i) => i.notes.map((n) => n.decidedBy)),
    ]),
  ];
  const profiles = await db.select('profiles', { where: { id: { in: userIds } } });
  const userName = (userId: string) =>
    profiles.find((p) => p.id === userId)?.displayName ?? '（不明な利用者）';

  const alternatives: WhatIfAlternative[] = items ? await listWhatIfAlternatives(db, ctx, id) : [];

  // 原因の記録の欄（?record=1&item=）
  const recordTarget = items?.find((i) => i.key === param(query, 'item')) ?? null;
  const recordOpen = canReview && recordTarget !== null && isCreatePanelOpen(query, 'record');
  const recordHref = (item: ReconciliationItemView) =>
    `${createPanelHref(basePath, { ...query, item: item.key }, { open: true, openParam: 'record' })}#record-cause`;

  // 仮説の再計算（?whatif=。保存しない）
  const whatIfKey = param(query, 'whatif');
  const whatIfItem = param(query, 'item');
  let whatIf: WhatIfResult | null = null;
  let whatIfError: string | null = null;
  if (whatIfKey && items) {
    try {
      whatIf = await whatIfForReconciliation(db, ctx, id, whatIfKey);
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      whatIfError = error.message;
    }
  }
  const whatIfHref = (item: ReconciliationItemView) =>
    alternatives.length > 0
      ? `${reconciliationDetailHref(id, period.id, { item: item.key })}#whatif`
      : null;

  // 項目の一覧（絞り込み・並べ替え・ページ送りは URL。サーバーで行う）
  const verdictFilter = param(query, 'verdict');
  const unitFilter = param(query, 'unit');
  const scopeFilter = param(query, 'scope');
  const search = (param(query, 'q') ?? '').trim().toLowerCase();
  const sort = param(query, 'sort');
  const dir = param(query, 'dir') === 'asc' ? 'asc' : 'desc';
  const filtered = (items ?? [])
    .filter((i) => (isVerdict(verdictFilter) ? i.verdict === verdictFilter : true))
    .filter((i) => (unitFilter ? i.unitId === unitFilter : true))
    .filter((i) => (scopeFilter ? i.scope === scopeFilter : true))
    .filter((i) => (search === '' ? true : itemLabel(i, unitName).toLowerCase().includes(search)))
    .sort((a, b) => {
      if (sort === 'diff') {
        const d = Math.abs(b.diff) - Math.abs(a.diff);
        return (dir === 'asc' ? -d : d) || a.key.localeCompare(b.key);
      }
      return (
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        Math.abs(b.diff) - Math.abs(a.diff) ||
        a.key.localeCompare(b.key)
      );
    });
  const pageSize = parsePageSize(query.size);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(parsePage(query.page), pageCount);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const unitsInItems = [...new Set((items ?? []).map((i) => i.unitId).filter(Boolean))] as string[];

  const columns: DataTableColumn<ReconciliationItemView>[] = [
    {
      key: 'unit',
      header: '拠点',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (i) => <span className="font-medium text-ink">{unitName(i.unitId)}</span>,
    },
    {
      key: 'scope',
      header: '区分（報告区分）',
      importance: 'primary',
      cell: (i) => GHG_SCOPE_LABELS[i.scope],
    },
    {
      key: 'activity',
      header: '活動',
      importance: 'primary',
      cell: (i) => <span className="text-small">{itemActivityText(i)}</span>,
    },
    {
      key: 't4d',
      header: 'T4D（t-CO2e）',
      importance: 'secondary',
      align: 'right',
      cell: (i) => <span className="tnum">{formatT(i.t4d)}</span>,
    },
    {
      key: 'baseline',
      header: '既存（t-CO2e）',
      importance: 'secondary',
      align: 'right',
      cell: (i) => <span className="tnum">{formatT(i.baseline)}</span>,
    },
    {
      key: 'diff',
      header: '差（既存−T4D）',
      importance: 'primary',
      align: 'right',
      sortKey: 'diff',
      cell: (i) => <span className="tnum">{formatT(i.diff)}</span>,
    },
    {
      key: 'diffPct',
      header: '差率（%）',
      importance: 'detail',
      align: 'right',
      cell: (i) => <span className="tnum">{i.diffPct === null ? '—' : formatT(i.diffPct)}</span>,
    },
    {
      key: 'verdict',
      header: '判定',
      importance: 'primary',
      cell: (i) => <StatusBadge domain="ghgReconItem" value={i.verdict} />,
    },
    {
      key: 'cause',
      header: '主な原因（寄与の最大）',
      importance: 'primary',
      cell: (i) => <MainCauseBadge item={i} />,
    },
    {
      key: 'note',
      header: '記録した原因',
      importance: 'detail',
      cell: (i) =>
        i.latestNote ? (
          <span className="inline-flex items-center gap-1">
            <StatusBadge domain="ghgCause" value={i.latestNote.confirmedCause} />
            <span className="text-caption text-ink-muted">{userName(i.latestNote.decidedBy)}</span>
          </span>
        ) : (
          '—'
        ),
    },
  ];

  const verdictHref = (verdict: GhgReconVerdict | null) =>
    reconciliationDetailHref(id, period.id, verdict ? { verdict } : {});
  const exportHref = `/api/exports/ghg-reconciliation?id=${id}`;

  return (
    <>
      <PageHeader
        title="照合の詳細"
        breadcrumbsTail={[{ label: `${formatJst(reconciliation.createdAt)} の照合` }]}
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>
              期間 {period.label}（{formatJstDate(period.startDate)}〜
              {formatJstDate(period.endDate)}）・算定の記録 {formatJst(run.createdAt)} ×
              既存の算定結果「
              {baseline.label}」
            </span>
            <HonestyBadge kind="consistency-check" />
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
          </span>
        }
        help="項目（拠点×区分×活動〔×月・出荷〕）ごとに、T4D の値と既存の値の差を、原因ごとの寄与と説明できない残差に分けて示します。判定は利用者が入れた許容差によります。原因は確認者が行の「原因を記録」で記録します（AI は関与しません）。"
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'export-reconciliation',
                label: 'XLSX を出力',
                icon: <FileSpreadsheet aria-hidden="true" />,
                href: exportHref,
                download: true,
                hidden: !canExport || items === null,
              },
              {
                kind: 'link',
                id: 'reconciliation-list',
                label: '照合の一覧へ',
                href: reconciliationListHref(period.id),
              },
            ]}
          />
        }
      />
      <CalcNav current="reconciliation" periodId={period.id} attention={attention} />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {demo && <GhgNotice id="N9" />}
        <GhgNotice id="N3" />

        {items === null ? (
          <>
            <Notice tone="warning" title="この照合の結果は作り直せません">
              照合の入力（算定の記録・既存の算定結果）が変わったか、照合の規則の版が違うため、数値を出していません。
              照合の一覧から、いまの算定の記録で照合し直してください。
            </Notice>
            <EmptyState
              kind="not-applicable"
              title="表示できる項目はありません"
              action={
                <Link
                  href={reconciliationListHref(period.id)}
                  className="text-small text-brand-700 underline-offset-2 hover:underline"
                >
                  照合の一覧へ
                </Link>
              }
            />
          </>
        ) : (
          <>
            <MetricStrip label="判定の内訳">
              <MetricTile
                label="項目"
                value={items.length}
                href={verdictHref(null)}
                hint="拠点×区分×活動（×月・出荷）"
              />
              {GHG_RECON_VERDICTS.map((verdict) => {
                const entry = statusEntry('ghgReconItem', verdict);
                return (
                  <MetricTile
                    key={verdict}
                    label={entry.label}
                    value={loaded.counts[verdict]}
                    denominator={items.length}
                    status={{ semantic: entry.semantic, label: entry.label }}
                    href={verdictHref(verdict)}
                  />
                );
              })}
            </MetricStrip>

            {recordOpen && recordTarget && (
              <CreatePanel
                id="record-cause"
                title="差異の原因を記録する"
                openParam="record"
                searchParams={query}
                closeHref={createPanelHref(basePath, query, { open: false, openParam: 'record' })}
                description="原因は確認者が決めます。照合の「主な原因」は寄与の最も大きい原因で、候補にすぎません。記録はあなたの名義で追記され、取り消せません（記録し直すと前の記録は差し替え済みとして残ります）。"
              >
                <div className="space-y-0.5 rounded-t4d bg-surface-muted px-3 py-2 text-small">
                  <p className="font-medium text-ink">{itemLabel(recordTarget, unitName)}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-ink-muted">
                    <span>
                      T4D {formatT(recordTarget.t4d)}・既存 {formatT(recordTarget.baseline)}・差{' '}
                      {formatT(recordTarget.diff)}（t-CO2e）
                    </span>
                    <StatusBadge domain="ghgReconItem" value={recordTarget.verdict} />
                    <span>主な原因:</span>
                    <MainCauseBadge item={recordTarget} />
                  </p>
                  {recordTarget.latestNote && (
                    <p className="text-caption text-ink-muted">
                      前の記録: {statusLabel('ghgCause', recordTarget.latestNote.confirmedCause)}（
                      {userName(recordTarget.latestNote.decidedBy)}・
                      {formatJst(recordTarget.latestNote.decidedAt)}）を差し替えます。
                    </p>
                  )}
                </div>
                <PreservingForm action={recordCauseAction} className="space-y-2">
                  <input type="hidden" name="reconciliationId" value={id} />
                  <input type="hidden" name="itemKey" value={recordTarget.key} />
                  <input type="hidden" name="periodId" value={period.id} />
                  <div className="grid gap-2 md:grid-cols-3">
                    <Field
                      id="record-cause-select"
                      label="原因"
                      required
                      hint="「その他」はコメントに原因を書いてください"
                    >
                      {(control) => (
                        <NativeSelect {...control} name="cause" defaultValue="">
                          <option value="">選んでください</option>
                          {GHG_CAUSES.map((cause) => (
                            <option key={cause} value={cause}>
                              {statusLabel('ghgCause', cause)}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    <Field
                      id="record-cause-comment"
                      label="コメント（何を確かめたか）"
                      required={isResidualItem(recordTarget)}
                      hint={`${noteCommentLimit(db)} 字まで。${isResidualItem(recordTarget) ? '原因不明（残差）の項目は必須です。' : '「その他」のときは必須です。'}`}
                      className="md:col-span-2"
                    >
                      {(control) => (
                        <Textarea
                          {...control}
                          name="comment"
                          rows={2}
                          maxLength={noteCommentLimit(db)}
                        />
                      )}
                    </Field>
                  </div>
                  <SubmitButton
                    variant="primary"
                    size="sm"
                    icon={<NotebookPen aria-hidden="true" />}
                    pendingLabel="記録中…"
                  >
                    原因を記録する
                  </SubmitButton>
                </PreservingForm>
              </CreatePanel>
            )}

            <Section title="区分ごとの合計" summary="項目の値の合計（t-CO2e）">
              <Table>
                <caption className="sr-only">区分ごとの合計</caption>
                <THead>
                  <TR>
                    <TH>区分（報告区分）</TH>
                    <TH align="right">T4D</TH>
                    <TH align="right">既存</TH>
                    <TH align="right">差（既存−T4D）</TH>
                  </TR>
                </THead>
                <TBody>
                  {GHG_SCOPES.flatMap((scope) => {
                    const total = reconciliation.result?.totals.find((t) => t.scope === scope);
                    return total
                      ? [
                          <TR key={scope}>
                            <TD className="font-medium">{GHG_SCOPE_LABELS[scope]}</TD>
                            <TD align="right" className="tnum">
                              {formatT(total.t4d)}
                            </TD>
                            <TD align="right" className="tnum">
                              {formatT(total.baseline)}
                            </TD>
                            <TD align="right" className="tnum">
                              {formatT(total.diff)}
                            </TD>
                          </TR>,
                        ]
                      : [];
                  })}
                </TBody>
              </Table>
              <p className="mt-1 text-caption text-ink-muted">
                Scope2 のロケーション基準とマーケット基準は別々の見方で、足し合わせません。
              </p>
            </Section>

            <Section title="項目ごとの差と原因" summary={`${filtered.length} 件`}>
              <GhgNotice id="N4" />
              <DataTable
                id="ghg-reconciliation-items"
                caption="項目ごとの差と原因"
                columns={columns}
                rows={pageRows}
                getRowId={(i) => i.key}
                getRowLabel={(i) => itemLabel(i, unitName)}
                getRowStatus={(i) => statusLabel('ghgReconItem', i.verdict)}
                searchParams={query}
                basePath={basePath}
                search={{ placeholder: '拠点・区分・活動で検索' }}
                filters={[
                  {
                    key: 'verdict',
                    label: '判定',
                    options: GHG_RECON_VERDICTS.map((v) => ({
                      value: v,
                      label: statusLabel('ghgReconItem', v),
                    })),
                  },
                ]}
                overflowFilters={[
                  {
                    key: 'unit',
                    label: '拠点',
                    options: unitsInItems.map((unitId) => ({
                      value: unitId,
                      label: unitName(unitId),
                    })),
                  },
                  {
                    key: 'scope',
                    label: '区分',
                    options: GHG_SCOPES.map((scope) => ({
                      value: scope,
                      label: GHG_SCOPE_LABELS[scope],
                    })),
                  },
                ]}
                page={{ page, pageSize, total: filtered.length, sizes: DEFAULT_PAGE_SIZES }}
                expand={(i) => (
                  <ItemBreakdown item={i} userName={userName} whatIfHref={whatIfHref(i)} />
                )}
                rowActions={(i) =>
                  canReview
                    ? {
                        rowLabel: itemLabel(i, unitName),
                        primary: {
                          kind: 'link',
                          id: `record-${i.key}`,
                          label: '原因を記録',
                          icon: <NotebookPen aria-hidden="true" />,
                          href: recordHref(i),
                        },
                      }
                    : null
                }
                empty={{
                  noData: {
                    title: '照合の項目がありません',
                    description: '算定の記録と既存の算定結果に、突き合わせる行がありませんでした。',
                    action: (
                      <Link
                        href={reconciliationListHref(period.id)}
                        className="text-small text-brand-700 underline-offset-2 hover:underline"
                      >
                        照合の一覧へ
                      </Link>
                    ),
                  },
                }}
              />
            </Section>

            <Section
              id="whatif"
              title="仮説の再計算（保存しません）"
              summary={
                whatIf
                  ? whatIf.alternative.label
                  : '別の前提で算定し直して、差がどう変わるかを見ます'
              }
            >
              <GhgNotice id="N8" />
              {alternatives.length === 0 ? (
                <p className="text-small text-ink-muted">この照合で選べる仮説はありません。</p>
              ) : (
                <form
                  method="get"
                  // 結果は節の中に出す（GET の送信は行き先の # を保つ）
                  action={`${basePath}#whatif`}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="period" value={period.id} />
                  {whatIfItem && <input type="hidden" name="item" value={whatIfItem} />}
                  <Field id="whatif-select" label="仮説" required className="min-w-80">
                    {(control) => (
                      <NativeSelect
                        {...control}
                        name="whatif"
                        defaultValue={whatIfKey ?? alternatives[0]!.key}
                      >
                        {alternatives.map((alternative) => (
                          <option key={alternative.key} value={alternative.key}>
                            {alternative.label}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    icon={<RefreshCw aria-hidden="true" />}
                  >
                    仮説で再計算する
                  </SubmitButton>
                  {whatIfItem && (
                    <Link
                      href={`${reconciliationDetailHref(id, period.id, whatIfKey ? { whatif: whatIfKey } : {})}#whatif`}
                      className="text-small text-brand-700 underline-offset-2 hover:underline"
                    >
                      全項目で見る
                    </Link>
                  )}
                </form>
              )}
              {whatIfError && (
                <Notice tone="danger" role="alert">
                  {whatIfError}
                </Notice>
              )}
              {whatIf && (
                <WhatIfResultView result={whatIf} focusKey={whatIfItem} unitName={unitName} />
              )}
            </Section>

            <Section
              title="確認の記録"
              summary={`${items.reduce((n, i) => n + i.notes.length, 0)} 件`}
            >
              <NotesTable items={items} unitName={unitName} userName={userName} />
            </Section>
          </>
        )}

        <Section
          id="conditions"
          title="照合の条件"
          collapsible
          summary={`許容差 ${toleranceSummary(reconciliation.tolerance)}`}
        >
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
            <dt className="text-ink-muted">許容差（利用者の入力）</dt>
            <dd>{toleranceSummary(reconciliation.tolerance) || '—'}</dd>
            <dt className="text-ink-muted">原因を揃える順序</dt>
            <dd>{orderLabel(reconciliation.attributionOrder)}</dd>
            <dt className="text-ink-muted">照合の規則の版</dt>
            <dd className="font-mono">{reconciliation.checkerVersion}</dd>
            <dt className="text-ink-muted">照合した人・日時</dt>
            <dd>
              {userName(reconciliation.createdBy)}・{formatJst(reconciliation.createdAt)}
            </dd>
            <dt className="text-ink-muted">算定の記録</dt>
            <dd>
              <Link
                href={CALC_DETAIL_HREF.run(run.id)}
                className="text-brand-700 underline-offset-2 hover:underline"
              >
                {formatJst(run.createdAt)} の算定（{run.unitIds.length} 拠点・算定行 {run.lineCount}{' '}
                行）
              </Link>
              <span className="ml-2 font-mono text-caption text-ink-muted">
                {run.engineVersion}・入力ハッシュ {run.inputHash.slice(0, 12)}
              </span>
            </dd>
            <dt className="text-ink-muted">既存の算定結果</dt>
            <dd>
              {baseline.label}（{BASELINE_GRANULARITY_LABELS[baseline.granularity]}・
              {baseline.rowCount} 行・取込 {userName(baseline.createdBy)}）
            </dd>
            <dt className="text-ink-muted">ファイル</dt>
            <dd>
              {baseline.fileName || '—'}
              <span className="ml-2 font-mono text-caption text-ink-muted">
                sha256 {baseline.fileSha256}
              </span>
            </dd>
          </dl>
        </Section>
      </div>
    </>
  );
}

function WhatIfResultView({
  result,
  focusKey,
  unitName,
}: {
  result: WhatIfResult;
  focusKey: string | null;
  unitName: (id: string | null) => string;
}) {
  const subKey = (key: string) => key.split('|').slice(2).join('|');
  const focus = focusKey ? result.items.find((i) => i.key === focusKey) : undefined;
  const rows: WhatIfItemResult[] = focus
    ? result.items.filter(
        (i) =>
          i.key === focus.key || (i.unitId === focus.unitId && subKey(i.key) === subKey(focus.key)),
      )
    : result.items
        .filter((i) => i.changed)
        .sort(
          (a, b) =>
            Number(b.closes) - Number(a.closes) ||
            Math.abs(b.before.diff) - Math.abs(a.before.diff) ||
            a.key.localeCompare(b.key),
        );
  const shown = rows.slice(0, WHAT_IF_ROWS);
  return (
    <div className="space-y-2" data-whatif-result={result.alternative.key}>
      <p className="text-small text-ink" role="status">
        仮説「{result.alternative.label}」: 差が変わる項目 {result.changedCount}{' '}
        件・許容差内になる項目 {result.closedCount} 件（全 {result.items.length} 項目）
      </p>
      <Table>
        <caption className="sr-only">区分ごとの合計（記録と仮説）</caption>
        <THead>
          <TR>
            <TH>区分</TH>
            <TH align="right">T4D（記録）</TH>
            <TH align="right">T4D（仮説）</TH>
            <TH align="right">差（記録）</TH>
            <TH align="right">差（仮説）</TH>
          </TR>
        </THead>
        <TBody>
          {result.totals.map((t) => (
            <TR key={t.scope}>
              <TD>{GHG_SCOPE_LABELS[t.scope]}</TD>
              <TD align="right" className="tnum">
                {formatT(t.before.t4d)}
              </TD>
              <TD align="right" className="tnum">
                {formatT(t.after?.t4d ?? null)}
              </TD>
              <TD align="right" className="tnum">
                {formatT(t.before.diff)}
              </TD>
              <TD align="right" className="tnum">
                {formatT(t.after?.diff ?? null)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {shown.length === 0 ? (
        <p className="text-small text-ink-muted">
          {focus ? 'この項目は仮説で差が変わりません。' : 'この仮説で差が変わる項目はありません。'}
        </p>
      ) : (
        <Table>
          <caption className="sr-only">仮説で差が変わる項目</caption>
          <THead>
            <TR>
              <TH>項目</TH>
              <TH align="right">既存</TH>
              <TH align="right">T4D（記録 → 仮説）</TH>
              <TH align="right">差（記録 → 仮説）</TH>
              <TH>仮説での判定</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((i) => (
              <TR key={i.key} data-whatif-item={i.key}>
                <TD className="text-small">
                  {unitName(i.unitId)}・{GHG_SCOPE_LABELS[i.scope]}・{itemActivityText(i)}
                </TD>
                <TD align="right" className="tnum">
                  {formatT(i.baseline)}
                </TD>
                <TD align="right" className="tnum">
                  {formatT(i.before.t4d)} → {formatT(i.after?.t4d ?? null)}
                </TD>
                <TD align="right" className="tnum">
                  {formatT(i.before.diff)} → {formatT(i.after?.diff ?? null)}
                </TD>
                <TD>
                  {i.after === null ? (
                    <SemanticBadge semantic="info" label="仮説では項目なし" />
                  ) : i.after.withinTolerance ? (
                    <SemanticBadge
                      semantic="done"
                      label={i.closes ? '許容差内になる' : '許容差内'}
                    />
                  ) : (
                    <SemanticBadge semantic="pending" label="許容差の外" />
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {rows.length > shown.length && (
        <p className="text-caption text-ink-muted">ほか {rows.length - shown.length} 件</p>
      )}
    </div>
  );
}

function NotesTable({
  items,
  unitName,
  userName,
}: {
  items: ReconciliationItemView[];
  unitName: (id: string | null) => string;
  userName: (id: string) => string;
}) {
  const rows = items
    .flatMap((item) => item.notes.map((note) => ({ item, note })))
    .sort((a, b) => (a.note.decidedAt < b.note.decidedAt ? 1 : -1));
  if (rows.length === 0) {
    return (
      <p className="text-small text-ink-muted">
        まだ確認の記録はありません。項目の行の「原因を記録」から記録します（確認の権限を持つ人）。
      </p>
    );
  }
  return (
    <Table>
      <caption className="sr-only">確認の記録</caption>
      <THead>
        <TR>
          <TH>日時</TH>
          <TH>確認者</TH>
          <TH>項目</TH>
          <TH>原因</TH>
          <TH>コメント</TH>
          <TH>状態</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map(({ item, note }) => (
          <TR key={note.id}>
            <TD className="tnum text-caption">{formatJst(note.decidedAt)}</TD>
            <TD>{userName(note.decidedBy)}</TD>
            <TD className="text-small">{itemLabel(item, unitName)}</TD>
            <TD>
              <StatusBadge domain="ghgCause" value={note.confirmedCause} />
            </TD>
            <TD className="text-small">{note.comment || '—'}</TD>
            <TD className="text-caption text-ink-muted">
              {item.latestNote?.id === note.id ? '最新' : '差し替え済み'}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
