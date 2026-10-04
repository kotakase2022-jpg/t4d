import { AlertTriangle, CheckCircle2, Info, Lock } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { permissionsFor } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_PROJECT_STATUS_LABELS,
} from '@/lib/domain/disclosure-status';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import {
  DECISION_STATUSES,
  FRAMEWORK_CONDITION_REFERENCE,
  PROJECT_FIELD_LABELS,
  compareFrameworkVersions,
  computeBlockImpact,
  formatConditionValue,
  getProject,
  nameOf,
  type ProjectFrameworkView,
} from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { ApplicabilityDecisionForm } from './applicability-decision-form';
import { DISCLOSURE_LANGUAGES, DISCLOSURE_PROJECT_STATUSES } from '@/types/domain';
import { attachFrameworkVersionAction, updateProjectAction } from '../../actions';
import { ApplicabilityBadge, LegalStatusBadge } from '../../_components/framework-badges';
import { ProjectForm } from '../../new/project-form';
import { FrameworkConditionsForm } from './framework-conditions-form';

/**
 * 設定タブ（§6.2・§8.4）。
 *  - プロジェクト情報: 報告範囲・期間を変えるときは影響する原稿・数値・承認を先に示す。
 *  - 基準ごと: 「保存して準備を始める」（適用条件と準備の区分）と「適用判断を確定」を別の操作にする。
 *    条件の未入力は「未入力（不明）」のまま表示し、0 や対象外として扱わない。
 *  - 新しい版: 自動では切り替えず、移行差分と影響を見てから人が追加する（A23）。
 */
export async function SettingsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const detail = await getProject(db, ctx, projectId);
  const project = detail.project;
  const today = getReferenceDate();
  // 判断を確定した直後は、確定した判断が載る履歴を開いて描く（フラッシュが中身を指すとき。§10.4）
  const historyOpen = searchParams.flash === 'applicabilityConfirmed';

  // 新しい版ごとの移行差分と、旧版で書いた原稿への影響
  const newerInfo = new Map<
    string,
    Array<{
      versionId: string;
      label: string;
      diff: Awaited<ReturnType<typeof compareFrameworkVersions>>;
    }>
  >();
  const impactByPf = new Map<string, Awaited<ReturnType<typeof computeBlockImpact>>>();
  for (const f of detail.frameworks) {
    if (f.newerVersions.length === 0) continue;
    const list = [];
    for (const v of f.newerVersions) {
      list.push({
        versionId: v.version.id,
        label: v.version.label,
        diff: await compareFrameworkVersions(db, f.version.id, v.version.id),
      });
    }
    newerInfo.set(f.projectFramework.id, list);
    impactByPf.set(
      f.projectFramework.id,
      await computeBlockImpact(db, detail, (b) => b.frameworkVersionId === f.version.id),
    );
  }

  return (
    <div className="space-y-3">
      {!detail.canWrite && (
        <p className="flex items-center gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink">
          <Lock className="size-3.5" aria-hidden="true" />
          設定の変更には開示の編集権限が必要です。内容の確認だけできます。
        </p>
      )}

      <Card>
        <SectionTitle title="プロジェクト情報" />
        <div className="px-3 pb-3">
          {detail.canWrite ? (
            <ProjectForm
              mode="edit"
              action={updateProjectAction}
              projectId={project.id}
              baseUpdatedAt={project.updatedAt}
              initial={{
                name: project.name,
                reportingEntity: project.reportingEntity,
                periodStart: project.periodStart,
                periodEnd: project.periodEnd,
                currency: project.currency,
                dueDate: project.dueDate ?? '',
                status: project.status,
                ownerUserId: project.ownerUserId ?? '',
                reviewerUserId: project.reviewerUserId ?? '',
                finalApproverUserId: project.finalApproverUserId ?? '',
                languages: project.languages,
                scopeOrgNote: project.scopeOrgNote,
                scopeConsolidationNote: project.scopeConsolidationNote,
                scopeGhgBoundaryNote: project.scopeGhgBoundaryNote,
                scopeValueChainNote: project.scopeValueChainNote,
                includedUnitIds: project.includedUnitIds,
              }}
              periods={[]}
              members={detail.members.map((m) => ({
                userId: m.userId,
                displayName: m.displayName,
                canApprove: permissionsFor(m.roleKeys).has('enterprise.disclosure.approve'),
              }))}
              units={shell.units.map((u) => ({ id: u.id, name: u.name }))}
              purposes={[]}
              versionOptions={{}}
              languages={DISCLOSURE_LANGUAGES.map((l) => ({
                value: l,
                label: DISCLOSURE_LANGUAGE_LABELS[l],
              }))}
              statuses={DISCLOSURE_PROJECT_STATUSES.map((s) => ({
                value: s,
                label: DISCLOSURE_PROJECT_STATUS_LABELS[s],
              }))}
              fieldLabels={{ ...PROJECT_FIELD_LABELS }}
            />
          ) : (
            <p className="text-[12px] text-ink-muted">
              {project.name}（{formatJstDate(project.periodStart)}〜
              {formatJstDate(project.periodEnd)}）
            </p>
          )}
        </div>
      </Card>

      {detail.frameworks.map((f) => (
        <FrameworkSettings
          key={f.projectFramework.id}
          projectId={project.id}
          framework={f}
          canWrite={detail.canWrite}
          today={today}
          decidedByName={(id) => nameOf(detail.members, id)}
          newer={newerInfo.get(f.projectFramework.id) ?? []}
          impact={impactByPf.get(f.projectFramework.id) ?? null}
          historyOpen={historyOpen}
        />
      ))}
      {detail.frameworks.length === 0 && (
        <Card>
          <p className="px-3 py-3 text-[12px] text-ink-muted">
            基準が登録されていません（社内 ESG 管理のみ）。
          </p>
        </Card>
      )}
    </div>
  );
}

function FrameworkSettings({
  projectId,
  framework: f,
  canWrite,
  today,
  decidedByName,
  newer,
  impact,
  historyOpen,
}: {
  projectId: string;
  framework: ProjectFrameworkView;
  canWrite: boolean;
  today: string;
  decidedByName: (id: string | null) => string | null;
  newer: Array<{
    versionId: string;
    label: string;
    diff: Awaited<ReturnType<typeof compareFrameworkVersions>>;
  }>;
  impact: Awaited<ReturnType<typeof computeBlockImpact>> | null;
  historyOpen: boolean;
}) {
  const pfId = f.projectFramework.id;
  const decided = f.projectFramework.currentDecisionId !== null;
  const reference = FRAMEWORK_CONDITION_REFERENCE[f.frameworkKey];
  const defaultRuleRef = `${f.label}${f.version.versionCode ? `（${f.version.versionCode}）` : ''}`;

  return (
    <Card id={`pf-${pfId}`} className="scroll-mt-4">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <h3 className="text-[13px] font-semibold text-ink">{f.label}</h3>
        <span className="text-[12px] text-ink-muted">{f.purposeLabel}</span>
        <LegalStatusBadge legal={f.legal} />
        <ApplicabilityBadge
          status={f.projectFramework.applicabilityStatus}
          confirmed={f.confirmed}
        />
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-2">
        {/* 適用条件（保存して準備を始める） */}
        <section aria-labelledby={`cond-${pfId}`} className="min-w-0 space-y-2">
          <h4 id={`cond-${pfId}`} className="text-[12px] font-semibold text-ink">
            適用条件（保存して準備を始める）
          </h4>
          {f.legal.coverageLabel && (
            <p className="text-[11px] text-ink-muted">
              収録: {f.legal.coverageLabel}
              {f.legal.coverageNote ? `（${f.legal.coverageNote}）` : ''}／重要性の考え方:{' '}
              {f.legal.materialityLabel ?? '—'}
            </p>
          )}
          {reference && (
            <MoreInfo label="適用条件の参考">
              <p>{reference}</p>
            </MoreInfo>
          )}
          {f.conditionsChangedSinceDecision && (
            <p className="flex items-center gap-1 text-[11px] text-[#8a5d00]">
              <AlertTriangle className="size-3" aria-hidden="true" />
              判断を確定した後に条件が変わっています。必要なら判断を見直して追記してください。
            </p>
          )}
          {f.conditionFields.length === 0 ? (
            <p className="text-[12px] text-ink-muted">この基準に記録する適用条件はありません。</p>
          ) : canWrite ? (
            <FrameworkConditionsForm
              projectId={projectId}
              projectFrameworkId={pfId}
              baseUpdatedAt={f.projectFramework.updatedAt}
              fields={f.conditionFields.map((field) => {
                const value = f.projectFramework.conditions[field.key];
                return {
                  key: field.key,
                  label: field.label,
                  kind: field.kind,
                  unit: field.unit,
                  help: field.help,
                  saved: value === undefined || value === null ? '' : String(value),
                };
              })}
              decided={decided}
              decidedStatusLabel={
                APPLICABILITY_STATUS_LABELS[f.projectFramework.applicabilityStatus]
              }
              preparationStatus={
                f.projectFramework.applicabilityStatus === 'awaiting_confirmation'
                  ? 'awaiting_confirmation'
                  : 'candidate'
              }
            />
          ) : (
            <dl className="space-y-0.5 text-[12px]">
              {f.conditionFields.map((field) => (
                <div key={field.key} className="flex justify-between gap-2">
                  <dt className="text-ink-muted">{field.label}</dt>
                  <dd>{formatConditionValue(field, f.projectFramework.conditions[field.key])}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {/* 適用判断を確定 */}
        <section aria-labelledby={`dec-${pfId}`} className="min-w-0 space-y-2">
          <h4 id={`dec-${pfId}`} className="text-[12px] font-semibold text-ink">
            適用判断を確定
          </h4>
          {f.unknownConditions.length > 0 && f.conditionFields.length > 0 && (
            <p className="flex gap-1 text-[11px] text-[#8a5d00]">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              未入力（不明）の条件: {f.unknownConditions.map((c) => c.label).join('、')}。
              不明のまま判断する場合は、理由にその旨を書いてください。
            </p>
          )}
          {canWrite ? (
            <ApplicabilityDecisionForm
              projectId={projectId}
              projectFrameworkId={pfId}
              statusOptions={DECISION_STATUSES.map((s) => ({
                value: s,
                label: APPLICABILITY_STATUS_LABELS[s],
              }))}
              defaultRuleRef={defaultRuleRef}
              today={today}
            />
          ) : null}

          {/* 判断の履歴は既定で閉じる（件数は閉じていても見える。§10.4 B6） */}
          {f.decisions.length === 0 ? (
            <p className="text-[11px] text-ink-muted">まだ判断は確定していません。</p>
          ) : (
            <Collapsible
              variant="plain"
              summary={`判断の履歴（${f.decisions.length} 件）`}
              open={historyOpen || undefined}
            >
              <ol className="space-y-1">
                {f.decisions.map((d) => (
                  <li key={d.id} className="rounded-t4d bg-surface-muted px-2 py-1 text-[11px]">
                    <span className="font-medium">
                      判断 {d.decisionNo}：{APPLICABILITY_STATUS_LABELS[d.applicabilityStatus]}
                    </span>
                    {d.id === f.projectFramework.currentDecisionId && (
                      <Badge tone="brand" className="ml-1">
                        <CheckCircle2 className="size-3" aria-hidden="true" />
                        現在の判断
                      </Badge>
                    )}
                    <span className="block">理由: {d.reason}</span>
                    <span className="block text-ink-muted">
                      参照規則・版: {d.ruleRef}／確認日 {formatJstDate(d.confirmedOn)}／判断者{' '}
                      {decidedByName(d.decidedBy)}／{formatJst(d.decidedAt)}
                    </span>
                  </li>
                ))}
              </ol>
            </Collapsible>
          )}
        </section>
      </div>

      {newer.length > 0 && (
        <section
          aria-labelledby={`newer-${pfId}`}
          className="space-y-2 border-t border-line bg-warning-soft/30 px-3 py-3"
        >
          <h4
            id={`newer-${pfId}`}
            className="flex items-center gap-1 text-[12px] font-semibold text-ink"
          >
            <Info className="size-3.5" aria-hidden="true" />
            新しい版があります（このプロジェクトは自動では切り替えていません）
          </h4>
          {newer.map((n) => (
            <div key={n.versionId} className="space-y-1 text-[12px]">
              <p className="font-medium">{n.label}</p>
              <p className="text-ink-muted">
                移行差分: 追加 {n.diff.added.length} 項目／変更 {n.diff.changed.length} 項目／削除{' '}
                {n.diff.removed.length} 項目／変更なし {n.diff.unchangedCount} 項目
              </p>
              {n.diff.added.length + n.diff.changed.length + n.diff.removed.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-brand-800">
                    差分の項番を見る
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-[11px]">
                    {n.diff.added.map((i) => (
                      <li key={`a-${i.code}`}>
                        追加: {i.code} {i.title}
                      </li>
                    ))}
                    {n.diff.changed.map((i) => (
                      <li key={`c-${i.code}`}>
                        変更: {i.code} {i.title}
                      </li>
                    ))}
                    {n.diff.removed.map((i) => (
                      <li key={`r-${i.code}`}>
                        削除: {i.code} {i.title}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {impact && impact.blocks.length > 0 && (
                <p className="text-[11px] text-ink-muted">
                  現在の版で書いた原稿 {impact.blocks.length} 節（
                  {impact.blocks.map((b) => `${b.title}（${b.statusLabel}）`).join('、')}）
                  と承認・レビュー {impact.approvals.length} 件は、旧版のまま残ります。
                </p>
              )}
              {canWrite && (
                <form
                  action={attachFrameworkVersionAction}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="projectFrameworkId" value={pfId} />
                  <input type="hidden" name="newVersionId" value={n.versionId} />
                  <label className="flex items-center gap-1 text-[12px]">
                    <input type="checkbox" name="acknowledgeImpact" />
                    影響を確認しました
                  </label>
                  <SubmitButton variant="outline" size="xs" pendingLabel="追加中…">
                    新しい版をこのプロジェクトに追加
                  </SubmitButton>
                </form>
              )}
            </div>
          ))}
        </section>
      )}
    </Card>
  );
}
