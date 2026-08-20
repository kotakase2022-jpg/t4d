import { Bot, Lock, Snowflake } from 'lucide-react';
import { ReadOnlyBadge } from '@/components/shared/badges';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { detectSnapshotChanges, loadDataRoom, loadEngagementOr404 } from '@/lib/services/assurance';
import {
  assessSnapshotChangeAction,
  createSnapshotAction,
  summarizeChangesAction,
} from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'Data Room' };

export default async function DataRoomPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const { rows, snapshot } = await loadDataRoom(db, ctx, engagementId);
  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];

  const snapshotItems = snapshot
    ? await db.select('snapshotItems', { where: { snapshotId: snapshot.id } })
    : [];
  const itemByDataPoint = new Map(snapshotItems.map((i) => [i.sourceId, i]));

  const aiRuns = await db.select('aiRuns', {
    where: { engagementId, featureType: 'assuranceChangeSummary' },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 1,
  });
  const latestAi = aiRuns[0];

  const canSnapshot = can(ctx, 'assurance.snapshot.create');
  const canAssess = can(ctx, 'assurance.testing.write');

  return (
    <>
      <EngagementHeader
        context={context}
        page="Data Room"
        actions={
          canSnapshot && (
            <form action={createSnapshotAction} className="flex items-center gap-1.5">
              <input type="hidden" name="engagementId" value={engagementId} />
              <Input
                name="label"
                placeholder="Snapshot ラベル"
                aria-label="Snapshot ラベル"
                className="w-44"
              />
              <Button type="submit" size="sm">
                <Snowflake aria-hidden="true" />
                Snapshot を固定
              </Button>
            </form>
          )
        }
      />

      <div className="space-y-3 p-4">
        <Card className="border-brand-200 bg-brand-50">
          <p className="flex items-start gap-2 px-3 py-2 text-[12px] text-brand-900">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              ここに表示されるクライアント原本は <strong>Read-only</strong>{' '}
              です。監査法人側から値を変更することはできません （アプリ層と DB の RLS
              の両方で禁止されています）。監査側の注記・調書・依頼・指摘は別データとして保存されます。
            </span>
          </p>
        </Card>

        {snapshot && (
          <Card>
            <SectionTitle
              title={`Snapshot: ${snapshot.label}`}
              action={
                <span className="text-[11px] text-ink-muted">
                  固定 {formatJst(snapshot.frozenAt)} ／ {snapshot.itemCount} 件 ／ hash{' '}
                  {snapshot.hash.slice(0, 16)}
                </span>
              }
            />
          </Card>
        )}

        {changes.length > 0 && (
          <Card className="border-danger/40">
            <SectionTitle
              title={`Snapshot 固定後の変更（${changes.length}）`}
              action={
                can(ctx, 'assurance.ai.run') && (
                  <form action={summarizeChangesAction}>
                    <input type="hidden" name="engagementId" value={engagementId} />
                    <Button type="submit" size="xs" variant="secondary">
                      <Bot aria-hidden="true" />
                      AI で差分を要約
                    </Button>
                  </form>
                )
              }
            />
            <Table>
              <THead>
                <TR>
                  <TH>対象</TH>
                  <TH>固定時点</TH>
                  <TH>現在</TH>
                  <TH>区分</TH>
                  <TH>影響評価</TH>
                </TR>
              </THead>
              <TBody>
                {changes.map((change) => {
                  const row = rows.find(
                    (r) => itemByDataPoint.get(r.dataPointId)?.id === change.snapshotItemId,
                  );
                  return (
                    <TR key={change.id}>
                      <TD>{row ? `${row.unit?.name ?? '—'} / ${row.metric?.name ?? '—'}` : '—'}</TD>
                      <TD className="tnum text-[12px]">{change.beforeSummary}</TD>
                      <TD className="tnum text-[12px] font-medium text-danger">
                        {change.afterSummary}
                      </TD>
                      <TD>
                        <Badge tone="warning">{change.changeKind}</Badge>
                      </TD>
                      <TD>
                        {change.assessment ? (
                          <Badge tone={change.assessment === 'no_impact' ? 'success' : 'warning'}>
                            {change.assessment}
                          </Badge>
                        ) : canAssess ? (
                          <form
                            action={assessSnapshotChangeAction}
                            className="flex items-center gap-1"
                          >
                            <input type="hidden" name="engagementId" value={engagementId} />
                            <input
                              type="hidden"
                              name="snapshotItemId"
                              value={change.snapshotItemId}
                            />
                            <select
                              name="assessment"
                              aria-label="影響評価"
                              className="h-6 rounded-t4d border border-line bg-surface px-1 text-[11px]"
                            >
                              <option value="no_impact">影響なし</option>
                              <option value="retest_required">再検証が必要</option>
                              <option value="issue_raised">指摘として起票</option>
                            </select>
                            <Button type="submit" size="xs" variant="outline">
                              記録
                            </Button>
                          </form>
                        ) : (
                          <Badge tone="danger">未評価</Badge>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>

            {latestAi && (
              <div className="border-t border-line px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={latestAi.provider === 'mock' ? 'warning' : 'brand'}>
                    {latestAi.provider === 'mock' ? 'Mock / AI未接続' : 'AI生成'}
                  </Badge>
                  <span className="text-[11px] text-ink-muted">
                    確信度 {Math.round(latestAi.confidence * 100)}% ／{' '}
                    {formatJst(latestAi.createdAt)}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {(
                    (latestAi.outputJson.changes as Array<{
                      subject: string;
                      possibleImpact: string;
                    }>) ?? []
                  ).map((c, i) => (
                    <li key={i} className="text-[12px] text-ink">
                      ・{c.possibleImpact}
                    </li>
                  ))}
                </ul>
                {latestAi.warnings.map((w, i) => (
                  <p key={i} className="text-[11px] text-[#8a5d00]">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle
            title={`共有されているクライアントデータ（${rows.length}）`}
            action={<ReadOnlyBadge />}
          />
          {rows.length === 0 ? (
            <EmptyState
              title="共有されているデータがありません"
              description="クライアント側でアクセス許諾（Grant）が設定されると、ここに表示されます。"
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>Source Type</TH>
                    <TH>指標</TH>
                    <TH>組織</TH>
                    <TH align="right">現在値</TH>
                    <TH>単位</TH>
                    <TH align="right">Version</TH>
                    <TH align="right">Evidence</TH>
                    <TH>Client Approval</TH>
                    <TH>Shared At</TH>
                    <TH>Snapshot</TH>
                    <TH>Change</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.dataPointId}>
                      <TD className="text-[11px]">data_point</TD>
                      <TD className="font-medium">{row.metric?.name ?? '—'}</TD>
                      <TD>{row.unit?.name ?? '—'}</TD>
                      <TD align="right">{formatNumber(row.currentValue)}</TD>
                      <TD>{row.currentUnitOfMeasure}</TD>
                      <TD align="right">{row.currentVersionNo ?? '—'}</TD>
                      <TD align="right">{row.evidenceCount}</TD>
                      <TD>
                        <Badge tone="success">{row.clientStatus}</Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                        {formatJst(row.sharedAt)}
                      </TD>
                      <TD>
                        {row.snapshotIncluded ? (
                          <Badge tone="brand">固定済み</Badge>
                        ) : (
                          <Badge tone="neutral">未固定</Badge>
                        )}
                      </TD>
                      <TD>
                        {row.changedSinceSnapshot ? (
                          <Badge tone="danger">変更あり</Badge>
                        ) : (
                          <span className="text-[11px] text-ink-muted">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
