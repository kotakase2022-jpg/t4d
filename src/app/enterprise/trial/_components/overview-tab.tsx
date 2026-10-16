import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { backupResidualLabel } from '@/lib/domain/data-disposal';
import { ACTIVITY_KIND_LABELS, GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import type { SiteStatus } from '@/lib/domain/ghg/verification-status';
import {
  reductionTargetLabel,
  TRIAL_AGREEMENT_LABELS,
  TRIAL_DECISION_LABELS,
  TRIAL_END_DISPOSITION_LABELS,
  TRIAL_PHASE_LABELS,
} from '@/lib/domain/trial-metrics';
import { parseTrialOptions } from '@/lib/domain/trial-options';
import {
  SCOPE_OVER_NOTICE,
  signalCountLabel,
  STANDARD_SCOPE_ITEMS,
  STANDARD_SCOPE_NOTE,
} from '@/lib/domain/trial-scope';
import { formatJstDate } from '@/lib/format/datetime';
import {
  PLANNED_KEYS,
  PLANNED_LABELS,
  type TrialFormChoices,
  type TrialOverview,
  type TrialScopeOverview,
  type TrialTextLimits,
} from '@/lib/services/trial-program';
import {
  GHG_ACTIVITY_KINDS,
  GHG_SCOPES,
  TRIAL_AGREEMENT_KEYS,
  TRIAL_DECISIONS,
  TRIAL_END_DISPOSITIONS,
  TRIAL_PHASES,
  type TrialProgram,
} from '@/types/domain';
import { saveTrialCasesAction, saveTrialDecisionAction, saveTrialPlanAction } from '../actions';
import { TRIAL_BASE, trialHref } from '../_lib/tabs';

type Params = Record<string, string | string[] | undefined>;

const linkClass = 'text-small text-brand-700 hover:underline';

/**
 * 概要（NF-32・NF-37 の合計）: 計画と実績を分母付きで並べ、超過は止めずに知らせる。
 * 選定ケース・開始前の合意・終了時の扱いと導入判断（人が入力）。編集は管理者だけ（作成・編集の欄）。
 */
export function OverviewTab({
  overview,
  choices,
  params,
  canManage,
  limits,
}: {
  overview: TrialOverview;
  choices: TrialFormChoices | null;
  params: Params;
  canManage: boolean;
  limits: TrialTextLimits;
}) {
  const { program } = overview;
  const closeHref = createPanelHref(TRIAL_BASE, params, { open: false, openParam: 'edit' });

  const planPanel = canManage && choices && (
    <CreatePanel
      id="trial-plan-panel"
      title={program ? '計画を編集' : '計画を作成'}
      openParam="edit"
      searchParams={params}
      closeHref={closeHref}
      description="計画値は目安です。実績が計画を超えても記録・操作は止めません。"
    >
      <PlanForm program={program} choices={choices} limits={limits} />
    </CreatePanel>
  );

  if (!program) {
    return (
      <div className="space-y-3">
        {planPanel}
        <EmptyState
          kind="no-data"
          title="トライアルの計画がまだありません"
          description="期間・対象・利用枠・選定ケースを登録すると、記録から数えた実績と並べて確かめられます。"
          icon={<ClipboardList className="size-5" aria-hidden="true" />}
          action={
            canManage ? (
              <Link href={trialHref('overview', { edit: '1' })} className={linkClass}>
                計画を作成
              </Link>
            ) : (
              <Link href={trialHref('scenarios')} className={linkClass}>
                検証シナリオを見る
              </Link>
            )
          }
        />
      </div>
    );
  }

  const casesPanel = canManage && choices && (
    <CreatePanel
      id="trial-cases-panel"
      title="選定ケースを編集"
      openParam="cases"
      searchParams={params}
      closeHref={createPanelHref(TRIAL_BASE, params, { open: false, openParam: 'cases' })}
      description="選定ケースは追跡率（評価のトレーサビリティ）と判定の分母になります。対象プロジェクトの基準の要求事項から選びます。"
    >
      <CasesForm program={program} choices={choices} />
    </CreatePanel>
  );

  const decisionPanel = canManage && (
    <CreatePanel
      id="trial-decision-panel"
      title="合意・終了時の扱い・導入判断を記録"
      openParam="decision"
      searchParams={params}
      closeHref={createPanelHref(TRIAL_BASE, params, { open: false, openParam: 'decision' })}
      description="判断は人が入力します（AI は関与しません）。"
    >
      <DecisionForm program={program} limits={limits} />
    </CreatePanel>
  );

  const cdpTile = (
    <MetricTile
      label="CDP オプション"
      value={<StatusBadge domain="cdpOption" value={overview.cdp.state} />}
      hint={
        overview.cdp.planned === null
          ? '計画: 未設定'
          : `計画: ${overview.cdp.planned ? '含める' : '含めない'}${
              overview.cdp.differs ? '（契約の状態と異なります）' : ''
            }`
      }
      status={overview.cdp.differs ? { semantic: 'blocked', label: '計画と異なる' } : undefined}
    />
  );

  return (
    <div className="space-y-3">
      {planPanel}
      {casesPanel}
      {decisionPanel}

      <Section title="計画" divider="none">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
          <dt className="text-ink-muted">名前</dt>
          <dd className="font-medium text-ink">{program.name}</dd>
          <dt className="text-ink-muted">段階</dt>
          <dd>
            <SemanticBadge
              semantic={program.phase === 'closed' ? 'done' : 'in_review'}
              label={TRIAL_PHASE_LABELS[program.phase]}
            />
          </dd>
          <dt className="text-ink-muted">期間</dt>
          <dd>
            {program.startsOn ? formatJstDate(program.startsOn) : '未設定'} 〜{' '}
            {program.endsOn ? formatJstDate(program.endsOn) : '未設定'}
          </dd>
          <dt className="text-ink-muted">対象プロジェクト</dt>
          <dd>
            {overview.project ? (
              <Link
                href={`/enterprise/disclosure-projects/${overview.project.id}`}
                className={linkClass}
              >
                {overview.project.name}
              </Link>
            ) : (
              '未設定'
            )}
          </dd>
          <dt className="text-ink-muted">対象データ</dt>
          <dd className="whitespace-pre-wrap">{program.targetDataNote || '—'}</dd>
          <dt className="text-ink-muted">作業時間の目標</dt>
          <dd>{reductionTargetLabel(overview.reductionTarget)}</dd>
          {overview.scope && <PlanScopeRows scope={overview.scope} />}
        </dl>
      </Section>

      <Section
        title="計画と実績"
        summary="実績は記録から毎回数えます（保存しません）"
        divider="top"
      >
        {overview.overages.length > 0 && (
          <Notice tone="warning" title="計画を超えている項目があります（操作は止めません）">
            {overview.overages
              .map((row) => `${row.label} ${row.actual} / 計画 ${row.planned}`)
              .join('、')}
            。合意した対象範囲・利用枠を確かめてください。
          </Notice>
        )}
        <MetricStrip label="計画値と実績の件数">
          {overview.rows.map((row) => (
            <MetricTile
              key={row.key}
              label={row.label}
              value={row.actual === null ? '—' : row.actual}
              denominator={row.planned === null ? undefined : `計画 ${row.planned}`}
              status={row.over ? { semantic: 'blocked', label: '計画超過' } : undefined}
              hint={row.hint}
            />
          ))}
          {cdpTile}
        </MetricStrip>
      </Section>

      {overview.scope && (
        <>
          <VerificationSection scope={overview.scope} canManage={canManage} />
          <FreeScopeSection scope={overview.scope} canManage={canManage} />
        </>
      )}

      <Section
        title={`選定ケース（要求事項 ${overview.selectedRequirements.length} 件）`}
        summary="追跡率と評価の分母"
        actions={
          canManage ? (
            <Link href={trialHref('overview', { cases: '1' })} className={linkClass}>
              選定ケースを編集
            </Link>
          ) : undefined
        }
      >
        {overview.selectedRequirements.length === 0 ? (
          <EmptyState
            kind={canManage ? 'no-data' : 'not-applicable'}
            size="compact"
            title="選定ケースはまだありません"
            description="評価に使う要求事項の集合です。管理者が対象プロジェクトの要求事項から選びます。"
            action={
              canManage ? (
                <Link href={trialHref('overview', { cases: '1' })} className={linkClass}>
                  選定ケースを編集
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="t4d-scroll-x rounded-t4d border border-line">
            <Table>
              <caption className="sr-only">選定ケース</caption>
              <THead>
                <TR>
                  <TH>コード</TH>
                  <TH>要求事項</TH>
                  <TH>基準</TH>
                </TR>
              </THead>
              <TBody>
                {overview.selectedRequirements.map((item) => (
                  <TR key={item.id} data-t4d-record="">
                    <TD className="whitespace-nowrap font-medium">{item.code}</TD>
                    <TD className="text-small">{item.title}</TD>
                    <TD className="text-small">
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {item.frameworkLabel}
                        {item.isSample && <HonestyBadge kind="sample-master" />}
                        {item.outsideProject && (
                          <SemanticBadge semantic="blocked" label="対象プロジェクトの基準に無い" />
                        )}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        {overview.selectedMetrics.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-small font-medium text-ink">
              選定した指標（{overview.selectedMetrics.length}）
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {overview.selectedMetrics.map((metric) => (
                <li key={metric.id} className="inline-flex items-center gap-1 text-small">
                  {metric.name}
                  <SemanticBadge
                    semantic={metric.hasData ? 'done' : 'todo'}
                    label={metric.hasData ? 'データあり' : 'データなし'}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section
        title="開始前の合意と、終了時の扱い・導入判断"
        summary="人が入力した判断（AI は関与しません）"
        actions={
          canManage ? (
            <Link href={trialHref('overview', { decision: '1' })} className={linkClass}>
              判断を記録
            </Link>
          ) : undefined
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
            {TRIAL_AGREEMENT_KEYS.map((key) => {
              const agreement = program.agreements[key];
              return (
                <div key={key} className="contents">
                  <dt className="text-ink-muted">{TRIAL_AGREEMENT_LABELS[key]}</dt>
                  <dd className="space-y-0.5">
                    {agreement?.agreedOn ? (
                      <SemanticBadge
                        semantic="done"
                        label={`合意済み（${formatJstDate(agreement.agreedOn)}）`}
                      />
                    ) : (
                      <SemanticBadge semantic="todo" label="未合意" />
                    )}
                    {agreement?.note && <p className="text-ink">{agreement.note}</p>}
                  </dd>
                </div>
              );
            })}
          </dl>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
            <dt className="text-ink-muted">終了時の扱い</dt>
            <dd>
              {TRIAL_END_DISPOSITION_LABELS[program.endDisposition]}
              {program.endAgreedOn && `（合意 ${formatJstDate(program.endAgreedOn)}）`}
            </dd>
            {overview.scope && (
              <DisposalRows scope={overview.scope} disposition={program.endDisposition} />
            )}
            <dt className="text-ink-muted">導入判断</dt>
            <dd>
              <SemanticBadge
                semantic={program.decision === 'undecided' ? 'todo' : 'done'}
                label={TRIAL_DECISION_LABELS[program.decision]}
              />
            </dd>
            <dt className="text-ink-muted">条件</dt>
            <dd className="whitespace-pre-wrap">{program.decisionConditions || '—'}</dd>
            <dt className="text-ink-muted">判断者</dt>
            <dd>{program.decidedByLabel || '—'}</dd>
          </dl>
        </div>
      </Section>
    </div>
  );
}

/** 「計画」の欄: 算定の検証拠点（国コード・国内／海外の数）と将来の展開対象（全 N・うち検証 n） */
function PlanScopeRows({ scope }: { scope: TrialScopeOverview }) {
  const { verification, rollout } = scope;
  return (
    <>
      <dt className="text-ink-muted">算定の検証拠点</dt>
      <dd data-trial-verification-sites="">
        {verification.sites.length === 0 ? (
          '未設定'
        ) : (
          <>
            <span className="font-medium">
              {verification.sites.length} 拠点（国内 {verification.domestic}・海外{' '}
              {verification.overseas}）
            </span>
            {verification.fromIncludedUnits && (
              <span className="text-ink-muted">（計画の対象拠点を使っています）</span>
            )}
            <span className="block text-ink">
              {verification.sites.map((s) => `${s.name}（${s.countryCode}）`).join('・')}
            </span>
          </>
        )}
      </dd>
      <dt className="text-ink-muted">将来の展開対象</dt>
      <dd data-trial-rollout="">
        {rollout.totalSites === null ? (
          '未設定'
        ) : (
          <span className="font-medium">
            全 {rollout.totalSites} 拠点（うち検証対象 {rollout.verifying}・残り {rollout.remaining}
            ）
          </span>
        )}
        {rollout.note && <span className="block whitespace-pre-wrap">{rollout.note}</span>}
      </dd>
    </>
  );
}

const ACTIVITY_STATE_LABEL = (s: SiteStatus['activity']) =>
  s.state === 'none' ? '未受領' : `${s.months} / ${s.of} か月`;
const FACTOR_STATE_LABEL = (s: SiteStatus['factors']) =>
  s.state === 'ok' ? '揃っている' : `未割当 ${s.unresolved} 行`;
const CALCULATION_LABEL: Record<SiteStatus['calculation'], string> = {
  none: '未算定',
  current: '最新',
  stale: '再算定が必要',
};
const BASELINE_LABEL: Record<SiteStatus['baseline'], string> = { none: 'なし', present: 'あり' };
const RECONCILIATION_LABEL: Record<SiteStatus['reconciliation'], string> = {
  none: '未照合',
  needs_review: '要確認',
  done: '照合済み',
};

/** 算定の検証範囲（期間・Scope・活動）と拠点別の検証の状況（算定の概要と同じ数え方） */
function VerificationSection({
  scope,
  canManage,
}: {
  scope: TrialScopeOverview;
  canManage: boolean;
}) {
  const { verification } = scope;
  const period = verification.period;
  const calcHref = period
    ? `/enterprise/ghg/calculation?period=${encodeURIComponent(period.id)}`
    : '/enterprise/ghg/calculation';
  const summary =
    period && verification.sites.length > 0
      ? `${period.code}・${verification.sites.length} 拠点（国内 ${verification.domestic}・海外 ${verification.overseas}）`
      : '未設定';
  const status = verification.status;
  return (
    <Section
      title="算定の検証範囲"
      summary={summary}
      actions={
        <Link href={calcHref} className={linkClass}>
          Scope1・2算定の概要を開く
        </Link>
      }
    >
      {!verification.configured && verification.sites.length === 0 ? (
        <EmptyState
          kind={canManage ? 'no-data' : 'not-applicable'}
          size="compact"
          title="算定の検証範囲はまだ設定されていません"
          description="期間・算定の検証拠点・Scope・活動を計画に入れると、拠点ごとの検証の進み具合を並べます。"
          action={
            canManage ? (
              <Link href={trialHref('overview', { edit: '1' })} className={linkClass}>
                計画を編集
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
            <dt className="text-ink-muted">期間</dt>
            <dd>{period ? period.label : '未設定（計画を編集して選びます）'}</dd>
            <dt className="text-ink-muted">Scope</dt>
            <dd>
              {verification.scopes.length > 0
                ? verification.scopes.map((s) => GHG_SCOPE_LABELS[s]).join('・')
                : '未設定'}
            </dd>
            <dt className="text-ink-muted">活動</dt>
            <dd>
              {verification.activityKinds.length > 0
                ? verification.activityKinds.map((k) => ACTIVITY_KIND_LABELS[k]).join('・')
                : '未設定'}
            </dd>
          </dl>
          {status ? (
            <div className="t4d-scroll-x rounded-t4d border border-line">
              <Table>
                <caption className="sr-only">拠点別の検証の状況</caption>
                <THead>
                  <TR>
                    <TH>拠点（国）</TH>
                    <TH>国内・海外</TH>
                    <TH>活動量</TH>
                    <TH>係数</TH>
                    <TH>算定</TH>
                    <TH>既存結果</TH>
                    <TH>照合</TH>
                    <TH>状況</TH>
                  </TR>
                </THead>
                <TBody>
                  {status.units.map(({ unit, status: site }) => {
                    const view = verification.sites.find((s) => s.id === unit.id);
                    return (
                      <TR key={unit.id} data-t4d-record="">
                        <TD className="whitespace-nowrap font-medium">
                          {unit.name}（{unit.countryCode}）
                        </TD>
                        <TD className="text-small">{view?.domestic ? '国内' : '海外'}</TD>
                        <TD className="tnum text-small">{ACTIVITY_STATE_LABEL(site.activity)}</TD>
                        <TD className="text-small">{FACTOR_STATE_LABEL(site.factors)}</TD>
                        <TD className="text-small">{CALCULATION_LABEL[site.calculation]}</TD>
                        <TD className="text-small">{BASELINE_LABEL[site.baseline]}</TD>
                        <TD className="text-small">{RECONCILIATION_LABEL[site.reconciliation]}</TD>
                        <TD>
                          <StatusBadge domain="ghgSiteStatus" value={site.overall} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          ) : (
            <p className="text-small text-ink-muted">
              算定の検証期間と拠点を設定すると、拠点ごとの状況（活動量・係数・算定・既存結果・照合）を並べます。
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * 無償の範囲と別途協議（合意・標準機能の一覧・4 区分の信号）。目安を超えても止めない。金額は出さない。
 * 合意が無ければ推測で「無償」と書かない
 */
function FreeScopeSection({ scope, canManage }: { scope: TrialScopeOverview; canManage: boolean }) {
  const { agreement, signals, over, unclassifiedSeparate } = scope.freeScope;
  return (
    <Section
      title="無償の範囲と別途協議"
      summary={
        over.length > 0
          ? `別途協議の目安を超過 ${over.length} 区分（操作は止めません）`
          : '目安を超えた区分はありません'
      }
      actions={
        canManage ? (
          <Link href={trialHref('overview', { decision: '1' })} className={linkClass}>
            合意を記録
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-1.5 text-small">
          <span className="text-ink-muted">無償の範囲の合意</span>
          {agreement?.agreedOn ? (
            <SemanticBadge
              semantic="done"
              label={`合意済み（${formatJstDate(agreement.agreedOn)}）`}
            />
          ) : (
            <SemanticBadge semantic="todo" label="未合意" />
          )}
          {agreement?.note && <span className="text-ink">{agreement.note}</span>}
        </p>
        {over.length > 0 && (
          <Notice tone="warning" title={SCOPE_OVER_NOTICE}>
            {over.map((s) => s.label).join('・')}
            。「目安を超過」は別途協議の候補であって確定ではありません。合意した範囲を確かめてください。
          </Notice>
        )}
        <div className="grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_2fr]">
          <div className="space-y-1">
            <p className="text-small font-medium text-ink">標準機能の一覧</p>
            <ul className="list-disc space-y-0.5 pl-4 text-small">
              {STANDARD_SCOPE_ITEMS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="text-caption text-ink-muted">{STANDARD_SCOPE_NOTE}</p>
          </div>
          <div className="t4d-scroll-x rounded-t4d border border-line">
            <Table>
              <caption className="sr-only">別途協議の区分</caption>
              <THead>
                <TR>
                  <TH>区分</TH>
                  <TH>数えたもの</TH>
                  <TH>件数／目安</TH>
                  <TH>状態</TH>
                  <TH>補足</TH>
                </TR>
              </THead>
              <TBody>
                {signals.map((signal) => (
                  <TR key={signal.kind} data-t4d-record="">
                    <TD className="whitespace-nowrap font-medium">{signal.label}</TD>
                    <TD className="text-small">{signal.measured}</TD>
                    <TD className="tnum whitespace-nowrap text-small">
                      {signalCountLabel(signal)}
                    </TD>
                    <TD>
                      <StatusBadge domain="trialScopeSignal" value={signal.state} />
                    </TD>
                    <TD className="text-small">{signal.detail || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
        <p className="text-caption text-ink-muted">
          金額は表示しません。目安は合意した値を人が入れます（PDF
          の目安は「計画を編集」、改善管理表の別途協議は区分を選んで記録）。
          {unclassifiedSeparate > 0 &&
            ` 区分の無い別途協議 ${unclassifiedSeparate} 件は、どの区分にも数えていません。`}
        </p>
      </div>
    </Section>
  );
}

/** 返却・削除の予定日と、バックアップから消える見込み日（予定日 + 合意した残存期間） */
function DisposalRows({
  scope,
  disposition,
}: {
  scope: TrialScopeOverview;
  disposition: TrialProgram['endDisposition'];
}) {
  const { plannedOn, backupResidualDays, purgeDueOn } = scope.disposal;
  return (
    <>
      <dt className="text-ink-muted">返却・削除の予定日</dt>
      <dd data-trial-disposal="">{plannedOn ? formatJstDate(plannedOn) : '未設定'}</dd>
      <dt className="text-ink-muted">バックアップから消える見込み日</dt>
      <dd data-trial-purge="">
        {disposition === 'continue'
          ? '—（本導入へ移行するため削除しません）'
          : purgeDueOn
            ? `${formatJstDate(purgeDueOn)}（予定日 + 残存期間 ${backupResidualLabel(backupResidualDays)}）`
            : plannedOn
              ? '出しません（バックアップの残存期間が未合意です）'
              : '出しません（返却・削除の予定日が未設定です）'}
      </dd>
    </>
  );
}

function PlanForm({
  program,
  choices,
  limits,
}: {
  program: TrialProgram | null;
  choices: TrialFormChoices;
  limits: TrialTextLimits;
}) {
  const target = program?.options.reductionTarget as
    { minPercent?: number; maxPercent?: number } | undefined;
  const cdp = program?.options.cdp;
  const options = parseTrialOptions(program?.options);
  const ghg = options.ghgVerification;
  const ghgUnits = new Set(ghg?.unitIds ?? []);
  const ghgScopes = new Set<string>(ghg?.scopes ?? []);
  const ghgKinds = new Set<string>(ghg?.activityKinds ?? []);
  return (
    <PreservingForm action={saveTrialPlanAction} className="space-y-3 p-3">
      <FormSection title="基本" kind="required">
        <div className="grid grid-cols-12 gap-2">
          <Field label="計画の名前" id="trial-plan-name" required className="col-span-6">
            {(p) => (
              <Input
                {...p}
                name="name"
                maxLength={limits.title}
                defaultValue={program?.name ?? ''}
              />
            )}
          </Field>
          <Field label="段階" id="trial-plan-phase" required className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="phase" defaultValue={program?.phase ?? 'setup'}>
                {TRIAL_PHASES.map((phase) => (
                  <option key={phase} value={phase}>
                    {TRIAL_PHASE_LABELS[phase]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="期間と対象" kind="optional" open>
        <div className="grid grid-cols-12 gap-2">
          <Field label="開始日" id="trial-plan-starts" className="col-span-3">
            {(p) => (
              <Input {...p} name="startsOn" type="date" defaultValue={program?.startsOn ?? ''} />
            )}
          </Field>
          <Field label="終了日" id="trial-plan-ends" className="col-span-3">
            {(p) => <Input {...p} name="endsOn" type="date" defaultValue={program?.endsOn ?? ''} />}
          </Field>
          <Field label="対象プロジェクト" id="trial-plan-project" className="col-span-6">
            {(p) => (
              <NativeSelect {...p} name="projectId" defaultValue={program?.projectId ?? ''}>
                <option value="">未設定</option>
                {choices.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-small font-medium text-ink">対象拠点（選ばなければ全社）</legend>
          <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded-t4d border border-line p-2">
            {choices.units.map((unit) => (
              <NativeCheckbox
                key={unit.id}
                name="includedUnitIds"
                value={unit.id}
                label={unit.name}
                defaultChecked={program?.includedUnitIds.includes(unit.id) ?? false}
              />
            ))}
          </div>
        </fieldset>
        <Field label="対象データの説明" id="trial-plan-note" hint={`${limits.text} 字以内`}>
          {(p) => (
            <Textarea
              {...p}
              name="targetDataNote"
              rows={2}
              maxLength={limits.text}
              defaultValue={program?.targetDataNote ?? ''}
            />
          )}
        </Field>
      </FormSection>
      <FormSection
        title="算定の検証範囲と将来の展開対象"
        kind="optional"
        open={ghg !== null || options.rollout !== null}
        description="算定の検証拠点を選ばなければ、上の対象拠点を使います。展開対象の総拠点数は検証対象を含む全体の数です（検証対象の拠点数以上）。"
      >
        <div className="grid grid-cols-12 gap-2">
          <Field label="算定の検証期間" id="trial-plan-ghg-period" className="col-span-5">
            {(p) => (
              <NativeSelect {...p} name="ghgPeriodId" defaultValue={ghg?.periodId ?? ''}>
                <option value="">未設定</option>
                {choices.periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.code}（{period.label}）
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="将来の展開対象の総拠点数"
            id="trial-plan-rollout-total"
            hint="検証対象を含む全体の数"
            className="col-span-3"
          >
            {(p) => (
              <Input
                {...p}
                name="rolloutTotalSites"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                defaultValue={options.rollout?.totalSites ?? ''}
              />
            )}
          </Field>
          <Field
            label="展開対象のメモ"
            id="trial-plan-rollout-note"
            hint={`${limits.rolloutNote} 字以内`}
            className="col-span-4"
          >
            {(p) => (
              <Input
                {...p}
                name="rolloutNote"
                maxLength={limits.rolloutNote}
                defaultValue={options.rollout?.note ?? ''}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-small font-medium text-ink">
            算定の検証拠点（国コード。選ばなければ上の対象拠点）
          </legend>
          <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded-t4d border border-line p-2">
            {choices.units.map((unit) => (
              <NativeCheckbox
                key={unit.id}
                name="ghgUnitIds"
                value={unit.id}
                label={`${unit.name}（${unit.countryCode}）`}
                defaultChecked={ghgUnits.has(unit.id)}
              />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-2 md:grid-cols-2">
          <fieldset className="space-y-1">
            <legend className="text-small font-medium text-ink">検証の Scope</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {GHG_SCOPES.map((value) => (
                <NativeCheckbox
                  key={value}
                  name="ghgScopes"
                  value={value}
                  label={GHG_SCOPE_LABELS[value]}
                  defaultChecked={ghgScopes.has(value)}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-small font-medium text-ink">検証の活動</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {GHG_ACTIVITY_KINDS.map((value) => (
                <NativeCheckbox
                  key={value}
                  name="ghgActivityKinds"
                  value={value}
                  label={ACTIVITY_KIND_LABELS[value]}
                  defaultChecked={ghgKinds.has(value)}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </FormSection>
      <FormSection
        title="利用枠（計画値）と目標"
        kind="optional"
        open
        description="空欄は「計画値なし」。実績が超えても止めません。"
      >
        <div className="grid grid-cols-4 gap-2">
          {PLANNED_KEYS.map((key) => (
            <Field key={key} label={PLANNED_LABELS[key]} id={`trial-plan-${key}`}>
              {(p) => (
                <Input
                  {...p}
                  name={key}
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  defaultValue={program?.[key] ?? ''}
                />
              )}
            </Field>
          ))}
          <Field label="CDP オプション" id="trial-plan-cdp">
            {(p) => (
              <NativeSelect
                {...p}
                name="cdpPlanned"
                defaultValue={cdp === true ? 'yes' : cdp === false ? 'no' : ''}
              >
                <option value="">未設定</option>
                <option value="yes">計画に含める</option>
                <option value="no">計画に含めない</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="短縮の目標・下限（%）"
            id="trial-plan-target-min"
            hint="合意した値を入れます"
          >
            {(p) => (
              <Input
                {...p}
                name="targetMin"
                type="number"
                min={0}
                max={100}
                defaultValue={target?.minPercent ?? ''}
              />
            )}
          </Field>
          <Field label="短縮の目標・上限（%）" id="trial-plan-target-max">
            {(p) => (
              <Input
                {...p}
                name="targetMax"
                type="number"
                min={0}
                max={100}
                defaultValue={target?.maxPercent ?? ''}
              />
            )}
          </Field>
          <Field
            label="PDF 等の一次データの目安（件）"
            id="trial-plan-free-pdf"
            hint="無償の範囲として合意した目安。超えても止めません"
          >
            {(p) => (
              <Input
                {...p}
                name="freeScopePdfFiles"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                defaultValue={options.freeScope?.pdfFiles ?? ''}
              />
            )}
          </Field>
        </div>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="保存中…">
        計画を保存
      </SubmitButton>
    </PreservingForm>
  );
}

function CasesForm({ program, choices }: { program: TrialProgram; choices: TrialFormChoices }) {
  if (!program.projectId) {
    return (
      <div className="p-3">
        <Notice tone="info">
          選定ケースは対象プロジェクトの要求事項から選びます。先に「計画を編集」で対象プロジェクトを設定してください。
        </Notice>
        <Link href={trialHref('overview', { edit: '1' })} className={linkClass}>
          計画を編集
        </Link>
      </div>
    );
  }
  const selected = new Set(program.selectedRequirementItemIds);
  const selectedMetrics = new Set(program.selectedMetricIds);
  return (
    <PreservingForm action={saveTrialCasesAction} className="space-y-3 p-3">
      {choices.frameworks.map((framework) => (
        <FormSection
          key={framework.versionId}
          title={`${framework.label}（${framework.items.filter((i) => selected.has(i.id)).length} / ${framework.items.length}）`}
          kind="optional"
          open={framework.items.some((i) => selected.has(i.id))}
        >
          {framework.isSample && (
            <p className="flex items-center gap-1 text-caption text-ink-muted">
              <HonestyBadge kind="sample-master" />
              試行用のサンプル（架空）。条文ではありません。
            </p>
          )}
          {framework.items.length === 0 ? (
            <p className="text-small text-ink-muted">この版には要求事項が収録されていません。</p>
          ) : (
            <div className="grid max-h-64 gap-1 overflow-y-auto md:grid-cols-2">
              {framework.items.map((item) => (
                <NativeCheckbox
                  key={item.id}
                  name="requirementIds"
                  value={item.id}
                  defaultChecked={selected.has(item.id)}
                  label={
                    <span>
                      <span className="font-medium">{item.code}</span> {item.title}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </FormSection>
      ))}
      <FormSection
        title={`選定する指標（${selectedMetrics.size}）`}
        kind="optional"
        open={selectedMetrics.size > 0}
      >
        <div className="grid max-h-48 gap-1 overflow-y-auto md:grid-cols-3">
          {choices.metrics.map((metric) => (
            <NativeCheckbox
              key={metric.id}
              name="metricIds"
              value={metric.id}
              defaultChecked={selectedMetrics.has(metric.id)}
              label={metric.name}
            />
          ))}
        </div>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="保存中…">
        選定ケースを保存
      </SubmitButton>
    </PreservingForm>
  );
}

function DecisionForm({ program, limits }: { program: TrialProgram; limits: TrialTextLimits }) {
  const disposal = parseTrialOptions(program.options).disposal;
  return (
    <PreservingForm action={saveTrialDecisionAction} className="space-y-3 p-3">
      <FormSection
        title="開始前の合意（範囲・判断者・スケジュール・無償の範囲）"
        kind="optional"
        open
        description="合意日が空の項目は「未合意」と表示します（推測で埋めません）。無償の範囲は「標準機能の範囲は無償、追加開発等は別途協議」などの合意を書きます（金額は書きません）。"
      >
        <div className="grid grid-cols-12 gap-2">
          {TRIAL_AGREEMENT_KEYS.map((key) => (
            <div key={key} className="contents">
              <Field
                label={`${TRIAL_AGREEMENT_LABELS[key]}の合意日`}
                id={`trial-agreement-${key}-date`}
                className="col-span-3"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={`agreement.${key}.agreedOn`}
                    type="date"
                    defaultValue={program.agreements[key]?.agreedOn ?? ''}
                  />
                )}
              </Field>
              <Field
                label={`${TRIAL_AGREEMENT_LABELS[key]}のメモ`}
                id={`trial-agreement-${key}-note`}
                hint={`${limits.agreementNote} 字以内`}
                className="col-span-9"
              >
                {(p) => (
                  <Input
                    {...p}
                    name={`agreement.${key}.note`}
                    maxLength={limits.agreementNote}
                    defaultValue={program.agreements[key]?.note ?? ''}
                  />
                )}
              </Field>
            </div>
          ))}
        </div>
      </FormSection>
      <FormSection title="終了時の扱いと導入判断" kind="optional" open>
        <div className="grid grid-cols-12 gap-2">
          <Field label="終了時の扱い" id="trial-end-disposition" className="col-span-4">
            {(p) => (
              <NativeSelect {...p} name="endDisposition" defaultValue={program.endDisposition}>
                {TRIAL_END_DISPOSITIONS.map((value) => (
                  <option key={value} value={value}>
                    {TRIAL_END_DISPOSITION_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="終了時の扱いの合意日" id="trial-end-agreed" className="col-span-3">
            {(p) => (
              <Input
                {...p}
                name="endAgreedOn"
                type="date"
                defaultValue={program.endAgreedOn ?? ''}
              />
            )}
          </Field>
          <Field
            label="返却・削除の予定日"
            id="trial-disposal-planned"
            hint="バックアップから消える見込み日は、データ取扱条件の残存期間を足して出します"
            className="col-span-5"
          >
            {(p) => (
              <Input
                {...p}
                name="disposalPlannedOn"
                type="date"
                defaultValue={disposal?.plannedOn ?? ''}
              />
            )}
          </Field>
          <Field label="導入判断" id="trial-decision" className="col-span-3">
            {(p) => (
              <NativeSelect {...p} name="decision" defaultValue={program.decision}>
                {TRIAL_DECISIONS.map((value) => (
                  <option key={value} value={value}>
                    {TRIAL_DECISION_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="判断者" id="trial-decided-by" className="col-span-2">
            {(p) => (
              <Input
                {...p}
                name="decidedByLabel"
                maxLength={limits.title}
                defaultValue={program.decidedByLabel}
              />
            )}
          </Field>
        </div>
        <Field
          label="条件（条件付き導入のときは必須）"
          id="trial-decision-conditions"
          hint={`${limits.text} 字以内`}
        >
          {(p) => (
            <Textarea
              {...p}
              name="decisionConditions"
              rows={2}
              maxLength={limits.text}
              defaultValue={program.decisionConditions}
            />
          )}
        </Field>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="保存中…">
        判断を保存
      </SubmitButton>
    </PreservingForm>
  );
}
