import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { can, permissionsFor } from '@/lib/authorization/can';
import {
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
} from '@/lib/domain/disclosure-status';
import {
  PROJECT_FIELD_LABELS,
  PURPOSE_FRAMEWORK_KEY,
  listFrameworkVersionOptions,
} from '@/lib/services/disclosure-project';
import { formatJstDate } from '@/lib/format/datetime';
import { listMembers } from '@/lib/services/identity';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DISCLOSURE_LANGUAGES, DISCLOSURE_PURPOSES, type FrameworkKey } from '@/types/domain';
import { createProjectAction } from '../actions';
import { ProjectForm, type VersionOptionItem } from './project-form';

export const metadata = { title: '開示プロジェクトの作成' };

const BREADCRUMBS = [
  { label: 'ホーム', href: '/enterprise/dashboard' },
  { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
  { label: '新規作成' },
];

const FRAMEWORK_KEY_LABELS: Partial<Record<FrameworkKey, string>> = {
  ssbj: 'SSBJ 基準',
  esrs_40a: 'ESRS-40a（EU 域外企業向け）',
  csrd: 'CSRD / ESRS',
};

/**
 * 開示プロジェクトの新規作成（§6.2 の 3 段階）。
 * 1. 報告主体と期間 → 2. 対応する制度と基準 → 3. 報告範囲と承認。
 * 「保存して準備を始める」で作成し、適用判断の確定は作成後の設定タブで行う。
 */
export default async function NewDisclosureProjectPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  if (!can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="開示プロジェクトの作成" breadcrumbs={BREADCRUMBS} />
        <PermissionDeniedState
          description="開示プロジェクトを作成するには、開示の編集権限が必要です。"
          permission="enterprise.disclosure.write"
        />
      </>
    );
  }

  const [members, options] = await Promise.all([
    listMembers(db, ctx),
    listFrameworkVersionOptions(db),
  ]);
  const versionOptions: Record<string, VersionOptionItem[]> = {};
  for (const [purpose, list] of Object.entries(options)) {
    versionOptions[purpose] = list.map((o) => ({
      versionId: o.versionId,
      label: o.label,
      legalLabel: o.legal.label,
      coverageLabel: o.legal.coverageLabel,
      itemCount: o.itemCount,
    }));
  }
  const current = shell.currentPeriod;

  return (
    <>
      <PageHeader
        title="開示プロジェクトの作成"
        description="3 段階で設定します（作成後も設定タブで変更できます）"
        help={
          <p>
            報告主体・期間、対応する制度と基準、報告範囲と承認者を 3
            段階で設定します。基準の版はプロジェクトごとに固定され、新しい版が出ても自動では切り替わりません。
          </p>
        }
        breadcrumbs={BREADCRUMBS}
      />
      <div className="p-4">
        <div className="max-w-4xl rounded-t4d-lg border border-line bg-surface p-4">
          <ProjectForm
            mode="create"
            action={createProjectAction}
            initial={{
              name: '',
              reportingEntity: ctx.workspace.organizationName,
              reportingPeriodId: current.id,
              periodStart: current.startDate,
              periodEnd: current.endDate,
              currency: 'JPY',
              ownerUserId: ctx.userId,
              // 期限は報告期間の提出期限を既定にする（D3。期間を選び直すと追従する）
              dueDate: current.submissionDueDate ?? '',
              purposes: [],
              languages: ['ja'],
              includedUnitIds: [],
              reviewerUserId: '',
              finalApproverUserId: '',
            }}
            periods={shell.periods.map((p) => ({
              id: p.id,
              code: p.code,
              label: p.label,
              startDate: p.startDate,
              endDate: p.endDate,
              rangeLabel: `${formatJstDate(p.startDate)}〜${formatJstDate(p.endDate)}`,
              submissionDueDate: p.submissionDueDate,
            }))}
            members={members.map((m) => ({
              userId: m.userId,
              displayName: m.displayName,
              canApprove: permissionsFor(m.roleKeys).has('enterprise.disclosure.approve'),
            }))}
            units={shell.units.map((u) => ({ id: u.id, name: u.name }))}
            purposes={DISCLOSURE_PURPOSES.map((p) => {
              const key = PURPOSE_FRAMEWORK_KEY[p];
              return {
                value: p,
                label: DISCLOSURE_PURPOSE_LABELS[p],
                frameworkLabel: key ? (FRAMEWORK_KEY_LABELS[key] ?? key) : null,
              };
            })}
            versionOptions={versionOptions}
            languages={DISCLOSURE_LANGUAGES.map((l) => ({
              value: l,
              label: DISCLOSURE_LANGUAGE_LABELS[l],
            }))}
            fieldLabels={{ ...PROJECT_FIELD_LABELS }}
          />
        </div>
      </div>
    </>
  );
}
