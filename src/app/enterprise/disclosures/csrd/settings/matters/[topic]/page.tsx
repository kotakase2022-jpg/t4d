import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Banknote,
  CircleCheck,
  CircleDashed,
  Globe,
  HandHeart,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { DMA_AXIS_ASSESSMENT_LABEL, ESRS_TOPIC_LABEL } from '@/lib/domain/csrd';
import {
  IRO_TYPE_LABEL,
  TIME_HORIZON_LABEL,
  VALUE_CHAIN_STAGE_LABEL,
  type DmaAxisResult,
} from '@/lib/domain/dma';
import { formatJst } from '@/lib/format/datetime';
import { loadCsrdMatterDetail, type CsrdIroScoreView } from '@/lib/services/csrd/settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { DMA_AXIS_ASSESSMENTS, type DmaAxisAssessment, type IroType } from '@/types/domain';
import { DmaOutcomeBadge, ProvisionalBadge } from '../../../_components/csrd-badges';
import { IroForm } from '../../_components/iro-form';
import {
  decideCsrdDmaMatterAction,
  deleteCsrdDmaIroAction,
  upsertCsrdDmaIroAction,
} from '../../actions';
import { axisProposalLabel, axisProposalText, formatScore, iroInputSummary } from '../../dma-view';
import { EMPTY_IRO_FORM, iroFormValuesOf } from '../../iro-form-values';

export const metadata = { title: 'CSRD サステナビリティ事項の評価' };

const BASE = '/enterprise/disclosures/csrd';
const IRO_CREATE_ID = 'csrd-iro-create';

const IRO_TYPE_ICON: Record<IroType, typeof Globe> = {
  impact: Globe,
  risk: TriangleAlert,
  opportunity: Sparkles,
};

/** 1 つの観点の算定結果（提案） */
function AxisProposal({
  title,
  icon: Icon,
  axis,
  emptyNote,
}: {
  title: string;
  icon: typeof Globe;
  axis: DmaAxisResult;
  emptyNote: string;
}) {
  const label = axisProposalLabel(axis);
  return (
    <section
      aria-label={`${title}の算定結果`}
      className="space-y-1 rounded-t4d border border-line p-2.5"
    >
      <h3 className="flex items-center gap-1.5 text-small font-semibold text-ink">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        {title}
      </h3>
      <p className="text-figure-sm font-semibold tabular-nums text-ink">{axisProposalText(axis)}</p>
      <p className="text-caption text-ink-muted">
        {label === '評価材料なし'
          ? emptyNote
          : `提案: ${label}（最大スコア。IRO ${axis.iroCount} 件から算定）`}
      </p>
    </section>
  );
}

/** IRO の行の名前（行の操作の読み上げ名・確認ダイアログの題に使う） */
const iroName = (row: CsrdIroScoreView) => `IRO「${row.iro.description}」`;

const IRO_COLUMNS: DataTableColumn<CsrdIroScoreView>[] = [
  {
    key: 'type',
    header: '種類',
    importance: 'primary',
    cell: ({ iro }) => {
      const Icon = IRO_TYPE_ICON[iro.iroType];
      return (
        <Badge tone={iro.iroType === 'impact' ? 'brand' : 'outline'}>
          <Icon className="size-3" aria-hidden="true" />
          {IRO_TYPE_LABEL[iro.iroType]}
        </Badge>
      );
    },
  },
  {
    key: 'description',
    header: '内容',
    importance: 'primary',
    lockVisible: true,
    cell: ({ iro }) => (
      <span className="block max-w-[280px] text-small text-ink">
        {iro.description}
        {iro.subTopic && (
          <span className="block text-caption text-ink-muted">サブトピック: {iro.subTopic}</span>
        )}
      </span>
    ),
  },
  {
    key: 'stage',
    header: '段階・期間',
    importance: 'secondary',
    cell: ({ iro }) => (
      <span className="whitespace-nowrap text-caption">
        {VALUE_CHAIN_STAGE_LABEL[iro.valueChainStage]}
        <span className="block text-ink-muted">
          {iro.timeHorizon ? TIME_HORIZON_LABEL[iro.timeHorizon] : '期間 未設定'}
        </span>
      </span>
    ),
  },
  {
    key: 'input',
    header: '入力',
    importance: 'secondary',
    cell: ({ iro }) => (
      <span className="whitespace-nowrap text-caption">
        {iroInputSummary(iro)}
        {iro.humanRights && (
          <span className="mt-0.5 flex items-center gap-1 text-ink-muted">
            <HandHeart className="size-3" aria-hidden="true" />
            人権（深刻度で評価）
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'severity',
    header: '深刻度',
    importance: 'secondary',
    align: 'right',
    cell: ({ severity }) => (
      <span className="tabular-nums text-small">{formatScore(severity)}</span>
    ),
  },
  {
    key: 'score',
    header: 'スコア',
    importance: 'primary',
    align: 'right',
    cell: ({ iro, impactScore, financialScore }) => (
      <span className="tabular-nums text-small font-semibold">
        {formatScore(impactScore ?? financialScore)}
        <span className="block text-caption font-normal text-ink-muted">
          {iro.iroType === 'impact' ? 'インパクト' : '財務'}
        </span>
      </span>
    ),
  },
  {
    key: 'stakeholders',
    header: '影響を受ける人・関連',
    importance: 'detail',
    cell: ({ iro, relatedImpactDescription }) => (
      <span className="block max-w-[200px] text-caption text-ink-muted">
        {iro.affectedStakeholders || '—'}
        {relatedImpactDescription && (
          <span className="block">関連: {relatedImpactDescription}</span>
        )}
      </span>
    ),
  },
];

/**
 * サステナビリティ事項 1 件のダブル・マテリアリティ評価（docs/disclosure-first.md §9.4・plan S12）。
 * IRO（影響・リスク・機会）の一覧・追加・編集・削除（論理削除）と、観点ごとの人の判断。
 * 算定結果は自社の方法・閾値による提案で、重要性を決めるのは人（根拠が必須）。AI は書き込まない。
 * `[topic]` が ESRS のテーマでなければ 404。
 *
 * 主操作は「判断を保存」1 つ（人の判断がこの画面の仕事）。IRO の追加は secondary で CreatePanel（?new=1）、
 * 行の「操作 ▾」に 編集（?edit= で行の編集欄を開く）・削除…（論理削除。確認ダイアログを通す。plan §1.16）。
 */
export default async function CsrdMatterPage({
  params,
  searchParams,
}: {
  params: Promise<{ topic: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { topic } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const backLink = {
    kind: 'link' as const,
    id: 'back',
    label: '設定へ戻る',
    href: `${BASE}/settings?step=dma`,
    icon: <ArrowLeft aria-hidden="true" />,
  };

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader
          title="CSRD サステナビリティ事項"
          autoBreadcrumbs
          actions={<PageActions secondary={[backLink]} />}
        />
        <PermissionDeniedState
          description="CSRD の設定は、開示の閲覧権限を持つ利用者のみ閲覧できます。"
          permission="enterprise.disclosure.read"
        />
      </>
    );
  }

  const detail = await loadCsrdMatterDetail(db, ctx, shell.currentPeriod, topic);
  if (!detail) notFound();

  const { state, thresholds } = detail;
  const matter = state.matter;
  const topicName = `${state.topic} ${ESRS_TOPIC_LABEL[state.topic]}`;
  const matterPath = `${BASE}/settings/matters/${state.topic}`;
  const editing = typeof query.edit === 'string' ? query.edit : null;
  const rowActionsOf = (row: CsrdIroScoreView) => {
    const items: MenuActionSpec[] = [
      {
        kind: 'link',
        id: `edit-${row.iro.id}`,
        label: '編集',
        href: `${matterPath}?edit=${row.iro.id}#iro-edit-${row.iro.id}`,
        icon: <Pencil aria-hidden="true" />,
      },
      {
        kind: 'confirm',
        id: `delete-${row.iro.id}`,
        label: '削除',
        destructive: true,
        icon: <Trash2 aria-hidden="true" />,
        action: deleteCsrdDmaIroAction,
        fields: { iroId: row.iro.id, topic: state.topic },
        confirm: {
          tier: 'irreversible',
          title: `${iroName(row)}を削除しますか`,
          scope: `${topicName} の${IRO_TYPE_LABEL[row.iro.iroType]}「${row.iro.description}」`,
          consequences: [
            '論理削除です（履歴は残り、算定からは外れます）。',
            'DMA を確定していた場合は、確定を取り消します。人の判断は変わりません。',
          ],
          confirmLabel: '削除する',
          destructive: true,
        },
      },
    ];
    return { rowLabel: iroName(row), items };
  };

  return (
    <>
      <PageHeader
        title={`${topicName}（ダブル・マテリアリティ評価）`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {shell.currentPeriod.label} ／ {detail.scoringMethodLabel}
            </span>
            <span className="flex items-center gap-1">
              人の判断:
              <DmaOutcomeBadge outcome={state.outcome} />
            </span>
            {detail.dmaConfirmed ? (
              <Badge tone="success">
                <CircleCheck className="size-3" aria-hidden="true" />
                DMA 確定済み
              </Badge>
            ) : (
              <ProvisionalBadge />
            )}
          </span>
        }
        breadcrumbsTail={[
          { label: '設定（報告範囲・DMA）', href: `${BASE}/settings?step=dma` },
          { label: state.topic },
        ]}
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'add-iro',
                label: 'IRO を追加',
                href: `${createPanelHref(matterPath, query, { open: true })}#${IRO_CREATE_ID}`,
                icon: <Plus aria-hidden="true" />,
                hidden: !detail.canEdit,
              },
              backLink,
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <Section
          title="算定結果（提案・自社の方法と閾値）"
          actions={
            <span className="flex items-center gap-1 text-caption text-ink-muted">
              提案
              <DmaOutcomeBadge outcome={state.proposedOutcome} />
            </span>
          }
          bodyClassName="space-y-2"
        >
          <div className="grid grid-cols-2 gap-2">
            <AxisProposal
              title="インパクト重要性"
              icon={Globe}
              axis={state.axes.impact}
              emptyNote="インパクトの IRO がありません（評価材料なし）。"
            />
            <AxisProposal
              title="財務的重要性"
              icon={Banknote}
              axis={state.axes.financial}
              emptyNote="リスク・機会の IRO がありません（評価材料なし）。"
            />
          </div>
          <p className="text-caption text-ink-muted">
            閾値はインパクト {formatScore(thresholds.impactThreshold)}・財務{' '}
            {formatScore(thresholds.financialThreshold)}（自社の評価方法・デモ既定。ESRS
            は数値の閾値を定めていません）。算定結果は提案で、重要性は下の「人の判断」で決めます。
          </p>
        </Section>

        <Section
          id="csrd-matter-iros"
          title={`IRO（影響・リスク・機会）（${detail.iros.length} 件）`}
          bodyClassName="space-y-2"
        >
          {detail.canEdit && (
            <CreatePanel
              id={IRO_CREATE_ID}
              title="IRO を追加する"
              searchParams={query}
              closeHref={createPanelHref(matterPath, query, { open: false })}
              description="先に種類（インパクト／リスク・機会）を選ぶと、その種類で必要な欄だけが出ます。"
            >
              <IroForm
                action={upsertCsrdDmaIroAction}
                reportingPeriodId={shell.currentPeriod.id}
                topic={state.topic}
                initial={EMPTY_IRO_FORM}
                impactIroOptions={detail.impactIroOptions}
                submitLabel="IRO を追加"
              />
            </CreatePanel>
          )}
          <DataTable<CsrdIroScoreView>
            id="csrd-matter-iros"
            caption={`${topicName} の IRO`}
            columns={IRO_COLUMNS}
            rows={detail.iros}
            getRowId={(row) => row.iro.id}
            getRowLabel={iroName}
            searchParams={query}
            basePath={matterPath}
            search={false}
            rowActions={detail.canEdit ? rowActionsOf : undefined}
            empty={{
              noData: {
                title: 'IRO が登録されていません',
                description: 'インパクトとリスク・機会を登録すると、算定結果（提案）が出ます。',
                action: detail.canEdit ? (
                  <Link
                    href={`${createPanelHref(matterPath, query, { open: true })}#${IRO_CREATE_ID}`}
                    className="text-small text-brand-700 underline"
                  >
                    最初の IRO を追加する
                  </Link>
                ) : (
                  <span className="text-small text-ink-muted">
                    IRO の登録には開示対応の編集権限が必要です。
                  </span>
                ),
              },
            }}
          />
          {/* 編集欄は表の外に置く（行の中で開くと表の幅が崩れる）。行の「操作 ▾ → 編集」で開いて描く */}
          {detail.canEdit &&
            detail.iros.map(({ iro }) => (
              <Collapsible
                key={`edit-${iro.id}`}
                id={`iro-edit-${iro.id}`}
                variant="plain"
                open={editing === iro.id ? true : undefined}
                summary={`${IRO_TYPE_LABEL[iro.iroType]}「${iro.description}」を編集`}
              >
                <IroForm
                  action={upsertCsrdDmaIroAction}
                  reportingPeriodId={shell.currentPeriod.id}
                  topic={state.topic}
                  initial={iroFormValuesOf(iro)}
                  impactIroOptions={detail.impactIroOptions.filter(
                    (option) => option.id !== iro.id,
                  )}
                  submitLabel="IRO を更新"
                />
              </Collapsible>
            ))}
          {detail.canEdit && (
            <MoreInfo label="削除の扱い">
              <p>削除は論理削除です（履歴は残り、算定からは外れます）。</p>
            </MoreInfo>
          )}
        </Section>

        <Section
          id="csrd-matter-decision"
          title="人の判断"
          actions={
            matter.decidedAt ? (
              <span className="flex items-center gap-1 text-caption text-ink-muted">
                <UserCheck className="size-3" aria-hidden="true" />
                {detail.decidedByName ?? '担当者'} ・ {formatJst(matter.decidedAt)}
              </span>
            ) : (
              <Badge tone="warning">
                <CircleDashed className="size-3" aria-hidden="true" />
                未判断
              </Badge>
            )
          }
        >
          {detail.canEdit ? (
            <PreservingForm action={decideCsrdDmaMatterAction} className="space-y-3">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              <input type="hidden" name="topic" value={state.topic} />
              <div className="grid grid-cols-2 gap-3">
                <AxisDecision
                  name="impact"
                  title="インパクト重要性（人・環境への影響）"
                  icon={Globe}
                  current={matter.impactAssessment}
                  rationale={matter.impactRationale}
                  proposal={`${axisProposalText(state.axes.impact)}（${axisProposalLabel(state.axes.impact)}）`}
                />
                <AxisDecision
                  name="financial"
                  title="財務的重要性（企業へのリスク・機会）"
                  icon={Banknote}
                  current={matter.financialAssessment}
                  rationale={matter.financialRationale}
                  proposal={`${axisProposalText(state.axes.financial)}（${axisProposalLabel(state.axes.financial)}）`}
                />
              </div>
              <label className="block space-y-1 text-small text-ink">
                <span className="block font-medium">ステークホルダーの意見（任意）</span>
                <Textarea name="stakeholderNote" rows={2} defaultValue={matter.stakeholderNote} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton
                  variant="primary"
                  size="sm"
                  icon={<UserCheck aria-hidden="true" />}
                  pendingLabel="保存中…"
                >
                  判断を保存
                </SubmitButton>
                {/* AI は判断しないことは常に見せる。確定の取り消しは、取り消す確定があるときだけ書く */}
                <span className="text-caption text-ink-muted">
                  AI は判断しません。
                  {detail.dmaConfirmed && '保存すると DMA の確定は取り消されます。'}
                </span>
              </div>
              <MoreInfo label="判断の決まり">
                <p>
                  重要／重要でないと評価した観点は根拠が必須です。算定結果（提案）と違う判断もできます（根拠を残してください）。
                </p>
                <p>判断を保存すると、確定済みの DMA は確定が取り消されます。</p>
              </MoreInfo>
            </PreservingForm>
          ) : (
            <div className="space-y-2">
              <dl className="grid grid-cols-2 gap-3 text-small">
                <div>
                  <dt className="text-caption text-ink-muted">インパクト重要性</dt>
                  <dd className="text-ink">
                    {DMA_AXIS_ASSESSMENT_LABEL[matter.impactAssessment]}
                    {matter.impactRationale && (
                      <span className="block text-caption text-ink-muted">
                        {matter.impactRationale}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-ink-muted">財務的重要性</dt>
                  <dd className="text-ink">
                    {DMA_AXIS_ASSESSMENT_LABEL[matter.financialAssessment]}
                    {matter.financialRationale && (
                      <span className="block text-caption text-ink-muted">
                        {matter.financialRationale}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-caption text-ink-muted">
                判断を変えるには開示対応の編集権限が必要です。
              </p>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

/** 1 つの観点の判断（重要／重要でない／未評価＋根拠）。算定結果（提案）を横に示す */
function AxisDecision({
  name,
  title,
  icon: Icon,
  current,
  rationale,
  proposal,
}: {
  name: 'impact' | 'financial';
  title: string;
  icon: typeof Globe;
  current: DmaAxisAssessment;
  rationale: string;
  proposal: string;
}) {
  return (
    <fieldset className="space-y-1.5 rounded-t4d border border-line p-2.5">
      <legend className="flex items-center gap-1.5 px-1 text-small font-semibold text-ink">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        {title}
      </legend>
      <p className="text-caption text-ink-muted">算定結果（提案）: {proposal}</p>
      <div className="flex flex-wrap gap-3">
        {DMA_AXIS_ASSESSMENTS.map((value) => (
          <label key={value} className="flex items-center gap-1 text-small text-ink">
            <input
              type="radio"
              name={`${name}Assessment`}
              value={value}
              defaultChecked={current === value}
              className="accent-brand-700"
            />
            {DMA_AXIS_ASSESSMENT_LABEL[value]}
          </label>
        ))}
      </div>
      <label className="block space-y-1 text-caption text-ink-muted">
        <span className="block">根拠（重要／重要でないを選んだときは必須）</span>
        {/* 「重要」「重要でない」を選んだときだけ必須にする（送る前にブラウザが止める。最終の検査はサーバー） */}
        <Textarea
          name={`${name}Rationale`}
          rows={3}
          defaultValue={rationale}
          maxLength={600}
          data-required-if={`${name}Assessment=material|not_material`}
        />
      </label>
    </fieldset>
  );
}
