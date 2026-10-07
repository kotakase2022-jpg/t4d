import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Download,
  FileText,
  Info,
  Lock,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  EXPORT_ARTIFACT_FORMAT_LABELS,
} from '@/lib/domain/disclosure-status';
import { AUDIENCE_DISPLAY } from '@/lib/exports/disclosure-report';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { listExportArtifacts } from '@/lib/services/disclosure-export';
import {
  SNAPSHOT_KIND_DISPLAY,
  evaluateReportReadiness,
  listProjectSnapshots,
  type SnapshotListEntry,
} from '@/lib/services/report-snapshot';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { ExportArtifactFormat, ExportAudience, ReportSnapshotKind } from '@/types/domain';
import { confirmReportAction, createReviewDraftSnapshotAction } from '../outputs/actions';

/**
 * 開示プロジェクトの「出力」タブ（指示書 §6.10、docs/disclosure-first.md §5「レポート確定」「出力」、plan S1）。
 *
 * - 主操作は「レポートを確定する」（最終承認の権限を持つ人だけ）。取り消せない操作なので確認ダイアログで
 *   範囲（承認済みの版を不変のスナップショットとして固定）を示してから送る（plan §1.16 区分 1）。
 *   「レビュー用草稿を作成」は副操作
 * - 出力する版を「レビュー用草稿」「社内承認済み版」から選ぶ。どちらもスナップショットを作ってから、
 *   そのスナップショットだけを元に DOCX / XLSX / CSV を生成する（ライブの値から組み立てない）。
 * - 確定できない理由は常に並べる。押せない状態の表示は画面だけで、確定の操作でもサーバー（confirmReport）が
 *   同じ判定をやり直す。
 * - ファイルの作成は提出ではない。社内承認は第三者保証ではない（どちらも画面に明記する）。
 * - スナップショット作成後に上流が変わった場合は注意として示すだけで、スナップショットは変えない（§10.3）。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function param(searchParams: SearchParams, key: string): string | null {
  const value = searchParams[key];
  return typeof value === 'string' ? value : null;
}

function exportHref(
  snapshot: { id: string; projectId: string },
  format: ExportArtifactFormat,
  audience: ExportAudience,
  frameworkVersionId?: string,
): string {
  // project は、出力できなかったとき（デモで別のサーバーに当たったなど）に出力タブへ戻して理由を示すため
  const query = new URLSearchParams({ format, audience, project: snapshot.projectId });
  if (frameworkVersionId) query.set('framework', frameworkVersionId);
  return `/api/exports/disclosure-snapshots/${encodeURIComponent(snapshot.id)}?${query.toString()}`;
}

function SnapshotKindBadge({ kind }: { kind: ReportSnapshotKind }) {
  return kind === 'approved' ? (
    <Badge tone="success">
      <BadgeCheck className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.approved}
    </Badge>
  ) : (
    <Badge tone="outline">
      <FileText className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.review_draft}
    </Badge>
  );
}

function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="secondary" size="xs">
      {/* download 属性は付けない（失敗時の出力タブへの戻りをファイルとして保存させない）。
          成功時は Content-Disposition: attachment でダウンロードになる */}
      <a href={href}>
        <Download aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}

/** ハッシュの先頭 12 文字（全体は読み上げ用に添える。title= には入れない） */
function ShortHash({ value }: { value: string }) {
  return (
    <code className="text-caption">
      {value.slice(0, 12)}
      <span className="sr-only">（全体: {value}）</span>
    </code>
  );
}

function SnapshotDownloads({ entry, canExport }: { entry: SnapshotListEntry; canExport: boolean }) {
  const { snapshot } = entry;
  if (!canExport) {
    return (
      <p className="flex items-center gap-1 text-caption text-ink-muted">
        <Lock className="size-3" aria-hidden="true" />
        出力の権限がありません
      </p>
    );
  }
  if (!entry.integrityOk) {
    return (
      <Badge tone="danger">
        <AlertTriangle className="size-3" aria-hidden="true" />
        内容ハッシュ不一致のため出力できません
      </Badge>
    );
  }
  return (
    <div className="space-y-1">
      {snapshot.frameworkVersions.map((framework) => (
        <div key={framework.frameworkVersionId} className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-caption text-ink-muted">DOCX 原稿（{framework.label}）</span>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'internal', framework.frameworkVersionId)}
          >
            社内確認用
          </DownloadLink>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'external', framework.frameworkVersionId)}
          >
            対外用
          </DownloadLink>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-caption text-ink-muted">対応表・数値</span>
        <DownloadLink href={exportHref(snapshot, 'xlsx', 'internal')}>
          XLSX 対応表（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'internal')}>
          CSV 数値（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'external')}>
          CSV 数値（対外用）
        </DownloadLink>
      </div>
    </div>
  );
}

type ArtifactRow = Awaited<ReturnType<typeof listExportArtifacts>>[number];

export async function OutputsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: SearchParams;
}) {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  if (!can(ctx, 'enterprise.disclosure.read')) {
    return (
      <PermissionDeniedState
        description="出力の確認には開示の閲覧権限が必要です。"
        permission="enterprise.disclosure.read"
      />
    );
  }

  const [readiness, snapshots] = await Promise.all([
    evaluateReportReadiness(db, ctx, projectId),
    listProjectSnapshots(db, ctx, projectId),
  ]);
  const artifacts = await listExportArtifacts(
    db,
    ctx,
    snapshots.map((s) => s.snapshot.id),
  );
  const snapshotNoById = new Map(
    snapshots.map((s) => [
      s.snapshot.id,
      `${SNAPSHOT_KIND_DISPLAY[s.snapshot.snapshotKind]} No.${s.snapshot.snapshotNo}`,
    ]),
  );

  const canDraft = can(ctx, 'enterprise.disclosure.write') || can(ctx, 'enterprise.export.run');
  const canExport = can(ctx, 'enterprise.export.run');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');
  // 番号以外が載った URL（手で作られたもの）で「作成しました」と見せない
  const createdParam = param(searchParams, 'snapshotCreated');
  const created = createdParam && /^\d{1,6}$/.test(createdParam) ? createdParam : null;
  const createdKind = param(searchParams, 'kind') === 'approved' ? 'approved' : 'review_draft';
  // 作成したスナップショットが、この一覧（このサーバーのメモリ）にあるか。デモでは作成したサーバーと
  // 一覧を描くサーバーが違うことがあり、無いのに「下の一覧から出力できます」と言わない
  const createdListed =
    created !== null &&
    snapshots.some(
      (s) => s.snapshot.snapshotKind === createdKind && String(s.snapshot.snapshotNo) === created,
    );
  const outputError = param(searchParams, 'outputError');
  const MAX_BLOCKERS = 8;
  const blockerCount = readiness.actorBlockers.length + readiness.blockers.length;
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  const includedCount = readiness.frameworks.filter((f) => f.included).length;

  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(artifacts.length / pageSize)),
  );
  const artifactColumns: DataTableColumn<ArtifactRow>[] = [
    {
      key: 'generatedAt',
      header: '出力日時',
      importance: 'primary',
      lockVisible: true,
      cell: (a) => <span className="whitespace-nowrap text-small">{formatJst(a.generatedAt)}</span>,
    },
    {
      key: 'format',
      header: '形式',
      importance: 'primary',
      cell: (a) => <span className="text-small">{EXPORT_ARTIFACT_FORMAT_LABELS[a.format]}</span>,
    },
    {
      key: 'fileName',
      header: 'ファイル名',
      importance: 'primary',
      width: 'lg',
      cell: (a) => <span className="break-all text-small">{a.fileName}</span>,
    },
    {
      key: 'generatedBy',
      header: '出力者',
      importance: 'primary',
      cell: (a) => <span className="text-small">{a.generatedByName}</span>,
    },
    {
      key: 'snapshot',
      header: 'スナップショット',
      importance: 'detail',
      cell: (a) => (
        <span className="text-small">
          {snapshotNoById.get(a.snapshotId) ?? '（このサーバーに無いスナップショット）'}
        </span>
      ),
    },
    {
      key: 'audience',
      header: '区分',
      importance: 'detail',
      cell: (a) => <span className="text-small">{AUDIENCE_DISPLAY[a.audience]}</span>,
    },
    {
      key: 'size',
      header: 'サイズ',
      importance: 'detail',
      align: 'right',
      cell: (a) => <span className="text-small">{formatNumber(a.byteSize)} B</span>,
    },
    {
      key: 'fileHash',
      header: 'ファイルのハッシュ',
      importance: 'detail',
      cell: (a) => <ShortHash value={a.fileSha256} />,
    },
    {
      key: 'contentHash',
      header: '内容ハッシュ',
      importance: 'detail',
      cell: (a) => <ShortHash value={a.contentHash} />,
    },
  ];

  return (
    <div className="space-y-3">
      {outputError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-small text-ink"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {outputError}
        </p>
      )}
      {created && createdListed && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-small text-ink"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {SNAPSHOT_KIND_DISPLAY[createdKind]}
          のスナップショット No.{created} を作成しました。下の一覧から出力できます。
        </p>
      )}
      {created && !createdListed && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-small text-ink"
          data-testid="snapshot-created-elsewhere"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          <span>
            {SNAPSHOT_KIND_DISPLAY[createdKind]}のスナップショット No.{created}
            は作成しましたが、この画面を表示したサーバーの一覧にはありません
            {db.mode === 'demo'
              ? '（デモ環境ではスナップショットをこのブラウザの Cookie で持ち回すため、別のブラウザで作成した・古い操作が押し出された・固定した元の行が変わった可能性があります）'
              : ''}
            。一覧に無い場合は、作成し直してから出力してください。
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div
          role="note"
          className="min-w-0 flex-1 space-y-0.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-small text-brand-900"
        >
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
            <span>
              ファイル作成は提出ではありません（開示先へ提出・公表したことにはなりません）。
              {SNAPSHOT_KIND_DISPLAY.approved}
              は社内の承認であり、第三者による保証ではありません。
            </span>
          </p>
          {db.mode === 'demo' && (
            <MoreInfo label="デモでのスナップショットの保存" className="pl-5">
              <p>
                デモではスナップショットの目録をこのブラウザの Cookie
                で持ち回します。別のブラウザや、Cookie
                の容量不足で古い操作が押し出された後は一覧から消えることがあります（本番は追記専用の表に保存します）。
              </p>
            </MoreInfo>
          )}
        </div>
        <PageActions
          primary={{
            kind: 'confirm',
            id: 'confirm-report',
            label: 'レポートを確定する',
            icon: <BadgeCheck aria-hidden="true" />,
            action: confirmReportAction,
            fields: { projectId },
            hidden: !canApprove,
            disabledReason: readiness.canConfirm
              ? undefined
              : `確定できない理由が ${blockerCount} 件あります（下の「確定できない理由」を参照）`,
            confirm: {
              tier: 'irreversible',
              title: 'レポートを確定しますか',
              scope:
                '承認済みの版を不変のスナップショットとして固定します。以後の変更は差分として検知されます。',
              consequences: [
                `確定すると「${SNAPSHOT_KIND_DISPLAY.approved}」のスナップショットができ、取り消せません。`,
                'ファイル作成・確定は提出ではありません。社内の承認であり、第三者による保証ではありません。',
                ...(readiness.draftStandardPrep
                  ? ['草案の基準による準備を含みます。確定しても法定準拠の確定にはなりません。']
                  : []),
              ],
              confirmLabel: '確定する',
              destructive: false,
            },
          }}
          secondary={[
            {
              kind: 'submit',
              id: 'create-review-draft',
              label: `${SNAPSHOT_KIND_DISPLAY.review_draft}を作成`,
              icon: <FileText aria-hidden="true" />,
              action: createReviewDraftSnapshotAction,
              fields: { projectId },
              pendingLabel: '作成中…',
              hidden: !canDraft,
            },
          ]}
        />
      </div>

      {/* 出力する版の違いと、確定の条件 */}
      <div className="grid gap-x-4 gap-y-2 lg:grid-cols-2">
        <Section
          title={SNAPSHOT_KIND_DISPLAY.review_draft}
          summary="保存済みの版を固定して出力します（未承認の箇所は出力に明示）"
          divider="none"
        >
          <MoreInfo label="草稿に含めるもの">
            <p>
              保存済みの版をそのまま固定します（自動保存中の本文は含めません）。未承認の節・不足情報は出力に「草稿・未承認箇所あり」として明示します。
            </p>
          </MoreInfo>
          {!canDraft && (
            <p className="flex items-center gap-1 text-caption text-ink-muted">
              <Lock className="size-3" aria-hidden="true" />
              草稿の作成には開示の編集または出力の権限が必要です。
            </p>
          )}
        </Section>

        <Section title={`${SNAPSHOT_KIND_DISPLAY.approved}（レポートの確定）`} divider="none">
          <div className="space-y-2 text-small">
            <p className="text-ink-muted">
              適用する基準の全節が承認済みで阻害条件が無いときだけ確定できます。確定の操作でも、サーバーで同じ条件を確かめ直します。
            </p>
            {!canApprove && (
              <p className="flex items-center gap-1 text-caption text-ink-muted">
                <Lock className="size-3" aria-hidden="true" />
                レポートの確定は最終承認者（開示の承認の権限を持つ人）が行います。
              </p>
            )}
            {readiness.draftStandardPrep && (
              <p className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-caption text-ink">
                <AlertTriangle
                  className="mt-0.5 size-3 shrink-0 text-warning-ink"
                  aria-hidden="true"
                />
                草案の基準による準備を含みます。確定しても「草案基準による準備」として扱い、法定準拠の確定にはなりません。
              </p>
            )}
            {!readiness.canConfirm && (
              <div>
                <p className="flex items-center gap-1 font-medium text-ink">
                  <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
                  確定できない理由（{blockerCount} 件）
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
                  {readiness.actorBlockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                  {readiness.blockers.slice(0, MAX_BLOCKERS).map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                  ))}
                </ul>
                {readiness.blockers.length > MAX_BLOCKERS && (
                  <p className="mt-0.5 text-caption text-ink-muted">
                    ほか {readiness.blockers.length - MAX_BLOCKERS} 件
                  </p>
                )}
              </div>
            )}
          </div>
        </Section>
      </div>

      {/* 基準ごとの出力対象（補助表。既定で閉じる） */}
      <Section
        id="output-frameworks"
        collapsible
        title="基準ごとの出力対象"
        summary={`基準 ${readiness.frameworks.length} 件（出力に含める ${includedCount} 件）`}
      >
        <div className="t4d-scroll-x">
          <Table>
            <THead>
              <TR>
                <TH>基準</TH>
                <TH>目的</TH>
                <TH>適用判断</TH>
                <TH>区分</TH>
                <TH align="right">節</TH>
                <TH>出力</TH>
              </TR>
            </THead>
            <TBody>
              {readiness.frameworks.map((f) => (
                <TR key={f.frameworkVersionId}>
                  <TD className="font-medium">{f.label}</TD>
                  <TD>{DISCLOSURE_PURPOSE_LABELS[f.purpose]}</TD>
                  <TD>
                    {APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}
                    {!f.decided && (
                      <span className="ml-1 text-caption text-ink-muted">（判断未確定）</span>
                    )}
                  </TD>
                  <TD>{f.draftStandardPrep ? '草案基準による準備' : '—'}</TD>
                  <TD align="right">{f.blockCount}</TD>
                  <TD>{f.included ? '含める' : '含めない（対象外と判断）'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Section>

      {/* スナップショット一覧 */}
      <Section title="スナップショット" summary={`${snapshots.length} 件（新しい順）`}>
        {snapshots.length === 0 ? (
          <EmptyState
            kind="no-data"
            size="compact"
            title="まだスナップショットがありません"
            description="上の「レビュー用草稿を作成」か「レポートを確定する」で版を固定すると、ここから出力できます。"
            action={
              <span className="text-small text-ink-muted">
                {canDraft || canApprove
                  ? '見出しの右の操作から作成できます'
                  : '作成担当・最終承認者が作成します'}
              </span>
            }
          />
        ) : (
          <div className="max-h-[70vh] overflow-auto rounded-t4d border border-line">
            <Table>
              <THead className="sticky top-0 z-(--z-sticky) bg-surface">
                <TR>
                  <TH>No.</TH>
                  <TH>種別</TH>
                  <TH>作成</TH>
                  <TH>内容ハッシュ</TH>
                  <TH>上流の変更</TH>
                  <TH>出力</TH>
                </TR>
              </THead>
              <TBody>
                {snapshots.map((entry) => (
                  <TR key={entry.snapshot.id} className="align-top">
                    <TD className="tnum align-top">{entry.snapshot.snapshotNo}</TD>
                    <TD className="align-top">
                      <SnapshotKindBadge kind={entry.snapshot.snapshotKind} />
                      <p className="mt-0.5 text-caption text-ink-muted">{entry.snapshot.label}</p>
                    </TD>
                    <TD className="align-top text-small">
                      {entry.createdByName}
                      <br />
                      <span className="text-ink-muted">{formatJst(entry.snapshot.createdAt)}</span>
                    </TD>
                    <TD className="align-top">
                      <ShortHash value={entry.snapshot.contentHash} />
                    </TD>
                    <TD className="align-top text-small">
                      {entry.upstreamChanges.length === 0 ? (
                        <span className="text-ink-muted">なし</span>
                      ) : (
                        <Collapsible
                          variant="plain"
                          summary={
                            <span className="inline-flex items-center gap-1 text-warning-ink">
                              <AlertTriangle className="size-3" aria-hidden="true" />
                              作成後に上流が更新（{entry.upstreamChanges.length} 件）
                            </span>
                          }
                        >
                          <ul className="list-disc space-y-0.5 pl-4 text-caption text-ink-muted">
                            {entry.upstreamChanges.map((change, index) => (
                              <li key={index}>
                                {change.label}: {change.detail}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-caption text-ink-muted">
                            このスナップショットの内容は変わりません。最新の内容で出力するには新しいスナップショットを作成してください。
                          </p>
                        </Collapsible>
                      )}
                    </TD>
                    <TD className="align-top">
                      <SnapshotDownloads entry={entry} canExport={canExport} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Section>

      {/* 出力の記録 */}
      <Section title="出力の記録" summary={`${artifacts.length} 件`}>
        <MoreInfo label="ハッシュの見方" className="pb-1">
          <p>
            同じスナップショットから再出力すると、内容ハッシュ（本文・数値・参照）は一致します。ファイルのハッシュは生成日時を含むため、DOCX・XLSX
            では出力ごとに変わります。区分（対外用・社内確認用）・サイズ・ハッシュは「列」から表示できます。
          </p>
        </MoreInfo>
        <DataTable
          id="export-artifacts"
          caption="出力の記録"
          columns={artifactColumns}
          rows={artifacts.slice((page - 1) * pageSize, page * pageSize)}
          getRowId={(a) => a.id}
          getRowLabel={(a) => a.fileName}
          searchParams={searchParams}
          basePath={projectPath}
          search={false}
          page={{ page, pageSize, total: artifacts.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          empty={{
            noData: {
              title: 'まだ出力していません',
              description:
                'スナップショットの「出力」から DOCX・XLSX・CSV を作ると、記録が残ります。',
              action: canExport ? (
                <span className="text-small text-ink-muted">
                  上のスナップショットの一覧から出力できます
                </span>
              ) : (
                <span className="text-small text-ink-muted">
                  出力には出力の権限が必要です。管理者・作成担当・最終承認者に依頼してください。
                </span>
              ),
            },
          }}
        />
      </Section>
    </div>
  );
}
