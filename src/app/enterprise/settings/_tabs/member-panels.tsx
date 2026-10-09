import type * as React from 'react';
import Link from 'next/link';
import { UserCog, Users } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Notice } from '@/components/shared/notice';
import { EmptyState } from '@/components/shared/states';
import { FormSection } from '@/components/ui/form-section';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { roleLabel } from '@/lib/authorization/roles';
import {
  DEMO_MEMBER_PROTECTED_MESSAGE,
  MEMBER_ASSIGNMENT_KIND_LABELS,
  type MemberAssignment,
  type MemberAssignments,
} from '@/lib/services/identity';
import type { OrganizationMembership, OrganizationUnit, RoleKey } from '@/types/domain';
import { updateMembershipAction } from '../actions';
import { UnitScopeFields } from '../_components/unit-scope-fields';

/**
 * 設定「メンバー」タブの 2 つの欄（トライアル対応 NF-25）。
 *  - 役割・担当拠点の変更（?edit=<メンバーシップ>）: 確認ダイアログを通して保存する
 *  - 担当の一覧（引継ぎ。?handover=<メンバーシップ>）: 読むだけ。一括の付け替えは作らない
 */

const BASE = '/enterprise/settings';

/** 変更の欄で選べる役割（企業の役割。招待で選べる役割に、後任を管理者にするための企業管理者を足す） */
export const EDITABLE_ROLES: readonly RoleKey[] = [
  'enterprise_admin',
  'sustainability_manager',
  'site_contributor',
  'reviewer',
  'approver',
  'viewer',
];

export function membersHref(extra?: Record<string, string>): string {
  return `${BASE}?${new URLSearchParams({ tab: 'members', ...extra }).toString()}`;
}

function PanelFrame({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-create-panel=""
      className="rounded-t4d-lg border border-brand-200 bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2
          id={`${id}-title`}
          className="flex items-center gap-1.5 text-body font-semibold text-ink"
        >
          {icon}
          {title}
        </h2>
        <Link href={membersHref()} className="text-small text-brand-700 hover:underline">
          閉じる
        </Link>
      </div>
      <div className="space-y-2 px-3 py-3">{children}</div>
    </section>
  );
}

const FORM_ID = 'membership-edit-form';

export function MemberEditPanel({
  membership,
  displayName,
  roleKeys,
  units,
  protectedMember,
  demo,
}: {
  membership: OrganizationMembership;
  displayName: string;
  roleKeys: readonly RoleKey[];
  units: readonly OrganizationUnit[];
  protectedMember: boolean;
  demo: boolean;
}) {
  // 今の役割に一覧の外の役割（外部支援者など）があれば、外さずに残せるよう選択肢に足す
  const roleOptions = [...EDITABLE_ROLES, ...roleKeys.filter((r) => !EDITABLE_ROLES.includes(r))];
  return (
    <PanelFrame
      id="member-edit"
      icon={<UserCog className="size-4 text-brand-700" aria-hidden="true" />}
      title={`役割・担当拠点を変更: ${displayName}`}
    >
      {protectedMember ? (
        <Notice tone="info" role="status">
          {DEMO_MEMBER_PROTECTED_MESSAGE}
        </Notice>
      ) : (
        <form id={FORM_ID} action={updateMembershipAction} className="space-y-3">
          <input type="hidden" name="membershipId" value={membership.id} />
          {/* デモで役割の変更が持ち回らないことは隠さない（折りたたまない） */}
          {demo && (
            <Notice tone="warning">
              デモでは、役割の変更は同じサーバーのメモリにだけ残ります（担当拠点と利用の停止は持ち回します）。
            </Notice>
          )}
          <FormSection title="役割（1 つ以上）" kind="required">
            <div className="flex flex-wrap gap-3">
              {roleOptions.map((role) => (
                <NativeCheckbox
                  key={role}
                  name="roleKeys"
                  value={role}
                  defaultChecked={roleKeys.includes(role)}
                  label={roleLabel(role)}
                />
              ))}
            </div>
          </FormSection>
          <FormSection
            title="担当拠点"
            kind="optional"
            open
            description="選んだ拠点のデータだけを入力・提出できます。何も選ばないと全社です。"
          >
            <UnitScopeFields units={units} selected={membership.unitScopeIds} />
          </FormSection>
          <div className="flex items-center gap-2">
            {/* 操作できる範囲（権限）が変わる。範囲と戻し方を確かめてから保存する（plan §1.16） */}
            <ConfirmDialog
              tier="irreversible"
              destructive={false}
              title="役割・担当拠点を変更しますか"
              scope={`${displayName} の役割と担当拠点`}
              consequences={[
                '保存した時点から、この人が操作できる範囲が変わります（監査ログに記録します）。',
                '最後の企業管理者から管理者の役割は外せません。戻すときは、もう一度この欄で変更します。',
              ]}
              confirmLabel="変更する"
              formId={FORM_ID}
              trigger={{ label: '変更を保存…', size: 'sm', variant: 'primary' }}
            />
            <Link href={membersHref()} className="text-small text-brand-700 hover:underline">
              キャンセル
            </Link>
          </div>
        </form>
      )}
    </PanelFrame>
  );
}

export function HandoverPanel({
  params,
  assignments,
}: {
  params: Record<string, string | string[] | undefined>;
  assignments: MemberAssignments;
}) {
  const columns: DataTableColumn<MemberAssignment & { key: string }>[] = [
    {
      key: 'kind',
      header: '種類',
      importance: 'primary',
      cell: (row) => MEMBER_ASSIGNMENT_KIND_LABELS[row.kind],
    },
    {
      key: 'title',
      header: '担当',
      importance: 'primary',
      lockVisible: true,
      cell: (row) => (
        <Link href={row.href} className="text-brand-700 hover:underline">
          {row.title}
        </Link>
      ),
    },
    { key: 'role', header: '立場', importance: 'primary', cell: (row) => row.role },
  ];
  const rows = assignments.items.map((item, index) => ({ ...item, key: `${item.kind}-${index}` }));
  return (
    <PanelFrame
      id="member-handover"
      icon={<Users className="size-4 text-brand-700" aria-hidden="true" />}
      title={`担当の一覧（引継ぎ）: ${assignments.displayName}`}
    >
      <p className="text-small text-ink-muted">
        この人が担当・指名されている未完了の仕事です。異動・交代のときは、各画面で担当を後任に付け替えてください（一括の付け替えはありません）。
      </p>
      {rows.length === 0 ? (
        <EmptyState
          kind="done"
          size="compact"
          title="未完了の担当はありません"
          description="役割の変更・利用の停止をしても、引き継ぐ仕事は残りません。"
        />
      ) : (
        <DataTable
          id="settings-member-handover"
          caption="担当の一覧（引継ぎ）"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.key}
          getRowLabel={(row) => row.title}
          searchParams={params}
          basePath={BASE}
          search={false}
          empty={{
            noData: {
              title: '未完了の担当はありません',
              action: (
                <Link href={membersHref()} className="text-small text-brand-700 hover:underline">
                  メンバーの一覧へ
                </Link>
              ),
            },
          }}
        />
      )}
    </PanelFrame>
  );
}
