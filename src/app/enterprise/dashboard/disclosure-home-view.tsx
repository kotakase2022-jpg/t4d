import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  FolderKanban,
  History,
  Scale,
  Tag,
} from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { MiniBars } from '@/components/charts/mini-bars';
import { MetricTile } from '@/components/shared/metric-strip';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJstDate } from '@/lib/format/datetime';
import type { DisclosureHome } from '@/lib/services/disclosure-home';
import { cn } from '@/lib/utils';

/**
 * 開示優先モードのホーム「開示業務」タブ（指示書 §6.1）。
 * 集計は src/lib/services/disclosure-home.ts。ここは表示だけを担う。
 * 分母の決め方・リセットの対象一覧などの説明は既定で閉じる（docs/disclosure-first.md §10.4）。
 */

function remainingText(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return `${Math.abs(days)} 日超過`;
  if (days === 0) return '本日が期限';
  return `あと ${days} 日`;
}

/**
 * 開示の状況の 1 枚（共通の MetricTile。押すと絞り込んだ一覧へ）。要対応は色だけでなくアイコンと語で示す
 */
function HomeCardLink({
  label,
  value,
  suffix,
  hint,
  href,
  attention,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  hint: string;
  href: string;
  attention: boolean;
}) {
  return (
    <MetricTile
      label={label}
      value={value}
      unit={suffix}
      hint={hint}
      href={href}
      status={attention ? { semantic: 'pending', label: '要対応' } : undefined}
      className="h-full"
    />
  );
}

/**
 * 「自分が次に行う作業」はページの先頭の MyWork（役割別ホーム。plan §1.3・S2）へ移した（同じデータ源
 * loadDisclosureHome.myTasks。行の CTA の文言とリンク先は保つ）。開示デモのリセットは見出しの
 * 「その他」から確認ダイアログで行う（毎日開く画面の本文に破壊的な操作を置かない。plan §1.16）
 */
export function DisclosureHomeView({ home }: { home: DisclosureHome }) {
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
      {/* 現在のプロジェクトと期限（枠は 1 本の罫線だけ。装飾の Card にしない） */}
      <section
        aria-label="現在のプロジェクト"
        className="rounded-t4d-lg border border-line bg-surface"
      >
        {project ? (
          <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-caption text-ink-muted">
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
              <h2 className="mt-0.5 truncate text-title font-semibold text-ink">
                <Link href={project.href} className="hover:text-brand-700 hover:underline">
                  {project.name}
                </Link>
              </h2>
              <p className="mt-0.5 text-small text-ink-muted">
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
              <div className="text-caption text-ink-muted">提出期限</div>
              <div className="flex items-center justify-end gap-1 text-title font-semibold text-ink">
                <CalendarClock className="size-4 text-ink-muted" aria-hidden="true" />
                {formatJstDate(project.dueDate)}
              </div>
              {remainingText(project.daysUntilDue) && (
                <div
                  className={cn(
                    'text-small',
                    (project.daysUntilDue ?? 0) < 0 ? 'font-medium text-danger' : 'text-ink-muted',
                  )}
                >
                  {remainingText(project.daysUntilDue)}
                </div>
              )}
              {home.otherProjectCount > 0 && (
                <Link
                  href="/enterprise/disclosure-projects"
                  className="mt-1 inline-flex items-center gap-1 text-caption text-brand-700 hover:underline"
                >
                  他のプロジェクト（{home.otherProjectCount} 件）
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            kind="no-data"
            title="この報告期間の開示プロジェクトはありません"
            description="報告期間・目的・担当・対象範囲を決めてプロジェクトを作成すると、原稿・レビュー・出力をここから進められます。別の年度のプロジェクトは一覧から開いてください。"
            icon={<FolderKanban className="size-5" aria-hidden="true" />}
            action={
              <div className="flex gap-2">
                {/* ホームの primary は「最初の作業を開く」1 つ。空状態の次の操作は secondary で並べる */}
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/enterprise/disclosure-projects/new">プロジェクトを作成</Link>
                </Button>
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/enterprise/disclosure-projects">プロジェクト一覧</Link>
                </Button>
              </div>
            }
          />
        )}
      </section>

      {cards && (
        <section aria-label="開示の状況">
          <ul className="grid grid-cols-4 gap-2">
            <li>
              <HomeCardLink
                label="未解決の必須情報"
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
                  value={formatJstDate(cards.nextDeadline.date)}
                  suffix={remainingText(cards.nextDeadline.daysUntil) ?? undefined}
                  hint={cards.nextDeadline.label}
                  href={cards.nextDeadline.href}
                  attention={(cards.nextDeadline.daysUntil ?? 1) < 0}
                />
              ) : (
                <HomeCardLink
                  label="次の提出期限"
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

      {progress && <ProgressSection home={home} />}

      <UnitSubmissions home={home} />
    </div>
  );
}

function ProgressSection({ home }: { home: DisclosureHome }) {
  const progress = home.progress;
  if (!progress) return null;
  const undecided = progress.rows.filter((r) => !r.decided);
  return (
    <section
      aria-labelledby="home-progress-title"
      className="overflow-hidden rounded-t4d-lg border border-line bg-surface"
    >
      <h2 id="home-progress-title" className="px-3 py-2 text-body font-semibold text-ink">
        開示の進み具合（分母を明示）
      </h2>
      <div className="grid grid-cols-3 gap-2 px-3 pb-2">
        <div className="col-span-2 space-y-1.5 rounded-t4d border border-line px-3 py-2">
          <p className="flex items-center gap-1.5 text-body text-ink">
            <Scale className="size-4 text-ink-muted" aria-hidden="true" />
            <span>
              適用確定済み <strong className="tnum">{progress.confirmedItemCount}</strong>{' '}
              項目中、承認済み <strong className="tnum">{progress.approvedItemCount}</strong> 項目
            </span>
          </p>
          <FractionBar
            label="承認済み（適用確定済みのうち）"
            numerator={progress.approvedItemCount}
            denominator={progress.confirmedItemCount}
            unit="項目"
          />
          {/* 承認後の再確認は対応が要る事実なので閉じない（分母の決め方の説明だけを閉じる） */}
          {progress.staleApprovedItemCount > 0 && (
            <p className="flex items-center gap-1 text-caption text-warning-ink">
              <History className="size-3.5 shrink-0" aria-hidden="true" />
              承認済みのうち {progress.staleApprovedItemCount}{' '}
              項目は、承認後に引用先が更新され再確認が必要です
            </p>
          )}
          <Collapsible
            variant="plain"
            summary={`分母の決め方（割当済み ${progress.assignedItemCount} 項目・分母に含めない ${progress.excludedItemCount + progress.notAssessedItemCount} 項目）`}
          >
            <ul className="space-y-0.5 text-caption text-ink-muted">
              <li>
                原稿の節に割り当て済み {progress.assignedItemCount} 項目（残り{' '}
                {Math.max(progress.confirmedItemCount - progress.assignedItemCount, 0)}{' '}
                項目は未割当）
              </li>
              {(progress.excludedItemCount > 0 || progress.notAssessedItemCount > 0) && (
                <li>
                  分母に含めていない要求事項: 対象外・非重要と判断 {progress.excludedItemCount}{' '}
                  項目（理由・判断者あり）／要求事項ごとの適用が未判定{' '}
                  {progress.notAssessedItemCount} 項目
                </li>
              )}
              <li>
                分母は、適用すると判断を確定した基準の要求事項のうち、要求事項ごとの評価で「適用（重要）」と確定したもの（プロジェクトの概要・要求事項タブと同じ数）。承認済みは、その要求事項を割り当てた原稿の節がすべて承認済みのものです（率にはまとめません）。
              </li>
            </ul>
          </Collapsible>
        </div>
        <div className="rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2">
          <p className="flex items-center gap-1.5 text-body text-ink">
            <AlertTriangle className="size-4 text-warning-ink" aria-hidden="true" />
            <span>
              適用未判定 <strong className="tnum">{progress.notAssessedCount}</strong> 件
            </span>
          </p>
          <p className="mt-1 text-caption text-ink-muted">
            適用判断を確定していない基準（基準単位）。分母には含めず、ここで別に示します。
          </p>
          {undecided.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-caption text-ink">
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
              {/* 左の 3 列（適用確定済み → 割当済み → 承認済み）の件数を 0 起点の小さな棒で並べる。
                  数値は左の列にあるので棒は読み上げない */}
              <TH>確定→割当→承認</TH>
              <TH align="right">原稿の節</TH>
            </TR>
          </THead>
          <TBody>
            {progress.rows.map((row) => (
              <TR key={row.projectFrameworkId}>
                <TD className="font-medium">{row.label}</TD>
                <TD className="text-small">
                  {row.legalStatusLabel ?? '—'}
                  {row.coverageStatusLabel && (
                    <div className="text-caption text-ink-muted">{row.coverageStatusLabel}</div>
                  )}
                </TD>
                <TD className="text-small">
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
                    <div className="mt-0.5 text-caption text-ink-muted">
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
                    <div className="text-caption text-ink-muted">
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
                    <div className="text-caption text-warning-ink">
                      うち再確認 {row.staleApprovedItemCount}
                    </div>
                  )}
                </TD>
                <TD>
                  {row.inScope ? (
                    <MiniBars
                      values={[
                        row.confirmedItemCount,
                        row.assignedItemCount,
                        row.approvedItemCount,
                      ]}
                      labels={['適用確定済み', '割当済み', '承認済み']}
                      decorative
                    />
                  ) : (
                    <span className="text-ink-muted">—</span>
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
    </section>
  );
}

function UnitSubmissions({ home }: { home: DisclosureHome }) {
  const total = home.unitSubmissions.reduce((sum, r) => sum + r.notSubmitted, 0);
  return (
    // 補助表示（指示書 §6.1「拠点の未提出一覧は折りたたんだ補助表示」）。既定は閉じる。
    // 開閉の印は共通の Collapsible（docs/disclosure-first.md §10.4。入れ子でもずれない印）に揃える
    // details に overflow-hidden を付けない（summary のフォーカスリングが切れて見えなくなる）。
    // 角の丸めは中の表の枠だけで切る
    <Collapsible
      id="home-unit-submissions"
      summary="拠点の未提出（補助表示）"
      meta={`${home.unitSubmissions.length} 拠点・${total} 件`}
      bodyClassName="px-0 py-0"
    >
      {home.unitSubmissions.length === 0 ? (
        <p className="px-3 py-2 text-small text-ink-muted">未提出の拠点はありません。</p>
      ) : (
        <div className="overflow-hidden rounded-b-t4d-lg">
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
                    <span className="ml-1 text-caption text-ink-muted">{row.unitCode}</span>
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
        </div>
      )}
    </Collapsible>
  );
}
