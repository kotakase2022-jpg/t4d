import Link from 'next/link';
import { FileSpreadsheet, GitCompare, Upload } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { StepNav } from '@/components/shared/step-nav';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import { ghgDemoFileLinks } from '@/lib/fixtures/ghg-demo-files';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import {
  BASELINE_EMISSION_UNITS,
  BASELINE_FIELD_SPECS,
  BASELINE_GRANULARITY_LABELS,
  BASELINE_SITE_EXCLUDED,
  baselineImportPermissionReason,
  listBaselineSiteChoices,
  listBaselines,
} from '@/lib/services/ghg/baseline-import';
import {
  calculationPermissionReason,
  listRuns,
  type RunListEntry,
} from '@/lib/services/ghg/calculation';
import {
  listReconciliations,
  loadReconciliation,
  type LoadedReconciliation,
} from '@/lib/services/ghg/reconciliation';
import { BASELINE_MAX_ROWS } from '@/lib/domain/ghg/baseline-parse';
import {
  GHG_RECON_VERDICTS,
  GHG_SCOPES,
  type GhgBaselineResult,
  type GhgScope,
} from '@/types/domain';
import { loadCalcContext } from '../_components/calc-context';
import { CalcNav } from '../_components/calc-nav';
import { BaselineImportForm } from './_components/baseline-import-form';
import {
  ATTRIBUTION_ORDER_PRESET_KEYS,
  orderPresetLabel,
  RECONCILIATION_BASE_PATH,
  reconciliationDetailHref,
  reconciliationListHref,
  toleranceSummary,
} from './_components/reconcile-options';
import { PreservingForm } from '@/components/shared/preserving-form';
import { reconcileAction } from './actions';

export const metadata = { title: '既存の算定結果との照合' };

type Query = Record<string, string | string[] | undefined>;

const RUN_STATE_TEXT: Record<RunListEntry['inputState'], string> = {
  current: '入力は最新',
  stale: '入力が変わった',
  input_changed: '作り直せない',
};

function param(query: Query, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function runLabel(entry: RunListEntry, unitCount: number): string {
  return `${formatJst(entry.run.createdAt)}・${unitCount} 拠点・算定行 ${entry.run.lineCount} 行（${RUN_STATE_TEXT[entry.inputState]}）`;
}

interface ReconRow {
  loaded: LoadedReconciliation;
  runLabel: string;
}

export default async function GhgReconciliationListPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const { shell, period, status } = await loadCalcContext(query);
  const { db, ctx } = shell;
  const demo = ctx.demo;
  const canImport = baselineImportPermissionReason(ctx) === null;
  const canReconcile = calculationPermissionReason(ctx) === null;
  const canExport = can(ctx, 'enterprise.export.run');

  const [runs, baselines, reconciliations, siteChoices] = await Promise.all([
    listRuns(db, ctx, { periodId: period.id }),
    listBaselines(db, ctx, { periodId: period.id }),
    listReconciliations(db, ctx, { periodId: period.id }),
    listBaselineSiteChoices(db, ctx),
  ]);
  // 照合の一覧はページ送りし、見えるページの記録だけ判定の内訳（確認の記録を反映）のために読み直す。
  // 件数は全件（以前は先頭 20 件に切って「20 件」と出し、古い記録へ辿れなかった）
  const reconPageSize = parsePageSize(query.size);
  const reconPage = Math.min(
    parsePage(query.page),
    Math.max(1, Math.ceil(reconciliations.length / reconPageSize)),
  );
  const reconRows: ReconRow[] = await Promise.all(
    reconciliations
      .slice((reconPage - 1) * reconPageSize, reconPage * reconPageSize)
      .map(async (r) => {
        const loaded = await loadReconciliation(db, ctx, r.id);
        const entry = runs.find((e) => e.run.id === r.runId);
        return {
          loaded,
          runLabel: entry
            ? runLabel(entry, entry.run.unitIds.length)
            : formatJst(loaded.run.createdAt),
        };
      }),
  );
  const userIds = [
    ...new Set([
      ...baselines.map((b) => b.createdBy),
      ...reconRows.map((r) => r.loaded.reconciliation.createdBy),
    ]),
  ];
  const profiles =
    userIds.length > 0 ? await db.select('profiles', { where: { id: { in: userIds } } }) : [];
  const userName = (id: string) => profiles.find((p) => p.id === id)?.displayName ?? '—';

  const reconcilableRuns = runs.filter((e) => e.run.summary !== null);
  const importOpen = canImport && isCreatePanelOpen(query, 'import');
  const reconcileOpen = canReconcile && isCreatePanelOpen(query, 'reconcile');
  const reconcileBlocked =
    reconcilableRuns.length === 0
      ? '照合できる算定の記録がありません。概要で算定を実行してから照合します。'
      : baselines.length === 0
        ? '既存の算定結果がありません。取り込んでから照合します。'
        : undefined;

  // 照合の欄: 記録と既存結果（?run=・?baseline=。無ければ最新）と、その組の区分の許容差
  const selectedRun =
    reconcilableRuns.find((e) => e.run.id === param(query, 'run')) ?? reconcilableRuns[0] ?? null;
  const selectedBaseline =
    baselines.find((b) => b.id === param(query, 'baseline')) ?? baselines[0] ?? null;
  const toleranceScopes: GhgScope[] =
    selectedRun && selectedBaseline
      ? GHG_SCOPES.filter(
          (scope) =>
            (selectedRun.run.summary?.reported.totals ?? []).some((t) => t.scope === scope) ||
            selectedBaseline.rows.some((r) => r.scope === scope),
        )
      : [];

  const unitName = (id: string) => shell.units.find((u) => u.id === id)?.name ?? id.slice(0, 8);
  // 取込の欄を開くときは照合の欄を閉じる（欄の中の主操作を 2 つ同時に出さない）
  const importHref = createPanelHref(
    RECONCILIATION_BASE_PATH,
    { ...query, reconcile: undefined, run: undefined, baseline: undefined },
    { open: true, openParam: 'import' },
  );
  const reconcileHref = (baselineId?: string) =>
    `${reconciliationListHref(period.id, { reconcile: '1', ...(baselineId ? { baseline: baselineId } : {}) })}#reconcile`;
  const sample = demo
    ? (ghgDemoFileLinks().find((link) => link.kind === 'baseline') ?? null)
    : null;

  const baselineColumns: DataTableColumn<GhgBaselineResult>[] = [
    {
      key: 'label',
      header: '名前',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (b) => (
        <span className="font-medium text-ink">
          {b.label}
          {b.supersedesId && <span className="ml-1 text-caption text-ink-muted">（差し替え）</span>}
        </span>
      ),
    },
    {
      key: 'file',
      header: 'ファイル',
      importance: 'secondary',
      cell: (b) => <span className="text-small">{b.fileName || '—'}</span>,
    },
    {
      key: 'sha',
      header: 'sha256（先頭）',
      importance: 'secondary',
      cell: (b) => <span className="font-mono text-caption">{b.fileSha256.slice(0, 12)}</span>,
    },
    {
      key: 'granularity',
      header: '粒度',
      importance: 'primary',
      cell: (b) => BASELINE_GRANULARITY_LABELS[b.granularity],
    },
    {
      key: 'rows',
      header: '行数',
      importance: 'primary',
      align: 'right',
      cell: (b) => <span className="tnum">{formatNumber(b.rowCount)}</span>,
    },
    {
      key: 'sites',
      header: '対応付けた拠点',
      importance: 'secondary',
      cell: (b) =>
        Object.values(b.unitMapping).length > 0
          ? [...new Set(Object.values(b.unitMapping))].map(unitName).join('・')
          : '—',
    },
    {
      key: 'createdBy',
      header: '取込者',
      importance: 'detail',
      cell: (b) => userName(b.createdBy),
    },
    {
      key: 'createdAt',
      header: '取込日時',
      importance: 'secondary',
      cell: (b) => formatJst(b.createdAt),
    },
  ];

  const reconColumns: DataTableColumn<ReconRow>[] = [
    {
      key: 'createdAt',
      header: '照合',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (r) => (
        <Link
          href={reconciliationDetailHref(r.loaded.reconciliation.id, period.id)}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          {formatJst(r.loaded.reconciliation.createdAt)} の照合
        </Link>
      ),
    },
    {
      key: 'run',
      header: '算定の記録',
      importance: 'secondary',
      cell: (r) => <span className="text-small">{r.runLabel}</span>,
    },
    {
      key: 'baseline',
      header: '既存の算定結果',
      importance: 'primary',
      cell: (r) => r.loaded.baseline.label,
    },
    {
      key: 'verdicts',
      header: '判定の内訳',
      importance: 'primary',
      cell: (r) =>
        r.loaded.items ? (
          <span className="flex flex-wrap items-center gap-1">
            {GHG_RECON_VERDICTS.filter((v) => r.loaded.counts[v] > 0).map((v) => (
              <span key={v} className="inline-flex items-center gap-0.5">
                <StatusBadge domain="ghgReconItem" value={v} />
                <span className="tnum text-small">{r.loaded.counts[v]}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-small text-ink-muted">
            結果を作り直せません（入力が変わった・照合の規則の版が違う）
          </span>
        ),
    },
    {
      key: 'tolerance',
      header: '許容差（利用者の入力）',
      importance: 'detail',
      cell: (r) => (
        <span className="text-small">{toleranceSummary(r.loaded.reconciliation.tolerance)}</span>
      ),
    },
    {
      key: 'createdBy',
      header: '照合した人',
      importance: 'detail',
      cell: (r) => userName(r.loaded.reconciliation.createdBy),
    },
  ];

  return (
    <>
      <PageHeader
        title="既存の算定結果との照合"
        autoBreadcrumbs
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>
              期間 {period.label}（{formatJstDate(period.startDate)}〜
              {formatJstDate(period.endDate)}）
            </span>
            <HonestyBadge kind="consistency-check" />
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
          </span>
        }
        help="既存の算定結果（Excel・CSV）を取り込み、算定の記録と項目（拠点×区分×活動〔×月〕）ごとに突き合わせます。差は原因（区分・対象範囲・活動量・単位換算・排出係数・算定方法・丸め）ごとの寄与と、説明できない残差に分けて示します。原因の確定は確認者が記録します。"
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'reconcile',
              label: '照合する',
              shortcut: 'new',
              icon: <GitCompare aria-hidden="true" />,
              href: reconcileHref(),
              // 欄を開いているときは、欄の中の送信が主操作
              hidden: !canReconcile || reconcileOpen || importOpen,
              disabledReason: reconcileBlocked,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'import-baseline',
                label: '既存の算定結果を取り込む',
                icon: <Upload aria-hidden="true" />,
                href: `${importHref}#import-baseline`,
                hidden: !canImport || importOpen,
              },
            ]}
          />
        }
      />
      <CalcNav current="reconciliation" periodId={period.id} attention={status.attention} />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {demo && <GhgNotice id="N9" />}
        <GhgNotice id="N3" />

        {canImport && (
          <CreatePanel
            id="import-baseline"
            title="既存の算定結果を取り込む"
            openParam="import"
            searchParams={query}
            closeHref={createPanelHref(RECONCILIATION_BASE_PATH, query, {
              open: false,
              openParam: 'import',
            })}
            description={`取り込む期間: ${period.label}。拠点コードと拠点の対応付けは推測で決めず、あなたが選びます。`}
          >
            <BaselineImportForm
              periodId={period.id}
              fields={BASELINE_FIELD_SPECS.map(({ key, label, required }) => ({
                key,
                label,
                required,
              }))}
              units={siteChoices.map((u) => ({
                id: u.id,
                code: u.code,
                name: u.name,
                countryCode: u.countryCode,
              }))}
              existing={baselines.map((b) => ({ id: b.id, label: b.label }))}
              emissionUnits={BASELINE_EMISSION_UNITS}
              granularityLabels={BASELINE_GRANULARITY_LABELS}
              scopeLabels={GHG_SCOPE_LABELS}
              excludedValue={BASELINE_SITE_EXCLUDED}
              maxRows={db.mode === 'demo' ? DEMO_GHG_LIMITS.baselineRows : BASELINE_MAX_ROWS}
              sample={sample ? { href: sample.href, label: sample.label } : null}
            />
          </CreatePanel>
        )}

        {canReconcile && (
          <CreatePanel
            id="reconcile"
            title="照合する"
            openParam="reconcile"
            searchParams={query}
            closeHref={createPanelHref(RECONCILIATION_BASE_PATH, query, {
              open: false,
              openParam: 'reconcile',
            })}
            description="許容差は区分ごとに、絶対値（t）か相対値（%）の少なくとも一方を入れてください。既定値はありません（入れた値は照合の記録と出力に残ります）。"
          >
            <StepNav
              ariaLabel="照合の段階"
              steps={[
                {
                  key: 'pair',
                  label: '算定の記録と既存の算定結果を選ぶ',
                  state: selectedRun && selectedBaseline ? 'done' : 'current',
                },
                {
                  key: 'tolerance',
                  label: '許容差を入れる',
                  state: selectedRun && selectedBaseline ? 'current' : 'blocked',
                },
                { key: 'run', label: '照合', state: 'todo' },
              ]}
            />
            {reconcileBlocked ? (
              <p className="text-small text-ink-muted">{reconcileBlocked}</p>
            ) : (
              <>
                <form
                  method="get"
                  // 送ったあとも照合の欄を見せる（GET の送信は行き先の # を保つ）
                  action={`${RECONCILIATION_BASE_PATH}#reconcile`}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="period" value={period.id} />
                  <input type="hidden" name="reconcile" value="1" />
                  <Field id="reconcile-run" label="算定の記録" required className="min-w-72">
                    {(control) => (
                      <NativeSelect
                        {...control}
                        name="run"
                        defaultValue={selectedRun?.run.id ?? ''}
                      >
                        {reconcilableRuns.map((entry) => (
                          <option key={entry.run.id} value={entry.run.id}>
                            {runLabel(entry, entry.run.unitIds.length)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    id="reconcile-baseline"
                    label="既存の算定結果"
                    required
                    className="min-w-60"
                  >
                    {(control) => (
                      <NativeSelect
                        {...control}
                        name="baseline"
                        defaultValue={selectedBaseline?.id ?? ''}
                      >
                        {baselines.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.label}（{BASELINE_GRANULARITY_LABELS[b.granularity]}・{b.rowCount}{' '}
                            行）
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <SubmitButton variant="secondary" size="sm">
                    この組で許容差を入れる
                  </SubmitButton>
                </form>

                {selectedRun && selectedBaseline && (
                  <PreservingForm
                    action={reconcileAction}
                    className="space-y-2 border-t border-line pt-2"
                  >
                    <input type="hidden" name="periodId" value={period.id} />
                    <input type="hidden" name="runId" value={selectedRun.run.id} />
                    <input type="hidden" name="baselineId" value={selectedBaseline.id} />
                    <p className="text-small text-ink">
                      {formatJst(selectedRun.run.createdAt)} の算定の記録 × 「
                      {selectedBaseline.label}」
                    </p>
                    <Table>
                      <caption className="sr-only">区分ごとの許容差</caption>
                      <THead>
                        <TR>
                          <TH>区分（この組に出てくるもの）</TH>
                          <TH>絶対値（t-CO2e）</TH>
                          <TH>相対値（%）</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {toleranceScopes.map((scope) => (
                          <TR key={scope}>
                            <TD className="font-medium">{GHG_SCOPE_LABELS[scope]}</TD>
                            <TD>
                              <Input
                                name={`tol:${scope}:abs`}
                                inputMode="decimal"
                                aria-label={`${GHG_SCOPE_LABELS[scope]} の許容差（絶対値 t）`}
                                className="w-28"
                              />
                            </TD>
                            <TD>
                              <Input
                                name={`tol:${scope}:rel`}
                                inputMode="decimal"
                                aria-label={`${GHG_SCOPE_LABELS[scope]} の許容差（相対値 %）`}
                                className="w-28"
                              />
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                    <p className="text-caption text-ink-muted">
                      区分ごとに少なくとも一方が必要です。どちらかの内なら「許容差内」です。
                    </p>
                    <Field
                      id="reconcile-order"
                      label="原因を揃える順序"
                      hint="順序を変えると原因別の寄与の配分が変わることがあります"
                      className="max-w-xl"
                    >
                      {(control) => (
                        <NativeSelect {...control} name="order" defaultValue="default">
                          {ATTRIBUTION_ORDER_PRESET_KEYS.map((key) => (
                            <option key={key} value={key}>
                              {orderPresetLabel(key)}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    <SubmitButton
                      variant="primary"
                      size="sm"
                      icon={<GitCompare aria-hidden="true" />}
                      pendingLabel="照合中…"
                    >
                      照合する
                    </SubmitButton>
                  </PreservingForm>
                )}
              </>
            )}
          </CreatePanel>
        )}

        <Section title="既存の算定結果" summary={`${baselines.length} 件`}>
          <DataTable
            id="ghg-baselines"
            caption="既存の算定結果"
            columns={baselineColumns}
            rows={baselines}
            getRowId={(b) => b.id}
            getRowLabel={(b) => b.label}
            searchParams={query}
            basePath={RECONCILIATION_BASE_PATH}
            search={false}
            rowActions={(b) =>
              canReconcile && !reconcileBlocked
                ? {
                    rowLabel: b.label,
                    primary: {
                      kind: 'link',
                      id: `reconcile-${b.id}`,
                      label: 'これと照合',
                      href: reconcileHref(b.id),
                    },
                  }
                : null
            }
            empty={{
              noData: {
                title: 'まだ既存の算定結果がありません',
                description: '既存の算定結果（Excel・CSV）を取り込むと、算定の記録と照合できます。',
                action: canImport ? (
                  <Link
                    href={`${importHref}#import-baseline`}
                    className="text-small text-brand-700 underline-offset-2 hover:underline"
                  >
                    既存の算定結果を取り込む
                  </Link>
                ) : (
                  <span className="text-small text-ink-muted">
                    取込は、取込とデータ入力の権限を持つ人（本社サステナ担当など）が行います。
                  </span>
                ),
              },
            }}
          />
        </Section>

        <Section title="照合の記録" summary={`${reconciliations.length} 件`}>
          <DataTable
            id="ghg-reconciliations"
            caption="照合の記録"
            columns={reconColumns}
            rows={reconRows}
            page={{
              page: reconPage,
              pageSize: reconPageSize,
              total: reconciliations.length,
              sizes: [25, 50, 100],
            }}
            getRowId={(r) => r.loaded.reconciliation.id}
            getRowLabel={(r) => `${formatJst(r.loaded.reconciliation.createdAt)} の照合`}
            searchParams={query}
            basePath={RECONCILIATION_BASE_PATH}
            search={false}
            rowActions={(r) =>
              canExport && r.loaded.items
                ? {
                    rowLabel: `${formatJst(r.loaded.reconciliation.createdAt)} の照合`,
                    items: [
                      {
                        kind: 'link',
                        id: `export-${r.loaded.reconciliation.id}`,
                        label: '照合の結果を XLSX で出力',
                        icon: <FileSpreadsheet aria-hidden="true" />,
                        href: `/api/exports/ghg-reconciliation?id=${r.loaded.reconciliation.id}`,
                        download: true,
                        group: 'export',
                      },
                    ],
                  }
                : null
            }
            empty={{
              noData: {
                title: 'まだ照合の記録がありません',
                description: '算定の記録と既存の算定結果を選び、許容差を入れて照合します。',
                action:
                  canReconcile && !reconcileBlocked ? (
                    <Link
                      href={reconcileHref()}
                      className="text-small text-brand-700 underline-offset-2 hover:underline"
                    >
                      照合する
                    </Link>
                  ) : (
                    <span className="text-small text-ink-muted">
                      {reconcileBlocked ??
                        '照合は、データ入力の権限を持つ人（本社サステナ担当など）が行います。'}
                    </span>
                  ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
