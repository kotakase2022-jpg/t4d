import Link from 'next/link';
import { Bot, Lock, Snowflake } from 'lucide-react';
import { ReadOnlyBadge } from '@/components/shared/badges';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  detectSnapshotChanges,
  loadDataRoom,
  loadEngagementOr404,
  recordDataRoomView,
  type DataRoomReportRow,
  type DataRoomRow,
} from '@/lib/services/assurance';
import {
  assessSnapshotChangeAction,
  createSnapshotAction,
  summarizeChangesAction,
} from '../../../actions';
import {
  ASSESSMENT_OPTIONS,
  CHANGE_KIND_LABEL,
  assessmentEntry,
} from '../../../_components/labels';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'Data Room' };

type SearchParams = Record<string, string | string[] | undefined>;

/** Data Room の 1 行（取得元: 非財務データ／開示レポート） */
type DataRoomTableRow =
  { kind: 'data_point'; row: DataRoomRow } | { kind: 'report'; report: DataRoomReportRow };

export default async function DataRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const basePath = `/assurance/engagements/${engagementId}/data-room`;

  // 行は許諾と承認から読み取り時に導出する（NF-22。企業が許諾を足す・承認すると次の表示で出る）
  const { rows, snapshot, reports } = await loadDataRoom(db, ctx, engagementId);
  // 閲覧の記録（1 画面 1 件・要約だけ。NF-26）と、この人の前回の表示日時（「前回表示以降」の絞込）
  const { previousViewedAt } = await recordDataRoomView(db, ctx, engagementId, {
    dataPoints: rows.length,
    reports: reports.length,
  });
  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];

  const snapshotItems = snapshot
    ? await db.select('snapshotItems', { where: { snapshotId: snapshot.id } })
    : [];
  const itemByDataPoint = new Map(snapshotItems.map((i) => [i.sourceId, i]));

  const aiRuns = await db.select('aiRuns', {
    where: { engagementId, featureType: 'assuranceChangeSummary' },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 1,
  });
  const latestAi = aiRuns[0];

  const canSnapshot = can(ctx, 'assurance.snapshot.create');
  const canAssess = can(ctx, 'assurance.testing.write');

  // 共有データの検索・絞り込み（URL が正。サーバーで絞る）
  const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const changeFilter = typeof query.change === 'string' ? query.change : null;
  const sourceFilter = typeof query.source === 'string' ? query.source : null;
  // 「前回表示以降に共有された n 件」: URL の since が正。無ければこの人の前回の表示日時を選択肢にする
  const sinceParam =
    typeof query.since === 'string' && !Number.isNaN(Date.parse(query.since)) ? query.since : null;
  const sinceValue = sinceParam ?? previousViewedAt;
  const allRows: DataRoomTableRow[] = [
    ...reports.map((report) => ({ kind: 'report' as const, report })),
    ...rows.map((row) => ({ kind: 'data_point' as const, row })),
  ];
  const sharedAtOf = (entry: DataRoomTableRow) =>
    entry.kind === 'report' ? entry.report.sharedAt : entry.row.sharedAt;
  const newSince = sinceValue
    ? allRows.filter((entry) => Date.parse(sharedAtOf(entry)) > Date.parse(sinceValue))
    : [];
  const tableRows = allRows
    .filter((entry) => (sourceFilter ? entry.kind === sourceFilter : true))
    .filter((entry) =>
      changeFilter === 'changed'
        ? entry.kind === 'data_point' && entry.row.changedSinceSnapshot
        : true,
    )
    .filter((entry) =>
      changeFilter === 'unfixed'
        ? entry.kind === 'data_point' && !entry.row.snapshotIncluded
        : true,
    )
    .filter((entry) => (sinceParam ? Date.parse(sharedAtOf(entry)) > Date.parse(sinceParam) : true))
    .filter((entry) =>
      search === ''
        ? true
        : (entry.kind === 'report'
            ? `${entry.report.label} ${entry.report.frameworkNames.join(' ')} 開示レポート`
            : `${entry.row.metric?.name ?? ''} ${entry.row.unit?.name ?? ''}`
          )
            .toLowerCase()
            .includes(search),
    );
  const reportHref = (copyId: string) => `/assurance/engagements/${engagementId}/reports/${copyId}`;
  const dash = <span className="text-caption text-ink-muted">—</span>;

  const columns: DataTableColumn<DataRoomTableRow>[] = [
    {
      key: 'metric',
      header: '指標',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (entry) =>
        entry.kind === 'report' ? (
          <Link
            href={reportHref(entry.report.copyId)}
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            開示レポート {entry.report.label}
          </Link>
        ) : (
          <span className="font-medium">{entry.row.metric?.name ?? '—'}</span>
        ),
    },
    {
      key: 'unit',
      header: '組織',
      importance: 'primary',
      cell: (entry) =>
        entry.kind === 'report'
          ? entry.report.frameworkNames.join('・') || '—'
          : (entry.row.unit?.name ?? '—'),
    },
    {
      key: 'value',
      header: '現在値',
      importance: 'primary',
      align: 'right',
      cell: (entry) =>
        entry.kind === 'report' ? (
          dash
        ) : (
          <span className="tnum">
            {formatNumber(entry.row.currentValue)}
            <span className="ml-1 text-caption text-ink-muted">
              {entry.row.currentUnitOfMeasure}
            </span>
          </span>
        ),
    },
    {
      key: 'clientStatus',
      header: 'クライアントの承認',
      importance: 'secondary',
      cell: (entry) =>
        entry.kind === 'report' ? (
          <HonestyBadge kind="internal-approval" />
        ) : (
          <StatusBadge domain="dataPoint" value={entry.row.clientStatus as never} />
        ),
    },
    {
      key: 'snapshot',
      header: 'Snapshot',
      importance: 'primary',
      cell: (entry) =>
        entry.kind === 'report' ? (
          // 写しは共有の時点で固定されている（Snapshot の固定の対象ではない）
          <SemanticBadge semantic="info" label="写し（固定済み）" />
        ) : entry.row.snapshotIncluded ? (
          <SemanticBadge semantic="done" label="固定済み" />
        ) : (
          <SemanticBadge semantic="todo" label="未固定" />
        ),
    },
    {
      key: 'change',
      header: '固定後の変更',
      importance: 'primary',
      cell: (entry) =>
        entry.kind === 'data_point' && entry.row.changedSinceSnapshot ? (
          <SemanticBadge semantic="error" label="変更あり" />
        ) : (
          dash
        ),
    },
    {
      key: 'source',
      header: '取得元',
      // 開示レポートの行が混ざるため既定で見せる（以前は常に「非財務データ」で detail だった）
      importance: 'secondary',
      cell: (entry) => (
        <span className="text-caption" data-source={entry.kind}>
          {entry.kind === 'report' ? '開示レポート' : '非財務データ'}
        </span>
      ),
    },
    {
      key: 'version',
      header: '版',
      importance: 'detail',
      align: 'right',
      cell: (entry) =>
        entry.kind === 'report' ? (
          dash
        ) : (
          <span className="tnum">{entry.row.currentVersionNo ?? '—'}</span>
        ),
    },
    {
      key: 'evidence',
      header: '資料',
      importance: 'detail',
      align: 'right',
      cell: (entry) =>
        entry.kind === 'report' ? (
          dash
        ) : (
          <span className="tnum">
            {entry.row.evidenceCount}
            {!entry.row.includesEvidence && entry.row.evidenceCount > 0 && (
              <span className="ml-1 text-caption text-ink-muted">（実体は許諾外）</span>
            )}
          </span>
        ),
    },
    {
      key: 'sharedAt',
      header: '共有日時',
      importance: 'detail',
      cell: (entry) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">
          {formatJst(sharedAtOf(entry))}
        </span>
      ),
    },
  ];

  return (
    <>
      <EngagementHeader
        context={context}
        page="Data Room"
        actions={
          canSnapshot && (
            // 固定は取り消せない（以後の変更は差分として検知される）。範囲を本文に出して確かめる（plan §1.16 区分 1）
            <ConfirmDialog
              tier="irreversible"
              title="Snapshot を固定しますか"
              scope={`${context.engagement.code} の Data Room に共有されている非財務データ ${rows.length} 件の現在値を固定します。`}
              consequences={[
                '固定した値は変更できません（追記専用）。以後のクライアント側の変更は「固定後の変更」として検知されます。',
                '固定した Snapshot から母集団が構成されます。',
                ...(reports.length > 0
                  ? ['開示レポートの写しは共有の時点で固定されているため、対象に含めません。']
                  : []),
              ]}
              extraFields={
                <label className="block space-y-1">
                  <span className="text-small font-medium text-ink">
                    Snapshot ラベル
                    <span className="ml-1 text-caption font-normal text-ink-muted">
                      （任意。空欄なら自動で付けます）
                    </span>
                  </span>
                  <Input name="label" aria-label="Snapshot ラベル" placeholder="例: 期末固定" />
                </label>
              }
              confirmLabel="固定する"
              action={createSnapshotAction}
              fields={{ engagementId }}
              trigger={{
                label: 'Snapshot を固定',
                variant: 'primary',
                icon: <Snowflake aria-hidden="true" />,
              }}
            />
          )
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* クライアント原本は Read-only（誠実さ・安全の注記。折りたたまない） */}
        <Notice tone="info">
          <span className="flex items-start gap-1.5">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              ここに表示されるクライアント原本は <strong>Read-only</strong>{' '}
              です。監査法人側から値を変更することはできません （アプリ層と DB の RLS
              の両方で禁止されています）。監査側の注記・調書・依頼・指摘は別データとして保存されます。
            </span>
          </span>
        </Notice>

        {snapshot && (
          <Section title={`Snapshot: ${snapshot.label}`}>
            <p className="text-small text-ink-muted">
              固定 {formatJst(snapshot.frozenAt)} ／ {snapshot.itemCount} 件 ／ hash{' '}
              <span className="font-mono">{snapshot.hash.slice(0, 16)}</span>
            </p>
          </Section>
        )}

        {changes.length > 0 && (
          <Section
            title={`Snapshot 固定後の変更（${changes.length}）`}
            actions={
              can(ctx, 'assurance.ai.run') && (
                <form action={summarizeChangesAction}>
                  <input type="hidden" name="engagementId" value={engagementId} />
                  <SubmitButton
                    size="xs"
                    variant="secondary"
                    icon={<Bot aria-hidden="true" />}
                    pendingLabel="要約中…"
                  >
                    AI で差分を要約
                  </SubmitButton>
                </form>
              )
            }
          >
            <div className="t4d-scroll-x rounded-t4d border border-danger/40">
              <Table>
                <THead>
                  <TR>
                    <TH>対象</TH>
                    <TH>固定時点</TH>
                    <TH>現在</TH>
                    <TH>区分</TH>
                    <TH>影響評価</TH>
                  </TR>
                </THead>
                <TBody>
                  {changes.map((change) => {
                    const row = rows.find(
                      (r) => itemByDataPoint.get(r.dataPointId)?.id === change.snapshotItemId,
                    );
                    return (
                      <TR key={change.id}>
                        <TD>
                          {row ? `${row.unit?.name ?? '—'} / ${row.metric?.name ?? '—'}` : '—'}
                        </TD>
                        <TD className="tnum text-small">{change.beforeSummary}</TD>
                        <TD className="tnum text-small font-medium text-danger">
                          {change.afterSummary}
                        </TD>
                        <TD>
                          <SemanticBadge
                            semantic="blocked"
                            label={CHANGE_KIND_LABEL[change.changeKind] ?? '変更'}
                          />
                        </TD>
                        <TD>
                          {change.assessment ? (
                            <SemanticBadge
                              semantic={assessmentEntry(change.assessment).semantic}
                              label={assessmentEntry(change.assessment).label}
                            />
                          ) : canAssess ? (
                            <form
                              action={assessSnapshotChangeAction}
                              className="flex items-center gap-1"
                            >
                              <input type="hidden" name="engagementId" value={engagementId} />
                              <input
                                type="hidden"
                                name="snapshotItemId"
                                value={change.snapshotItemId}
                              />
                              <NativeSelect name="assessment" aria-label="影響評価" size="xs">
                                {ASSESSMENT_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </NativeSelect>
                              <SubmitButton size="xs" variant="secondary">
                                記録
                              </SubmitButton>
                            </form>
                          ) : (
                            <SemanticBadge semantic="pending" label="未評価" />
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>

            {latestAi && (
              <div className="mt-2 space-y-1 rounded-t4d border border-line px-3 py-2">
                {/* AI の要約は候補（人が影響を評価する）。生成元の表示を常に外に出す */}
                <div className="flex flex-wrap items-center gap-2">
                  <HonestyBadge kind={latestAi.provider === 'mock' ? 'mock-ai' : 'ai-candidate'} />
                  <span className="text-caption text-ink-muted">
                    確信度 {Math.round(latestAi.confidence * 100)}% ／{' '}
                    {formatJst(latestAi.createdAt)}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {(
                    (latestAi.outputJson.changes as Array<{
                      subject: string;
                      possibleImpact: string;
                    }>) ?? []
                  ).map((c, i) => (
                    <li key={i} className="text-small text-ink">
                      ・{c.possibleImpact}
                    </li>
                  ))}
                </ul>
                {latestAi.warnings.map((w, i) => (
                  <p key={i} className="text-caption text-warning-ink">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
          </Section>
        )}

        <Section
          title={`共有されているクライアントデータ（${allRows.length}）`}
          summary={`非財務データ ${rows.length} 件・開示レポート ${reports.length} 件`}
          actions={<ReadOnlyBadge />}
        >
          <p className="mb-1.5 text-caption text-ink-muted">
            クライアントの許諾（指標・組織・期間）と承認から、表示のたびに導いています。許諾の追加・承認は次の表示で反映され、許諾の取消・承認の取り消しで見えなくなります。
          </p>
          <DataTable<DataRoomTableRow>
            id="assurance-data-room"
            caption="共有されているクライアントデータ"
            columns={columns}
            rows={tableRows}
            getRowId={(entry) =>
              entry.kind === 'report' ? `report-${entry.report.copyId}` : entry.row.dataPointId
            }
            getRowLabel={(entry) =>
              entry.kind === 'report'
                ? `開示レポート ${entry.report.label}`
                : `${entry.row.metric?.name ?? '指標'} ${entry.row.unit?.name ?? ''}`
            }
            searchParams={query}
            basePath={basePath}
            search={{ placeholder: '指標名・組織名・開示レポートで検索' }}
            filters={[
              {
                key: 'change',
                label: '固定',
                options: [
                  { value: 'changed', label: '固定後の変更あり' },
                  { value: 'unfixed', label: '未固定' },
                ],
              },
              ...(sinceValue
                ? [
                    {
                      key: 'since',
                      label: '共有',
                      options: [
                        {
                          value: sinceValue,
                          label: `前回表示以降に共有（${newSince.length}）`,
                        },
                      ],
                    },
                  ]
                : []),
            ]}
            overflowFilters={[
              {
                key: 'source',
                label: '取得元',
                options: [
                  { value: 'data_point', label: '非財務データ' },
                  { value: 'report', label: '開示レポート' },
                ],
              },
            ]}
            empty={{
              noData: {
                title: '共有されているデータがありません',
                description:
                  'クライアント側でアクセス許諾（Grant）が設定され、許諾の範囲のデータが承認されると、ここに表示されます。許諾の範囲はスコープで確認できます。',
                action: (
                  <Link
                    href={`/assurance/engagements/${engagementId}/scope`}
                    className="text-small text-brand-700 hover:underline"
                  >
                    スコープと許諾を確認する
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
