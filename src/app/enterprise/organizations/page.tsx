import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { FlashMessage } from '@/components/shared/flash';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  AddMetricButton,
  AddUnitButton,
  AddReportingPeriodButton,
  CreateCampaignButton,
  EditMetricButton,
  EditUnitButton,
} from './master-forms';

const PERIOD_STATUS_LABEL: Record<string, string> = {
  planning: '計画中',
  collecting: '収集中',
  reviewing: 'レビュー中',
  closed: 'クローズ',
};

export const metadata = { title: '組織・拠点' };

const UNIT_TYPE_LABEL: Record<string, string> = {
  headquarters: '本社',
  division: '事業部',
  site: '事業所・工場',
  subsidiary: 'グループ会社',
  supplier: 'サプライヤー',
};

const CONSOLIDATION_LABEL: Record<string, string> = {
  full: '全部連結',
  proportionate: '比例連結',
  equity: '持分法',
  excluded: '連結対象外',
};

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const canManageOrg = can(shell.ctx, 'enterprise.org.manage');
  const canManageMetric = can(shell.ctx, 'enterprise.metric.manage');
  const canManagePeriod = can(shell.ctx, 'enterprise.period.manage');

  // 収集キャンペーン（ORG-P0-002）。作成済みのものと、そのスコープ件数を表示する。
  const campaigns = await shell.db.select('campaigns', {
    where: { organizationId: shell.ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const campaignScopes =
    campaigns.length > 0
      ? await shell.db.select('campaignScopes', {
          where: { campaignId: { in: campaigns.map((c) => c.id) } },
        })
      : [];
  const scopeCountByCampaign = new Map<string, number>();
  for (const scope of campaignScopes) {
    scopeCountByCampaign.set(
      scope.campaignId,
      (scopeCountByCampaign.get(scope.campaignId) ?? 0) + 1,
    );
  }

  const byParent = new Map<string | null, typeof shell.units>();
  for (const unit of shell.units) {
    const key = unit.parentId;
    const list = byParent.get(key) ?? [];
    list.push(unit);
    byParent.set(key, list);
  }

  const ordered: Array<{ unit: (typeof shell.units)[number]; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const unit of byParent.get(parentId) ?? []) {
      ordered.push({ unit, depth });
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <>
      <PageHeader
        title="組織・拠点"
        description="階層・連結範囲・持分・除外理由を期間別に管理します。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '組織・拠点' }]}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        <Card className="overflow-hidden">
          <SectionTitle
            title={`組織階層（${shell.units.length}）`}
            action={canManageOrg ? <AddUnitButton units={shell.units} /> : undefined}
          />
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>コード</TH>
                <TH>種別</TH>
                <TH>国</TH>
                <TH>通貨</TH>
                <TH>タイムゾーン</TH>
                <TH>連結方法</TH>
                <TH align="right">持分</TH>
                <TH>除外理由</TH>
                {canManageOrg && <TH className="w-10" aria-label="操作" />}
              </TR>
            </THead>
            <TBody>
              {ordered.map(({ unit, depth }) => (
                <TR key={unit.id}>
                  <TD>
                    <span style={{ paddingLeft: depth * 16 }} className="inline-block">
                      {depth > 0 && <span className="mr-1 text-ink-muted">└</span>}
                      {unit.name}
                    </span>
                  </TD>
                  <TD className="font-mono text-[11px]">{unit.code}</TD>
                  <TD>
                    <Badge tone={unit.unitType === 'supplier' ? 'neutral' : 'brand'}>
                      {UNIT_TYPE_LABEL[unit.unitType] ?? unit.unitType}
                    </Badge>
                  </TD>
                  <TD>{unit.countryCode}</TD>
                  <TD>{unit.currencyCode}</TD>
                  <TD className="text-[11px]">{unit.timezone}</TD>
                  <TD>{CONSOLIDATION_LABEL[unit.consolidationMethod]}</TD>
                  <TD align="right">{unit.ownershipPercent}%</TD>
                  <TD className="text-[11px] text-ink-muted">{unit.exclusionReason ?? '—'}</TD>
                  {canManageOrg && (
                    <TD>
                      <EditUnitButton unit={unit} units={shell.units} />
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`報告期間（${shell.periods.length}）`} />
          <Table>
            <THead>
              <TR>
                <TH>コード</TH>
                <TH>名称</TH>
                <TH>開始</TH>
                <TH>終了</TH>
                <TH>状態</TH>
                <TH>提出期限</TH>
              </TR>
            </THead>
            <TBody>
              {shell.periods.map((period) => (
                <TR key={period.id}>
                  <TD className="font-medium">{period.code}</TD>
                  <TD>{period.label}</TD>
                  <TD>{formatJstDate(period.startDate)}</TD>
                  <TD>{formatJstDate(period.endDate)}</TD>
                  <TD>
                    <Badge tone={period.status === 'collecting' ? 'brand' : 'neutral'}>
                      {period.status}
                    </Badge>
                  </TD>
                  <TD>{formatJstDate(period.submissionDueDate)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`報告年度（${shell.periods.length}）`}
            action={canManagePeriod ? <AddReportingPeriodButton /> : undefined}
          />
          <Table>
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
                  <TD className="text-[12px] text-ink-muted">
                    {period.startDate} 〜 {period.endDate}
                  </TD>
                  <TD className="text-[12px] text-ink-muted">{period.submissionDueDate ?? '—'}</TD>
                  <TD>
                    <Badge tone={period.status === 'collecting' ? 'brand' : 'neutral'}>
                      {PERIOD_STATUS_LABEL[period.status]}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`収集キャンペーン（${campaigns.length}）`}
            action={
              canManagePeriod ? (
                <CreateCampaignButton
                  periods={shell.periods}
                  units={shell.units}
                  metrics={shell.metrics}
                />
              ) : undefined
            }
          />
          {campaigns.length === 0 ? (
            <p className="px-3 pb-3 text-[12px] text-ink-muted">
              対象期間・組織・指標・担当・期限をまとめた収集依頼を作成できます。
            </p>
          ) : (
            <Table>
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
                    <TD>
                      {shell.periods.find((p) => p.id === campaign.reportingPeriodId)?.code ?? '—'}
                    </TD>
                    <TD>
                      <Badge tone={campaign.status === 'open' ? 'brand' : 'neutral'}>
                        {campaign.status}
                      </Badge>
                    </TD>
                    <TD>{formatJstDate(campaign.dueDate)}</TD>
                    <TD align="right">{scopeCountByCampaign.get(campaign.id) ?? 0} 件</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`指標マスター（${shell.metrics.length}）`}
            action={canManageMetric ? <AddMetricButton /> : undefined}
          />
          <div className="t4d-scroll-x">
            <Table>
              <THead>
                <TR>
                  <TH>コード</TH>
                  <TH>指標名</TH>
                  <TH>カテゴリ</TH>
                  <TH>単位</TH>
                  <TH>データ型</TH>
                  <TH>集計方法</TH>
                  <TH>Evidence 必須</TH>
                  <TH>重要度</TH>
                  <TH>前年変動許容</TH>
                  <TH>責任部署</TH>
                  {canManageMetric && <TH className="w-10" aria-label="操作" />}
                </TR>
              </THead>
              <TBody>
                {shell.metrics.map((metric) => (
                  <TR key={metric.id}>
                    <TD className="font-mono text-[11px]">{metric.code}</TD>
                    <TD>{metric.name}</TD>
                    <TD>{metric.category}</TD>
                    <TD>{metric.unit}</TD>
                    <TD>{metric.dataType}</TD>
                    <TD>{metric.aggregationMethod}</TD>
                    <TD>{metric.requiresEvidence ? <Badge tone="brand">必須</Badge> : '—'}</TD>
                    <TD>{metric.materiality}</TD>
                    <TD align="right">
                      {metric.yoyWarningRatio === null
                        ? '—'
                        : `±${Math.round(metric.yoyWarningRatio * 100)}%`}
                    </TD>
                    <TD className="text-[11px] text-ink-muted">
                      {metric.responsibleDepartment ?? '—'}
                    </TD>
                    {canManageMetric && (
                      <TD>
                        <EditMetricButton metric={metric} />
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      </div>
    </>
  );
}
