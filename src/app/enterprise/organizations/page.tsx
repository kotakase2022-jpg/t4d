import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { NavTabs } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  AGGREGATION_METHOD_LABEL,
  MATERIALITY_LABEL,
  METRIC_CATEGORY_LABEL,
  METRIC_DATA_TYPE_LABEL,
  METRIC_FRAMEWORK_LABEL,
  summarizeFrameworkCoverage,
} from '@/lib/domain/metrics';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import {
  METRIC_CATEGORIES,
  METRIC_FRAMEWORK_KEYS,
  type CollectionCampaign,
  type MetricDefinition,
  type OrganizationUnit,
} from '@/types/domain';
import { createReportingPeriodAction, createUnitAction, updateUnitAction } from '../actions';
import { CAMPAIGN_STATUS_LABEL, CONSOLIDATION_LABEL, UNIT_TYPE_LABEL } from './_components/labels';
import { AddReportingPeriodButton } from './_components/period-dialog';
import { UnitFormFields, type UnitFormValues, type UnitOption } from './_components/unit-form';
import { runKeepingInput } from './_lib/form-adapter';
import {
  filterMetrics,
  filterUnits,
  orderedUnits,
  OWN_METRIC_FRAMEWORK,
  sortMetrics,
  type UnitRow,
} from './_lib/master-tables';
import { nextPeriodDefaults } from './_lib/period-defaults';
import {
  ORG_TAB_LABEL,
  ORG_TABS,
  ORGANIZATIONS_PATH,
  orgTabHref,
  parseOrgTab,
  type OrgTab,
} from './_lib/tabs';

export const metadata = { title: '組織・拠点' };

/**
 * 組織・拠点（plan §2 S10）。6 区画を開いたまま縦に並べていたものを、URL のタブ（?tab=）に分ける:
 * 組織・拠点／報告年度／収集キャンペーン／指標マスター／基準別の充足。各タブの主操作は 1 つ（権限で出し分け）。
 *
 * - 組織・拠点: 一覧（検索・種別と連結方法の絞り込み・階層の順）。追加は作成パネル（?new=1）、
 *   編集は行の「編集」から開く編集パネル（?edit=）。55 行それぞれにフォームを埋め込まない（DOM を膨らませない）
 * - 報告年度: 同じ期間を 2 つの表で出していたものを 1 つに（状態は登録簿のラベル）。追加は 6 項目の小さな
 *   ダイアログで、既定値は最新＋1 年（D12）。追加の操作は組織の管理のときだけ（サービスも組織の管理を求める。R2）
 * - 収集キャンペーン・指標マスター: 作成・編集は専用ページ（モーダルの 115 チェック・19 項目をやめる）
 * - 指標マスター: 一覧（検索・分類と基準の絞り込み・並べ替え・25 件のページ送り）。開示基準の出所の列は
 *   発注者の要望（指標マスターにどの基準が求める指標かを出す）なので既定で見せる
 *
 * 作成・更新は既存の Server Action（F109・F110・F111）をそのまま呼ぶ。業務エラーは入力を残したまま
 * フォームに示し（runKeepingInput）、成功したら同じタブへ ?flash= 付きで戻る。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ----------------------------------------------------------------------
// フォームの送信（既存の Action を呼び、業務エラーは入力を残して返す）
// ----------------------------------------------------------------------

async function saveNewUnit(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => createUnitAction(formData), formData);
  if (failure) return failure;
  redirect(
    orgTabHref('units', {
      flash: 'masterUnitCreated',
      name: String(formData.get('name') ?? '').trim(),
    }),
  );
}

async function saveUnit(_previous: FormActionState, formData: FormData): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => updateUnitAction(formData), formData);
  if (failure) return failure;
  redirect(
    orgTabHref('units', {
      flash: 'masterUnitUpdated',
      name: String(formData.get('name') ?? '').trim(),
    }),
  );
}

async function saveNewPeriod(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => createReportingPeriodAction(formData), formData);
  if (failure) return failure;
  redirect(
    orgTabHref('periods', {
      flash: 'masterPeriodCreated',
      name: String(formData.get('label') ?? formData.get('code') ?? '').trim(),
    }),
  );
}

// ----------------------------------------------------------------------
// 組織・拠点
// ----------------------------------------------------------------------

function unitOption(unit: OrganizationUnit): UnitOption {
  return {
    id: unit.id,
    name: unit.name,
    countryCode: unit.countryCode,
    currencyCode: unit.currencyCode,
    timezone: unit.timezone,
  };
}

/** 自分と子孫（親に選ぶと循環する組織） */
function selfAndDescendants(units: readonly OrganizationUnit[], unitId: string): Set<string> {
  const out = new Set<string>([unitId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const unit of units) {
      if (unit.parentId && out.has(unit.parentId) && !out.has(unit.id)) {
        out.add(unit.id);
        grew = true;
      }
    }
  }
  return out;
}

/** 新しい組織の既定値: 親は最上位の組織が 1 つならそれ。国・通貨・タイムゾーンは親から（D11） */
function newUnitValues(units: readonly OrganizationUnit[]): UnitFormValues {
  const roots = units.filter((u) => u.parentId === null && u.unitType !== 'supplier');
  const parent = roots.length === 1 ? roots[0] : undefined;
  return {
    code: '',
    name: '',
    unitType: 'site',
    parentId: parent?.id ?? '',
    countryCode: parent?.countryCode ?? 'JP',
    currencyCode: parent?.currencyCode ?? 'JPY',
    timezone: parent?.timezone ?? 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: '100',
    exclusionReason: '',
  };
}

function editUnitValues(unit: OrganizationUnit): UnitFormValues {
  return {
    unitId: unit.id,
    code: unit.code,
    name: unit.name,
    unitType: unit.unitType,
    parentId: unit.parentId ?? '',
    countryCode: unit.countryCode,
    currencyCode: unit.currencyCode,
    timezone: unit.timezone,
    consolidationMethod: unit.consolidationMethod,
    ownershipPercent: String(unit.ownershipPercent),
    exclusionReason: unit.exclusionReason ?? '',
  };
}

const UNIT_COLUMNS: DataTableColumn<UnitRow>[] = [
  {
    key: 'name',
    header: '名称',
    importance: 'primary',
    lockVisible: true,
    pinned: 'left',
    cell: ({ unit, depth }) => (
      <span style={{ paddingLeft: depth * 16 }} className="inline-block font-medium text-ink">
        {depth > 0 && (
          <span className="mr-1 text-ink-muted" aria-hidden="true">
            └
          </span>
        )}
        {unit.name}
      </span>
    ),
  },
  {
    key: 'code',
    header: 'コード',
    importance: 'secondary',
    cell: ({ unit }) => <span className="font-mono text-caption">{unit.code}</span>,
  },
  {
    key: 'type',
    header: '種別',
    importance: 'primary',
    cell: ({ unit }) => (
      <Badge tone={unit.unitType === 'supplier' ? 'neutral' : 'brand'}>
        {UNIT_TYPE_LABEL[unit.unitType] ?? unit.unitType}
      </Badge>
    ),
  },
  {
    key: 'consolidation',
    header: '連結方法',
    importance: 'primary',
    cell: ({ unit }) => CONSOLIDATION_LABEL[unit.consolidationMethod],
  },
  {
    key: 'ownership',
    header: '持分',
    importance: 'primary',
    align: 'right',
    cell: ({ unit }) => <span className="tnum">{unit.ownershipPercent}%</span>,
  },
  {
    key: 'country',
    header: '国',
    importance: 'detail',
    cell: ({ unit }) => unit.countryCode,
  },
  {
    key: 'currency',
    header: '通貨',
    importance: 'detail',
    cell: ({ unit }) => unit.currencyCode,
  },
  {
    key: 'timezone',
    header: 'タイムゾーン',
    importance: 'detail',
    cell: ({ unit }) => <span className="text-caption">{unit.timezone}</span>,
  },
  {
    key: 'exclusion',
    header: '除外理由',
    importance: 'detail',
    cell: ({ unit }) => (
      <span className="text-caption text-ink-muted">{unit.exclusionReason ?? '—'}</span>
    ),
  },
];

// ----------------------------------------------------------------------
// 指標マスター
// ----------------------------------------------------------------------

function frameworksCell(metric: MetricDefinition) {
  if (metric.frameworks.length === 0) {
    return <span className="text-caption text-ink-muted">自社独自</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {metric.frameworks.map((framework) => (
        <Badge key={framework} tone="brand">
          {METRIC_FRAMEWORK_LABEL[framework]}
        </Badge>
      ))}
    </span>
  );
}

const METRIC_COLUMNS: DataTableColumn<MetricDefinition>[] = [
  {
    key: 'code',
    header: 'コード',
    importance: 'primary',
    sortKey: 'code',
    pinned: 'left',
    cell: (m) => <span className="font-mono text-caption">{m.code}</span>,
  },
  {
    key: 'name',
    header: '指標名',
    importance: 'primary',
    lockVisible: true,
    sortKey: 'name',
    cell: (m) => <span className="text-ink">{m.name}</span>,
  },
  { key: 'unit', header: '単位', importance: 'primary', sortKey: 'unit', cell: (m) => m.unit },
  {
    key: 'category',
    header: '分類',
    importance: 'primary',
    sortKey: 'category',
    cell: (m) => METRIC_CATEGORY_LABEL[m.category],
  },
  {
    key: 'frameworks',
    header: '求めている基準',
    importance: 'secondary',
    cell: frameworksCell,
  },
  {
    key: 'department',
    header: '責任部署',
    importance: 'secondary',
    sortKey: 'department',
    cell: (m) => (
      <span className="text-caption text-ink-muted">{m.responsibleDepartment ?? '—'}</span>
    ),
  },
  {
    key: 'dataType',
    header: 'データ型',
    importance: 'detail',
    cell: (m) => METRIC_DATA_TYPE_LABEL[m.dataType],
  },
  {
    key: 'aggregation',
    header: '集計方法',
    importance: 'detail',
    cell: (m) => AGGREGATION_METHOD_LABEL[m.aggregationMethod],
  },
  {
    key: 'evidence',
    header: '根拠資料',
    importance: 'detail',
    cell: (m) => (m.requiresEvidence ? <Badge tone="brand">必須</Badge> : '—'),
  },
  {
    key: 'materiality',
    header: '重要度',
    importance: 'detail',
    cell: (m) => MATERIALITY_LABEL[m.materiality],
  },
  {
    key: 'yoy',
    header: '前年変動許容',
    importance: 'detail',
    align: 'right',
    cell: (m) => (m.yoyWarningRatio === null ? '—' : `±${Math.round(m.yoyWarningRatio * 100)}%`),
  },
];

const CAMPAIGN_SEMANTIC: Record<'draft' | 'open' | 'closed', StatusSemantic> = {
  draft: 'draft',
  open: 'in_review',
  closed: 'done',
};

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const tab = parseOrgTab(query.tab);
  const shell = await loadEnterpriseShell();
  const canManageOrg = can(shell.ctx, 'enterprise.org.manage');
  const canManageMetric = can(shell.ctx, 'enterprise.metric.manage');
  const canManagePeriodPlan = can(shell.ctx, 'enterprise.period.manage');

  // 収集キャンペーン（ORG-P0-002）。件数はタブにも出すので、どのタブでも読む
  const campaigns = await shell.db.select('campaigns', {
    where: { organizationId: shell.ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });

  const scopeCounts =
    tab === 'campaigns'
      ? await campaignScopeCounts(
          shell,
          campaigns.map((c) => c.id),
        )
      : new Map<string, number>();

  const tabCounts: Record<OrgTab, number | undefined> = {
    units: shell.units.length,
    periods: shell.periods.length,
    campaigns: campaigns.length,
    metrics: shell.metrics.length,
    coverage: undefined,
  };

  // 組織のタブの条件（作成パネルの開閉リンクは編集パネルの指定を持ち越さない）
  const unitsQuery = { ...query, tab: 'units', edit: undefined };
  const createOpen = tab === 'units' && canManageOrg && isCreatePanelOpen(query);
  const editingId = tab === 'units' && canManageOrg ? one(query.edit) : undefined;
  const editing = editingId ? shell.units.find((u) => u.id === editingId) : undefined;

  const actions =
    tab === 'units' ? (
      <PageActions
        primary={{
          kind: 'link',
          id: 'add-unit',
          shortcut: 'new',
          label: '組織を追加',
          icon: <Plus aria-hidden="true" />,
          href: `${createPanelHref(ORGANIZATIONS_PATH, unitsQuery, { open: true })}#unit-create`,
          // 作成・編集のパネルを開いている間は、パネルの送信が主操作（同時に 2 つ出さない）
          hidden: !canManageOrg || createOpen || Boolean(editing),
        }}
      />
    ) : tab === 'periods' ? (
      // 報告年度の作成はサービスが組織の管理を求める。期間の管理だけでは出さない（R2）
      canManageOrg ? (
        <AddReportingPeriodButton
          action={saveNewPeriod}
          defaults={nextPeriodDefaults(shell.periods)}
        />
      ) : null
    ) : tab === 'campaigns' ? (
      <PageActions
        primary={{
          kind: 'link',
          id: 'create-campaign',
          shortcut: 'new',
          label: 'キャンペーンを作成',
          icon: <Plus aria-hidden="true" />,
          href: '/enterprise/organizations/campaigns/new',
          hidden: !canManagePeriodPlan,
        }}
      />
    ) : tab === 'metrics' ? (
      <PageActions
        primary={{
          kind: 'link',
          id: 'add-metric',
          shortcut: 'new',
          label: '指標を追加',
          icon: <Plus aria-hidden="true" />,
          href: '/enterprise/organizations/metrics/new',
          hidden: !canManageMetric,
        }}
      />
    ) : null;

  return (
    <>
      <PageHeader
        title="組織・拠点"
        description="組織の階層と連結範囲・報告年度・収集キャンペーン・指標マスターを管理します"
        autoBreadcrumbs
        actions={actions}
      />
      <NavTabs
        ariaLabel="組織・拠点の区分"
        current={tab}
        items={ORG_TABS.map((key) => ({
          key,
          label: ORG_TAB_LABEL[key],
          href: orgTabHref(key),
          count: tabCounts[key],
        }))}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {tab === 'units' && (
          <>
            {createOpen && (
              <CreatePanel
                id="unit-create"
                title="組織を追加"
                searchParams={unitsQuery}
                closeHref={createPanelHref(ORGANIZATIONS_PATH, unitsQuery, { open: false })}
                description="必須の項目だけで追加できます。国・通貨・タイムゾーンは親組織から引き継ぎます。"
              >
                <PreservingForm action={saveNewUnit} className="space-y-3" aria-label="組織を追加">
                  <UnitFormFields
                    idPrefix="unit-new"
                    values={newUnitValues(shell.units)}
                    parents={shell.units.map(unitOption)}
                    editing={false}
                  />
                  <SubmitButton variant="primary" size="sm" pendingLabel="追加中…">
                    追加する
                  </SubmitButton>
                </PreservingForm>
              </CreatePanel>
            )}
            {editing && (
              <CreatePanel
                id="unit-edit"
                title={`組織を編集（${editing.name}）`}
                openParam="edit"
                searchParams={{ edit: '1' }}
                closeHref={orgTabHref('units')}
              >
                <PreservingForm
                  key={editing.id}
                  action={saveUnit}
                  className="space-y-3"
                  aria-label={`${editing.name} を編集`}
                >
                  <UnitFormFields
                    idPrefix="unit-edit"
                    values={editUnitValues(editing)}
                    parents={shell.units
                      .filter((u) => !selfAndDescendants(shell.units, editing.id).has(u.id))
                      .map(unitOption)}
                    editing
                  />
                  <SubmitButton variant="primary" size="sm" pendingLabel="更新中…">
                    更新する
                  </SubmitButton>
                </PreservingForm>
              </CreatePanel>
            )}
            <Section title={`組織階層（${shell.units.length}）`} divider="none">
              <DataTable<UnitRow>
                id="org-units"
                caption="組織階層"
                columns={UNIT_COLUMNS}
                rows={filterUnits(orderedUnits(shell.units), {
                  q: one(query.q),
                  type: many(query.type),
                  consolidation: many(query.consolidation),
                })}
                getRowId={(row) => row.unit.id}
                getRowLabel={(row) => row.unit.name}
                searchParams={unitsQuery}
                basePath={ORGANIZATIONS_PATH}
                search={{ placeholder: '組織名・コードで検索' }}
                filters={[
                  {
                    key: 'type',
                    label: '種別',
                    options: Object.entries(UNIT_TYPE_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  },
                  {
                    key: 'consolidation',
                    label: '連結方法',
                    options: Object.entries(CONSOLIDATION_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  },
                ]}
                rowActions={(row) =>
                  canManageOrg
                    ? {
                        rowLabel: row.unit.name,
                        primary: {
                          kind: 'link',
                          id: `edit-unit-${row.unit.id}`,
                          label: '編集',
                          href: `${orgTabHref('units', { edit: row.unit.id })}#unit-edit`,
                        },
                      }
                    : null
                }
                empty={{
                  noData: {
                    title: 'まだ組織が登録されていません',
                    description: '組織・拠点を登録すると、データの収集・連結の範囲を決められます。',
                    action: canManageOrg ? (
                      <Link
                        href={createPanelHref(ORGANIZATIONS_PATH, unitsQuery, { open: true })}
                        className="text-small text-brand-700 underline underline-offset-2"
                      >
                        最初の組織を登録する
                      </Link>
                    ) : (
                      <span className="text-small text-ink-muted">
                        組織・拠点は企業管理者が登録します。
                      </span>
                    ),
                  },
                }}
              />
            </Section>
          </>
        )}

        {tab === 'periods' && (
          <Section title={`報告年度（${shell.periods.length}）`} divider="none">
            <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
              <Table>
                <caption className="sr-only">報告年度</caption>
                <THead>
                  <TR>
                    <TH>コード</TH>
                    <TH>表示名</TH>
                    <TH>期間</TH>
                    <TH>提出期限</TH>
                    <TH>状態</TH>
                  </TR>
                </THead>
                <TBody>
                  {shell.periods.map((period) => (
                    <TR key={period.id}>
                      <TD className="font-medium">{period.code}</TD>
                      <TD>{period.label}</TD>
                      <TD className="tnum text-small text-ink-muted">
                        {formatJstDate(period.startDate)} 〜 {formatJstDate(period.endDate)}
                      </TD>
                      <TD className="tnum text-small text-ink-muted">
                        {formatJstDate(period.submissionDueDate)}
                      </TD>
                      <TD>
                        <StatusBadge domain="period" value={period.status} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            {!canManageOrg && (
              <p className="mt-2 text-small text-ink-muted">
                報告年度の追加は、組織を管理する権限を持つ企業管理者が行います。
              </p>
            )}
          </Section>
        )}

        {tab === 'campaigns' && (
          <Section title={`収集キャンペーン（${campaigns.length}）`} divider="none">
            {campaigns.length === 0 ? (
              <EmptyState
                kind="no-data"
                size="compact"
                title="まだ収集キャンペーンがありません"
                description="対象期間・組織・指標・期限をまとめた収集依頼を作ると、組織ごとに提出のタスクができます。"
                action={
                  canManagePeriodPlan ? (
                    <Link
                      href={'/enterprise/organizations/campaigns/new'}
                      className="text-small text-brand-700 underline underline-offset-2"
                    >
                      最初のキャンペーンを作る
                    </Link>
                  ) : (
                    <span className="text-small text-ink-muted">
                      収集キャンペーンは報告期間を管理する担当者が作ります。
                    </span>
                  )
                }
              />
            ) : (
              <CampaignTable
                campaigns={campaigns}
                periods={shell.periods}
                scopeCounts={scopeCounts}
              />
            )}
          </Section>
        )}

        {tab === 'metrics' && (
          <MetricsTab shell={shell} query={query} canManage={canManageMetric} />
        )}

        {tab === 'coverage' && <CoverageTab shell={shell} />}
      </div>
    </>
  );
}

type Shell = Awaited<ReturnType<typeof loadEnterpriseShell>>;

async function campaignScopeCounts(shell: Shell, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const scopes = await shell.db.select('campaignScopes', { where: { campaignId: { in: ids } } });
  for (const scope of scopes) {
    counts.set(scope.campaignId, (counts.get(scope.campaignId) ?? 0) + 1);
  }
  return counts;
}

function CampaignTable({
  campaigns,
  periods,
  scopeCounts,
}: {
  campaigns: readonly CollectionCampaign[];
  periods: Shell['periods'];
  scopeCounts: Map<string, number>;
}) {
  return (
    <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
      <Table>
        <caption className="sr-only">収集キャンペーン</caption>
        <THead>
          <TR>
            <TH>名称</TH>
            <TH>対象期間</TH>
            <TH>状態</TH>
            <TH>提出期限</TH>
            <TH align="right">収集スコープ</TH>
          </TR>
        </THead>
        <TBody>
          {campaigns.map((campaign) => (
            <TR key={campaign.id}>
              <TD className="font-medium">{campaign.name}</TD>
              <TD>{periods.find((p) => p.id === campaign.reportingPeriodId)?.code ?? '—'}</TD>
              <TD>
                <SemanticBadge
                  semantic={CAMPAIGN_SEMANTIC[campaign.status]}
                  label={CAMPAIGN_STATUS_LABEL[campaign.status]}
                />
              </TD>
              <TD className="tnum">{formatJstDate(campaign.dueDate)}</TD>
              <TD align="right" className="tnum">
                {scopeCounts.get(campaign.id) ?? 0} 件
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function MetricsTab({
  shell,
  query,
  canManage,
}: {
  shell: Shell;
  query: SearchParams;
  canManage: boolean;
}) {
  const metricsQuery = { ...query, tab: 'metrics' };
  const sizes = [25, 50, 100] as const;
  const pageSize = parsePageSize(query.size, sizes);
  const filtered = sortMetrics(
    filterMetrics(shell.metrics, {
      q: one(query.q),
      category: many(query.category),
      framework: many(query.framework),
    }),
    one(query.sort),
    one(query.dir),
  );
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(parsePage(query.page), lastPage);
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <Section title={`指標マスター（${shell.metrics.length}）`} divider="none">
      <DataTable<MetricDefinition>
        id="org-metrics"
        caption="指標マスター"
        columns={METRIC_COLUMNS}
        rows={rows}
        getRowId={(m) => m.id}
        getRowLabel={(m) => m.name}
        searchParams={metricsQuery}
        basePath={ORGANIZATIONS_PATH}
        search={{ placeholder: '指標名・コードで検索' }}
        filters={[
          {
            key: 'category',
            label: '分類',
            options: METRIC_CATEGORIES.map((value) => ({
              value,
              label: METRIC_CATEGORY_LABEL[value],
            })),
          },
          {
            key: 'framework',
            label: '基準',
            options: [
              ...METRIC_FRAMEWORK_KEYS.map((value) => ({
                value,
                label: METRIC_FRAMEWORK_LABEL[value],
              })),
              { value: OWN_METRIC_FRAMEWORK, label: '自社独自' },
            ],
          },
        ]}
        page={{ page, pageSize, total: filtered.length, sizes }}
        rowActions={(m) =>
          canManage
            ? {
                rowLabel: m.name,
                primary: {
                  kind: 'link',
                  id: `edit-metric-${m.id}`,
                  label: '編集',
                  href: `/enterprise/organizations/metrics/${m.id}`,
                },
              }
            : null
        }
        empty={{
          noData: {
            title: 'まだ指標が登録されていません',
            description: '指標を登録すると、拠点ごとに値を集められます。',
            action: canManage ? (
              <Link
                href={'/enterprise/organizations/metrics/new'}
                className="text-small text-brand-700 underline underline-offset-2"
              >
                最初の指標を登録する
              </Link>
            ) : (
              <span className="text-small text-ink-muted">
                指標は指標を管理する権限を持つ担当者が登録します。
              </span>
            ),
          },
        }}
      />
    </Section>
  );
}

/**
 * 基準ごとの指標の充足（指標の数だけでは足りているか分からない。基準ごとに、
 * 求められている指標のうち何件に当年度の値があるか）。値が「入っている」の判定は当年度の Data Point の有無
 * （承認前でも、集める仕組みが動いていることは分かるため）
 */
async function CoverageTab({ shell }: { shell: Shell }) {
  const currentDataPoints = await shell.db.select('dataPoints', {
    where: {
      organizationId: shell.ctx.workspace.organizationId,
      reportingPeriodId: shell.currentPeriod.id,
      deletedAt: { isNull: true },
    },
  });
  const frameworkCoverage = summarizeFrameworkCoverage(
    shell.metrics,
    new Set(currentDataPoints.map((dp) => dp.metricId)),
    METRIC_FRAMEWORK_KEYS,
  );
  return (
    <Section
      title="開示基準からみた指標の充足状況"
      summary={`${shell.currentPeriod.label}の実績値が入っている指標の割合`}
      divider="none"
    >
      <ul className="grid gap-2 md:grid-cols-3">
        {frameworkCoverage.map((coverage) => (
          <li
            key={coverage.framework}
            className="space-y-1.5 rounded-t4d border border-line bg-surface p-2.5"
          >
            <p className="flex items-center justify-between text-caption text-ink-muted">
              <span>{coverage.label} が求める指標</span>
              <span className="tabular-nums text-ink">
                {coverage.collected} / {coverage.required} 件
              </span>
            </p>
            <div className="flex items-center gap-1.5">
              <Progress
                value={coverage.rate}
                tone={coverage.rate >= 80 ? 'success' : coverage.rate >= 50 ? 'warning' : 'danger'}
                label={`${coverage.label} の指標充足率 ${coverage.rate}%`}
              />
              <span className="text-body font-semibold tabular-nums text-ink">
                {coverage.rate}%
              </span>
            </div>
            <p className="flex flex-wrap items-center justify-between gap-1 text-caption">
              {coverage.required - coverage.collected > 0 ? (
                <span className="text-warning-ink">
                  値が無い指標 {coverage.required - coverage.collected} 件
                </span>
              ) : (
                <span className="text-ink-muted">求める指標すべてに値があります</span>
              )}
              <Link
                href={orgTabHref('metrics', { framework: coverage.framework })}
                className="text-brand-700 hover:underline"
              >
                {coverage.label} の指標を一覧で見る
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
