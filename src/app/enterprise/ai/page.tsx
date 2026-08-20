import Link from 'next/link';
import { ArrowRight, Bot, CircleAlert, Lightbulb, Minus, TriangleAlert } from 'lucide-react';
import { AiGeneratedBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { can } from '@/lib/authorization/can';
import { getOpenAiConfig } from '@/lib/config';
import { formatEstimatedCostUsd, formatJst } from '@/lib/format/datetime';
import { loadConversation } from '@/lib/services/copilot';
import { loadInsightResult } from '@/lib/services/insights';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { runInsightDiscoveryAction } from '../actions';
import { CopilotChat } from './copilot-chat';

export const metadata = { title: 'AI Copilot' };

const FEATURE_LABEL: Record<string, string> = {
  importMapping: '取込マッピング',
  anomalyExplanation: '異常値の説明',
  cdpQuestionMapping: 'CDP 質問マッピング',
  cdpDraftGeneration: 'CDP 回答ドラフト',
  evidenceMapping: 'Evidence 自動マッピング',
  inconsistencyCheck: '矛盾・陳腐化チェック',
  insightDiscovery: 'インサイト発見',
  copilotChat: 'Copilot 対話',
  assuranceEvidenceSummary: 'Evidence 要約（監査）',
  assuranceChangeSummary: 'Snapshot 後変更要約（監査）',
};

const INSIGHT_CATEGORY_LABEL: Record<string, string> = {
  data_quality: 'データ品質',
  deadline_risk: '締切リスク',
  disclosure_gap: '開示ギャップ',
  trend_anomaly: 'トレンド異常',
  assurance_readiness: '監査対応',
  efficiency: '効率化',
};
/** 影響度。色だけに頼らず、ラベルとアイコンを併記する。 */
const IMPACT_LABEL: Record<
  string,
  { label: string; tone: 'danger' | 'warning' | 'neutral'; Icon: typeof CircleAlert }
> = {
  high: { label: '影響大', tone: 'danger', Icon: CircleAlert },
  medium: { label: '影響中', tone: 'warning', Icon: TriangleAlert },
  low: { label: '影響小', tone: 'neutral', Icon: Minus },
};

export default async function AiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const runs = await shell.db.select('aiRuns', {
    where: { organizationId: shell.ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 50,
  });

  const config = getOpenAiConfig();
  const connected = Boolean(config.apiKey);

  // インサイト（?insight=<runId> で読み直し。未指定なら最新の実行結果を表示）
  const insightRunId =
    typeof params.insight === 'string'
      ? params.insight
      : (runs.find((r) => r.featureType === 'insightDiscovery' && r.status !== 'failed')?.id ??
        null);
  const insight = insightRunId ? await loadInsightResult(shell.db, shell.ctx, insightRunId) : null;
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');

  // Copilot 対話（?chat=<conversationId> で会話を継続・読み直し）
  const chatId = typeof params.chat === 'string' ? params.chat : null;
  const conversation = chatId ? await loadConversation(shell.db, shell.ctx, chatId) : null;

  const totalCost = runs.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  const accepted = runs.filter((r) => r.status === 'accepted').length;
  const rejected = runs.filter((r) => r.status === 'rejected').length;

  return (
    <>
      <PageHeader
        title="AI Copilot"
        description="AI は候補の提示のみを行い、承認済みデータ・開示回答・保証結論を自動確定しません。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'AI Copilot' }]}
        actions={<AiGeneratedBadge provider={connected ? 'openai' : 'mock'} />}
      />

      <div className="space-y-3 p-4">
        <Card className="overflow-hidden border-brand-200">
          <SectionTitle title="Copilot 対話 — 権限内のデータに限定して答えます" />
          <CopilotChat
            initialTurns={(conversation?.turns ?? []).map((t) => ({
              runId: t.runId,
              question: t.question,
              answer: t.answer,
              confidence: t.confidence,
              provider: t.provider,
              references: t.references,
            }))}
            initialConversationId={conversation?.conversationId ?? null}
            canRunAi={canRunAi}
          />
        </Card>

        <Card className="overflow-hidden border-brand-200">
          <SectionTitle
            title="インサイト — 気づいていない論点を AI が横断発見"
            action={
              canRunAi ? (
                <form action={runInsightDiscoveryAction}>
                  <Button type="submit" size="sm" variant="secondary">
                    <Lightbulb aria-hidden="true" />
                    インサイトを発見
                  </Button>
                </form>
              ) : undefined
            }
          />
          <p className="px-3 text-[12px] text-ink-muted">
            承認済みデータの拠点別トレンド・収集の滞留・開示ギャップ・Evidence
            不足・監査依頼を横断で突き合わせ、単一画面では見えない論点を提示します。 AI
            は提示のみを行い、データは変更しません。
          </p>
          {!insight ? (
            <p className="p-3 text-[12px] text-ink-muted">
              まだ実行していません。「インサイトを発見」を押すと分析が始まります。
            </p>
          ) : (
            <div className="space-y-2 p-3">
              <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                <AiGeneratedBadge provider={insight.run.provider} />
                <span>{formatJst(insight.run.createdAt)} 実行</span>
                <span>確信度 {Math.round(insight.run.confidence * 100)}%</span>
              </div>
              {insight.insights.length === 0 ? (
                <p className="text-[12px] text-ink-muted">
                  現時点で提示できる洞察はありませんでした。
                </p>
              ) : (
                <ul className="grid grid-cols-2 gap-2">
                  {insight.insights.map((item, i) => (
                    <li key={i} className="rounded-t4d border border-line bg-surface p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-medium text-ink">{item.title}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Badge tone={IMPACT_LABEL[item.impact]?.tone ?? 'neutral'}>
                            {(() => {
                              const Icon = IMPACT_LABEL[item.impact]?.Icon ?? Minus;
                              return <Icon className="size-3" aria-hidden="true" />;
                            })()}
                            {IMPACT_LABEL[item.impact]?.label ?? item.impact}
                          </Badge>
                        </span>
                      </div>
                      <Badge tone="neutral">
                        {INSIGHT_CATEGORY_LABEL[item.category] ?? item.category}
                      </Badge>
                      <dl className="mt-1.5 space-y-1 text-[12px]">
                        <div>
                          <dt className="font-medium text-ink-muted">根拠</dt>
                          <dd className="text-ink">{item.finding}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-ink-muted">含意</dt>
                          <dd className="text-ink">{item.implication}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-ink-muted">推奨アクション</dt>
                          <dd className="text-ink">{item.recommendedAction}</dd>
                        </div>
                      </dl>
                      {item.link && (
                        <Link
                          href={item.link}
                          className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-brand-800 hover:underline"
                        >
                          確認しに行く
                          <ArrowRight className="size-3" aria-hidden="true" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {insight.run.warnings.length > 0 && (
                <p className="text-[11px] text-[#8a5d00]">⚠ {insight.run.warnings.join(' / ')}</p>
              )}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="接続状態" />
          <dl className="grid grid-cols-4 gap-x-6 px-3 pb-3 text-[12px]">
            <Meta label="Provider" value={connected ? 'OpenAI' : 'Mock（決定論的）'} />
            <Meta label="Model" value={connected ? config.model : 'mock-deterministic-v1'} />
            <Meta label="Timeout" value={`${config.timeoutMs} ms`} />
            <Meta label="Max Retries" value={String(config.maxRetries)} />
            <Meta label="実行回数（直近 50）" value={String(runs.length)} />
            <Meta label="採用" value={String(accepted)} />
            <Meta label="却下" value={String(rejected)} />
            <Meta
              label="推定コスト合計"
              value={formatEstimatedCostUsd(Number(totalCost.toFixed(4)))}
            />
          </dl>
          {!connected && (
            <p className="border-t border-line px-3 py-2 text-[12px] text-[#8a5d00]">
              OPENAI_API_KEY が未設定のため、決定論的な Mock AI を使用しています。出力には常に
              「Mock / AI未接続」バッジが表示されます。
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="利用できる AI 機能" />
          <ul className="grid grid-cols-2 gap-2 p-3">
            {Object.entries(FEATURE_LABEL).map(([key, label]) => (
              <li key={key} className="rounded-t4d border border-line px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-ink">{label}</span>
                  <Badge tone="neutral">{key}</Badge>
                </div>
                <p className="text-[11px] text-ink-muted">
                  {key === 'cdpDraftGeneration' && 'CDP 質問画面から実行します。'}
                  {key === 'importMapping' && '取込ジョブの解析時に自動実行されます。'}
                  {key.startsWith('assurance') && '監査法人ワークスペースで実行します。'}
                  {!key.startsWith('assurance') &&
                    key !== 'cdpDraftGeneration' &&
                    key !== 'importMapping' &&
                    '対象画面から実行します。'}
                </p>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`AI 実行履歴（${runs.length}）`} />
          {runs.length === 0 ? (
            <EmptyState
              title="AI の実行履歴はありません"
              description="CDP 質問画面や取込ジョブから AI を実行すると、ここに Provenance が記録されます。"
              icon={<Bot className="size-5" aria-hidden="true" />}
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>機能</TH>
                    <TH>Provider</TH>
                    <TH>Model</TH>
                    <TH>Prompt 版</TH>
                    <TH align="right">確信度</TH>
                    <TH align="right">Latency</TH>
                    <TH align="right">Token</TH>
                    <TH align="right">コスト</TH>
                    <TH>状態</TH>
                    <TH>実行日時</TH>
                  </TR>
                </THead>
                <TBody>
                  {runs.map((run) => (
                    <TR key={run.id}>
                      <TD>{FEATURE_LABEL[run.featureType] ?? run.featureType}</TD>
                      <TD>
                        <AiGeneratedBadge provider={run.provider} />
                      </TD>
                      <TD className="text-[11px]">{run.model}</TD>
                      <TD className="text-[11px]">{run.promptVersion}</TD>
                      <TD align="right">{Math.round(run.confidence * 100)}%</TD>
                      <TD align="right">{run.latencyMs} ms</TD>
                      <TD align="right">{run.tokenUsage.total}</TD>
                      <TD align="right">{formatEstimatedCostUsd(run.estimatedCostUsd)}</TD>
                      <TD>
                        <Badge
                          tone={
                            run.status === 'accepted'
                              ? 'success'
                              : run.status === 'rejected'
                                ? 'danger'
                                : run.status === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {run.status}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                        {formatJst(run.createdAt)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="AI に対する禁止事項（実装で担保）" />
          <ul className="list-inside list-disc space-y-1 px-3 pb-3 text-[12px] text-ink">
            <li>
              承認済み Data Point の無断上書き（Repository 層で AI からの直接更新経路を持たない）
            </li>
            <li>
              最終 CDP 回答の自動提出（AI 由来 Version は approved にできない。DB トリガでも禁止）
            </li>
            <li>保証結論・意見・Sign-off の自動確定（監査 AI は要約・差分の提示のみ）</li>
            <li>権限外 Evidence の参照（Prompt には権限内データのみを渡す）</li>
            <li>Client Secret や API Key の Prompt 送信</li>
            <li>Evidence がない内容の断定（warnings / missingInformation を必ず表示）</li>
          </ul>
          <p className="border-t border-line px-3 py-2 text-[11px] text-ink-muted">
            詳細は{' '}
            <Link href="/enterprise/roadmap" className="text-brand-700 hover:underline">
              今後対応一覧
            </Link>{' '}
            および docs/ai-design.md を参照してください。
          </p>
        </Card>
      </div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-line py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}
