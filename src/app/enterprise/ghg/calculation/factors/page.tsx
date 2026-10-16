import Link from 'next/link';
import { Download, Link2, Unlink, Upload } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { FACTOR_KIND_LABELS } from '@/lib/domain/ghg/factor-import';
import {
  PRESET_FUEL_CO2_EDITION_LABELS,
  PRESET_FUEL_CO2_EDITIONS,
  presetFactorSetHref,
} from '@/lib/exports/ghg-preset-factor-set';
import { ghgDemoFileLinks } from '@/lib/fixtures/ghg-demo-files';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import {
  ASSIGNMENT_LEVEL_LABELS,
  factorFits,
  listAssignmentNeeds,
  needLabel,
  type AssignmentNeed,
  type AssignmentRow,
  type CandidateFactor,
} from '@/lib/services/ghg/assignments';
import { listFactorSets, type FactorSetListEntry } from '@/lib/services/ghg/factor-sets';
import { statusLabel } from '@/lib/ui/status/registry';
import { FACTOR_SET_STATUSES } from '@/types/domain';
import { CALC_DETAIL_HREF, CalcNav } from '../_components/calc-nav';
import { loadCalcContext } from '../_components/calc-context';
import { clearAssignmentAction, saveAssignmentAction } from './actions';
import { FactorImportForm } from './_components/factor-import-form';
import { factorOptionLabel, factorValueText } from './_lib/format';
import { PeriodContext, PeriodSwitch } from './_components/s1-chrome';

export const metadata = { title: '排出係数（Scope1・2算定）' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE = '/enterprise/ghg/calculation/factors';

function param(query: SearchParams, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * P91 排出係数（plan §2.4・CR-01・CR-02。S1）。係数のセットの一覧・取込と、活動量から導いた割当。
 *
 * - 表示の切り替え（?view=sets|assignments）。セットは組織全体、割当は期間ごと（?period=）
 * - 取込は CreatePanel（?new=1）の中で ファイル → 列の対応 → 検証 → 確定。確定すると下書きのセット（P92 で有効にする）
 * - 割当は「必要な割当」の行の操作「割り当てる」から（?assign=1&target=）。選べるのは有効なセットの、
 *   種類・活動・基準・国が合う係数だけ。解決できない割当は「未割当」などの印を行に出す（代わりを使わない）
 * - Demo Mode は架空の注記（N9）を折りたたまずに出す
 */
export default async function GhgFactorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const { shell, period, status } = await loadCalcContext(query);
  const { ctx, db } = shell;
  const demo = ctx.demo;
  const canManage = can(ctx, 'enterprise.metric.manage');
  const view = param(query, 'view') === 'assignments' ? 'assignments' : 'sets';
  const periodQuery = { period: period.id };

  const [sets, overview] = await Promise.all([
    listFactorSets(db, ctx, { periodId: period.id }),
    view === 'assignments' ? listAssignmentNeeds(db, ctx, { periodId: period.id }) : null,
  ]);

  const importOpen = canManage && view === 'sets' && isCreatePanelOpen(query);
  const target = overview?.needs.find((n) => n.key === param(query, 'target')) ?? null;
  const assignOpen = canManage && target !== null && isCreatePanelOpen(query, 'assign');
  const sampleHref = demo
    ? (ghgDemoFileLinks().find((l) => l.kind === 'factor-set')?.href ?? null)
    : null;

  const viewHref = (next: 'sets' | 'assignments') =>
    `${BASE}?${new URLSearchParams({ view: next, ...periodQuery }).toString()}`;

  return (
    <>
      <PageHeader
        title="排出係数（Scope1・2算定）"
        description="係数のセット（年度・版・出所）を取り込み、期間・拠点・国ごとに割り当てます"
        autoBreadcrumbs
        context={<PeriodContext period={period} demo={demo} />}
        help={
          <p>
            係数は「拠点の割当 ＞ 国の割当 ＞
            全社既定の割当」の順に探します。見つからない・同じ優先度に 2 つ以上ある・
            セットが有効でないときは算定でエラーにし、代わりの係数（別の年度・別の版）は使いません。有効にしたセットの係数は
            変更できません（変えるときは新しいセットを取り込みます）。
          </p>
        }
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'import-factor-set',
              label: '係数セットを取り込む',
              icon: <Upload aria-hidden="true" />,
              href: `${createPanelHref(BASE, { ...query, view: 'sets' }, { open: true })}#factor-import`,
              hidden: !canManage || importOpen || assignOpen,
              shortcut: 'new',
            }}
            more={[
              ...(sampleHref
                ? [
                    {
                      kind: 'link' as const,
                      id: 'download-factor-sample',
                      label: '架空のサンプル（係数セット CSV）をダウンロード',
                      icon: <Download aria-hidden="true" />,
                      href: sampleHref,
                      download: true,
                      group: 'export' as const,
                    },
                  ]
                : []),
              // 公的参照プリセット（告示・算定省令の値）。採用を決めたときだけ「係数セットを取り込む」で
              // 出所「公的参照」の下書きのセットにする（既定では算定に使わない。固定文 N10）
              ...PRESET_FUEL_CO2_EDITIONS.map((edition) => ({
                kind: 'link' as const,
                id: `download-preset-${edition}`,
                label: `公的参照プリセットの取込用 CSV（${PRESET_FUEL_CO2_EDITION_LABELS[edition]}）`,
                icon: <Download aria-hidden="true" />,
                href: presetFactorSetHref(edition),
                download: true,
                group: 'export' as const,
              })),
            ]}
          />
        }
      />
      <CalcNav current="factors" periodId={period.id} attention={status.attention} />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={query} />
        {demo && <GhgNotice id="N9" />}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedFilter
            ariaLabel="排出係数の表示"
            current={view}
            items={[
              { key: 'sets', label: '係数のセット', href: viewHref('sets'), count: sets.length },
              {
                key: 'assignments',
                label: '割当',
                href: viewHref('assignments'),
                ...(status.attention.unresolvedLines > 0
                  ? { count: status.attention.unresolvedLines, attention: true }
                  : {}),
              },
            ]}
          />
          {view === 'assignments' && (
            <PeriodSwitch
              basePath={BASE}
              periods={shell.periods}
              current={period}
              searchParams={query}
            />
          )}
        </div>

        {importOpen && (
          <CreatePanel
            id="factor-import"
            title="係数セットを取り込む"
            searchParams={query}
            closeHref={createPanelHref(BASE, query, { open: false })}
            description="係数の表（CSV・Excel）を下書きのセットとして取り込みます。確定した後、セットの画面で内容を確かめてから有効にします。"
          >
            <FactorImportForm
              defaultReferenceYear={period.startDate.slice(0, 4)}
              sampleHref={sampleHref}
            />
          </CreatePanel>
        )}

        {view === 'sets' ? (
          <SetsView sets={sets} query={query} canManage={canManage} />
        ) : overview ? (
          <>
            {assignOpen && target && (
              <AssignPanel
                need={target}
                candidates={overview.candidates}
                periodId={period.id}
                query={query}
              />
            )}
            <AssignmentsView
              overview={overview}
              periodLabel={period.label}
              query={query}
              canManage={canManage}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

// ----------------------------------------------------------------------
// 係数のセット
// ----------------------------------------------------------------------

function SetsView({
  sets,
  query,
  canManage,
}: {
  sets: FactorSetListEntry[];
  query: SearchParams;
  canManage: boolean;
}) {
  const statusFilter = param(query, 'status');
  const search = param(query, 'q')?.trim().toLowerCase() ?? '';
  const rows = sets
    .filter((s) => (statusFilter ? s.set.status === statusFilter : true))
    .filter((s) =>
      search === ''
        ? true
        : `${s.set.code} ${s.set.name} ${s.set.versionLabel} ${s.set.sourceLabel}`
            .toLowerCase()
            .includes(search),
    );
  const columns: DataTableColumn<FactorSetListEntry>[] = [
    {
      key: 'code',
      header: 'コード',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <Link
          href={CALC_DETAIL_HREF.factorSet(row.set.id)}
          className="font-mono text-small text-brand-700 hover:underline"
        >
          {row.set.code}
        </Link>
      ),
    },
    {
      key: 'name',
      header: '名称',
      importance: 'primary',
      cell: (row) => <span className="text-small text-ink">{row.set.name}</span>,
    },
    {
      key: 'origin',
      header: '出所',
      importance: 'primary',
      cell: (row) => <StatusBadge domain="factorOrigin" value={row.set.origin} />,
    },
    {
      key: 'version',
      header: '版',
      importance: 'secondary',
      cell: (row) => <span className="text-small">{row.set.versionLabel || '—'}</span>,
    },
    {
      key: 'publishedOn',
      header: '公表日',
      importance: 'detail',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">
          {row.set.publishedOn ? formatJstDate(row.set.publishedOn) : '—'}
        </span>
      ),
    },
    {
      key: 'referenceYear',
      header: '基準年',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="tnum">{row.set.referenceYear ?? '—'}</span>,
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <StatusBadge domain="ghgFactorSet" value={row.set.status} />,
    },
    {
      key: 'factors',
      header: '係数',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="tnum">{row.factorCount}</span>,
    },
    {
      key: 'assignments',
      header: 'この期間の割当',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="tnum">{row.assignmentCount}</span>,
    },
    {
      key: 'kinds',
      header: '種類',
      importance: 'detail',
      cell: (row) => (
        <span className="text-caption text-ink-muted">
          {Object.entries(row.kindCounts)
            .map(
              ([kind, n]) => `${FACTOR_KIND_LABELS[kind as keyof typeof FACTOR_KIND_LABELS]} ${n}`,
            )
            .join('・') || '—'}
        </span>
      ),
    },
  ];
  return (
    <Section title={`係数のセット（${sets.length}）`}>
      <DataTable<FactorSetListEntry>
        id="ghg-factor-sets"
        caption="係数のセット"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.set.id}
        getRowLabel={(row) => `${row.set.code} ${row.set.name}`}
        getRowStatus={(row) => statusLabel('ghgFactorSet', row.set.status)}
        searchParams={query}
        basePath={BASE}
        search={{ placeholder: 'コード・名称・版・出典で検索' }}
        filters={[
          {
            key: 'status',
            label: '状態',
            options: FACTOR_SET_STATUSES.map((s) => ({
              value: s,
              label: statusLabel('ghgFactorSet', s),
            })),
          },
        ]}
        rowActions={(row) => ({
          rowLabel: `${row.set.code} ${row.set.name}`,
          primary: {
            kind: 'link',
            id: `open-${row.set.id}`,
            label: row.set.status === 'draft' ? '確かめて有効にする' : '係数を見る',
            href: CALC_DETAIL_HREF.factorSet(row.set.id),
          },
        })}
        empty={{
          noData: {
            title: '係数のセットはまだありません',
            description: '組織が使う係数の表（CSV・Excel）を取り込むと、ここに並びます。',
            action: canManage ? (
              <Link
                href={`${createPanelHref(BASE, query, { open: true })}#factor-import`}
                className="text-small text-brand-700 hover:underline"
              >
                係数セットを取り込む
              </Link>
            ) : (
              <Link
                href="/enterprise/ghg/calculation"
                className="text-small text-brand-700 hover:underline"
              >
                算定の概要へ戻る
              </Link>
            ),
          },
        }}
      />
    </Section>
  );
}

// ----------------------------------------------------------------------
// 割当
// ----------------------------------------------------------------------

function needStatusBadge(need: AssignmentNeed) {
  if (need.resolution) return <SemanticBadge semantic="done" label="解決済み" />;
  if (need.error === 'not_assigned') {
    return <SemanticBadge semantic="todo" label="未割当" detail={need.errorLabel ?? undefined} />;
  }
  return <SemanticBadge semantic="error" label={need.errorLabel ?? 'エラー'} />;
}

function AssignmentsView({
  overview,
  periodLabel,
  query,
  canManage,
}: {
  overview: NonNullable<Awaited<ReturnType<typeof listAssignmentNeeds>>>;
  periodLabel: string;
  query: SearchParams;
  canManage: boolean;
}) {
  const unresolved = overview.needs.filter((n) => !n.resolution).length;
  const state = param(query, 'state');
  const needRows = overview.needs.filter((n) =>
    state === 'unresolved' ? !n.resolution : state === 'resolved' ? !!n.resolution : true,
  );
  const assignHref = (need: AssignmentNeed) =>
    `${createPanelHref(BASE, { ...query, target: need.key }, { open: true, openParam: 'assign' })}#assign-panel`;

  const needColumns: DataTableColumn<AssignmentNeed>[] = [
    {
      key: 'unit',
      header: '拠点〔国〕',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="text-small text-ink">
          {row.unit.name}
          <span className="ml-1 font-mono text-caption text-ink-muted">
            〔{row.unit.countryCode}〕
          </span>
        </span>
      ),
    },
    {
      key: 'activity',
      header: '活動',
      importance: 'primary',
      cell: (row) => <span className="text-small">{row.label}</span>,
    },
    {
      key: 'factor',
      header: '解決した係数',
      importance: 'primary',
      cell: (row) =>
        row.resolution ? (
          <span className="block text-small">
            <span className="font-mono text-caption">{row.resolution.factor.code}</span>
            <span className="ml-1 text-ink-muted">
              {factorValueText(row.resolution.factor)}（{row.resolution.factor.factorYear} 年度・
              {row.resolution.set.versionLabel}）
            </span>
          </span>
        ) : (
          <span className="text-small text-ink-muted">—</span>
        ),
    },
    {
      key: 'path',
      header: '経路',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-caption text-ink-muted">
          {row.resolution ? row.resolution.description : row.errorLabel}
        </span>
      ),
    },
    {
      key: 'state',
      header: '状態',
      importance: 'primary',
      cell: needStatusBadge,
    },
    {
      key: 'lines',
      header: '活動量の行',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.lineCount}</span>,
    },
  ];

  const assignmentColumns: DataTableColumn<AssignmentRow>[] = [
    {
      key: 'target',
      header: '範囲',
      importance: 'primary',
      lockVisible: true,
      cell: (row) => (
        <span className="text-small">
          <span className="text-ink-muted">{ASSIGNMENT_LEVEL_LABELS[row.level]}</span>
          {row.level !== 'org_default' && <span className="ml-1 text-ink">{row.targetLabel}</span>}
        </span>
      ),
    },
    {
      key: 'activity',
      header: '活動',
      importance: 'primary',
      cell: (row) => (
        <span className="text-small">
          {needLabel(
            row.assignment.activityKind,
            row.assignment.activityCode,
            row.assignment.basis,
          )}
        </span>
      ),
    },
    {
      key: 'factor',
      header: '係数',
      importance: 'primary',
      cell: (row) =>
        row.factor ? (
          <span className="block text-small">
            <span className="font-mono text-caption">{row.factor.code}</span>
            <span className="ml-1 text-ink-muted">
              {factorValueText(row.factor)}（{row.factor.factorYear} 年度）
            </span>
          </span>
        ) : (
          <span className="text-small text-danger">係数が見つかりません</span>
        ),
    },
    {
      key: 'set',
      header: 'セット',
      importance: 'secondary',
      cell: (row) =>
        row.set ? (
          <span className="inline-flex flex-wrap items-center gap-1 text-small">
            <Link
              href={CALC_DETAIL_HREF.factorSet(row.set.id)}
              className="font-mono text-brand-700 hover:underline"
            >
              {row.set.code}
            </Link>
            {row.set.status !== 'active' && (
              <StatusBadge domain="ghgFactorSet" value={row.set.status} />
            )}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'reason',
      header: '理由',
      importance: 'secondary',
      cell: (row) => (
        <span className="line-clamp-2 text-caption text-ink-muted">
          {row.assignment.reason || '—'}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      header: '更新',
      importance: 'detail',
      cell: (row) => (
        <span className="whitespace-nowrap text-caption">
          {formatJst(row.assignment.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <MetricStrip label="割当の状況">
        <MetricTile
          label="必要な割当"
          value={overview.needs.length}
          hint="確定済みの活動量から導いた組"
        />
        <MetricTile
          label="解決済み"
          value={overview.needs.length - unresolved}
          denominator={overview.needs.length}
          status={{ semantic: 'done', label: '係数が決まっている' }}
        />
        <MetricTile
          label="未割当・エラー"
          value={unresolved}
          status={
            unresolved > 0
              ? { semantic: 'error', label: '算定でエラーになる' }
              : { semantic: 'done', label: 'なし' }
          }
          href={`${BASE}?${new URLSearchParams({ view: 'assignments', period: overview.period.id, state: 'unresolved' }).toString()}`}
        />
        <MetricTile
          label="確認中の活動量のバッチ"
          value={overview.draftBatches}
          hint="確定すると必要な割当に出ます"
        />
      </MetricStrip>

      {unresolved > 0 && (
        <Notice tone="warning" title="係数が決まらない活動があります">
          未割当・エラーの行は、算定でエラーになります（代わりの係数は使いません）。行の「割り当てる」から係数を選んでください。
        </Notice>
      )}

      <Section title={`必要な割当（${periodLabel}・${overview.needs.length}）`}>
        <DataTable<AssignmentNeed>
          id="ghg-assignment-needs"
          caption="必要な割当"
          columns={needColumns}
          rows={needRows}
          getRowId={(row) => row.key}
          getRowLabel={(row) => `${row.unit.name} ${row.label}`}
          getRowStatus={(row) => (row.resolution ? '解決済み' : (row.errorLabel ?? '未割当'))}
          searchParams={query}
          basePath={BASE}
          search={false}
          filters={[
            {
              key: 'state',
              label: '状態',
              options: [
                { value: 'unresolved', label: '未割当・エラー' },
                { value: 'resolved', label: '解決済み' },
              ],
            },
          ]}
          rowActions={(row) => ({
            rowLabel: `${row.unit.name} ${row.label}`,
            primary: {
              kind: 'link',
              id: `assign-${row.key}`,
              label: row.resolution ? '割り当て直す' : '割り当てる',
              icon: <Link2 aria-hidden="true" />,
              href: assignHref(row),
              hidden: !canManage,
            },
          })}
          empty={{
            noData: {
              title: '必要な割当はまだありません',
              description:
                '活動量を取り込んで確定すると、拠点・活動ごとに必要な割当がここに並びます。',
              action: (
                <Link
                  href={`/enterprise/ghg/calculation/activity?period=${encodeURIComponent(overview.period.id)}`}
                  className="text-small text-brand-700 hover:underline"
                >
                  活動量の画面へ
                </Link>
              ),
            },
            filtered: { title: '条件に合う割当はありません' },
          }}
        />
      </Section>

      <Section title={`いまの割当（${overview.assignments.length}）`}>
        {overview.assignments.length === 0 ? (
          <EmptyState
            kind="not-applicable"
            size="compact"
            title="この期間の割当はまだありません"
            description="上の「必要な割当」の行から割り当てます。"
          />
        ) : (
          <DataTable<AssignmentRow>
            id="ghg-assignments"
            caption="いまの割当"
            columns={assignmentColumns}
            rows={overview.assignments}
            getRowId={(row) => row.assignment.id}
            getRowLabel={(row) =>
              `${ASSIGNMENT_LEVEL_LABELS[row.level]} ${row.targetLabel} ${needLabel(row.assignment.activityKind, row.assignment.activityCode, row.assignment.basis)}`
            }
            searchParams={query}
            basePath={BASE}
            search={false}
            rowActions={(row) => {
              const label = `${ASSIGNMENT_LEVEL_LABELS[row.level]} ${row.targetLabel} ${needLabel(row.assignment.activityKind, row.assignment.activityCode, row.assignment.basis)}`;
              return {
                rowLabel: label,
                items: [
                  {
                    kind: 'confirm',
                    id: `clear-${row.assignment.id}`,
                    label: '割当を外す…',
                    icon: <Unlink aria-hidden="true" />,
                    action: clearAssignmentAction,
                    fields: { assignmentId: row.assignment.id, periodId: overview.period.id },
                    hidden: !canManage,
                    disabledReason: row.removeBlockedReason ?? undefined,
                    destructive: true,
                    confirm: {
                      tier: 'irreversible',
                      title: 'この割当を外しますか',
                      scope: `${periodLabel} ／ ${label}`,
                      consequences: [
                        'この範囲の係数が決まらなくなる活動は、算定でエラーになります（国・全社既定の割当があればそちらを使います）。',
                        '外した割当は戻せません（もう一度割り当てることはできます）。',
                      ],
                      confirmLabel: '外す',
                    },
                  },
                ],
              };
            }}
            empty={{
              noData: {
                title: 'この期間の割当はまだありません',
                action: <span className="text-small text-ink-muted">上の表から割り当てます</span>,
              },
            }}
          />
        )}
      </Section>
    </>
  );
}

function AssignPanel({
  need,
  candidates,
  periodId,
  query,
}: {
  need: AssignmentNeed;
  candidates: readonly CandidateFactor[];
  periodId: string;
  query: SearchParams;
}) {
  const fitting = candidates.filter(
    (c) =>
      factorFits(c.factor, need.activityKind, need.activityCode, need.basis) &&
      (c.factor.countryCode === null || c.factor.countryCode === need.unit.countryCode),
  );
  const bySet = new Map<string, CandidateFactor[]>();
  for (const c of fitting) bySet.set(c.set.id, [...(bySet.get(c.set.id) ?? []), c]);
  const closeHref = createPanelHref(
    BASE,
    { ...query, target: undefined },
    {
      open: false,
      openParam: 'assign',
    },
  );
  return (
    <CreatePanel
      id="assign-panel"
      title="係数を割り当てる"
      openParam="assign"
      searchParams={query}
      closeHref={closeHref}
      description="選べるのは有効なセットの、種類・活動・基準・国が合う係数だけです。"
    >
      <dl className="grid gap-x-4 gap-y-0.5 rounded-t4d bg-surface-muted px-3 py-2 text-small sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-muted">拠点〔国〕</dt>
        <dd>
          {need.unit.name}〔{need.unit.countryCode}〕
        </dd>
        <dt className="text-ink-muted">活動</dt>
        <dd>{need.label}</dd>
        <dt className="text-ink-muted">いまの係数</dt>
        <dd>
          {need.resolution
            ? `${need.resolution.factor.code}（${need.resolution.description}）`
            : (need.errorLabel ?? '—')}
        </dd>
      </dl>
      {fitting.length === 0 ? (
        <Notice tone="warning" title="割り当てられる係数がありません">
          有効なセットに、この活動に使える係数がありません。係数セットを取り込んで有効にしてください。
        </Notice>
      ) : (
        <PreservingForm action={saveAssignmentAction} className="space-y-2" aria-label="係数の割当">
          <input type="hidden" name="periodId" value={periodId} />
          <input type="hidden" name="activityKind" value={need.activityKind} />
          <input type="hidden" name="activityCode" value={need.activityCode} />
          <input type="hidden" name="basis" value={need.basis ?? ''} />
          <input type="hidden" name="unitId" value={need.unit.id} />
          <input type="hidden" name="countryCode" value={need.unit.countryCode} />
          <input type="hidden" name="levelLabel:unit" value={need.unit.name} />
          <input type="hidden" name="levelLabel:country" value={need.unit.countryCode} />
          <input
            type="hidden"
            name="levelLabel:org_default"
            value={ASSIGNMENT_LEVEL_LABELS.org_default}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field
              label="割り当てる範囲"
              name="level"
              required
              hint="拠点 ＞ 国 ＞ 全社既定の順に使います"
            >
              {(p) => (
                <NativeSelect {...p} name="level" defaultValue={need.resolution?.path ?? 'unit'}>
                  <option value="unit">この拠点（{need.unit.name}）</option>
                  <option value="country">この国（{need.unit.countryCode}）</option>
                  <option value="org_default">全社既定（すべての拠点）</option>
                </NativeSelect>
              )}
            </Field>
            <Field label="係数" name="factorId" required>
              {(p) => (
                <NativeSelect
                  {...p}
                  name="factorId"
                  defaultValue={need.resolution?.factor.id ?? ''}
                >
                  <option value="" disabled>
                    係数を選ぶ
                  </option>
                  {[...bySet.values()].map((list) => (
                    <optgroup
                      key={list[0]!.set.id}
                      label={`${list[0]!.set.code}（${list[0]!.set.versionLabel}・${statusLabel('factorOrigin', list[0]!.set.origin)}）`}
                    >
                      {list.map((c) => (
                        <option key={c.factor.id} value={c.factor.id}>
                          {factorOptionLabel(c.factor)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field
            label="理由"
            name="reason"
            hint="例: 2025 年分は前年度公表の係数を使う（組織の方針）"
          >
            {(p) => <Textarea {...p} name="reason" rows={2} maxLength={300} />}
          </Field>
          <SubmitButton
            variant="primary"
            size="sm"
            icon={<Link2 aria-hidden="true" />}
            pendingLabel="割り当て中…"
          >
            割り当てる
          </SubmitButton>
        </PreservingForm>
      )}
    </CreatePanel>
  );
}
