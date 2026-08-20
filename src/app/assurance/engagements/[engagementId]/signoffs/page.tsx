import Link from 'next/link';
import { CheckCircle2, Lock, Signature } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { requireAssuranceContext } from '@/lib/auth/session';
import { canSignoff } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { evaluateSignoffBlockers, loadEngagementOr404 } from '@/lib/services/assurance';
import type { SignoffStage } from '@/types/domain';
import { createSignoffAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'Sign-off' };

const STAGES: Array<{ stage: SignoffStage; label: string; description: string }> = [
  {
    stage: 'prepared',
    label: 'Prepared（作成）',
    description: '調書の作成が完了したことを示します。',
  },
  {
    stage: 'reviewed',
    label: 'Reviewed（レビュー）',
    description: 'マネージャー等によるレビュー完了。',
  },
  {
    stage: 'partner_approved',
    label: 'Partner Approved（契約責任者承認）',
    description: '契約責任者による最終承認。保証意見の確定はシステム外で行います。',
  },
];

export default async function SignoffsPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const signoffs = await db.select('signoffs', {
    where: { engagementId },
    orderBy: { column: 'createdAt' },
  });
  const profileIds = [...new Set(signoffs.map((s) => s.userId))];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];

  const blockersByStage = new Map<
    SignoffStage,
    Awaited<ReturnType<typeof evaluateSignoffBlockers>>
  >();
  for (const { stage } of STAGES) {
    blockersByStage.set(stage, await evaluateSignoffBlockers(db, ctx, engagementId, stage));
  }

  return (
    <>
      <EngagementHeader context={context} page="Sign-off" />

      <div className="space-y-3 p-4">
        <Card className="border-brand-200 bg-brand-50">
          <p className="flex items-start gap-2 px-3 py-2 text-[12px] text-brand-900">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Sign-off は<strong>本人のみ</strong>が実行できます（代理 Sign-off は禁止。RLS と DB
              トリガの両方で強制しています）。また、抑止条件を 1
              つでも満たさない場合は実行できません。 作成済みの Sign-off
              は取り消せません（追記専用）。
            </span>
          </p>
        </Card>

        <div className="grid grid-cols-3 gap-3">
          {STAGES.map(({ stage, label, description }) => {
            const done = signoffs.filter((s) => s.signoffStage === stage);
            const blockers = blockersByStage.get(stage) ?? [];
            const allowed = canSignoff(ctx, stage);
            return (
              <Card key={stage}>
                <SectionTitle
                  title={label}
                  action={
                    done.length > 0 ? (
                      <Badge tone="success">
                        <CheckCircle2 className="size-3" aria-hidden="true" />
                        実行済み
                      </Badge>
                    ) : blockers.length === 0 ? (
                      <Badge tone="brand">実行可能</Badge>
                    ) : (
                      <Badge tone="danger">抑止中</Badge>
                    )
                  }
                />
                <div className="space-y-2 p-3">
                  <p className="text-[12px] text-ink-muted">{description}</p>

                  {done.length > 0 && (
                    <ul className="space-y-1">
                      {done.map((signoff) => (
                        <li
                          key={signoff.id}
                          className="rounded-t4d border border-line bg-surface-muted p-2 text-[12px]"
                        >
                          <div className="font-medium text-ink">
                            {profiles.find((p) => p.id === signoff.userId)?.displayName ?? '—'}
                          </div>
                          <div className="text-[11px] text-ink-muted">
                            {signoff.roleKey} ／ v{signoff.version} ／{' '}
                            {formatJst(signoff.createdAt)}
                          </div>
                          {signoff.snapshotId && (
                            <div className="text-[11px] text-ink-muted">
                              対象 Snapshot: {signoff.snapshotId.slice(0, 8)}
                            </div>
                          )}
                          {signoff.comment && (
                            <p className="mt-0.5 text-[12px] text-ink">{signoff.comment}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {blockers.length > 0 && (
                    <ul className="space-y-1 rounded-t4d bg-danger-soft p-2">
                      {blockers.map((blocker) => (
                        <li key={blocker.code} className="text-[11px] text-danger">
                          ・{blocker.message}
                          {blocker.href && (
                            <Link href={blocker.href} className="ml-1 underline">
                              対応
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {allowed ? (
                    <form action={createSignoffAction} className="space-y-1.5">
                      <input type="hidden" name="engagementId" value={engagementId} />
                      <input type="hidden" name="stage" value={stage} />
                      <Input name="comment" placeholder="コメント（任意）" aria-label="コメント" />
                      <Button type="submit" size="sm" disabled={blockers.length > 0}>
                        <Signature aria-hidden="true" />
                        {ctx.displayName} として Sign-off
                      </Button>
                    </form>
                  ) : (
                    <p className="text-[11px] text-ink-muted">
                      この段階を実行する権限がありません（現在のロール:{' '}
                      {ctx.workspace.roleKeys.join(' / ')}）。
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        <Card>
          <SectionTitle title={`Sign-off 履歴（${signoffs.length}）`} />
          {signoffs.length === 0 ? (
            <EmptyState title="Sign-off はまだありません" />
          ) : (
            <ul className="divide-y divide-line">
              {signoffs.map((signoff) => (
                <li
                  key={signoff.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5"
                >
                  <span className="text-[12px] text-ink">
                    {signoff.signoffStage} —{' '}
                    {profiles.find((p) => p.id === signoff.userId)?.displayName ?? '—'}
                  </span>
                  <span className="text-[11px] text-ink-muted">{formatJst(signoff.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
