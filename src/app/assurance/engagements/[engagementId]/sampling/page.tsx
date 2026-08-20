import { ListChecks } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadPopulation } from '@/lib/services/assurance';
import { createSampleAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'サンプリング' };

export default async function SamplingPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const view = await loadPopulation(db, ctx, engagementId);

  const samples = await db.select('samples', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const sampleItems =
    samples.length > 0
      ? await db.select('sampleItems', { where: { sampleId: { in: samples.map((s) => s.id) } } })
      : [];
  const itemById = new Map((view?.items ?? []).map((i) => [i.id, i]));
  const canSample = can(ctx, 'assurance.sampling.run');

  return (
    <>
      <EngagementHeader context={context} page="サンプリング" />

      <div className="space-y-3 p-4">
        {!view ? (
          <Card>
            <EmptyState title="母集団が作成されていません" />
          </Card>
        ) : (
          <>
            {canSample && (
              <Card>
                <SectionTitle
                  title="サンプル抽出"
                  action={
                    <span className="text-[11px] text-ink-muted">
                      同一 Seed で再現可能です（Seed・抽出条件・選定理由を保存します）
                    </span>
                  }
                />
                <form action={createSampleAction} className="grid grid-cols-6 gap-2 p-3">
                  <input type="hidden" name="engagementId" value={engagementId} />
                  <input type="hidden" name="populationId" value={view.population.id} />

                  <label className="col-span-1 text-[12px] text-ink-muted">
                    サンプル名
                    <Input
                      name="name"
                      defaultValue={`SMP-${samples.length + 1}`}
                      className="mt-0.5"
                    />
                  </label>
                  <label className="col-span-1 text-[12px] text-ink-muted">
                    抽出方法
                    <select
                      name="method"
                      defaultValue="random"
                      className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                    >
                      <option value="random">無作為抽出</option>
                      <option value="stratified">層化抽出（組織別）</option>
                      <option value="key_item">重要項目抽出（金額基準）</option>
                      <option value="judgmental">判断による抽出</option>
                    </select>
                  </label>
                  <label className="col-span-1 text-[12px] text-ink-muted">
                    サンプル件数
                    <Input
                      name="targetSize"
                      type="number"
                      min={1}
                      max={view.items.length}
                      defaultValue={Math.min(10, view.items.length)}
                      className="mt-0.5"
                    />
                  </label>
                  <label className="col-span-1 text-[12px] text-ink-muted">
                    乱数 Seed
                    <Input
                      name="seed"
                      defaultValue={`${context.engagement.code}-S${samples.length + 1}`}
                      className="mt-0.5"
                    />
                  </label>
                  <label className="col-span-1 text-[12px] text-ink-muted">
                    層あたり件数
                    <Input
                      name="perStratum"
                      type="number"
                      min={1}
                      placeholder="層化のみ"
                      className="mt-0.5"
                    />
                  </label>
                  <label className="col-span-1 text-[12px] text-ink-muted">
                    重要項目の閾値
                    <Input
                      name="keyItemThreshold"
                      type="number"
                      placeholder="重要項目のみ"
                      className="mt-0.5"
                    />
                  </label>
                  <label className="col-span-6 text-[12px] text-ink-muted">
                    選定理由（調書に残ります）
                    <Textarea
                      name="rationale"
                      rows={2}
                      defaultValue="限定的保証水準に基づき、母集団から無作為に抽出した。"
                      className="mt-0.5"
                    />
                  </label>
                  <div className="col-span-6">
                    <Button type="submit" size="sm">
                      <ListChecks aria-hidden="true" />
                      サンプルを抽出
                    </Button>
                  </div>
                </form>
              </Card>
            )}

            {samples.length === 0 ? (
              <Card>
                <EmptyState title="サンプルが未作成です" />
              </Card>
            ) : (
              samples.map((sample) => {
                const items = sampleItems
                  .filter((i) => i.sampleId === sample.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder);
                return (
                  <Card key={sample.id} className="overflow-hidden">
                    <SectionTitle
                      title={`${sample.name}（${sample.size} 件）`}
                      action={
                        <span className="flex items-center gap-2 text-[11px] text-ink-muted">
                          <Badge tone="brand">{sample.method}</Badge>
                          <span>Seed: {sample.seed}</span>
                          <span>母集団 v{sample.populationVersionNo}</span>
                          <span>{formatJst(sample.createdAt)}</span>
                        </span>
                      }
                    />
                    <p className="border-b border-line px-3 py-1.5 text-[12px] text-ink-muted">
                      選定理由: {sample.rationale}
                    </p>
                    <Table>
                      <THead>
                        <TR>
                          <TH align="right">#</TH>
                          <TH>指標</TH>
                          <TH>組織（層）</TH>
                          <TH align="right">固定値</TH>
                          <TH>単位</TH>
                          <TH>選定理由</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {items.map((item, index) => {
                          const populationItem = itemById.get(item.populationItemId);
                          return (
                            <TR key={item.id}>
                              <TD align="right">{index + 1}</TD>
                              <TD className="font-medium">{populationItem?.metricName ?? '—'}</TD>
                              <TD>{item.stratum ?? populationItem?.unitName ?? '—'}</TD>
                              <TD align="right">{formatNumber(populationItem?.value ?? null)}</TD>
                              <TD>{populationItem?.unitOfMeasure ?? ''}</TD>
                              <TD className="text-[11px] text-ink-muted">{item.selectionReason}</TD>
                            </TR>
                          );
                        })}
                      </TBody>
                    </Table>
                  </Card>
                );
              })
            )}
          </>
        )}
      </div>
    </>
  );
}
