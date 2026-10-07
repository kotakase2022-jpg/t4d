import Link from 'next/link';
import { AlertTriangle, ArrowRight, CalendarClock, ChartLine } from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { PriorityBadge, SeverityBadge } from '@/components/shared/badges';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { ROUTE_CATALOG, canOpenRoute } from '@/components/shared/route-catalog';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { daysUntilJst, formatJst, formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseDashboard } from '@/lib/services/enterprise-data';
import type { EnterpriseShell } from '@/lib/services/shell';
import { loadSsbjHeadline } from '@/lib/services/ssbj-gap';
import { canFor } from '@/lib/ui/home-profile';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import type { IsoDate } from '@/types/domain';
import { unitStatusItems } from './home-breakdown';

/** 分析の画面（Insight の 1 行。開ける画面だけ） */
const INSIGHT_PATTERNS = [
  '/enterprise/analysis/diagnosis',
  '/enterprise/analysis/regulations',
  '/enterprise/analysis/trends',
  '/enterprise/analysis/benchmark',
  '/enterprise/analysis/financial-impact',
] as const;

/** KPI の状態は色だけで示さない（アイコンと語を MetricTile が併記する） */
function attention(count: number, semantic: StatusSemantic = 'error') {
  return count > 0 ? { semantic, label: '要対応' } : { semantic: 'done' as const, label: 'なし' };
}

/**
 * 従来のホーム（データ収集の進み具合が中心）。plan §1.14 の順: Attention → Status → Insight。
 * Action（自分が次に行う作業）はページの先頭の MyWork が出す。
 *
 * 開示優先モードが無効の組織ではこれがホームそのもの（A39。KPI のリンク先は変えない。
 * ラベルは plan §1.17 の業務の言葉: Validation Error → 検証エラー など）。
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
  const ssbjRate =
    ssbj === null ? 0 : Math.min(ssbj.disclosureRate, ssbj.dataRate, ssbj.processRate);

  const base = '/enterprise/data';
  const userCan = canFor(shell.ctx);
  const insightLinks = ROUTE_CATALOG.filter(
    (entry) =>
      (INSIGHT_PATTERNS as readonly string[]).includes(entry.pattern) &&
      entry.href !== undefined &&
      canOpenRoute(entry, userCan),
  );

  return (
    <div className="space-y-3 p-4">
      {/* Attention: 承認の後に見つかった問題（最下部にあると見落とすため先頭に置く。§1.14） */}
      {(data.approvedNeedsRecheckCount > 0 || data.changedAfterApprovalCount > 0) && (
        <Notice tone="warning" title="承認の後に確認が必要なデータ">
          <ul className="space-y-0.5">
            {data.approvedNeedsRecheckCount > 0 && (
              <li>
                承認済みのデータのうち {data.approvedNeedsRecheckCount}{' '}
                件は、承認後に根拠資料の不足が見つかっています（承認済み・要再確認）。{' '}
                <Link
                  href={`${base}?status=approved&flag=missing_evidence`}
                  className="font-medium underline"
                >
                  対象を確認
                </Link>
              </li>
            )}
            {data.changedAfterApprovalCount > 0 && (
              <li>
                承認後に変更されたデータが {data.changedAfterApprovalCount}{' '}
                件あります。保証対象の場合、監査法人側へ変更として通知されます。{' '}
                <Link
                  href={`${base}?flag=changed_after_approval`}
                  className="font-medium underline"
                >
                  対象を確認
                </Link>
              </li>
            )}
          </ul>
        </Notice>
      )}

      {/* Status: KPI。押すと必ず対象一覧へ Filter 付きで移る（指示書 15.1。リンク先は A39 のまま） */}
      <MetricStrip label="主要指標" className="grid-cols-9">
        <MetricTile
          label="期限超過"
          value={data.overdueCount}
          unit="件"
          status={attention(data.overdueCount)}
          href="/enterprise/workflows?flag=overdue"
          hint="タスク・PBC 依頼"
        />
        <MetricTile
          label="未提出"
          value={data.notSubmittedCount}
          unit="件"
          status={attention(data.notSubmittedCount, 'pending')}
          href={`${base}?status=not_started&status=draft`}
        />
        <MetricTile
          label="検証エラー"
          value={data.validationErrorCount}
          unit="件"
          status={attention(data.validationErrorCount)}
          href={`${base}?flag=validation_error`}
        />
        <MetricTile
          label="根拠資料の不足"
          value={data.missingEvidenceCount}
          unit="件"
          status={attention(data.missingEvidenceCount, 'blocked')}
          href={`${base}?flag=missing_evidence`}
        />
        <MetricTile
          label="レビュー・承認待ち"
          value={data.reviewPendingCount}
          unit="件"
          href={`${base}?flag=review_pending`}
        />
        <MetricTile
          label="承認率"
          value={data.approvalRate}
          unit="%"
          status={
            data.approvalRate >= 80
              ? { semantic: 'done', label: '80% 以上' }
              : { semantic: 'pending', label: '80% 未満' }
          }
          href={`${base}?status=approved`}
        />
        {/* SSBJ 対応が当社の開示対応の起点。開示・データ・業務プロセスの
            3 つの整備度のうち、最も遅れているものを見出しに出す */}
        <MetricTile
          label="SSBJ 対応度"
          value={ssbjRate}
          unit="%"
          status={
            ssbj !== null && ssbjRate >= 60
              ? { semantic: 'done', label: '60% 以上' }
              : { semantic: 'blocked', label: '60% 未満' }
          }
          hint={
            ssbj === null
              ? 'SSBJ の評価がまだありません'
              : `開示 ${ssbj.disclosureRate}% ／ データ ${ssbj.dataRate}% ／ 業務プロセス ${ssbj.processRate}%（最も遅れている観点を表示）`
          }
          href="/enterprise/disclosures/ssbj"
        />
        <MetricTile
          label="SSBJ 未対応"
          value={ssbj?.openCount ?? 0}
          unit="件"
          status={attention(ssbj?.openCount ?? 0)}
          hint="未対応・未確認の要求事項。優先度の高いものから着手します"
          // 件数（loadSsbjHeadline）は評価対象だけを数えるため、一覧も同じ母集団に絞る
          href="/enterprise/disclosures/ssbj/requirements?scope=in_scope&coverage=not_covered&coverage=unconfirmed"
        />
        <MetricTile
          label="CDP 準備度"
          value={data.cdpReadiness}
          unit="%"
          status={
            data.cdpReadiness >= 60
              ? { semantic: 'done', label: '60% 以上' }
              : { semantic: 'blocked', label: '60% 未満' }
          }
          href="/enterprise/disclosures/cdp"
        />
      </MetricStrip>

      <div className="grid grid-cols-3 gap-x-4 gap-y-3">
        {/* 拠点別進捗 */}
        <Section
          title="拠点別進捗"
          className="col-span-2"
          actions={
            <Link
              href="/enterprise/organizations"
              className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
            >
              組織・拠点 <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          }
        >
          {/* 拠点ごとの状態の内訳（docs/disclosure-first.md §10.4）。帯は重ならない区分（合計 = 対象）で、
              各区分はその拠点・状態の台帳へのリンク。検証エラーは状態と重なるので帯の外に書く */}
          {data.unitProgress.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="集計対象の拠点がありません"
              description="組織・拠点で報告対象の拠点を登録すると、拠点ごとの進み具合が並びます。"
            />
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {data.unitProgress.map((row) => (
                <li
                  key={row.unit.id}
                  className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5 text-small">
                    <p className="truncate">
                      <Link
                        href={`${base}?unit=${row.unit.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {row.unit.name}
                      </Link>
                      <span className="ml-1 text-caption text-ink-muted">{row.unit.code}</span>
                    </p>
                    <p className="text-caption text-ink-muted">
                      対象 <span className="tnum text-ink">{row.total}</span> 件
                    </p>
                    {/* 0 件でも書く（表のときと同じく、エラーが無いことも読める） */}
                    {row.errors > 0 ? (
                      <Link
                        href={`${base}?unit=${row.unit.id}&flag=validation_error`}
                        className="inline-flex items-center gap-1 text-caption font-medium text-danger hover:underline"
                      >
                        <AlertTriangle className="size-3" aria-hidden="true" />
                        エラー {row.errors} 件
                      </Link>
                    ) : (
                      <p className="text-caption text-ink-muted">エラー 0 件</p>
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
        </Section>

        {/* 今日のタスク（期限超過はキーの「期限超過」から一覧へ。同じ事実の表を重ねない） */}
        <Section
          title="今日のタスク（7 日以内）"
          actions={
            <Link
              href="/enterprise/workflows#tasks"
              className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
            >
              すべて <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          }
        >
          {data.todaysTasks.length === 0 ? (
            <EmptyState kind="done" size="compact" title="期限が近いタスクはありません" />
          ) : (
            <ul className="divide-y divide-line">
              {data.todaysTasks.map((task) => {
                const remaining = daysUntilJst(task.dueDate, today);
                return (
                  <li key={task.id} className="py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-small text-ink">{task.title}</span>
                      <PriorityBadge priority={task.priority} />
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
                      <CalendarClock className="size-3" aria-hidden="true" />
                      期限 {formatJstDate(task.dueDate)}
                      {remaining !== null && <span>（あと {remaining} 日）</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {/* 重要アラート */}
        <Section
          title="重要アラート（検証エラー）"
          actions={
            <Link
              href="/enterprise/alerts"
              className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
            >
              アラート <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          }
        >
          {data.topAlerts.length === 0 ? (
            <EmptyState kind="done" size="compact" title="検証エラーはありません" />
          ) : (
            <ul className="divide-y divide-line">
              {data.topAlerts.map((alert) => (
                <li key={alert.id} className="flex items-start gap-2 py-1.5">
                  <SeverityBadge severity={alert.severity} />
                  <Link
                    href={`/enterprise/data/${alert.dataPointId}`}
                    className="text-small text-ink hover:text-brand-700 hover:underline"
                  >
                    {alert.message}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* 履歴は既定で閉じる（docs/disclosure-first.md §10.4）。空のときは閉じずに空であることを見せる */}
        {data.recentActivity.length === 0 ? (
          <Section title="直近のアクティビティ">
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="更新履歴がありません"
              description="データの入力・取込・承認を行うと、ここに並びます。"
            />
          </Section>
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
                  <div className="text-small text-ink">{item.label}</div>
                  <div className="text-caption text-ink-muted">{formatJst(item.at)}</div>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}
      </div>

      {/* Insight: 推移・比較・分析への入口（1 行） */}
      {insightLinks.length > 0 && (
        <nav
          aria-label="分析"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-small"
        >
          <span className="inline-flex items-center gap-1 font-medium text-ink">
            <ChartLine className="size-3.5 text-ink-muted" aria-hidden="true" />
            分析
          </span>
          {insightLinks.map((entry) => (
            <Link key={entry.pattern} href={entry.href!} className="text-brand-700 hover:underline">
              {entry.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
