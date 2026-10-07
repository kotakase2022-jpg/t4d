import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CircleAlert,
  Lightbulb,
  Minus,
  TriangleAlert,
} from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { getOpenAiConfig } from '@/lib/config';
import { formatEstimatedCostUsd, formatJst } from '@/lib/format/datetime';
import { loadConversation } from '@/lib/services/copilot';
import { loadInsightResult } from '@/lib/services/insights';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { AiRun } from '@/types/domain';
import { runInsightDiscoveryAction } from '../actions';
import { CopilotChat } from './copilot-chat';

export const metadata = { title: 'AI Copilot' };

/**
 * AI Copilot（plan §2.26 E06）。6 区画を、毎日使う 2 つ（対話・インサイト）と、確かめたいときに開く
 * 3 つ（AI の実行記録・接続状態・利用できる AI 機能。既定で閉じる）に分ける。
 *
 * 閉じないもの: 「AI は自動確定しない」の説明（見出しの下）、デモ生成（Mock）であることの注記とバッジ、
 * インサイトの「候補」の警告、AI に対する禁止事項。
 * 実行記録の状態は登録簿のラベル（生の enum を出さない）、提供元・モデル・トークンなどの技術情報は
 * 表の「列 ▾」から出す（plan §1.5 L3）。
 */

const FEATURE_LABEL: Record<string, string> = {
  importMapping: '取込マッピング',
  anomalyExplanation: '異常値の説明',
  cdpQuestionMapping: 'CDP 質問マッピング',
  cdpDraftGeneration: 'CDP 回答ドラフト',
  evidenceMapping: '資料の自動対応付け',
  inconsistencyCheck: '矛盾・陳腐化チェック',
  insightDiscovery: 'インサイト発見',
  copilotChat: 'Copilot 対話',
  assuranceEvidenceSummary: '資料の要約（監査）',
  assuranceChangeSummary: 'Snapshot 後の変更の要約（監査）',
  // 開示優先モードの原稿編集画面から実行する。候補は人が段落ごとに採用するまで本文に入らない
  disclosureBlockDraft: '開示本文の下書き',
  // CSRD の要求事項詳細・開示ドラフトの画面から実行する。結果は候補の列にだけ入り、人が採用・確定する
  csrdGapAnalysis: 'CSRD ギャップ分析',
  csrdDisclosureDraft: 'CSRD 開示ドラフト',
};

/** 機能ごとの「どこから実行するか」 */
function featureWhere(key: string): string {
  if (key === 'cdpDraftGeneration') return 'CDP 質問画面から実行します。';
  if (key === 'importMapping') return '取込ジョブの解析時に自動実行されます。';
  if (key === 'disclosureBlockDraft') {
    return '開示プロジェクトの原稿編集画面から実行します（候補は段落ごとに人が採用）。';
  }
  if (key.startsWith('csrd')) {
    return 'CSRD の要求事項詳細・開示ドラフトの画面から実行します（候補は人が採用・確定）。';
  }
  if (key.startsWith('assurance')) return '監査法人ワークスペースで実行します。';
  if (key === 'copilotChat' || key === 'insightDiscovery') return 'この画面で実行します。';
  return '対象画面から実行します。';
}

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

const RUN_COLUMNS: DataTableColumn<AiRun>[] = [
  {
    key: 'feature',
    header: '機能',
    importance: 'primary',
    lockVisible: true,
    cell: (run) => FEATURE_LABEL[run.featureType] ?? run.featureType,
  },
  {
    key: 'status',
    header: '状態',
    importance: 'primary',
    cell: (run) => <StatusBadge domain="aiRun" value={run.status} />,
  },
  {
    key: 'confidence',
    header: '確信度',
    importance: 'primary',
    align: 'right',
    cell: (run) => <span className="tnum">{Math.round(run.confidence * 100)}%</span>,
  },
  {
    key: 'createdAt',
    header: '実行日時',
    importance: 'primary',
    cell: (run) => (
      <span className="whitespace-nowrap text-caption text-ink-muted">
        {formatJst(run.createdAt)}
      </span>
    ),
  },
  {
    key: 'provider',
    header: '提供元',
    importance: 'detail',
    cell: (run) =>
      run.provider === 'mock' ? <HonestyBadge kind="mock-ai" /> : <span>OpenAI</span>,
  },
  {
    key: 'model',
    header: 'モデル',
    importance: 'detail',
    cell: (run) => <span className="text-caption">{run.model}</span>,
  },
  {
    key: 'promptVersion',
    header: 'プロンプトの版',
    importance: 'detail',
    cell: (run) => <span className="text-caption">{run.promptVersion}</span>,
  },
  {
    key: 'latency',
    header: '応答時間',
    importance: 'detail',
    align: 'right',
    cell: (run) => <span className="tnum">{run.latencyMs} ms</span>,
  },
  {
    key: 'tokens',
    header: 'トークン数',
    importance: 'detail',
    align: 'right',
    cell: (run) => <span className="tnum">{run.tokenUsage.total}</span>,
  },
  {
    key: 'cost',
    header: 'コスト',
    importance: 'detail',
    align: 'right',
    cell: (run) => <span className="tnum">{formatEstimatedCostUsd(run.estimatedCostUsd)}</span>,
  },
];

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
  const aiPermission = PERMISSION_LABELS['enterprise.ai.run'];
  const deniedMessage = `質問するには「${aiPermission.label}」の権限が必要です。${aiPermission.holders}に依頼してください。`;

  // Copilot 対話（?chat=<conversationId> で会話を継続・読み直し）
  const chatId = typeof params.chat === 'string' ? params.chat : null;
  const conversation = chatId ? await loadConversation(shell.db, shell.ctx, chatId) : null;

  const totalCost = runs.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  const accepted = runs.filter((r) => r.status === 'accepted').length;
  const rejected = runs.filter((r) => r.status === 'rejected').length;
  const costText = formatEstimatedCostUsd(Number(totalCost.toFixed(4)));

  return (
    <>
      <PageHeader
        title="AI Copilot"
        description="AI は候補の提示のみを行い、承認済みデータ・開示回答・保証結論を自動確定しません。"
        context={<HonestyBadge kind={connected ? 'ai-candidate' : 'mock-ai'} />}
        autoBreadcrumbs
      />

      <div className="space-y-3 p-4">
        {!connected && (
          <Notice tone="warning" title="AI の提供元に接続していません">
            決定論的なデモ生成（Mock）の AI
            を使っています。出力には「デモ生成（Mock）」のバッジが付きます。
          </Notice>
        )}

        <Section title="Copilot 対話 — 権限内のデータに限定して答えます" divider="none">
          <div className="rounded-t4d border border-brand-200 bg-surface">
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
              deniedMessage={deniedMessage}
            />
          </div>
        </Section>

        <Section
          title="インサイト — 気づいていない論点を AI が横断発見"
          actions={
            canRunAi ? (
              <form action={runInsightDiscoveryAction}>
                <SubmitButton
                  size="sm"
                  variant="secondary"
                  icon={<Lightbulb aria-hidden="true" />}
                  pendingLabel="分析中…"
                >
                  インサイトを発見
                </SubmitButton>
              </form>
            ) : undefined
          }
        >
          <p className="text-small text-ink-muted">
            承認済みデータの拠点別トレンド・収集の滞留・開示ギャップ・資料の不足・監査依頼を横断で突き合わせ、
            単一画面では見えない論点を提示します。AI は提示のみを行い、データは変更しません。
          </p>
          {!insight ? (
            <p className="py-2 text-small text-ink-muted">
              {canRunAi
                ? 'まだ実行していません。「インサイトを発見」を押すと分析が始まります。'
                : `まだ実行していません。インサイトの実行には「${aiPermission.label}」の権限が必要です。`}
            </p>
          ) : (
            <div className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                <HonestyBadge kind={insight.run.provider === 'mock' ? 'mock-ai' : 'ai-candidate'} />
                <span>{formatJst(insight.run.createdAt)} 実行</span>
                <span>確信度 {Math.round(insight.run.confidence * 100)}%</span>
              </div>
              {insight.run.warnings.length > 0 && (
                <p className="flex items-start gap-1 text-caption text-warning-ink">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  {insight.run.warnings.join(' / ')}
                </p>
              )}
              {insight.insights.length === 0 ? (
                <p className="text-small text-ink-muted">
                  現時点で提示できる洞察はありませんでした。
                </p>
              ) : (
                <ul className="grid gap-2 md:grid-cols-2">
                  {insight.insights.map((item, i) => {
                    const impact = IMPACT_LABEL[item.impact];
                    const Icon = impact?.Icon ?? Minus;
                    return (
                      <li key={i} className="rounded-t4d border border-line bg-surface p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-body font-medium text-ink">{item.title}</span>
                          <span className="flex shrink-0 items-center gap-1">
                            <Badge tone={impact?.tone ?? 'neutral'}>
                              <Icon className="size-3" aria-hidden="true" />
                              {impact?.label ?? item.impact}
                            </Badge>
                            <Badge tone="neutral">
                              {INSIGHT_CATEGORY_LABEL[item.category] ?? item.category}
                            </Badge>
                          </span>
                        </div>
                        <dl className="mt-1.5 space-y-1 text-small">
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
                            className="mt-1.5 inline-flex items-center gap-1 text-small text-brand-800 hover:underline"
                          >
                            確認しに行く
                            <ArrowRight className="size-3" aria-hidden="true" />
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </Section>

        <Section
          id="ai-runs"
          collapsible
          title={`AI の実行記録（${runs.length}）`}
          summary={`直近 ${runs.length} 件・採用 ${accepted}・不採用 ${rejected}・推定コスト合計 ${costText}`}
          // 列の表示を切り替えた（URL の cols が表を指す）ときは開いて描く
          open={params.cols !== undefined || undefined}
        >
          <DataTable<AiRun>
            id="ai-runs-table"
            caption="AI の実行記録"
            columns={RUN_COLUMNS}
            rows={runs}
            getRowId={(run) => run.id}
            getRowLabel={(run) => FEATURE_LABEL[run.featureType] ?? run.featureType}
            searchParams={params}
            basePath="/enterprise/ai"
            search={false}
            empty={{
              noData: {
                title: 'AI の実行記録はありません',
                description:
                  'CDP の質問画面・取込ジョブ・この画面の対話などで AI を実行すると、何をどの版で実行したかがここに記録されます。',
                action: (
                  <Link
                    href="/enterprise/disclosures/cdp"
                    className="text-small text-brand-700 underline underline-offset-2"
                  >
                    CDP の質問で AI を使う
                  </Link>
                ),
              },
            }}
          />
        </Section>

        <Section
          id="ai-connection"
          collapsible
          title="接続状態"
          summary={`提供元 ${connected ? 'OpenAI' : 'デモ生成（Mock）'}・直近 ${runs.length} 件・推定コスト合計 ${costText}`}
        >
          <dl className="grid gap-x-6 text-small sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="提供元" value={connected ? 'OpenAI' : 'デモ生成（Mock・決定論的）'} />
            <Meta label="モデル" value={connected ? config.model : 'mock-deterministic-v1'} />
            <Meta label="時間切れ" value={`${config.timeoutMs} ms`} />
            <Meta label="再試行の上限" value={`${config.maxRetries} 回`} />
            <Meta label="実行回数（直近 50）" value={String(runs.length)} />
            <Meta label="採用" value={String(accepted)} />
            <Meta label="不採用" value={String(rejected)} />
            <Meta label="推定コスト合計" value={costText} />
          </dl>
        </Section>

        <Section
          id="ai-features"
          collapsible
          title={`利用できる AI 機能（${Object.keys(FEATURE_LABEL).length}）`}
          summary="どの画面から実行するか"
        >
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {Object.entries(FEATURE_LABEL).map(([key, label]) => (
              <li key={key} className="rounded-t4d border border-line px-2 py-1.5">
                <span className="text-small font-medium text-ink">{label}</span>
                <p className="text-caption text-ink-muted">{featureWhere(key)}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="AI に対する禁止事項（実装で担保）">
          <ul className="list-inside list-disc space-y-1 text-small text-ink">
            <li>
              承認済みデータの無断上書き（データアクセスの層に AI からの直接更新の経路を持たない）
            </li>
            <li>
              最終 CDP 回答の自動提出（AI が作った版は承認済みにできない。データベースでも禁止）
            </li>
            <li>保証結論・意見・Sign-off の自動確定（監査の AI は要約・差分の提示のみ）</li>
            <li>権限外の資料の参照（AI へは権限内のデータだけを渡す）</li>
            <li>秘密の鍵・API キーを AI への指示に含めること</li>
            <li>資料のない内容の断定（警告・不足している情報を必ず表示する）</li>
          </ul>
          <p className="mt-1.5 text-caption text-ink-muted">
            実装していない機能は{' '}
            <Link href="/enterprise/roadmap" className="text-brand-700 hover:underline">
              今後対応一覧
            </Link>
            にまとめています。
          </p>
        </Section>
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
