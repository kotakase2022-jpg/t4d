import Link from 'next/link';
import { ListChecks, ListPlus } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadPopulation } from '@/lib/services/assurance';
import { statusOptions } from '@/lib/ui/status/registry';
import { createSampleAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'サンプリング' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SamplingPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const view = await loadPopulation(db, ctx, engagementId);
  const base = `/assurance/engagements/${engagementId}`;
  const basePath = `${base}/sampling`;

  const samples = await db.select('samples', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const sampleItems =
    samples.length > 0
      ? await db.select('sampleItems', { where: { sampleId: { in: samples.map((s) => s.id) } } })
      : [];
  const itemById = new Map((view?.items ?? []).map((i) => [i.id, i]));
  const canSample = can(ctx, 'assurance.sampling.run') && view !== null;
  const panelOpen = canSample && isCreatePanelOpen(query);
  const openHref = createPanelHref(basePath, query, { open: true });

  return (
    <>
      <EngagementHeader
        context={context}
        page="サンプリング"
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'new-sample',
              shortcut: 'new',
              label: '新しいサンプルを抽出',
              icon: <ListPlus aria-hidden="true" />,
              href: openHref,
              // 抽出の欄を開いているときは、欄の中の「サンプルを抽出」が主操作
              hidden: !canSample || panelOpen,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'open-testing',
                label: '保証手続・調書へ',
                href: `${base}/testing`,
                hidden: samples.length === 0,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {!view ? (
          <EmptyState
            kind="no-data"
            title="母集団が作成されていません"
            description="Data Room で Snapshot を固定すると母集団が構成され、ここからサンプルを抽出できます。"
            action={
              <Button variant="secondary" size="sm" asChild>
                <Link href={`${base}/data-room`}>Data Room で Snapshot を固定する</Link>
              </Button>
            }
          />
        ) : (
          <>
            {canSample && (
              <CreatePanel
                id="create-sample"
                title="サンプルを抽出"
                searchParams={query}
                closeHref={createPanelHref(basePath, query, { open: false })}
                description="同一 Seed で再現可能です（Seed・抽出条件・選定理由を保存します）。"
              >
                <form action={createSampleAction} className="space-y-3">
                  <input type="hidden" name="engagementId" value={engagementId} />
                  <input type="hidden" name="populationId" value={view.population.id} />

                  <FormSection title="抽出の条件" kind="required">
                    <div className="grid grid-cols-4 gap-2">
                      <Field label="サンプル名" name="name" required>
                        {(p) => (
                          <Input {...p} name="name" defaultValue={`SMP-${samples.length + 1}`} />
                        )}
                      </Field>
                      <Field label="抽出方法" name="method" required>
                        {(p) => (
                          <NativeSelect {...p} name="method" defaultValue="random">
                            {statusOptions('samplingMethod').map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NativeSelect>
                        )}
                      </Field>
                      <Field
                        label="サンプル件数"
                        name="targetSize"
                        required
                        hint={`母集団 ${view.items.length} 件から`}
                      >
                        {(p) => (
                          <Input
                            {...p}
                            name="targetSize"
                            type="number"
                            min={1}
                            max={view.items.length}
                            defaultValue={Math.min(10, view.items.length)}
                          />
                        )}
                      </Field>
                      <Field label="乱数 Seed" name="seed" required hint="同じ Seed なら同じ結果">
                        {(p) => (
                          <Input
                            {...p}
                            name="seed"
                            defaultValue={`${context.engagement.code}-S${samples.length + 1}`}
                          />
                        )}
                      </Field>
                    </div>
                    <Field label="選定理由（調書に残ります）" name="rationale" required>
                      {(p) => (
                        <Textarea
                          {...p}
                          name="rationale"
                          rows={2}
                          defaultValue="限定的保証水準に基づき、母集団から無作為に抽出した。"
                        />
                      )}
                    </Field>
                  </FormSection>

                  <FormSection
                    title="方法ごとの条件（層化・重要項目・判断による抽出）"
                    kind="optional"
                    description="選んだ抽出方法に関係する欄だけが使われます（他の方法では無視されます）。"
                  >
                    <div className="grid grid-cols-4 gap-2">
                      <Field label="層あたり件数" name="perStratum" hint="層化抽出のみ">
                        {(p) => <Input {...p} name="perStratum" type="number" min={1} />}
                      </Field>
                      <Field label="重要項目の閾値" name="keyItemThreshold" hint="重要項目抽出のみ">
                        {(p) => <Input {...p} name="keyItemThreshold" type="number" />}
                      </Field>
                    </div>
                    {/*
                      「判断による抽出」は監査人が対象を名指しする方式なので、
                      ここで選ばないと該当 0 件になり、必ず失敗する。
                      他の方式では無視されるため、常に置いておく。
                    */}
                    <div>
                      <p className="mb-1 text-small font-medium text-ink">
                        判断による抽出の対象（{view.items.length} 件から選ぶ）
                      </p>
                      <div className="max-h-64 overflow-y-auto rounded-t4d border border-line">
                        <Table>
                          <THead>
                            <TR>
                              <TH className="w-8">
                                <span className="sr-only">選択</span>
                              </TH>
                              <TH>指標</TH>
                              <TH>組織</TH>
                              <TH align="right">値</TH>
                            </TR>
                          </THead>
                          <TBody>
                            {view.items.map((item) => (
                              <TR key={item.id}>
                                <TD>
                                  <NativeCheckbox
                                    name="selectedItemIds"
                                    value={item.id}
                                    aria-label={`${item.metricName}（${item.unitName}）を判断による抽出の対象にする`}
                                  />
                                </TD>
                                <TD className="font-medium">{item.metricName}</TD>
                                <TD>{item.unitName}</TD>
                                <TD align="right" className="tnum">
                                  {formatNumber(item.value)}
                                  <span className="ml-1 text-caption text-ink-muted">
                                    {item.unitOfMeasure}
                                  </span>
                                </TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </div>
                    </div>
                  </FormSection>

                  <SubmitButton
                    variant="primary"
                    size="sm"
                    icon={<ListChecks aria-hidden="true" />}
                    pendingLabel="抽出中…"
                  >
                    サンプルを抽出
                  </SubmitButton>
                </form>
              </CreatePanel>
            )}

            {samples.length === 0 ? (
              canSample ? (
                <EmptyState
                  kind="no-data"
                  title="サンプルが未作成です"
                  description={`母集団 ${view.items.length} 件から、方法と件数を決めて抽出します。`}
                  action={
                    <Button variant="secondary" size="sm" asChild>
                      <Link href={openHref}>最初のサンプルを抽出</Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  kind="not-applicable"
                  title="サンプルが未作成です"
                  description="サンプルの抽出は、マネージャー・担当者が行います。"
                />
              )
            ) : (
              samples.map((sample, index) => {
                const items = sampleItems
                  .filter((i) => i.sampleId === sample.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder);
                const meta = (
                  <span className="inline-flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                    <StatusBadge domain="samplingMethod" value={sample.method} />
                    <span>Seed: {sample.seed}</span>
                    <span>母集団 v{sample.populationVersionNo}</span>
                    <span>{formatJst(sample.createdAt)}</span>
                  </span>
                );
                const body = (
                  <>
                    <p className="pb-1.5 text-small text-ink-muted">選定理由: {sample.rationale}</p>
                    <div className="t4d-scroll-x rounded-t4d border border-line">
                      <Table>
                        <THead>
                          <TR>
                            <TH align="right">#</TH>
                            <TH>指標</TH>
                            <TH>組織（層）</TH>
                            <TH align="right">固定値</TH>
                            <TH>選定理由</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {items.map((item, position) => {
                            const populationItem = itemById.get(item.populationItemId);
                            return (
                              <TR key={item.id}>
                                <TD align="right">{position + 1}</TD>
                                <TD className="font-medium">{populationItem?.metricName ?? '—'}</TD>
                                <TD>{item.stratum ?? populationItem?.unitName ?? '—'}</TD>
                                <TD align="right" className="tnum">
                                  {formatNumber(populationItem?.value ?? null)}
                                  <span className="ml-1 text-caption text-ink-muted">
                                    {populationItem?.unitOfMeasure ?? ''}
                                  </span>
                                </TD>
                                <TD className="text-caption text-ink-muted">
                                  {item.selectionReason}
                                </TD>
                              </TR>
                            );
                          })}
                        </TBody>
                      </Table>
                    </div>
                  </>
                );
                // 最新のサンプル（調書の対象）は開いて描き、過去のサンプルは閉じておく
                return index === 0 ? (
                  <Section
                    key={sample.id}
                    title={`${sample.name}（${sample.size} 件）`}
                    summary={meta}
                  >
                    {body}
                  </Section>
                ) : (
                  <Section
                    key={sample.id}
                    id={`sample-${sample.id}`}
                    title={`${sample.name}（${sample.size} 件）`}
                    collapsible
                    summary={meta}
                  >
                    {body}
                  </Section>
                );
              })
            )}
          </>
        )}
      </div>
    </>
  );
}
