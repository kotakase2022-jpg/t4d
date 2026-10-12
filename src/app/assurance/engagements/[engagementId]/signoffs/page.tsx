import Link from 'next/link';
import { Lock, Signature } from 'lucide-react';
import { ActionButton } from '@/components/shared/action-button';
import { FlashMessage } from '@/components/shared/flash';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can, canSignoff } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  evaluateSignoffBlockers,
  loadEngagementOr404,
  loadSharedReportList,
  loadSignoffReportAttention,
  sharedReportLabel,
} from '@/lib/services/assurance';
import { canFor } from '@/lib/ui/home-profile';
import { signoffStateActions } from '@/lib/ui/state-actions';
import { statusLabel } from '@/lib/ui/status/registry';
import type { SignoffStage } from '@/types/domain';
import { createSignoffAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';
import { SignoffReportAttentionText } from './report-attention';

export const metadata = { title: 'Sign-off' };

const STAGES: Array<{ stage: SignoffStage; description: string }> = [
  { stage: 'prepared', description: '調書の作成が完了したことを示します。' },
  { stage: 'reviewed', description: 'マネージャー等によるレビュー完了。' },
  {
    stage: 'partner_approved',
    description: '契約責任者による最終承認。保証意見の確定はシステム外で行います。',
  },
];

export default async function SignoffsPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const signoffs = await db.select('signoffs', {
    where: { engagementId },
    orderBy: { column: 'createdAt' },
  });
  // Sign-off に結び付けられる開示レポート（共有中の写し。NF-23）と、Sign-off 後に共有された別の承認版の注意
  const [reportRows, reportAttention, allCopies] = await Promise.all([
    can(ctx, 'assurance.engagement.read') ? loadSharedReportList(db, ctx, engagementId) : [],
    loadSignoffReportAttention(db, ctx, engagementId),
    // 保証側が読めるのは共有中の写しだけ（取り下げた写しは DB の SELECT ポリシーでも返らない）
    db.select('sharedReportCopies', { where: { engagementId, withdrawnAt: { isNull: true } } }),
  ]);
  const linkable = reportRows.filter((row) => row.integrityOk);
  const reportLabelOf = (copyId: string): string => {
    const copy = allCopies.find((c) => c.id === copyId);
    const content = copy ? parseSharedReportCopy(copy.copy) : null;
    if (!copy) return '（企業が共有を取り下げた写し）';
    return content ? sharedReportLabel(content) : '（写しを読めません）';
  };
  const profileIds = [...new Set(signoffs.map((s) => s.userId))];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];
  const nameOf = (userId: string) => profiles.find((p) => p.id === userId)?.displayName ?? '—';

  const blockersByStage = new Map<
    SignoffStage,
    Awaited<ReturnType<typeof evaluateSignoffBlockers>>
  >();
  for (const { stage } of STAGES) {
    blockersByStage.set(stage, await evaluateSignoffBlockers(db, ctx, engagementId, stage));
  }

  // 主操作は、自分が実行できる未完了の段階のうち最初のもの 1 つ（抑止中なら押せない理由を添える）
  const nextStage = STAGES.find(
    ({ stage }) => canSignoff(ctx, stage) && !signoffs.some((s) => s.signoffStage === stage),
  )?.stage;
  const roles = ctx.workspace.roleKeys.map(roleLabel).join(' / ');

  return (
    <>
      <EngagementHeader context={context} page="Sign-off" />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 代理禁止・追記専用は安全の注記（折りたたまない） */}
        <Notice tone="info">
          <span className="flex items-start gap-1.5">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Sign-off は<strong>本人のみ</strong>が実行できます（代理 Sign-off は禁止。RLS と DB
              トリガの両方で強制しています）。また、抑止条件を 1
              つでも満たさない場合は実行できません。 作成済みの Sign-off
              は取り消せません（追記専用）。
            </span>
          </span>
        </Notice>

        {reportAttention && (
          // Sign-off の後に別の承認版が共有された／結び付けた写しが取り下げられた（保存せず毎回導く）
          <Notice tone="warning" title="Sign-off の後に開示レポートが変わりました">
            <SignoffReportAttentionText
              attention={reportAttention}
              labelOf={reportLabelOf}
              reportsHref={`/assurance/engagements/${engagementId}/reports`}
            />
          </Notice>
        )}

        <div className="grid grid-cols-3 gap-3">
          {STAGES.map(({ stage, description }) => {
            const label = statusLabel('signoff', stage);
            const done = signoffs.filter((s) => s.signoffStage === stage);
            const blockers = blockersByStage.get(stage) ?? [];
            const plan = signoffStateActions({
              stage,
              can: canFor(ctx),
              blockers: blockers.map((b) => b.message),
            });
            return (
              <section
                key={stage}
                aria-labelledby={`stage-${stage}`}
                className="space-y-2 rounded-t4d-lg border border-line bg-surface p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 id={`stage-${stage}`} className="text-body font-semibold text-ink">
                    {label}
                  </h2>
                  {done.length > 0 ? (
                    <SemanticBadge semantic="done" label="実行済み" />
                  ) : blockers.length === 0 ? (
                    <SemanticBadge semantic="todo" label="実行可能" />
                  ) : (
                    <SemanticBadge semantic="blocked" label="抑止中" />
                  )}
                </div>
                <p className="text-small text-ink-muted">{description}</p>

                {done.length > 0 && (
                  <ul className="space-y-1">
                    {done.map((signoff) => (
                      <li
                        key={signoff.id}
                        className="rounded-t4d border border-line bg-surface-muted p-2 text-small"
                      >
                        <div className="font-medium text-ink">{nameOf(signoff.userId)}</div>
                        <div className="text-caption text-ink-muted">
                          {roleLabel(signoff.roleKey)} ／ 版 {signoff.version} ／{' '}
                          {formatJst(signoff.createdAt)}
                        </div>
                        {signoff.snapshotId && (
                          <div className="text-caption text-ink-muted">
                            対象 Snapshot: {signoff.snapshotId.slice(0, 8)}
                          </div>
                        )}
                        {signoff.sharedReportCopyId && (
                          <div className="text-caption text-ink-muted" data-signoff-report="">
                            対象の開示レポート:{' '}
                            <Link
                              href={`/assurance/engagements/${engagementId}/reports/${signoff.sharedReportCopyId}`}
                              className="text-brand-700 hover:underline"
                            >
                              {reportLabelOf(signoff.sharedReportCopyId)}
                            </Link>
                            （写しのハッシュ{' '}
                            <span className="font-mono">
                              {(signoff.sharedReportContentHash ?? '').slice(0, 12)}
                            </span>
                            ）
                          </div>
                        )}
                        {signoff.comment && (
                          <p className="mt-0.5 text-small text-ink">{signoff.comment}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {blockers.length > 0 && (
                  <ul className="space-y-1 rounded-t4d bg-danger-soft p-2">
                    {blockers.map((blocker) => (
                      <li key={blocker.code} className="text-caption text-danger">
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

                {plan.primary ? (
                  // 取り消せない記録なので、範囲（誰が・どの案件の・どの段階）を確かめてから送る（plan §1.16 区分 1）
                  <ActionButton
                    variant={stage === nextStage ? 'primary' : 'secondary'}
                    action={{
                      kind: 'confirm',
                      id: `signoff-${stage}`,
                      label: plan.primary.label,
                      icon: <Signature aria-hidden="true" />,
                      action: createSignoffAction,
                      fields: { engagementId, stage },
                      disabledReason: plan.primary.disabledReason,
                      confirm: {
                        tier: 'irreversible',
                        title: `「${label}」の Sign-off を記録しますか`,
                        scope: `${ctx.displayName}（本人）として、${context.engagement.code} の「${label}」を記録します。`,
                        consequences: [
                          '作成した Sign-off は取り消せません（追記専用）。',
                          '代理 Sign-off は禁止です。本人のアカウントで記録されます。',
                          ...(linkable.length > 0
                            ? [
                                '対象の開示レポートを選ぶと、その写しと内容ハッシュを Sign-off に記録します（後から別の承認版が共有されると、案件の概要に注意が出ます）。',
                              ]
                            : []),
                        ],
                        extraFields: (
                          <div className="space-y-2">
                            {linkable.length > 0 && (
                              <label className="block space-y-1">
                                <span className="text-small font-medium text-ink">
                                  対象の開示レポート
                                  <span className="ml-1 text-caption font-normal text-ink-muted">
                                    （任意）
                                  </span>
                                </span>
                                <NativeSelect
                                  name="sharedReportCopyId"
                                  aria-label="対象の開示レポート"
                                  defaultValue=""
                                >
                                  <option value="">（結び付けない）</option>
                                  {linkable.map((row) => (
                                    <option key={row.copy.id} value={row.copy.id}>
                                      {row.label}（共有 {formatJst(row.copy.sharedAt)}・写し
                                      {row.copy.copyHash.slice(0, 12)}）
                                    </option>
                                  ))}
                                </NativeSelect>
                              </label>
                            )}
                            <label className="block space-y-1">
                              <span className="text-small font-medium text-ink">
                                コメント
                                <span className="ml-1 text-caption font-normal text-ink-muted">
                                  （任意）
                                </span>
                              </span>
                              <Input name="comment" aria-label="コメント" />
                            </label>
                          </div>
                        ),
                        confirmLabel: 'Sign-off を記録する',
                      },
                    }}
                  />
                ) : done.length === 0 ? (
                  <p className="text-caption text-ink-muted">
                    この段階を実行する権限がありません（現在の役割: {roles}）。
                  </p>
                ) : null}
              </section>
            );
          })}
        </div>

        <Section title={`Sign-off 履歴（${signoffs.length}）`}>
          {signoffs.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="Sign-off はまだありません"
              description="抑止条件をすべて満たすと、各段階の担当者が本人として記録できます。"
            />
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {signoffs.map((signoff) => (
                <li
                  key={signoff.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5"
                >
                  <span className="text-small text-ink">
                    {statusLabel('signoff', signoff.signoffStage)} — {nameOf(signoff.userId)}
                  </span>
                  <span className="text-caption text-ink-muted">
                    {formatJst(signoff.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
