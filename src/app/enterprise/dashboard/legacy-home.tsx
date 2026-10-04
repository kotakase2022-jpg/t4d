import Link from 'next/link';
import { AlertTriangle, ArrowRight, CalendarClock, History, ListTodo } from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { PriorityBadge, SeverityBadge } from '@/components/shared/badges';
import { KpiCard, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { daysUntilJst, formatJst, formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseDashboard } from '@/lib/services/enterprise-data';
import type { EnterpriseShell } from '@/lib/services/shell';
import { loadSsbjHeadline } from '@/lib/services/ssbj-gap';
import type { IsoDate } from '@/types/domain';
import { unitStatusItems } from './home-breakdown';

/**
 * 従来のホーム（データ収集の進み具合が中心）。
 *
 * 開示優先モードが無効の組織ではこれがホームそのもの（A39。KPI カードとリンクは変えない）。
 * 有効な組織では「ESG経営」タブにそのまま出す。期限の判定は業務上の今日（src/lib/clock.ts）を
 * 受け取って使う（以前は Supabase Mode でも固定の FIXTURE_TODAY を使っていた）。
 * 2026-10-02 の文字量削減（docs/disclosure-first.md §10.4）で、拠点別進捗を状態の内訳の帯に、
 * 直近のアクティビティを既定で閉じた節にした。
 */
export async function LegacyHomeBody({ shell, today }: { shell: EnterpriseShell; today: IsoDate }) {
  // KPI はすべて DB 側の count で求める（全件をアプリへ読み込まない）。
  // 件数の期限判定と画面の「あと N 日」が別の日を基準にしないよう、同じ today を渡す
  const data = await loadEnterpriseDashboard(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.units,
    shell.metrics,
    { referenceDate: today },
  );

  // SSBJ 対応の現在地（読み取り専用。ホームを開いただけで評価行は作らない）
  const ssbj = await loadSsbjHeadline(shell.db, shell.ctx, shell.currentPeriod);

  const base = '/enterprise/data';

  return (
    <div className="space-y-3 p-4">
      {/* KPI: クリックで必ず対象一覧へ Filter 付き遷移する（指示書 15.1） */}
      <section aria-label="主要指標">
        <ul className="grid grid-cols-9 gap-2">
          <li>
            <KpiCard
              label="期限超過"
              value={data.overdueCount}
              suffix="件"
              tone={data.overdueCount > 0 ? 'danger' : 'success'}
              href="/enterprise/workflows?flag=overdue"
              hint="タスク・PBC 依頼"
            />
          </li>
          <li>
            <KpiCard
              label="未提出"
              value={data.notSubmittedCount}
              suffix="件"
              tone={data.notSubmittedCount > 0 ? 'warning' : 'success'}
              href={`${base}?status=not_started&status=draft`}
            />
          </li>
          <li>
            <KpiCard
              label="Validation Error"
              value={data.validationErrorCount}
              suffix="件"
              tone={data.validationErrorCount > 0 ? 'danger' : 'success'}
              href={`${base}?flag=validation_error`}
            />
          </li>
          <li>
            <KpiCard
              label="Evidence 不足"
              value={data.missingEvidenceCount}
              suffix="件"
              tone={data.missingEvidenceCount > 0 ? 'warning' : 'success'}
              href={`${base}?flag=missing_evidence`}
            />
          </li>
          <li>
            <KpiCard
              label="Review 待ち"
              value={data.reviewPendingCount}
              suffix="件"
              tone="brand"
              href={`${base}?flag=review_pending`}
            />
          </li>
          <li>
            <KpiCard
              label="承認率"
              value={data.approvalRate}
              suffix="%"
              tone={data.approvalRate >= 80 ? 'success' : 'brand'}
              href={`${base}?status=approved`}
            />
          </li>
          <li>
            {/* SSBJ 対応が当社の開示対応の起点。開示・データ・業務プロセスの
                3 つの整備度のうち、最も遅れているものを見出しに出す */}
            <KpiCard
              label="SSBJ 対応度"
              value={
                ssbj === null ? 0 : Math.min(ssbj.disclosureRate, ssbj.dataRate, ssbj.processRate)
              }
              suffix="%"
              tone={
                ssbj !== null &&
                Math.min(ssbj.disclosureRate, ssbj.dataRate, ssbj.processRate) >= 60
                  ? 'success'
                  : 'warning'
              }
              hint={
                ssbj === null
                  ? 'SSBJ の評価がまだありません'
                  : `開示 ${ssbj.disclosureRate}% ／ データ ${ssbj.dataRate}% ／ 業務プロセス ${ssbj.processRate}%（最も遅れている観点を表示）`
              }
              href="/enterprise/disclosures/ssbj"
            />
          </li>
          <li>
            <KpiCard
              label="SSBJ 未対応"
              value={ssbj?.openCount ?? 0}
              suffix="件"
              tone={(ssbj?.openCount ?? 0) > 0 ? 'danger' : 'success'}
              hint="未対応・未確認の要求事項。優先度の高いものから着手します"
              // 件数（loadSsbjHeadline）は評価対象だけを数えるため、一覧も同じ母集団に絞る
              href="/enterprise/disclosures/ssbj/requirements?scope=in_scope&coverage=not_covered&coverage=unconfirmed"
            />
          </li>
          <li>
            <KpiCard
              label="CDP 準備度"
              value={data.cdpReadiness}
              suffix="%"
              tone={data.cdpReadiness >= 60 ? 'success' : 'warning'}
              href="/enterprise/disclosures/cdp"
            />
          </li>
        </ul>
      </section>

      <div className="grid grid-cols-3 gap-3">
        {/* 拠点別進捗 */}
        <Card className="col-span-2">
          <SectionTitle
            title="拠点別進捗"
            action={
              <Link
                href="/enterprise/organizations"
                className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
              >
                組織・拠点 <ArrowRight className="size-3" aria-hidden="true" />
              </Link>
            }
          />
          {/* 拠点ごとの状態の内訳（docs/disclosure-first.md §10.4）。帯は重ならない区分（合計 = 対象）で、
              各区分はその拠点・状態の台帳へのリンク。検証エラーは状態と重なるので帯の外に書く */}
          {data.unitProgress.length === 0 ? (
            <EmptyState title="集計対象の拠点がありません" />
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {data.unitProgress.map((row) => (
                <li
                  key={row.unit.id}
                  className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-3 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5 text-[12px]">
                    <p className="truncate">
                      <Link
                        href={`${base}?unit=${row.unit.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {row.unit.name}
                      </Link>
                      <span className="ml-1 text-[11px] text-ink-muted">{row.unit.code}</span>
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      対象 <span className="tnum text-ink">{row.total}</span> 件
                    </p>
                    {/* 0 件でも書く（表のときと同じく、エラーが無いことも読める） */}
                    {row.errors > 0 ? (
                      <Link
                        href={`${base}?unit=${row.unit.id}&flag=validation_error`}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-danger hover:underline"
                      >
                        <AlertTriangle className="size-3" aria-hidden="true" />
                        エラー {row.errors} 件
                      </Link>
                    ) : (
                      <p className="text-[11px] text-ink-muted">エラー 0 件</p>
                    )}
                  </div>
                  <StatusBreakdown
                    label={`${row.unit.name} の状態の内訳`}
                    items={unitStatusItems({
                      unitId: row.unit.id,
                      total: row.total,
                      approved: row.approved,
                      submitted: row.submitted,
                      notStarted: row.notStarted,
                    })}
                    denominator={row.total}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 今日のタスク */}
        <Card>
          <SectionTitle
            title="今日のタスク（7 日以内）"
            action={
              <Link
                href="/enterprise/workflows"
                className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
              >
                すべて <ArrowRight className="size-3" aria-hidden="true" />
              </Link>
            }
          />
          {data.todaysTasks.length === 0 ? (
            <EmptyState
              title="期限が近いタスクはありません"
              icon={<ListTodo className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.todaysTasks.map((task) => {
                const remaining = daysUntilJst(task.dueDate, today);
                return (
                  <li key={task.id} className="px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[12px] text-ink">{task.title}</span>
                      <PriorityBadge priority={task.priority} />
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                      <CalendarClock className="size-3" aria-hidden="true" />
                      期限 {formatJstDate(task.dueDate)}
                      {remaining !== null && <span>（あと {remaining} 日）</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* 重要アラート */}
        <Card>
          <SectionTitle
            title="重要アラート（検証エラー）"
            action={
              <Link
                href="/enterprise/alerts"
                className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
              >
                アラートセンター <ArrowRight className="size-3" aria-hidden="true" />
              </Link>
            }
          />
          {data.topAlerts.length === 0 ? (
            <EmptyState
              title="検証エラーはありません"
              icon={<AlertTriangle className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.topAlerts.map((alert) => (
                <li key={alert.id} className="flex items-start gap-2 px-3 py-2">
                  <SeverityBadge severity={alert.severity} />
                  <Link
                    href={`/enterprise/data/${alert.dataPointId}`}
                    className="text-[12px] text-ink hover:text-brand-700 hover:underline"
                  >
                    {alert.message}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 期限超過タスク + 直近アクティビティ */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title="期限超過" />
            {data.overdueTasks.length === 0 ? (
              <EmptyState title="期限超過はありません" />
            ) : (
              <ul className="divide-y divide-line">
                {data.overdueTasks.map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="text-[12px] text-ink">{task.title}</span>
                    <Badge tone="danger">
                      {Math.abs(daysUntilJst(task.dueDate, today) ?? 0)} 日超過
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 履歴は既定で閉じる（docs/disclosure-first.md §10.4）。空のときは閉じずに空であることを見せる */}
          {data.recentActivity.length === 0 ? (
            <Card>
              <SectionTitle title="直近のアクティビティ" />
              <EmptyState
                title="更新履歴がありません"
                icon={<History className="size-5" aria-hidden="true" />}
              />
            </Card>
          ) : (
            <CollapsibleSection
              id="recent-activity"
              title="直近のアクティビティ"
              summary={`更新 ${data.recentActivity.length} 件（最新 ${formatJst(data.recentActivity[0]!.at)}）`}
              bodyClassName="pl-0"
            >
              <ul className="divide-y divide-line">
                {data.recentActivity.map((item) => (
                  <li key={item.id} className="py-1.5">
                    <div className="text-[12px] text-ink">{item.label}</div>
                    <div className="text-[11px] text-ink-muted">{formatJst(item.at)}</div>
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          )}
        </div>
      </div>

      {data.approvedNeedsRecheckCount > 0 && (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-[#8a5d00]">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            承認済みの Data Point のうち {data.approvedNeedsRecheckCount}{' '}
            件は、承認後に証跡不足が見つかっています（承認済み・要再確認）。
            <Link
              href={`${base}?status=approved&flag=missing_evidence`}
              className="ml-auto font-medium underline"
            >
              対象を確認
            </Link>
          </div>
        </Card>
      )}

      {data.changedAfterApprovalCount > 0 && (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-[#8a5d00]">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            承認後に変更された Data Point が {data.changedAfterApprovalCount} 件あります。
            保証対象の場合、監査法人側へ変更として通知されます。
            <Link
              href={`${base}?flag=changed_after_approval`}
              className="ml-auto font-medium underline"
            >
              対象を確認
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
