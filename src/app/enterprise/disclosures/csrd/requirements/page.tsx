import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleDashed,
  ClipboardList,
  Settings2,
  UserCheck,
} from 'lucide-react';
import { FunnelSteps } from '@/components/charts/funnel-steps';
import { FilterBar, type FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import {
  filterCsrdRequirements,
  loadCsrdRequirementViews,
  type CsrdRequirementView,
} from '@/lib/services/csrd/requirements';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { SsbjCoverageStatus } from '@/types/domain';
import {
  ApplicabilityBadge,
  CoverageStatusBadge,
  PerspectiveBadges,
  PlanPriorityBadge,
  SampleMasterBadge,
} from '../_components/csrd-badges';
import { DoubleMaterialityNote } from '../settings/_components/materiality-note';
import {
  CSRD_OPEN_HIGH_PRIORITY_QUERY,
  CSRD_REQUIREMENTS_PATH,
  parseRequirementQuery,
  searchCsrdRequirements,
} from './form-input';

export const metadata = { title: 'CSRD 要求事項の評価' };

const BASE = '/enterprise/disclosures/csrd';

/** 3 観点の 1 セル（評価行が無ければ未確認）。ラベルとアイコンを併記する（色だけで表さない） */
function CoverageCell({ status }: { status: SsbjCoverageStatus }) {
  return <CoverageStatusBadge status={status} />;
}

/** 担当者の確認の状態。AI の候補の後に人が確認していなければ「確認待ち」 */
function ReviewCell({ view }: { view: CsrdRequirementView }) {
  if (view.awaitingReview) {
    return (
      <Badge tone="warning">
        <CircleAlert className="size-3" aria-hidden="true" />
        確認待ち
      </Badge>
    );
  }
  if (view.reviewState === 'human') {
    return (
      <Badge tone="success">
        <UserCheck className="size-3" aria-hidden="true" />
        確認済み
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <CircleDashed className="size-3" aria-hidden="true" />
      未確認
    </Badge>
  );
}

/**
 * CSRD 要求事項の評価（docs/disclosure-first.md §9.4）。12 行。
 * 適用は DMA（人の判断）から導出し、どの観点（インパクト・財務）で適用になったかを行ごとに示す。
 * DMA が未確定の間は「暫定（DMA 確定前）」を併記する。AI ギャップ分析は詳細で 1 件ずつ（候補）。
 *
 * 文字量を減らす（§10.4）: 件数の流れは図（FunnelSteps）、画面の使い方は「この画面について」、
 * SSBJ との違いは 1 行（未発効の注記を含む）＋閉じた全文。DMA 未確定の注記・表・架空の縮小サンプルは常に見せる。
 */
export default async function CsrdRequirementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const breadcrumbs = [
    { label: '企業ワークスペース' },
    { label: '開示対応' },
    { label: 'CSRD', href: BASE },
    { label: '要求事項の評価' },
  ];
  const backButton = (
    <Button variant="outline" size="sm" asChild>
      <Link href={BASE}>
        <ArrowLeft aria-hidden="true" />
        対応状況へ戻る
      </Link>
    </Button>
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 要求事項の評価" breadcrumbs={breadcrumbs} actions={backButton} />
        <PermissionDeniedState description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
      </>
    );
  }

  const loaded = await loadCsrdRequirementViews(db, ctx, shell.currentPeriod);
  if (!loaded) {
    return (
      <>
        <PageHeader title="CSRD 要求事項の評価" breadcrumbs={breadcrumbs} actions={backButton} />
        <div className="p-4">
          <EmptyState title="ESRS 項目マスターが登録されていません" />
        </div>
      </>
    );
  }

  const { filters, q } = parseRequirementQuery(query);
  const filtered = searchCsrdRequirements(filterCsrdRequirements(loaded.views, filters), q);
  const count = (kind: CsrdRequirementView['applicability']['kind']) =>
    loaded.views.filter((v) => v.applicability.kind === kind).length;
  const inScope = count('always') + count('material');
  const provisional = loaded.views.filter((v) => v.applicability.provisional).length;

  const groups: FilterGroup[] = [
    {
      key: 'applicability',
      label: '適用',
      options: [
        { value: 'always', label: 'ESRS 2（常に適用）' },
        { value: 'material', label: '適用（重要）' },
        { value: 'not_material', label: '対象外' },
        { value: 'undetermined', label: '未判定' },
      ],
    },
    {
      key: 'perspective',
      label: '観点',
      options: [
        { value: 'impact', label: 'インパクト' },
        { value: 'financial', label: '財務' },
      ],
    },
    {
      key: 'coverage',
      label: '総合',
      options: [
        { value: 'covered', label: '対応済み' },
        { value: 'mostly_covered', label: 'おおむね対応' },
        { value: 'partial', label: '一部対応' },
        { value: 'not_covered', label: '未対応' },
        { value: 'unconfirmed', label: '未確認' },
      ],
    },
    {
      key: 'priority',
      label: '優先度',
      options: [
        { value: 'high', label: '高' },
        { value: 'medium', label: '中' },
        { value: 'low', label: '低' },
      ],
    },
    {
      key: 'review',
      label: '確認',
      options: [{ value: 'awaiting', label: '確認待ち（AI 候補あり）' }],
    },
  ];

  return (
    <>
      <PageHeader
        title="CSRD 要求事項の評価"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {loaded.versionLabel} ／ {shell.currentPeriod.label} ／ DMA で決めた適用を 3
              観点で評価
            </span>
            {loaded.isFixture && <SampleMasterBadge />}
          </span>
        }
        help={
          <>
            <p>
              ダブル・マテリアリティ評価（DMA）で決めた適用に沿って、開示・データ・業務プロセスの 3
              観点で評価します。
            </p>
            <p>
              コードを選ぶと、適用の根拠・3 観点・AI
              の候補・対応計画・回答への導線を確認できます。優先度は評価対象（常に適用・重要）だけに付けます。
            </p>
          </>
        }
        breadcrumbs={breadcrumbs}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild>
              <Link href={`${BASE}/settings`}>
                <Settings2 aria-hidden="true" />
                設定（DMA）
              </Link>
            </Button>
            {backButton}
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {!loaded.dmaConfirmed && (
          <p
            role="note"
            className="flex flex-wrap items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink"
          >
            <CircleAlert className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
            ダブル・マテリアリティ評価（DMA）が未確定のため、テーマ別の要求事項の適用は暫定です（
            {provisional} / {loaded.views.length} 件）。
            <Link href={`${BASE}/settings`} className="text-brand-800 underline">
              設定で事項を判断して確定する
            </Link>
          </p>
        )}

        <DoubleMaterialityNote compact />

        {/* 件数の流れ。「なぜこの件数なのか」を画面上で検算できるようにする（段ごとの内訳は閉じた説明に） */}
        <Card className="max-w-2xl space-y-1.5 p-3">
          <FunnelSteps
            label="評価対象の件数の流れ"
            steps={[
              { label: 'サンプル（架空）マスター', count: loaded.masterTotal, unit: '項目' },
              { label: '未判定を除く', count: loaded.views.length - count('undetermined') },
              {
                label: '対象外を除く（評価対象）',
                count: inScope,
                href: `${CSRD_REQUIREMENTS_PATH}?applicability=always&applicability=material`,
              },
            ]}
          />
          <MoreInfo label="件数の内訳">
            <p>
              評価対象 {inScope} / {loaded.views.length} 件 ＝ ESRS 2（常に適用）{count('always')}{' '}
              件＋重要と判断 {count('material')} 件。対象外 {count('not_material')} 件・未判定{' '}
              {count('undetermined')} 件は評価対象から除きます。
            </p>
          </MoreInfo>
        </Card>

        <FilterBar
          groups={groups}
          searchPlaceholder="要求事項コード・見出しで検索"
          total={filtered.length}
          savedViews={[
            {
              label: '評価対象のみ',
              query: 'applicability=always&applicability=material',
              description: '常に適用・重要と判断した事項の要求事項',
            },
            {
              label: '確認待ち',
              query: 'review=awaiting',
              description: 'AI の候補を担当者が確認していない要求事項',
            },
            {
              label: '優先度「高」（評価対象・未対応）',
              query: CSRD_OPEN_HIGH_PRIORITY_QUERY,
              description: '初年度対応を優先する項目（対応済みを除く）',
            },
            {
              label: '財務の観点で適用',
              query: 'perspective=financial',
              description: '財務的重要性で重要と判断した事項の要求事項',
            },
          ]}
        />

        <Card className="overflow-hidden">
          {/* コードの行き先の説明は「この画面について」に置く（§10.4） */}
          <SectionTitle title={`要求事項（${filtered.length} / ${loaded.views.length} 件）`} />
          {filtered.length === 0 ? (
            <EmptyState
              title="該当する要求事項がありません"
              description="絞り込み条件を変更してください。"
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label="CSRD 要求事項の評価" className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>要求事項</TH>
                    <TH>節</TH>
                    <TH>適用</TH>
                    <TH>適用になった観点</TH>
                    <TH>開示</TH>
                    <TH>データ</TH>
                    <TH>業務プロセス</TH>
                    <TH>総合</TH>
                    <TH>優先度</TH>
                    <TH>AI の候補</TH>
                    <TH>担当者の確認</TH>
                  </TR>
                </THead>
                <TBody>
                  {filtered.map((view) => {
                    const a = view.assessment;
                    return (
                      <TR key={view.item.id}>
                        <TD className="max-w-[300px]">
                          <Link
                            href={`${CSRD_REQUIREMENTS_PATH}/${view.item.id}`}
                            className="font-medium text-brand-700 underline-offset-2 hover:underline"
                          >
                            <span className="font-mono text-[11px]">{view.item.code}</span>{' '}
                            {view.item.questionText}
                          </Link>
                          {view.plans.length > 0 && (
                            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                              <ClipboardList className="size-3" aria-hidden="true" />
                              対応計画 {view.plans.length} 件
                            </span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-[11px]">
                          {view.section ? CSRD_SECTION_LABEL[view.section] : '判定できない'}
                        </TD>
                        <TD>
                          <ApplicabilityBadge applicability={view.applicability} />
                        </TD>
                        <TD>
                          {view.applicability.kind === 'material' ? (
                            <PerspectiveBadges perspectives={view.applicability.perspectives} />
                          ) : (
                            <span className="text-[11px] text-ink-muted">
                              {view.applicability.kind === 'always' ? '重要性に関わらず' : '—'}
                            </span>
                          )}
                        </TD>
                        <TD>
                          <CoverageCell status={a?.disclosureStatus ?? 'unconfirmed'} />
                        </TD>
                        <TD>
                          <CoverageCell status={a?.dataStatus ?? 'unconfirmed'} />
                        </TD>
                        <TD>
                          <CoverageCell status={a?.processStatus ?? 'unconfirmed'} />
                        </TD>
                        <TD>
                          <CoverageCell status={view.combined} />
                        </TD>
                        <TD>
                          {view.priority ? (
                            <PlanPriorityBadge priority={view.priority.priority} />
                          ) : (
                            <span className="text-[11px] text-ink-muted">評価対象外</span>
                          )}
                        </TD>
                        <TD>
                          {a?.aiStatus ? (
                            <span className="flex items-center gap-1 whitespace-nowrap text-[12px]">
                              <Bot className="size-3 text-ink-muted" aria-hidden="true" />
                              {COVERAGE_LABEL[a.aiStatus]}
                            </span>
                          ) : (
                            <span className="text-[11px] text-ink-muted">未実施</span>
                          )}
                        </TD>
                        <TD>
                          <ReviewCell view={view} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
          {/* AI は候補・確定は人、架空の縮小サンプルであることは閉じずに見せる */}
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            3 観点・総合は担当者が確定した値です（AI の候補は「AI
            の候補」列に分け、確定値には入れません）。収録は ESRS の架空の縮小サンプル{' '}
            {loaded.masterTotal} 項目で、正式な ESRS の全量ではありません。
          </p>
        </Card>
      </div>
    </>
  );
}
