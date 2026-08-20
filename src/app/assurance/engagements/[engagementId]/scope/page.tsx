import { ScopeInclusionBadge } from '@/components/shared/badges';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'スコープ' };

export default async function ScopePage({ params }: { params: Promise<{ engagementId: string }> }) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const scopes = await db.select('engagementScopes', { where: { engagementId } });
  const grants = await db.select('grants', { where: { engagementId } });

  const metricIds = [...new Set(scopes.map((s) => s.metricId))];
  const unitIds = [...new Set(scopes.map((s) => s.unitId))];
  const [metrics, units] = await Promise.all([
    metricIds.length > 0 ? db.select('metrics', { where: { id: { in: metricIds } } }) : [],
    unitIds.length > 0 ? db.select('units', { where: { id: { in: unitIds } } }) : [],
  ]);

  // Grant を経由して閲覧できる範囲だけが実際に見える（RLS と同じ条件）
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const grantedMetricIds = new Set(
    grants.filter((g) => g.subjectType === 'metric' && !g.revokedAt).map((g) => g.subjectId),
  );
  const grantedUnitIds = new Set(
    grants
      .filter((g) => g.subjectType === 'organization_unit' && !g.revokedAt)
      .map((g) => g.subjectId),
  );

  const orderedUnits = [...new Set(scopes.map((s) => s.unitId))];
  const orderedMetrics = [...new Set(scopes.map((s) => s.metricId))];
  const scopeByKey = new Map(scopes.map((s) => [`${s.unitId}|${s.metricId}`, s]));

  return (
    <>
      <EngagementHeader context={context} page="スコープ" />

      <div className="space-y-3 p-4">
        <Card className="overflow-hidden">
          <SectionTitle
            title="Scope Matrix（組織 × 指標 × 期間）"
            action={
              <span className="text-[11px] text-ink-muted">
                Client Grant がない組織・指標は保証対象外として表示されます
              </span>
            }
          />
          {scopes.length === 0 ? (
            <EmptyState title="スコープが設定されていません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>組織 \ 指標</TH>
                    {orderedMetrics.map((metricId) => (
                      <TH key={metricId}>{metricById.get(metricId)?.name ?? '（許諾外）'}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {orderedUnits.map((unitId) => (
                    <TR key={unitId}>
                      <TD className="whitespace-nowrap font-medium">
                        {unitById.get(unitId)?.name ?? '（許諾外の組織）'}
                        {!grantedUnitIds.has(unitId) && (
                          <Badge tone="neutral" className="ml-1">
                            Grant なし
                          </Badge>
                        )}
                      </TD>
                      {orderedMetrics.map((metricId) => {
                        const scope = scopeByKey.get(`${unitId}|${metricId}`);
                        if (!scope) return <TD key={metricId}>—</TD>;
                        return (
                          <TD key={metricId}>
                            <div className="flex flex-col gap-0.5">
                              <ScopeInclusionBadge inclusion={scope.inclusion} />
                              <span className="text-[10px] text-ink-muted">
                                リスク: {scope.riskTag}
                                {scope.materialityFlag && ' / 重要'}
                              </span>
                              {!grantedMetricIds.has(metricId) && (
                                <span className="text-[10px] text-danger">Grant なし</span>
                              )}
                            </div>
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`クライアントからのアクセス許諾（${grants.length}）`} />
          <Table>
            <THead>
              <TR>
                <TH>種別</TH>
                <TH>対象</TH>
                <TH>Evidence 共有</TH>
                <TH>状態</TH>
                <TH>備考</TH>
              </TR>
            </THead>
            <TBody>
              {grants.map((grant) => (
                <TR key={grant.id}>
                  <TD>{grant.subjectType}</TD>
                  <TD className="font-medium">
                    {metricById.get(grant.subjectId)?.name ??
                      unitById.get(grant.subjectId)?.name ??
                      grant.subjectId.slice(0, 8)}
                  </TD>
                  <TD>{grant.includesEvidence ? <Badge tone="brand">あり</Badge> : '—'}</TD>
                  <TD>
                    {grant.revokedAt ? (
                      <Badge tone="danger">取消済み</Badge>
                    ) : (
                      <Badge tone="success">有効</Badge>
                    )}
                  </TD>
                  <TD className="text-[11px] text-ink-muted">{grant.note ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
