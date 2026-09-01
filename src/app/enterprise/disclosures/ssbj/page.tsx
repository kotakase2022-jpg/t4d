import Link from 'next/link';
import {
  CircleAlert,
  ClipboardList,
  Database,
  FileText,
  FlaskConical,
  ListChecks,
  ScrollText,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { SsbjFlow, type SsbjFlowStep } from '@/components/shared/ssbj-flow';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  AREA_LABEL,
  COVERAGE_LABEL,
  COVERAGE_TONE,
  PRIORITY_LABEL,
  PRIORITY_MEANING,
} from '@/lib/domain/ssbj';
import { SSBJ_FRAMEWORK_INFO } from '@/lib/frameworks/ssbj-2026';
import { CATEGORY_LABEL, loadMateriality, MATERIALITY_LABEL } from '@/lib/services/materiality';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadSsbjOverview } from '@/lib/services/ssbj-gap';
import { loadSsbjSettings } from '@/lib/services/ssbj-settings';
import type { MaterialityLevel } from '@/types/domain';

export const metadata = { title: 'SSBJ 対応状況' };

const LEVEL_TONE: Record<MaterialityLevel, 'danger' | 'warning' | 'neutral' | 'brand'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  not_material: 'neutral',
  not_assessed: 'neutral',
};

/** 整備度に応じた色（色だけに頼らず、必ず数値を併記する） */
function rateTone(rate: number): 'success' | 'warning' | 'danger' {
  if (rate >= 80) return 'success';
  if (rate >= 50) return 'warning';
  return 'danger';
}

/** 3 つの整備度カード。単一の総合点にまとめず、何が遅れているかを分けて示す */
function ReadinessCard({
  label,
  description,
  rate,
  icon: Icon,
}: {
  label: string;
  description: string;
  rate: number;
  icon: typeof ListChecks;
}) {
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center gap-1.5">
        <Icon className="size-4 text-ink-muted" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-ink">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[28px] font-semibold leading-none text-ink tabular-nums">{rate}</span>
        <span className="text-[13px] text-ink-muted">%</span>
      </div>
      <Progress value={rate} tone={rateTone(rate)} label={`${label} ${rate}%`} />
      <p className="text-[11px] leading-relaxed text-ink-muted">{description}</p>
    </Card>
  );
}

export default async function SsbjPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  const [overview, materiality, settings] = await Promise.all([
    loadSsbjOverview(shell.db, shell.ctx, shell.currentPeriod, SSBJ_FRAMEWORK_INFO.attribution),
    loadMateriality(shell.db, shell.ctx, shell.currentPeriod, shell.metrics),
    loadSsbjSettings(shell.db, shell.ctx, shell.currentPeriod, shell.metrics),
  ]);

  if (!overview) {
    return (
      <>
        <PageHeader
          title="SSBJ 対応状況"
          breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'SSBJ' }]}
        />
        <div className="p-4">
          <EmptyState title="SSBJ の要求事項マスターが登録されていません" />
        </div>
      </>
    );
  }

  const { counts, areas } = overview;
  const remaining = counts.partial + counts.notCovered;

  const steps: SsbjFlowStep[] = [
    {
      // ここで決めることが後続すべての前提になる。決まっていないなら「完了」と書かない
      title: 'マテリアリティ・分析条件の設定',
      description: '適用する基準・報告の範囲・重要性のある課題を決めます。',
      state: settings.confirmed ? 'done' : 'current',
      detail: settings.confirmed
        ? `確定済み ／ 重要性あり ${settings.materialTopicCount} 件`
        : `未完了 ／ 残り ${settings.steps.filter((s) => !s.done).length} 項目`,
      href: '/enterprise/disclosures/ssbj/settings',
    },
    {
      title: '資料の取り込み',
      description: '有価証券報告書・統合報告書・社内規程などを取り込みます。',
      state: 'done',
      href: '/enterprise/imports',
    },
    {
      title: '対象判定・重要性判断',
      description: 'どの要求事項が自社に適用され、重要性があるかを判断します。',
      state: counts.notApplicable + counts.notMaterial > 0 ? 'done' : 'current',
      detail: `対象外 ${counts.notApplicable} 件／重要性なし ${counts.notMaterial} 件`,
      href: '/enterprise/disclosures/ssbj/requirements',
    },
    {
      title: '人工知能によるギャップ分析',
      description: '現在の開示内容と要求事項を比較し、対応状況を判定します。',
      state: 'done',
      detail: `${counts.total - counts.notApplicable} 件を判定`,
      href: '/enterprise/disclosures/ssbj/requirements',
    },
    {
      title: '担当者による確認',
      description: '人工知能の判定を確認し、承認または修正して最終判定にします。',
      state: counts.awaitingReview > 0 ? 'current' : 'done',
      detail: `確認待ち ${counts.awaitingReview} 件`,
      href: '/enterprise/disclosures/ssbj/requirements?coverage=unconfirmed',
    },
    {
      title: 'ギャップの優先順位付け',
      description: '重要性・期限・データの有無から、着手する順番を決めます。',
      state: remaining > 0 ? 'current' : 'done',
      detail: `優先度「高」${overview.topPriorities.filter((v) => v.priority.priority === 'high').length} 件`,
      href: '/enterprise/disclosures/ssbj/requirements?priority=high',
    },
    {
      title: '対応計画の作成',
      description: 'ギャップごとに担当部署・担当者・期限を決めます。',
      state:
        overview.planCounts.not_started + overview.planCounts.in_progress > 0 ? 'current' : 'todo',
      detail: `対応中 ${overview.planCounts.in_progress} 件／未着手 ${overview.planCounts.not_started} 件`,
      href: '/enterprise/disclosures/ssbj/plans',
    },
    {
      title: 'データ収集・開示・内部統制',
      description:
        '不足データを最大 5 階層の承認を通して集め、開示ドラフトを作り、証跡と承認履歴を残します。',
      state: 'todo',
      href: '/enterprise/disclosures/ssbj/collection',
    },
  ];

  const countCards: Array<{ label: string; value: number; tone?: 'warning' | 'danger' }> = [
    { label: '全要求事項', value: counts.total },
    { label: '対応済み', value: counts.covered },
    { label: 'おおむね対応', value: counts.mostlyCovered },
    { label: '一部対応', value: counts.partial, tone: 'warning' },
    { label: '未対応', value: counts.notCovered, tone: 'danger' },
    { label: '重要性なし', value: counts.notMaterial },
    { label: '対象外', value: counts.notApplicable },
    { label: '確認待ち', value: counts.awaitingReview, tone: 'warning' },
  ];

  return (
    <>
      <PageHeader
        title="SSBJ 対応状況"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {overview.versionLabel} ／ {shell.currentPeriod.label}
            </span>
            {overview.isFixture ? (
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                架空の縮小マスター
              </Badge>
            ) : (
              <Badge tone="success">
                <ScrollText className="size-3" aria-hidden="true" />
                正式基準準拠（転載許可取得済み）
              </Badge>
            )}
          </span>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'SSBJ' }]}
        actions={
          <div className="flex items-center gap-1.5">
            <Button size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj/requirements">
                <ListChecks aria-hidden="true" />
                要求事項一覧
              </Link>
            </Button>
            {/* 書き出すだけでなく、草案を作るところから扱えるようにする */}
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj/draft">
                <FileText aria-hidden="true" />
                開示ドラフト
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <SsbjFlow steps={steps} />

        {/* 単一の総合点にまとめない。何が遅れているのかを 3 つに分けて示す */}
        <section className="grid grid-cols-3 gap-2">
          <ReadinessCard
            label="開示対応度"
            description="要求される情報が、現在の開示資料に記載されている度合い"
            rate={overview.disclosureRate}
            icon={ScrollText}
          />
          <ReadinessCard
            label="データ整備度"
            description="開示に必要な情報・数値を、社内で取得できている度合い"
            rate={overview.dataRate}
            icon={Database}
          />
          <ReadinessCard
            label="業務プロセス・内部統制整備度"
            description="継続的かつ正確に収集・確認・承認できる仕組みがある度合い"
            rate={overview.processRate}
            icon={ShieldCheck}
          />
        </section>

        <ul className="grid grid-cols-8 gap-2">
          {countCards.map((card) => (
            <li key={card.label}>
              <Card className="space-y-1 p-2.5">
                <p className="truncate text-[11px] text-ink-muted">{card.label}</p>
                <p
                  className={`text-[20px] font-semibold leading-none tabular-nums ${
                    card.tone === 'danger'
                      ? 'text-danger'
                      : card.tone === 'warning'
                        ? 'text-[#8a5d00]'
                        : 'text-ink'
                  }`}
                >
                  {card.value}
                </p>
              </Card>
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-[1fr_1.4fr] gap-3">
          {/* 領域別の対応状況 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="領域別の対応状況"
              action={
                <span className="text-[11px] text-ink-muted">
                  対象外・重要性なしを除いた要求事項で集計
                </span>
              }
            />
            <Table>
              <THead>
                <TR>
                  <TH>領域</TH>
                  <TH align="right">要求事項</TH>
                  <TH>対応率</TH>
                  <TH align="right">未対応・未確認</TH>
                </TR>
              </THead>
              <TBody>
                {areas.map((area) => (
                  <TR key={area.area}>
                    <TD className="font-medium text-ink">{AREA_LABEL[area.area]}</TD>
                    <TD align="right">{area.total}</TD>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        <Progress
                          value={area.rate}
                          tone={rateTone(area.rate)}
                          className="w-24"
                          label={`${AREA_LABEL[area.area]} の対応率 ${area.rate}%`}
                        />
                        <span className="text-[12px] tabular-nums">{area.rate}%</span>
                      </span>
                    </TD>
                    <TD align="right">
                      {area.notCovered > 0 ? (
                        <Link
                          href={`/enterprise/disclosures/ssbj/requirements?area=${area.area}&coverage=not_covered&coverage=unconfirmed`}
                          className="font-medium text-danger underline-offset-2 hover:underline"
                        >
                          {area.notCovered}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          {/* 優先度の高いギャップ */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="優先して対応するギャップ"
              action={
                <span className="text-[11px] text-ink-muted">
                  優先度「高」= {PRIORITY_MEANING.high}
                </span>
              }
            />
            {overview.topPriorities.length === 0 ? (
              <EmptyState title="優先して対応すべきギャップはありません" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>要求事項</TH>
                    <TH>領域</TH>
                    <TH>対応状況</TH>
                    <TH>優先度</TH>
                    <TH>担当部署</TH>
                  </TR>
                </THead>
                <TBody>
                  {overview.topPriorities.map((view) => (
                    <TR key={view.item.id}>
                      <TD className="max-w-[280px]">
                        <Link
                          href={`/enterprise/disclosures/ssbj/requirements/${view.item.id}`}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          <span className="font-mono text-[11px]">{view.item.code}</span>{' '}
                          {view.item.questionText}
                        </Link>
                      </TD>
                      <TD>{AREA_LABEL[view.area]}</TD>
                      <TD>
                        <Badge tone={COVERAGE_TONE[view.combined]}>
                          <CircleAlert className="size-3" aria-hidden="true" />
                          {COVERAGE_LABEL[view.combined]}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge tone={view.priority.priority === 'high' ? 'danger' : 'warning'}>
                          {PRIORITY_LABEL[view.priority.priority]}
                        </Badge>
                      </TD>
                      <TD className="text-[11px]">{view.assessment.ownerDepartment || '未設定'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        {/* マテリアリティ評価（重要性判断の起点）。
            評価そのものは「①マテリアリティ・分析条件の設定」で行う。
            ここでは結果だけを見せ、決める場所を 1 つに寄せる */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="マテリアリティ評価"
            action={
              <Button variant="outline" size="xs" asChild>
                <Link href="/enterprise/disclosures/ssbj/settings">
                  <Target aria-hidden="true" />
                  評価・分析条件を設定する
                </Link>
              </Button>
            }
          />
          <div className="flex items-center gap-3 border-b border-line px-3 py-2">
            <span className="text-[12px] text-ink-muted">マテリアリティ充足度</span>
            <Progress
              value={materiality.overallCoverage}
              tone={rateTone(materiality.overallCoverage)}
              className="w-40"
              label={`マテリアリティ充足度 ${materiality.overallCoverage}%`}
            />
            <span className="text-[13px] font-semibold tabular-nums text-ink">
              {materiality.overallCoverage}%
            </span>
            <span className="text-[12px] text-ink-muted">
              重要と評価: {materiality.materialCount} トピック
            </span>
            {settings.assessedTopicCount < settings.totalTopicCount && (
              <Badge tone="warning">
                未評価 {settings.totalTopicCount - settings.assessedTopicCount} 件
              </Badge>
            )}
          </div>
          {materiality.topics.length === 0 ? (
            <EmptyState
              title="マテリアリティが未登録です"
              description="「①マテリアリティ・分析条件の設定」で、自社の重要課題を自由記述で登録してください。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/ssbj/settings">
                    <Target aria-hidden="true" />
                    登録しに行く
                  </Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  {/* マテリアリティ名 → 区分 → 項目 の階層で見せる */}
                  <TH>マテリアリティ</TH>
                  <TH>区分</TH>
                  <TH>項目（対象指標）</TH>
                  <TH>評価</TH>
                  <TH>充足度</TH>
                </TR>
              </THead>
              <TBody>
                {materiality.topics.map((topic) => (
                  <TR key={topic.id}>
                    <TD className="font-medium text-ink">
                      <div className="flex items-center gap-1.5">
                        <Target className="size-3.5 text-ink-muted" aria-hidden="true" />
                        {topic.title}
                      </div>
                      {topic.rationale && (
                        <p className="mt-0.5 text-[11px] text-ink-muted">{topic.rationale}</p>
                      )}
                    </TD>
                    <TD>{CATEGORY_LABEL[topic.category]}</TD>
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
                          <Progress
                            value={topic.coverage}
                            tone={rateTone(topic.coverage)}
                            className="w-16"
                            label={`${topic.title} の充足度 ${topic.coverage}%`}
                          />
                          <span className="text-[12px] tabular-nums">
                            {topic.coverage}%（{topic.collectedMetricCount}/{topic.totalMetricCount}
                            ）
                          </span>
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj/plans">
              <ClipboardList aria-hidden="true" />
              対応計画を管理する
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj/collection">
              <Database aria-hidden="true" />
              データ収集を管理する
            </Link>
          </Button>
        </div>

        {/* 正式基準を収録しているため、出所と転載許可を必ず明示する */}
        {!overview.isFixture && (
          <p className="text-[11px] leading-relaxed text-ink-muted">{overview.attribution}</p>
        )}
      </div>
    </>
  );
}
