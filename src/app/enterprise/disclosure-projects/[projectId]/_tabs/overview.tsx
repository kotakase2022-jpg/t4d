import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  Info,
} from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { AttentionStrip, type AttentionItem } from '@/components/shared/attention-strip';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getReferenceDate } from '@/lib/clock';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
} from '@/lib/domain/disclosure-status';
import { daysUntilJst, formatJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import { listProjectBlocks, type ManuscriptRow } from '@/lib/services/disclosure-block';
import {
  canCreateStatutoryPackage,
  getProject,
  nameOf,
  packageInputOf,
  summarizeProject,
} from '@/lib/services/disclosure-project';
import { listProjectReviews, type ReviewListItem } from '@/lib/services/disclosure-review';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { ApplicabilityBadge, LegalStatusBadge } from '../../_components/framework-badges';

/** 期限が近いとみなす日数（期限切れ間近の注意に出す） */
const DUE_SOON_DAYS = 7;
/** 自分の作業の表に並べる上限（残りは件数とリンクで示す） */
const MAX_WORK_ROWS = 5;

interface WorkItem {
  key: string;
  verb: string;
  title: string;
  href: string;
  due: string | null;
  reason: string;
  /** primary の文言（先頭の作業を開くボタン） */
  primaryLabel: string;
}

/**
 * このプロジェクトで自分が次に行う作業（plan S1 の Action）。並びは
 * 承認・レビュー（人を待たせている）→ 差戻し → 引用先の再確認 → 下書き。
 * 業務の判定はサービスの一覧（原稿・レビュー）の値をそのまま使う（新しい規則を作らない）。
 */
function myWorkOf(
  base: string,
  userId: string,
  rows: readonly ManuscriptRow[],
  reviews: readonly ReviewListItem[],
): WorkItem[] {
  const blockHref = (id: string) => `${base}/blocks/${id}`;
  const out: WorkItem[] = [];
  for (const r of reviews.filter((item) => item.myStage === 'final')) {
    out.push({
      key: `final-${r.id}`,
      verb: '最終承認する',
      title: r.blockTitle,
      href: blockHref(r.blockId),
      due: null,
      reason: `版 ${r.targetVersionNo ?? '—'} のレビューが完了しています`,
      primaryLabel: '承認する原稿を開く',
    });
  }
  for (const r of reviews.filter((item) => item.myStage === 'review')) {
    out.push({
      key: `review-${r.id}`,
      verb: 'レビューする',
      title: r.blockTitle,
      href: blockHref(r.blockId),
      due: null,
      reason: `${r.requestedByName} さんから版 ${r.targetVersionNo ?? '—'} の依頼`,
      primaryLabel: 'レビューする',
    });
  }
  const mine = rows.filter((row) => row.ownerUserId === userId);
  for (const row of mine.filter((r) => r.status === 'returned')) {
    out.push({
      key: `returned-${row.id}`,
      verb: '差戻しを直す',
      title: row.title,
      href: blockHref(row.id),
      due: row.dueDate,
      reason: '差し戻されています',
      primaryLabel: '次の原稿を開く',
    });
  }
  for (const row of mine.filter(
    (r) =>
      r.status !== 'returned' &&
      (r.freshness === 'upstream_updated' || r.freshness === 'evidence_invalid'),
  )) {
    out.push({
      key: `recheck-${row.id}`,
      verb: '引用先を再確認する',
      title: row.title,
      href: `${blockHref(row.id)}/recheck`,
      due: row.dueDate,
      reason: row.freshnessLabel,
      primaryLabel: '再確認する原稿を開く',
    });
  }
  for (const row of mine.filter((r) => r.status === 'draft')) {
    out.push({
      key: `draft-${row.id}`,
      verb: '原稿を書く',
      title: row.title,
      href: blockHref(row.id),
      due: row.dueDate,
      reason: row.hasBody ? `版 ${row.currentVersionNo ?? '—'} から続ける` : '本文がまだありません',
      primaryLabel: '次の原稿を開く',
    });
  }
  return out;
}

/**
 * 概要タブ（§6.3・plan S1）: Attention（要対応）→ Action（このプロジェクトでの自分の作業。primary 1 つ）
 * → Status（基準別の分母つき進捗）→ 前提・確定パッケージ・関連画面（既定で閉じる）。
 * 進捗は「適用確定済み N 項目中、承認済み M 項目」と「適用未判定 K 件」を分けて示し、
 * 準拠率のような 1 つの数字にしない（§6.1・§8.3）。
 */
export async function OverviewTab({
  projectId,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const detail = await getProject(db, ctx, projectId);
  const project = detail.project;
  const [summaries, manuscripts, reviews] = await Promise.all([
    summarizeProject(db, ctx, detail),
    listProjectBlocks(db, ctx, projectId).catch(() => null),
    listProjectReviews(db, ctx, projectId).catch(() => [] as ReviewListItem[]),
  ]);
  const packageCheck = canCreateStatutoryPackage({
    purposes: project.purposes,
    frameworks: detail.frameworks.map(packageInputOf),
  });
  const today = getReferenceDate();
  const daysLeft = daysUntilJst(project.dueDate, today);
  const base = `/enterprise/disclosure-projects/${project.id}`;
  const manuscriptsHref = (filter?: string) =>
    filter ? `${base}?tab=manuscripts&filter=${filter}` : `${base}?tab=manuscripts`;
  const approvedBlocks = detail.blocks.filter(
    (b) => b.status === 'approved' && b.approvedVersionId,
  );
  const rows = manuscripts?.rows ?? [];
  const open = rows.filter((row) => row.status !== 'approved');
  const overdue = open.filter((row) => isOverdue(row.dueDate, today)).length;
  const dueSoon = open.filter((row) => {
    const days = daysUntilJst(row.dueDate, today);
    return days !== null && days >= 0 && days <= DUE_SOON_DAYS;
  }).length;

  const attention: AttentionItem[] = [
    {
      key: 'undecided',
      label: '適用判断が未確定の基準',
      count: detail.frameworks.filter((f) => !f.confirmed).length,
      href: `${base}?tab=settings`,
      semantic: 'pending',
    },
    {
      key: 'not-assessed',
      label: '適用未判定の要求事項',
      count: summaries.reduce(
        (sum, s) => sum + (s.mode === 'not_loaded' ? 0 : s.summary.notAssessed),
        0,
      ),
      href: `${base}?tab=requirements`,
      semantic: 'pending',
    },
    {
      key: 'returned',
      label: '差戻しの節',
      count: manuscripts?.counts.returned ?? 0,
      href: manuscriptsHref('returned'),
      semantic: 'returned',
    },
    {
      key: 'recheck',
      label: '引用先の再確認が必要な節',
      count: manuscripts?.counts.recheck ?? 0,
      href: manuscriptsHref('recheck'),
      semantic: 'blocked',
    },
    {
      key: 'changed',
      label: '承認後に変更が発生した節',
      count: manuscripts?.counts.changed_after_approval ?? 0,
      href: manuscriptsHref('changed_after_approval'),
      semantic: 'blocked',
    },
    {
      key: 'overdue',
      label: '期限を過ぎた節',
      count: overdue,
      href: manuscriptsHref(),
      semantic: 'error',
    },
    {
      key: 'due-soon',
      label: `期限まで ${DUE_SOON_DAYS} 日以内の節`,
      count: dueSoon,
      href: manuscriptsHref(),
      semantic: 'pending',
    },
  ];

  const work = myWorkOf(base, ctx.userId, rows, reviews);
  const first = work[0];

  return (
    <div className="space-y-3">
      <AttentionStrip label="このプロジェクトの要対応" items={attention} />

      <div className="grid gap-x-4 gap-y-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <Section
            title={`このプロジェクトでの自分の作業（${work.length} 件）`}
            divider="none"
            actions={
              first ? (
                <PageActions
                  primary={{
                    kind: 'link',
                    id: 'open-first-work',
                    label: first.primaryLabel,
                    href: first.href,
                    icon: <ArrowRight aria-hidden="true" />,
                  }}
                />
              ) : undefined
            }
          >
            {work.length === 0 ? (
              <EmptyState
                kind="done"
                size="compact"
                title="このプロジェクトで今やることはありません"
                description="担当の原稿・レビュー・最終承認の依頼が来ると、ここに並びます。"
              />
            ) : (
              <div className="t4d-scroll-x rounded-t4d border border-line">
                <Table>
                  <caption className="sr-only">このプロジェクトでの自分の作業</caption>
                  <THead>
                    <TR>
                      <TH>作業</TH>
                      <TH>原稿</TH>
                      <TH>理由</TH>
                      <TH>期限</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {work.slice(0, MAX_WORK_ROWS).map((item) => (
                      <TR key={item.key} data-t4d-record="">
                        <TD className="whitespace-nowrap text-small font-medium">{item.verb}</TD>
                        <TD className="text-small">
                          <Link href={item.href} className="text-brand-800 hover:underline">
                            {item.title}
                          </Link>
                        </TD>
                        <TD className="text-small text-ink-muted">{item.reason}</TD>
                        <TD className="whitespace-nowrap text-small">
                          {item.due ? formatJstDate(item.due) : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {work.length > MAX_WORK_ROWS && (
                  <p className="border-t border-line px-2 py-1 text-small">
                    <Link href={manuscriptsHref('mine')} className="text-brand-800 hover:underline">
                      すべて見る（{work.length} 件）
                    </Link>
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section title="進捗（分母つき）">
            <div className="space-y-3">
              <div className="space-y-0.5">
                <FractionBar
                  label="原稿のうち承認済み"
                  numerator={approvedBlocks.length}
                  denominator={detail.blocks.length}
                  unit="節"
                />
                <p className="text-caption text-ink-muted">
                  承認は企業内の承認です。保証の結論ではありません。
                </p>
              </div>
              {summaries.map(({ framework, summary, mode }) => (
                <div
                  key={framework.projectFramework.id}
                  className="border-t border-line pt-2"
                  data-framework-progress=""
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-body font-medium text-ink">
                    {framework.label}
                    <LegalStatusBadge legal={framework.legal} />
                  </p>
                  {mode === 'not_loaded' ? (
                    <p className="mt-1 flex items-center gap-1 text-small text-ink-muted">
                      <Info className="size-3.5" aria-hidden="true" />
                      要求事項は未収録（公開草案）。進捗は数えられません。
                      {framework.legal.coverageNote ? `（${framework.legal.coverageNote}）` : ''}
                    </p>
                  ) : (
                    <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-small sm:grid-cols-2">
                      {/* 基準別の進捗は分母つきの帯（準拠率のような 1 つの数字にしない。§10.4 B6） */}
                      <div className="sm:col-span-2">
                        <dt className="sr-only">適用確定済みのうち承認済み</dt>
                        <dd>
                          <FractionBar
                            label="適用確定済みのうち承認済み"
                            numerator={summary.approvedOfApplicable}
                            denominator={summary.applicableConfirmed}
                            unit="項目"
                          />
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-ink-muted">適用未判定: </dt>
                        <dd className="inline font-medium">{summary.notAssessed} 件</dd>
                      </div>
                      <div>
                        <dt className="inline text-ink-muted">対象外・非重要と判断: </dt>
                        <dd className="inline">{summary.excludedDecided} 件（理由・判断者あり）</dd>
                      </div>
                      <div>
                        <dt className="inline text-ink-muted">収録された要求事項: </dt>
                        <dd className="inline">{summary.total} 項目</dd>
                      </div>
                    </dl>
                  )}
                  {summary.notReadyReasons.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-caption text-warning-ink">
                      {summary.notReadyReasons.map((reason) => (
                        <li key={reason} className="flex items-center gap-1">
                          <AlertTriangle className="size-3" aria-hidden="true" />
                          {reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {mode === 'rows' && (
                    <Link
                      href={`${base}?tab=requirements&fw=${framework.projectFramework.id}`}
                      className="mt-1 inline-block text-small text-brand-800 hover:underline"
                    >
                      要求事項の一覧を開く
                    </Link>
                  )}
                </div>
              ))}
              {summaries.length === 0 && (
                <p className="text-small text-ink-muted">
                  基準が登録されていません（社内 ESG 管理のみ）。
                </p>
              )}
            </div>
          </Section>

          <Section title="基準・版と適用判断">
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>基準・版</TH>
                    <TH>目的</TH>
                    <TH>法的な位置付け・収録</TH>
                    <TH>重要性の考え方</TH>
                    <TH>適用判断</TH>
                  </TR>
                </THead>
                <TBody>
                  {detail.frameworks.map((f) => (
                    <TR key={f.projectFramework.id}>
                      <TD className="min-w-[200px] text-small">
                        <span className="font-medium">{f.label}</span>
                        {f.version.versionCode && (
                          <span className="block text-caption text-ink-muted">
                            {f.version.versionCode}
                          </span>
                        )}
                        {f.newerVersions.length > 0 && (
                          <Link
                            href={`${base}?tab=settings#pf-${f.projectFramework.id}`}
                            className="mt-0.5 flex items-center gap-1 text-caption text-warning-ink underline"
                          >
                            <AlertTriangle className="size-3" aria-hidden="true" />
                            新しい版があります（自動では切り替えていません）
                          </Link>
                        )}
                      </TD>
                      <TD className="text-small">{f.purposeLabel}</TD>
                      <TD className="min-w-[200px] text-small">
                        <LegalStatusBadge legal={f.legal} />
                        {f.legal.coverageLabel && (
                          <span className="mt-0.5 block text-caption text-ink-muted">
                            {f.legal.coverageLabel}
                            {f.legal.coverageNote ? `：${f.legal.coverageNote}` : ''}
                          </span>
                        )}
                        {f.legal.sourceUrl && (
                          <a
                            href={f.legal.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 inline-flex items-center gap-0.5 text-caption text-brand-800 underline"
                          >
                            一次資料
                            <ExternalLink className="size-3" aria-hidden="true" />
                            <span className="sr-only">（新しいタブで開く）</span>
                          </a>
                        )}
                      </TD>
                      <TD className="text-small">{f.legal.materialityLabel ?? '—'}</TD>
                      <TD className="min-w-[260px] text-small">
                        <ApplicabilityBadge
                          status={f.projectFramework.applicabilityStatus}
                          confirmed={f.confirmed}
                        />
                        {f.currentDecision ? (
                          <span className="mt-0.5 block text-caption text-ink-muted">
                            判断 {f.currentDecision.decisionNo}：
                            {nameOf(detail.members, f.currentDecision.decidedBy)}・ 確認日{' '}
                            {formatJstDate(f.currentDecision.confirmedOn)}・
                            {f.currentDecision.ruleRef}
                          </span>
                        ) : (
                          <span className="mt-0.5 block text-caption text-ink-muted">
                            判断は確定していません（下書きの準備はできます）。
                          </span>
                        )}
                        {f.decisions.length > 0 && (
                          <Collapsible
                            variant="plain"
                            summary={`判断の履歴（${f.decisions.length} 件）`}
                            className="mt-1"
                          >
                            <ol className="space-y-1">
                              {f.decisions.map((d) => (
                                <li
                                  key={d.id}
                                  className="rounded-t4d bg-surface-muted px-2 py-1 text-caption"
                                >
                                  <span className="font-medium">
                                    判断 {d.decisionNo}：
                                    {APPLICABILITY_STATUS_LABELS[d.applicabilityStatus]}
                                  </span>
                                  <span className="block">理由: {d.reason}</span>
                                  <span className="block text-ink-muted">
                                    参照規則・版: {d.ruleRef}／確認日 {formatJstDate(d.confirmedOn)}
                                    ／ 判断者 {nameOf(detail.members, d.decidedBy)}／
                                    {formatJst(d.decidedAt)}
                                  </span>
                                  {d.transitionalNote && (
                                    <span className="block text-ink-muted">
                                      経過措置: {d.transitionalNote}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </Collapsible>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Section>
        </div>

        <div className="space-y-2">
          <Collapsible summary="プロジェクトの前提" meta={`期限 ${formatJstDate(project.dueDate)}`}>
            <dl className="space-y-1 text-small">
              {(
                [
                  ['報告主体', project.reportingEntity || '—'],
                  [
                    '報告期間',
                    `${detail.period?.code ?? '—'}（${formatJstDate(project.periodStart)}〜${formatJstDate(project.periodEnd)}）`,
                  ],
                  ['報告通貨', project.currency],
                  [
                    '目的',
                    project.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・') || '—',
                  ],
                  [
                    '原稿の言語',
                    project.languages.map((l) => DISCLOSURE_LANGUAGE_LABELS[l]).join('・'),
                  ],
                  ['作成担当', nameOf(detail.members, project.ownerUserId) ?? '未定'],
                  ['レビュアー', nameOf(detail.members, project.reviewerUserId) ?? '未定'],
                  ['最終承認者', nameOf(detail.members, project.finalApproverUserId) ?? '未定'],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="shrink-0 text-ink-muted">{label}</dt>
                  <dd className="text-right text-ink">{value}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-ink-muted">期限</dt>
                <dd className="text-right text-ink">
                  {formatJstDate(project.dueDate)}
                  {daysLeft !== null && (
                    <span className={daysLeft < 0 ? 'ml-1 text-danger' : 'ml-1 text-ink-muted'}>
                      {daysLeft < 0 ? `（${-daysLeft} 日超過）` : `（あと ${daysLeft} 日）`}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            <dl className="mt-2 space-y-1 border-t border-line pt-2 text-small">
              {(
                [
                  ['対象組織', project.scopeOrgNote],
                  ['財務連結の範囲', project.scopeConsolidationNote],
                  ['GHG 算定境界', project.scopeGhgBoundaryNote],
                  ['バリューチェーン', project.scopeValueChainNote],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className="text-ink">{value || '（記載なし）'}</dd>
                </div>
              ))}
            </dl>
          </Collapsible>

          {/* 草案・サンプルの基準は準備としてだけ扱う（誠実さの注記なので折りたたみの外に出す） */}
          {packageCheck.preparationOnly.length > 0 && (
            <p className="text-caption text-ink-muted">
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                草案・サンプル
              </Badge>{' '}
              {packageCheck.preparationOnly.join('、')}
              は準備としてのみ扱い、正式な準拠の完了とは表示しません。
            </p>
          )}
          <Collapsible
            summary="法定提出用の確定パッケージ"
            meta={
              packageCheck.ok
                ? '作成の前提を満たしています'
                : `作成できません（理由 ${packageCheck.reasons.length} 件）`
            }
          >
            <div className="text-small">
              {packageCheck.ok ? (
                <p className="flex items-center gap-1 text-ink">
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
                  適用判断が確定しており、作成の前提を満たしています（原稿の承認は別途必要です）。
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-1 text-ink">
                    <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
                    現在は作成できません。下書きの準備・レビュー用の出力はできます。
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-caption text-ink-muted">
                    {packageCheck.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Collapsible>

          <Collapsible summary="関連する画面">
            <ul className="space-y-1 text-small">
              <li>
                <Link href={manuscriptsHref()} className="text-brand-800 hover:underline">
                  原稿の一覧
                </Link>
              </li>
              <li>
                <Link href="/enterprise/narratives" className="text-brand-800 hover:underline">
                  定性情報
                </Link>
              </li>
              <li>
                <Link href="/enterprise/evidence" className="text-brand-800 hover:underline">
                  資料・証跡
                </Link>
              </li>
              <li>
                <Link href="/enterprise/data" className="text-brand-800 hover:underline">
                  定量データ
                </Link>
              </li>
              {detail.frameworks.some((f) => f.frameworkKey === 'ssbj') && (
                <li>
                  <Link
                    href="/enterprise/disclosures/ssbj"
                    className="text-brand-800 hover:underline"
                  >
                    SSBJ 対応状況（従来の画面）
                  </Link>
                </li>
              )}
            </ul>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
