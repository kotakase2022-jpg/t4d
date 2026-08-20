import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadPopulation } from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '母集団' };

export default async function PopulationPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const view = await loadPopulation(db, ctx, engagementId);

  return (
    <>
      <EngagementHeader context={context} page="母集団" />

      <div className="space-y-3 p-4">
        {!view ? (
          <Card>
            <EmptyState
              title="母集団が作成されていません"
              description="Snapshot を固定すると、保証対象 Data Point から母集団が構成されます。"
            />
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-6 gap-2">
              <Stat label="Population Count" value={view.population.itemCount} />
              <Stat label="Population Sum" value={formatNumber(view.population.totalValue)} />
              <Stat
                label="Missing"
                value={view.population.missingCount}
                tone={view.population.missingCount > 0 ? 'warning' : 'success'}
              />
              <Stat label="Duplicate" value={view.population.duplicateCount} />
              <Stat label="Excluded" value={view.population.excludedCount} />
              <Stat label="Version" value={`v${view.population.versionNo}`} />
            </div>

            <Card>
              <SectionTitle title="完全性の確認（Completeness）" />
              <dl className="space-y-2 px-3 pb-3 text-[12px]">
                <div>
                  <dt className="font-medium text-ink">スコープ上の対象件数</dt>
                  <dd className="text-ink-muted">
                    {view.expectedInScope} 件（Scope Matrix で「対象」とした 組織 × 指標）
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-ink">母集団に含まれた件数</dt>
                  <dd className="text-ink-muted">
                    {view.population.itemCount} 件（差 {view.population.missingCount}{' '}
                    件は企業側で未承認のため）
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-ink">照合メモ（Reconciliation）</dt>
                  <dd className="text-ink-muted">{view.population.reconciliationNote ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-ink">完全性手続メモ</dt>
                  <dd className="whitespace-pre-wrap text-ink-muted">
                    {view.population.completenessProcedureNote ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-ink">作成</dt>
                  <dd className="text-ink-muted">{formatJst(view.population.createdAt)}</dd>
                </div>
              </dl>
            </Card>

            <Card className="overflow-hidden">
              <SectionTitle title={`母集団項目（${view.items.length}）`} />
              <div className="t4d-scroll-x">
                <Table className="t4d-sticky-head">
                  <THead>
                    <TR>
                      <TH>指標</TH>
                      <TH>組織（層）</TH>
                      <TH align="right">固定値</TH>
                      <TH>単位</TH>
                      <TH>除外</TH>
                      <TH>除外理由</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {view.items.map((item) => (
                      <TR key={item.id}>
                        <TD className="font-medium">{item.metricName}</TD>
                        <TD>{item.unitName}</TD>
                        <TD align="right">{formatNumber(item.value)}</TD>
                        <TD>{item.unitOfMeasure}</TD>
                        <TD>{item.excluded ? <Badge tone="warning">除外</Badge> : '—'}</TD>
                        <TD className="text-[11px] text-ink-muted">
                          {item.exclusionReason ?? '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'warning' | 'success';
}) {
  return (
    <Card>
      <div className="px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </div>
        <div
          className={`tnum text-[20px] font-semibold ${
            tone === 'warning' ? 'text-[#8a5d00]' : tone === 'success' ? 'text-success' : 'text-ink'
          }`}
        >
          {value}
        </div>
      </div>
    </Card>
  );
}
