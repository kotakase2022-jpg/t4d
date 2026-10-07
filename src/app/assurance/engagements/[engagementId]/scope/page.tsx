import Link from 'next/link';
import { ScopeInclusionBadge } from '@/components/shared/badges';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { GRANT_SUBJECT_LABEL, RISK_TAG_LABEL } from '../../../_components/labels';
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
  const activeGrants = grants.filter((g) => !g.revokedAt).length;

  return (
    <>
      <EngagementHeader context={context} page="スコープ" />

      <div className="space-y-3 p-4">
        <Section
          title="対象範囲の一覧（組織 × 指標 × 期間）"
          summary="クライアントのアクセス許諾が無い組織・指標は、保証対象外として表示されます"
        >
          {scopes.length === 0 ? (
            <EmptyState
              kind="no-data"
              size="compact"
              title="スコープが設定されていません"
              description="クライアントが共有したデータは Data Room で確認できます。共有の範囲は下のアクセス許諾で決まります。"
              action={
                <Button variant="secondary" size="xs" asChild>
                  <Link href={`/assurance/engagements/${engagementId}/data-room`}>
                    Data Room を開く
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="t4d-scroll-x rounded-t4d border border-line">
              <Table>
                <THead>
                  <TR>
                    <TH className="sticky left-0 z-(--z-sticky) bg-surface">組織 \ 指標</TH>
                    {orderedMetrics.map((metricId) => (
                      <TH key={metricId}>{metricById.get(metricId)?.name ?? '（許諾外）'}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {orderedUnits.map((unitId) => (
                    <TR key={unitId}>
                      <TD className="sticky left-0 z-(--z-sticky-col) whitespace-nowrap bg-surface font-medium">
                        {unitById.get(unitId)?.name ?? '（許諾外の組織）'}
                        {!grantedUnitIds.has(unitId) && (
                          <SemanticBadge semantic="excluded" label="許諾なし" className="ml-1" />
                        )}
                      </TD>
                      {orderedMetrics.map((metricId) => {
                        const scope = scopeByKey.get(`${unitId}|${metricId}`);
                        if (!scope) return <TD key={metricId}>—</TD>;
                        return (
                          <TD key={metricId}>
                            <div className="flex flex-col gap-0.5">
                              <ScopeInclusionBadge inclusion={scope.inclusion} />
                              <span className="text-caption text-ink-muted">
                                リスク: {RISK_TAG_LABEL[scope.riskTag] ?? scope.riskTag}
                                {scope.materialityFlag && ' / 重要'}
                              </span>
                              {!grantedMetricIds.has(metricId) && (
                                <span className="text-caption text-danger">許諾なし</span>
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
        </Section>

        <Section
          title={`クライアントからのアクセス許諾（${grants.length}）`}
          summary={`有効 ${activeGrants} 件 ／ 取消済み ${grants.length - activeGrants} 件`}
        >
          {grants.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="アクセス許諾はまだありません"
              description="アクセス許諾はクライアント企業が設定します（監査法人からは付与・変更できません）。必要な範囲は資料依頼（PBC）で依頼してください。"
            />
          ) : (
            <div className="t4d-scroll-x rounded-t4d border border-line">
              <Table>
                <THead>
                  <TR>
                    <TH>種別</TH>
                    <TH>対象</TH>
                    <TH>資料の共有</TH>
                    <TH>状態</TH>
                    <TH>備考</TH>
                  </TR>
                </THead>
                <TBody>
                  {grants.map((grant) => (
                    <TR key={grant.id}>
                      <TD>{GRANT_SUBJECT_LABEL[grant.subjectType] ?? '対象'}</TD>
                      <TD className="font-medium">
                        {metricById.get(grant.subjectId)?.name ??
                          unitById.get(grant.subjectId)?.name ??
                          grant.subjectId.slice(0, 8)}
                      </TD>
                      <TD>{grant.includesEvidence ? 'あり' : '—'}</TD>
                      <TD>
                        {grant.revokedAt ? (
                          <SemanticBadge semantic="excluded" label="取消済み" />
                        ) : (
                          <SemanticBadge semantic="done" label="有効" />
                        )}
                      </TD>
                      <TD className="text-caption text-ink-muted">{grant.note ?? '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
