import Link from 'next/link';
import { Route } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { roleLabel } from '@/lib/authorization/roles';
import { formatJst } from '@/lib/format/datetime';
import {
  APPROVAL_ROUTE_PURPOSE_LABELS,
  APPROVAL_ROUTE_TEXT_LIMITS,
  type ApprovalRouteView,
} from '@/lib/services/approval-route';
import {
  APPROVAL_ROUTE_PURPOSES,
  ENTERPRISE_ROLES,
  MAX_APPROVAL_STAGES,
  type ApprovalRoutePurpose,
  type RoleKey,
} from '@/types/domain';
import { saveApprovalRouteAction } from '../actions';

/**
 * 設定「承認ルート」タブ（トライアル対応 NF-24・NF-44）。データの段階承認の経路（1〜5 段階）を一覧し、
 * 作成・編集する。保存は既存の saveApprovalRoute（enterprise.org.manage）。
 *
 *  - 経路を変えても、進行中のデータは写しを持つので経路は変わらない（確認ダイアログの本文に出す）
 *  - 「3 段階のひな形」「過年度確定値のひな形」は編集の欄に値を入れるだけ（保存は人が押す）
 *  - 過年度確定値の経路（用途 prior_year_final）は既定にできない。標準 CSV の確定で選んだときだけ使う
 */

const BASE = '/enterprise/settings';

export const APPROVAL_TEMPLATES = {
  three: {
    name: '3 段階の承認（標準）',
    purpose: 'default',
    isDefault: true,
    description: '拠点・部署の確認 → 本社の確認 → 最終承認 の 3 段階（ひな形から作成）',
    stages: [
      { name: '拠点・部署の確認', role: 'reviewer', department: '' },
      { name: '本社サステナビリティ担当の確認', role: 'sustainability_manager', department: '' },
      { name: '最終承認', role: 'approver', department: '' },
    ],
  },
  'prior-year': {
    name: '過年度確定値の登録',
    purpose: 'prior_year_final',
    isDefault: false,
    description: '確定済みの過去の年度の値を登録するときの確認（ひな形から作成）',
    stages: [{ name: '過年度確定値の確認', role: 'approver', department: '' }],
  },
} as const satisfies Record<
  string,
  {
    name: string;
    purpose: ApprovalRoutePurpose;
    isDefault: boolean;
    description: string;
    stages: ReadonlyArray<{ name: string; role: string; department: string }>;
  }
>;
export type ApprovalTemplateKey = keyof typeof APPROVAL_TEMPLATES;

export function approvalTabHref(extra?: Record<string, string>): string {
  return `${BASE}?${new URLSearchParams({ tab: 'approval', ...extra }).toString()}`;
}

interface EditorValues {
  routeId: string | null;
  name: string;
  purpose: ApprovalRoutePurpose;
  isDefault: boolean;
  description: string;
  stages: Array<{ name: string; role: string; department: string }>;
}

function editorValues(
  edit: string,
  template: string | null,
  routes: readonly ApprovalRouteView[],
): EditorValues | null {
  if (edit === 'new') {
    const t =
      template && template in APPROVAL_TEMPLATES
        ? APPROVAL_TEMPLATES[template as ApprovalTemplateKey]
        : null;
    return {
      routeId: null,
      name: t?.name ?? '',
      purpose: t?.purpose ?? 'default',
      isDefault: t?.isDefault ?? false,
      description: t?.description ?? '',
      stages: t ? t.stages.map((s) => ({ ...s })) : [],
    };
  }
  const view = routes.find((r) => r.route.id === edit);
  if (!view) return null;
  return {
    routeId: view.route.id,
    name: view.route.name,
    purpose: view.route.purpose === 'prior_year_final' ? 'prior_year_final' : 'default',
    isDefault: view.route.isDefault,
    description: view.route.description,
    stages: view.stages.map((s) => ({
      name: s.name,
      role: s.approverRole,
      department: s.department,
    })),
  };
}

/** 段階の承認できる役割の表示（空・企業の役割でない値は「承認権限を持つ人」） */
function approverLabel(role: string): string {
  return (ENTERPRISE_ROLES as readonly string[]).includes(role)
    ? roleLabel(role as RoleKey)
    : '承認権限を持つ人';
}

function stageLine(view: ApprovalRouteView): string {
  return view.stages
    .map((s) => `${s.stageNo}. ${s.name}（${approverLabel(s.approverRole)}）`)
    .join(' → ');
}

export function ApprovalTab({
  params,
  routes,
}: {
  params: Record<string, string | string[] | undefined>;
  routes: readonly ApprovalRouteView[];
}) {
  const edit = typeof params.edit === 'string' ? params.edit : null;
  const template = typeof params.template === 'string' ? params.template : null;
  const values = edit ? editorValues(edit, template, routes) : null;

  const columns: DataTableColumn<ApprovalRouteView>[] = [
    {
      key: 'name',
      header: '名称',
      importance: 'primary',
      lockVisible: true,
      cell: (view) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{view.route.name}</span>
          {view.route.isDefault && <SemanticBadge semantic="done" label="既定" />}
        </span>
      ),
    },
    {
      key: 'purpose',
      header: '用途',
      importance: 'primary',
      cell: (view) =>
        APPROVAL_ROUTE_PURPOSE_LABELS[
          view.route.purpose === 'prior_year_final' ? 'prior_year_final' : 'default'
        ],
    },
    {
      key: 'stages',
      header: '段階',
      importance: 'primary',
      cell: (view) => <span className="text-small">{stageLine(view)}</span>,
    },
    {
      key: 'count',
      header: '段階数',
      importance: 'secondary',
      align: 'right',
      cell: (view) => <span className="tnum">{view.stages.length}</span>,
    },
    {
      key: 'updated',
      header: '更新',
      importance: 'detail',
      cell: (view) => (
        <span className="text-caption text-ink-muted">{formatJst(view.route.updatedAt)}</span>
      ),
    },
  ];

  return (
    <>
      {edit && !values && (
        <Notice tone="warning" role="alert">
          指定の承認ルートが見つかりません。一覧から選び直してください。
        </Notice>
      )}
      {values && <ApprovalRouteEditor values={values} />}

      <Section title={`承認ルート（${routes.length}）`} divider="none">
        <p className="mb-2 text-small text-ink-muted">
          データ（数値）を提出すると、既定の経路の段階を順に承認します。経路を変えても、進行中のデータは提出の時点の経路のまま進みます。
          過年度確定値の経路は、標準 CSV
          の確定で「過年度確定値として登録」を選んだときだけ使います。
        </p>
        <DataTable<ApprovalRouteView>
          id="settings-approval-routes"
          caption="承認ルート"
          columns={columns}
          rows={routes}
          getRowId={(view) => view.route.id}
          getRowLabel={(view) => view.route.name}
          searchParams={params}
          basePath={BASE}
          search={false}
          rowActions={(view) => ({
            rowLabel: view.route.name,
            primary: {
              kind: 'link',
              id: `edit-route-${view.route.id}`,
              label: '編集',
              href: approvalTabHref({ edit: view.route.id }),
            },
          })}
          empty={{
            noData: {
              title: '承認ルートはまだありません',
              description:
                '経路が無い組織では、データは 1 段階の承認で進みます。3 段階のひな形から作れます。',
              action: (
                <Link
                  href={approvalTabHref({ edit: 'new', template: 'three' })}
                  className="text-small text-brand-700 hover:underline"
                >
                  3 段階のひな形を入れる
                </Link>
              ),
            },
          }}
        />
      </Section>
    </>
  );
}

const FORM_ID = 'approval-route-form';

function ApprovalRouteEditor({ values }: { values: EditorValues }) {
  const title = values.routeId ? `承認ルートを編集: ${values.name}` : '承認ルートを追加';
  const stageRows = Array.from(
    { length: MAX_APPROVAL_STAGES },
    (_, index) => values.stages[index] ?? { name: '', role: '', department: '' },
  );
  return (
    <section
      id="approval-route-editor"
      aria-labelledby="approval-route-editor-title"
      data-create-panel=""
      className="rounded-t4d-lg border border-brand-200 bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 id="approval-route-editor-title" className="text-body font-semibold text-ink">
          <Route className="mr-1 inline size-4 text-brand-700" aria-hidden="true" />
          {title}
        </h2>
        <Link href={approvalTabHref()} className="text-small text-brand-700 hover:underline">
          閉じる
        </Link>
      </div>
      <form id={FORM_ID} action={saveApprovalRouteAction} className="space-y-3 px-3 py-3">
        {values.routeId && <input type="hidden" name="routeId" value={values.routeId} />}
        <FormSection title="経路" kind="required">
          <div className="grid gap-2 md:grid-cols-2">
            <Field
              label="名称"
              name="name"
              required
              hint={`${APPROVAL_ROUTE_TEXT_LIMITS.name} 文字以内`}
            >
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  defaultValue={values.name}
                  maxLength={APPROVAL_ROUTE_TEXT_LIMITS.name}
                />
              )}
            </Field>
            <Field label="用途" name="purpose" required>
              {(p) => (
                <NativeSelect {...p} name="purpose" defaultValue={values.purpose}>
                  {APPROVAL_ROUTE_PURPOSES.map((purpose) => (
                    <option key={purpose} value={purpose}>
                      {APPROVAL_ROUTE_PURPOSE_LABELS[purpose]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <NativeCheckbox
            name="isDefault"
            defaultChecked={values.isDefault}
            label="通常のデータの既定の経路にする（過年度確定値の経路は既定にできません）"
          />
        </FormSection>

        <FormSection
          title={`段階（1〜${MAX_APPROVAL_STAGES}）`}
          kind="required"
          description="上から順に承認します。段階名が空の行は使いません。承認できる役割を空にすると、承認権限を持つ人なら誰でも承認できます。"
        >
          <div className="t4d-scroll-x rounded-t4d border border-line">
            <Table>
              <THead>
                <TR>
                  <TH>段階</TH>
                  <TH>段階名</TH>
                  <TH>承認できる役割</TH>
                  <TH>部署（任意）</TH>
                </TR>
              </THead>
              <TBody>
                {stageRows.map((stage, index) => {
                  const no = index + 1;
                  return (
                    <TR key={no}>
                      <TD className="tnum text-small">{no}</TD>
                      <TD>
                        <Input
                          name={`stageName${no}`}
                          aria-label={`${no} 段目の段階名`}
                          defaultValue={stage.name}
                          maxLength={APPROVAL_ROUTE_TEXT_LIMITS.name}
                          required={no === 1}
                        />
                      </TD>
                      <TD>
                        <NativeSelect
                          name={`stageRole${no}`}
                          aria-label={`${no} 段目の承認できる役割`}
                          defaultValue={stage.role}
                        >
                          <option value="">承認権限を持つ人なら誰でも</option>
                          {ENTERPRISE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {roleLabel(role)}
                            </option>
                          ))}
                        </NativeSelect>
                      </TD>
                      <TD>
                        <Input
                          name={`stageDepartment${no}`}
                          aria-label={`${no} 段目の部署`}
                          defaultValue={stage.department}
                          maxLength={APPROVAL_ROUTE_TEXT_LIMITS.name}
                        />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </FormSection>

        <FormSection title="説明" kind="optional" open={values.description !== ''}>
          <Field
            label="説明"
            name="description"
            hint={`${APPROVAL_ROUTE_TEXT_LIMITS.description} 文字以内`}
          >
            {(p) => (
              <Textarea
                {...p}
                name="description"
                rows={2}
                defaultValue={values.description}
                maxLength={APPROVAL_ROUTE_TEXT_LIMITS.description}
              />
            )}
          </Field>
        </FormSection>

        <div className="flex items-center gap-2">
          {/* 組織の全員の、これからの提出の経路が変わる。範囲と影響を確かめてから保存する（plan §1.16 区分 2） */}
          <ConfirmDialog
            tier="bulk"
            destructive={false}
            title="承認ルートを保存しますか"
            scope={
              values.routeId
                ? `承認ルート「${values.name}」の名称・用途・段階`
                : 'この組織の承認ルート（新規）'
            }
            consequences={[
              '進行中のデータは写しを持つため経路は変わりません。新しい提出から使います。',
              '既定にすると、通常のデータの提出はこの経路で始まります（既定はひとつだけです）。',
            ]}
            confirmLabel="保存する"
            formId={FORM_ID}
            trigger={{ label: '保存…', size: 'sm', variant: 'primary' }}
          />
          <Link href={approvalTabHref()} className="text-small text-brand-700 hover:underline">
            キャンセル
          </Link>
        </div>
      </form>
    </section>
  );
}
