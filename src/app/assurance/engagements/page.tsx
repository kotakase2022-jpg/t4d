import Link from 'next/link';
import { FilePlus2 } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { formatJstDate, formatNumber } from '@/lib/format/datetime';
import { loadAssuranceShell } from '@/lib/services/shell';
import { statusOptions } from '@/lib/ui/status/registry';
import type { Engagement } from '@/types/domain';
import { createEngagementAction } from '../actions';
import { assuranceLevelLabel, frameworkLabel } from '../_components/labels';

export const metadata = { title: '保証契約' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE = '/assurance/engagements';

/** 起票で選べる基準（既存の案件の frameworkKey と同じ値。既定は SSBJ＝サーバーの既定と同じ） */
const FRAMEWORK_CHOICES: Engagement['frameworkKey'][] = ['ssbj', 'csrd', 'cdp', 'issb', 'other'];

export default async function EngagementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const shell = await loadAssuranceShell();
  const { db, ctx } = shell;

  const clientIds = [...new Set(shell.engagements.map((e) => e.clientOrganizationId))];
  const clients =
    clientIds.length > 0
      ? await db.select('organizations', { where: { id: { in: clientIds } } })
      : [];
  const periodIds = [...new Set(shell.engagements.map((e) => e.clientReportingPeriodId))];
  const periods =
    periodIds.length > 0 ? await db.select('periods', { where: { id: { in: periodIds } } }) : [];

  const members =
    shell.engagements.length > 0
      ? await db.select('engagementMembers', {
          where: { engagementId: { in: shell.engagements.map((e) => e.id) } },
        })
      : [];
  const profileIds = [...new Set(members.map((m) => m.userId))];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];

  const canManage = can(ctx, 'assurance.engagement.manage');
  // 起票できるのは取引のあるクライアントの期間だけ
  const clientPeriods =
    clientIds.length > 0
      ? await db.select('periods', { where: { organizationId: { in: clientIds } } })
      : [];
  const canCreate = canManage && clients.length > 0;
  // 入力の誤りで戻ってきたとき（?error=）も作成欄を開いて描く（どこを直すかを見失わせない）
  const panelOpen = canCreate && (isCreatePanelOpen(params) || typeof params.error === 'string');
  const panelParams: SearchParams = panelOpen ? { ...params, new: '1' } : params;

  // 既定の期間（plan D1）: クライアントの収集中の期間（無ければ最新）
  const defaultPeriod =
    clientPeriods.find((p) => p.status === 'collecting') ??
    [...clientPeriods].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const defaultClientId = defaultPeriod?.organizationId ?? clients[0]?.id;

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? '—';
  const periodCode = (id: string) => periods.find((p) => p.id === id)?.code ?? '—';
  const teamOf = (engagementId: string) =>
    members
      .filter((m) => m.engagementId === engagementId && m.removedAt === null)
      .map((m) => profiles.find((p) => p.id === m.userId)?.displayName ?? '—')
      .join(' / ');

  // 一覧の検索・絞り込み（URL が正。サーバーで絞る）
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const statusFilter = typeof params.status === 'string' ? params.status : null;
  const rows = shell.engagements
    .filter((e) => (statusFilter ? e.status === statusFilter : true))
    .filter((e) =>
      query === ''
        ? true
        : `${e.code} ${e.name} ${clientName(e.clientOrganizationId)}`.toLowerCase().includes(query),
    );

  const columns: DataTableColumn<Engagement>[] = [
    {
      key: 'code',
      header: 'コード',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (engagement) => (
        <Link
          href={`${BASE}/${engagement.id}/overview`}
          className="font-mono text-small text-brand-700 hover:underline"
        >
          {engagement.code}
        </Link>
      ),
    },
    {
      key: 'name',
      header: '案件名',
      importance: 'primary',
      cell: (engagement) => <span className="font-medium">{engagement.name}</span>,
    },
    {
      key: 'client',
      header: 'クライアント',
      importance: 'primary',
      cell: (engagement) => clientName(engagement.clientOrganizationId),
    },
    {
      key: 'period',
      header: '対象期間',
      importance: 'secondary',
      cell: (engagement) => periodCode(engagement.clientReportingPeriodId),
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (engagement) => <StatusBadge domain="engagement" value={engagement.status} />,
    },
    {
      key: 'deadline',
      header: '期限',
      importance: 'primary',
      cell: (engagement) => formatJstDate(engagement.deadlineDate),
    },
    {
      key: 'framework',
      header: '基準',
      importance: 'detail',
      cell: (engagement) => frameworkLabel(engagement.frameworkKey),
    },
    {
      key: 'level',
      header: '保証水準',
      importance: 'detail',
      cell: (engagement) => assuranceLevelLabel(engagement.assuranceLevel),
    },
    {
      key: 'materiality',
      header: '重要性',
      importance: 'detail',
      cell: (engagement) => (
        <span className="text-caption">
          {engagement.materialityValue === null
            ? '—'
            : `${formatNumber(engagement.materialityValue)} ${engagement.materialityUnit ?? ''}`}
          <span className="block text-ink-muted">{engagement.materialityBasis ?? ''}</span>
        </span>
      ),
    },
    {
      key: 'team',
      header: 'チーム',
      importance: 'detail',
      cell: (engagement) => <span className="text-caption">{teamOf(engagement.id)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="保証契約"
        description="アサインされた案件のみ表示（未アサイン案件は管理者も閲覧不可）"
        help={
          <p>
            アサインされている案件のみ表示されます（監査法人管理者でも未アサイン案件は閲覧できません）。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-engagement',
              shortcut: 'new',
              label: '保証契約を起票',
              icon: <FilePlus2 aria-hidden="true" />,
              href: createPanelHref(BASE, params, { open: true }),
              // 作成欄を開いているときは、欄の中の「起票」が主操作（同時に 2 つ出さない）
              hidden: !canCreate || panelOpen,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} />

        {canCreate && (
          <CreatePanel
            id="create-engagement"
            title="保証契約を起票"
            searchParams={panelParams}
            closeHref={createPanelHref(BASE, params, { open: false })}
            description="クライアントは取引のある企業から選びます。起票した本人がマネージャーとしてチームに入ります。"
          >
            <form action={createEngagementAction} className="space-y-3">
              <FormSection title="案件の基本" kind="required">
                <div className="grid grid-cols-12 gap-2">
                  <Field
                    label="クライアント"
                    name="clientOrganizationId"
                    required
                    className="col-span-3"
                  >
                    {(p) => (
                      <NativeSelect
                        {...p}
                        name="clientOrganizationId"
                        defaultValue={defaultClientId}
                      >
                        {clients.map((client) => (
                          <option key={client.id} value={client.id}>
                            {client.name}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    label="対象期間"
                    name="clientReportingPeriodId"
                    required
                    hint="既定はクライアントの収集中の期間"
                    className="col-span-3"
                  >
                    {(p) => (
                      <NativeSelect
                        {...p}
                        name="clientReportingPeriodId"
                        defaultValue={defaultPeriod?.id}
                      >
                        {clients.map((client) => (
                          <optgroup key={client.id} label={client.name}>
                            {clientPeriods
                              .filter((period) => period.organizationId === client.id)
                              .map((period) => (
                                <option key={period.id} value={period.id}>
                                  {period.code}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="案件コード" name="code" required className="col-span-2">
                    {(p) => <Input {...p} name="code" placeholder="ENG-2027-001" />}
                  </Field>
                  <Field label="案件名" name="name" required className="col-span-4">
                    {(p) => <Input {...p} name="name" placeholder="FY2027 限定的保証業務" />}
                  </Field>
                </div>
              </FormSection>
              <FormSection title="保証水準・基準・日程" kind="optional">
                <div className="grid grid-cols-12 gap-2">
                  <Field label="保証水準" name="assuranceLevel" className="col-span-3">
                    {(p) => (
                      <NativeSelect {...p} name="assuranceLevel" defaultValue="limited">
                        <option value="limited">{assuranceLevelLabel('limited')}</option>
                        <option value="reasonable">{assuranceLevelLabel('reasonable')}</option>
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="基準" name="frameworkKey" className="col-span-3">
                    {(p) => (
                      <NativeSelect {...p} name="frameworkKey" defaultValue="ssbj">
                        {FRAMEWORK_CHOICES.map((key) => (
                          <option key={key} value={key}>
                            {frameworkLabel(key)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    label="開始予定日"
                    name="plannedStartDate"
                    hint="空欄なら起票日"
                    className="col-span-3"
                  >
                    {(p) => <Input {...p} name="plannedStartDate" type="date" />}
                  </Field>
                  <Field
                    label="期限"
                    name="deadlineDate"
                    hint="空欄なら起票日"
                    className="col-span-3"
                  >
                    {(p) => <Input {...p} name="deadlineDate" type="date" />}
                  </Field>
                </div>
              </FormSection>
              <SubmitButton variant="primary" size="sm" pendingLabel="起票中…">
                起票
              </SubmitButton>
            </form>
          </CreatePanel>
        )}

        <DataTable<Engagement>
          id="assurance-engagement-list"
          caption={`案件（${shell.engagements.length}）`}
          columns={columns}
          rows={rows}
          getRowId={(engagement) => engagement.id}
          getRowLabel={(engagement) => engagement.code}
          searchParams={params}
          basePath={BASE}
          search={{ placeholder: '案件コード・案件名・クライアントで検索' }}
          filters={[{ key: 'status', label: '状態', options: statusOptions('engagement') }]}
          empty={{
            noData: {
              title: 'アサインされている案件がありません',
              description: '案件は契約責任者・マネージャーが起票し、チームに担当者を加えます。',
              action: canCreate ? (
                <Link
                  href={createPanelHref(BASE, params, { open: true })}
                  className="text-small text-brand-700 hover:underline"
                >
                  保証契約を起票
                </Link>
              ) : (
                <Link
                  href="/assurance/dashboard"
                  className="text-small text-brand-700 hover:underline"
                >
                  案件ホームへ
                </Link>
              ),
            },
          }}
        />
        <p className="text-caption text-ink-muted">
          ログイン中: {ctx.displayName} ／ アサイン案件 {ctx.engagementIds.length} 件
        </p>
      </div>
    </>
  );
}
