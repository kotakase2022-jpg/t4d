import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Download,
  FlaskConical,
  ListChecks,
  Minus,
  ShieldCheck,
  TriangleAlert,
  Sparkles,
  Upload,
} from 'lucide-react';
import { AiGeneratedBadge, PriorityBadge, ResponseStatusBadge } from '@/components/shared/badges';
import { DisclosureSteps, type DisclosureStep } from '@/components/shared/disclosure-steps';
import { FilterBar } from '@/components/shared/filter-bar';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { filterDisclosureRows, loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { loadApplicability, type Applicability } from '@/lib/services/disclosure-applicability';
import { loadQuestionMapping } from '@/lib/services/ai-assist';
import { loadConsistencyCheck } from '@/lib/services/disclosure-check';
import { loadDisclosureOnboarding } from '@/lib/services/disclosure-onboarding';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ItemChangeType } from '@/types/domain';
import {
  evaluateApplicabilityAction,
  runConsistencyCheckAction,
  runQuestionMappingAction,
} from '../../actions';

export const metadata = { title: 'CDP' };

const CHANGE_LABEL: Record<
  ItemChangeType,
  { label: string; tone: 'brand' | 'warning' | 'neutral' | 'danger' }
> = {
  new: { label: '新規', tone: 'warning' },
  changed: { label: '変更', tone: 'brand' },
  carry_forward: { label: '継続', tone: 'neutral' },
  retired: { label: '廃止', tone: 'danger' },
};

const ISSUE_KIND_LABEL: Record<string, string> = {
  missing_information: '不足情報',
  stale_content: '古い記述',
  period_mismatch: '年度不一致',
  contradiction: '回答間の矛盾',
  evidence_gap: 'Evidence 不足',
};

/** 適用判定（CDP-P0-002）。色だけで区別させないためアイコンとラベルを併記する。 */
const APPLICABILITY_LABEL: Record<
  Applicability,
  { label: string; tone: 'brand' | 'neutral' | 'warning'; Icon: typeof CircleCheck }
> = {
  applicable: { label: '適用', tone: 'brand', Icon: CircleCheck },
  not_applicable: { label: '非適用', tone: 'neutral', Icon: CircleSlash },
  needs_check: { label: '要確認', tone: 'warning', Icon: CircleHelp },
};

/** 指摘の重要度。色だけに頼らず、ラベルとアイコンを併記する。 */
const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};
const SEVERITY_ICON: Record<string, typeof CircleAlert> = {
  high: CircleAlert,
  medium: TriangleAlert,
  low: Minus,
};

export default async function CdpWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const workspace = await loadDisclosureWorkspace(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    shell.metrics,
  );
  if (!workspace) notFound();

  // 整合チェック結果は ?check=<aiRunId> で読み直す（CDP-P0-006）
  const checkRunId = typeof params.check === 'string' ? params.check : null;
  // 質問マッピングの候補は ?mapping=<aiRunId> で読み直す（候補のまま。確定は人が行う）
  const mappingRunId = typeof params.mapping === 'string' ? params.mapping : null;
  const mapping = mappingRunId
    ? await loadQuestionMapping(shell.db, shell.ctx, mappingRunId)
    : null;
  const check = checkRunId ? await loadConsistencyCheck(shell.db, shell.ctx, checkRunId) : null;

  // 適用判定（CDP-P0-002）。未実行なら空の Map なので列は「未判定」になる
  const applicability = await loadApplicability(shell.db, shell.ctx, workspace.period.id);
  const applicabilityCounts = {
    applicable: 0,
    not_applicable: 0,
    needs_check: 0,
  };
  for (const result of applicability.values()) applicabilityCounts[result.applicability] += 1;
  const hasApplicability = applicability.size > 0;

  // 準備段階（版の選択 → 過去データの取込）の到達状況
  const onboarding = await loadDisclosureOnboarding(
    shell.db,
    shell.ctx,
    'cdp',
    shell.currentPeriod,
    shell.periods,
    typeof params.version === 'string' ? params.version : null,
  );
  const selectedVersion = onboarding?.versions.find((v) => v.id === onboarding.selectedVersionId);
  const importedPeriods = (onboarding?.periods ?? []).filter((p) => p.responseCount > 0);
  const steps: DisclosureStep[] = [
    {
      title: 'バージョン（FY）を選ぶ',
      description: '回答する質問書の年度を決めます。年度が変わると質問の新規・変更が発生します。',
      state: selectedVersion ? 'done' : 'current',
      detail: selectedVersion ? (
        <span>
          {selectedVersion.label}（質問 {selectedVersion.itemCount} 件）
        </span>
      ) : undefined,
    },
    {
      title: '過去データを取り込む',
      description:
        '前年以前の回答を取り込むと、継続項目を引き継げます。複数年分をまとめて取り込めます。',
      state: onboarding?.hasPastData ? 'done' : 'current',
      detail:
        importedPeriods.length > 0 ? (
          <span>
            取込済み:{' '}
            {importedPeriods.map((p) => `${p.periodLabel}（${p.responseCount} 件）`).join(' ／ ')}
          </span>
        ) : (
          <span className="text-[#8a5d00]">まだ過去回答がありません</span>
        ),
      action: can(shell.ctx, 'enterprise.disclosure.write')
        ? { label: '過去回答を取り込む', href: '/enterprise/disclosures/cdp/import' }
        : undefined,
    },
    {
      title: '新規分・不足分に対応する',
      description: '取り込んだ内容と当年度の質問を突き合わせ、新規・変更・不足を埋めます。',
      state: onboarding?.hasPastData ? 'current' : 'todo',
      detail: (
        <span>
          新規 {workspace.summary.newItems} 件 ／ 未着手 {workspace.summary.notStarted} 件
        </span>
      ),
    },
  ];

  const onlyDiff = params.diff === '1';
  const rows = filterDisclosureRows(workspace.rows, {
    changeType: typeof params.change === 'string' ? params.change : undefined,
    status: typeof params.status === 'string' ? params.status : undefined,
    search: typeof params.q === 'string' ? params.q : undefined,
    onlyDiff,
  });

  return (
    <>
      <PageHeader
        title="CDP 開示対応"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {workspace.versionLabel} ／ {workspace.period.label}
            </span>
            {workspace.isFixture && (
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                架空の縮小マスター（正式質問書ではありません）
              </Badge>
            )}
          </span>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'CDP' }]}
        actions={
          <div className="flex items-center gap-2">
            {can(shell.ctx, 'enterprise.disclosure.write') && (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/enterprise/disclosures/cdp/import">
                    <Upload aria-hidden="true" />
                    過去回答を取込
                  </Link>
                </Button>
                <form action={evaluateApplicabilityAction}>
                  <input type="hidden" name="framework" value="cdp" />
                  <Button type="submit" variant="outline" size="sm">
                    <ListChecks aria-hidden="true" />
                    適用判定を実行
                  </Button>
                </form>
              </>
            )}
            {can(shell.ctx, 'enterprise.ai.run') && (
              <form action={runQuestionMappingAction}>
                <input type="hidden" name="frameworkKey" value="cdp" />
                <Button type="submit" variant="secondary" size="sm">
                  <Sparkles aria-hidden="true" />
                  質問マッピングを実行
                </Button>
              </form>
            )}
            {can(shell.ctx, 'enterprise.ai.run') && (
              <form action={runConsistencyCheckAction}>
                <input type="hidden" name="framework" value="cdp" />
                <Button type="submit" variant="secondary" size="sm">
                  <ShieldCheck aria-hidden="true" />
                  整合チェックを実行
                </Button>
              </form>
            )}
            <Button variant="outline" size="sm" asChild>
              {/* 期間を渡さないと常に collecting 期間が出力され、画面の選択と食い違う */}
              <a href={`/api/exports/cdp?period=${workspace.period.id}&format=xlsx`} download>
                <Download aria-hidden="true" />
                XLSX
              </a>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <DisclosureSteps steps={steps} />

        {onboarding && onboarding.versions.length > 1 && (
          <Card className="overflow-hidden">
            <SectionTitle title="バージョン（FY）" />
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              {onboarding.versions.map((v) => (
                <Button
                  key={v.id}
                  size="xs"
                  variant={v.id === onboarding.selectedVersionId ? 'secondary' : 'outline'}
                  asChild
                >
                  <Link href={`?version=${v.id}`}>
                    {v.label}
                    <span className="ml-1 text-ink-muted">
                      {v.status === 'published' ? '（最新）' : '（過年度）'}
                    </span>
                  </Link>
                </Button>
              ))}
              <span className="text-[11px] text-ink-muted">
                質問書の年度。過年度を選ぶと、その版の質問構成で確認できます。
              </span>
            </div>
          </Card>
        )}

        <ul className="grid grid-cols-6 gap-2">
          <li>
            <KpiCard
              label="準備度"
              value={workspace.summary.readiness}
              suffix="%"
              tone={workspace.summary.readiness >= 60 ? 'success' : 'warning'}
              href="/enterprise/disclosures/cdp"
            />
          </li>
          <li>
            <KpiCard
              label="承認済み"
              value={workspace.summary.approved}
              suffix={`/ ${workspace.summary.total}`}
              tone="success"
              href="/enterprise/disclosures/cdp?status=approved"
            />
          </li>
          <li>
            <KpiCard
              label="作成中"
              value={workspace.summary.draft}
              suffix="件"
              tone="brand"
              href="/enterprise/disclosures/cdp?status=draft"
            />
          </li>
          <li>
            <KpiCard
              label="未着手"
              value={workspace.summary.notStarted}
              suffix="件"
              tone="warning"
              href="/enterprise/disclosures/cdp?status=not_started"
            />
          </li>
          <li>
            <KpiCard
              label="新規質問"
              value={workspace.summary.newItems}
              suffix="件"
              tone="warning"
              href="/enterprise/disclosures/cdp?change=new"
            />
          </li>
          <li>
            <KpiCard
              label="変更質問"
              value={workspace.summary.changedItems}
              suffix="件"
              tone="brand"
              href="/enterprise/disclosures/cdp?change=changed"
            />
          </li>
        </ul>

        {hasApplicability && (
          <div className="flex flex-wrap items-center gap-2 rounded-t4d border border-line bg-surface px-3 py-1.5 text-[12px]">
            <span className="text-ink-muted">適用判定:</span>
            {(['applicable', 'not_applicable', 'needs_check'] as const).map((key) => {
              const a = APPLICABILITY_LABEL[key];
              return (
                <span key={key} className="inline-flex items-center gap-1">
                  <Badge tone={a.tone}>
                    <a.Icon className="size-3" aria-hidden="true" />
                    {a.label}
                  </Badge>
                  <span className="text-ink">{applicabilityCounts[key]} 件</span>
                </span>
              );
            })}
            <span className="text-[11px] text-ink-muted">
              非適用の質問も一覧には残ります。判定根拠はバッジにカーソルを合わせると表示されます。
            </span>
          </div>
        )}

        {mapping && (
          <Card className="overflow-hidden">
            <SectionTitle
              title={`質問マッピングの候補（${mapping.mappings.length} 件）`}
              action={
                <span className="flex items-center gap-2">
                  <AiGeneratedBadge provider={mapping.run.provider} />
                  <span className="text-[11px] text-ink-muted">
                    候補です。実際の紐付けは質問ごとに確定してください
                  </span>
                </span>
              }
            />
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>質問</TH>
                    <TH>指標コード</TH>
                    <TH>根拠</TH>
                    <TH align="right">確信度</TH>
                  </TR>
                </THead>
                <TBody>
                  {mapping.mappings.map((row) => (
                    <TR key={row.itemCode}>
                      <TD className="font-medium">{row.itemCode}</TD>
                      <TD>{row.metricCode ?? '—'}</TD>
                      <TD className="text-[12px] text-ink-muted">{row.rationale}</TD>
                      <TD align="right">{Math.round(row.confidence * 100)}%</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Card>
        )}

        {check && (
          <Card className="overflow-hidden">
            <SectionTitle
              title={`整合チェックの結果（${check.issues.length} 件の指摘）`}
              action={
                <span className="flex items-center gap-2">
                  <AiGeneratedBadge provider={check.run.provider} />
                  <span className="text-[11px] text-ink-muted">
                    {formatJst(check.run.createdAt)} 実行
                  </span>
                  <Link
                    href="/enterprise/disclosures/cdp"
                    className="text-[11px] text-brand-800 underline"
                  >
                    閉じる
                  </Link>
                </span>
              }
            />
            {check.issues.length === 0 ? (
              <p className="px-3 pb-3 text-[12px] text-ink-muted">
                不足・陳腐化・矛盾は検出されませんでした。
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>重要度</TH>
                    <TH>種別</TH>
                    <TH>対象</TH>
                    <TH>指摘</TH>
                  </TR>
                </THead>
                <TBody>
                  {check.issues.map((issue, i) => (
                    <TR key={`${issue.subject}-${i}`}>
                      <TD>
                        <Badge tone={SEVERITY_TONE[issue.severity]}>
                          {(() => {
                            const Icon = SEVERITY_ICON[issue.severity] ?? Minus;
                            return <Icon className="size-3" aria-hidden="true" />;
                          })()}
                          {SEVERITY_LABEL[issue.severity]}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-[12px]">
                        {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                      </TD>
                      <TD className="font-mono text-[11px]">{issue.subject}</TD>
                      <TD className="text-[12px] text-ink">{issue.detail}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              AI は指摘のみを行います。回答の修正・承認は人が行ってください。
            </p>
          </Card>
        )}

        <Card className="overflow-hidden">
          <FilterBar
            total={rows.length}
            searchPlaceholder="質問コード・質問文で検索"
            groups={[
              {
                key: 'change',
                label: '前年差分',
                multiple: false,
                options: [
                  { value: 'new', label: '新規' },
                  { value: 'changed', label: '変更' },
                  { value: 'carry_forward', label: '継続' },
                ],
              },
              {
                key: 'status',
                label: '状態',
                multiple: false,
                options: [
                  { value: 'not_started', label: '未着手' },
                  { value: 'draft', label: '作成中' },
                  { value: 'in_review', label: 'レビュー中' },
                  { value: 'approved', label: '承認済み' },
                ],
              },
            ]}
            savedViews={[
              {
                label: '前年差分だけ回答',
                query: 'diff=1',
                description: '新規・変更のあった質問だけを表示します',
              },
              { label: '未着手のみ', query: 'status=not_started' },
              { label: '承認済み', query: 'status=approved' },
            ]}
          />

          {onlyDiff && (
            <div className="border-b border-line bg-brand-50 px-3 py-1.5 text-[12px] text-brand-900">
              「前年差分だけ回答」モード: 継続（carry forward）質問を非表示にしています。
              <Link href="/enterprise/disclosures/cdp" className="ml-2 underline">
                すべて表示
              </Link>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState title="該当する質問がありません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>セクション</TH>
                    <TH>質問</TH>
                    <TH>適用</TH>
                    <TH>前年差分</TH>
                    <TH>状態</TH>
                    <TH>優先度</TH>
                    <TH>マッピング指標</TH>
                    <TH align="right">当年値</TH>
                    <TH align="right">前年値</TH>
                    <TH align="right">増減</TH>
                    <TH className="w-16" aria-label="操作" />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const change = CHANGE_LABEL[row.item.changeType];
                    const delta =
                      row.currentValue !== null &&
                      row.previousValue !== null &&
                      row.previousValue !== 0
                        ? ((row.currentValue - row.previousValue) / row.previousValue) * 100
                        : null;
                    return (
                      <TR key={row.item.id}>
                        <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                          {row.item.section}
                        </TD>
                        <TD className="max-w-[420px]">
                          <Link
                            href={`/enterprise/disclosures/cdp/${row.item.id}`}
                            className="font-medium text-brand-800 hover:underline"
                          >
                            {row.item.code}
                          </Link>
                          <div className="truncate text-[12px] text-ink">
                            {row.item.questionText}
                          </div>
                        </TD>
                        <TD>
                          {(() => {
                            const result = applicability.get(row.item.id);
                            if (!result) {
                              return <span className="text-[11px] text-ink-muted">未判定</span>;
                            }
                            const a = APPLICABILITY_LABEL[result.applicability];
                            return (
                              <span title={result.reason} className="inline-flex">
                                <Badge tone={a.tone}>
                                  <a.Icon className="size-3" aria-hidden="true" />
                                  {a.label}
                                </Badge>
                              </span>
                            );
                          })()}
                        </TD>
                        <TD>
                          <Badge tone={change.tone}>{change.label}</Badge>
                        </TD>
                        <TD>
                          <ResponseStatusBadge status={row.response?.status ?? 'not_started'} />
                        </TD>
                        <TD>
                          <PriorityBadge priority={row.priority} />
                        </TD>
                        <TD className="text-[11px]">
                          {row.mappedMetrics.length === 0
                            ? '—'
                            : row.mappedMetrics.map((m) => m.name).join(' / ')}
                        </TD>
                        <TD align="right">{formatNumber(row.currentValue)}</TD>
                        <TD align="right">{formatNumber(row.previousValue)}</TD>
                        <TD align="right">
                          {delta === null ? (
                            '—'
                          ) : (
                            <span className={delta >= 0 ? 'text-danger' : 'text-success'}>
                              {delta >= 0 ? '+' : ''}
                              {delta.toFixed(1)}%
                            </span>
                          )}
                        </TD>
                        <TD>
                          <Button variant="ghost" size="xs" asChild>
                            <Link href={`/enterprise/disclosures/cdp/${row.item.id}`}>開く</Link>
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
