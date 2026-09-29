import Link from 'next/link';
import { AlertTriangle, CheckCircle2, ExternalLink, FlaskConical, Info } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getReferenceDate } from '@/lib/clock';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
} from '@/lib/domain/disclosure-status';
import { daysUntilJst, formatJst, formatJstDate } from '@/lib/format/datetime';
import {
  canCreateStatutoryPackage,
  getProject,
  nameOf,
  packageInputOf,
  summarizeProject,
} from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { ApplicabilityBadge, LegalStatusBadge } from '../../_components/framework-badges';

/**
 * 概要タブ（§6.3）: プロジェクトの前提・基準ごとの位置付けと適用判断の履歴・分母付きの進捗。
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
  const summaries = await summarizeProject(db, ctx, detail);
  const packageCheck = canCreateStatutoryPackage({
    purposes: project.purposes,
    frameworks: detail.frameworks.map(packageInputOf),
  });
  const today = getReferenceDate();
  const daysLeft = daysUntilJst(project.dueDate, today);
  const base = `/enterprise/disclosure-projects/${project.id}`;
  const approvedBlocks = detail.blocks.filter(
    (b) => b.status === 'approved' && b.approvedVersionId,
  );

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        <Card>
          <SectionTitle title="進捗（分母つき）" />
          <div className="space-y-3 px-3 pb-3">
            <p className="text-[12px] text-ink">
              原稿: {detail.blocks.length} 節中、承認済み {approvedBlocks.length} 節
              <span className="ml-1 text-[11px] text-ink-muted">
                （承認は企業内の承認です。保証の結論ではありません）
              </span>
            </p>
            {summaries.map(({ framework, summary, mode }) => (
              <div
                key={framework.projectFramework.id}
                className="rounded-t4d border border-line p-2"
              >
                <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink">
                  {framework.label}
                  <LegalStatusBadge legal={framework.legal} />
                </p>
                {mode === 'not_loaded' ? (
                  <p className="mt-1 flex items-center gap-1 text-[12px] text-ink-muted">
                    <Info className="size-3.5" aria-hidden="true" />
                    要求事項は未収録（公開草案）。進捗は数えられません。
                    {framework.legal.coverageNote ? `（${framework.legal.coverageNote}）` : ''}
                  </p>
                ) : (
                  <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
                    <div>
                      <dt className="inline text-ink-muted">適用確定済み: </dt>
                      <dd className="inline font-medium">
                        {summary.applicableConfirmed} 項目中、承認済み{' '}
                        {summary.approvedOfApplicable} 項目
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
                  <ul className="mt-1 space-y-0.5 text-[11px] text-[#8a5d00]">
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
                    className="mt-1 inline-block text-[12px] text-brand-800 hover:underline"
                  >
                    要求事項の一覧を開く
                  </Link>
                )}
              </div>
            ))}
            {summaries.length === 0 && (
              <p className="text-[12px] text-ink-muted">
                基準が登録されていません（社内 ESG 管理のみ）。
              </p>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title="基準・版と適用判断" />
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
                    <TD className="min-w-[200px] text-[12px]">
                      <span className="font-medium">{f.label}</span>
                      {f.version.versionCode && (
                        <span className="block text-[11px] text-ink-muted">
                          {f.version.versionCode}
                        </span>
                      )}
                      {f.newerVersions.length > 0 && (
                        <Link
                          href={`${base}?tab=settings#pf-${f.projectFramework.id}`}
                          className="mt-0.5 block text-[11px] text-[#8a5d00] underline"
                        >
                          新しい版があります（自動では切り替えていません）
                        </Link>
                      )}
                    </TD>
                    <TD className="text-[12px]">{f.purposeLabel}</TD>
                    <TD className="min-w-[200px] text-[12px]">
                      <LegalStatusBadge legal={f.legal} />
                      {f.legal.coverageLabel && (
                        <span className="mt-0.5 block text-[11px] text-ink-muted">
                          {f.legal.coverageLabel}
                          {f.legal.coverageNote ? `：${f.legal.coverageNote}` : ''}
                        </span>
                      )}
                      {f.legal.sourceUrl && (
                        <a
                          href={f.legal.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-brand-800 underline"
                        >
                          一次資料
                          <ExternalLink className="size-3" aria-hidden="true" />
                          <span className="sr-only">（新しいタブで開く）</span>
                        </a>
                      )}
                    </TD>
                    <TD className="text-[12px]">{f.legal.materialityLabel ?? '—'}</TD>
                    <TD className="min-w-[260px] text-[12px]">
                      <ApplicabilityBadge
                        status={f.projectFramework.applicabilityStatus}
                        confirmed={f.confirmed}
                      />
                      {f.currentDecision ? (
                        <span className="mt-0.5 block text-[11px] text-ink-muted">
                          判断 {f.currentDecision.decisionNo}：
                          {nameOf(detail.members, f.currentDecision.decidedBy)}・ 確認日{' '}
                          {formatJstDate(f.currentDecision.confirmedOn)}・
                          {f.currentDecision.ruleRef}
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[11px] text-ink-muted">
                          判断は確定していません（下書きの準備はできます）。
                        </span>
                      )}
                      {f.decisions.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-brand-800">
                            判断の履歴（{f.decisions.length} 件）
                          </summary>
                          <ol className="mt-1 space-y-1">
                            {f.decisions.map((d) => (
                              <li
                                key={d.id}
                                className="rounded-t4d bg-surface-muted px-2 py-1 text-[11px]"
                              >
                                <span className="font-medium">
                                  判断 {d.decisionNo}：
                                  {APPLICABILITY_STATUS_LABELS[d.applicabilityStatus]}
                                </span>
                                <span className="block">理由: {d.reason}</span>
                                <span className="block text-ink-muted">
                                  参照規則・版: {d.ruleRef}／確認日 {formatJstDate(d.confirmedOn)}／
                                  判断者 {nameOf(detail.members, d.decidedBy)}／
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
                        </details>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      </div>

      <div className="space-y-3">
        <Card>
          <SectionTitle title="プロジェクトの前提" />
          <dl className="space-y-1 px-3 pb-3 text-[12px]">
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
          <dl className="space-y-1 border-t border-line px-3 py-2 text-[12px]">
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
        </Card>

        <Card>
          <SectionTitle title="法定提出用の確定パッケージ" />
          <div className="px-3 pb-3 text-[12px]">
            {packageCheck.ok ? (
              <p className="flex items-center gap-1 text-ink">
                <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
                適用判断が確定しており、作成の前提を満たしています（原稿の承認は別途必要です）。
              </p>
            ) : (
              <>
                <p className="flex items-center gap-1 text-ink">
                  <AlertTriangle className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
                  現在は作成できません。下書きの準備・レビュー用の出力はできます。
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-ink-muted">
                  {packageCheck.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {packageCheck.preparationOnly.length > 0 && (
              <p className="mt-1 text-[11px] text-ink-muted">
                <Badge tone="warning">
                  <FlaskConical className="size-3" aria-hidden="true" />
                  草案・サンプル
                </Badge>{' '}
                {packageCheck.preparationOnly.join('、')}
                は準備としてのみ扱い、正式な準拠の完了とは表示しません。
              </p>
            )}
          </div>
        </Card>

        <Card>
          <SectionTitle title="関連する画面" />
          <ul className="space-y-1 px-3 pb-3 text-[12px]">
            <li>
              <Link href={`${base}?tab=manuscripts`} className="text-brand-800 hover:underline">
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
        </Card>
      </div>
    </div>
  );
}
