import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  BadgeCheck,
  Ban,
  Download,
  FileCode2,
  FileJson,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Table2,
  Trash2,
} from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { REPORT_SNAPSHOT_KIND_LABELS } from '@/lib/domain/disclosure-status';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { XBRL_EXPORT_ERROR_MESSAGES, type XbrlExportErrorCode } from '@/lib/services/xbrl-export';
import {
  FILING_IDENTIFIER_PATTERNS,
  XBRL_PERIOD_ROLE_LABELS,
  excludedReasonLimit,
  loadXbrlTab,
  parsePeriodRole,
  type XbrlMappingRow,
} from '@/lib/services/xbrl-tagging';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { XBRL_MAPPING_STATES, type XbrlMappingState } from '@/lib/ui/status/xbrlMapping';
import { FILING_IDENTIFIER_SCHEME_LABELS } from '@/lib/xbrl/context';
import { XBRL_RULES, XBRL_RULE_IDS, XBRL_SEVERITY_LABELS } from '@/lib/xbrl/rules';
import {
  NOT_FILING_READY_NOTICE,
  SAMPLE_TAXONOMY_NOTICE,
  SIMPLE_CHECK_NOTICE,
} from '@/lib/xbrl/sample-taxonomy';
import {
  XBRL_LEGAL_STATUS_LABELS,
  XBRL_LICENSE_STATUS_LABELS,
  XBRL_PROFILE_LABELS,
  axesOf,
  valueConceptsOf,
} from '@/lib/xbrl/taxonomy';
import { MAPPED_UNIT_EXAMPLES } from '@/lib/xbrl/unit-map';
import { entityLabel } from '@/lib/xbrl/xbrl-json';
import {
  confirmXbrlMappingsAction,
  deleteXbrlMappingAction,
  excludeXbrlMappingAction,
  restoreXbrlMappingAction,
  saveFilingIdentifierAction,
  setXbrlTaxonomyAction,
  suggestXbrlMappingsAction,
} from '../xbrl/actions';
import { XbrlConfirmBulkBar } from '../xbrl/_components/confirm-bulk-bar';
import { MappingForm, type MappingFormValues } from '../xbrl/_components/mapping-form';

/**
 * 開示プロジェクトの「XBRL」タブ（トライアル対応 NF-42 Stage 1・K3: 出力の右。plan §2.7）。
 *
 * - 先頭にパッケージ名と誠実さのバッジ（SAMPLE・提出用ではない）と注記（折りたたまない）
 * - 指標の帯: 対応付け（確定・候補・対象外）・未対応付けの対象・検証のエラーと警告・事実の追跡（分母付き）
 * - 一覧（DataTable）: 要求事項／T4D の対象／概念／期間／単位・decimals／軸／状態／検証。行: 編集・対象外・
 *   削除・確定。一括「選択した対応付けを確定」は承認権限者の主操作（行を選んだときだけ出る）。それ以外の人に
 *   主操作は無い
 * - 事実と検証は表示のたびに同じ純関数で作る（書き込みなし）。出力は社内確認用だけ（出力の権限）
 * - スナップショットが無ければ出力タブへの空状態
 */

type SearchParams = Record<string, string | string[] | undefined>;

function param(searchParams: SearchParams, key: string): string | null {
  const value = searchParams[key];
  return typeof value === 'string' ? value : null;
}

const RESULT_MESSAGES: Record<string, (params: SearchParams) => string> = {
  saved: () =>
    'XBRL の対応付けを「候補」として保存しました。承認権限を持つ別の人が確定すると事実になります。',
  updated: () =>
    'XBRL の対応付けを変更しました（候補に戻りました）。承認権限を持つ別の人が確定し直します。',
  confirmed: (p) => {
    const n = Number(param(p, 'n') ?? '0');
    const skipped = Number(param(p, 'skipped') ?? '0');
    return `対応付けを ${n} 件確定しました。${skipped > 0 ? `確定できなかった ${skipped} 件は理由（職務分離・精度や軸の未設定など）を確かめてください。` : ''}`;
  },
  excluded: () => '対応付けを対象外にしました（理由を記録しました）。',
  restored: () => '対象外を取り消し、候補に戻しました。',
  deleted: () => '対応付けを削除しました（履歴は残ります）。',
  suggested: (p) =>
    `AI${param(p, 'ai') === 'mock' ? '（デモ生成・Mock）' : ''}の候補から対応付けの候補を ${param(p, 'n') ?? '0'} 件作りました。精度・軸を確かめ、承認権限を持つ別の人が確定するまで事実になりません。`,
  taxonomy: () => '基準の XBRL のタクソノミを変更しました。',
  identifier: () => '提出者の識別子を保存しました。',
};

function isExportErrorCode(value: string | null): value is XbrlExportErrorCode | 'not_found' {
  return value !== null && value in XBRL_EXPORT_ERROR_MESSAGES;
}

function StateBadge({ row }: { row: XbrlMappingRow }) {
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusBadge domain="xbrlMapping" value={row.state} />
      {row.origin === 'ai_adopted' && <HonestyBadge kind="ai-candidate" />}
      {row.origin === 'ai_adopted' && row.aiProvider === 'mock' && <HonestyBadge kind="mock-ai" />}
    </span>
  );
}

function ValidationBadge({ row }: { row: XbrlMappingRow }) {
  if (row.validation === null) return <span className="text-caption text-ink-muted">—</span>;
  return <StatusBadge domain="xbrlValidation" value={row.validation} />;
}

export async function XbrlTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: SearchParams;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const model = await loadXbrlTab(db, ctx, {
    projectId,
    snapshotId: param(searchParams, 'snapshot'),
    frameworkVersionId: param(searchParams, 'fw'),
  });
  const base = `/enterprise/disclosure-projects/${projectId}`;
  const { permissions, pkg, evaluation, snapshot } = model;
  const result = param(searchParams, 'xbrlResult');
  const exportError = param(searchParams, 'xbrlError');
  const snapshotId = snapshot?.id ?? null;
  const fw = model.frameworkVersionId;

  const hidden = (extra: Record<string, string> = {}) => ({
    projectId,
    ...(snapshotId ? { snapshot: snapshotId } : {}),
    ...(fw ? { fw } : {}),
    ...extra,
  });
  const tabParams = new URLSearchParams({ tab: 'xbrl' });
  if (param(searchParams, 'snapshot') && snapshotId) tabParams.set('snapshot', snapshotId);
  if (param(searchParams, 'fw') && fw) tabParams.set('fw', fw);
  const tabHref = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(tabParams);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `${base}?${p.toString()}`;
  };
  const apiHref = (format: 'xbrl_json' | 'ixbrl_html' | 'trace_csv', download = false) => {
    const query = new URLSearchParams({ format, audience: 'internal', project: projectId });
    if (fw) query.set('framework', fw);
    if (download) query.set('download', '1');
    return `/api/exports/xbrl/${encodeURIComponent(snapshotId ?? '')}?${query.toString()}`;
  };

  const notices = (
    <>
      {result && RESULT_MESSAGES[result] && (
        <Notice tone="success" role="status">
          {RESULT_MESSAGES[result](searchParams)}
        </Notice>
      )}
      {isExportErrorCode(exportError) && (
        <Notice tone="danger" role="alert">
          {XBRL_EXPORT_ERROR_MESSAGES[exportError]}
        </Notice>
      )}
    </>
  );

  // 誠実さの注記（常に見える場所に置く。折りたたまない）
  const honesty = (
    <div
      role="note"
      data-xbrl-honesty=""
      className="space-y-1 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-small text-ink"
    >
      <p className="flex flex-wrap items-center gap-1.5">
        <FileCode2 className="size-3.5 text-warning-ink" aria-hidden="true" />
        <span className="font-semibold">
          {pkg ? `${pkg.name}（${pkg.versionLabel}）` : 'XBRL（社内確認用）'}
        </span>
        {(pkg?.isSample ?? true) && <HonestyBadge kind="sample-master" />}
        <HonestyBadge kind="not-filing-ready" />
      </p>
      <p>{NOT_FILING_READY_NOTICE}</p>
      {(pkg?.isSample ?? true) && <p>{SAMPLE_TAXONOMY_NOTICE}</p>}
      <p>{SIMPLE_CHECK_NOTICE}</p>
    </div>
  );

  if (!snapshot) {
    return (
      <div className="space-y-3">
        {notices}
        {honesty}
        <EmptyState
          kind="no-data"
          icon={<FileCode2 className="size-6" aria-hidden="true" />}
          title="スナップショットがありません"
          description="XBRL の事実は、出力タブで作るスナップショット（レビュー用草稿・社内承認済み版）だけから作ります。先にスナップショットを作ってください。"
          action={
            <Link href={`${base}?tab=outputs`} className="text-small text-brand-800 underline">
              出力タブを開く
            </Link>
          }
        />
      </div>
    );
  }

  const blocking = evaluation?.validation.blocking ?? false;
  const exportDisabled = !model.integrityOk
    ? 'スナップショットの内容ハッシュが一致しないため出力できません'
    : !evaluation
      ? 'この基準に XBRL のタクソノミが設定されていません（下の「基準とタクソノミ」）'
      : blocking
        ? `検証のエラーが ${evaluation.validation.counts.error} 件あるため出力できません（下の「検証の結果」）`
        : undefined;
  const conceptGroups = pkg ? valueConceptsOf(pkg) : { numeric: [], textBlocks: [] };
  const axes = pkg ? axesOf(pkg) : [];

  // ---- 一覧（状態の絞り込み・検索・ページ送り。すべて URL） ----
  const stateFilter = param(searchParams, 'state');
  const query = (param(searchParams, 'q') ?? '').trim().toLowerCase();
  const filteredRows = model.rows.filter((row) => {
    if (stateFilter && XBRL_MAPPING_STATES.includes(stateFilter as XbrlMappingState)) {
      if (row.state !== stateFilter) return false;
    }
    if (!query) return true;
    return [
      row.targetLabel,
      row.targetDetail,
      row.concept?.labelJa ?? '',
      row.conceptQName ?? '',
      ...row.requirements.map((r) => r.code),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(filteredRows.length / pageSize)),
  );
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  const columns: DataTableColumn<XbrlMappingRow>[] = [
    {
      key: 'requirement',
      header: '要求事項',
      importance: 'primary',
      pinned: 'left',
      cell: (row) => (
        <span className="whitespace-nowrap text-small font-medium">
          {row.requirements.length > 0 ? row.requirements.map((r) => r.code).join('・') : '—'}
        </span>
      ),
    },
    {
      key: 'target',
      header: 'T4D の対象',
      importance: 'primary',
      lockVisible: true,
      width: 'md',
      cell: (row) => (
        <span className="text-small">
          <span className="block font-medium text-ink">{row.targetLabel}</span>
          <span className="block text-caption text-ink-muted">{row.targetDetail}</span>
        </span>
      ),
    },
    {
      key: 'concept',
      header: '概念',
      importance: 'primary',
      width: 'md',
      cell: (row) =>
        row.concept ? (
          <span className="text-small">
            <span className="block">{row.concept.labelJa}</span>
            <code className="block text-caption text-ink-muted">{row.conceptQName}</code>
          </span>
        ) : (
          <span className="text-caption text-ink-muted">未対応付け</span>
        ),
    },
    {
      key: 'period',
      header: '期間',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">
          {XBRL_PERIOD_ROLE_LABELS[row.periodRole]}
          {row.concept?.periodType && (
            <span className="block text-caption text-ink-muted">
              {row.concept.periodType === 'instant' ? '時点' : '期間'}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'unit',
      header: '単位・decimals',
      importance: 'secondary',
      cell: (row) =>
        row.targetKind === 'metric' && row.mapping ? (
          <span className="whitespace-nowrap text-small">
            {row.measure ?? '換算できない単位'}
            <span className="block text-caption text-ink-muted">
              decimals {row.decimals ?? '未設定'}
            </span>
          </span>
        ) : (
          <span className="text-caption text-ink-muted">—</span>
        ),
    },
    {
      key: 'dimensions',
      header: '軸',
      importance: 'secondary',
      cell: (row) =>
        row.dimensionLabels.length > 0 ? (
          <ul className="text-caption">
            {row.dimensionLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        ) : (
          <span className="text-caption text-ink-muted">—</span>
        ),
    },
    {
      key: 'state',
      header: '状態',
      importance: 'primary',
      cell: (row) => <StateBadge row={row} />,
    },
    {
      key: 'validation',
      header: '検証',
      importance: 'primary',
      cell: (row) => <ValidationBadge row={row} />,
    },
    {
      key: 'confirmedBy',
      header: '確定者・日時',
      importance: 'detail',
      cell: (row) =>
        row.confirmedByName ? (
          <span className="text-caption">
            {row.confirmedByName}
            <span className="block text-ink-muted">{formatJst(row.confirmedAt)}</span>
          </span>
        ) : (
          <span className="text-caption text-ink-muted">—</span>
        ),
    },
    {
      key: 'createdBy',
      header: '作成者',
      importance: 'detail',
      cell: (row) => <span className="text-caption">{row.createdByName ?? '—'}</span>,
    },
  ];

  const limit = excludedReasonLimit(db);
  const rowActions = (row: XbrlMappingRow) => {
    const m = row.mapping;
    if (!m) {
      // 未対応付けの対象: 対応付けを作る（作成パネルに対象を入れて開く）
      if (!permissions.canWrite || !pkg || !row.targetKey) return null;
      return {
        rowLabel: row.targetLabel,
        primary: {
          kind: 'link' as const,
          id: `map-${row.id}`,
          label: '対応付ける',
          icon: <Link2 aria-hidden="true" />,
          href: tabHref({ new: '1', target: row.targetKey, role: row.periodRole }),
        },
      };
    }
    const scope = `${row.targetLabel} ⇄ ${row.concept?.labelJa ?? '概念不明'}`;
    const items: MenuActionSpec[] = [
      {
        kind: 'link',
        id: `edit-${m.id}`,
        label: '編集',
        icon: <Pencil aria-hidden="true" />,
        href: tabHref({ edit: '1', mapping: m.id }),
        hidden: !permissions.canWrite,
      },
      {
        kind: 'confirm',
        id: `exclude-${m.id}`,
        label: '対象外にする…',
        icon: <Ban aria-hidden="true" />,
        action: excludeXbrlMappingAction,
        fields: hidden({ mappingId: m.id }),
        hidden: !permissions.canWrite || m.status === 'excluded',
        confirm: {
          tier: 'bulk',
          title: 'この対応付けを対象外にしますか',
          scope,
          consequences: [
            '対象外の対応付けは事実になりません。理由は履歴と監査ログに残ります。',
            '確定済みの場合は確定が外れます（取り消すと候補に戻ります）。',
          ],
          reason: { name: 'reason', label: '対象外にする理由', required: true, maxLength: limit },
          confirmLabel: '対象外にする',
        },
      },
      {
        kind: 'confirm',
        id: `delete-${m.id}`,
        label: '削除…',
        icon: <Trash2 aria-hidden="true" />,
        destructive: true,
        action: deleteXbrlMappingAction,
        fields: hidden({ mappingId: m.id }),
        hidden: !permissions.canWrite,
        confirm: {
          tier: 'irreversible',
          title: 'この対応付けを削除しますか',
          scope,
          consequences: [
            '一覧から消え、事実になりません（画面からは元に戻せません）。',
            '作成・確定などの履歴は追記専用の記録に残ります。',
          ],
          confirmLabel: '削除する',
        },
      },
    ];
    const canConfirmRow =
      permissions.canApprove && m.status === 'candidate' && row.confirmBlockedReason === null;
    const primary =
      m.status === 'excluded'
        ? {
            kind: 'submit' as const,
            id: `restore-${m.id}`,
            label: '対象外を取り消す',
            icon: <RotateCcw aria-hidden="true" />,
            action: restoreXbrlMappingAction,
            fields: hidden({ mappingId: m.id }),
            hidden: !permissions.canWrite,
          }
        : m.status === 'candidate' && permissions.canApprove
          ? {
              kind: 'confirm' as const,
              id: `confirm-${m.id}`,
              label: '確定…',
              icon: <BadgeCheck aria-hidden="true" />,
              action: confirmXbrlMappingsAction,
              fields: hidden({ mappingId: m.id }),
              disabledReason: canConfirmRow ? undefined : (row.confirmBlockedReason ?? undefined),
              confirm: {
                tier: 'bulk' as const,
                title: 'この対応付けを確定しますか',
                scope,
                consequences: [
                  '確定した対応付けだけが XBRL の事実になります。',
                  '確定後に内容を変えると候補に戻ります。出力は社内確認用で、提出用ではありません。',
                ],
                confirmLabel: '確定する',
              },
            }
          : undefined;
    return { rowLabel: row.targetLabel, primary, items };
  };

  // ---- 作成・編集のパネル ----
  const newOpen = permissions.canWrite && pkg && isCreatePanelOpen(searchParams);
  const editOpen = permissions.canWrite && pkg && isCreatePanelOpen(searchParams, 'edit');
  const editing = editOpen
    ? (model.rows.find((r) => r.mapping?.id === param(searchParams, 'mapping'))?.mapping ?? null)
    : null;
  const prefillTarget = param(searchParams, 'target');
  const newValues: MappingFormValues = {
    mappingId: null,
    targetKey: model.targetOptions.some((o) => o.key === prefillTarget) ? prefillTarget : null,
    conceptId: null,
    disclosureItemId: null,
    periodRole: parsePeriodRole(param(searchParams, 'role')),
    decimals: null,
    dimensions: {},
    resetsDecision: false,
  };
  const editRow = editing ? model.rows.find((r) => r.mapping?.id === editing.id) : undefined;
  const editValues: MappingFormValues | null = editing
    ? {
        mappingId: editing.id,
        targetKey: editRow?.targetKey ?? null,
        conceptId: editing.conceptId,
        disclosureItemId: editing.disclosureItemId,
        periodRole: editing.periodRole,
        decimals: editing.decimals,
        dimensions: editing.dimensions,
        resetsDecision: editing.status !== 'candidate',
      }
    : null;
  // 編集する行の対象が表示中のスナップショットに無い（別の年度の節など）ときも選べるようにする
  const editTargetOptions =
    editValues?.targetKey && !model.targetOptions.some((o) => o.key === editValues.targetKey)
      ? [
          ...model.targetOptions,
          {
            key: editValues.targetKey,
            kind: editing!.targetKind === 'block' ? ('block' as const) : ('metric' as const),
            label: `${editRow?.targetLabel ?? '対象'}（このスナップショットに無い対象）`,
            periodRole: editing!.periodRole,
            requirementItemIds: [],
          },
        ]
      : model.targetOptions;

  const counts = model.counts;
  const validation = evaluation?.validation ?? null;
  const trace = evaluation?.trace ?? { traceable: 0, total: 0 };

  return (
    <div className="space-y-3">
      {notices}
      {honesty}

      {!model.integrityOk && (
        <Notice tone="danger" role="alert">
          このスナップショットは保存後に内容ハッシュが一致しないため、XBRL
          の事実を作りません。出力タブで作り直してください。
        </Notice>
      )}

      <div className="flex flex-wrap items-end justify-between gap-2">
        <form method="get" action={base} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="xbrl" />
          <Field label="スナップショット" id="xbrl-snapshot">
            {(control) => (
              <NativeSelect
                {...control}
                name="snapshot"
                size="xs"
                defaultValue={snapshot.id}
                className="w-field-md"
              >
                {model.snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    No.{s.snapshotNo} {REPORT_SNAPSHOT_KIND_LABELS[s.kind]}（
                    {formatJstDate(s.createdAt)}）
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {snapshot.frameworkVersions.length > 1 && (
            <Field label="基準" id="xbrl-framework">
              {(control) => (
                <NativeSelect
                  {...control}
                  name="fw"
                  size="xs"
                  defaultValue={fw ?? ''}
                  className="w-field-md"
                >
                  {snapshot.frameworkVersions.map((f) => (
                    <option key={f.frameworkVersionId} value={f.frameworkVersionId}>
                      {f.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          <SubmitButton size="xs" variant="secondary">
            表示を切り替える
          </SubmitButton>
        </form>
        <PageActions
          secondary={[
            {
              kind: 'link',
              id: 'xbrl-new-mapping',
              label: '対応付けを追加',
              icon: <Plus aria-hidden="true" />,
              href: tabHref({ new: '1' }),
              hidden: !permissions.canWrite || !pkg,
              shortcut: 'new',
            },
            {
              kind: 'link',
              id: 'xbrl-preview',
              label: 'インライン XBRL プレビュー（社内確認用）',
              icon: <FileCode2 aria-hidden="true" />,
              href: apiHref('ixbrl_html'),
              external: true,
              hidden: !permissions.canExport,
              disabledReason: exportDisabled,
            },
          ]}
          more={[
            {
              kind: 'link',
              id: 'xbrl-json',
              label: 'XBRL（xBRL-JSON・社内確認用）を出力',
              icon: <FileJson aria-hidden="true" />,
              href: apiHref('xbrl_json'),
              external: true,
              group: 'export',
              hidden: !permissions.canExport,
              disabledReason: exportDisabled,
            },
            {
              kind: 'link',
              id: 'xbrl-ixbrl-download',
              label: 'インライン XBRL を保存（HTML・社内確認用）',
              icon: <Download aria-hidden="true" />,
              href: apiHref('ixbrl_html', true),
              external: true,
              group: 'export',
              hidden: !permissions.canExport,
              disabledReason: exportDisabled,
            },
            {
              kind: 'link',
              id: 'xbrl-trace-csv',
              label: '照合表（CSV・社内確認用）を出力',
              icon: <Table2 aria-hidden="true" />,
              href: apiHref('trace_csv'),
              external: true,
              group: 'export',
              hidden: !permissions.canExport,
              disabledReason: exportDisabled,
            },
            {
              kind: 'submit',
              id: 'xbrl-ai-suggest',
              label: 'AI に対応付けの候補を出させる',
              icon: <Sparkles aria-hidden="true" />,
              action: suggestXbrlMappingsAction,
              fields: hidden(),
              pendingLabel: '候補を作成中…',
              group: 'advanced',
              hidden: !permissions.canRunAi || !pkg,
              disabledReason: counts.unmapped === 0 ? '未対応付けの対象がありません' : undefined,
            },
          ]}
        />
      </div>

      {pkg && evaluation && (
        <MetricStrip label="XBRL の対応付けと検証">
          <MetricTile
            label="確定"
            value={counts.confirmed}
            denominator={counts.mappings}
            hint="確定した対応付けだけが事実になります"
            href={tabHref({ state: 'confirmed' })}
          />
          <MetricTile
            label="候補"
            value={counts.candidate}
            denominator={counts.mappings}
            hint="承認権限を持つ別の人の確定待ち"
            href={tabHref({ state: 'candidate' })}
          />
          <MetricTile
            label="対象外"
            value={counts.excluded}
            denominator={counts.mappings}
            href={tabHref({ state: 'excluded' })}
          />
          <MetricTile
            label="未対応付けの対象"
            value={counts.unmapped}
            denominator={counts.targets}
            hint="本文の節と、本文が引用した数値"
            status={
              counts.unmapped > 0 ? { semantic: 'todo', label: '対応付けがありません' } : undefined
            }
            href={tabHref({ state: 'unmapped' })}
          />
          <MetricTile
            label="検証のエラー・警告"
            value={`${validation!.counts.error}・${validation!.counts.warning}`}
            hint={`規則 ${XBRL_RULE_IDS.length} 件（T4D の簡易検査）・注記 ${validation!.counts.note} 件`}
            status={
              validation!.counts.error > 0
                ? { semantic: 'error', label: '出力できません' }
                : validation!.counts.warning > 0
                  ? { semantic: 'blocked', label: '警告あり' }
                  : { semantic: 'done', label: 'エラーなし' }
            }
          />
          <MetricTile
            label="事実の追跡"
            value={trace.traceable}
            denominator={trace.total}
            hint="版（承認済み）・要求事項・引用した節まで遡れる事実"
          />
        </MetricStrip>
      )}

      {!pkg && (
        <Notice tone="warning">
          表示中の基準に XBRL
          のタクソノミが設定されていないため、事実と検証を作れません。下の「基準とタクソノミ」で設定してください。
        </Notice>
      )}

      {newOpen && pkg && (
        <CreatePanel
          id="xbrl-new-panel"
          title="XBRL の対応付けを追加（候補）"
          searchParams={searchParams}
          closeHref={createPanelHref(base, searchParams, { open: false })}
          description="保存すると「候補」になります。承認権限を持つ、作った人と別の人が確定すると事実になります。"
        >
          <MappingForm
            projectId={projectId}
            packageId={pkg.id}
            snapshotId={snapshotId}
            frameworkVersionId={fw}
            targetOptions={model.targetOptions}
            numericConcepts={conceptGroups.numeric}
            textBlockConcepts={conceptGroups.textBlocks}
            axes={axes}
            requirementOptions={model.requirementOptions}
            values={newValues}
          />
        </CreatePanel>
      )}
      {editOpen && pkg && editValues && (
        <CreatePanel
          id="xbrl-edit-panel"
          title="XBRL の対応付けを編集"
          openParam="edit"
          searchParams={searchParams}
          closeHref={createPanelHref(base, searchParams, { open: false, openParam: 'edit' })}
        >
          <MappingForm
            projectId={projectId}
            packageId={pkg.id}
            snapshotId={snapshotId}
            frameworkVersionId={fw}
            targetOptions={editTargetOptions}
            numericConcepts={conceptGroups.numeric}
            textBlockConcepts={conceptGroups.textBlocks}
            axes={axes}
            requirementOptions={model.requirementOptions}
            values={editValues}
          />
        </CreatePanel>
      )}

      {pkg && (
        <DataTable
          id="xbrl-mappings"
          caption={`XBRL の対応付け（${filteredRows.length} 件）`}
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.targetLabel}
          getRowStatus={(row) =>
            row.state === 'unmapped'
              ? '未対応付け'
              : row.state === 'candidate'
                ? '候補'
                : row.state === 'confirmed'
                  ? '確定'
                  : '対象外'
          }
          searchParams={searchParams}
          basePath={base}
          filters={[
            {
              key: 'state',
              label: '状態',
              options: [
                { value: 'unmapped', label: '未対応付け' },
                { value: 'candidate', label: '候補' },
                { value: 'confirmed', label: '確定' },
                { value: 'excluded', label: '対象外' },
              ],
            },
          ]}
          search={{ placeholder: '対象・概念・要求事項コードで検索' }}
          page={{ page, pageSize, total: filteredRows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          selection={
            permissions.canApprove
              ? {
                  formId: 'xbrl-confirm-form',
                  isSelectable: (row) =>
                    row.state === 'candidate' && row.confirmBlockedReason === null,
                }
              : undefined
          }
          bulkBar={
            permissions.canApprove ? (
              <XbrlConfirmBulkBar
                formId="xbrl-confirm-form"
                projectId={projectId}
                snapshotId={snapshotId}
                frameworkVersionId={fw}
              />
            ) : undefined
          }
          rowActions={rowActions}
          expand={(row) => {
            const lines: ReactNode[] = [];
            for (const f of row.findings) {
              lines.push(
                <li key={`${f.rule}-${f.message}`} className="flex items-start gap-1.5">
                  <StatusBadge
                    domain="xbrlValidation"
                    value={f.severity === 'note' ? 'note' : f.severity}
                  />
                  <span>
                    {f.rule}: {f.message}
                  </span>
                </li>,
              );
            }
            if (row.mapping?.status === 'excluded' && row.mapping.excludedReason) {
              lines.push(<li key="excluded">対象外の理由: {row.mapping.excludedReason}</li>);
            }
            if (
              row.mapping?.status === 'candidate' &&
              permissions.canApprove &&
              row.confirmBlockedReason
            ) {
              lines.push(<li key="blocked">確定できない理由: {row.confirmBlockedReason}</li>);
            }
            if (row.origin === 'ai_adopted') {
              lines.push(
                <li key="ai">
                  AI
                  が出した候補です。精度・軸を確かめ、承認権限を持つ別の人が確定するまで事実になりません。
                </li>,
              );
            }
            return lines.length === 0 ? null : <ul className="space-y-1 text-ink">{lines}</ul>;
          }}
          empty={{
            noData: {
              title: '対応付けの対象がありません',
              description:
                'スナップショットの本文に節・数値がありません。原稿を作ってからスナップショットを作り直してください。',
              action: (
                <Link
                  href={`${base}?tab=manuscripts`}
                  className="text-small text-brand-800 underline"
                >
                  原稿タブを開く
                </Link>
              ),
            },
            filtered: { title: '条件に当たる対応付けはありません' },
          }}
        />
      )}

      {validation && (
        <Section
          title="検証の結果（T4D の簡易検査）"
          summary={`エラー ${validation.counts.error}・警告 ${validation.counts.warning}・注記 ${validation.counts.note}`}
          divider="none"
        >
          <p className="mb-1 text-caption text-ink-muted">
            {SIMPLE_CHECK_NOTICE}エラーがあると出力できません。
          </p>
          {validation.findings.length === 0 ? (
            <p className="text-small text-ink">指摘はありません。</p>
          ) : (
            <ul className="space-y-1 text-small" data-xbrl-findings="">
              {validation.findings.map((f, index) => (
                <li key={`${f.rule}-${index}`} className="flex items-start gap-1.5">
                  <StatusBadge domain="xbrlValidation" value={f.severity} />
                  <span>
                    <span className="font-medium">{f.rule}</span> {f.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <MoreInfo label="規則の一覧（V01〜V16）">
            <ul className="space-y-0.5">
              {XBRL_RULE_IDS.map((rule) => (
                <li key={rule} className="flex items-start gap-1.5">
                  {validation.byRule[rule] === 'passed' ? (
                    <StatusBadge domain="xbrlValidation" value="passed" />
                  ) : (
                    <StatusBadge
                      domain="xbrlValidation"
                      value={validation.byRule[rule] as 'error' | 'warning' | 'note'}
                    />
                  )}
                  <span>
                    {rule}: {XBRL_RULES[rule].title}（既定の重大度:{' '}
                    {XBRL_SEVERITY_LABELS[XBRL_RULES[rule].severity]}）
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1">
              換算できる単位: {MAPPED_UNIT_EXAMPLES.join('・')}。表に無い単位は換算しません（V03）。
            </p>
          </MoreInfo>
        </Section>
      )}

      {evaluation && (
        <Collapsible
          id="xbrl-facts"
          summary={`事実の一覧（${evaluation.built.facts.length} 件・追跡 ${trace.traceable} / ${trace.total}）`}
          variant="card"
        >
          {evaluation.built.facts.length === 0 ? (
            <p className="text-small text-ink-muted">
              事実はありません（確定した対応付けがありません）。
            </p>
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <caption className="sr-only">XBRL の事実</caption>
                <THead>
                  <TR>
                    <TH>概念</TH>
                    <TH>値</TH>
                    <TH>期間</TH>
                    <TH>単位・decimals</TH>
                    <TH>出所</TH>
                    <TH>要求事項</TH>
                  </TR>
                </THead>
                <TBody>
                  {evaluation.built.facts.map((fact) => (
                    <TR key={fact.id}>
                      <TD className="text-small">
                        {fact.concept.labelJa}
                        <code className="block text-caption text-ink-muted">{fact.qname}</code>
                      </TD>
                      <TD className="text-small">
                        {fact.numeric
                          ? `${fact.displayNumber ?? fact.value}${fact.source.kind === 'metric' ? ` ${fact.source.unitOfMeasure}` : ''}`
                          : `テキストブロック（${fact.source.kind === 'block' ? fact.source.paragraphCount : 0} 段落）`}
                      </TD>
                      <TD className="whitespace-nowrap text-caption">
                        {fact.period.type === 'instant'
                          ? `${formatJstDate(fact.period.instant)} 時点`
                          : `${formatJstDate(fact.period.start)}〜${formatJstDate(fact.period.end)}`}
                      </TD>
                      <TD className="text-caption">
                        {fact.unit ? fact.unit.measure : '—'}
                        {fact.decimals !== null && (
                          <span className="block text-ink-muted">decimals {fact.decimals}</span>
                        )}
                      </TD>
                      <TD className="text-caption">
                        {fact.source.kind === 'metric' ? (
                          <Link
                            href={`/enterprise/data/${fact.source.dataPointId}`}
                            className="text-brand-800 underline"
                          >
                            数値の版 {fact.source.versionNo}: {fact.source.metricName}（
                            {fact.source.unitName}・{fact.source.periodCode}）
                          </Link>
                        ) : (
                          <Link
                            href={`${base}/blocks/${fact.source.blockId}`}
                            className="text-brand-800 underline"
                          >
                            節の版 {fact.source.versionNo ?? '—'}: {fact.source.title}
                          </Link>
                        )}
                        <span className="block text-ink-muted">
                          {fact.traceable ? '遡れる' : '遡れない（未承認・要求事項なし）'}
                        </span>
                      </TD>
                      <TD className="text-caption">
                        {fact.requirements.length === 0 ? (
                          '—'
                        ) : (
                          <ul>
                            {fact.requirements.map((r) => (
                              <li key={r.itemId}>
                                <Link
                                  href={`${base}/requirements/${r.itemId}`}
                                  className="text-brand-800 underline"
                                >
                                  {r.code}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Collapsible>
      )}

      <Section title="基準とタクソノミ" divider="none">
        <ul className="space-y-1.5 text-small" data-xbrl-frameworks="">
          {model.frameworks.map((f) => (
            <li key={f.projectFrameworkId} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{f.label}</span>
              <span className="text-ink-muted">→</span>
              {f.packageName ? (
                <span>{f.packageName}</span>
              ) : f.packageOptions.length === 0 ? (
                <span className="text-ink-muted">
                  この基準の XBRL
                  タクソノミは公表されていないか、まだ読み込んでいません（今後対応）。
                </span>
              ) : (
                <span className="text-ink-muted">未設定</span>
              )}
              {permissions.canWrite && f.packageOptions.length > 0 && (
                <form action={setXbrlTaxonomyAction} className="flex items-center gap-1">
                  {Object.entries(hidden({ projectFrameworkId: f.projectFrameworkId })).map(
                    ([k, v]) => (
                      <input key={k} type="hidden" name={k} value={v} />
                    ),
                  )}
                  <NativeSelect
                    name="packageId"
                    size="xs"
                    defaultValue={f.packageId ?? ''}
                    aria-label={`${f.label} の XBRL タクソノミ`}
                    className="w-field-md"
                  >
                    <option value="">設定しない</option>
                    {f.packageOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <SubmitButton size="xs" variant="secondary" pendingLabel="保存中…">
                    設定する
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        {pkg && (
          <p className="mt-1 text-caption text-ink-muted">
            表示中のタクソノミ: {XBRL_PROFILE_LABELS[pkg.profile]}・
            {XBRL_LEGAL_STATUS_LABELS[pkg.legalStatus]}・
            {XBRL_LICENSE_STATUS_LABELS[pkg.licenseStatus]}。{pkg.licenseNote}
          </p>
        )}
      </Section>

      <Section title="提出者の識別子" divider="none">
        <p className="text-small">
          {model.entity
            ? `出力に使う識別子: ${entityLabel(model.entity)}${model.entity.isSample ? '（架空）' : ''}`
            : model.identifiers.length > 0
              ? 'このタクソノミに使える識別子がありません（SAMPLE には架空の識別子だけを使います）。'
              : '提出者の識別子がありません（検証の V11 で知らせます）。'}
        </p>
        {model.identifiers.length > 0 && (
          <ul className="mt-1 text-caption text-ink-muted">
            {model.identifiers.map((i) => (
              <li key={i.id}>
                {FILING_IDENTIFIER_SCHEME_LABELS[i.scheme]}: {i.value}（
                {i.verifiedAt ? `確認 ${formatJst(i.verifiedAt)}` : '未確認'}）
              </li>
            ))}
          </ul>
        )}
        {model.demoMode ? (
          <p className="mt-1 text-caption text-ink-muted">
            デモでは架空（サンプル）の識別子だけを使い、変更できません（実在の EDINET
            コード・LEI・法人番号をデモに置かないため）。
          </p>
        ) : permissions.canManageOrg ? (
          <PreservingForm
            action={saveFilingIdentifierAction}
            className="mt-2 flex flex-wrap items-end gap-2 text-small"
            aria-label="提出者の識別子を保存"
          >
            {Object.entries(hidden()).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <Field label="識別子の種類" id="xbrl-identifier-scheme" required>
              {(control) => (
                <NativeSelect {...control} name="scheme" size="xs" defaultValue="edinet_code">
                  {(
                    Object.keys(FILING_IDENTIFIER_PATTERNS) as Array<
                      keyof typeof FILING_IDENTIFIER_PATTERNS
                    >
                  ).map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {FILING_IDENTIFIER_SCHEME_LABELS[scheme]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field
              label="識別子"
              id="xbrl-identifier-value"
              required
              hint="EDINET コードは E＋5 桁、LEI は 20 桁、法人番号は 13 桁"
            >
              {(control) => (
                <Input {...control} name="value" maxLength={64} className="w-field-sm" />
              )}
            </Field>
            <SubmitButton size="xs" variant="secondary" pendingLabel="保存中…">
              識別子を保存
            </SubmitButton>
          </PreservingForm>
        ) : (
          <p className="mt-1 text-caption text-ink-muted">
            識別子の登録・変更は企業の管理者が行います。
          </p>
        )}
      </Section>
    </div>
  );
}
