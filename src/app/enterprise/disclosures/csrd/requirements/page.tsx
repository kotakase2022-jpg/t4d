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
import { FilterBar, type FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import { COVERAGE_LABEL, COVERAGE_TONE, PRIORITY_LABEL } from '@/lib/domain/ssbj';
import {
  filterCsrdRequirements,
  loadCsrdRequirementViews,
  type CsrdRequirementView,
} from '@/lib/services/csrd/requirements';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { SsbjCoverageStatus } from '@/types/domain';
import {
  ApplicabilityBadge,
  PerspectiveBadges,
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

/** 3 観点の 1 セル（評価行が無ければ未確認） */
function CoverageCell({ status }: { status: SsbjCoverageStatus }) {
  return <Badge tone={COVERAGE_TONE[status]}>{COVERAGE_LABEL[status]}</Badge>;
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
              {loaded.versionLabel} ／ {shell.currentPeriod.label} ／
              ダブル・マテリアリティで決めた適用に沿って、3 観点で評価します
            </span>
            {loaded.isFixture && <SampleMasterBadge />}
          </span>
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

        {/* 件数の流れ。「なぜこの件数なのか」を画面上で検算できるようにする */}
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
          <span className="rounded-t4d border border-line bg-surface px-2 py-1">
            サンプル（架空）マスター <strong className="tabular-nums">{loaded.masterTotal}</strong>{' '}
            項目
          </span>
          <span aria-hidden="true">→</span>
          <span className="rounded-t4d border border-line bg-surface px-2 py-1">
            ESRS 2（常に適用） <strong className="tabular-nums">{count('always')}</strong>{' '}
            件・重要と判断 <strong className="tabular-nums">{count('material')}</strong> 件
          </span>
          <span aria-hidden="true">→</span>
          <span className="rounded-t4d border border-line bg-surface px-2 py-1">
            対象外 <strong className="tabular-nums">{count('not_material')}</strong> 件・未判定{' '}
            <strong className="tabular-nums">{count('undetermined')}</strong> 件を除外
          </span>
          <span aria-hidden="true">→</span>
          <span className="rounded-t4d border border-brand-300 bg-brand-50 px-2 py-1 font-medium text-brand-800">
            評価対象 <strong className="tabular-nums">{inScope}</strong> / {loaded.views.length} 件
          </span>
        </div>

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
          <SectionTitle
            title={`要求事項（${filtered.length} / ${loaded.views.length} 件）`}
            action={
              <span className="text-[11px] text-ink-muted">
                コードを選ぶと、適用の根拠・3 観点・AI の候補・対応計画・回答への導線を確認できます
              </span>
            }
          />
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
                            <Badge
                              tone={
                                view.priority.priority === 'high'
                                  ? 'danger'
                                  : view.priority.priority === 'medium'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {PRIORITY_LABEL[view.priority.priority]}
                            </Badge>
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
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            3 観点・総合は担当者が確定した値です（AI の候補は「AI
            の候補」列に分けて表示し、確定値には入れません）。
            優先度は評価対象（常に適用・重要）だけに付けます。収録は ESRS の架空の縮小サンプル{' '}
            {loaded.masterTotal} 項目で、正式な ESRS の全量ではありません。
          </p>
        </Card>
      </div>
    </>
  );
}
