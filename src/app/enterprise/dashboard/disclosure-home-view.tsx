import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  FileWarning,
  FolderKanban,
  History,
  ListTodo,
  RotateCcw,
  Scale,
  Tag,
} from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJstDate } from '@/lib/format/datetime';
import type { DisclosureHome, MyTaskKind } from '@/lib/services/disclosure-home';
import { cn } from '@/lib/utils';
import { resetDisclosureDemoAction } from './actions';

/**
 * 開示優先モードのホーム「開示業務」タブ（指示書 §6.1）。
 * 集計は src/lib/services/disclosure-home.ts。ここは表示だけを担う。
 */

function remainingText(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return `${Math.abs(days)} 日超過`;
  if (days === 0) return '本日が期限';
  return `あと ${days} 日`;
}

const TASK_KIND_LABELS: Record<MyTaskKind, string> = {
  returned: '差戻し',
  final_approval: '最終承認',
  review: 'レビュー',
  recheck: '再確認',
  missing_info: '不足あり',
  ready_for_review: '依頼可能',
};

function TaskKindBadge({ kind }: { kind: MyTaskKind }) {
  const icon =
    kind === 'returned' ? (
      <RotateCcw className="size-3" aria-hidden="true" />
    ) : kind === 'final_approval' || kind === 'review' ? (
      <ClipboardCheck className="size-3" aria-hidden="true" />
    ) : kind === 'recheck' ? (
      <History className="size-3" aria-hidden="true" />
    ) : kind === 'missing_info' ? (
      <FileWarning className="size-3" aria-hidden="true" />
    ) : (
      <CheckCircle2 className="size-3" aria-hidden="true" />
    );
  const tone =
    kind === 'returned' || kind === 'missing_info'
      ? 'warning'
      : kind === 'recheck'
        ? 'danger'
        : kind === 'ready_for_review'
          ? 'success'
          : 'brand';
  return (
    <Badge tone={tone}>
      {icon}
      {TASK_KIND_LABELS[kind]}
    </Badge>
  );
}

/** 上部の 4 カード。数値は色だけでなく見出し・補足の文言で意味を示す */
function HomeCardLink({
  label,
  icon,
  value,
  suffix,
  hint,
  href,
  attention,
}: {
  label: string;
  icon: React.ReactNode;
  value: string | number;
  suffix?: string;
  hint: string;
  href: string;
  attention: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col justify-between rounded-t4d-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-brand-300 hover:bg-brand-50"
    >
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
        {icon}
        {label}
      </span>
      <span
        className={cn('mt-1 flex items-baseline gap-1', attention ? 'text-[#8a5d00]' : 'text-ink')}
      >
        <span className="tnum text-[22px] font-semibold leading-7">{value}</span>
        {suffix && <span className="text-[12px] text-ink-muted">{suffix}</span>}
      </span>
      <span className="mt-0.5 text-[11px] text-ink-muted">{hint}</span>
      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-700 group-hover:underline">
        一覧を開く <ArrowRight className="size-3" aria-hidden="true" />
      </span>
    </Link>
  );
}

export function DisclosureHomeView({
  home,
  showDemoReset,
}: {
  home: DisclosureHome;
  showDemoReset: boolean;
}) {
  if (!home.canRead) {
    return (
      <div className="space-y-3 p-4">
        <PermissionDeniedState description="開示業務の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。拠点の入力状況は下の一覧、または「ESG経営」タブで確認できます。" />
        <UnitSubmissions home={home} />
      </div>
    );
  }

  const { project, cards, progress } = home;

  return (
    <div className="space-y-3 p-4">
      {/* 現在のプロジェクトと期限 */}
      <Card>
        {project ? (
          <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <FolderKanban className="size-3.5" aria-hidden="true" />
                現在のプロジェクト
                <Badge tone={project.status === 'closed' ? 'neutral' : 'brand'}>
                  {project.status === 'closed' ? (
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                  ) : (
                    <CircleDashed className="size-3" aria-hidden="true" />
                  )}
                  {project.statusLabel}
                </Badge>
              </div>
              <h2 className="mt-0.5 truncate text-[15px] font-semibold text-ink">
                <Link href={project.href} className="hover:text-brand-700 hover:underline">
                  {project.name}
                </Link>
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                対象期間 {formatJstDate(project.periodStart)}〜{formatJstDate(project.periodEnd)} ／
                範囲 {project.reportingEntity}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {project.purposeLabels.map((label) => (
                  <Badge key={label} tone="outline">
                    <Tag className="size-3" aria-hidden="true" />
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] text-ink-muted">提出期限</div>
              <div className="flex items-center justify-end gap-1 text-[15px] font-semibold text-ink">
                <CalendarClock className="size-4 text-ink-muted" aria-hidden="true" />
                {formatJstDate(project.dueDate)}
              </div>
              {remainingText(project.daysUntilDue) && (
                <div
                  className={cn(
                    'text-[12px]',
                    (project.daysUntilDue ?? 0) < 0 ? 'font-medium text-danger' : 'text-ink-muted',
                  )}
                >
                  {remainingText(project.daysUntilDue)}
                </div>
              )}
              {home.otherProjectCount > 0 && (
                <Link
                  href="/enterprise/disclosure-projects"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
                >
                  他のプロジェクト（{home.otherProjectCount} 件）
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            title="この報告期間の開示プロジェクトはありません"
            description="報告期間・目的・担当・対象範囲を決めてプロジェクトを作成すると、原稿・レビュー・出力をここから進められます。別の年度のプロジェクトは一覧から開いてください。"
            icon={<FolderKanban className="size-5" aria-hidden="true" />}
            action={
              <div className="flex gap-2">
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosure-projects/new">プロジェクトを作成</Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href="/enterprise/disclosure-projects">プロジェクト一覧</Link>
                </Button>
              </div>
            }
          />
        )}
      </Card>

      {cards && (
        <section aria-label="開示の状況">
          <ul className="grid grid-cols-4 gap-2">
            <li>
              <HomeCardLink
                label="未解決の必須情報"
                icon={<FileWarning className="size-3.5" aria-hidden="true" />}
                value={cards.unresolvedRequired.count}
                suffix="節"
                hint="本文・引用した定性情報の必須項目・要対応コメント・適用判断に不足がある原稿"
                href={cards.unresolvedRequired.href}
                attention={cards.unresolvedRequired.count > 0}
              />
            </li>
            <li>
              <HomeCardLink
                label="レビュー待ち"
                icon={<ClipboardCheck className="size-3.5" aria-hidden="true" />}
                value={cards.reviewPending.count}
                suffix="件"
                hint={`レビュー ${cards.reviewPending.reviewStage} 件 ／ 最終承認 ${cards.reviewPending.finalStage} 件`}
                href={cards.reviewPending.href}
                attention={cards.reviewPending.count > 0}
              />
            </li>
            <li>
              <HomeCardLink
                label="承認後に変更が発生"
                icon={<History className="size-3.5" aria-hidden="true" />}
                value={cards.changedAfterApproval.count}
                suffix="節"
                hint="承認済みの原稿が引用した数値・定性情報の更新、または承認後の修正"
                href={cards.changedAfterApproval.href}
                attention={cards.changedAfterApproval.count > 0}
              />
            </li>
            <li>
              {cards.nextDeadline ? (
                <HomeCardLink
                  label="次の提出期限"
                  icon={<CalendarClock className="size-3.5" aria-hidden="true" />}
                  value={formatJstDate(cards.nextDeadline.date)}
                  suffix={remainingText(cards.nextDeadline.daysUntil) ?? undefined}
                  hint={cards.nextDeadline.label}
                  href={cards.nextDeadline.href}
                  attention={(cards.nextDeadline.daysUntil ?? 1) < 0}
                />
              ) : (
                <HomeCardLink
                  label="次の提出期限"
                  icon={<CalendarClock className="size-3.5" aria-hidden="true" />}
                  value="—"
                  hint="期限が設定された未承認の原稿はありません"
                  href={project?.href ?? '/enterprise/disclosure-projects'}
                  attention={false}
                />
              )}
            </li>
          </ul>
        </section>
      )}

      {project && <MyTasks home={home} projectHref={project.href} />}

      {progress && <ProgressSection home={home} />}

      <UnitSubmissions home={home} />

      {showDemoReset && <DemoResetCard />}
    </div>
  );
}

function MyTasks({ home, projectHref }: { home: DisclosureHome; projectHref: string }) {
  return (
    <Card className="overflow-hidden">
      <SectionTitle
        title={`自分が次に行う作業（${home.myTaskTotal} 件${home.myTaskTotal > home.myTasks.length ? `中 ${home.myTasks.length} 件を表示` : ''}）`}
        action={
          <Link
            href={`${projectHref}?tab=manuscripts&filter=mine`}
            className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
          >
            自分の原稿をすべて見る <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        }
      />
      {home.myTasks.length === 0 ? (
        <EmptyState
          title="いま、あなたが次に行う作業はありません"
          description="レビューの依頼・差戻し・承認後の再確認が発生すると、ここに理由とともに表示されます。"
          icon={<ListTodo className="size-5" aria-hidden="true" />}
        />
      ) : (
        <div className="t4d-scroll-x">
          <Table>
            <THead>
              <TR>
                <TH className="w-[88px]">区分</TH>
                <TH>項目名</TH>
                <TH>対象基準</TH>
                <TH>担当</TH>
                <TH>期限</TH>
                <TH>阻害理由</TH>
                <TH className="w-[132px]">
                  <span className="sr-only">操作</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {home.myTasks.map((task) => (
                <TR key={task.key}>
                  <TD>
                    <TaskKindBadge kind={task.kind} />
                  </TD>
                  <TD className="font-medium">{task.itemName}</TD>
                  <TD className="text-[12px]">
                    <div>{task.frameworkLabel}</div>
                    {task.frameworkNote && (
                      <div className="text-[11px] text-[#8a5d00]">{task.frameworkNote}</div>
                    )}
                  </TD>
                  <TD className="text-[12px]">{task.ownerName}</TD>
                  <TD className="whitespace-nowrap text-[12px]">
                    {formatJstDate(task.dueDate)}
                    {remainingText(task.daysUntilDue) && (
                      <div
                        className={cn(
                          'text-[11px]',
                          (task.daysUntilDue ?? 0) < 0
                            ? 'font-medium text-danger'
                            : 'text-ink-muted',
                        )}
                      >
                        {remainingText(task.daysUntilDue)}
                      </div>
                    )}
                  </TD>
                  <TD className="max-w-[360px] text-[12px]">
                    {task.blockerReason ?? <span className="text-ink-muted">—</span>}
                  </TD>
                  <TD>
                    <Button
                      size="xs"
                      variant={task.kind === 'ready_for_review' ? 'outline' : 'primary'}
                      asChild
                    >
                      <Link href={task.cta.href} aria-label={`${task.itemName}: ${task.cta.label}`}>
                        {task.cta.label}
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function ProgressSection({ home }: { home: DisclosureHome }) {
  const progress = home.progress;
  if (!progress) return null;
  const undecided = progress.rows.filter((r) => !r.decided);
  return (
    <Card className="overflow-hidden">
      <SectionTitle title="開示の進み具合（分母を明示）" />
      <div className="grid grid-cols-3 gap-2 px-3 pb-2">
        <div className="col-span-2 rounded-t4d border border-line px-3 py-2">
          <p className="flex items-center gap-1.5 text-[13px] text-ink">
            <Scale className="size-4 text-ink-muted" aria-hidden="true" />
            <span>
              適用確定済み <strong className="tnum">{progress.confirmedItemCount}</strong>{' '}
              項目中、承認済み <strong className="tnum">{progress.approvedItemCount}</strong> 項目
            </span>
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-ink-muted">
            <li>
              原稿の節に割り当て済み {progress.assignedItemCount} 項目（残り{' '}
              {Math.max(progress.confirmedItemCount - progress.assignedItemCount, 0)} 項目は未割当）
            </li>
            {(progress.excludedItemCount > 0 || progress.notAssessedItemCount > 0) && (
              <li>
                分母に含めていない要求事項: 対象外・非重要と判断 {progress.excludedItemCount}{' '}
                項目（理由・判断者あり）／要求事項ごとの適用が未判定 {progress.notAssessedItemCount}{' '}
                項目
              </li>
            )}
            {progress.staleApprovedItemCount > 0 && (
              <li className="text-[#8a5d00]">
                承認済みのうち {progress.staleApprovedItemCount}{' '}
                項目は、承認後に引用先が更新され再確認が必要です
              </li>
            )}
            <li>
              分母は、適用すると判断を確定した基準の要求事項のうち、要求事項ごとの評価で「適用（重要）」と確定したもの（プロジェクトの概要・要求事項タブと同じ数）。承認済みは、その要求事項を割り当てた原稿の節がすべて承認済みのものです（率にはまとめません）。
            </li>
          </ul>
        </div>
        <div className="rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2">
          <p className="flex items-center gap-1.5 text-[13px] text-ink">
            <AlertTriangle className="size-4 text-[#8a5d00]" aria-hidden="true" />
            <span>
              適用未判定 <strong className="tnum">{progress.notAssessedCount}</strong> 件
            </span>
          </p>
          <p className="mt-1 text-[11px] text-ink-muted">
            適用判断を確定していない基準（基準単位）。分母には含めず、ここで別に示します。
          </p>
          {undecided.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px] text-ink">
              {undecided.map((row) => (
                <li key={row.projectFrameworkId}>
                  {row.label}（{row.applicabilityLabel}
                  {row.coverageStatusLabel ? `・${row.coverageStatusLabel}` : ''}）
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="t4d-scroll-x border-t border-line">
        <Table>
          <THead>
            <TR>
              <TH>基準・版</TH>
              <TH>位置付け</TH>
              <TH>適用判断</TH>
              <TH align="right">要求事項（収録）</TH>
              <TH align="right">適用確定済み</TH>
              <TH align="right">割当済み</TH>
              <TH align="right">承認済み</TH>
              <TH align="right">原稿の節</TH>
            </TR>
          </THead>
          <TBody>
            {progress.rows.map((row) => (
              <TR key={row.projectFrameworkId}>
                <TD className="font-medium">{row.label}</TD>
                <TD className="text-[12px]">
                  {row.legalStatusLabel ?? '—'}
                  {row.coverageStatusLabel && (
                    <div className="text-[11px] text-ink-muted">{row.coverageStatusLabel}</div>
                  )}
                </TD>
                <TD className="text-[12px]">
                  <Badge tone={row.decided ? (row.excluded ? 'neutral' : 'success') : 'warning'}>
                    {row.decided ? (
                      <CheckCircle2 className="size-3" aria-hidden="true" />
                    ) : (
                      <CircleDashed className="size-3" aria-hidden="true" />
                    )}
                    {row.applicabilityLabel}
                    {row.decided ? '（確定）' : '（未確定）'}
                  </Badge>
                  {row.decidedOn && (
                    <div className="mt-0.5 text-[11px] text-ink-muted">
                      確認日 {formatJstDate(row.decidedOn)}
                    </div>
                  )}
                </TD>
                <TD align="right" className="tnum">
                  {row.itemCount}
                </TD>
                <TD align="right" className="tnum">
                  {row.inScope ? row.confirmedItemCount : '—'}
                  {row.inScope && row.excludedItemCount + row.notAssessedItemCount > 0 && (
                    <div className="text-[11px] text-ink-muted">
                      対象外・非重要 {row.excludedItemCount}／未判定 {row.notAssessedItemCount}
                    </div>
                  )}
                </TD>
                <TD align="right" className="tnum">
                  {row.assignedItemCount}
                </TD>
                <TD align="right" className="tnum">
                  {row.approvedItemCount}
                  {row.staleApprovedItemCount > 0 && (
                    <div className="text-[11px] text-[#8a5d00]">
                      うち再確認 {row.staleApprovedItemCount}
                    </div>
                  )}
                </TD>
                <TD align="right" className="tnum">
                  {row.blockCount}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}

function UnitSubmissions({ home }: { home: DisclosureHome }) {
  const total = home.unitSubmissions.reduce((sum, r) => sum + r.notSubmitted, 0);
  return (
    <Card className="overflow-hidden">
      {/* 補助表示（指示書 §6.1「拠点の未提出一覧は折りたたんだ補助表示」）。既定は閉じる */}
      <details className="group">
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[13px] font-semibold text-ink hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600">
          <span>
            拠点の未提出（補助表示）
            <span className="ml-1.5 text-[12px] font-normal text-ink-muted">
              {home.unitSubmissions.length} 拠点・{total} 件
            </span>
          </span>
          <span className="text-[11px] font-normal text-ink-muted group-open:hidden">開く</span>
          <span className="hidden text-[11px] font-normal text-ink-muted group-open:inline">
            閉じる
          </span>
        </summary>
        {home.unitSubmissions.length === 0 ? (
          <p className="px-3 pb-3 text-[12px] text-ink-muted">未提出の拠点はありません。</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>組織・拠点</TH>
                <TH align="right">未提出</TH>
                <TH align="right">対象</TH>
              </TR>
            </THead>
            <TBody>
              {home.unitSubmissions.map((row) => (
                <TR key={row.unitId}>
                  <TD>
                    <Link href={row.href} className="text-brand-700 hover:underline">
                      {row.unitName}
                    </Link>
                    <span className="ml-1 text-[11px] text-ink-muted">{row.unitCode}</span>
                  </TD>
                  <TD align="right" className="tnum">
                    {row.notSubmitted}
                  </TD>
                  <TD align="right" className="tnum">
                    {row.total}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </details>
    </Card>
  );
}

function DemoResetCard() {
  return (
    <Card className="border-dashed">
      <SectionTitle title="開示デモのリセット（デモ環境のみ）" />
      <form action={resetDisclosureDemoAction} className="space-y-2 px-3 pb-3">
        <p className="text-[12px] text-ink-muted">
          開示プロジェクト・原稿・レビュー・定性情報・引用位置・スナップショット・出力記録・KPI
          目標を、デモ開始時の状態へ戻します。デモ中に作った行は削除し、変更した行は元の値へ戻します。
          資料・SSBJ の評価・Scope3
          の算定・通知・監査ログ・開示優先モードの設定には触れません。数値データは、下で選んだときだけ戻します。
        </p>
        <label className="flex items-start gap-1.5 text-[12px] text-ink">
          <input type="checkbox" name="includeDataPoints" className="mt-0.5 size-3.5" />
          <span>
            数値データも初期値へ戻す（Data Point と版・承認の記録・承認の道筋・標準 CSV
            の取込。デモ中に取り込んだ値・訂正した値を消し、次のリハーサルを同じ数値から始める）
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink">
          <input type="checkbox" name="confirmScope" required className="size-3.5" />
          上記の範囲だけを初期状態へ戻すことを確認しました
        </label>
        <Button type="submit" size="sm" variant="outline">
          <RotateCcw aria-hidden="true" />
          開示デモを初期状態に戻す
        </Button>
      </form>
    </Card>
  );
}
