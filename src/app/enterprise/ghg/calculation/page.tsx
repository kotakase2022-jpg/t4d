import Link from 'next/link';
import { Calculator, FileText } from 'lucide-react';
import { AttentionStrip } from '@/components/shared/attention-strip';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { CompanyRuleNotice, GhgNotice, PendingRuleNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge } from '@/components/shared/status-badge';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { isUnitInScope } from '@/lib/authorization/can';
import { doubleCountWarnings } from '@/lib/domain/ghg/classification';
import { latestPolicy } from '@/lib/domain/ghg/select-inputs';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { calculationPermissionReason, listRuns, loadRun } from '@/lib/services/ghg/calculation';
import { loadGhgSource } from '@/lib/services/ghg/inputs';
import { runShortId } from '@/lib/services/ghg/post-to-data-points';
import { listReconciliations } from '@/lib/services/ghg/reconciliation';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import type { GhgCalculationRun, OrganizationUnit } from '@/types/domain';
import {
  loadProfileNames,
  loadRunViewContext,
  loadScope3InputLabels,
  showsCompanyRuleBadge,
} from '../_components/calc-data';
import { RUN_INPUT_STATE_VIEW, siteResultRows, roundingPolicyText } from '../_components/calc-view';
import { DualViewTable } from '../_components/dual-view-table';
import { SiteResultsTable } from '../_components/site-results-table';
import { loadCalcContext } from './_components/calc-context';
import { CALC_DETAIL_HREF, CalcNav, calcTabHref } from './_components/calc-nav';
import { runGhgCalculationAction } from './runs/actions';

export const metadata = { title: 'Scope1・2算定' };

const BASE = '/enterprise/ghg/calculation';

/*
 * P90 Scope1・2 の算定の概要（plan §2.4・CR-08・CR-09・CR-20）。
 * 並び（plan §1.14）: 注意（段階・要対応）→ 拠点別の結果 → 報告区分と既定区分の二重表示 → 算定の記録。
 * 主操作は「算定を実行」1 つ（記録は追記だけで、既存の値・Data Point を変えないため確認は挟まない）。
 * 誠実さの注記（N9 架空・N1/N2 区分規則・N6 荷主の排出量）は折りたたみに入れない。
 */

interface RunRow {
  run: GhgCalculationRun;
  inputState: keyof typeof RUN_INPUT_STATE_VIEW;
  creatorName: string;
  reconciliations: number;
}

export default async function GhgCalculationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const context = await loadCalcContext(params);
  const { shell, period } = context;
  const { db, ctx } = shell;
  const demo = ctx.demo;
  const source = await loadGhgSource(db, ctx, period.id);

  // 検証の拠点（トライアルの設定 → 計画の対象拠点）。どちらも無い組織は、この期間に活動量のある拠点
  let status = context.status;
  let unitIds = status.units.map((u) => u.unit.id);
  const fromTrial = unitIds.length > 0;
  if (!fromTrial) {
    const withActivity = new Set(
      source.batches.filter((b) => b.status !== 'discarded').map((b) => b.unitId),
    );
    unitIds = source.units.filter((u) => withActivity.has(u.id)).map((u) => u.id);
    if (unitIds.length > 0) {
      status = await loadGhgVerificationStatus(db, ctx, { periodId: period.id, unitIds });
    }
  }
  const units: OrganizationUnit[] = status.units.map((u) => u.unit);
  const policy = latestPolicy(source.policies, period.id);

  const [runs, reconciliations] = await Promise.all([
    listRuns(db, ctx, { periodId: period.id }),
    listReconciliations(db, ctx, { periodId: period.id }),
  ]);
  const latestEntry = status.latestRun
    ? (runs.find((r) => r.run.id === status.latestRun!.id) ?? null)
    : null;
  const latestRun = latestEntry?.run ?? null;
  const summary = latestRun?.summary ?? null;
  const view = await loadRunViewContext(db, ctx, latestRun, period, source.periods);
  const rounding = view.policy?.rounding ?? [];
  const creatorNames = await loadProfileNames(
    db,
    runs.map((r) => r.run.createdBy),
  );

  // 二重計上の警告（報告区分を Scope1 へ移した委託物流と、Scope3 の内訳の物流の購入）。再分類があるときだけ読む
  const doubleCounts =
    latestRun && summary && summary.reclassified.length > 0
      ? doubleCountWarnings(
          (await loadRun(db, ctx, latestRun.id)).lines,
          await loadScope3InputLabels(db, ctx, period.id),
        )
      : [];

  // ---- 操作の可否 ----
  const permissionReason = calculationPermissionReason(ctx);
  const outside = units.filter((u) => !isUnitInScope(ctx, u.id));
  const hasActivity = status.units.some((u) => u.status.activity.state !== 'none');
  const runDisabledReason =
    permissionReason ??
    (units.length === 0
      ? '算定する拠点がありません（トライアルの算定の検証範囲で拠点を選ぶか、活動量を取り込んでください）。'
      : outside.length > 0
        ? `担当外の拠点（${outside.map((u) => u.name).join('・')}）を含むため実行できません。`
        : !policy
          ? 'この期間の算定方針（丸め・換算・改良トンキロ法の設定）がありません。算定ルールのタブで保存してください。'
          : !hasActivity
            ? '確定済みの活動量がありません。活動量のタブで取り込んで確定してください。'
            : undefined);

  // ---- 段階（係数 → ルール → 活動量 → 算定 → 照合） ----
  const attention = status.attention;
  const activityComplete = status.units.filter((u) => u.status.activity.state === 'complete');
  const calcCurrent = status.units.filter((u) => u.status.calculation === 'current');
  const calcStale = status.units.filter((u) => u.status.calculation === 'stale');
  const reconciled = status.units.filter((u) => u.status.reconciliation === 'done');
  const reconReview = status.units.filter((u) => u.status.reconciliation === 'needs_review');
  const n = status.units.length;
  const raw: Array<Omit<StepItem, 'state'> & { done: boolean }> = [
    {
      key: 'factors',
      label: '排出係数',
      href: calcTabHref('factors', period.id),
      done: hasActivity && attention.unresolvedLines === 0,
      note:
        attention.unresolvedLines > 0
          ? `係数が解決できない行 ${attention.unresolvedLines}`
          : undefined,
    },
    {
      key: 'rules',
      label: '算定ルール',
      href: calcTabHref('rules', period.id),
      done: Boolean(policy),
      note: !policy
        ? '算定方針なし'
        : attention.pendingRules > 0
          ? `承認待ちの区分規則 ${attention.pendingRules}`
          : undefined,
    },
    {
      key: 'activity',
      label: '活動量',
      href: calcTabHref('activity', period.id),
      done: n > 0 && activityComplete.length === n && attention.draftBatches === 0,
      note: n > 0 ? `月がそろった拠点 ${activityComplete.length}/${n}` : undefined,
    },
    {
      key: 'calculation',
      label: '算定',
      href: '#ghg-calc-runs',
      done: n > 0 && calcCurrent.length === n,
      note:
        calcStale.length > 0
          ? `再算定が必要 ${calcStale.length} 拠点`
          : n > 0 && calcCurrent.length < n
            ? `算定済み ${calcCurrent.length}/${n}`
            : undefined,
    },
    {
      key: 'reconciliation',
      label: '照合',
      href: calcTabHref('reconciliation', period.id),
      done: n > 0 && reconciled.length === n,
      note:
        reconReview.length > 0
          ? `要確認 ${reconReview.length} 拠点`
          : n > 0 && reconciled.length < n
            ? `照合済み ${reconciled.length}/${n}`
            : undefined,
    },
  ];
  const firstOpen = raw.findIndex((s) => !s.done);
  const steps: StepItem[] = raw.map(({ done, ...step }, index) => ({
    ...step,
    state: done ? 'done' : index === firstOpen ? 'current' : 'todo',
  }));

  // ---- 拠点別の結果 ----
  const statusByUnit = new Map(status.units.map((u) => [u.unit.id, u.status.overall]));
  const siteRows = siteResultRows(summary, units, {
    organizationCountryCode: source.organization.countryCode,
    statuses: statusByUnit,
  });
  const domestic = siteRows.filter((r) => r.domestic).length;

  // ---- 算定の記録 ----
  const reconCount = new Map<string, number>();
  for (const r of reconciliations) reconCount.set(r.runId, (reconCount.get(r.runId) ?? 0) + 1);
  const runRows: RunRow[] = runs.map((entry) => ({
    run: entry.run,
    inputState: entry.inputState,
    creatorName: creatorNames.get(entry.run.createdBy) ?? '—',
    reconciliations: reconCount.get(entry.run.id) ?? 0,
  }));
  const pageSize = parsePageSize(params.size);
  const page = parsePage(params.page);
  const pagedRuns = runRows.slice((page - 1) * pageSize, page * pageSize);
  const runColumns: DataTableColumn<RunRow>[] = [
    {
      key: 'createdAt',
      header: '実行日時',
      importance: 'primary',
      lockVisible: true,
      cell: (row) => (
        <Link
          href={CALC_DETAIL_HREF.run(row.run.id)}
          className="font-medium text-brand-700 hover:underline"
        >
          {formatJst(row.run.createdAt)}
        </Link>
      ),
    },
    {
      key: 'id',
      header: '記録',
      importance: 'primary',
      cell: (row) => <span className="font-mono text-small">#{runShortId(row.run.id)}</span>,
    },
    {
      key: 'creator',
      header: '実行者',
      importance: 'secondary',
      cell: (row) => row.creatorName,
    },
    {
      key: 'units',
      header: '拠点',
      importance: 'secondary',
      align: 'right',
      cell: (row) => `${row.run.unitIds.length} 拠点`,
    },
    {
      key: 'lines',
      header: '算定行',
      importance: 'secondary',
      align: 'right',
      cell: (row) => `${row.run.lineCount.toLocaleString('ja-JP')} 行`,
    },
    {
      key: 'inputState',
      header: '入力の状態',
      importance: 'primary',
      cell: (row) => {
        const v = RUN_INPUT_STATE_VIEW[row.inputState];
        return <SemanticBadge semantic={v.semantic} label={v.label} detail={v.detail} />;
      },
    },
    {
      key: 'reconciliations',
      header: '照合',
      importance: 'secondary',
      align: 'right',
      cell: (row) => (row.reconciliations > 0 ? `${row.reconciliations} 件` : '—'),
    },
    {
      key: 'engine',
      header: 'エンジンの版',
      importance: 'detail',
      cell: (row) => <span className="font-mono text-caption">{row.run.engineVersion}</span>,
    },
  ];

  const hasCompanyRule = showsCompanyRuleBadge(view);

  return (
    <>
      <PageHeader
        title="Scope1・2算定"
        autoBreadcrumbs
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>
              期間 {period.label}（{formatJstDate(period.startDate)}〜
              {formatJstDate(period.endDate)}）
            </span>
            {n > 0 && (
              <span className="text-ink-muted">
                {fromTrial ? '算定の検証拠点' : '活動量のある拠点'} {n}（国内 {domestic}・海外{' '}
                {n - domestic}）
              </span>
            )}
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
          </span>
        }
        help={
          <>
            <p>
              活動量（燃料・電力・ガス・輸送実績）× 排出係数で Scope1・2
              を算定し、算定の記録（追記だけ）を残します。算定は Data Point
              を直接確定しません。反映は算定明細から下書きとして行い、確定は承認フローで人が行います。
            </p>
            <p>
              係数が解決できない行・単位を換算できない行が 1
              行でもあれば、記録を作らずに理由を示します（代わりの係数を使いません）。
            </p>
          </>
        }
        actions={
          <PageActions
            primary={{
              kind: 'submit',
              id: 'run-calculation',
              label: '算定を実行',
              icon: <Calculator aria-hidden="true" />,
              action: runGhgCalculationAction,
              fields: { periodId: period.id, unitIds: unitIds.join(',') },
              pendingLabel: '算定しています…',
              disabledReason: runDisabledReason,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'open-latest-run',
                label: '最新の算定明細',
                icon: <FileText aria-hidden="true" />,
                href: latestRun ? CALC_DETAIL_HREF.run(latestRun.id) : BASE,
                hidden: !latestRun,
              },
            ]}
          />
        }
      />
      <CalcNav current="overview" periodId={period.id} attention={attention} />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} />
        {demo && <GhgNotice id="N9" />}

        <div className="flex flex-wrap items-end justify-between gap-2">
          <StepNav ariaLabel="算定の検証の段階" steps={steps} />
          <form method="get" action={BASE} className="flex items-end gap-1.5">
            <label className="text-small text-ink-muted">
              期間
              <NativeSelect name="period" defaultValue={period.id} className="mt-0.5 min-w-48">
                {shell.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <SubmitButton size="sm" variant="secondary">
              表示する
            </SubmitButton>
          </form>
        </div>

        <AttentionStrip
          items={[
            {
              key: 'unresolved',
              label: '係数が解決できない行',
              count: attention.unresolvedLines,
              href: calcTabHref('factors', period.id),
              semantic: 'blocked',
            },
            {
              key: 'draft-batches',
              label: '確定していない活動量',
              count: attention.draftBatches,
              href: calcTabHref('activity', period.id),
              semantic: 'pending',
            },
            {
              key: 'pending-rules',
              label: '承認待ちの区分規則',
              count: attention.pendingRules,
              href: calcTabHref('rules', period.id),
              semantic: 'pending',
            },
            {
              key: 'recalc',
              label: '再算定が必要な拠点',
              count: calcStale.length,
              href: '#ghg-calc-sites',
              semantic: 'returned',
            },
            {
              key: 'default-load',
              label: '見なし積載率で算定した輸送の行',
              count: attention.defaultLoadLines,
              href: latestRun ? `${CALC_DETAIL_HREF.run(latestRun.id)}?warn=1` : BASE,
              semantic: 'blocked',
            },
            {
              key: 'floored-load',
              label: '積載率の下限を適用した行',
              count: attention.flooredLoadLines,
              href: latestRun ? `${CALC_DETAIL_HREF.run(latestRun.id)}?warn=1` : BASE,
              semantic: 'blocked',
            },
            {
              key: 'reconciliation-review',
              label: '照合で要確認の拠点',
              count: attention.reconciliationNeedsReview,
              href: calcTabHref('reconciliation', period.id),
              semantic: 'pending',
            },
          ]}
        />

        {attention.unresolvedReasons.length > 0 && (
          <Notice tone="warning" title="係数が解決できない行があります（算定の記録を作れません）">
            <ul className="list-disc space-y-0.5 pl-4">
              {attention.unresolvedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-1">
              <Link
                href={calcTabHref('factors', period.id)}
                className="text-brand-700 underline underline-offset-2"
              >
                排出係数のタブで割り当てる
              </Link>
            </p>
          </Notice>
        )}

        <Section
          id="ghg-calc-sites"
          title="拠点別の結果"
          divider="none"
          summary={
            latestRun
              ? `最新の記録 #${runShortId(latestRun.id)}（${formatJst(latestRun.createdAt)}）`
              : 'まだ算定していません'
          }
        >
          {latestEntry?.inputState === 'stale' && (
            <Notice tone="warning" title="入力が変わりました（再算定が必要）">
              最新の記録の後に係数・算定ルール・活動量が変わりました。表の値は記録の時点のものです。
            </Notice>
          )}
          {latestEntry?.inputState === 'input_changed' && (
            <Notice tone="warning" title="この記録の数値を表示できません">
              {RUN_INPUT_STATE_VIEW.input_changed.detail}
            </Notice>
          )}
          {units.length === 0 ? (
            <EmptyState
              kind="no-data"
              size="compact"
              title="算定する拠点がありません"
              description="トライアルの算定の検証範囲で拠点を選ぶか、活動量を取り込むと、ここに拠点別の結果を出します。"
              action={
                <Link
                  href={calcTabHref('activity', period.id)}
                  className="text-small text-brand-700 underline underline-offset-2"
                >
                  活動量を取り込む
                </Link>
              }
            />
          ) : (
            <div className="space-y-1.5 py-1.5">
              <SiteResultsTable
                rows={siteRows}
                rounding={rounding}
                caption="拠点別の結果"
                siteHref={
                  latestRun && summary
                    ? (unitId) =>
                        `${CALC_DETAIL_HREF.run(latestRun.id)}?unit=${encodeURIComponent(unitId)}`
                    : undefined
                }
              />
              <p className="text-caption text-ink-muted">
                単位 t-CO2e。値は算定方針の拠点×区分の段の値（{roundingPolicyText(rounding)}
                ）。値の無い区分は「—」です（0
                ではありません）。うち再分類分は、報告区分と既定区分の Scope1 の差です。
              </p>
            </div>
          )}
        </Section>

        <Section
          id="ghg-calc-dual"
          title="報告区分と既定区分"
          actions={hasCompanyRule ? <HonestyBadge kind="company-rule" /> : undefined}
        >
          <div className="space-y-2 py-1.5">
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
            {summary ? (
              <DualViewTable summary={summary} rounding={rounding} rules={view.rules} />
            ) : (
              <p className="text-small text-ink-muted">
                算定の記録が無いため、二重表示はまだありません。算定を実行すると、報告区分（組織の算定ルール）と既定区分（GHG
                プロトコル）を並べて示します。
              </p>
            )}
            {doubleCounts.length > 0 && (
              <Notice tone="warning" title="二重計上の確認">
                <ul className="list-disc space-y-0.5 pl-4">
                  {doubleCounts.map((w) => (
                    <li key={`${w.ruleId}-${w.inputLabel}`}>{w.message}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <GhgNotice id="N6" />
          </div>
        </Section>

        <Section
          id="ghg-calc-runs"
          title="算定の記録"
          summary={`${runRows.length} 件（追記だけ。消しません）`}
        >
          <DataTable<RunRow>
            id="ghg-calc-runs"
            caption="算定の記録"
            columns={runColumns}
            rows={pagedRuns}
            getRowId={(row) => row.run.id}
            getRowLabel={(row) => `算定の記録 #${runShortId(row.run.id)}`}
            getRowStatus={(row) => RUN_INPUT_STATE_VIEW[row.inputState].label}
            searchParams={params}
            basePath={BASE}
            search={false}
            page={{ page, pageSize, total: runRows.length, sizes: [25, 50, 100] }}
            empty={{
              noData: {
                title: '算定の記録はまだありません',
                description:
                  '活動量・排出係数・算定ルールがそろったら、見出しの「算定を実行」で記録を作ります。',
                action: (
                  <Link
                    href={calcTabHref('activity', period.id)}
                    className="text-small text-brand-700 underline underline-offset-2"
                  >
                    活動量を確かめる
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
