import Link from 'next/link';
import { CircleAlert, FlaskConical, Send, Target } from 'lucide-react';
import { DisclosureSteps, type DisclosureStep } from '@/components/shared/disclosure-steps';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatNumber } from '@/lib/format/datetime';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { CATEGORY_LABEL, loadMateriality, MATERIALITY_LABEL } from '@/lib/services/materiality';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { MaterialityLevel } from '@/types/domain';
import { saveMaterialityTopicAction } from '../../actions';

export const metadata = { title: 'SSBJ' };

const LEVEL_TONE: Record<MaterialityLevel, 'danger' | 'warning' | 'neutral' | 'brand'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  not_material: 'neutral',
  not_assessed: 'neutral',
};

/** 充足度に応じた色（色だけに頼らず、必ず数値を併記する） */
function coverageTone(coverage: number): 'success' | 'warning' | 'danger' {
  if (coverage >= 80) return 'success';
  if (coverage >= 50) return 'warning';
  return 'danger';
}

export default async function SsbjPage() {
  const shell = await loadEnterpriseShell();
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');

  const [workspace, materiality] = await Promise.all([
    loadDisclosureWorkspace(
      shell.db,
      shell.ctx,
      'ssbj',
      shell.currentPeriod,
      shell.periods,
      shell.metrics,
    ),
    loadMateriality(shell.db, shell.ctx, shell.currentPeriod, shell.metrics),
  ]);

  const missingItems = workspace
    ? workspace.rows.filter((r) => !r.response || r.response.status === 'not_started')
    : [];

  const steps: DisclosureStep[] = [
    {
      title: 'マテリアリティを登録する',
      description:
        '自社にとって重要なサステナビリティ課題を特定します。ここが SSBJ 開示の起点です。',
      state: materiality.registered ? 'done' : 'current',
      detail: materiality.registered ? (
        <span>重要と評価: {materiality.materialCount} トピック</span>
      ) : (
        <span className="text-[#8a5d00]">未登録（下の表で評価してください）</span>
      ),
    },
    {
      title: '対象データを集める',
      description: '重要と評価したトピックに紐づく指標を収集します。承認済みの値が対象です。',
      state: materiality.registered
        ? materiality.overallCoverage >= 100
          ? 'done'
          : 'current'
        : 'todo',
      detail: <span>充足度 {materiality.overallCoverage}%</span>,
      action: { label: 'データ収集へ', href: '/enterprise/imports' },
    },
    {
      title: '不足項目に対応する',
      description: '開示項目のうち未着手のものを埋め、拠点へ提出を依頼します。',
      state: materiality.registered && materiality.overallCoverage > 0 ? 'current' : 'todo',
      detail: <span>未着手 {missingItems.length} 件</span>,
      action: { label: 'ワークフローへ', href: '/enterprise/workflows' },
    },
  ];

  return (
    <>
      <PageHeader
        title="SSBJ 開示対応"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {workspace?.versionLabel ?? 'マスター未登録'} ／ {shell.currentPeriod.label}
            </span>
            {workspace?.isFixture && (
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                架空の縮小マスター
              </Badge>
            )}
          </span>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'SSBJ' }]}
      />

      <div className="space-y-3 p-4">
        <DisclosureSteps steps={steps} />

        {/* 充足度の可視化 */}
        <ul className="grid grid-cols-4 gap-2">
          <li>
            <KpiCard
              label="マテリアリティ充足度"
              value={materiality.overallCoverage}
              suffix="%"
              tone={coverageTone(materiality.overallCoverage)}
              href="/enterprise/disclosures/ssbj"
            />
          </li>
          <li>
            <KpiCard
              label="重要トピック"
              value={materiality.materialCount}
              suffix="件"
              href="/enterprise/disclosures/ssbj"
            />
          </li>
          <li>
            <KpiCard
              label="開示項目"
              value={workspace?.rows.length ?? 0}
              suffix="件"
              href="/enterprise/disclosures/ssbj"
            />
          </li>
          <li>
            <KpiCard
              label="未着手"
              value={missingItems.length}
              suffix="件"
              tone={missingItems.length > 0 ? 'warning' : 'success'}
              href="/enterprise/disclosures/ssbj"
            />
          </li>
        </ul>

        {/* Step 1: マテリアリティの登録 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="マテリアリティ評価"
            action={
              <span className="text-[11px] text-ink-muted">
                重要と評価したトピックの指標が、次の「データ収集」の対象になります
              </span>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>区分</TH>
                <TH>トピック</TH>
                <TH>対象指標</TH>
                <TH>評価</TH>
                <TH>充足度</TH>
                {canWrite && <TH>評価を登録</TH>}
              </TR>
            </THead>
            <TBody>
              {materiality.topics.map((topic) => (
                <TR key={topic.topicKey}>
                  <TD>{CATEGORY_LABEL[topic.category]}</TD>
                  <TD className="font-medium text-ink">
                    <div className="flex items-center gap-1.5">
                      <Target className="size-3.5 text-ink-muted" aria-hidden="true" />
                      {topic.title}
                    </div>
                    {topic.rationale && (
                      <p className="mt-0.5 text-[11px] text-ink-muted">{topic.rationale}</p>
                    )}
                  </TD>
                  <TD className="text-[11px] text-ink-muted">
                    {topic.totalMetricCount} 件
                    {topic.missingMetricNames.length > 0 && (
                      <span className="ml-1 text-[#8a5d00]">
                        （未収集: {topic.missingMetricNames.join('・')}）
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={LEVEL_TONE[topic.materiality]}>
                      {MATERIALITY_LABEL[topic.materiality]}
                    </Badge>
                  </TD>
                  <TD>
                    {topic.coverage === null ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-1.5 w-16 rounded-full bg-surface-muted">
                          <span
                            className={`block h-full rounded-full ${
                              topic.coverage >= 80
                                ? 'bg-success'
                                : topic.coverage >= 50
                                  ? 'bg-warning'
                                  : 'bg-danger'
                            }`}
                            style={{ width: `${topic.coverage}%` }}
                          />
                        </span>
                        <span className="text-[12px] tabular-nums">
                          {topic.coverage}%（{topic.collectedMetricCount}/{topic.totalMetricCount}）
                        </span>
                      </span>
                    )}
                  </TD>
                  {canWrite && (
                    <TD>
                      <form action={saveMaterialityTopicAction} className="flex items-center gap-1">
                        <input type="hidden" name="topicKey" value={topic.topicKey} />
                        <input
                          type="hidden"
                          name="reportingPeriodId"
                          value={shell.currentPeriod.id}
                        />
                        <select
                          name="materiality"
                          defaultValue={topic.materiality}
                          aria-label={`${topic.title} の重要度`}
                          className="h-7 rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                        >
                          <option value="high">重要度：高</option>
                          <option value="medium">重要度：中</option>
                          <option value="low">重要度：低</option>
                          <option value="not_material">重要ではない</option>
                          <option value="not_assessed">未評価</option>
                        </select>
                        <input
                          type="text"
                          name="rationale"
                          defaultValue={topic.rationale}
                          placeholder="評価理由"
                          aria-label={`${topic.title} の評価理由`}
                          className="h-7 w-36 rounded-t4d border border-line px-2 text-[12px]"
                        />
                        <Button type="submit" size="xs" variant="outline">
                          保存
                        </Button>
                      </form>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        {/* Step 3: 不足項目の一覧と提出依頼 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title={`開示項目（${workspace?.rows.length ?? 0}）`}
            action={
              missingItems.length > 0 ? (
                <Button size="xs" variant="outline" asChild>
                  <Link href="/enterprise/workflows">
                    <Send aria-hidden="true" />
                    提出を依頼する
                  </Link>
                </Button>
              ) : undefined
            }
          />
          {!workspace || workspace.rows.length === 0 ? (
            <EmptyState title="開示項目マスターが登録されていません" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>コード</TH>
                  <TH>区分</TH>
                  <TH>開示要求</TH>
                  <TH>回答型</TH>
                  <TH>必須</TH>
                  <TH>マッピング指標</TH>
                  <TH align="right">当年値</TH>
                  <TH>状態</TH>
                </TR>
              </THead>
              <TBody>
                {workspace.rows.map((row) => {
                  const notStarted = !row.response || row.response.status === 'not_started';
                  return (
                    <TR key={row.item.id}>
                      <TD className="font-mono text-[11px]">{row.item.code}</TD>
                      <TD>{row.item.section}</TD>
                      <TD className="max-w-[380px]">{row.item.questionText}</TD>
                      <TD>{row.item.answerType}</TD>
                      <TD>{row.item.required ? <Badge tone="brand">必須</Badge> : '—'}</TD>
                      <TD className="text-[11px]">
                        {row.mappedMetrics.length === 0
                          ? '—'
                          : row.mappedMetrics.map((m) => m.name).join(' / ')}
                      </TD>
                      <TD align="right">{formatNumber(row.currentValue)}</TD>
                      <TD>
                        {notStarted ? (
                          <Badge tone="warning">
                            <CircleAlert className="size-3" aria-hidden="true" />
                            未着手
                          </Badge>
                        ) : (
                          <Badge tone="neutral">対応中</Badge>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
