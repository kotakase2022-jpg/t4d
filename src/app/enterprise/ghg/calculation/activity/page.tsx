import Link from 'next/link';
import { Download, Upload } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice, LoadFactorNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { ghgDemoFileLinks } from '@/lib/fixtures/ghg-demo-files';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import {
  activityImportPermissionReason,
  loadActivityCoverage,
  type CoverageBatch,
} from '@/lib/services/ghg/activity-import';
import { isUnitInScope } from '@/lib/authorization/can';
import { statusLabel } from '@/lib/ui/status/registry';
import { GHG_BATCH_KINDS, GHG_BATCH_STATUSES } from '@/types/domain';
import { loadCalcContext } from '../_components/calc-context';
import { CALC_DETAIL_HREF, CalcNav, calcTabHref } from '../_components/calc-nav';
import { ActivityImportForm } from './_components/activity-import-form';
import { CoverageTable } from './_components/coverage-table';
import { TonKmPresetSection } from './_components/tonkm-preset-section';
import { BATCH_KIND_LABELS } from './_lib/labels';

export const metadata = { title: '活動量（Scope1・2算定）' };

const BASE = '/enterprise/ghg/calculation/activity';

type Params = Record<string, string | string[] | undefined>;

/**
 * 活動量（P94。plan §2.4・CR-05）: 拠点 × 活動 × 月の充足と、活動量の取込。
 *
 * primary は「活動量を取り込む」（CreatePanel を開く。開いているときは欄の中の操作が主操作）。
 * 取込は 種類 → ファイル → 列の対応 → 検証 → 確定（確定はバッチの詳細 P95）。
 * 見なし積載率・下限の行の数（N7）と海外拠点の輸送（N5）は数があるときに常に見える位置に出す。
 * 公的参照プリセット（改良トンキロ法の告示の値。CR-19）は閲覧だけで、既定では算定に使わない（N10）。
 */
export default async function GhgActivityPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { shell, period, unitIds, status } = await loadCalcContext(params);
  const { db, ctx } = shell;
  const coverage = await loadActivityCoverage(db, ctx, { periodId: period.id, unitIds });
  const demo = ctx.demo;

  const permissionReason = activityImportPermissionReason(ctx);
  const closed = period.status === 'closed';
  const canImport = permissionReason === null && !closed;
  const panelOpen = canImport && isCreatePanelOpen(params);
  const periodQuery = { ...params, period: period.id };

  // 取込の拠点: 担当の拠点だけ（検証拠点を先に）
  const verification = new Set(unitIds);
  const importUnits = [
    ...shell.units.filter((u) => verification.has(u.id)),
    ...shell.units.filter((u) => !verification.has(u.id) && u.unitType !== 'supplier'),
  ]
    .filter((u) => isUnitInScope(ctx, u.id))
    .map((u) => ({
      id: u.id,
      code: u.code,
      name: u.name,
      countryCode: u.countryCode,
      overseas: u.countryCode !== coverage.organizationCountryCode,
      verification: verification.has(u.id),
    }));
  const replaceable = coverage.batches
    .filter((b) => b.batch.status === 'confirmed')
    .map((b) => ({
      batchId: b.batch.id,
      unitId: b.batch.unitId,
      kind: b.batch.kind,
      label: `${b.batch.fileName}（${b.batch.rowCount} 行・確定 ${b.batch.confirmedAt ? formatJstDate(b.batch.confirmedAt) : '—'}）`,
    }));
  const sampleLinks = demo
    ? ghgDemoFileLinks().filter((l) => l.kind === 'energy' || l.kind === 'transport')
    : [];

  // 取込の記録（絞り込みは URL。サーバーで行う）
  const statusFilter = typeof params.status === 'string' ? params.status : null;
  const kindFilter = typeof params.kind === 'string' ? params.kind : null;
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const batchRows = coverage.batches
    .filter((b) => (statusFilter ? b.batch.status === statusFilter : true))
    .filter((b) => (kindFilter ? b.batch.kind === kindFilter : true))
    .filter((b) =>
      query === ''
        ? true
        : `${b.batch.fileName} ${b.unitName} ${b.unitCode}`.toLowerCase().includes(query),
    );

  const columns: DataTableColumn<CoverageBatch>[] = [
    {
      key: 'file',
      header: 'ファイル',
      importance: 'primary',
      lockVisible: true,
      cell: (b) => (
        <Link
          href={CALC_DETAIL_HREF.activityBatch(b.batch.id)}
          className="text-small font-medium text-brand-700 hover:underline"
        >
          {b.batch.fileName || '（ファイル名なし）'}
        </Link>
      ),
    },
    {
      key: 'unit',
      header: '拠点',
      importance: 'primary',
      cell: (b) => (
        <span className="text-small">
          {b.unitName}
          <span className="ml-1 text-caption text-ink-muted">{b.unitCode}</span>
        </span>
      ),
    },
    {
      key: 'kind',
      header: '種類',
      importance: 'primary',
      cell: (b) => <span className="text-small">{BATCH_KIND_LABELS[b.batch.kind]}</span>,
    },
    {
      key: 'rows',
      header: '行数',
      importance: 'primary',
      align: 'right',
      cell: (b) => <span className="tnum text-small">{b.batch.rowCount}</span>,
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (b) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StatusBadge domain="ghgActivityBatch" value={b.batch.status} />
          {b.batch.supersedesBatchId && b.batch.status === 'draft' && (
            <span className="text-caption text-ink-muted">差し替え</span>
          )}
        </span>
      ),
    },
    {
      key: 'created',
      header: '取込',
      importance: 'secondary',
      cell: (b) => (
        <span className="text-caption">
          {formatJst(b.batch.createdAt)}
          {b.createdByName && <span className="ml-1 text-ink-muted">{b.createdByName}</span>}
        </span>
      ),
    },
    {
      key: 'confirmed',
      header: '確定',
      importance: 'secondary',
      cell: (b) =>
        b.batch.confirmedAt ? (
          <span className="text-caption">
            {formatJst(b.batch.confirmedAt)}
            {b.confirmedByName && <span className="ml-1 text-ink-muted">{b.confirmedByName}</span>}
          </span>
        ) : (
          <span className="text-caption text-ink-muted">—</span>
        ),
    },
    {
      key: 'superseded',
      header: '差し替えた取込',
      importance: 'detail',
      cell: (b) => (
        <span className="text-caption text-ink-muted">{b.supersededByFileName ?? '—'}</span>
      ),
    },
    {
      key: 'sha',
      header: 'sha256（先頭）',
      importance: 'detail',
      cell: (b) => (
        <span className="font-mono text-caption text-ink-muted">
          {b.batch.fileSha256 ? b.batch.fileSha256.slice(0, 12) : '—'}
        </span>
      ),
    },
  ];

  const counts = coverage.counts;
  return (
    <>
      <PageHeader
        title="活動量（Scope1・2算定）"
        autoBreadcrumbs
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>
              期間 {period.label}（{formatJstDate(period.startDate)}〜
              {formatJstDate(period.endDate)}）
            </span>
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
          </span>
        }
        help={
          <p>
            拠点ごとに電力・燃料・ガス・熱の使用量（エネルギー）と、委託物流・自社便の輸送の行（輸送実績）を月ごとに取り込みます。取込は
            種類と拠点 → ファイル → 列の対応 → 検証 → 確定
            の順で、確定するまで算定には使いません。委託物流は改良トンキロ法、自社便の燃料は燃料法で算定します。
          </p>
        }
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'open-activity-import',
              shortcut: 'new',
              label: '活動量を取り込む',
              icon: <Upload aria-hidden="true" />,
              href: createPanelHref(BASE, periodQuery, { open: true }),
              // 取込の欄を開いているときは、欄の中の「検証する」「取り込む」が主操作
              hidden: permissionReason !== null || panelOpen,
              disabledReason: closed
                ? `期間「${period.label}」は締めています。取り込めません。`
                : undefined,
            }}
            more={sampleLinks.map((link) => ({
              kind: 'link' as const,
              id: `sample-${link.kind}`,
              label: `架空のサンプル: ${link.label}`,
              icon: <Download aria-hidden="true" />,
              href: link.href,
              download: true,
              group: 'export' as const,
            }))}
          />
        }
      />
      <CalcNav current="activity" periodId={period.id} attention={status.attention} />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} />
        {demo && <GhgNotice id="N9" />}

        {panelOpen && (
          <CreatePanel
            id="activity-import"
            title="活動量を取り込む"
            searchParams={params}
            closeHref={createPanelHref(BASE, periodQuery, { open: false })}
            description="検証は保存しません。取り込むと確認中のバッチになり、詳細の画面で確定します。"
          >
            <ActivityImportForm
              periodId={period.id}
              periodLabel={period.label}
              units={importUnits}
              replaceable={replaceable}
              demo={demo}
              demoLimits={{
                batches: DEMO_GHG_LIMITS.userBatches,
                lines: DEMO_GHG_LIMITS.linesPerBatch,
              }}
              sampleLinks={sampleLinks}
            />
          </CreatePanel>
        )}

        <MetricStrip label="活動量の状況">
          <MetricTile
            label="確定"
            value={counts.confirmedBatches}
            unit="件"
            href={`${BASE}?period=${period.id}&status=confirmed#activity-batches`}
          />
          <MetricTile
            label="確認中"
            value={counts.draftBatches}
            unit="件"
            status={
              counts.draftBatches > 0
                ? { semantic: 'pending', label: '確定すると算定に使います' }
                : undefined
            }
            href={`${BASE}?period=${period.id}&status=draft#activity-batches`}
          />
          <MetricTile
            label="未受領"
            value={counts.missingMonths}
            unit="か月"
            status={
              counts.missingMonths > 0
                ? { semantic: 'pending', label: '検証拠点 × 活動で確定済みの行が無い月' }
                : { semantic: 'done', label: 'すべて受領' }
            }
          />
          <MetricTile
            label="見なし積載率の行"
            value={counts.defaultLoadLines}
            unit="行"
            hint="積載率が無く、原単位表で算定する輸送の行"
          />
          <MetricTile
            label="下限を適用する行"
            value={counts.flooredLoadLines ?? '—'}
            unit={counts.flooredLoadLines === null ? undefined : '行'}
            hint={
              coverage.minLoadPct === null
                ? '算定方針が無いため数えられません'
                : `積載率が ${coverage.minLoadPct}% 未満の輸送の行`
            }
          />
        </MetricStrip>

        {coverage.minLoadPct !== null && (
          <LoadFactorNotice
            defaultRows={counts.defaultLoadLines}
            minLoadPct={coverage.minLoadPct}
            flooredRows={counts.flooredLoadLines ?? 0}
          />
        )}
        {counts.overseasTransportLines > 0 && <GhgNotice id="N5" />}

        <Section
          title="拠点 × 活動の充足"
          summary={`検証拠点 ${coverage.sites.filter((s) => s.verification).length}・${coverage.months.length} か月`}
        >
          <CoverageTable coverage={coverage} />
        </Section>

        <Section id="activity-batches" title="取込の記録" summary={`${coverage.batches.length} 件`}>
          <DataTable
            id="ghg-activity-batches"
            caption="活動量の取込の記録"
            columns={columns}
            rows={batchRows}
            getRowId={(b) => b.batch.id}
            getRowLabel={(b) => b.batch.fileName || b.unitName}
            getRowStatus={(b) => statusLabel('ghgActivityBatch', b.batch.status)}
            searchParams={params}
            basePath={BASE}
            search={{ placeholder: 'ファイル名・拠点で検索' }}
            filters={[
              {
                key: 'status',
                label: '状態',
                options: GHG_BATCH_STATUSES.map((s) => ({
                  value: s,
                  label: statusLabel('ghgActivityBatch', s),
                })),
              },
              {
                key: 'kind',
                label: '種類',
                options: GHG_BATCH_KINDS.map((k) => ({ value: k, label: BATCH_KIND_LABELS[k] })),
              },
            ]}
            rowActions={(b) => ({
              rowLabel: b.batch.fileName || b.unitName,
              primary: {
                kind: 'link',
                id: `open-${b.batch.id}`,
                label: b.batch.status === 'draft' ? '確かめて確定' : '詳細を開く',
                href: CALC_DETAIL_HREF.activityBatch(b.batch.id),
              },
            })}
            empty={{
              noData: {
                title: 'この期間の活動量の取込はまだありません',
                action: canImport ? (
                  <Link
                    href={createPanelHref(BASE, periodQuery, { open: true })}
                    className="text-small text-brand-700 hover:underline"
                  >
                    活動量を取り込む
                  </Link>
                ) : (
                  <Link
                    href={calcTabHref('overview', period.id)}
                    className="text-small text-brand-700 hover:underline"
                  >
                    算定の概要へ
                  </Link>
                ),
              },
            }}
          />
        </Section>

        <TonKmPresetSection factorsHref={calcTabHref('factors', period.id)} />
      </div>
    </>
  );
}
